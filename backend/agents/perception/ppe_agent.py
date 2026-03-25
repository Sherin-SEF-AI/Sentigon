"""PPE Compliance Agent — periodic safety equipment monitoring.

Wraps the ppe_compliance module (Gemini Flash vision analysis) in an
autonomous agent that checks cameras in industrial/construction/warehouse
zones for personal protective equipment violations.  Non-compliant
detections are stored and published to CH_PERCEPTIONS.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from backend.agents.base_agent import BaseAgent
from backend.agents.agent_comms import CH_PERCEPTIONS, CH_CORTEX

logger = logging.getLogger(__name__)

# Default PPE list when zone has no explicit config
_DEFAULT_REQUIRED_PPE = ["hard_hat", "hi_vis_vest"]

# Zone types that warrant PPE checks
_PPE_ZONE_TYPES = {"industrial", "construction", "warehouse", "manufacturing"}

# Max zones to check per cycle
_MAX_ZONES_PER_CYCLE = 3


class PPEComplianceAgent(BaseAgent):
    """Autonomous PPE compliance monitoring agent.

    On each cycle the agent:
    1. Gets all zones with zone_type in industrial/construction/warehouse.
    2. For each zone, finds assigned cameras.
    3. Captures a frame and runs PPE compliance check.
    4. Stores compliance events and publishes summary to CH_PERCEPTIONS.
    5. Skips zones with no detected persons (checks YOLO first).
    """

    def __init__(self) -> None:
        super().__init__(
            name="ppe_compliance",
            role="PPE & Safety Compliance Monitor",
            description=(
                "Monitors industrial and construction zones for personal "
                "protective equipment compliance. Uses Gemini Flash vision "
                "to detect hard hats, hi-vis vests, safety glasses, and "
                "other required PPE. Records violations and raises alerts "
                "for non-compliant personnel."
            ),
            tier="perception",
            model_name="gemma3:27b-cloud",
            tool_names=[
                "capture_frame",
                "get_current_detections",
                "get_all_zones_status",
                "store_observation",
            ],
            subscriptions=[CH_CORTEX],
            cycle_interval=15.0,
            token_budget_per_cycle=15000,
        )
        self._zone_index = 0

    # ── Core reasoning ────────────────────────────────────────────

    async def think(self, context: dict) -> dict:
        """Main PPE compliance loop.

        1. Handle Cortex directives (force-check).
        2. Get industrial/construction zones.
        3. For each zone, capture frame and run compliance check.
        4. Store events and publish summary.
        """
        inbox = context.get("inbox_messages", [])
        results: list[dict] = []

        # Handle Cortex directives
        for msg in inbox:
            if msg.get("type") == "force_ppe_check":
                zone_id = msg.get("zone_id")
                camera_id = msg.get("camera_id")
                if zone_id and camera_id:
                    result = await self._check_camera(
                        camera_id, zone_id,
                        msg.get("required_ppe", _DEFAULT_REQUIRED_PPE),
                    )
                    results.append(result)

        # Get PPE-relevant zones
        ppe_zones = await self._get_ppe_zones()
        if not ppe_zones:
            return {"status": "idle", "reason": "no_ppe_zones"}

        # Round-robin through zones
        start = self._zone_index % len(ppe_zones)
        batch = []
        for i in range(_MAX_ZONES_PER_CYCLE):
            idx = (start + i) % len(ppe_zones)
            batch.append(ppe_zones[idx])
            if len(batch) >= len(ppe_zones):
                break
        self._zone_index = (start + len(batch)) % max(len(ppe_zones), 1)

        # Check each zone
        for zone in batch:
            try:
                zone_results = await self._check_zone(zone)
                results.extend(zone_results)
            except Exception as exc:
                logger.error(
                    "PPE check failed for zone %s: %s",
                    zone.get("id"), exc,
                )

        violations = sum(
            r.get("violation_count", 0) for r in results
        )
        return {
            "status": "processed",
            "zones_checked": len(batch),
            "cameras_checked": len(results),
            "total_violations": violations,
        }

    # ── Zone check ────────────────────────────────────────────────

    async def _check_zone(self, zone: dict) -> list[dict]:
        """Check all cameras in a zone for PPE compliance."""
        zone_id = zone.get("id")
        camera_ids = zone.get("camera_ids", [])
        required_ppe = zone.get("required_ppe", _DEFAULT_REQUIRED_PPE)

        if not camera_ids:
            return []

        results = []
        for camera_id in camera_ids[:2]:  # Max 2 cameras per zone per cycle
            # Quick check: skip if no persons detected by YOLO
            if not await self._has_persons(camera_id):
                continue

            result = await self._check_camera(camera_id, zone_id, required_ppe)
            results.append(result)

        return results

    # ── Single camera check ───────────────────────────────────────

    async def _check_camera(
        self,
        camera_id: str,
        zone_id: str,
        required_ppe: list,
    ) -> dict:
        """Run PPE compliance check on a single camera."""
        from backend.modules.ppe_compliance import ppe_compliance
        from backend.services.video_capture import capture_manager

        stream = capture_manager.get_stream(camera_id)
        if stream is None or not stream.is_running:
            return {
                "camera_id": camera_id,
                "zone_id": zone_id,
                "skipped": True,
                "reason": "camera_not_available",
                "violation_count": 0,
            }

        frame_bytes = stream.encode_jpeg()
        if frame_bytes is None:
            return {
                "camera_id": camera_id,
                "zone_id": zone_id,
                "skipped": True,
                "reason": "no_frame",
                "violation_count": 0,
            }

        # Run compliance check
        result = await ppe_compliance.check_compliance(
            frame_bytes=frame_bytes,
            camera_id=camera_id,
            zone_id=zone_id,
            required_ppe=required_ppe,
        )

        violation_count = result.get("violation_count", 0)
        persons = result.get("persons", [])

        # Store events
        if persons:
            await ppe_compliance.store_event(
                result=result,
                camera_id=camera_id,
                zone_id=zone_id,
                required_ppe=required_ppe,
            )

        # Publish summary to CH_PERCEPTIONS
        await self.send_message(CH_PERCEPTIONS, {
            "type": "ppe_compliance_check",
            "camera_id": camera_id,
            "zone_id": zone_id,
            "persons_checked": len(persons),
            "violation_count": violation_count,
            "overall_compliance": result.get("overall_zone_compliance", "unknown"),
            "required_ppe": required_ppe,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

        # Log action
        if violation_count > 0:
            await self.log_action("ppe_violation", {
                "camera_id": camera_id,
                "zone_id": zone_id,
                "violation_count": violation_count,
                "persons_checked": len(persons),
                "decision": (
                    f"PPE violations detected: {violation_count} in zone "
                    f"{zone_id}, camera {camera_id}"
                ),
            })

            await self.learn(
                knowledge=(
                    f"PPE violation: {violation_count} non-compliant "
                    f"person(s) in zone {zone_id}"
                ),
                category="ppe_violation",
                camera_id=camera_id,
            )

        # Cache result
        await self.remember(
            f"ppe_check_{camera_id}",
            {
                "violation_count": violation_count,
                "persons": len(persons),
                "compliance": result.get("overall_zone_compliance"),
                "checked_at": datetime.now(timezone.utc).isoformat(),
            },
            ttl=30,
        )

        return result

    # ── Helpers ────────────────────────────────────────────────────

    async def _get_ppe_zones(self) -> list[dict]:
        """Get zones that require PPE checks, with their cameras."""
        from backend.database import async_session
        from backend.models.models import Zone, Camera
        from sqlalchemy import select

        zones = []
        try:
            async with async_session() as session:
                stmt = select(Zone).where(
                    Zone.is_active == True,  # noqa: E712
                    Zone.zone_type.in_(list(_PPE_ZONE_TYPES)),
                )
                result = await session.execute(stmt)
                db_zones = result.scalars().all()

                for z in db_zones:
                    # Get cameras assigned to this zone
                    cam_stmt = select(Camera).where(
                        Camera.zone_id == z.id,
                        Camera.is_active == True,  # noqa: E712
                    )
                    cam_result = await session.execute(cam_stmt)
                    cameras = cam_result.scalars().all()

                    # Get required PPE from zone config
                    config = z.config or {}
                    required_ppe = config.get(
                        "required_ppe", _DEFAULT_REQUIRED_PPE
                    )

                    zones.append({
                        "id": str(z.id),
                        "name": z.name,
                        "zone_type": z.zone_type,
                        "camera_ids": [str(c.id) for c in cameras],
                        "required_ppe": required_ppe,
                    })

        except Exception as exc:
            logger.error("Failed to get PPE zones: %s", exc)

        return zones

    async def _has_persons(self, camera_id: str) -> bool:
        """Quick check if YOLO is currently detecting persons on this camera."""
        try:
            from backend.agents.agent_tools import TOOL_REGISTRY
            detections = await TOOL_REGISTRY["get_current_detections"]["fn"](
                camera_id=camera_id,
            )
            objects = detections.get("objects", [])
            return any(
                obj.get("class_name") == "person"
                for obj in objects
            )
        except Exception:
            # If detection check fails, proceed anyway
            return True
