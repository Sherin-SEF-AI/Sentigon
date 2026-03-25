"""Anomaly Detector Agent — behavioral anomaly detection.

Subscribes to perception events from Sentinel Eye and Patrol Agent,
compares them against learned baselines, and uses Gemini reasoning
to identify and score behavioral anomalies.  High-scoring anomalies
are published to the anomalies channel.  When scenes are consistently
normal, the agent updates baselines through long-term memory learning.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import (
    CH_PERCEPTIONS,
    CH_CORTEX,
    CH_ANOMALIES,
)

logger = logging.getLogger(__name__)

# Threshold above which an anomaly is published
_ANOMALY_PUBLISH_THRESHOLD = 6

# Number of consecutive normal cycles before updating the baseline
_BASELINE_UPDATE_INTERVAL = 10

# ── Gemini prompt template ───────────────────────────────────────────
_ANOMALY_PROMPT = """\
You are a behavioural anomaly detection system for a physical security \
installation.  Your job is to compare current scene observations against \
the learned baseline and identify deviations.

**Current perception event:**
{event_details}

**Learned baseline for this camera / time window:**
{baseline}

**Site context:**
{site_context}

**Recent event history (last 30 min):**
{event_history}

Identify anomalies by comparing current observations against the baseline. \
Consider:
1. **Person count anomaly** — significantly more or fewer people than usual
2. **Unexpected activity** — types of activity not seen in baseline
3. **Object anomaly** — objects present that don't belong (bags, equipment)
4. **Behavioural deviation** — loitering, running, unusual movement patterns
5. **Temporal anomaly** — activity happening at an unusual time
6. **Spatial anomaly** — activity in areas normally unoccupied

For each anomaly, provide a score from 1 to 10:
- 1-3: Minor deviation, likely benign
- 4-6: Moderate deviation, worth noting
- 7-8: Significant anomaly, requires attention
- 9-10: Critical anomaly, likely security incident

Respond with structured JSON:
{{
  "anomalies_detected": <true|false>,
  "anomalies": [
    {{
      "type": "<person_count|unexpected_activity|object|behavioural|temporal|spatial>",
      "description": "<detailed description>",
      "score": <1-10>,
      "baseline_comparison": "<what was expected vs what was observed>",
      "possible_explanations": ["<explanation 1>", ...],
      "confidence": <0.0-1.0>
    }}
  ],
  "max_anomaly_score": <1-10>,
  "overall_assessment": "<normal|slightly_unusual|moderately_unusual|highly_unusual|critical>",
  "scene_matches_baseline": <true|false>,
  "summary": "<1-2 sentence summary>"
}}
"""

_SIMILAR_SEARCH_PROMPT = "anomaly {anomaly_type} on camera {camera_id}"


class AnomalyDetectorAgent(BaseAgent):
    """Behavioural anomaly detection agent.

    Processes perception events, compares against learned baselines,
    scores deviations via Gemini, and publishes confirmed anomalies
    to ``CH_ANOMALIES`` for reasoning-tier consumption.
    """

    def __init__(self) -> None:
        super().__init__(
            name="anomaly_detector",
            role="Behavioural Anomaly Detector",
            description=(
                "Monitors perception events and compares them against "
                "learned activity baselines. Uses Gemini reasoning to "
                "identify, classify, and score behavioural anomalies. "
                "Publishes high-score anomalies to the anomalies channel "
                "and continuously learns new baselines from normal activity."
            ),
            tier="perception",
            model_name="gemma3:27b-cloud",
            tool_names=[
                "get_current_detections",
                "get_event_history",
                "get_activity_baseline",
                "analyze_frame_with_gemini",
                "semantic_search_video",
                "store_observation",
                "recall_observations",
                "get_site_context",
            ],
            subscriptions=[CH_PERCEPTIONS, CH_CORTEX],
            cycle_interval=5.0,
            token_budget_per_cycle=15000,
        )
        # Tracks how many consecutive cycles had no anomalies per camera
        # (used to decide when to update baselines)
        self._normal_streak: dict[str, int] = {}

    # ── Core reasoning ────────────────────────────────────────────────

    async def think(self, context: dict) -> dict:
        """Main anomaly detection loop.

        1. Check inbox for perception events from Sentinel Eye / Patrol Agent.
        2. For each perception event, compare against the learned baseline.
        3. Use ``execute_tool_loop`` to let Gemini identify anomalies.
        4. If any anomaly scores above the threshold, publish to ``CH_ANOMALIES``.
        5. If no anomalies after several cycles, update baseline via ``learn()``.
        6. Use ``semantic_search_video`` to check for prior similar anomalies.
        """
        inbox = context.get("inbox_messages", [])
        cycle = context.get("cycle", 0)
        results: list[dict] = []

        # ── 1. Filter for perception events ──────────────────────────
        perception_events = []
        cortex_directives = []

        for msg in inbox:
            channel = msg.get("_channel", "")
            msg_type = msg.get("type", "")

            if channel == CH_PERCEPTIONS or msg_type in (
                "scene_analysis", "patrol_finding", "detection",
            ):
                perception_events.append(msg)
            elif channel == CH_CORTEX:
                cortex_directives.append(msg)

        # Also handle direct analysis requests from Cortex
        for directive in cortex_directives:
            if directive.get("type") in ("check_anomaly", "analyze_baseline"):
                perception_events.append(directive)

        if not perception_events:
            # No new events — still track normal streak for baseline updates
            return {"status": "idle", "events_processed": 0}

        # ── 2-6. Process each perception event ───────────────────────
        for event in perception_events[:5]:  # cap per cycle
            try:
                assessment = await self._analyze_for_anomalies(event, context)
                results.append(assessment)
            except Exception as exc:
                logger.error("Anomaly analysis failed: %s", exc)
                await self.log_action("error", {
                    "error": f"Anomaly analysis failed: {exc}",
                    "camera_id": event.get("camera_id", "unknown"),
                })

        return {
            "status": "processed",
            "events_processed": len(results),
            "anomalies_found": sum(
                1 for r in results if r.get("anomalies_detected")
            ),
            "results": results,
        }

    # ── Anomaly analysis pipeline ────────────────────────────────────

    async def _analyze_for_anomalies(
        self, event: dict, context: dict
    ) -> dict:
        """Analyse a single perception event for anomalies."""
        camera_id = event.get("camera_id", "unknown")

        # ── 2. Recall learned baseline ───────────────────────────────
        baseline_memories = await self.recall_knowledge(
            category="baseline", limit=5
        )
        camera_baselines = [
            m for m in baseline_memories
            if m.get("camera_id") == camera_id
        ]

        # Also try the tool-based baseline
        from backend.agents.agent_tools import TOOL_REGISTRY
        baseline_tool_result = await TOOL_REGISTRY["get_activity_baseline"]["fn"](
            camera_id=camera_id,
        )
        baseline_data = baseline_tool_result.get("baselines", [])

        combined_baseline = camera_baselines + baseline_data
        baseline_str = (
            json.dumps(combined_baseline, default=str)[:2000]
            if combined_baseline
            else "No baseline established yet — treat this as initial observation."
        )

        # Get site context
        site_ctx = await TOOL_REGISTRY["get_site_context"]["fn"]()

        # Get recent event history for broader context
        event_history_result = await TOOL_REGISTRY["get_event_history"]["fn"](
            camera_id=camera_id, minutes=30, limit=10,
        )
        event_history_str = json.dumps(
            event_history_result.get("events", []), default=str
        )[:2000]

        # ── 3. Send to Gemini for anomaly detection ──────────────────
        event_details = json.dumps(
            {k: v for k, v in event.items() if not k.startswith("_")},
            default=str,
        )[:3000]

        prompt = _ANOMALY_PROMPT.format(
            event_details=event_details,
            baseline=baseline_str,
            site_context=json.dumps(site_ctx, default=str)[:500],
            event_history=event_history_str,
        )

        result = await self.execute_tool_loop(prompt, context_data={
            "camera_id": camera_id,
            "cycle": context.get("cycle", 0),
            "timestamp": context.get("timestamp"),
        })

        response_text = result.get("response", "")
        assessment = self._parse_anomaly_assessment(response_text)
        assessment["camera_id"] = camera_id

        # ── 4. Publish if above threshold ────────────────────────────
        max_score = assessment.get("max_anomaly_score", 0)
        anomalies = assessment.get("anomalies", [])

        if max_score >= _ANOMALY_PUBLISH_THRESHOLD:
            # Reset normal streak
            self._normal_streak[camera_id] = 0

            # Search for similar past anomalies
            similar_results = await self._search_similar_anomalies(
                camera_id, anomalies
            )

            await self.send_message(CH_ANOMALIES, {
                "type": "anomaly_detected",
                "camera_id": camera_id,
                "camera_name": event.get("camera_name", camera_id),
                "anomalies": anomalies,
                "max_anomaly_score": max_score,
                "overall_assessment": assessment.get(
                    "overall_assessment", "unknown"
                ),
                "summary": assessment.get("summary", ""),
                "source_event_type": event.get("type", "unknown"),
                "source_severity": event.get("severity", "info"),
                "similar_past_anomalies": similar_results,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

            # Store anomaly observation in long-term memory
            await self.learn(
                knowledge=(
                    f"Anomaly detected (max_score={max_score}): "
                    f"{assessment.get('summary', 'no summary')}"
                ),
                category="anomaly",
                camera_id=camera_id,
            )

            await self.log_action("anomaly_detected", {
                "camera_id": camera_id,
                "max_score": max_score,
                "anomaly_count": len(anomalies),
                "decision": (
                    f"anomaly score={max_score} on camera {camera_id}, "
                    f"published to CH_ANOMALIES"
                ),
            })
        else:
            # ── 5. Track normal streak and update baseline ───────────
            streak = self._normal_streak.get(camera_id, 0) + 1
            self._normal_streak[camera_id] = streak

            if streak >= _BASELINE_UPDATE_INTERVAL:
                await self._update_baseline(camera_id, event, assessment)
                self._normal_streak[camera_id] = 0

                await self.log_action("baseline_updated", {
                    "camera_id": camera_id,
                    "normal_streak": streak,
                    "decision": f"Updated baseline for camera {camera_id} after {streak} normal cycles",
                })

        # Store latest assessment in short-term memory for continuity
        await self.remember(
            f"last_anomaly_check_{camera_id}",
            {
                "max_score": max_score,
                "anomaly_count": len(anomalies),
                "overall_assessment": assessment.get("overall_assessment", "normal"),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
            ttl=120,
        )

        return assessment

    # ── Similar anomaly search ───────────────────────────────────────

    async def _search_similar_anomalies(
        self, camera_id: str, anomalies: list[dict]
    ) -> list[dict]:
        """Search long-term memory and vector store for similar past anomalies."""
        similar: list[dict] = []
        if not anomalies:
            return similar

        from backend.agents.agent_tools import TOOL_REGISTRY

        # Use the highest-scoring anomaly for the search query
        top_anomaly = max(anomalies, key=lambda a: a.get("score", 0))
        query = _SIMILAR_SEARCH_PROMPT.format(
            anomaly_type=top_anomaly.get("type", "unknown"),
            camera_id=camera_id,
        )

        try:
            search_result = await TOOL_REGISTRY["semantic_search_video"]["fn"](
                query=query, time_range_minutes=1440, max_results=5,
            )
            if search_result.get("success"):
                similar = search_result.get("results", [])
        except Exception as exc:
            logger.debug("Similar anomaly search failed: %s", exc)

        return similar

    # ── Baseline updates ─────────────────────────────────────────────

    async def _update_baseline(
        self, camera_id: str, event: dict, assessment: dict
    ) -> None:
        """Store current normal observations as a new baseline entry."""
        now = datetime.now(timezone.utc)
        baseline_entry = (
            f"Baseline at {now.strftime('%A %H:%M')}: "
            f"person_count={event.get('person_count', 0)}, "
            f"vehicle_count={event.get('vehicle_count', 0)}, "
            f"total_objects={event.get('total_objects', 0)}, "
            f"activity_level={event.get('activity_level', 'unknown')}, "
            f"assessment={assessment.get('overall_assessment', 'normal')}"
        )

        await self.learn(
            knowledge=baseline_entry,
            category="baseline",
            camera_id=camera_id,
        )

        logger.info(
            "Anomaly Detector: updated baseline for camera %s", camera_id
        )

    # ── Response parsing ─────────────────────────────────────────────

    @staticmethod
    def _parse_anomaly_assessment(response_text: str) -> dict:
        """Extract structured anomaly assessment from Gemini response."""
        try:
            start = response_text.index("{")
            end = response_text.rindex("}") + 1
            parsed = json.loads(response_text[start:end])
            return {
                "anomalies_detected": bool(parsed.get("anomalies_detected", False)),
                "anomalies": parsed.get("anomalies", []),
                "max_anomaly_score": int(parsed.get("max_anomaly_score", 0)),
                "overall_assessment": parsed.get("overall_assessment", "normal"),
                "scene_matches_baseline": bool(
                    parsed.get("scene_matches_baseline", True)
                ),
                "summary": parsed.get("summary", ""),
            }
        except (ValueError, json.JSONDecodeError, TypeError):
            logger.debug("Could not parse JSON from anomaly analysis response")
            return {
                "anomalies_detected": False,
                "anomalies": [],
                "max_anomaly_score": 0,
                "overall_assessment": "normal",
                "scene_matches_baseline": True,
                "summary": response_text[:300] if response_text else "",
                "raw_response": response_text[:500] if response_text else "",
            }
