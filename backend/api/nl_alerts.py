"""Phase 3C: Natural Language Alert Rules API — NL-defined monitoring rules."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
from backend.models.phase3_models import NLAlertRule
from backend.services.nl_alert_rules_service import nl_alert_rules_service

router = APIRouter(prefix="/api/nl-alerts", tags=["nl-alert-rules"])


@router.post("/rules")
async def create_rule(data: dict, db: AsyncSession = Depends(get_db)):
    try:
        result = await nl_alert_rules_service.create_rule(
            db,
            natural_language=data.get("natural_language", ""),
            name=data.get("name"),
            severity=data.get("severity", "medium"),
        )
        return result
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/rules")
async def list_rules(
    is_active: bool = None,
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(NLAlertRule).order_by(NLAlertRule.created_at.desc())
    if is_active is not None:
        stmt = stmt.where(NLAlertRule.is_active == is_active)
    stmt = stmt.limit(limit)
    result = await db.execute(stmt)
    return result.scalars().all()


@router.get("/rules/stats")
async def rule_stats(db: AsyncSession = Depends(get_db)):
    total = await db.scalar(select(func.count(NLAlertRule.id)))
    active = await db.scalar(
        select(func.count(NLAlertRule.id)).where(NLAlertRule.is_active.is_(True))
    )
    total_triggers = await db.scalar(select(func.coalesce(func.sum(NLAlertRule.trigger_count), 0)))
    return {
        "total_rules": total or 0,
        "active_rules": active or 0,
        "total_triggers": total_triggers or 0,
    }


@router.put("/rules/{rule_id}")
async def update_rule(rule_id: str, data: dict, db: AsyncSession = Depends(get_db)):
    rule = await db.get(NLAlertRule, rule_id)
    if not rule:
        raise HTTPException(404, "NL alert rule not found")
    try:
        result = await nl_alert_rules_service.update_rule(db, rule_id=rule_id, updates=data)
        return result
    except Exception as e:
        raise HTTPException(400, str(e))


@router.delete("/rules/{rule_id}")
async def delete_rule(rule_id: str, db: AsyncSession = Depends(get_db)):
    rule = await db.get(NLAlertRule, rule_id)
    if not rule:
        raise HTTPException(404, "NL alert rule not found")
    await db.delete(rule)
    return {"deleted": True}


@router.get("/rules/{rule_id}")
async def get_rule(rule_id: str, db: AsyncSession = Depends(get_db)):
    rule = await db.get(NLAlertRule, rule_id)
    if not rule:
        raise HTTPException(404, "NL alert rule not found")
    return rule
