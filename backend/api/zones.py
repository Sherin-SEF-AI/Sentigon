"""Zone CRUD API endpoints for SENTINEL AI."""

from __future__ import annotations

import uuid
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.config import settings
from backend.database import get_db
from backend.models import Zone, User
from backend.models.models import UserRole
from backend.schemas import ZoneCreate, ZoneUpdate, ZoneResponse
from backend.api.auth import get_current_user, require_role

router = APIRouter(prefix="/api/zones", tags=["zones"])


# ── List all zones ───────────────────────────────────────────

@router.get("", response_model=List[ZoneResponse])
async def list_zones(
    is_active: bool | None = None,
    zone_type: str | None = None,
    skip: int = 0,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Return all zones, with optional filters."""
    query = select(Zone).order_by(Zone.created_at.desc())

    if is_active is not None:
        query = query.where(Zone.is_active == is_active)
    if zone_type is not None:
        query = query.where(Zone.zone_type == zone_type)

    query = query.offset(skip).limit(limit)
    result = await db.execute(query)
    return [ZoneResponse.model_validate(z) for z in result.scalars().all()]


# ── Create a zone ────────────────────────────────────────────

@router.post("", response_model=ZoneResponse, status_code=status.HTTP_201_CREATED)
async def create_zone(
    body: ZoneCreate,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_role(UserRole.OPERATOR)),
):
    """Create a new zone. Requires at least operator role."""
    zone = Zone(
        name=body.name,
        description=body.description,
        zone_type=body.zone_type,
        polygon=body.polygon,
        max_occupancy=body.max_occupancy,
        current_occupancy=0,
        alert_on_breach=body.alert_on_breach,
        config=body.config,
        is_active=True,
    )
    db.add(zone)
    await db.flush()
    await db.refresh(zone)
    return ZoneResponse.model_validate(zone)


# ── Get single zone ──────────────────────────────────────────

@router.get("/{zone_id}", response_model=ZoneResponse)
async def get_zone(
    zone_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Retrieve a single zone by ID."""
    result = await db.execute(select(Zone).where(Zone.id == zone_id))
    zone = result.scalar_one_or_none()
    if zone is None:
        raise HTTPException(status_code=404, detail="Zone not found")
    return ZoneResponse.model_validate(zone)


# ── Update zone ──────────────────────────────────────────────

@router.patch("/{zone_id}", response_model=ZoneResponse)
async def update_zone(
    zone_id: uuid.UUID,
    body: ZoneUpdate,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_role(UserRole.OPERATOR)),
):
    """Partially update a zone. Requires at least operator role."""
    result = await db.execute(select(Zone).where(Zone.id == zone_id))
    zone = result.scalar_one_or_none()
    if zone is None:
        raise HTTPException(status_code=404, detail="Zone not found")

    update_data = body.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(zone, field, value)

    await db.flush()
    await db.refresh(zone)
    return ZoneResponse.model_validate(zone)


# ── Delete zone ──────────────────────────────────────────────

@router.delete("/{zone_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_zone(
    zone_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(require_role(UserRole.ADMIN)),
):
    """Delete a zone. Requires admin role."""
    result = await db.execute(select(Zone).where(Zone.id == zone_id))
    zone = result.scalar_one_or_none()
    if zone is None:
        raise HTTPException(status_code=404, detail="Zone not found")

    await db.delete(zone)
    await db.flush()
    return None


# ── Get zone occupancy ───────────────────────────────────────

@router.get("/{zone_id}/occupancy", response_model=Dict[str, Any])
async def get_zone_occupancy(
    zone_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """Return the current occupancy data for a zone."""
    result = await db.execute(select(Zone).where(Zone.id == zone_id))
    zone = result.scalar_one_or_none()
    if zone is None:
        raise HTTPException(status_code=404, detail="Zone not found")

    is_over_capacity = (
        zone.max_occupancy is not None
        and zone.current_occupancy > zone.max_occupancy
    )

    return {
        "zone_id": str(zone.id),
        "zone_name": zone.name,
        "current_occupancy": zone.current_occupancy,
        "max_occupancy": zone.max_occupancy,
        "is_over_capacity": is_over_capacity,
        "alert_on_breach": zone.alert_on_breach,
        "utilization_pct": (
            round((zone.current_occupancy / zone.max_occupancy) * 100, 1)
            if zone.max_occupancy and zone.max_occupancy > 0
            else None
        ),
    }
