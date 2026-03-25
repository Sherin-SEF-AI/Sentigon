"""Phase 3D: Safety Detection API — fire, falls, medical distress, mass egress."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
from backend.services.safety_detection_service import safety_detection_service

router = APIRouter(prefix="/api/safety", tags=["safety-detection"])


@router.get("/stats")
async def safety_stats(db: AsyncSession = Depends(get_db)):
    try:
        return await safety_detection_service.get_stats(db)
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/slip-fall-hotspots")
async def slip_fall_hotspots(
    camera_id: str = None,
    db: AsyncSession = Depends(get_db),
):
    try:
        return await safety_detection_service.get_slip_fall_hotspots(db, camera_id=camera_id)
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/events")
async def get_safety_events(
    event_type: str = None,
    hours: int = Query(24, ge=1, le=720),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    try:
        return await safety_detection_service.get_safety_events(
            db, event_type=event_type, hours=hours, limit=limit,
        )
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/events/{event_id}")
async def get_safety_event(event_id: str, db: AsyncSession = Depends(get_db)):
    try:
        event = await safety_detection_service.get_safety_event(db, event_id=event_id)
        if not event:
            raise HTTPException(404, "Safety event not found")
        return event
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, str(e))
