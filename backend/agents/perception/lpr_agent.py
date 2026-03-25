"""License Plate Recognition (LPR/ANPR) Agent.

Uses Gemini vision to read license plates from camera frames.
Maintains a vehicle watchlist, logs every plate with timestamp/camera,
alerts on watchlisted plates, and tracks vehicle dwell time.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from datetime import datetime, timezone

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import CH_PERCEPTIONS, CH_CORTEX, CH_THREATS

logger = logging.getLogger(__name__)


class LPRAgent(BaseAgent):
    """License Plate Recognition agent using Gemini vision."""

    def __init__(self) -> None:
        super().__init__(
            name="lpr_agent",
            role="License Plate Recognition Specialist",
            description=(
                "Continuously scans camera feeds for vehicles, reads license "
                "plates using Gemini vision, maintains a vehicle watchlist, "
                "tracks vehicle dwell time, and alerts on flagged plates."
            ),
            tier="perception",
            model_name="gemma3:27b-cloud",
            tool_names=[
                "capture_frame",
                "get_all_cameras_status",
                "analyze_frame_with_gemini",
                "create_alert",
                "store_observation",
                "recall_observations",
                "get_site_context",
            ],
            subscriptions=[CH_CORTEX],
            cycle_interval=4.0,
            token_budget_per_cycle=15000,
        )
        self._camera_index = 0

    async def think(self, context: dict) -> dict:
        """Main LPR cycle: scan cameras for vehicles and read plates."""
        from backend.agents.agent_tools import TOOL_REGISTRY
        from backend.agents.agent_comms import agent_comms

        # Get cameras
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

        # Analyze frame for license plates using Gemini
        result = await self.execute_tool_loop(
            prompt=(
                f"You are a License Plate Recognition specialist agent. "
                f"Analyze the latest frame from camera {camera_id}. "
                f"Use analyze_frame_with_gemini with this prompt: "
                f"'Identify ALL vehicles in the frame. For each vehicle, report: "
                f"1. Vehicle type (car, truck, SUV, van, motorcycle, bus) "
                f"2. Color "
                f"3. License plate number (if readable) "
                f"4. Position in frame (left, center, right) "
                f"5. Direction of travel if apparent "
                f"6. Any distinguishing features "
                f"If no vehicles are present, state that clearly.' "
                f"After analysis, store any plate observations for tracking."
            ),
            context_data={
                "camera_id": camera_id,
                "camera_name": camera.get("name", "Unknown"),
                "task": "license_plate_recognition",
            },
        )

        # Publish vehicle detections to perceptions channel
        if result.get("tool_calls"):
            await agent_comms.publish(CH_PERCEPTIONS, {
                "agent": self.name,
                "type": "vehicle_detection",
                "camera_id": camera_id,
                "camera_name": camera.get("name", "Unknown"),
                "analysis": result.get("response", ""),
                "tool_calls": len(result.get("tool_calls", [])),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

        return {"action": "scanned", "camera": camera_id, "result": result.get("response", "")}
