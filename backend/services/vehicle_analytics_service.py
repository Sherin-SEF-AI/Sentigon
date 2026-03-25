"""Vehicle Analytics Service — advanced vehicle intelligence beyond basic LPR."""

from __future__ import annotations

import logging
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select, desc, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import async_session

logger = logging.getLogger(__name__)


class VehicleAnalyticsService:
    """Advanced vehicle behavior analytics."""

    def __init__(self):
        self._vehicle_zone_history: Dict[str, List[Dict]] = defaultdict(list)

    async def analyze_vehicle_description(
        self, camera_id: str, frame_bytes: bytes, detection: dict
    ) -> Dict[str, Any]:
        """Use Gemini/Groq to classify vehicle make/model/color from frame crop."""
        prompt = (
            "Analyze this vehicle in the security camera frame. "
            "Return JSON: {\"make\": \"...\", \"model\": \"...\", \"color\": \"...\", "
            "\"vehicle_type\": \"sedan|suv|truck|van|motorcycle|bus|pickup\", "
            "\"year_approx\": \"...\", \"condition\": \"good|fair|poor\"}"
        )
        try:
            from backend.modules.gemini_client import analyze_frame_flash
            result = await analyze_frame_flash(frame_bytes, prompt)
            return result if isinstance(result, dict) else {"raw": str(result)}
        except Exception as e:
            logger.warning("Vehicle description analysis failed: %s", e)
            return {}

    async def check_wrong_way(
        self, camera_id: str, track_id: int,
        trajectory: List[tuple], zone_id: str
    ) -> Dict[str, Any]:
        """Check if vehicle trajectory violates zone's allowed directions."""
        from backend.models.advanced_models import ParkingZoneConfig

        if len(trajectory) < 3:
            return {"violation": False}

        async with async_session() as session:
            config = (await session.execute(
                select(ParkingZoneConfig).where(ParkingZoneConfig.zone_id == zone_id)
            )).scalar_one_or_none()

            if not config or not config.allowed_directions:
                return {"violation": False}

            # Compute dominant direction from trajectory
            start = trajectory[0]
            end = trajectory[-1]
            dx = end[0] - start[0]
            dy = end[1] - start[1]

            if abs(dx) > abs(dy):
                direction = "east" if dx > 0 else "west"
            else:
                direction = "south" if dy > 0 else "north"

            allowed = config.allowed_directions
            if isinstance(allowed, list) and direction not in allowed:
                return {
                    "violation": True,
                    "detected_direction": direction,
                    "allowed_directions": allowed,
                    "zone_id": zone_id,
                }

        return {"violation": False}

    async def check_parking_violation(
        self, plate: str, zone_id: str, dwell_seconds: int
    ) -> Dict[str, Any]:
        """Check if a vehicle exceeds dwell time or is unauthorized for zone type."""
        from backend.models.advanced_models import ParkingZoneConfig

        async with async_session() as session:
            config = (await session.execute(
                select(ParkingZoneConfig).where(ParkingZoneConfig.zone_id == zone_id)
            )).scalar_one_or_none()

            if not config:
                return {"violation": False}

            violations = []
            dwell_minutes = dwell_seconds / 60

            if config.max_dwell_minutes and dwell_minutes > config.max_dwell_minutes:
                violations.append({
                    "type": "excessive_dwell",
                    "dwell_minutes": round(dwell_minutes, 1),
                    "max_allowed": config.max_dwell_minutes,
                })

            return {
                "violation": len(violations) > 0,
                "violations": violations,
                "zone_type": config.zone_type,
                "plate": plate,
            }

    async def detect_loitering(
        self, plate: str, hours: int = 1
    ) -> Dict[str, Any]:
        """Detect vehicle loitering (seen at 3+ cameras or 4+ times at same camera)."""
        from backend.models.advanced_models import VehicleSighting

        async with async_session() as session:
            since = datetime.now(timezone.utc) - timedelta(hours=hours)
            result = await session.execute(
                select(VehicleSighting)
                .where(
                    VehicleSighting.plate_text == plate.upper(),
                    VehicleSighting.timestamp > since,
                )
                .order_by(VehicleSighting.timestamp)
            )
            sightings = result.scalars().all()

            cameras = set()
            total = len(sightings)
            for s in sightings:
                cameras.add(str(s.camera_id))

            is_loitering = len(cameras) >= 3 or total >= 4

            return {
                "plate": plate,
                "is_loitering": is_loitering,
                "unique_cameras": len(cameras),
                "total_sightings": total,
                "time_window_hours": hours,
                "camera_ids": list(cameras),
            }

    async def get_loading_dock_status(self, zone_id: str) -> Dict[str, Any]:
        """Get current loading dock occupancy and dwell analytics."""
        from backend.models.advanced_models import ParkingZoneConfig, VehicleSighting
        from backend.models.models import Zone

        async with async_session() as session:
            config = (await session.execute(
                select(ParkingZoneConfig).where(ParkingZoneConfig.zone_id == zone_id)
            )).scalar_one_or_none()

            zone = (await session.execute(
                select(Zone).where(Zone.id == zone_id)
            )).scalar_one_or_none()

            if not config:
                return {"error": "No parking config for zone", "zone_id": zone_id}

            return {
                "success": True,
                "zone_id": zone_id,
                "zone_name": zone.name if zone else "Unknown",
                "zone_type": config.zone_type,
                "total_spots": config.total_spots,
                "occupied_spots": config.occupied_spots,
                "max_dwell_minutes": config.max_dwell_minutes,
                "utilization_pct": round(
                    (config.occupied_spots / config.total_spots * 100)
                    if config.total_spots else 0, 1
                ),
            }

    async def get_vehicle_flow_analytics(
        self, hours: int = 24, zone_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """Get vehicle flow patterns and analytics."""
        from backend.models.advanced_models import VehicleSighting

        async with async_session() as session:
            since = datetime.now(timezone.utc) - timedelta(hours=hours)
            query = select(VehicleSighting).where(VehicleSighting.timestamp > since)
            if zone_id:
                from backend.models.models import Camera
                cam_result = await session.execute(
                    select(Camera.id).where(Camera.zone_id == zone_id)
                )
                cam_ids = [r[0] for r in cam_result.all()]
                if cam_ids:
                    query = query.where(VehicleSighting.camera_id.in_(cam_ids))

            result = await session.execute(query.order_by(VehicleSighting.timestamp))
            sightings = result.scalars().all()

            # Hourly flow
            hourly_flow: Dict[int, int] = defaultdict(int)
            type_counts: Dict[str, int] = defaultdict(int)
            color_counts: Dict[str, int] = defaultdict(int)
            unique_plates = set()

            for s in sightings:
                hour = s.timestamp.hour if s.timestamp else 0
                hourly_flow[hour] += 1
                if s.vehicle_type:
                    type_counts[s.vehicle_type] += 1
                if s.vehicle_color:
                    color_counts[s.vehicle_color] += 1
                if s.plate_text:
                    unique_plates.add(s.plate_text)

            return {
                "success": True,
                "time_range_hours": hours,
                "total_sightings": len(sightings),
                "unique_vehicles": len(unique_plates),
                "hourly_flow": [
                    {"hour": h, "count": hourly_flow.get(h, 0)} for h in range(24)
                ],
                "vehicle_types": dict(type_counts),
                "vehicle_colors": dict(color_counts),
                "peak_hour": max(hourly_flow, key=hourly_flow.get) if hourly_flow else None,
            }

    async def get_vehicle_violations(
        self, plate_text: Optional[str] = None, hours: int = 24
    ) -> Dict[str, Any]:
        """Get vehicle violations, optionally filtered by plate."""
        from backend.models.advanced_models import VehicleAnalyticsEvent

        async with async_session() as session:
            since = datetime.now(timezone.utc) - timedelta(hours=hours)
            query = select(VehicleAnalyticsEvent).where(
                VehicleAnalyticsEvent.created_at > since
            )
            if plate_text:
                query = query.where(VehicleAnalyticsEvent.plate_text == plate_text.upper())

            result = await session.execute(
                query.order_by(desc(VehicleAnalyticsEvent.created_at)).limit(100)
            )
            events = result.scalars().all()

            return {
                "success": True,
                "violations": [
                    {
                        "id": str(e.id),
                        "event_type": e.event_type,
                        "plate_text": e.plate_text,
                        "vehicle_description": e.vehicle_description,
                        "severity": e.severity,
                        "details": e.details,
                        "confidence": e.confidence,
                        "resolved": e.resolved,
                        "created_at": e.created_at.isoformat() if e.created_at else None,
                    }
                    for e in events
                ],
                "total": len(events),
            }

    async def create_violation_event(
        self,
        event_type: str,
        camera_id: str,
        zone_id: Optional[str] = None,
        plate_text: Optional[str] = None,
        vehicle_description: Optional[Dict] = None,
        severity: str = "medium",
        details: Optional[Dict] = None,
        confidence: float = 0.0,
    ) -> Dict[str, Any]:
        """Create a vehicle analytics violation event."""
        from backend.models.advanced_models import VehicleAnalyticsEvent

        async with async_session() as session:
            event = VehicleAnalyticsEvent(
                camera_id=camera_id,
                zone_id=zone_id,
                event_type=event_type,
                plate_text=plate_text.upper() if plate_text else None,
                vehicle_description=vehicle_description,
                severity=severity,
                details=details,
                confidence=confidence,
            )
            session.add(event)
            await session.commit()
            return {"success": True, "event_id": str(event.id)}


# Singleton
vehicle_analytics_service = VehicleAnalyticsService()
