"""Phase 3B: Alert Feedback API — false-positive learning and threshold tuning.

This closes the false-alarm-reduction loop: an operator marks an alert true/false,
which updates the camera+signature FalsePositiveProfile that the live monitoring
loop already consults (should_suppress / get_adjusted_threshold).
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.auth import get_current_user
from backend.database import get_db
from backend.models import User
from backend.models.phase3_models import AlertFeedback, FalsePositiveProfile
from backend.services.feedback_tuning_service import feedback_tuning_service

router = APIRouter(prefix="/api/feedback", tags=["alert-feedback"])


class FeedbackRequest(BaseModel):
    alert_id: str
    is_true_positive: bool
    fp_reason: Optional[str] = None
    fp_notes: Optional[str] = None


@router.post("/")
async def record_feedback(
    body: FeedbackRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Record one-click operator feedback. operator_id is taken from the token."""
    try:
        return await feedback_tuning_service.record_feedback(
            db,
            alert_id=body.alert_id,
            operator_id=str(user.id),
            is_true_positive=body.is_true_positive,
            fp_reason=body.fp_reason,
            fp_notes=body.fp_notes,
        )
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
        return await feedback_tuning_service.generate_fp_report(db, days=days)
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/accuracy")
async def alarm_accuracy(db: AsyncSession = Depends(get_db)):
    """Measured alarm precision from operator feedback.

    precision = confirmed true positives / all labelled alerts.
    This is the headline false-alarm-reduction metric — it makes "we cut false
    alarms" a number rather than a claim.
    """
    total = (await db.execute(select(func.count(AlertFeedback.id)))).scalar() or 0
    tp = (
        await db.execute(
            select(func.count(AlertFeedback.id)).where(AlertFeedback.is_true_positive.is_(True))
        )
    ).scalar() or 0
    fp = total - tp
    precision = (tp / total) if total else None
    return {
        "labelled_alerts": total,
        "true_positives": tp,
        "false_positives": fp,
        "precision": round(precision, 4) if precision is not None else None,
        "false_alarm_rate": round(fp / total, 4) if total else None,
        "suppressed_signatures": (
            await db.execute(
                select(func.count(FalsePositiveProfile.id)).where(
                    FalsePositiveProfile.suppressed.is_(True)
                )
            )
        ).scalar() or 0,
    }


@router.get("/camera/{camera_id}/profile")
async def get_camera_fp_profile(camera_id: str, db: AsyncSession = Depends(get_db)):
    try:
        return await feedback_tuning_service.get_camera_fp_profile(db, camera_id=camera_id)
    except Exception as e:
        raise HTTPException(400, str(e))


@router.post("/camera/{camera_id}/reset")
async def reset_camera_fp_profile(camera_id: str, db: AsyncSession = Depends(get_db)):
    try:
        return await feedback_tuning_service.reset_profile(db, camera_id=camera_id)
    except Exception as e:
        raise HTTPException(400, str(e))
