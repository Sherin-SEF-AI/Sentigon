"""License Plate Recognition API — vehicle tracking, watchlist, and plate search."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, func, desc
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.auth import get_current_user, require_role
from backend.database import get_db, async_session
from backend.models.models import UserRole
from backend.models.advanced_models import VehicleSighting, VehicleWatchlist, VehicleTrip

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/lpr", tags=["lpr"])


# ── Schemas ───────────────────────────────────────────────────

class WatchlistEntryCreate(BaseModel):
    plate_number: str
    reason: str
    severity: str = "high"
    plate_pattern: Optional[str] = None
    notes: Optional[str] = None
    vehicle_description: Optional[str] = None
    active: bool = True


# ── Helpers ──────────────────────────────────────────────────

def _fmt_sighting(s: VehicleSighting) -> dict:
    return {
        "id": str(s.id),
        "plate_number": s.plate_text or "",
        "camera": str(s.camera_id),
        "vehicle_type": s.vehicle_type or "",
        "color": s.vehicle_color or "",
        "make": s.vehicle_make,
        "model": s.vehicle_model,
        "confidence": s.plate_confidence,
        "timestamp": s.timestamp.isoformat() if s.timestamp else None,
        "direction": s.vehicle_direction,
        "watchlisted": False,
    }


def _fmt_watchlist(w: VehicleWatchlist) -> dict:
    return {
        "id": str(w.id),
        "plate_number": w.plate_text,
        "plate_pattern": w.plate_pattern,
        "reason": w.reason,
        "severity": w.severity,
        "active": w.active,
        "notes": w.notes,
        "vehicle_description": w.notes or "",
        "created_at": w.created_at.isoformat() if w.created_at else None,
        "expires_at": w.expires_at.isoformat() if w.expires_at else None,
    }


# ── 1. Dashboard stats ──────────────────────────────────────

@router.get("/stats")
async def lpr_stats(_user=Depends(get_current_user)):
    """Get LPR system statistics."""
    async with async_session() as session:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=24)

        total = (await session.execute(select(func.count(VehicleSighting.id)))).scalar() or 0
        recent = (await session.execute(
            select(func.count(VehicleSighting.id)).where(VehicleSighting.timestamp >= cutoff)
        )).scalar() or 0
        wl_count = (await session.execute(
            select(func.count(VehicleWatchlist.id)).where(VehicleWatchlist.active == True)
        )).scalar() or 0
        unique = (await session.execute(
            select(func.count(func.distinct(VehicleSighting.plate_text)))
        )).scalar() or 0
        avg_conf = (await session.execute(
            select(func.avg(VehicleSighting.plate_confidence))
        )).scalar() or 0

        # Watchlist hits: sightings whose plate matches an active watchlist entry
        wl_hits = (await session.execute(
            select(func.count(VehicleSighting.id)).where(
                VehicleSighting.plate_text.in_(
                    select(VehicleWatchlist.plate_text).where(VehicleWatchlist.active == True)
                )
            )
        )).scalar() or 0

        return {
            "total_plates": total,
            "plates_last_24h": recent,
            "watchlist_entries": wl_count,
            "watchlist_hits": wl_hits,
            "unique_vehicles": unique,
            "avg_confidence": round(float(avg_conf), 2),
        }


# ── 2. Plate log ────────────────────────────────────────────

@router.get("/plates")
async def list_plates(
    limit: int = Query(50, ge=1, le=500),
    watchlisted_only: bool = Query(False),
    _user=Depends(get_current_user),
):
    """Get recent plate detections."""
    async with async_session() as session:
        query = select(VehicleSighting).order_by(desc(VehicleSighting.timestamp)).limit(limit)
        result = await session.execute(query)
        return [_fmt_sighting(s) for s in result.scalars().all()]


# ── 3. Search plates ────────────────────────────────────────

@router.get("/search")
async def search_plates(
    query: str = Query(..., description="Plate number or partial match"),
    _user=Depends(get_current_user),
):
    """Search plate log by plate number."""
    q = query.upper().strip()
    async with async_session() as session:
        result = await session.execute(
            select(VehicleSighting)
            .where(VehicleSighting.plate_text.ilike(f"%{q}%"))
            .order_by(desc(VehicleSighting.timestamp))
            .limit(50)
        )
        return [_fmt_sighting(s) for s in result.scalars().all()]


# ── 4. Watchlist CRUD ────────────────────────────────────────

@router.get("/watchlist")
async def get_watchlist(_user=Depends(get_current_user)):
    """Get the full vehicle watchlist."""
    async with async_session() as session:
        result = await session.execute(
            select(VehicleWatchlist).order_by(desc(VehicleWatchlist.created_at))
        )
        return [_fmt_watchlist(w) for w in result.scalars().all()]


@router.post("/watchlist")
async def add_to_watchlist(
    body: WatchlistEntryCreate,
    _user=Depends(require_role(UserRole.ANALYST)),
):
    """Add a plate to the watchlist."""
    async with async_session() as session:
        entry = VehicleWatchlist(
            plate_text=body.plate_number.upper().strip(),
            plate_pattern=body.plate_pattern,
            reason=body.reason,
            severity=body.severity,
            notes=body.notes or body.vehicle_description,
            active=body.active,
        )
        session.add(entry)
        await session.commit()
        await session.refresh(entry)
        return _fmt_watchlist(entry)


@router.delete("/watchlist/{entry_id}")
async def remove_from_watchlist(
    entry_id: str,
    _user=Depends(require_role(UserRole.ANALYST)),
):
    """Remove a plate from the watchlist."""
    async with async_session() as session:
        result = await session.execute(
            select(VehicleWatchlist).where(VehicleWatchlist.id == uuid.UUID(entry_id))
        )
        entry = result.scalar_one_or_none()
        if not entry:
            raise HTTPException(status_code=404, detail="Watchlist entry not found")
        await session.delete(entry)
        await session.commit()
        return {"status": "removed"}


# ── 5. Vehicle dwell time ────────────────────────────────────

@router.get("/dwell")
async def get_vehicle_dwell(_user=Depends(get_current_user)):
    """Get vehicles tracked for dwell time."""
    async with async_session() as session:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
        result = await session.execute(
            select(
                VehicleSighting.plate_text,
                VehicleSighting.camera_id,
                func.min(VehicleSighting.timestamp).label("first_seen"),
                func.max(VehicleSighting.timestamp).label("last_seen"),
                func.count(VehicleSighting.id).label("cnt"),
            )
            .where(VehicleSighting.timestamp >= cutoff)
            .group_by(VehicleSighting.plate_text, VehicleSighting.camera_id)
            .having(func.count(VehicleSighting.id) > 1)
            .order_by(desc(func.max(VehicleSighting.timestamp)))
        )
        return [
            {
                "id": f"dwell-{i}",
                "plate_number": row.plate_text or "",
                "zone": str(row.camera_id),
                "first_seen": row.first_seen.isoformat() if row.first_seen else None,
                "last_seen": row.last_seen.isoformat() if row.last_seen else None,
                "dwell_seconds": int((row.last_seen - row.first_seen).total_seconds()) if row.first_seen and row.last_seen else 0,
            }
            for i, row in enumerate(result.all())
        ]


# ── 6. Plate timeline ───────────────────────────────────────

@router.get("/timeline/{plate_number}")
async def get_plate_timeline(plate_number: str, _user=Depends(get_current_user)):
    """Get the full timeline of a specific plate across all cameras."""
    async with async_session() as session:
        sightings = (await session.execute(
            select(VehicleSighting)
            .where(VehicleSighting.plate_text == plate_number)
            .order_by(VehicleSighting.timestamp)
        )).scalars().all()

        wl_match = (await session.execute(
            select(VehicleWatchlist).where(
                VehicleWatchlist.plate_text == plate_number,
                VehicleWatchlist.active == True,
            )
        )).scalar_one_or_none()

        # Calculate dwell records by grouping sightings per camera
        dwell_records = []
        by_camera: Dict[str, List[VehicleSighting]] = {}
        for s in sightings:
            cam_key = str(s.camera_id)
            by_camera.setdefault(cam_key, []).append(s)

        for cam_id, cam_sightings in by_camera.items():
            if len(cam_sightings) < 2:
                continue
            first = cam_sightings[0].timestamp
            last = cam_sightings[-1].timestamp
            if first and last:
                dwell_records.append({
                    "camera_id": cam_id,
                    "first_seen": first.isoformat(),
                    "last_seen": last.isoformat(),
                    "dwell_seconds": int((last - first).total_seconds()),
                    "sighting_count": len(cam_sightings),
                })

        return {
            "plate_number": plate_number,
            "sightings": [_fmt_sighting(s) for s in sightings],
            "sighting_count": len(sightings),
            "watchlisted": wl_match is not None,
            "watchlist_info": _fmt_watchlist(wl_match) if wl_match else None,
            "dwell_records": dwell_records,
        }


# ── 7. Analytics ─────────────────────────────────────────────

@router.get("/analytics/flow")
async def vehicle_flow(
    hours: int = Query(24, ge=1, le=168),
    _user=Depends(get_current_user),
):
    """Get vehicle flow patterns over time."""
    async with async_session() as session:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
        result = await session.execute(
            select(VehicleSighting)
            .where(VehicleSighting.timestamp >= cutoff)
            .order_by(VehicleSighting.timestamp)
        )
        sightings = result.scalars().all()
        by_hour: Dict[str, int] = {}
        for s in sightings:
            if s.timestamp:
                key = s.timestamp.strftime("%Y-%m-%dT%H:00")
                by_hour[key] = by_hour.get(key, 0) + 1
        return {
            "flow": [{"hour": k, "count": v} for k, v in sorted(by_hour.items())],
            "range_hours": hours,
            "total": len(sightings),
        }


# ── 8. Vehicle Analytics Suite ──────────────────────────────


@router.get("/analytics/vehicles")
async def get_vehicle_analytics(
    zone_id: Optional[str] = Query(None),
    hours: int = Query(24, ge=1, le=168),
    _user=Depends(get_current_user),
):
    """Get vehicle analytics with make/model/color classification."""
    from backend.services.vehicle_analytics_service import vehicle_analytics_service
    return await vehicle_analytics_service.get_vehicle_flow_analytics(hours=hours)


@router.get("/analytics/violations")
async def get_violations(
    plate_text: Optional[str] = Query(None),
    hours: int = Query(24, ge=1, le=168),
    _user=Depends(get_current_user),
):
    """Get parking/direction violations."""
    from backend.services.vehicle_analytics_service import vehicle_analytics_service
    return await vehicle_analytics_service.get_vehicle_violations(plate_text=plate_text, hours=hours)


@router.get("/analytics/loitering")
async def get_loitering_vehicles(
    hours: int = Query(4, ge=1, le=48),
    _user=Depends(get_current_user),
):
    """Get vehicles flagged for loitering (seen on 3+ cameras)."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    async with async_session() as session:
        result = await session.execute(
            select(
                VehicleSighting.plate_text,
                func.count(func.distinct(VehicleSighting.camera_id)).label("camera_count"),
                func.count(VehicleSighting.id).label("sighting_count"),
                func.min(VehicleSighting.timestamp).label("first_seen"),
                func.max(VehicleSighting.timestamp).label("last_seen"),
            )
            .where(VehicleSighting.timestamp >= cutoff, VehicleSighting.plate_text != None)
            .group_by(VehicleSighting.plate_text)
            .having(func.count(func.distinct(VehicleSighting.camera_id)) >= 3)
            .order_by(desc(func.count(func.distinct(VehicleSighting.camera_id))))
        )
        return [
            {
                "plate_number": row.plate_text,
                "camera_count": row.camera_count,
                "sighting_count": row.sighting_count,
                "first_seen": row.first_seen.isoformat() if row.first_seen else None,
                "last_seen": row.last_seen.isoformat() if row.last_seen else None,
                "status": "loitering",
            }
            for row in result.all()
        ]


@router.get("/analytics/loading-docks")
async def get_loading_dock_status(
    _user=Depends(get_current_user),
):
    """Get loading dock occupancy and dwell times."""
    from backend.models.advanced_models import ParkingZoneConfig
    async with async_session() as session:
        result = await session.execute(
            select(ParkingZoneConfig).where(
                ParkingZoneConfig.zone_type.in_(["loading_dock", "fire_lane"]),
                ParkingZoneConfig.is_active == True,
            )
        )
        docks = result.scalars().all()
        return [
            {
                "id": str(d.id),
                "zone_id": str(d.zone_id),
                "zone_type": d.zone_type,
                "total_spots": d.total_spots,
                "occupied_spots": d.occupied_spots,
                "max_dwell_minutes": d.max_dwell_minutes,
                "utilization": round(d.occupied_spots / d.total_spots, 2) if d.total_spots else 0,
            }
            for d in docks
        ]


@router.get("/analytics/flow-patterns")
async def get_flow_patterns(
    hours: int = Query(24, ge=1, le=168),
    _user=Depends(get_current_user),
):
    """Get detailed hourly flow data with vehicle type breakdowns."""
    from backend.services.vehicle_analytics_service import vehicle_analytics_service
    return await vehicle_analytics_service.get_vehicle_flow_analytics(hours=hours)


class ParkingConfigCreate(BaseModel):
    zone_id: str
    zone_type: str = "parking"
    max_dwell_minutes: Optional[int] = None
    allowed_vehicle_types: Optional[list] = None
    allowed_directions: Optional[list] = None
    total_spots: Optional[int] = None


@router.post("/zones/{zone_id}/parking-config")
async def create_parking_config(
    zone_id: str,
    body: ParkingConfigCreate,
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Configure parking rules for a zone."""
    from backend.models.advanced_models import ParkingZoneConfig

    async with async_session() as session:
        existing = (await session.execute(
            select(ParkingZoneConfig).where(ParkingZoneConfig.zone_id == uuid.UUID(zone_id))
        )).scalar_one_or_none()

        if existing:
            existing.zone_type = body.zone_type
            existing.max_dwell_minutes = body.max_dwell_minutes
            existing.allowed_vehicle_types = body.allowed_vehicle_types
            existing.allowed_directions = body.allowed_directions
            existing.total_spots = body.total_spots
        else:
            config = ParkingZoneConfig(
                zone_id=uuid.UUID(zone_id),
                zone_type=body.zone_type,
                max_dwell_minutes=body.max_dwell_minutes,
                allowed_vehicle_types=body.allowed_vehicle_types,
                allowed_directions=body.allowed_directions,
                total_spots=body.total_spots or 0,
            )
            session.add(config)
        await session.commit()
        return {"status": "configured", "zone_id": zone_id}


@router.get("/vehicle/{plate_number}/full-profile")
async def get_vehicle_full_profile(
    plate_number: str,
    _user=Depends(get_current_user),
):
    """Get complete vehicle profile: sightings, watchlist status, violations, trips."""
    from backend.models.advanced_models import VehicleAnalyticsEvent

    plate = plate_number.upper().strip()
    async with async_session() as session:
        # Sightings
        sightings = (await session.execute(
            select(VehicleSighting)
            .where(VehicleSighting.plate_text == plate)
            .order_by(desc(VehicleSighting.timestamp))
            .limit(50)
        )).scalars().all()

        # Watchlist
        wl_match = (await session.execute(
            select(VehicleWatchlist).where(
                VehicleWatchlist.plate_text == plate,
                VehicleWatchlist.active == True,
            )
        )).scalar_one_or_none()

        # Violations
        violations = (await session.execute(
            select(VehicleAnalyticsEvent)
            .where(VehicleAnalyticsEvent.plate_text == plate)
            .order_by(desc(VehicleAnalyticsEvent.created_at))
            .limit(20)
        )).scalars().all()

        # Trips
        trips = (await session.execute(
            select(VehicleTrip)
            .where(VehicleTrip.plate_text == plate)
            .order_by(desc(VehicleTrip.entry_time))
            .limit(20)
        )).scalars().all()

        # Vehicle description from latest sighting
        vehicle_desc = {}
        if sightings:
            latest = sightings[0]
            vehicle_desc = {
                "make": latest.vehicle_make,
                "model": latest.vehicle_model,
                "color": latest.vehicle_color,
                "type": latest.vehicle_type,
            }

        return {
            "plate_number": plate,
            "vehicle_description": vehicle_desc,
            "watchlisted": wl_match is not None,
            "watchlist_info": _fmt_watchlist(wl_match) if wl_match else None,
            "sighting_count": len(sightings),
            "sightings": [_fmt_sighting(s) for s in sightings[:20]],
            "violations": [
                {
                    "id": str(v.id),
                    "event_type": v.event_type,
                    "severity": v.severity,
                    "details": v.details,
                    "confidence": v.confidence,
                    "resolved": v.resolved,
                    "created_at": v.created_at.isoformat() if v.created_at else None,
                }
                for v in violations
            ],
            "trips": [
                {
                    "id": str(t.id),
                    "entry_time": t.entry_time.isoformat() if t.entry_time else None,
                    "exit_time": t.exit_time.isoformat() if t.exit_time else None,
                    "dwell_seconds": t.total_dwell_seconds,
                }
                for t in trips
            ],
        }
