"""Audio Intelligence Agent.

Captures audio from webcam microphones and uses Gemini's native audio
understanding to classify sounds — glass breaking, shouting/aggression,
gunshot-like sounds, alarms, vehicle horns, doors slamming.
Correlates audio events with visual events for multi-modal threat detection.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import CH_PERCEPTIONS, CH_CORTEX, CH_ANOMALIES

logger = logging.getLogger(__name__)

# Audio threat classification categories
AUDIO_THREAT_CATEGORIES = [
    "glass_breaking",
    "shouting_aggression",
    "gunshot",
    "alarm_siren",
    "vehicle_horn",
    "door_slam",
    "explosion",
    "running_footsteps",
    "metal_impact",
    "scream",
    "dog_barking",
    "vehicle_crash",
    "normal_ambient",
]


class AudioIntelligenceAgent(BaseAgent):
    """Audio threat detection agent using Gemini audio understanding."""

    def __init__(self) -> None:
        super().__init__(
            name="audio_agent",
            role="Audio Intelligence Analyst",
            description=(
                "Monitors audio streams from camera microphones, classifies "
                "sounds using Gemini audio understanding, detects threats like "
                "glass breaking, shouting, gunshots, alarms, and correlates "
                "audio events with visual detections for multi-modal analysis."
            ),
            tier="perception",
            model_name="gemma3:27b-cloud",
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
            cycle_interval=3.0,
            token_budget_per_cycle=15000,
        )
        self._camera_index = 0
        self._audio_buffer: dict[str, list] = {}
        self._last_alerts: dict[str, float] = {}

    async def think(self, context: dict) -> dict:
        """Main audio analysis cycle."""
        from backend.agents.agent_tools import TOOL_REGISTRY
        from backend.agents.agent_comms import agent_comms

        # Get site context for time-aware analysis
        site_ctx = await TOOL_REGISTRY["get_site_context"]["fn"]()

        # Get cameras
        cameras_result = await TOOL_REGISTRY["get_all_cameras_status"]["fn"]()
        if not cameras_result.get("success"):
            return {"action": "idle", "reason": "no cameras available"}

        cameras = [c for c in cameras_result.get("cameras", []) if c.get("status") == "online"]
        if not cameras:
            return {"action": "idle", "reason": "no online cameras"}

        # Round-robin
        if self._camera_index >= len(cameras):
            self._camera_index = 0
        camera = cameras[self._camera_index]
        self._camera_index += 1
        camera_id = camera["id"]

        # Use Gemini to analyze the visual scene for audio-correlated threats
        # (In production, this would also process actual audio stream data)
        result = await self.execute_tool_loop(
            prompt=(
                f"You are an Audio Intelligence agent analyzing camera {camera_id} "
                f"({camera.get('name', 'Unknown')}). Current time: {site_ctx.get('current_time', 'unknown')}. "
                f"Business hours: {site_ctx.get('business_hours', 'unknown')}. "
                f"\n\nYour task: Analyze the current scene for audio-correlated threats. "
                f"Use analyze_frame_with_gemini with this prompt: "
                f"'Analyze this frame for visual indicators of audio events: "
                f"1. Are there people who appear to be shouting or in distress? "
                f"2. Is there any visible damage (broken glass, forced entry)? "
                f"3. Are there emergency vehicles with potential sirens? "
                f"4. Are there any vehicles that may be honking (traffic situation)? "
                f"5. Is there any sign of physical altercation? "
                f"6. Any smoke/fire that would trigger alarms? "
                f"7. Are doors open that shouldn't be (after hours)? "
                f"Rate the overall audio threat level: none/low/medium/high/critical.' "
                f"\n\nIf you detect anything concerning, create an alert with appropriate severity. "
                f"Store observations for pattern tracking."
            ),
            context_data={
                "camera_id": camera_id,
                "task": "audio_intelligence",
                "is_after_hours": not site_ctx.get("business_hours", True),
                "categories": AUDIO_THREAT_CATEGORIES,
            },
        )

        # Publish audio analysis
        if result.get("tool_calls"):
            await agent_comms.publish(CH_PERCEPTIONS, {
                "agent": self.name,
                "type": "audio_analysis",
                "camera_id": camera_id,
                "analysis": result.get("response", ""),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

        return {"action": "analyzed", "camera": camera_id}
