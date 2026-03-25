"""VIP Protection API — manage VIP profiles, proximity events, and tracking."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.auth import get_current_user, require_role
from backend.database import get_db, async_session
from backend.models.models import UserRole
from backend.models.phase2_models import VIPProfile, VIPProximityEvent

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/vip", tags=["vip"])


# ── Schemas ───────────────────────────────────────────────────

class VIPProfileCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    appearance: dict = Field(default_factory=dict)
    threat_level: str = Field("normal", description="normal, elevated, high, critical")
    geofence_radius_meters: float = Field(50.0, ge=5.0, le=500.0)
    image_path: Optional[str] = None


class VIPProfileUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    appearance: Optional[dict] = None
    threat_level: Optional[str] = None
    active: Optional[bool] = None
    geofence_radius_meters: Optional[float] = None
    image_path: Optional[str] = None


class VIPProfileResponse(BaseModel):
    id: str
    name: str
    description: Optional[str]
    appearance: dict
    threat_level: str
    active: bool
    geofence_radius_meters: float
    image_path: Optional[str]
    created_at: Optional[str]
    updated_at: Optional[str]


class ProximityEventResponse(BaseModel):
    id: str
    vip_id: str
    vip_name: Optional[str] = None
    threat_type: Optional[str]
    distance_meters: Optional[float]
    camera_id: Optional[str]
    severity: str
    timestamp: Optional[str]


# ── Helpers ───────────────────────────────────────────────────

def _fmt_vip(v: VIPProfile) -> dict:
    return {
        "id": str(v.id),
        "name": v.name,
        "description": v.description,
        "appearance": v.appearance or {},
        "threat_level": v.threat_level or "normal",
        "active": v.active,
        "geofence_radius_meters": v.geofence_radius_meters or 50.0,
        "image_path": v.image_path,
        "created_at": v.created_at.isoformat() if v.created_at else None,
        "updated_at": v.updated_at.isoformat() if v.updated_at else None,
    }


def _fmt_proximity(e: VIPProximityEvent, vip_name: Optional[str] = None) -> dict:
    return {
        "id": str(e.id),
        "vip_id": str(e.vip_id),
        "vip_name": vip_name,
        "threat_type": e.threat_type,
        "distance_meters": e.distance_meters,
        "camera_id": e.camera_id,
        "severity": e.severity or "medium",
        "timestamp": e.timestamp.isoformat() if e.timestamp else None,
    }


# ── Endpoints ─────────────────────────────────────────────────

@router.get("/profiles", response_model=List[dict])
async def list_vip_profiles(
    active_only: bool = Query(True),
    limit: int = Query(50, ge=1, le=200),
    _user=Depends(get_current_user),
):
    """List VIP profiles."""
    try:
        async with async_session() as session:
            stmt = select(VIPProfile).order_by(desc(VIPProfile.created_at)).limit(limit)

            if active_only:
                stmt = stmt.where(VIPProfile.active == True)

            result = await session.execute(stmt)
            return [_fmt_vip(v) for v in result.scalars().all()]
    except Exception as e:
        logger.error(f"Error listing VIP profiles: {e}")
        raise HTTPException(status_code=500, detail="Failed to list VIP profiles")


@router.post("/profiles", response_model=dict, status_code=201)
async def create_vip_profile(
    body: VIPProfileCreate,
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Create a new VIP profile (admin only)."""
    try:
        async with async_session() as session:
            profile = VIPProfile(
                name=body.name,
                description=body.description,
                appearance=body.appearance,
                threat_level=body.threat_level,
                geofence_radius_meters=body.geofence_radius_meters,
                image_path=body.image_path,
                active=True,
            )
            session.add(profile)
            await session.commit()
            await session.refresh(profile)
            return _fmt_vip(profile)
    except Exception as e:
        logger.error(f"Error creating VIP profile: {e}")
        raise HTTPException(status_code=500, detail="Failed to create VIP profile")


@router.put("/profiles/{vip_id}", response_model=dict)
async def update_vip_profile(
    vip_id: uuid.UUID,
    body: VIPProfileUpdate,
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Update an existing VIP profile (admin only)."""
    try:
        async with async_session() as session:
            result = await session.execute(
                select(VIPProfile).where(VIPProfile.id == vip_id)
            )
            profile = result.scalar_one_or_none()
            if not profile:
                raise HTTPException(status_code=404, detail="VIP profile not found")

            update_data = body.model_dump(exclude_unset=True)
            for field, value in update_data.items():
                setattr(profile, field, value)

            profile.updated_at = datetime.now(timezone.utc)
            await session.commit()
            await session.refresh(profile)
            return _fmt_vip(profile)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating VIP profile {vip_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to update VIP profile")


@router.get("/proximity-events", response_model=List[dict])
async def list_proximity_events(
    vip_id: Optional[str] = Query(None, description="Filter by VIP ID"),
    severity: Optional[str] = Query(None, description="Filter by severity"),
    hours: int = Query(24, ge=1, le=168),
    limit: int = Query(50, ge=1, le=200),
    _user=Depends(get_current_user),
):
    """List proximity events for VIPs."""
    try:
        async with async_session() as session:
            cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
            stmt = (
                select(VIPProximityEvent)
                .where(VIPProximityEvent.timestamp >= cutoff)
                .order_by(desc(VIPProximityEvent.timestamp))
                .limit(limit)
            )

            if vip_id:
                stmt = stmt.where(VIPProximityEvent.vip_id == uuid.UUID(vip_id))
            if severity:
                stmt = stmt.where(VIPProximityEvent.severity == severity)

            result = await session.execute(stmt)
            events = result.scalars().all()

            # Fetch VIP names for enrichment
            vip_ids = list({e.vip_id for e in events})
            vip_names: dict = {}
            if vip_ids:
                vip_result = await session.execute(
                    select(VIPProfile).where(VIPProfile.id.in_(vip_ids))
                )
                for v in vip_result.scalars().all():
                    vip_names[v.id] = v.name

            return [_fmt_proximity(e, vip_names.get(e.vip_id)) for e in events]
    except Exception as e:
        logger.error(f"Error listing proximity events: {e}")
        raise HTTPException(status_code=500, detail="Failed to list proximity events")


@router.get("/tracking/{vip_id}", response_model=dict)
async def get_vip_tracking(
    vip_id: uuid.UUID,
    hours: int = Query(24, ge=1, le=168),
    _user=Depends(get_current_user),
):
    """Get tracking information for a specific VIP including recent proximity events."""
    try:
        async with async_session() as session:
            # Get VIP profile
            vip_result = await session.execute(
                select(VIPProfile).where(VIPProfile.id == vip_id)
            )
            profile = vip_result.scalar_one_or_none()
            if not profile:
                raise HTTPException(status_code=404, detail="VIP profile not found")

            # Get recent proximity events
            cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
            events_result = await session.execute(
                select(VIPProximityEvent)
                .where(
                    VIPProximityEvent.vip_id == vip_id,
                    VIPProximityEvent.timestamp >= cutoff,
                )
                .order_by(desc(VIPProximityEvent.timestamp))
                .limit(100)
            )
            events = events_result.scalars().all()

            # Determine last known camera
            last_camera = None
            last_seen = None
            if events:
                last_camera = events[0].camera_id
                last_seen = events[0].timestamp.isoformat() if events[0].timestamp else None

            return {
                "profile": _fmt_vip(profile),
                "tracking": {
                    "last_camera": last_camera,
                    "last_seen": last_seen,
                    "event_count_24h": len(events),
                    "high_severity_events": sum(1 for e in events if e.severity in ("high", "critical")),
                    "cameras_detected_on": list({e.camera_id for e in events if e.camera_id}),
                },
                "recent_events": [_fmt_proximity(e, profile.name) for e in events[:20]],
            }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching VIP tracking for {vip_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch VIP tracking")
