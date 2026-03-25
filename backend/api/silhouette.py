"""Phase 3E: Silhouette Privacy API — tiered privacy rendering and access audit."""

import uuid as _uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
from backend.models.phase3_models import SilhouetteConfig, VideoAccessLog
from backend.services.silhouette_service import silhouette_service

router = APIRouter(prefix="/api/silhouette", tags=["silhouette-privacy"])


def _to_uuid(value: str | None) -> _uuid.UUID | None:
    """Convert a string to UUID, returning None when the input is None."""
    if value is None:
        return None
    return _uuid.UUID(value)


@router.get("/config")
async def get_config(
    zone_id: str = None,
    camera_id: str = None,
    db: AsyncSession = Depends(get_db),
):
    try:
        config = await silhouette_service.get_zone_config(
            db, zone_id=_to_uuid(zone_id), camera_id=_to_uuid(camera_id),
        )
        return config
    except Exception as e:
        raise HTTPException(400, str(e))


@router.post("/config")
async def set_config(data: dict, db: AsyncSession = Depends(get_db)):
    try:
        zone_id = _to_uuid(data.pop("zone_id", None))
        camera_id = _to_uuid(data.pop("camera_id", None))
        result = await silhouette_service.set_zone_config(
            db, zone_id=zone_id, camera_id=camera_id, config=data,
        )
        return result
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/access-tier")
async def check_access_tier(
    user_role: str = Query(...),
    zone_id: str = None,
    camera_id: str = None,
    db: AsyncSession = Depends(get_db),
):
    try:
        tier = await silhouette_service.check_access_tier(
            db, user_role=user_role, zone_id=_to_uuid(zone_id), camera_id=_to_uuid(camera_id),
        )
        return {"access_tier": tier}
    except Exception as e:
        raise HTTPException(400, str(e))


@router.post("/access-log")
async def log_video_access(data: dict, db: AsyncSession = Depends(get_db)):
    try:
        log_data = dict(data)
        if "user_id" in log_data:
            log_data["user_id"] = _uuid.UUID(log_data["user_id"])
        if "camera_id" in log_data:
            log_data["camera_id"] = _uuid.UUID(log_data["camera_id"])
        result = await silhouette_service.log_video_access(db, **log_data)
        return result
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/access-audit")
async def get_access_audit(
    camera_id: str = None,
    user_id: str = None,
    days: int = Query(7, ge=1, le=90),
    limit: int = Query(100, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
):
    try:
        results = await silhouette_service.get_access_audit(
            db, camera_id=_to_uuid(camera_id), user_id=_to_uuid(user_id), days=days,
        )
        return results[:limit]
    except Exception as e:
        raise HTTPException(400, str(e))
