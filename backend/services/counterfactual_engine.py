"""Counterfactual Analysis Engine — "What Would Have Happened If..."

After an incident, analyzes hypothetical policy changes:
  "If the east door had auto-locked after 18:00, this intrusion would have
  been prevented. The intruder entered at 19:42 through the east door which
  was in free-access mode."

Quantifies the value of proposed security investments and policy changes.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from backend.config import settings
from backend.database import async_session
from backend.models import Alert

logger = logging.getLogger(__name__)

_COUNTERFACTUAL_PROMPT = """\
You are a security policy analyst performing counterfactual reasoning.

**Incident Timeline:**
{incident_timeline}

**Proposed Policy Change:**
{policy_change}

**Current Policies:**
{current_policies}

**Historical Similar Incidents (if any):**
{similar_incidents}

Analyze: If the proposed policy had been in place, would this incident have
been prevented, mitigated, or unaffected?

Respond with JSON:
{{
  "outcome": "prevented|mitigated|unaffected|worsened",
  "confidence": 0.0-1.0,
  "reasoning": [
    {{
      "step": 1,
      "original_event": "what happened",
      "counterfactual_event": "what would have happened under new policy",
      "impact": "prevented|mitigated|unchanged"
    }}
  ],
  "impact_summary": "2-3 sentence summary of the counterfactual outcome",
  "cost_benefit": {{
    "incidents_preventable": "estimated number per quarter",
    "risk_reduction_pct": 0-100,
    "implementation_complexity": "low|medium|high",
    "recommended": true/false
  }},
  "side_effects": ["potential negative consequences of the policy change"],
  "alternative_policies": [
    {{
      "policy": "alternative policy suggestion",
      "expected_outcome": "what this would achieve"
    }}
  ]
}}
"""


class CounterfactualAnalysis:
    """Represents a single counterfactual analysis result."""

    def __init__(self, incident_id: str, policy_change: str) -> None:
        self.analysis_id = f"cf_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
        self.incident_id = incident_id
        self.policy_change = policy_change
        self.outcome: str = "unknown"
        self.confidence: float = 0.0
        self.reasoning: List[Dict] = []
        self.impact_summary: str = ""
        self.cost_benefit: Dict = {}
        self.side_effects: List[str] = []
        self.alternative_policies: List[Dict] = []
        self.created_at = datetime.now(timezone.utc).isoformat()

    def to_dict(self) -> Dict[str, Any]:
        return {
            "analysis_id": self.analysis_id,
            "incident_id": self.incident_id,
            "policy_change": self.policy_change,
            "outcome": self.outcome,
            "confidence": self.confidence,
            "reasoning": self.reasoning,
            "impact_summary": self.impact_summary,
            "cost_benefit": self.cost_benefit,
            "side_effects": self.side_effects,
            "alternative_policies": self.alternative_policies,
            "created_at": self.created_at,
        }


class CounterfactualEngine:
    """Performs counterfactual analysis on resolved incidents.

    Uses Gemini Pro to reason about what would have happened under
    different security policies or configurations.
    """

    def __init__(self) -> None:
        self._analysis_history: List[Dict] = []

    async def analyze(
        self,
        incident_id: str,
        policy_change: str,
        incident_data: Optional[Dict] = None,
    ) -> CounterfactualAnalysis:
        """Analyze what would have happened if a policy had been different.

        Args:
            incident_id: Alert or incident ID
            policy_change: Natural language description of proposed change
            incident_data: Optional pre-fetched incident data
        """
        analysis = CounterfactualAnalysis(incident_id, policy_change)

        # Gather incident timeline
        timeline = incident_data or await self._get_incident_timeline(incident_id)

        # Get current policies
        current_policies = await self._get_current_policies()

        # Find similar historical incidents
        similar = await self._find_similar_incidents(incident_id, timeline)

        prompt = _COUNTERFACTUAL_PROMPT.format(
            incident_timeline=json.dumps(timeline, indent=2, default=str),
            policy_change=policy_change,
            current_policies=json.dumps(current_policies, indent=2, default=str),
            similar_incidents=json.dumps(similar, indent=2, default=str),
        )

        try:
            from backend.modules.gemini_client import gemini_client
            response = await gemini_client.generate(
                prompt=prompt,
                
                temperature=0.3,
                max_tokens=1500,
            )

            if response:
                parsed = self._parse_json(response)
                if parsed:
                    analysis.outcome = parsed.get("outcome", "unknown")
                    analysis.confidence = parsed.get("confidence", 0.0)
                    analysis.reasoning = parsed.get("reasoning", [])
                    analysis.impact_summary = parsed.get("impact_summary", "")
                    analysis.cost_benefit = parsed.get("cost_benefit", {})
                    analysis.side_effects = parsed.get("side_effects", [])
                    analysis.alternative_policies = parsed.get("alternative_policies", [])

        except Exception as e:
            logger.error("counterfactual.analysis_failed incident=%s: %s", incident_id, e)
            analysis.impact_summary = f"Unable to complete analysis: {e}"

        self._analysis_history.append(analysis.to_dict())
        if len(self._analysis_history) > 200:
            self._analysis_history = self._analysis_history[-100:]

        logger.info(
            "counterfactual.completed incident=%s outcome=%s confidence=%.2f",
            incident_id, analysis.outcome, analysis.confidence,
        )
        return analysis

    async def batch_analyze(
        self,
        policy_change: str,
        lookback_days: int = 90,
        limit: int = 50,
    ) -> Dict[str, Any]:
        """Analyze a policy change against multiple historical incidents.

        Returns aggregate impact: "This policy would have prevented X of Y incidents."
        """
        # Get resolved alerts
        from sqlalchemy import select
        from backend.models.models import AlertStatus, AlertSeverity

        cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)

        try:
            async with async_session() as session:
                stmt = select(Alert).where(
                    Alert.status.in_([AlertStatus.RESOLVED, AlertStatus.DISMISSED]),
                    Alert.created_at >= cutoff,
                    Alert.severity.in_([AlertSeverity.HIGH, AlertSeverity.CRITICAL]),
                ).order_by(Alert.created_at.desc()).limit(limit)

                result = await session.execute(stmt)
                alerts = result.scalars().all()
        except Exception as e:
            logger.error("counterfactual.batch_failed: %s", e)
            return {"error": str(e)}

        results = {
            "policy_change": policy_change,
            "incidents_analyzed": len(alerts),
            "prevented": 0,
            "mitigated": 0,
            "unaffected": 0,
            "analyses": [],
        }

        for alert in alerts[:20]:  # Limit Gemini calls
            incident_data = {
                "alert_id": str(alert.id),
                "threat_type": alert.threat_type,
                "severity": alert.severity.value if hasattr(alert.severity, "value") else str(alert.severity),
                "camera": alert.source_camera,
                "zone": alert.zone_name,
                "timestamp": str(alert.created_at),
                "description": alert.description,
            }

            analysis = await self.analyze(
                incident_id=str(alert.id),
                policy_change=policy_change,
                incident_data=incident_data,
            )

            if analysis.outcome == "prevented":
                results["prevented"] += 1
            elif analysis.outcome == "mitigated":
                results["mitigated"] += 1
            else:
                results["unaffected"] += 1

            results["analyses"].append({
                "incident_id": str(alert.id),
                "outcome": analysis.outcome,
                "confidence": analysis.confidence,
                "summary": analysis.impact_summary,
            })

        total = len(results["analyses"])
        if total > 0:
            results["prevention_rate"] = round(results["prevented"] / total * 100, 1)
            results["mitigation_rate"] = round((results["prevented"] + results["mitigated"]) / total * 100, 1)
            results["summary"] = (
                f"Policy '{policy_change}' would have prevented {results['prevented']} "
                f"and mitigated {results['mitigated']} of {total} analyzed incidents "
                f"({results['prevention_rate']}% prevention rate)."
            )
        else:
            results["summary"] = "No incidents to analyze."

        return results

    async def _get_incident_timeline(self, incident_id: str) -> Dict:
        """Fetch incident details from database."""
        try:
            from sqlalchemy import select
            async with async_session() as session:
                result = await session.execute(
                    select(Alert).where(Alert.id == incident_id)
                )
                alert = result.scalar_one_or_none()
                if alert:
                    return {
                        "alert_id": str(alert.id),
                        "title": alert.title,
                        "description": alert.description,
                        "threat_type": alert.threat_type,
                        "severity": alert.severity.value if hasattr(alert.severity, "value") else str(alert.severity),
                        "camera": alert.source_camera,
                        "zone": alert.zone_name,
                        "timestamp": str(alert.created_at),
                        "resolution": alert.resolution_notes,
                        "metadata": alert.metadata_ or {},
                    }
        except Exception as e:
            logger.debug("counterfactual.timeline_fetch_failed: %s", e)
        return {"incident_id": incident_id, "note": "Details not available"}

    async def _get_current_policies(self) -> List[Dict]:
        """Get currently active security policies."""
        try:
            from backend.services.sop_engine import sop_engine
            if hasattr(sop_engine, "get_active_sops"):
                return await sop_engine.get_active_sops()
        except Exception:
            pass
        return [{"note": "No structured policies available"}]

    async def _find_similar_incidents(self, incident_id: str, timeline: Dict) -> List[Dict]:
        """Find historically similar incidents."""
        try:
            from sqlalchemy import select
            from backend.models.models import AlertStatus

            threat_type = timeline.get("threat_type", "")
            if not threat_type:
                return []

            async with async_session() as session:
                result = await session.execute(
                    select(Alert).where(
                        Alert.threat_type == threat_type,
                        Alert.id != incident_id,
                        Alert.status.in_([AlertStatus.RESOLVED, AlertStatus.DISMISSED]),
                    ).order_by(Alert.created_at.desc()).limit(5)
                )
                return [
                    {
                        "id": str(a.id),
                        "threat_type": a.threat_type,
                        "severity": a.severity.value if hasattr(a.severity, "value") else str(a.severity),
                        "resolution": a.resolution_notes or "No notes",
                    }
                    for a in result.scalars().all()
                ]
        except Exception:
            return []

    def _parse_json(self, text: str) -> Optional[Dict]:
        text = text.strip()
        if text.startswith("```"):
            lines = text.split("\n")
            lines = [l for l in lines if not l.strip().startswith("```")]
            text = "\n".join(lines)
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            start = text.find("{")
            end = text.rfind("}") + 1
            if start >= 0 and end > start:
                try:
                    return json.loads(text[start:end])
                except json.JSONDecodeError:
                    pass
        return None

    def get_history(self, limit: int = 20) -> List[Dict]:
        return self._analysis_history[-limit:]


# ── Singleton ─────────────────────────────────────────────────────
counterfactual_engine = CounterfactualEngine()
