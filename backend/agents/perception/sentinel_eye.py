"""Sentinel Eye Agent — always-on continuous scene understanding.

Performs continuous round-robin monitoring across all active cameras.
Each cycle selects the next camera, pulls YOLO detections, and when
notable activity is present, uses Gemini function-calling for deeper
scene analysis.  Noteworthy findings are published to the perceptions
channel for consumption by reasoning-tier agents.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import CH_CORTEX, CH_PERCEPTIONS

logger = logging.getLogger(__name__)

# ── Gemini prompt template ───────────────────────────────────────────
_SCENE_ANALYSIS_PROMPT = """\
You are monitoring camera **{camera_name}** (ID: {camera_id}) located at \
**{camera_location}**.

**YOLO Detection Summary:**
- Persons detected: {person_count}
- Vehicles detected: {vehicle_count}
- Total objects: {total_objects}
- Active tracks: {active_tracks}
- Object details: {detection_details}
- Dwell times: {dwell_times}

**Site context:**
{site_context}

**Previous analysis for this camera (if available):**
{previous_analysis}

Analyse the scene for security-relevant activity. Consider:
1. Unusual person positioning or loitering (high dwell times)
2. Vehicles in unexpected areas
3. Time-of-day anomalies (e.g. people in restricted areas after hours)
4. Objects that appear out of place
5. Changes from the previous analysis

Respond with structured JSON:
{{
  "scene_summary": "<concise 1-2 sentence summary>",
  "activity_level": "<quiet|normal|busy|crowded>",
  "notable_observations": ["<observation 1>", ...],
  "potential_concerns": ["<concern 1>", ...],
  "severity_estimate": "<info|low|medium|high|critical>",
  "confidence": <0.0-1.0>,
  "changes_from_previous": "<description of scene changes or 'initial observation'>"
}}
"""


class SentinelEyeAgent(BaseAgent):
    """Always-on continuous scene understanding agent.

    Cycles through every active camera in round-robin order, pulling
    live YOLO detections and — when warranted — invoking Gemini for
    richer contextual analysis.  Publishes structured PerceptionEvent
    messages to ``CH_PERCEPTIONS``.
    """

    def __init__(self) -> None:
        super().__init__(
            name="sentinel_eye",
            role="Continuous Scene Monitor",
            description=(
                "Always-on perception agent that continuously monitors all "
                "active cameras via round-robin scanning. Pulls YOLO "
                "detections, assesses scene context with Gemini, and "
                "publishes noteworthy observations to the perceptions channel."
            ),
            tier="perception",
            model_name="gemma3:27b-cloud",
            tool_names=[
                "capture_frame",
                "get_current_detections",
                "analyze_frame_with_gemini",
                "get_zone_occupancy",
                "get_site_context",
                "store_observation",
            ],
            subscriptions=[CH_CORTEX],
            cycle_interval=2.0,
            token_budget_per_cycle=15000,  # Perception: lightweight analysis only
        )

    # ── Core reasoning ────────────────────────────────────────────────

    async def think(self, context: dict) -> dict:
        """Main perception loop executed every cycle.

        1. Fetch all camera statuses and determine which camera to scan next
           (round-robin tracked via short-term memory).
        2. Pull current YOLO detections for the selected camera.
        3. If detections contain people or notable activity, invoke Gemini
           via ``execute_tool_loop`` for deeper scene analysis.
        4. If the analysis is noteworthy (not routine), publish a
           PerceptionEvent to ``CH_PERCEPTIONS``.
        5. Cache the latest analysis per camera for continuity tracking.
        6. Detect scene changes by comparing against the previous analysis.
        """
        cycle = context.get("cycle", 0)

        # ── 1. Pick next camera via round-robin ──────────────────────
        camera = await self._select_next_camera()
        if camera is None:
            logger.debug("Sentinel Eye: no active cameras available")
            return {"status": "idle", "reason": "no_active_cameras"}

        camera_id = camera["id"]
        camera_name = camera.get("name", camera_id)
        camera_location = camera.get("location", "unknown")

        # ── 2. Get YOLO detections ───────────────────────────────────
        from backend.agents.agent_tools import TOOL_REGISTRY

        detections_result = await TOOL_REGISTRY["get_current_detections"]["fn"](
            camera_id=camera_id,
        )

        if not detections_result.get("success"):
            logger.debug(
                "Sentinel Eye: no detections available for camera %s",
                camera_id,
            )
            return {"status": "skip", "camera_id": camera_id, "reason": "no_frame"}

        person_count = detections_result.get("person_count", 0)
        vehicle_count = detections_result.get("vehicle_count", 0)
        total_objects = detections_result.get("total_objects", 0)
        active_tracks = detections_result.get("active_tracks", 0)
        raw_detections = detections_result.get("detections", [])

        # ── 3. Decide whether Gemini analysis is warranted ───────────
        # Skip AI if scene is unchanged from last analysis (save tokens)
        previous = await self.recall(f"last_analysis_{camera_id}")
        scene_changed = True
        if previous and isinstance(previous, dict):
            scene_changed = (
                previous.get("person_count") != person_count
                or previous.get("vehicle_count") != vehicle_count
                or abs(previous.get("total_objects", 0) - total_objects) > 1
                or any(d.get("dwell_time", 0) > 60 for d in raw_detections)
            )

        needs_analysis = scene_changed and (
            person_count > 0
            or vehicle_count > 0
            or total_objects > 2
            or any(d.get("dwell_time", 0) > 30 for d in raw_detections)
            or any(d.get("is_stationary") for d in raw_detections)
        )

        analysis_text = ""
        assessment: dict = {}

        if needs_analysis:
            assessment = await self._run_scene_analysis(
                camera_id=camera_id,
                camera_name=camera_name,
                camera_location=camera_location,
                detections_result=detections_result,
                raw_detections=raw_detections,
                context=context,
            )
            analysis_text = assessment.get("raw_response", "")
        elif not scene_changed:
            logger.debug(
                "Sentinel Eye: skipping AI for camera %s — scene unchanged",
                camera_id,
            )

        # ── 4. Publish if noteworthy ─────────────────────────────────
        severity = assessment.get("severity_estimate", "info")
        is_noteworthy = severity in ("low", "medium", "high", "critical") or (
            assessment.get("notable_observations") and len(assessment.get("notable_observations", [])) > 0
        )

        if is_noteworthy:
            await self.send_message(CH_PERCEPTIONS, {
                "type": "scene_analysis",
                "camera_id": camera_id,
                "camera_name": camera_name,
                "camera_location": camera_location,
                "person_count": person_count,
                "vehicle_count": vehicle_count,
                "total_objects": total_objects,
                "active_tracks": active_tracks,
                "detections": raw_detections[:20],  # cap for message size
                "analysis": assessment.get("scene_summary", ""),
                "notable_observations": assessment.get("notable_observations", []),
                "potential_concerns": assessment.get("potential_concerns", []),
                "severity": severity,
                "confidence": assessment.get("confidence", 0.0),
                "changes_from_previous": assessment.get("changes_from_previous", ""),
                "activity_level": assessment.get("activity_level", "unknown"),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

        # ── 5. Remember last analysis per camera ─────────────────────
        await self.remember(
            f"last_analysis_{camera_id}",
            {
                "person_count": person_count,
                "vehicle_count": vehicle_count,
                "total_objects": total_objects,
                "severity": severity,
                "summary": assessment.get("scene_summary", "No analysis performed"),
                "notable": assessment.get("notable_observations", []),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
            ttl=60,
        )

        # ── 6. Log action ────────────────────────────────────────────
        await self.log_action("perception_scan", {
            "camera_id": camera_id,
            "person_count": person_count,
            "vehicle_count": vehicle_count,
            "severity": severity,
            "noteworthy": is_noteworthy,
            "decision": f"camera={camera_name} persons={person_count} severity={severity}",
        })

        return {
            "status": "scanned",
            "camera_id": camera_id,
            "person_count": person_count,
            "severity": severity,
            "noteworthy": is_noteworthy,
        }

    # ── Camera selection (round-robin) ───────────────────────────────

    async def _select_next_camera(self) -> dict | None:
        """Select the next camera to analyze via round-robin.

        Tracks the current index in short-term memory so it persists
        across cycles.
        """
        from backend.agents.agent_tools import TOOL_REGISTRY

        cameras_result = await TOOL_REGISTRY["get_all_cameras_status"]["fn"]()
        if not cameras_result.get("success"):
            return None

        cameras = [
            c for c in cameras_result.get("cameras", [])
            if c.get("status") == "online"
        ]
        if not cameras:
            return None

        # Recall current round-robin index
        rr_index = await self.recall("camera_rr_index")
        if rr_index is None:
            rr_index = 0
        else:
            rr_index = int(rr_index)

        # Wrap around
        if rr_index >= len(cameras):
            rr_index = 0

        selected = cameras[rr_index]

        # Advance index
        await self.remember("camera_rr_index", rr_index + 1, ttl=300)

        return selected

    # ── Scene analysis with Gemini ───────────────────────────────────

    async def _run_scene_analysis(
        self,
        camera_id: str,
        camera_name: str,
        camera_location: str,
        detections_result: dict,
        raw_detections: list[dict],
        context: dict,
    ) -> dict:
        """Invoke Gemini function-calling loop for scene analysis."""

        # Build detection details
        detection_details = json.dumps(
            [
                {
                    "class": d.get("class", "unknown"),
                    "confidence": d.get("confidence", 0),
                    "track_id": d.get("track_id"),
                    "stationary": d.get("is_stationary", False),
                }
                for d in raw_detections
            ],
            default=str,
        )[:2000]

        dwell_times = json.dumps(
            [
                {
                    "track_id": d.get("track_id"),
                    "class": d.get("class", "unknown"),
                    "dwell_seconds": d.get("dwell_time", 0),
                }
                for d in raw_detections
                if d.get("dwell_time", 0) > 5
            ],
            default=str,
        )[:1000]

        # Recall previous analysis for scene continuity
        previous = await self.recall(f"last_analysis_{camera_id}")
        if previous:
            previous_analysis = json.dumps(previous, default=str)[:1500]
        else:
            previous_analysis = "No previous analysis — this is the first scan."

        # Get site context
        from backend.agents.agent_tools import TOOL_REGISTRY
        site_ctx_result = await TOOL_REGISTRY["get_site_context"]["fn"]()
        site_context = json.dumps(site_ctx_result, default=str)[:500]

        prompt = _SCENE_ANALYSIS_PROMPT.format(
            camera_id=camera_id,
            camera_name=camera_name,
            camera_location=camera_location,
            person_count=detections_result.get("person_count", 0),
            vehicle_count=detections_result.get("vehicle_count", 0),
            total_objects=detections_result.get("total_objects", 0),
            active_tracks=detections_result.get("active_tracks", 0),
            detection_details=detection_details,
            dwell_times=dwell_times,
            site_context=site_context,
            previous_analysis=previous_analysis,
        )

        result = await self.execute_tool_loop(prompt, context_data={
            "camera_id": camera_id,
            "cycle": context.get("cycle", 0),
            "timestamp": context.get("timestamp"),
        })

        response_text = result.get("response", "")
        return self._parse_scene_assessment(response_text)

    # ── Response parsing ─────────────────────────────────────────────

    @staticmethod
    def _parse_scene_assessment(response_text: str) -> dict:
        """Extract structured assessment from Gemini response."""
        try:
            start = response_text.index("{")
            end = response_text.rindex("}") + 1
            parsed = json.loads(response_text[start:end])
            return {
                "scene_summary": parsed.get("scene_summary", ""),
                "activity_level": parsed.get("activity_level", "unknown"),
                "notable_observations": parsed.get("notable_observations", []),
                "potential_concerns": parsed.get("potential_concerns", []),
                "severity_estimate": parsed.get("severity_estimate", "info"),
                "confidence": float(parsed.get("confidence", 0.0)),
                "changes_from_previous": parsed.get(
                    "changes_from_previous", "initial observation"
                ),
                "raw_response": response_text[:500],
            }
        except (ValueError, json.JSONDecodeError, TypeError):
            logger.debug("Could not parse JSON from scene analysis response")
            return {
                "scene_summary": response_text[:300] if response_text else "",
                "activity_level": "unknown",
                "notable_observations": [],
                "potential_concerns": [],
                "severity_estimate": "info",
                "confidence": 0.0,
                "changes_from_previous": "initial observation",
                "raw_response": response_text[:500] if response_text else "",
            }
