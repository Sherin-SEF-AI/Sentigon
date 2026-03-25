"""Privacy-Preserving Re-Identification Agent.

Tracks individuals across cameras WITHOUT facial recognition. Uses Gemini
to extract non-biometric descriptors — clothing color, body build, gait
pattern, carried objects, hair style — and creates appearance embeddings
in Qdrant for cross-camera search. GDPR/privacy-compliant.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import (
    CH_PERCEPTIONS, CH_CORTEX, CH_CORRELATION, CH_INVESTIGATION,
)

logger = logging.getLogger(__name__)


class ReIDAgent(BaseAgent):
    """Privacy-preserving person re-identification agent."""

    def __init__(self) -> None:
        super().__init__(
            name="reid_agent",
            role="Privacy-Preserving Re-Identification Specialist",
            description=(
                "Tracks individuals across cameras without facial recognition. "
                "Extracts non-biometric descriptors (clothing, build, gait, objects) "
                "using Gemini vision and creates searchable appearance profiles "
                "in Qdrant. Enables cross-camera tracking while maintaining "
                "GDPR/privacy compliance."
            ),
            tier="reasoning",
            model_name="deepseek-v3.1:671b-cloud",
            tool_names=[
                "capture_frame",
                "get_all_cameras_status",
                "get_current_detections",
                "analyze_frame_with_gemini",
                "analyze_frame_sequence_deep",
                "semantic_search_video",
                "search_entity_appearances",
                "store_observation",
                "recall_observations",
                "create_alert",
                "get_site_context",
            ],
            subscriptions=[CH_CORTEX, CH_PERCEPTIONS],
            cycle_interval=5.0,
            token_budget_per_cycle=25000,
        )
        self._camera_index = 0

    async def think(self, context: dict) -> dict:
        """Main re-identification cycle: extract and match appearances."""
        from backend.agents.agent_tools import TOOL_REGISTRY
        from backend.agents.agent_comms import agent_comms

        # Check for person detections from perception agents
        inbox_messages = []
        while not self._inbox.empty():
            try:
                msg = self._inbox.get_nowait()
                if msg.get("type") in ("perception_event", "person_detected"):
                    inbox_messages.append(msg)
            except asyncio.QueueEmpty:
                break

        cameras_result = await TOOL_REGISTRY["get_all_cameras_status"]["fn"]()
        if not cameras_result.get("success"):
            return {"action": "idle", "reason": "no cameras available"}

        cameras = [c for c in cameras_result.get("cameras", []) if c.get("status") == "online"]
        if not cameras:
            return {"action": "idle", "reason": "no online cameras"}

        # Round-robin camera selection
        if self._camera_index >= len(cameras):
            self._camera_index = 0
        camera = cameras[self._camera_index]
        self._camera_index += 1
        camera_id = camera["id"]

        # Extract appearance descriptors using Gemini
        result = await self.execute_tool_loop(
            prompt=(
                f"You are a Privacy-Preserving Re-Identification specialist. "
                f"Analyze camera {camera_id} ({camera.get('name', 'Unknown')}) for person tracking. "
                f"\n\nIMPORTANT: Do NOT use facial recognition. Extract ONLY non-biometric descriptors. "
                f"\n\nUse analyze_frame_with_gemini with this prompt: "
                f"'PERSON APPEARANCE PROFILING (Privacy-Preserving - NO facial features): "
                f"For each person visible in the frame, create an appearance profile: "
                f"1. CLOTHING: Upper body (color, type - jacket/shirt/hoodie), "
                f"   Lower body (color, type - jeans/pants/skirt), Footwear (color, type) "
                f"2. BUILD: Approximate height (tall/medium/short), body type "
                f"3. ACCESSORIES: Backpack, bag, hat, glasses (non-identifying), umbrella "
                f"4. CARRIED OBJECTS: Phone, briefcase, shopping bags, equipment "
                f"5. HAIR: Color and general style (NOT facial features) "
                f"6. GAIT/POSTURE: Walking speed, direction, distinctive movement patterns "
                f"7. POSITION: Location in frame, entry/exit direction "
                f"\nCreate a searchable text descriptor for each person, e.g.: "
                f"\"Person in black hoodie, blue jeans, white sneakers, carrying red backpack, "
                f"medium height, walking north-east\" "
                f"\nIf previously seen descriptors match someone from another camera, note the match.' "
                f"\n\nAfter analysis, use search_entity_appearances to check for matches "
                f"with recently seen individuals. Store new appearance observations."
            ),
            context_data={
                "camera_id": camera_id,
                "task": "person_reidentification",
                "privacy_mode": True,
            },
        )

        # Publish re-id findings
        if result.get("response"):
            await agent_comms.publish(CH_CORRELATION, {
                "agent": self.name,
                "type": "appearance_profile",
                "camera_id": camera_id,
                "profiles": result.get("response", ""),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

        return {"action": "profiled", "camera": camera_id}
