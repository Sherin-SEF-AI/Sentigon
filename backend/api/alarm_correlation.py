"""Phase 3B: Alarm Correlation API — multi-sensor correlation and fatigue tracking."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
from backend.models.phase3_models import AlarmCorrelationEvent, AlarmFatigueMetric
from backend.services.alarm_correlation_engine import alarm_correlation_engine

router = APIRouter(prefix="/api/alarm-correlation", tags=["alarm-correlation"])


@router.post("/correlate")
async def correlate_alarm(data: dict, db: AsyncSession = Depends(get_db)):
    try:
        result = await alarm_correlation_engine.correlate_alarm(
            db,
            source_type=data.get("source_type", "camera"),
            source_id=data.get("source_id"),
            event_data=data.get("event_data", {}),
            camera_id=data.get("camera_id"),
            zone_id=data.get("zone_id"),
        )
        return result
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/stats")
async def correlation_stats(db: AsyncSession = Depends(get_db)):
    try:
        stats = await alarm_correlation_engine.get_correlation_stats(db)
        return stats
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/fatigue")
async def alarm_fatigue(
    operator_id: str = None,
    db: AsyncSession = Depends(get_db),
):
    stmt = select(AlarmFatigueMetric).order_by(AlarmFatigueMetric.created_at.desc())
    if operator_id:
        stmt = stmt.where(AlarmFatigueMetric.operator_id == operator_id)
    stmt = stmt.limit(50)
    result = await db.execute(stmt)
    return result.scalars().all()


@router.get("/events")
async def list_correlation_events(
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    classification: str = None,
    db: AsyncSession = Depends(get_db),
):
    stmt = select(AlarmCorrelationEvent).order_by(AlarmCorrelationEvent.created_at.desc())
    if classification:
        stmt = stmt.where(AlarmCorrelationEvent.classification == classification)
    stmt = stmt.offset(offset).limit(limit)
    result = await db.execute(stmt)
    total = await db.scalar(select(func.count(AlarmCorrelationEvent.id)))
    return {"total": total or 0, "items": result.scalars().all()}


@router.get("/events/{event_id}")
async def get_correlation_event(event_id: str, db: AsyncSession = Depends(get_db)):
    event = await db.get(AlarmCorrelationEvent, event_id)
    if not event:
        raise HTTPException(404, "Correlation event not found")
    return event


# ── Alarm Management: Suppression & Escalation Rules ─────────
# Stored in-memory for now; production would use DB

_suppression_rules: list[dict] = []
_escalation_rules: list[dict] = []


@router.get("/suppression-rules", tags=["alarm-management"])
async def list_suppression_rules():
    return {"rules": _suppression_rules}


@router.post("/suppression-rules", tags=["alarm-management"])
async def create_suppression_rule(data: dict):
    import uuid
    rule = {"id": str(uuid.uuid4()), **data}
    _suppression_rules.append(rule)
    return rule


@router.get("/escalation-rules", tags=["alarm-management"])
async def list_escalation_rules():
    return {"rules": _escalation_rules}


@router.post("/escalation-rules", tags=["alarm-management"])
async def create_escalation_rule(data: dict):
    import uuid
    rule = {"id": str(uuid.uuid4()), **data}
    _escalation_rules.append(rule)
    return rule
