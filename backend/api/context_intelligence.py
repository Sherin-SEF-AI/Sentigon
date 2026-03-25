"""Phase 3A: Context Intelligence API — context rules and manual evaluation."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
from backend.models.phase3_models import ContextRule
from backend.services.context_fusion_engine import context_fusion_engine

router = APIRouter(prefix="/api/context", tags=["context-intelligence"])


@router.get("/rules")
async def list_context_rules(
    zone_type: str = None,
    is_active: bool = None,
    db: AsyncSession = Depends(get_db),
):
    stmt = select(ContextRule)
    if zone_type:
        stmt = stmt.where(ContextRule.zone_type == zone_type)
    if is_active is not None:
        stmt = stmt.where(ContextRule.is_active == is_active)
    result = await db.execute(stmt.order_by(ContextRule.zone_type, ContextRule.object_class))
    return [row._asdict() if hasattr(row, "_asdict") else row for row in result.scalars().all()]


@router.post("/rules")
async def create_context_rule(data: dict, db: AsyncSession = Depends(get_db)):
    try:
        rule = ContextRule(**data)
        db.add(rule)
        await db.flush()
        await db.refresh(rule)
        return rule
    except Exception as e:
        raise HTTPException(400, str(e))


@router.put("/rules/{rule_id}")
async def update_context_rule(rule_id: str, data: dict, db: AsyncSession = Depends(get_db)):
    rule = await db.get(ContextRule, rule_id)
    if not rule:
        raise HTTPException(404, "Context rule not found")
    for key, value in data.items():
        if hasattr(rule, key):
            setattr(rule, key, value)
    await db.flush()
    await db.refresh(rule)
    return rule


@router.delete("/rules/{rule_id}")
async def delete_context_rule(rule_id: str, db: AsyncSession = Depends(get_db)):
    rule = await db.get(ContextRule, rule_id)
    if not rule:
        raise HTTPException(404, "Context rule not found")
    await db.delete(rule)
    return {"deleted": True}


@router.post("/evaluate")
async def evaluate_context(data: dict, db: AsyncSession = Depends(get_db)):
    try:
        result = await context_fusion_engine.evaluate_context(
            db,
            camera_id=data.get("camera_id"),
            zone_id=data.get("zone_id"),
            detections=data.get("detections", []),
            threats=data.get("threats", []),
        )
        return result
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/stats")
async def context_stats(db: AsyncSession = Depends(get_db)):
    total = await db.scalar(select(func.count(ContextRule.id)))
    active = await db.scalar(select(func.count(ContextRule.id)).where(ContextRule.is_active.is_(True)))
    zone_types = await db.execute(
        select(ContextRule.zone_type, func.count(ContextRule.id))
        .group_by(ContextRule.zone_type)
    )
    return {
        "total_rules": total or 0,
        "active_rules": active or 0,
        "rules_by_zone_type": {row[0]: row[1] for row in zone_types.all()},
    }
