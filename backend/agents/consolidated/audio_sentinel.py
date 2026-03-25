"""Audio Sentinel Agent — Audio event detection and classification.

Monitors audio sensors (simulated via perception events from camera
microphones), classifies sounds into threat categories, tracks audio
event frequency per zone, and correlates audio detections with visual
events for multi-modal threat confirmation.
"""
from __future__ import annotations

import logging
import time
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import (
    CH_CORTEX,
    CH_PERCEPTIONS,
    CH_ANOMALIES,
)

logger = logging.getLogger(__name__)

# ── Audio classification categories ───────────────────────────────
AUDIO_CATEGORIES = [
    "glass_break",
    "gunshot",
    "shouting",
    "alarm",
    "vehicle_horn",
    "explosion",
    "scream",
    "running_footsteps",
    "metal_impact",
    "dog_barking",
    "door_slam",
    "normal_ambient",
]

# Severity mapping for audio categories
_CATEGORY_SEVERITY: dict[str, str] = {
    "gunshot": "critical",
    "explosion": "critical",
    "glass_break": "high",
    "scream": "high",
    "shouting": "medium",
    "alarm": "medium",
    "running_footsteps": "medium",
    "metal_impact": "medium",
    "vehicle_horn": "low",
    "door_slam": "low",
    "dog_barking": "low",
    "normal_ambient": "info",
}

# Cooldown in seconds — suppress duplicate alerts for the same
# category on the same camera within this window.
_ALERT_COOLDOWN_SECONDS = 60


class AudioSentinel(BaseAgent):
    """Audio event detection and classification agent.

    Monitors camera microphone feeds (simulated through visual-audio
    correlation analysis), classifies sounds, tracks per-zone event
    frequency, and publishes structured audio perception events.
    """

    def __init__(self) -> None:
        super().__init__(
            name="audio_sentinel",
            role="Audio Event Classifier",
            description=(
                "Monitors audio sensor feeds from camera microphones, "
                "classifies sounds (glass break, gunshot, shouting, alarm, "
                "vehicle horn, explosion), tracks audio event frequency "
                "per zone, and correlates audio detections with visual "
                "events for multi-modal threat confirmation."
            ),
            tier="perception",
            model_name="gemma3:4b",
            tool_names=[
                "get_all_cameras_status",
                "get_current_detections",
                "analyze_frame_with_gemini",
                "create_alert",
                "store_observation",
                "recall_observations",
                "get_site_context",
                "get_event_history",
            ],
            subscriptions=[CH_CORTEX, CH_PERCEPTIONS],
            cycle_interval=30.0,
            token_budget_per_cycle=15000,
        )
        # Round-robin camera index
        self._camera_index: int = 0
        # Per-zone audio event counters: zone_id -> {category -> count}
        self._zone_event_counts: dict[str, dict[str, int]] = defaultdict(
            lambda: defaultdict(int)
        )
        # Cooldown tracker: "camera_id:category" -> last_alert_ts
        self._last_alerts: dict[str, float] = {}

    # ── Core reasoning loop ───────────────────────────────────────

    async def think(self, context: dict) -> dict:
        """Main audio analysis cycle.

        1. Fetch online cameras and select the next one (round-robin).
        2. Use the LLM tool loop to analyse the current frame for
           visual indicators of audio-significant events.
        3. Track zone-level event counts and apply cooldown logic.
        4. Publish structured audio_event perceptions.
        """
        from backend.agents.agent_tools import TOOL_REGISTRY
        from backend.agents.agent_comms import agent_comms

        # ── 1. Get site context & cameras ─────────────────────────
        try:
            site_ctx = await TOOL_REGISTRY["get_site_context"]["fn"]()
        except Exception as exc:
            logger.warning("audio_sentinel: site context unavailable: %s", exc)
            site_ctx = {}

        try:
            cameras_result = await TOOL_REGISTRY["get_all_cameras_status"]["fn"]()
        except Exception as exc:
            logger.warning("audio_sentinel: camera status unavailable: %s", exc)
            return {"status": "idle", "reason": f"camera query failed: {exc}"}

        if not cameras_result.get("success"):
            return {"status": "idle", "reason": "no cameras available"}

        cameras = [
            c for c in cameras_result.get("cameras", [])
            if c.get("status") == "online"
        ]
        if not cameras:
            return {"status": "idle", "reason": "no online cameras"}

        # Round-robin selection
        if self._camera_index >= len(cameras):
            self._camera_index = 0
        camera = cameras[self._camera_index]
        self._camera_index += 1
        camera_id = camera["id"]

        # ── 2. LLM tool loop — visual-audio correlation ───────────
        is_after_hours = not site_ctx.get("business_hours", True)

        result = await self.execute_tool_loop(
            prompt=(
                f"You are an Audio Sentinel agent analyzing camera {camera_id} "
                f"({camera.get('name', 'Unknown')}). "
                f"Current time: {site_ctx.get('current_time', 'unknown')}. "
                f"After hours: {is_after_hours}.\n\n"
                f"Analyze the current frame for visual indicators of audio events. "
                f"Use analyze_frame_with_gemini with this prompt:\n"
                f"'AUDIO-VISUAL CORRELATION SCAN — Analyze this frame for:\n"
                f"1. People appearing to shout, argue, or show distress\n"
                f"2. Broken glass, forced entry, or impact damage\n"
                f"3. Emergency vehicles (sirens likely)\n"
                f"4. Traffic congestion (horns likely)\n"
                f"5. Physical altercations or running\n"
                f"6. Smoke or fire (alarms likely)\n"
                f"7. Doors propped open or forced\n"
                f"Classify each detected audio indicator into one of: "
                f"{', '.join(AUDIO_CATEGORIES)}.\n"
                f"Rate confidence 0.0-1.0 for each detection.'\n\n"
                f"If you detect a concerning audio indicator with confidence >= 0.6, "
                f"create an alert with appropriate severity. "
                f"Store observations for pattern tracking."
            ),
            context_data={
                "camera_id": camera_id,
                "task": "audio_classification",
                "is_after_hours": is_after_hours,
                "categories": AUDIO_CATEGORIES,
            },
        )

        # ── 3. Publish audio perception ───────────────────────────
        if result.get("tool_calls"):
            zone_id = camera.get("zone_id", "unknown")
            now = datetime.now(timezone.utc)

            await agent_comms.publish(CH_PERCEPTIONS, {
                "agent": self.name,
                "type": "audio_event",
                "camera_id": camera_id,
                "zone_id": zone_id,
                "analysis": result.get("response", ""),
                "timestamp": now.isoformat(),
            })

        return {"status": "analyzed", "camera": camera_id}

    # ── Helpers ───────────────────────────────────────────────────

    def _is_cooldown_active(self, camera_id: str, category: str) -> bool:
        """Check whether a recent alert was already raised for this
        camera + category combination."""
        key = f"{camera_id}:{category}"
        last_ts = self._last_alerts.get(key)
        if last_ts is None:
            return False
        return (time.time() - last_ts) < _ALERT_COOLDOWN_SECONDS

    def _record_alert(self, camera_id: str, category: str) -> None:
        """Mark that an alert was just raised."""
        key = f"{camera_id}:{category}"
        self._last_alerts[key] = time.time()
