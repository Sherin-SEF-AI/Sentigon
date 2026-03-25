"""Phase 3A: Intent Classification API — classified intent queries."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
from backend.models.phase3_models import IntentClassification

router = APIRouter(prefix="/api/intent", tags=["intent-classification"])


@router.get("/stats")
async def intent_stats(db: AsyncSession = Depends(get_db)):
    total = await db.scalar(select(func.count(IntentClassification.id)))
    high_risk = await db.scalar(
        select(func.count(IntentClassification.id)).where(IntentClassification.risk_score >= 0.7)
    )
    by_category = await db.execute(
        select(IntentClassification.intent_category, func.count(IntentClassification.id))
        .group_by(IntentClassification.intent_category)
    )
    unresolved = await db.scalar(
        select(func.count(IntentClassification.id)).where(IntentClassification.resolved.is_(False))
    )
    return {
        "total_classifications": total or 0,
        "high_risk_count": high_risk or 0,
        "unresolved": unresolved or 0,
        "by_category": {row[0]: row[1] for row in by_category.all()},
    }


@router.get("/recent")
async def get_recent_intents(
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    min_risk_score: float = Query(None, ge=0.0, le=1.0),
    camera_id: str = None,
    db: AsyncSession = Depends(get_db),
):
    stmt = select(IntentClassification).order_by(IntentClassification.created_at.desc())
    if min_risk_score is not None:
        stmt = stmt.where(IntentClassification.risk_score >= min_risk_score)
    if camera_id:
        stmt = stmt.where(IntentClassification.camera_id == camera_id)
    stmt = stmt.offset(offset).limit(limit)
    result = await db.execute(stmt)
    return result.scalars().all()


@router.get("/{classification_id}")
async def get_classification(classification_id: str, db: AsyncSession = Depends(get_db)):
    item = await db.get(IntentClassification, classification_id)
    if not item:
        raise HTTPException(404, "Intent classification not found")
    return item
