"""Threat Analyst Agent — senior security threat analysis with Gemini reasoning.

Subscribes to perception events and anomaly detections, performs deep threat
analysis using Gemini function-calling, and publishes validated threat
assessments to the threats channel.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import (
    CH_PERCEPTIONS,
    CH_ANOMALIES,
    CH_CORTEX,
    CH_THREATS,
)

logger = logging.getLogger(__name__)

# ── Threat analysis prompt template ──────────────────────────────────
_ANALYSIS_PROMPT = """\
You are a senior security threat analyst in an autonomous physical security \
system. A notable activity has been flagged by the perception layer.

**Flagged activity:**
{event_details}

**Recent event context (last 30 min):**
{recent_context}

**Site context:**
{site_context}

Perform a thorough threat assessment. Use the available tools to gather \
additional evidence — check event history, search for similar incidents, \
review alert history, analyse frames if a camera_id is available, and \
retrieve any stored observations that may be relevant.

After gathering evidence, provide your assessment as structured JSON:
{{
  "benign_explanation": "<most likely innocent explanation>",
  "threat_explanation": "<most likely threat scenario>",
  "evidence_for_threat": ["<evidence point 1>", ...],
  "evidence_against_threat": ["<evidence point 1>", ...],
  "threat_probability": <0-100>,
  "matching_signature": "<threat signature name or 'none'>",
  "recommended_severity": "<info|low|medium|high|critical>",
  "recommended_response": "<description of recommended response>",
  "confidence": <0.0-1.0>
}}
"""

_SWEEP_PROMPT = """\
You are a senior security threat analyst performing a periodic alert review.

**Currently active alerts:**
{active_alerts}

**Recent threat statistics:**
{threat_stats}

Review each active alert. For alerts that are stale or no longer relevant, \
recommend downgrading. For alerts where the situation has worsened, recommend \
escalation. Use tools to check the latest detections and event history.

Provide your reassessment as structured JSON:
{{
  "reassessments": [
    {{
      "alert_id": "<uuid>",
      "current_severity": "<severity>",
      "recommended_severity": "<severity>",
      "action": "maintain|escalate|downgrade|resolve",
      "reasoning": "<brief reasoning>"
    }}
  ],
  "overall_threat_posture": "<low|moderate|elevated|high|critical>",
  "summary": "<1-2 sentence summary>"
}}
"""


class ThreatAnalystAgent(BaseAgent):
    """Senior security threat analyst agent.

    Monitors perception events and anomalies, performs deep Gemini-powered
    threat analysis, creates alerts for confirmed threats, and periodically
    sweeps active alerts to reassess severity levels.
    """

    def __init__(self) -> None:
        super().__init__(
            name="threat_analyst",
            role="Senior Security Threat Analyst",
            description=(
                "Analyses flagged activities from the perception layer using "
                "deep reasoning and multi-tool evidence gathering. Determines "
                "threat probability, creates alerts for confirmed threats, and "
                "periodically reassesses active alert severities."
            ),
            tier="reasoning",
            model_name="deepseek-v3.1:671b-cloud",
            tool_names=[
                "analyze_frame_sequence_deep",
                "get_event_history",
                "get_alert_history",
                "semantic_search_video",
                "get_current_detections",
                "get_site_context",
                "create_alert",
                "escalate_alert",
                "recall_observations",
                "analyze_frame_with_gemini",
                "get_threat_statistics",
            ],
            subscriptions=[CH_PERCEPTIONS, CH_ANOMALIES, CH_CORTEX],
            cycle_interval=5.0,
            token_budget_per_cycle=25000,
        )
        # Tracks the last sweep cycle to schedule periodic reviews
        self._sweep_interval = 12  # every 12th cycle

    # ── Core reasoning ────────────────────────────────────────────────

    async def think(self, context: dict) -> dict:
        """Main reasoning loop executed every cycle.

        1. Process incoming perception and anomaly events.
        2. Run deep threat analysis on notable events.
        3. Create alerts and publish to CH_THREATS for high-probability threats.
        4. Every 12th cycle, perform a sweep of active alerts.
        """
        inbox = context.get("inbox_messages", [])
        cycle = context.get("cycle", 0)
        results = []

        # ── 1. Classify incoming messages ─────────────────────────────
        perception_events = []
        anomaly_events = []
        cortex_directives = []

        for msg in inbox:
            channel = msg.get("_channel", "")
            msg_type = msg.get("type", "")

            if channel == CH_PERCEPTIONS or msg_type in (
                "perception", "detection", "scene_analysis",
            ):
                perception_events.append(msg)
            elif channel == CH_ANOMALIES or msg_type in (
                "anomaly", "anomaly_detected", "baseline_deviation",
            ):
                anomaly_events.append(msg)
            elif channel == CH_CORTEX:
                cortex_directives.append(msg)

        # ── 2. Identify notable events worth deep analysis ────────────
        notable_events = self._filter_notable_events(
            perception_events, anomaly_events, cortex_directives,
        )

        if notable_events:
            logger.info(
                "Threat analyst processing %d notable events (cycle %d)",
                len(notable_events), cycle,
            )

        # ── 3. Analyse each notable event with Gemini ─────────────────
        for event in notable_events:
            try:
                assessment = await self._analyse_event(event, context)
                results.append(assessment)
            except Exception as exc:
                logger.error("Threat analysis failed for event: %s", exc)
                await self.log_action("error", {
                    "error": f"Analysis failed: {exc}",
                    "event_type": event.get("type", "unknown"),
                })

        # ── 4. Periodic alert sweep ───────────────────────────────────
        if cycle > 0 and cycle % self._sweep_interval == 0:
            try:
                await self._sweep_active_alerts()
            except Exception as exc:
                logger.error("Alert sweep failed: %s", exc)
                await self.log_action("error", {"error": f"Sweep failed: {exc}"})

        return {"notable_events_processed": len(notable_events), "results": results}

    # ── Event filtering ───────────────────────────────────────────────

    def _filter_notable_events(
        self,
        perception_events: list[dict],
        anomaly_events: list[dict],
        cortex_directives: list[dict],
    ) -> list[dict]:
        """Select events worth deep analysis.

        Notable events include:
        - Any anomaly detection (these are pre-filtered by the anomaly detector)
        - Perception events with medium+ severity or high confidence threats
        - Direct analysis requests from the Cortex supervisor
        """
        notable = []

        # All anomalies are notable by definition
        for event in anomaly_events:
            event["_analysis_priority"] = "high"
            event["_source"] = "anomaly"
            notable.append(event)

        # Cortex directives are always honoured
        for directive in cortex_directives:
            if directive.get("type") in ("analyze_threat", "investigate", "assess"):
                directive["_analysis_priority"] = "critical"
                directive["_source"] = "cortex"
                notable.append(directive)

        # Perception events — filter for significance
        for event in perception_events:
            severity = event.get("severity", "info")
            confidence = event.get("confidence", 0.0)
            person_count = event.get("person_count", 0)
            threats = event.get("threats", [])

            is_notable = (
                severity in ("medium", "high", "critical")
                or confidence >= 0.7
                or len(threats) > 0
                or person_count > 5  # unusual crowd
            )
            if is_notable:
                event["_analysis_priority"] = "medium"
                event["_source"] = "perception"
                notable.append(event)

        # Cap to avoid overload — prioritise by priority level
        priority_order = {"critical": 0, "high": 1, "medium": 2}
        notable.sort(key=lambda e: priority_order.get(e.get("_analysis_priority", "medium"), 2))
        return notable[:5]  # max 5 deep analyses per cycle

    # ── Deep event analysis ───────────────────────────────────────────

    async def _analyse_event(self, event: dict, context: dict) -> dict:
        """Run Gemini-powered deep threat analysis on a single event."""
        # Prepare context strings
        event_details = json.dumps(
            {k: v for k, v in event.items() if not k.startswith("_")},
            default=str,
        )[:3000]

        recent_events = context.get("short_term_memory", {}).get(
            "recent_events", "No recent context available"
        )
        if isinstance(recent_events, (dict, list)):
            recent_context = json.dumps(recent_events, default=str)[:2000]
        else:
            recent_context = str(recent_events)[:2000]

        site_ctx = "Will be retrieved via get_site_context tool"

        prompt = _ANALYSIS_PROMPT.format(
            event_details=event_details,
            recent_context=recent_context,
            site_context=site_ctx,
        )

        # Let Gemini reason and call tools autonomously
        result = await self.execute_tool_loop(prompt, context_data={
            "event": {k: v for k, v in event.items() if not k.startswith("_")},
            "cycle": context.get("cycle", 0),
            "timestamp": context.get("timestamp"),
        })

        response_text = result.get("response", "")
        tool_calls = result.get("tool_calls", [])

        # Parse the threat assessment from Gemini's response
        assessment = self._parse_assessment(response_text)
        assessment["tool_calls_made"] = len(tool_calls)
        assessment["source_event"] = event.get("type", "unknown")
        assessment["camera_id"] = event.get("camera_id")

        # ── Act on high-probability threats ───────────────────────────
        threat_probability = assessment.get("threat_probability", 0)
        if threat_probability > 60:
            await self._handle_confirmed_threat(assessment, event)

        # Store in short-term memory for context continuity
        await self.remember(
            f"last_analysis_{event.get('camera_id', 'unknown')}",
            {
                "threat_probability": threat_probability,
                "signature": assessment.get("matching_signature", "none"),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
            ttl=600,  # 10 minutes
        )

        await self.log_action("decision", {
            "decision": f"threat_probability={threat_probability}%",
            "confidence": assessment.get("confidence", 0),
            "prompt_summary": f"Threat analysis for {event.get('type', 'unknown')}",
            "response_summary": response_text[:300],
        })

        return assessment

    def _parse_assessment(self, response_text: str) -> dict:
        """Extract structured assessment from Gemini response.

        Attempts JSON parsing first; falls back to keyword extraction.
        """
        # Try to find JSON block in the response
        try:
            # Look for JSON between curly braces
            start = response_text.index("{")
            end = response_text.rindex("}") + 1
            parsed = json.loads(response_text[start:end])
            return {
                "benign_explanation": parsed.get("benign_explanation", ""),
                "threat_explanation": parsed.get("threat_explanation", ""),
                "evidence_for_threat": parsed.get("evidence_for_threat", []),
                "evidence_against_threat": parsed.get("evidence_against_threat", []),
                "threat_probability": int(parsed.get("threat_probability", 0)),
                "matching_signature": parsed.get("matching_signature", "none"),
                "recommended_severity": parsed.get("recommended_severity", "info"),
                "recommended_response": parsed.get("recommended_response", ""),
                "confidence": float(parsed.get("confidence", 0.0)),
            }
        except (ValueError, json.JSONDecodeError, TypeError):
            logger.debug("Could not parse JSON from threat analysis response")
            return {
                "benign_explanation": "",
                "threat_explanation": "",
                "evidence_for_threat": [],
                "evidence_against_threat": [],
                "threat_probability": 0,
                "matching_signature": "none",
                "recommended_severity": "info",
                "recommended_response": "",
                "confidence": 0.0,
                "raw_response": response_text[:1000],
            }

    async def _handle_confirmed_threat(self, assessment: dict, event: dict) -> None:
        """Create an alert, publish to CH_THREATS, and trigger auto-learning for novel threats."""
        from backend.services.threat_engine import ThreatEngine

        camera_id = event.get("camera_id", "unknown")
        severity = assessment.get("recommended_severity", "medium")
        signature = assessment.get("matching_signature", "unknown_threat")
        confidence = assessment.get("confidence", 0.5)
        probability = assessment.get("threat_probability", 0)

        threat_msg = {
            "type": "threat_assessment",
            "camera_id": camera_id,
            "threat_probability": probability,
            "severity": severity,
            "signature": signature,
            "confidence": confidence,
            "benign_explanation": assessment.get("benign_explanation", ""),
            "threat_explanation": assessment.get("threat_explanation", ""),
            "evidence": assessment.get("evidence_for_threat", []),
            "recommended_response": assessment.get("recommended_response", ""),
            "source_event_type": event.get("type", "unknown"),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        # Publish threat assessment to inter-agent channel
        await self.send_message(CH_THREATS, threat_msg)

        # Store confirmed threat in long-term memory for pattern learning
        await self.learn(
            knowledge=(
                f"Confirmed threat (prob={probability}%): {signature} on camera "
                f"{camera_id}. {assessment.get('threat_explanation', '')}"
            ),
            category="confirmed_threat",
            camera_id=camera_id,
        )

        logger.info(
            "Threat confirmed: prob=%d%% severity=%s signature=%s camera=%s",
            probability, severity, signature, camera_id,
        )

        # ── Auto-learn novel threats ────────────────────────────────
        engine = ThreatEngine()
        is_novel = signature in ("none", "unknown_threat", "Unknown Threat", "")
        if is_novel and probability >= 70 and confidence >= 0.6:
            try:
                learned = await engine.auto_learn_signature(
                    threat_explanation=assessment.get("threat_explanation", ""),
                    evidence=assessment.get("evidence_for_threat", []),
                    recommended_severity=severity,
                    camera_id=camera_id,
                    event_id=str(event.get("event_id", "")),
                )
                if learned:
                    logger.info(
                        "Auto-learned new signature: %s (category=%s)",
                        learned["name"], learned["category"],
                    )
                    await self.send_message(CH_THREATS, {
                        "type": "signature_learned",
                        "signature_name": learned["name"],
                        "category": learned["category"],
                        "severity": learned["severity"],
                        "camera_id": camera_id,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    })
                    await self.log_action("auto_learn", {
                        "signature_name": learned["name"],
                        "category": learned["category"],
                        "source_probability": probability,
                    })
            except Exception as exc:
                logger.error("Auto-learn failed: %s", exc)
        elif not is_novel:
            # Track detection count for matched signatures
            try:
                await engine.increment_detection_count(signature)
            except Exception as exc:
                logger.debug("Detection count update failed: %s", exc)

    # ── Periodic alert sweep ──────────────────────────────────────────

    async def _sweep_active_alerts(self) -> None:
        """Review active alerts and reassess severities.

        Runs every 12th cycle (~60 seconds). Gathers current alert state
        and threat statistics, then asks Gemini to recommend adjustments.
        """
        logger.info("Performing periodic alert sweep")

        # Gather current state via tool loop
        result = await self.execute_tool_loop(
            _SWEEP_PROMPT.format(
                active_alerts="Retrieve via get_alert_history tool (status=new or escalated)",
                threat_stats="Retrieve via get_threat_statistics tool",
            ),
        )

        response_text = result.get("response", "")

        # Parse reassessments
        try:
            start = response_text.index("{")
            end = response_text.rindex("}") + 1
            parsed = json.loads(response_text[start:end])
            reassessments = parsed.get("reassessments", [])
            posture = parsed.get("overall_threat_posture", "unknown")
        except (ValueError, json.JSONDecodeError, TypeError):
            reassessments = []
            posture = "unknown"

        # Act on escalation recommendations
        for item in reassessments:
            action = item.get("action", "maintain")
            alert_id = item.get("alert_id")
            if not alert_id:
                continue

            if action == "escalate":
                new_sev = item.get("recommended_severity", "high")
                reason = item.get("reasoning", "Automated reassessment escalation")
                # The escalate_alert tool would have been called by Gemini
                # during the tool loop, but log the decision
                await self.log_action("decision", {
                    "decision": f"escalate_alert_{alert_id}",
                    "confidence": 0.8,
                    "prompt_summary": f"Sweep escalation: {reason}",
                })

        # Update short-term memory with current threat posture
        await self.remember("threat_posture", {
            "posture": posture,
            "active_reassessments": len(reassessments),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }, ttl=300)

        await self.log_action("sweep_complete", {
            "reassessments": len(reassessments),
            "threat_posture": posture,
        })
