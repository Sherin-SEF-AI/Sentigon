"""Phase 3D: Entity Tracking API — persistent entity profiles and anomalous behavior."""

import uuid as _uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
from backend.models.phase3_models import EntityTrack, EntityAppearance
from backend.services.entity_tracker_service import entity_tracker_service

router = APIRouter(prefix="/api/entity-tracking", tags=["entity-tracking"])


@router.get("/active")
async def get_active_entities(
    zone_id: str = None,
    min_risk_score: float = Query(0.0, ge=0.0, le=1.0),
    db: AsyncSession = Depends(get_db),
):
    try:
        result = await entity_tracker_service.get_active_entities(
            db, zone_id=zone_id, min_risk_score=min_risk_score,
        )
        return result
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/anomalous")
async def get_anomalous_entities(
    hours: int = Query(24, ge=1, le=168),
    db: AsyncSession = Depends(get_db),
):
    try:
        return await entity_tracker_service.get_anomalous_entities(db, hours=hours)
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/stats")
async def entity_stats(db: AsyncSession = Depends(get_db)):
    try:
        total_result = await db.execute(select(func.count(EntityTrack.id)))
        total = total_result.scalar() or 0

        cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
        active_result = await db.execute(
            select(func.count(EntityTrack.id)).where(EntityTrack.last_seen_at >= cutoff)
        )
        active = active_result.scalar() or 0

        flagged_result = await db.execute(
            select(func.count(EntityTrack.id)).where(EntityTrack.risk_score >= 0.4)
        )
        flagged = flagged_result.scalar() or 0

        high_risk_result = await db.execute(
            select(func.count(EntityTrack.id)).where(EntityTrack.escalation_level >= 2)
        )
        high_risk = high_risk_result.scalar() or 0

        return {
            "total_entities": total,
            "active_entities": active,
            "flagged_entities": flagged,
            "high_risk_entities": high_risk,
        }
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/{entity_id}")
async def get_entity(entity_id: str, db: AsyncSession = Depends(get_db)):
    try:
        entity = await entity_tracker_service.get_entity_profile(db, entity_id=entity_id)
        if not entity:
            raise HTTPException(404, "Entity not found")
        return entity
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/{entity_id}/appearances")
async def get_entity_appearances(
    entity_id: str,
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    try:
        result = await db.execute(
            select(EntityAppearance)
            .where(EntityAppearance.entity_track_id == _uuid.UUID(entity_id))
            .order_by(EntityAppearance.timestamp.desc())
            .limit(limit)
        )
        appearances = result.scalars().all()
        return [
            {
                "id": str(a.id),
                "camera_id": str(a.camera_id),
                "zone_id": str(a.zone_id) if a.zone_id else None,
                "timestamp": a.timestamp.isoformat() if a.timestamp else None,
                "duration_seconds": a.duration_seconds,
                "behavior": a.behavior,
                "frame_path": a.frame_path,
            }
            for a in appearances
        ]
    except Exception as e:
        raise HTTPException(400, str(e))
