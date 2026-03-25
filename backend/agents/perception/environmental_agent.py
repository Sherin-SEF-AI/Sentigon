"""Environmental Safety Agent.

Detects smoke, fire, flooding, electrical arcing, and other environmental
hazards directly from camera frames using Gemini vision. Provides faster
detection than traditional sensors by catching hazards at visual onset.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import CH_PERCEPTIONS, CH_CORTEX, CH_THREATS

logger = logging.getLogger(__name__)

HAZARD_TYPES = [
    "smoke",
    "fire_flame",
    "electrical_sparking",
    "water_flooding",
    "gas_fog",
    "structural_damage",
    "chemical_spill",
    "unusual_lighting",
    "temperature_anomaly",
]


class EnvironmentalSafetyAgent(BaseAgent):
    """Environmental hazard detection agent using Gemini vision."""

    def __init__(self) -> None:
        super().__init__(
            name="environmental_agent",
            role="Environmental Safety Monitor",
            description=(
                "Continuously monitors camera feeds for environmental hazards "
                "including smoke, fire, flooding, electrical arcing, gas leaks, "
                "and structural damage. Provides visual detection faster than "
                "traditional sensors by catching hazards at onset."
            ),
            tier="perception",
            model_name="gemma3:27b-cloud",
            tool_names=[
                "capture_frame",
                "get_all_cameras_status",
                "analyze_frame_with_gemini",
                "analyze_frame_sequence_deep",
                "create_alert",
                "store_observation",
                "recall_observations",
                "get_site_context",
                "send_notification",
            ],
            subscriptions=[CH_CORTEX],
            cycle_interval=3.0,
            token_budget_per_cycle=15000,
        )
        self._camera_index = 0
        self._hazard_history: dict[str, list] = {}

    async def think(self, context: dict) -> dict:
        """Main environmental scanning cycle."""
        from backend.agents.agent_tools import TOOL_REGISTRY
        from backend.agents.agent_comms import agent_comms

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

        # Environmental hazard analysis via Gemini
        result = await self.execute_tool_loop(
            prompt=(
                f"You are an Environmental Safety agent monitoring camera {camera_id} "
                f"({camera.get('name', 'Unknown')}). "
                f"\n\nCRITICAL TASK: Analyze the current frame for environmental hazards. "
                f"Use analyze_frame_with_gemini with this prompt: "
                f"'ENVIRONMENTAL HAZARD SCAN - Carefully analyze this frame for: "
                f"1. SMOKE: Any haze, wisps, or cloud-like formations (even subtle) "
                f"2. FIRE: Any visible flames, glowing embers, or fire-like reflections "
                f"3. ELECTRICAL: Sparking, arcing, exposed wiring, overheating equipment "
                f"4. WATER/FLOODING: Water on floors, leaking pipes, wet surfaces "
                f"5. GAS/FOG: Unusual atmospheric conditions, visible gas/vapor "
                f"6. STRUCTURAL: Cracks, collapse signs, damaged infrastructure "
                f"7. CHEMICAL: Unusual spills, discoloration on surfaces "
                f"8. LIGHTING: Flickering lights, unusual shadows suggesting electrical issues "
                f"\nFor each hazard detected, rate: type, severity (1-10), confidence (0-1), "
                f"location in frame, and recommended action. "
                f"If NO hazards detected, confirm all-clear status.' "
                f"\n\nIf severity >= 7, immediately create a CRITICAL alert. "
                f"If severity 4-6, create a HIGH alert. "
                f"Always store observations for baseline comparison."
            ),
            context_data={
                "camera_id": camera_id,
                "task": "environmental_safety",
                "hazard_types": HAZARD_TYPES,
            },
        )

        # Publish environmental scan results
        if result.get("response"):
            await agent_comms.publish(CH_PERCEPTIONS, {
                "agent": self.name,
                "type": "environmental_scan",
                "camera_id": camera_id,
                "analysis": result.get("response", ""),
                "tool_calls": len(result.get("tool_calls", [])),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

        return {"action": "scanned", "camera": camera_id}
