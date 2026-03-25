"""Phase 3B: Alert Feedback API — false-positive learning and threshold tuning."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
from backend.models.phase3_models import FalsePositiveProfile
from backend.services.feedback_tuning_service import feedback_tuning_service

router = APIRouter(prefix="/api/feedback", tags=["alert-feedback"])


@router.post("/")
async def record_feedback(data: dict, db: AsyncSession = Depends(get_db)):
    try:
        result = await feedback_tuning_service.record_feedback(
            db,
            alert_id=data["alert_id"],
            is_true_positive=data["is_true_positive"],
            fp_reason=data.get("fp_reason"),
            fp_notes=data.get("fp_notes"),
        )
        return result
    except KeyError as e:
        raise HTTPException(400, f"Missing required field: {e}")
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/thresholds")
async def get_adjusted_thresholds(db: AsyncSession = Depends(get_db)):
    stmt = select(FalsePositiveProfile).where(
        FalsePositiveProfile.adjusted_threshold != FalsePositiveProfile.original_threshold
    )
    result = await db.execute(stmt)
    return result.scalars().all()


@router.get("/report")
async def fp_report(days: int = Query(7, ge=1, le=90), db: AsyncSession = Depends(get_db)):
    try:
        report = await feedback_tuning_service.generate_fp_report(db, days=days)
        return report
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/camera/{camera_id}/profile")
async def get_camera_fp_profile(camera_id: str, db: AsyncSession = Depends(get_db)):
    try:
        profiles = await feedback_tuning_service.get_fp_profiles(db, camera_id=camera_id)
        return profiles
    except Exception as e:
        raise HTTPException(400, str(e))


@router.post("/camera/{camera_id}/reset")
async def reset_camera_fp_profile(camera_id: str, db: AsyncSession = Depends(get_db)):
    try:
        result = await feedback_tuning_service.reset_fp_profile(db, camera_id=camera_id)
        return result
    except Exception as e:
        raise HTTPException(400, str(e))
