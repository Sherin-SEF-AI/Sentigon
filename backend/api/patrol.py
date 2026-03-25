"""Patrol Management API — shifts, routes, checkpoints, and coverage."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, desc, func
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.auth import get_current_user, require_role
from backend.database import get_db, async_session
from backend.models.models import UserRole
from backend.models.phase2_models import PatrolShift, PatrolRoute

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/patrol", tags=["patrol"])


# ── Schemas ───────────────────────────────────────────────────

class PatrolShiftCreate(BaseModel):
    guard_id: Optional[str] = None
    zone_ids: List[str] = Field(default_factory=list)
    start_time: Optional[datetime] = None
    route_waypoints: List[dict] = Field(default_factory=list)


class CheckpointRecord(BaseModel):
    checkpoint_id: str = Field(..., description="ID of the checkpoint reached")
    lat: Optional[float] = None
    lng: Optional[float] = None
    notes: Optional[str] = None
    timestamp: Optional[datetime] = None


class RouteGenerateRequest(BaseModel):
    zone_ids: List[str] = Field(..., min_length=1, description="Zones to cover")
    guard_count: int = Field(1, ge=1, le=20)
    priority_areas: List[dict] = Field(default_factory=list)
    time_window_minutes: int = Field(60, ge=15, le=480)


class PatrolShiftResponse(BaseModel):
    id: str
    guard_id: Optional[str]
    zone_ids: list
    start_time: Optional[str]
    end_time: Optional[str]
    route_waypoints: list
    status: str
    checkpoints_completed: list
    created_at: Optional[str]


class PatrolRouteResponse(BaseModel):
    id: str
    name: str
    zone_sequence: list
    risk_score: float
    estimated_duration_minutes: int
    is_active: bool
    created_at: Optional[str]
    updated_at: Optional[str]


# ── Helpers ───────────────────────────────────────────────────

def _fmt_shift(s: PatrolShift) -> dict:
    return {
        "id": str(s.id),
        "guard_id": str(s.guard_id) if s.guard_id else None,
        "zone_ids": s.zone_ids or [],
        "start_time": s.start_time.isoformat() if s.start_time else None,
        "end_time": s.end_time.isoformat() if s.end_time else None,
        "route_waypoints": s.route_waypoints or [],
        "status": s.status or "scheduled",
        "checkpoints_completed": s.checkpoints_completed or [],
        "created_at": s.created_at.isoformat() if s.created_at else None,
    }


def _fmt_route(r: PatrolRoute) -> dict:
    return {
        "id": str(r.id),
        "name": r.name,
        "zone_sequence": r.zone_sequence or [],
        "risk_score": r.risk_score or 0.0,
        "estimated_duration_minutes": r.estimated_duration_minutes or 30,
        "is_active": r.is_active,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    }


# ── Endpoints ─────────────────────────────────────────────────

@router.get("/shifts", response_model=List[dict])
async def list_patrol_shifts(
    status: Optional[str] = Query(None, description="Filter: scheduled, active, completed, cancelled"),
    limit: int = Query(50, ge=1, le=200),
    _user=Depends(get_current_user),
):
    """List patrol shifts."""
    try:
        async with async_session() as session:
            stmt = select(PatrolShift).order_by(desc(PatrolShift.start_time)).limit(limit)

            if status:
                stmt = stmt.where(PatrolShift.status == status)

            result = await session.execute(stmt)
            return [_fmt_shift(s) for s in result.scalars().all()]
    except Exception as e:
        logger.error(f"Error listing patrol shifts: {e}")
        raise HTTPException(status_code=500, detail="Failed to list patrol shifts")


@router.post("/shifts", response_model=dict, status_code=201)
async def create_patrol_shift(
    body: PatrolShiftCreate,
    user=Depends(require_role(UserRole.OPERATOR)),
):
    """Create a new patrol shift."""
    try:
        async with async_session() as session:
            shift = PatrolShift(
                guard_id=uuid.UUID(body.guard_id) if body.guard_id else user.id,
                zone_ids=body.zone_ids,
                start_time=body.start_time or datetime.now(timezone.utc),
                route_waypoints=body.route_waypoints,
                status="scheduled",
                checkpoints_completed=[],
            )
            session.add(shift)
            await session.commit()
            await session.refresh(shift)
            return _fmt_shift(shift)
    except Exception as e:
        logger.error(f"Error creating patrol shift: {e}")
        raise HTTPException(status_code=500, detail="Failed to create patrol shift")


@router.get("/routes", response_model=List[dict])
async def list_patrol_routes(
    active_only: bool = Query(True),
    _user=Depends(get_current_user),
):
    """List patrol routes."""
    try:
        async with async_session() as session:
            stmt = select(PatrolRoute).order_by(desc(PatrolRoute.created_at))

            if active_only:
                stmt = stmt.where(PatrolRoute.is_active == True)

            result = await session.execute(stmt)
            return [_fmt_route(r) for r in result.scalars().all()]
    except Exception as e:
        logger.error(f"Error listing patrol routes: {e}")
        raise HTTPException(status_code=500, detail="Failed to list patrol routes")


@router.post("/routes/generate", response_model=dict)
async def generate_optimized_route(
    body: RouteGenerateRequest,
    user=Depends(require_role(UserRole.OPERATOR)),
):
    """Generate an optimized patrol route using the patrol optimizer service."""
    try:
        # Attempt to use the patrol_optimizer service
        try:
            from backend.services.patrol_optimizer import patrol_optimizer
            optimized = await patrol_optimizer.generate_route(
                zone_ids=body.zone_ids,
                guard_count=body.guard_count,
                priority_areas=body.priority_areas,
                time_window_minutes=body.time_window_minutes,
            )
            return optimized
        except ImportError:
            logger.warning("patrol_optimizer service not available, using fallback")

        # Fallback: create a basic route from the provided zones
        async with async_session() as session:
            route = PatrolRoute(
                name=f"Auto-route {datetime.now(timezone.utc).strftime('%Y%m%d-%H%M')}",
                zone_sequence=body.zone_ids,
                risk_score=0.5,
                estimated_duration_minutes=body.time_window_minutes,
                is_active=True,
            )
            session.add(route)
            await session.commit()
            await session.refresh(route)

            return {
                "route": _fmt_route(route),
                "optimization_method": "fallback_sequential",
                "guard_assignments": [
                    {
                        "guard_index": i,
                        "zones": body.zone_ids[i::body.guard_count],
                    }
                    for i in range(body.guard_count)
                ],
            }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error generating patrol route: {e}")
        raise HTTPException(status_code=500, detail="Failed to generate patrol route")


@router.put("/shifts/{shift_id}/checkpoint", response_model=dict)
async def record_checkpoint(
    shift_id: uuid.UUID,
    body: CheckpointRecord,
    user=Depends(require_role(UserRole.OPERATOR)),
):
    """Record a checkpoint completion for a patrol shift."""
    try:
        async with async_session() as session:
            result = await session.execute(
                select(PatrolShift).where(PatrolShift.id == shift_id)
            )
            shift = result.scalar_one_or_none()
            if not shift:
                raise HTTPException(status_code=404, detail="Patrol shift not found")
            if shift.status not in ("scheduled", "active"):
                raise HTTPException(status_code=409, detail="Patrol shift is not active or scheduled")

            # Activate the shift if it was scheduled
            if shift.status == "scheduled":
                shift.status = "active"

            checkpoint_data = {
                "checkpoint_id": body.checkpoint_id,
                "recorded_by": str(user.id),
                "timestamp": (body.timestamp or datetime.now(timezone.utc)).isoformat(),
                "lat": body.lat,
                "lng": body.lng,
                "notes": body.notes,
            }

            completed = list(shift.checkpoints_completed or [])
            completed.append(checkpoint_data)
            shift.checkpoints_completed = completed

            await session.commit()
            await session.refresh(shift)
            return _fmt_shift(shift)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error recording checkpoint for shift {shift_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to record checkpoint")


@router.get("/coverage", response_model=dict)
async def get_coverage_summary(
    hours: int = Query(24, ge=1, le=168),
    _user=Depends(get_current_user),
):
    """Get patrol coverage summary across zones."""
    try:
        from datetime import timedelta

        async with async_session() as session:
            cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)

            # Get recent patrol shifts
            result = await session.execute(
                select(PatrolShift).where(PatrolShift.start_time >= cutoff)
            )
            shifts = result.scalars().all()

            # Aggregate coverage by zone
            zone_coverage: dict = {}
            total_checkpoints = 0
            for s in shifts:
                for zone_id in (s.zone_ids or []):
                    if zone_id not in zone_coverage:
                        zone_coverage[zone_id] = {"patrol_count": 0, "checkpoints": 0}
                    zone_coverage[zone_id]["patrol_count"] += 1
                total_checkpoints += len(s.checkpoints_completed or [])
                for cp in (s.checkpoints_completed or []):
                    cp_zone = cp.get("checkpoint_id", "").split("-")[0] if isinstance(cp, dict) else ""
                    if cp_zone in zone_coverage:
                        zone_coverage[cp_zone]["checkpoints"] += 1

            # Get active route count
            active_routes = (await session.execute(
                select(func.count(PatrolRoute.id)).where(PatrolRoute.is_active == True)
            )).scalar() or 0

            return {
                "time_range_hours": hours,
                "total_patrols": len(shifts),
                "active_patrols": sum(1 for s in shifts if s.status == "active"),
                "completed_patrols": sum(1 for s in shifts if s.status == "completed"),
                "total_checkpoints_recorded": total_checkpoints,
                "zones_covered": len(zone_coverage),
                "zone_coverage": zone_coverage,
                "active_routes": active_routes,
            }
    except Exception as e:
        logger.error(f"Error getting coverage summary: {e}")
        raise HTTPException(status_code=500, detail="Failed to get coverage summary")
