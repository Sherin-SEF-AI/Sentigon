"""Patrol Agent — virtual security patrol across cameras.

Performs periodic patrol rounds by maintaining a priority-weighted queue
of cameras to inspect.  Cameras that have not been patrolled recently or
that belong to high-sensitivity zones are prioritised.  Each patrol
captures a frame, sends it to Gemini for analysis, compares with the
remembered baseline, and publishes findings to the perceptions channel.
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import CH_CORTEX, CH_PERCEPTIONS

logger = logging.getLogger(__name__)

# ── Zone sensitivity weights (higher = checked more frequently) ──────
_ZONE_SENSITIVITY = {
    "restricted": 10,
    "secure": 8,
    "entrance": 7,
    "exit": 7,
    "perimeter": 6,
    "parking": 5,
    "hallway": 4,
    "lobby": 4,
    "office": 3,
    "common": 2,
    "default": 3,
}

# ── Gemini patrol prompt template ────────────────────────────────────
_PATROL_PROMPT = """\
You are performing a **virtual security patrol** of zone **{zone_name}** \
via camera **{camera_name}** (ID: {camera_id}).

**Patrol context:**
- Zone type: {zone_type}
- Zone sensitivity: {zone_sensitivity}
- Last patrol of this camera: {last_patrol_ago}
- Current time: {current_time} ({period})
- Business hours: {business_hours}

**Site context:**
{site_context}

**Baseline observations for this camera (if any):**
{baseline}

Inspect the scene carefully. Look for:
1. **Unusual activity** — people in areas that should be empty, unexpected \
gatherings
2. **Physical security** — doors that should be closed/locked, propped-open \
fire exits, windows left open
3. **Unauthorised objects** — bags left unattended, vehicles in restricted \
spots, unfamiliar equipment
4. **Environmental issues** — lights that should be on/off, spills, \
obstructions in walkways
5. **Perimeter integrity** — fence damage, gate left open, blind spots

Respond with structured JSON:
{{
  "patrol_summary": "<concise 1-2 sentence summary of findings>",
  "findings": [
    {{
      "category": "<unusual_activity|physical_security|unauthorized_object|environmental|perimeter>",
      "description": "<detailed finding>",
      "severity": "<info|low|medium|high|critical>",
      "confidence": <0.0-1.0>
    }}
  ],
  "all_clear": <true|false>,
  "overall_severity": "<info|low|medium|high|critical>",
  "deviations_from_baseline": ["<deviation 1>", ...],
  "recommended_actions": ["<action 1>", ...]
}}
"""


class PatrolAgent(BaseAgent):
    """Virtual security patrol agent.

    Maintains a priority queue of cameras and systematically patrols
    each one on a rolling basis, analysing frames with Gemini and
    tracking deviations from learned baselines.
    """

    def __init__(self) -> None:
        super().__init__(
            name="patrol_agent",
            role="Virtual Security Patrol",
            description=(
                "Performs virtual security patrols by cycling through "
                "cameras in priority order weighted by zone sensitivity "
                "and time since last inspection. Captures frames, analyses "
                "with Gemini, compares against baselines, and reports "
                "findings to the perceptions channel."
            ),
            tier="perception",
            model_name="gemma3:27b-cloud",
            tool_names=[
                "capture_frame",
                "analyze_frame_with_gemini",
                "get_all_cameras_status",
                "get_all_zones_status",
                "get_site_context",
                "semantic_search_video",
            ],
            subscriptions=[CH_CORTEX],
            cycle_interval=30.0,
            token_budget_per_cycle=15000,
        )

    # ── Core reasoning ────────────────────────────────────────────────

    async def think(self, context: dict) -> dict:
        """Main patrol loop executed every cycle.

        1. Recall or rebuild the ``patrol_queue`` from short-term memory.
        2. Pop the highest-priority camera and capture a frame.
        3. Send to Gemini for analysis with patrol-specific prompting.
        4. Compare against recalled baseline observations.
        5. Publish findings to ``CH_PERCEPTIONS``.
        6. Update patrol memory and store observations for baseline
           learning.
        """
        cycle = context.get("cycle", 0)

        # ── 1. Get or build patrol queue ─────────────────────────────
        patrol_queue = await self._get_or_build_patrol_queue()
        if not patrol_queue:
            logger.debug("Patrol Agent: no cameras available for patrol")
            return {"status": "idle", "reason": "no_cameras"}

        # ── 2. Pop highest-priority camera ───────────────────────────
        target = patrol_queue.pop(0)  # first item = highest priority
        camera_id = target["camera_id"]
        camera_name = target.get("camera_name", camera_id)
        zone_name = target.get("zone_name", "unknown")
        zone_type = target.get("zone_type", "default")

        logger.info(
            "Patrol Agent: patrolling camera %s in zone %s (priority=%.1f)",
            camera_name, zone_name, target.get("priority", 0),
        )

        # Save remaining queue
        await self.remember("patrol_queue", patrol_queue, ttl=600)

        # ── 3. Capture frame for this camera ─────────────────────────
        from backend.agents.agent_tools import TOOL_REGISTRY

        capture_result = await TOOL_REGISTRY["capture_frame"]["fn"](
            camera_id=camera_id,
        )
        if not capture_result.get("success"):
            logger.debug("Patrol Agent: could not capture frame for %s", camera_id)
            await self.remember(f"last_patrol_{camera_id}", {
                "status": "failed",
                "timestamp": time.time(),
            }, ttl=600)
            return {"status": "skip", "camera_id": camera_id, "reason": "no_frame"}

        # ── 4. Gather context for analysis ───────────────────────────
        site_ctx = await TOOL_REGISTRY["get_site_context"]["fn"]()
        last_patrol_data = await self.recall(f"last_patrol_{camera_id}")
        last_patrol_ago = self._format_time_ago(last_patrol_data)

        # Recall baseline observations
        baseline_memories = await self.recall_knowledge(
            category="patrol_baseline", limit=5
        )
        camera_baselines = [
            m for m in baseline_memories
            if m.get("camera_id") == camera_id
        ]
        baseline_str = (
            json.dumps(camera_baselines, default=str)[:1500]
            if camera_baselines
            else "No baseline established yet for this camera."
        )

        # ── 5. Run Gemini patrol analysis ────────────────────────────
        zone_sensitivity = _ZONE_SENSITIVITY.get(zone_type, _ZONE_SENSITIVITY["default"])
        prompt = _PATROL_PROMPT.format(
            camera_id=camera_id,
            camera_name=camera_name,
            zone_name=zone_name,
            zone_type=zone_type,
            zone_sensitivity=zone_sensitivity,
            last_patrol_ago=last_patrol_ago,
            current_time=site_ctx.get("datetime", datetime.now().isoformat()),
            period=site_ctx.get("period", "unknown"),
            business_hours=site_ctx.get("business_hours", "unknown"),
            site_context=json.dumps(site_ctx, default=str)[:500],
            baseline=baseline_str,
        )

        result = await self.execute_tool_loop(prompt, context_data={
            "camera_id": camera_id,
            "zone_name": zone_name,
            "cycle": cycle,
        })

        response_text = result.get("response", "")
        assessment = self._parse_patrol_assessment(response_text)

        # ── 6. Publish findings if not all-clear ─────────────────────
        is_all_clear = assessment.get("all_clear", True)
        overall_severity = assessment.get("overall_severity", "info")
        findings = assessment.get("findings", [])

        if not is_all_clear or findings:
            await self.send_message(CH_PERCEPTIONS, {
                "type": "patrol_finding",
                "camera_id": camera_id,
                "camera_name": camera_name,
                "zone_name": zone_name,
                "zone_type": zone_type,
                "patrol_summary": assessment.get("patrol_summary", ""),
                "findings": findings,
                "all_clear": is_all_clear,
                "severity": overall_severity,
                "deviations_from_baseline": assessment.get(
                    "deviations_from_baseline", []
                ),
                "recommended_actions": assessment.get("recommended_actions", []),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

        # ── 7. Update patrol memory ──────────────────────────────────
        patrol_record = {
            "status": "completed",
            "timestamp": time.time(),
            "all_clear": is_all_clear,
            "severity": overall_severity,
            "findings_count": len(findings),
        }
        await self.remember(f"last_patrol_{camera_id}", patrol_record, ttl=3600)

        # ── 8. Store observations for baseline learning ──────────────
        if is_all_clear:
            await self.learn(
                knowledge=(
                    f"Patrol all-clear at camera {camera_name} ({zone_name}). "
                    f"Summary: {assessment.get('patrol_summary', 'normal')}"
                ),
                category="patrol_baseline",
                camera_id=camera_id,
            )

        await self.log_action("patrol_complete", {
            "camera_id": camera_id,
            "zone_name": zone_name,
            "all_clear": is_all_clear,
            "severity": overall_severity,
            "findings_count": len(findings),
            "decision": (
                f"patrol {camera_name}: "
                f"{'all clear' if is_all_clear else f'{len(findings)} finding(s)'}"
            ),
        })

        return {
            "status": "patrolled",
            "camera_id": camera_id,
            "all_clear": is_all_clear,
            "severity": overall_severity,
            "findings_count": len(findings),
        }

    # ── Patrol queue management ──────────────────────────────────────

    async def _get_or_build_patrol_queue(self) -> list[dict]:
        """Recall existing queue or build a new priority-weighted one."""
        queue = await self.recall("patrol_queue")
        if queue and isinstance(queue, list) and len(queue) > 0:
            return queue

        return await self._build_patrol_queue()

    async def _build_patrol_queue(self) -> list[dict]:
        """Build a priority-weighted patrol queue from all active cameras.

        Priority = zone_sensitivity_weight + time_since_last_patrol_bonus.
        """
        from backend.agents.agent_tools import TOOL_REGISTRY

        cameras_result = await TOOL_REGISTRY["get_all_cameras_status"]["fn"]()
        zones_result = await TOOL_REGISTRY["get_all_zones_status"]["fn"]()

        if not cameras_result.get("success"):
            return []

        cameras = [
            c for c in cameras_result.get("cameras", [])
            if c.get("status") == "online"
        ]

        # Build zone lookup
        zone_lookup: dict[str, dict] = {}
        for z in zones_result.get("zones", []):
            zone_lookup[z["id"]] = z

        queue = []
        now = time.time()

        for cam in cameras:
            camera_id = cam["id"]
            camera_name = cam.get("name", camera_id)
            location = cam.get("location", "")

            # Determine zone info (best-effort match)
            zone_name = location or "unknown"
            zone_type = "default"
            for z in zones_result.get("zones", []):
                if z.get("name", "").lower() in location.lower() or location.lower() in z.get("name", "").lower():
                    zone_name = z["name"]
                    zone_type = z.get("type", "default")
                    break

            # Calculate priority
            sensitivity = _ZONE_SENSITIVITY.get(zone_type, _ZONE_SENSITIVITY["default"])

            # Time since last patrol bonus (more time = higher priority)
            last_patrol = await self.recall(f"last_patrol_{camera_id}")
            if last_patrol and isinstance(last_patrol, dict):
                seconds_ago = now - last_patrol.get("timestamp", 0)
                time_bonus = min(seconds_ago / 60.0, 10.0)  # cap at 10
            else:
                time_bonus = 10.0  # never patrolled = max bonus

            priority = sensitivity + time_bonus

            queue.append({
                "camera_id": camera_id,
                "camera_name": camera_name,
                "zone_name": zone_name,
                "zone_type": zone_type,
                "priority": round(priority, 1),
            })

        # Sort by priority descending
        queue.sort(key=lambda x: x["priority"], reverse=True)

        # Cache the queue
        await self.remember("patrol_queue", queue, ttl=600)

        return queue

    # ── Helpers ───────────────────────────────────────────────────────

    @staticmethod
    def _format_time_ago(patrol_data: dict | None) -> str:
        """Format the time since last patrol as a human-readable string."""
        if not patrol_data or not isinstance(patrol_data, dict):
            return "never (first patrol)"
        ts = patrol_data.get("timestamp", 0)
        if ts == 0:
            return "never (first patrol)"
        minutes_ago = (time.time() - ts) / 60.0
        if minutes_ago < 1:
            return "less than 1 minute ago"
        if minutes_ago < 60:
            return f"{int(minutes_ago)} minutes ago"
        hours_ago = minutes_ago / 60.0
        return f"{hours_ago:.1f} hours ago"

    @staticmethod
    def _parse_patrol_assessment(response_text: str) -> dict:
        """Extract structured patrol assessment from Gemini response."""
        try:
            start = response_text.index("{")
            end = response_text.rindex("}") + 1
            parsed = json.loads(response_text[start:end])
            return {
                "patrol_summary": parsed.get("patrol_summary", ""),
                "findings": parsed.get("findings", []),
                "all_clear": bool(parsed.get("all_clear", True)),
                "overall_severity": parsed.get("overall_severity", "info"),
                "deviations_from_baseline": parsed.get(
                    "deviations_from_baseline", []
                ),
                "recommended_actions": parsed.get("recommended_actions", []),
            }
        except (ValueError, json.JSONDecodeError, TypeError):
            logger.debug("Could not parse JSON from patrol analysis response")
            return {
                "patrol_summary": response_text[:300] if response_text else "",
                "findings": [],
                "all_clear": True,
                "overall_severity": "info",
                "deviations_from_baseline": [],
                "recommended_actions": [],
            }
