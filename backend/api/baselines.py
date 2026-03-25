"""Phase 3A: Baseline Learning API — adaptive baselines and anomaly scoring."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
from backend.models.phase3_models import ActivityBaseline
from backend.services.baseline_learning_service import baseline_learning_service

router = APIRouter(prefix="/api/baselines", tags=["baselines"])


@router.get("/all")
async def list_baselines(
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    stmt = (
        select(ActivityBaseline)
        .order_by(ActivityBaseline.updated_at.desc())
        .offset(offset)
        .limit(limit)
    )
    result = await db.execute(stmt)
    total = await db.scalar(select(func.count(ActivityBaseline.id)))
    return {"total": total or 0, "items": result.scalars().all()}


@router.post("/rebuild")
async def rebuild_baselines(
    camera_id: str = Query(None),
    db: AsyncSession = Depends(get_db),
):
    try:
        result = await baseline_learning_service.rebuild_baselines(db, camera_id=camera_id)
        return {"status": "ok", "result": result}
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/camera/{camera_id}")
async def get_camera_baseline(camera_id: str, db: AsyncSession = Depends(get_db)):
    try:
        baseline = await baseline_learning_service.get_baseline(db, camera_id=camera_id)
        if not baseline:
            raise HTTPException(404, "No baseline found for this camera at current time")
        return baseline
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/camera/{camera_id}/anomaly")
async def get_anomaly_score(camera_id: str, db: AsyncSession = Depends(get_db)):
    try:
        score = await baseline_learning_service.compute_anomaly_score(db, camera_id=camera_id)
        return score
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/camera/{camera_id}/thresholds")
async def get_adaptive_thresholds(camera_id: str, db: AsyncSession = Depends(get_db)):
    try:
        thresholds = await baseline_learning_service.get_adaptive_thresholds(db, camera_id=camera_id)
        return thresholds
    except Exception as e:
        raise HTTPException(400, str(e))
