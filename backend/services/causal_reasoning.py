"""Causal Reasoning Engine — "The Why Machine"

Reconstructs the causal chain behind every alert:
  Instead of: "Alert: Person in restricted area"
  SENTINEL says: "Person entered via Door 3 at 14:02 (tailgated behind employee John),
  traversed corridor B (Camera 4, 14:03), reached server room (Camera 7, 14:05).
  No badge scan at any checkpoint. Pattern matches social engineering playbook."

Uses existing event correlation, CLIP re-identification, access logs, and
Gemini Pro reasoning to build a full narrative of how an incident developed.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from backend.config import settings
from backend.database import async_session
from backend.models import Alert, Event, Camera

logger = logging.getLogger(__name__)

# ── Gemini prompt for causal chain reconstruction ────────────────
_CAUSAL_PROMPT = """\
You are a forensic security analyst reconstructing the causal chain of a security incident.

**Current Alert:**
- Type: {threat_type}
- Severity: {severity}
- Camera: {camera_name} ({camera_id})
- Zone: {zone_name}
- Time: {alert_time}
- Description: {description}

**Subject Movement Trail (CLIP Re-ID across cameras):**
{movement_trail}

**Access Control Events (same time window):**
{access_events}

**Correlated Events (nearby cameras, same time window):**
{correlated_events}

**Zone History (recent activity in this zone):**
{zone_history}

Reconstruct the complete causal chain. Your response MUST be valid JSON:
{{
  "causal_chain": [
    {{
      "step": 1,
      "timestamp": "ISO timestamp",
      "location": "camera/zone name",
      "action": "what happened",
      "evidence_type": "yolo|clip|access_log|gemini|correlation",
      "confidence": 0.0-1.0,
      "details": "specific evidence details"
    }}
  ],
  "root_cause": "the initiating event that started this chain",
  "attack_pattern": "social_engineering|tailgating|forced_entry|insider|reconnaissance|opportunistic|unknown",
  "vulnerabilities_exploited": ["list of security gaps exploited"],
  "narrative": "2-3 sentence plain English summary of what happened and why",
  "countermeasures": ["what would have prevented this"],
  "confidence_overall": 0.0-1.0
}}
"""

# ── Gemini prompt for pattern matching against known causal patterns ─
_PATTERN_MATCH_PROMPT = """\
Compare this causal chain against known attack patterns.

**Current chain:**
{current_chain}

**Known patterns in our database:**
{known_patterns}

Respond with JSON:
{{
  "best_match": "pattern name or 'novel'",
  "similarity": 0.0-1.0,
  "differences": ["how this differs from the matched pattern"],
  "is_novel": true/false,
  "recommended_name": "if novel, suggest a name for this new pattern"
}}
"""


class CausalChain:
    """Represents a reconstructed causal chain for an incident."""

    def __init__(self, alert_id: str, threat_type: str, severity: str) -> None:
        self.alert_id = alert_id
        self.threat_type = threat_type
        self.severity = severity
        self.steps: List[Dict[str, Any]] = []
        self.root_cause: str = ""
        self.attack_pattern: str = "unknown"
        self.vulnerabilities: List[str] = []
        self.narrative: str = ""
        self.countermeasures: List[str] = []
        self.confidence: float = 0.0
        self.pattern_match: Optional[Dict] = None
        self.created_at: str = datetime.now(timezone.utc).isoformat()

    def to_dict(self) -> Dict[str, Any]:
        return {
            "alert_id": self.alert_id,
            "threat_type": self.threat_type,
            "severity": self.severity,
            "causal_chain": self.steps,
            "root_cause": self.root_cause,
            "attack_pattern": self.attack_pattern,
            "vulnerabilities_exploited": self.vulnerabilities,
            "narrative": self.narrative,
            "countermeasures": self.countermeasures,
            "confidence": self.confidence,
            "pattern_match": self.pattern_match,
            "step_count": len(self.steps),
            "created_at": self.created_at,
        }


class CausalReasoningEngine:
    """Reconstructs causal chains behind security alerts.

    Gathers evidence from multiple sources (CLIP re-id, access logs,
    event correlation, zone history) and uses Gemini Pro to reason
    about the full causal chain of an incident.
    """

    def __init__(self) -> None:
        self._pattern_cache: Dict[str, Dict] = {}
        self._chain_history: List[Dict] = []

    async def reconstruct_chain(
        self,
        alert_id: str,
        threat_data: Dict[str, Any],
        time_window_minutes: int = 30,
    ) -> CausalChain:
        """Reconstruct the full causal chain for an alert.

        Gathers evidence from:
        1. Subject movement trail (CLIP re-id)
        2. Access control events
        3. Correlated events (nearby cameras)
        4. Zone activity history
        Then uses Gemini Pro to reason about causality.
        """
        chain = CausalChain(
            alert_id=alert_id,
            threat_type=threat_data.get("threat_type", "unknown"),
            severity=threat_data.get("severity", "medium"),
        )

        camera_id = threat_data.get("camera_id", threat_data.get("source_camera", ""))
        zone_name = threat_data.get("zone_name", "")
        alert_time = threat_data.get("timestamp", datetime.now(timezone.utc).isoformat())

        # Gather evidence from multiple sources concurrently
        movement_trail = await self._get_movement_trail(threat_data, time_window_minutes)
        access_events = await self._get_access_events(zone_name, alert_time, time_window_minutes)
        correlated_events = await self._get_correlated_events(camera_id, alert_time, time_window_minutes)
        zone_history = await self._get_zone_history(zone_name, alert_time, time_window_minutes)

        # Get camera name
        camera_name = await self._get_camera_name(camera_id)

        # Build the Gemini prompt
        prompt = _CAUSAL_PROMPT.format(
            threat_type=chain.threat_type,
            severity=chain.severity,
            camera_name=camera_name,
            camera_id=camera_id,
            zone_name=zone_name or "Unknown",
            alert_time=alert_time,
            description=threat_data.get("description", "No description"),
            movement_trail=json.dumps(movement_trail, indent=2, default=str) if movement_trail else "No movement trail available",
            access_events=json.dumps(access_events, indent=2, default=str) if access_events else "No access events found",
            correlated_events=json.dumps(correlated_events, indent=2, default=str) if correlated_events else "No correlated events",
            zone_history=json.dumps(zone_history, indent=2, default=str) if zone_history else "No zone history",
        )

        # Call Gemini Pro for causal reasoning
        try:
            from backend.modules.gemini_client import gemini_client
            response = await gemini_client.generate(
                prompt=prompt,
                
                temperature=0.3,
                max_tokens=2048,
            )

            if response:
                parsed = self._parse_gemini_response(response)
                if parsed:
                    chain.steps = parsed.get("causal_chain", [])
                    chain.root_cause = parsed.get("root_cause", "")
                    chain.attack_pattern = parsed.get("attack_pattern", "unknown")
                    chain.vulnerabilities = parsed.get("vulnerabilities_exploited", [])
                    chain.narrative = parsed.get("narrative", "")
                    chain.countermeasures = parsed.get("countermeasures", [])
                    chain.confidence = parsed.get("confidence_overall", 0.0)

        except Exception as e:
            logger.error("causal.gemini_failed alert=%s err=%s", alert_id, e)
            # Fall back to rule-based chain construction
            chain = await self._build_rule_based_chain(
                chain, movement_trail, access_events, correlated_events
            )

        # Try to match against known causal patterns
        try:
            chain.pattern_match = await self._match_known_patterns(chain)
        except Exception as e:
            logger.debug("causal.pattern_match_failed: %s", e)

        # Store in history
        self._chain_history.append(chain.to_dict())
        if len(self._chain_history) > 500:
            self._chain_history = self._chain_history[-300:]

        logger.info(
            "causal.chain_built alert=%s steps=%d pattern=%s confidence=%.2f",
            alert_id, len(chain.steps), chain.attack_pattern, chain.confidence,
        )
        return chain

    async def _get_movement_trail(
        self, threat_data: Dict, time_window: int
    ) -> List[Dict]:
        """Get subject movement trail from CLIP re-identification."""
        try:
            from backend.services.event_correlator import EventCorrelator
            correlator = EventCorrelator()

            description = threat_data.get("description", "")
            if not description:
                return []

            result = await correlator.build_movement_trail(
                subject_description=description,
                time_range=None,
                top_k=20,
            )
            return result.get("trail_points", []) if result else []
        except Exception as e:
            logger.debug("causal.movement_trail_failed: %s", e)
            return []

    async def _get_access_events(
        self, zone_name: str, alert_time: str, window_minutes: int
    ) -> List[Dict]:
        """Get access control events near the alert time."""
        try:
            from sqlalchemy import select, and_
            from backend.models.models import AccessEvent

            try:
                ts = datetime.fromisoformat(alert_time.replace("Z", "+00:00"))
            except (ValueError, AttributeError):
                ts = datetime.now(timezone.utc)

            start = ts - timedelta(minutes=window_minutes)
            end = ts + timedelta(minutes=5)

            async with async_session() as session:
                stmt = select(AccessEvent).where(
                    and_(
                        AccessEvent.timestamp >= start,
                        AccessEvent.timestamp <= end,
                    )
                ).order_by(AccessEvent.timestamp).limit(50)

                result = await session.execute(stmt)
                events = result.scalars().all()
                return [
                    {
                        "timestamp": str(e.timestamp),
                        "user": getattr(e, "user_name", "Unknown"),
                        "door": getattr(e, "door_name", "Unknown"),
                        "event_type": getattr(e, "event_type", "unknown"),
                        "granted": getattr(e, "granted", None),
                    }
                    for e in events
                ]
        except Exception as e:
            logger.debug("causal.access_events_failed: %s", e)
            return []

    async def _get_correlated_events(
        self, camera_id: str, alert_time: str, window_minutes: int
    ) -> List[Dict]:
        """Get events from nearby cameras in the same time window."""
        try:
            try:
                ts = datetime.fromisoformat(alert_time.replace("Z", "+00:00"))
            except (ValueError, AttributeError):
                ts = datetime.now(timezone.utc)

            start = ts - timedelta(minutes=window_minutes)
            end = ts + timedelta(minutes=5)

            from sqlalchemy import select, and_
            async with async_session() as session:
                stmt = select(Event).where(
                    and_(
                        Event.timestamp >= start,
                        Event.timestamp <= end,
                    )
                ).order_by(Event.timestamp.desc()).limit(30)

                result = await session.execute(stmt)
                events = result.scalars().all()
                return [
                    {
                        "timestamp": str(e.timestamp),
                        "camera_id": str(e.camera_id),
                        "severity": e.severity.value if hasattr(e.severity, "value") else str(e.severity),
                        "detections": e.detections or {},
                        "gemini_summary": (e.gemini_analysis or {}).get("scene_description", ""),
                    }
                    for e in events[:20]
                ]
        except Exception as e:
            logger.debug("causal.correlated_events_failed: %s", e)
            return []

    async def _get_zone_history(
        self, zone_name: str, alert_time: str, window_minutes: int
    ) -> List[Dict]:
        """Get recent activity history for the zone."""
        if not zone_name:
            return []
        try:
            from sqlalchemy import select, and_
            try:
                ts = datetime.fromisoformat(alert_time.replace("Z", "+00:00"))
            except (ValueError, AttributeError):
                ts = datetime.now(timezone.utc)

            start = ts - timedelta(minutes=window_minutes)

            async with async_session() as session:
                stmt = select(Alert).where(
                    and_(
                        Alert.zone_name == zone_name,
                        Alert.created_at >= start,
                    )
                ).order_by(Alert.created_at.desc()).limit(20)

                result = await session.execute(stmt)
                alerts = result.scalars().all()
                return [
                    {
                        "timestamp": str(a.created_at),
                        "threat_type": a.threat_type,
                        "severity": a.severity.value if hasattr(a.severity, "value") else str(a.severity),
                        "status": a.status.value if hasattr(a.status, "value") else str(a.status),
                    }
                    for a in alerts
                ]
        except Exception as e:
            logger.debug("causal.zone_history_failed: %s", e)
            return []

    async def _get_camera_name(self, camera_id: str) -> str:
        """Look up camera name from ID."""
        if not camera_id:
            return "Unknown Camera"
        try:
            async with async_session() as session:
                from sqlalchemy import select
                stmt = select(Camera).where(Camera.id == camera_id).limit(1)
                result = await session.execute(stmt)
                cam = result.scalar_one_or_none()
                return cam.name if cam else camera_id
        except Exception:
            return camera_id

    def _parse_gemini_response(self, response: str) -> Optional[Dict]:
        """Parse Gemini JSON response, handling markdown code blocks."""
        text = response.strip()
        if text.startswith("```"):
            lines = text.split("\n")
            lines = [l for l in lines if not l.strip().startswith("```")]
            text = "\n".join(lines)
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            # Try to find JSON within the response
            start = text.find("{")
            end = text.rfind("}") + 1
            if start >= 0 and end > start:
                try:
                    return json.loads(text[start:end])
                except json.JSONDecodeError:
                    pass
            logger.warning("causal.json_parse_failed response_len=%d", len(text))
            return None

    async def _build_rule_based_chain(
        self,
        chain: CausalChain,
        movement_trail: List[Dict],
        access_events: List[Dict],
        correlated_events: List[Dict],
    ) -> CausalChain:
        """Fallback: build a basic causal chain without Gemini."""
        step_num = 1

        # Add movement trail steps
        for point in movement_trail:
            chain.steps.append({
                "step": step_num,
                "timestamp": point.get("timestamp", ""),
                "location": point.get("camera_id", "Unknown"),
                "action": f"Subject detected at camera",
                "evidence_type": "clip",
                "confidence": point.get("similarity", 0.5),
                "details": point.get("description", ""),
            })
            step_num += 1

        # Add access events
        for evt in access_events:
            chain.steps.append({
                "step": step_num,
                "timestamp": evt.get("timestamp", ""),
                "location": evt.get("door", "Unknown"),
                "action": f"{evt.get('event_type', 'access')} by {evt.get('user', 'Unknown')}",
                "evidence_type": "access_log",
                "confidence": 0.95,
                "details": f"Granted: {evt.get('granted', 'N/A')}",
            })
            step_num += 1

        chain.root_cause = "See movement trail for initial entry point"
        chain.confidence = 0.5
        chain.narrative = (
            f"Subject traced through {len(movement_trail)} camera locations "
            f"with {len(access_events)} access control events in the same time window."
        )
        return chain

    async def _match_known_patterns(self, chain: CausalChain) -> Optional[Dict]:
        """Match the causal chain against known attack patterns."""
        if not chain.steps:
            return None

        known_patterns = [
            {"name": "tailgating", "indicators": ["no badge scan", "followed", "piggyback", "tailgate"]},
            {"name": "social_engineering", "indicators": ["impersonation", "deception", "pretexting", "no authorization"]},
            {"name": "forced_entry", "indicators": ["forced", "break", "damage", "tamper"]},
            {"name": "insider_threat", "indicators": ["authorized user", "unusual hours", "excessive access", "data exfiltration"]},
            {"name": "reconnaissance", "indicators": ["circling", "photographing", "surveying", "testing"]},
            {"name": "loitering_escalation", "indicators": ["loitering", "lingering", "waiting", "stationary"]},
        ]

        chain_text = json.dumps(chain.steps).lower()
        best_match = None
        best_score = 0

        for pattern in known_patterns:
            matches = sum(1 for ind in pattern["indicators"] if ind in chain_text)
            score = matches / len(pattern["indicators"]) if pattern["indicators"] else 0
            if score > best_score:
                best_score = score
                best_match = pattern["name"]

        if best_match and best_score > 0.2:
            return {
                "matched_pattern": best_match,
                "similarity": round(best_score, 2),
                "is_novel": False,
            }

        return {"matched_pattern": "novel", "similarity": 0.0, "is_novel": True}

    def get_recent_chains(self, limit: int = 20) -> List[Dict]:
        """Get recently constructed causal chains."""
        return self._chain_history[-limit:]

    def get_chain_stats(self) -> Dict[str, Any]:
        """Get statistics about causal chain analysis."""
        if not self._chain_history:
            return {"total_chains": 0}

        patterns = {}
        for ch in self._chain_history:
            p = ch.get("attack_pattern", "unknown")
            patterns[p] = patterns.get(p, 0) + 1

        avg_steps = sum(ch.get("step_count", 0) for ch in self._chain_history) / len(self._chain_history)
        avg_conf = sum(ch.get("confidence", 0) for ch in self._chain_history) / len(self._chain_history)

        return {
            "total_chains": len(self._chain_history),
            "attack_patterns": patterns,
            "average_steps": round(avg_steps, 1),
            "average_confidence": round(avg_conf, 2),
        }


# ── Singleton ─────────────────────────────────────────────────────
causal_engine = CausalReasoningEngine()
