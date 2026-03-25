"""Phase 3D: Weapon Detection API — weapon detection events and statistics."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from datetime import datetime, timedelta, timezone

from backend.database import get_db
from backend.models.phase3_models import WeaponDetectionEvent
from backend.services.weapon_detection_service import weapon_detection_service

router = APIRouter(prefix="/api/weapon-detection", tags=["weapon-detection"])


@router.get("/stats")
async def weapon_stats(db: AsyncSession = Depends(get_db)):
    try:
        return await weapon_detection_service.get_stats(db)
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/events")
async def get_weapon_events(
    hours: int = Query(24, ge=1, le=720),
    severity: str = None,
    db: AsyncSession = Depends(get_db),
):
    try:
        return await weapon_detection_service.get_weapon_events(
            db, hours=hours, severity=severity,
        )
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/events/{event_id}")
async def get_weapon_event(event_id: str, db: AsyncSession = Depends(get_db)):
    try:
        result = await db.execute(
            select(WeaponDetectionEvent).where(
                WeaponDetectionEvent.id == uuid.UUID(event_id)
            )
        )
        event = result.scalar_one_or_none()
        if not event:
            raise HTTPException(404, "Weapon detection event not found")
        return {
            "id": str(event.id),
            "camera_id": str(event.camera_id),
            "zone_id": str(event.zone_id) if event.zone_id else None,
            "timestamp": event.timestamp.isoformat() if event.timestamp else None,
            "weapon_type": event.weapon_type,
            "detection_method": event.detection_method,
            "confidence": event.confidence,
            "threat_posture": event.threat_posture,
            "posture_confidence": event.posture_confidence,
            "pre_indicators": event.pre_indicators or [],
            "acoustic_correlated": event.acoustic_correlated,
            "track_id": event.track_id,
            "bounding_box": event.bounding_box,
            "alert_id": str(event.alert_id) if event.alert_id else None,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, str(e))
