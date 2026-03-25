"""Patrol Optimization -- dynamic risk-based camera patrol scheduling.

Computes per-camera risk scores based on historical alert frequency, time
since last patrol, zone sensitivity, current occupancy, and active nearby
alerts.  Generates an ordered patrol path using a weighted priority queue
so operators focus on the highest-risk cameras first.  Supports real-time
re-prioritisation when new alerts fire.
"""

from __future__ import annotations

import logging
import math
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List

from sqlalchemy import select, func

from backend.config import settings
from backend.database import async_session
from backend.models.models import Camera, Alert, Event, Zone, AlertStatus, AlertSeverity

logger = logging.getLogger(__name__)

# ── Tunable weights ──────────────────────────────────────────────

# How much each factor contributes to the final risk score (0-100).
WEIGHT_TIME_SINCE_PATROL = 0.25
WEIGHT_ALERT_FREQUENCY = 0.30
WEIGHT_ZONE_SENSITIVITY = 0.20
WEIGHT_OCCUPANCY = 0.10
WEIGHT_ACTIVE_ALERTS = 0.15

# Zone types ordered by sensitivity (higher index = higher risk).
ZONE_SENSITIVITY = {
    "restricted": 1.0,
    "entry": 0.8,
    "exit": 0.8,
    "parking": 0.6,
    "general": 0.3,
}

# Alert severity weights for frequency scoring.
SEVERITY_WEIGHT = {
    "critical": 5.0,
    "high": 3.0,
    "medium": 1.5,
    "low": 0.5,
    "info": 0.1,
}

# Time window over which historical alerts are counted (hours).
ALERT_HISTORY_HOURS = 24

# Maximum minutes since last patrol before the time factor saturates at 1.0.
MAX_PATROL_GAP_MINUTES = 120


class PatrolOptimizer:
    """Dynamic risk-based camera patrol scheduler."""

    def __init__(self) -> None:
        # In-memory tracking of last patrol time per camera.
        self._last_patrol: Dict[str, datetime] = {}
        # Cached patrol schedule (regenerated on each call to generate_patrol_path).
        self._patrol_schedule: List[dict] = []

    # ── Risk scoring ─────────────────────────────────────────────

    async def compute_risk_score(self, camera_id: str) -> float:
        """Compute a dynamic risk score (0.0 -- 100.0) for a single camera.

        Factors:
            1. Time since last patrol (longer = riskier).
            2. Historical alert frequency over the last 24 h, weighted by severity.
            3. Zone sensitivity tier.
            4. Current zone occupancy vs max occupancy.
            5. Number of active (unresolved) alerts near this camera.

        Args:
            camera_id: UUID-string of the camera.

        Returns:
            Float risk score between 0 and 100.
        """
        now = datetime.now(timezone.utc)
        camera_uuid_str = str(camera_id)

        # -- Factor 1: time since last patrol ---------------------------------
        last_patrol = self._last_patrol.get(camera_uuid_str)
        if last_patrol:
            minutes_since = (now - last_patrol).total_seconds() / 60.0
            time_factor = min(minutes_since / MAX_PATROL_GAP_MINUTES, 1.0)
        else:
            # Never patrolled -- maximum urgency
            time_factor = 1.0

        async with async_session() as session:
            try:
                import uuid as _uuid
                camera_uuid = _uuid.UUID(camera_uuid_str) if isinstance(camera_uuid_str, str) else camera_uuid_str

                # -- Load camera and zone info --------------------------------
                cam_stmt = select(Camera).where(Camera.id == camera_uuid)
                cam_result = await session.execute(cam_stmt)
                camera = cam_result.scalar_one_or_none()

                if not camera:
                    logger.warning(
                        "patrol.compute_risk camera not found: %s",
                        camera_id,
                    )
                    return 0.0

                # -- Factor 2: alert frequency (last 24 h) --------------------
                cutoff = now - timedelta(hours=ALERT_HISTORY_HOURS)
                alert_stmt = select(Alert).where(
                    Alert.source_camera == camera_uuid_str,
                    Alert.created_at > cutoff,
                )
                alert_result = await session.execute(alert_stmt)
                recent_alerts = alert_result.scalars().all()

                weighted_alert_score = 0.0
                for alert in recent_alerts:
                    sev_key = alert.severity.value if hasattr(alert.severity, "value") else str(alert.severity)
                    weighted_alert_score += SEVERITY_WEIGHT.get(sev_key, 1.0)

                # Normalise: cap at ~50 weighted alerts for factor = 1.0
                alert_factor = min(weighted_alert_score / 50.0, 1.0)

                # -- Factor 3: zone sensitivity --------------------------------
                zone_factor = 0.3  # default if no zone
                if camera.zone_id:
                    zone_stmt = select(Zone).where(Zone.id == camera.zone_id)
                    zone_result = await session.execute(zone_stmt)
                    zone = zone_result.scalar_one_or_none()
                    if zone:
                        zone_type = zone.zone_type or "general"
                        zone_factor = ZONE_SENSITIVITY.get(zone_type, 0.3)

                        # -- Factor 4: occupancy pressure -------------------------
                        occupancy_factor = 0.0
                        if zone.max_occupancy and zone.max_occupancy > 0:
                            occupancy_ratio = zone.current_occupancy / zone.max_occupancy
                            occupancy_factor = min(occupancy_ratio, 1.0)
                        else:
                            occupancy_factor = 0.0
                    else:
                        occupancy_factor = 0.0
                else:
                    occupancy_factor = 0.0

                # -- Factor 5: active (unresolved) alerts ----------------------
                active_alert_stmt = select(func.count(Alert.id)).where(
                    Alert.source_camera == camera_uuid_str,
                    Alert.status.in_([
                        AlertStatus.NEW,
                        AlertStatus.ACKNOWLEDGED,
                        AlertStatus.INVESTIGATING,
                        AlertStatus.ESCALATED,
                    ]),
                )
                active_result = await session.execute(active_alert_stmt)
                active_alert_count = active_result.scalar() or 0
                active_factor = min(active_alert_count / 10.0, 1.0)

                # -- Composite score -------------------------------------------
                raw_score = (
                    WEIGHT_TIME_SINCE_PATROL * time_factor
                    + WEIGHT_ALERT_FREQUENCY * alert_factor
                    + WEIGHT_ZONE_SENSITIVITY * zone_factor
                    + WEIGHT_OCCUPANCY * occupancy_factor
                    + WEIGHT_ACTIVE_ALERTS * active_factor
                )

                # Scale to 0-100
                risk_score = round(raw_score * 100.0, 2)

                logger.debug(
                    "patrol.risk camera=%s score=%.2f "
                    "(time=%.2f alert=%.2f zone=%.2f occ=%.2f active=%.2f)",
                    camera_id,
                    risk_score,
                    time_factor,
                    alert_factor,
                    zone_factor,
                    occupancy_factor,
                    active_factor,
                )
                return risk_score

            except Exception as exc:
                logger.error(
                    "patrol.compute_risk failed camera=%s: %s",
                    camera_id,
                    exc,
                )
                return 0.0

    # ── Patrol path generation ───────────────────────────────────

    async def generate_patrol_path(self) -> list:
        """Generate an optimal patrol order for all active cameras.

        Computes risk scores for every active camera and returns them
        sorted highest-risk first.

        Returns:
            Ordered list of dicts with camera_id, camera_name, location,
            zone_id, risk_score, and last_patrolled.
        """
        async with async_session() as session:
            try:
                stmt = select(Camera).where(Camera.is_active.is_(True))
                result = await session.execute(stmt)
                cameras = result.scalars().all()

                if not cameras:
                    logger.info("patrol.generate_patrol_path no active cameras")
                    self._patrol_schedule = []
                    return []

            except Exception as exc:
                logger.error("patrol.generate_patrol_path camera query failed: %s", exc)
                return []

        # Compute risk for each camera (outside the session to avoid nesting)
        patrol_entries: List[Dict[str, Any]] = []
        for camera in cameras:
            cam_id = str(camera.id)
            risk_score = await self.compute_risk_score(cam_id)
            last_patrolled = self._last_patrol.get(cam_id)

            patrol_entries.append({
                "camera_id": cam_id,
                "camera_name": camera.name,
                "location": camera.location,
                "zone_id": str(camera.zone_id) if camera.zone_id else None,
                "risk_score": risk_score,
                "last_patrolled": last_patrolled.isoformat() if last_patrolled else None,
            })

        # Sort by risk score descending (highest risk first)
        patrol_entries.sort(key=lambda e: e["risk_score"], reverse=True)

        # Add rank
        for idx, entry in enumerate(patrol_entries):
            entry["rank"] = idx + 1

        self._patrol_schedule = patrol_entries

        logger.info(
            "patrol.generate_patrol_path cameras=%d top_risk=%.2f",
            len(patrol_entries),
            patrol_entries[0]["risk_score"] if patrol_entries else 0.0,
        )
        return patrol_entries

    # ── Record patrol ────────────────────────────────────────────

    async def record_patrol(self, camera_id: str) -> None:
        """Record that a camera was patrolled (viewed by an operator).

        Updates the in-memory last-patrol timestamp, which reduces the
        camera's risk score on subsequent computations.

        Args:
            camera_id: UUID-string of the patrolled camera.
        """
        now = datetime.now(timezone.utc)
        camera_uuid_str = str(camera_id)

        self._last_patrol[camera_uuid_str] = now

        logger.info(
            "patrol.record camera=%s at=%s",
            camera_uuid_str,
            now.isoformat(),
        )

    # ── Alert-driven re-prioritisation ───────────────────────────

    async def handle_alert(self, camera_id: str) -> None:
        """Re-prioritise patrol on alert -- bump alert camera and neighbours.

        When an alert fires, the camera that triggered it and all cameras
        in the same zone are moved to the top of the patrol schedule.

        Args:
            camera_id: UUID-string of the camera that triggered the alert.
        """
        camera_uuid_str = str(camera_id)

        # Clear last-patrol for the alert camera so it gets max time_factor
        if camera_uuid_str in self._last_patrol:
            del self._last_patrol[camera_uuid_str]

        # Find neighbouring cameras (same zone)
        async with async_session() as session:
            try:
                import uuid as _uuid
                camera_uuid = _uuid.UUID(camera_uuid_str)

                cam_stmt = select(Camera).where(Camera.id == camera_uuid)
                cam_result = await session.execute(cam_stmt)
                camera = cam_result.scalar_one_or_none()

                if camera and camera.zone_id:
                    # Get all cameras in the same zone
                    neighbours_stmt = select(Camera).where(
                        Camera.zone_id == camera.zone_id,
                        Camera.is_active.is_(True),
                        Camera.id != camera_uuid,
                    )
                    neighbours_result = await session.execute(neighbours_stmt)
                    neighbours = neighbours_result.scalars().all()

                    for neighbour in neighbours:
                        neighbour_id = str(neighbour.id)
                        # Clear their last patrol too so they also get bumped
                        if neighbour_id in self._last_patrol:
                            del self._last_patrol[neighbour_id]

                    logger.info(
                        "patrol.handle_alert camera=%s zone=%s neighbours_bumped=%d",
                        camera_uuid_str,
                        camera.zone_id,
                        len(neighbours),
                    )
                else:
                    logger.info(
                        "patrol.handle_alert camera=%s (no zone, bumped camera only)",
                        camera_uuid_str,
                    )

            except Exception as exc:
                logger.error(
                    "patrol.handle_alert failed camera=%s: %s",
                    camera_id,
                    exc,
                )

        # Regenerate the schedule with updated priorities
        await self.generate_patrol_path()

    # ── Schedule accessor ────────────────────────────────────────

    async def get_schedule(self) -> list:
        """Get the current patrol schedule.

        If no schedule has been generated yet, generates one first.

        Returns:
            Ordered list of patrol entries (same format as generate_patrol_path).
        """
        if not self._patrol_schedule:
            return await self.generate_patrol_path()
        return self._patrol_schedule


# ── Singleton ────────────────────────────────────────────────────

patrol_optimizer = PatrolOptimizer()
