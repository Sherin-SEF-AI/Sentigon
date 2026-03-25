"""Tamper Detection Agent — periodic camera tamper and scene change detection.

Wraps the tamper_detection module (SSIM + Gemini Flash classification)
in an autonomous agent that round-robins through all active cameras,
comparing live frames against stored baselines.  High-confidence tamper
events are published to CH_ANOMALIES for reasoning-tier consumption.
"""
from __future__ import annotations

import base64
import logging
from datetime import datetime, timezone

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import CH_ANOMALIES, CH_CORTEX

logger = logging.getLogger(__name__)

# How many cameras to check per cycle (avoid overloading a single cycle)
_MAX_CAMERAS_PER_CYCLE = 4


class TamperDetectionAgent(BaseAgent):
    """Autonomous camera tamper / scene-change detection agent.

    On each cycle the agent:
    1. Gets all active cameras from the capture manager.
    2. Round-robins through cameras (up to ``_MAX_CAMERAS_PER_CYCLE``).
    3. Captures the current frame and calls ``tamper_detection.check_tamper``.
    4. If tamper is confirmed, publishes to ``CH_ANOMALIES``.
    5. Auto-captures a baseline on first run if none exists.
    """

    def __init__(self) -> None:
        super().__init__(
            name="tamper_detector",
            role="Camera Tamper & Scene Change Detector",
            description=(
                "Periodically compares live camera frames against stored "
                "baselines using SSIM and Gemini Flash classification. "
                "Detects camera tampering (covered, spray-painted, redirected) "
                "and scene modifications (objects added/removed). Publishes "
                "confirmed tamper events to the anomalies channel."
            ),
            tier="perception",
            model_name="gemma3:27b-cloud",
            tool_names=[
                "capture_frame",
                "store_observation",
                "get_all_cameras_status",
            ],
            subscriptions=[CH_CORTEX],
            cycle_interval=30.0,
            token_budget_per_cycle=10000,
        )
        # Track which camera index to check next (round-robin)
        self._camera_index = 0

    # ── Core reasoning ────────────────────────────────────────────

    async def think(self, context: dict) -> dict:
        """Main tamper detection loop.

        1. Handle any Cortex directives (force-check, capture-baseline).
        2. Round-robin through active cameras.
        3. For each camera, capture frame and run tamper check.
        4. Publish tamper events to CH_ANOMALIES.
        """
        inbox = context.get("inbox_messages", [])
        results: list[dict] = []

        # Handle Cortex directives first
        for msg in inbox:
            msg_type = msg.get("type", "")
            if msg_type == "force_tamper_check":
                camera_id = msg.get("camera_id")
                if camera_id:
                    result = await self._check_single_camera(camera_id)
                    results.append(result)
            elif msg_type == "capture_baseline":
                camera_id = msg.get("camera_id")
                if camera_id:
                    result = await self._auto_capture_baseline(camera_id)
                    results.append(result)

        # Get all active cameras
        camera_ids = self._get_active_camera_ids()
        if not camera_ids:
            return {"status": "idle", "reason": "no_active_cameras"}

        # Round-robin: pick next batch of cameras
        start = self._camera_index % len(camera_ids)
        batch = []
        for i in range(_MAX_CAMERAS_PER_CYCLE):
            idx = (start + i) % len(camera_ids)
            batch.append(camera_ids[idx])
            if len(batch) >= len(camera_ids):
                break
        self._camera_index = (start + len(batch)) % max(len(camera_ids), 1)

        # Check each camera in the batch
        for camera_id in batch:
            try:
                result = await self._check_single_camera(camera_id)
                results.append(result)
            except Exception as exc:
                logger.error("Tamper check failed for camera %s: %s", camera_id, exc)
                await self.log_action("error", {
                    "error": f"Tamper check failed: {exc}",
                    "camera_id": camera_id,
                })

        tamper_count = sum(1 for r in results if r.get("tamper_detected"))
        return {
            "status": "processed",
            "cameras_checked": len(results),
            "tamper_detected": tamper_count,
            "results": results,
        }

    # ── Single camera check ───────────────────────────────────────

    async def _check_single_camera(self, camera_id: str) -> dict:
        """Run tamper check on a single camera."""
        from backend.modules.tamper_detection import tamper_detection
        from backend.services.video_capture import capture_manager

        # Get current frame
        stream = capture_manager.get_stream(camera_id)
        if stream is None or not stream.is_running:
            return {
                "camera_id": camera_id,
                "tamper_detected": False,
                "skipped": True,
                "reason": "camera_not_available",
            }

        frame_bytes = stream.encode_jpeg()
        if frame_bytes is None:
            return {
                "camera_id": camera_id,
                "tamper_detected": False,
                "skipped": True,
                "reason": "no_frame",
            }

        # Check if baseline exists; auto-capture if not
        baseline_path, _ = await tamper_detection._load_baseline(camera_id)
        if not baseline_path:
            logger.info(
                "Tamper Agent: no baseline for camera %s, auto-capturing",
                camera_id,
            )
            await tamper_detection.capture_baseline(camera_id, frame_bytes)
            await self.log_action("baseline_auto_captured", {
                "camera_id": camera_id,
                "decision": f"Auto-captured baseline for camera {camera_id}",
            })
            return {
                "camera_id": camera_id,
                "tamper_detected": False,
                "baseline_captured": True,
            }

        # Run tamper check (SSIM + Gemini classification)
        result = await tamper_detection.check_tamper(camera_id, frame_bytes)

        # Cache result in short-term memory
        await self.remember(
            f"tamper_check_{camera_id}",
            {
                "ssim": result.get("ssim"),
                "tamper_detected": result.get("tamper_detected"),
                "tamper_type": result.get("tamper_type"),
                "severity": result.get("severity"),
                "checked_at": datetime.now(timezone.utc).isoformat(),
            },
            ttl=60,
        )

        # Publish to CH_ANOMALIES if tamper detected
        if result.get("tamper_detected") and result.get("tamper_type") in (
            "camera_tamper", "scene_modification",
        ):
            await self.send_message(CH_ANOMALIES, {
                "type": "tamper_detected",
                "camera_id": camera_id,
                "tamper_type": result.get("tamper_type"),
                "ssim": result.get("ssim"),
                "confidence": result.get("confidence"),
                "severity": result.get("severity"),
                "description": result.get("description"),
                "alert_id": result.get("alert_id"),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

            # Store in long-term memory
            await self.learn(
                knowledge=(
                    f"Tamper detected on camera {camera_id}: "
                    f"type={result.get('tamper_type')}, "
                    f"ssim={result.get('ssim')}, "
                    f"severity={result.get('severity')}"
                ),
                category="tamper",
                camera_id=camera_id,
            )

            await self.log_action("tamper_detected", {
                "camera_id": camera_id,
                "tamper_type": result.get("tamper_type"),
                "ssim": result.get("ssim"),
                "severity": result.get("severity"),
                "confidence": result.get("confidence"),
                "decision": (
                    f"Tamper detected on camera {camera_id}: "
                    f"{result.get('tamper_type')} (SSIM={result.get('ssim')})"
                ),
            })

        return result

    # ── Baseline auto-capture ─────────────────────────────────────

    async def _auto_capture_baseline(self, camera_id: str) -> dict:
        """Capture a baseline frame for a camera."""
        from backend.modules.tamper_detection import tamper_detection
        from backend.services.video_capture import capture_manager

        stream = capture_manager.get_stream(camera_id)
        if stream is None or not stream.is_running:
            return {"camera_id": camera_id, "success": False, "reason": "camera_not_available"}

        frame_bytes = stream.encode_jpeg()
        if frame_bytes is None:
            return {"camera_id": camera_id, "success": False, "reason": "no_frame"}

        path = await tamper_detection.capture_baseline(camera_id, frame_bytes)
        return {
            "camera_id": camera_id,
            "success": bool(path),
            "baseline_path": path,
        }

    # ── Helpers ────────────────────────────────────────────────────

    @staticmethod
    def _get_active_camera_ids() -> list[str]:
        """Get IDs of all cameras currently streaming."""
        from backend.services.video_capture import capture_manager

        streams = capture_manager.list_streams()
        return [
            cam_id for cam_id, stream in streams.items()
            if stream.is_running
        ]
