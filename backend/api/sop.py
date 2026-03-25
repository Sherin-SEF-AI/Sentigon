"""Standard Operating Procedures — templates, instances, and workflow management."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, desc

from backend.api.auth import get_current_user, require_role
from backend.database import async_session
from backend.models.models import UserRole
from backend.models.phase2_models import SOPTemplate, SOPInstance

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/sop", tags=["sop"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class SOPTemplateCreate(BaseModel):
    threat_type: str = Field(..., min_length=1, max_length=100)
    severity: str = Field(..., description="critical, high, medium, low")
    name: str = Field(..., min_length=1, max_length=200)
    workflow_stages: list = Field(
        ...,
        min_length=1,
        description="Ordered list of workflow stages",
    )
    auto_trigger: bool = False


class SOPAdvanceRequest(BaseModel):
    notes: Optional[str] = None


class SOPTemplateResponse(BaseModel):
    id: str
    threat_type: str
    severity: str
    name: str
    workflow_stages: list
    auto_trigger: bool
    is_active: bool
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class SOPInstanceResponse(BaseModel):
    id: str
    template_id: str
    template_name: Optional[str] = None
    alert_id: Optional[str] = None
    current_stage: int
    current_stage_name: Optional[str] = None
    total_stages: int = 0
    stage_history: list
    status: str
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _fmt_template(t: SOPTemplate) -> dict:
    return {
        "id": str(t.id),
        "threat_type": t.threat_type,
        "severity": t.severity,
        "name": t.name,
        "workflow_stages": t.workflow_stages or [],
        "auto_trigger": t.auto_trigger,
        "is_active": t.is_active,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "updated_at": t.updated_at.isoformat() if t.updated_at else None,
    }


def _fmt_instance(inst: SOPInstance, template: Optional[SOPTemplate] = None) -> dict:
    stages = template.workflow_stages if template else []
    current_stage_name = None
    if stages and 0 <= inst.current_stage < len(stages):
        stage = stages[inst.current_stage]
        current_stage_name = stage.get("name") if isinstance(stage, dict) else str(stage)

    return {
        "id": str(inst.id),
        "template_id": str(inst.template_id),
        "template_name": template.name if template else None,
        "alert_id": str(inst.alert_id) if inst.alert_id else None,
        "current_stage": inst.current_stage,
        "current_stage_name": current_stage_name,
        "total_stages": len(stages),
        "stage_history": inst.stage_history or [],
        "status": inst.status or "active",
        "created_at": inst.created_at.isoformat() if inst.created_at else None,
        "updated_at": inst.updated_at.isoformat() if inst.updated_at else None,
    }


# ── Endpoints — Templates ────────────────────────────────────────────────────

@router.get("/templates", response_model=List[dict])
async def list_sop_templates(
    active_only: bool = Query(True),
    _user=Depends(get_current_user),
):
    """List SOP templates."""
    try:
        async with async_session() as session:
            stmt = select(SOPTemplate).order_by(desc(SOPTemplate.created_at))

            if active_only:
                stmt = stmt.where(SOPTemplate.is_active == True)

            result = await session.execute(stmt)
            return [_fmt_template(t) for t in result.scalars().all()]
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to list SOP templates")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/templates", response_model=dict, status_code=201)
async def create_sop_template(
    body: SOPTemplateCreate,
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Create a new SOP template (admin only)."""
    try:
        async with async_session() as session:
            template = SOPTemplate(
                threat_type=body.threat_type,
                severity=body.severity,
                name=body.name,
                workflow_stages=body.workflow_stages,
                auto_trigger=body.auto_trigger,
                is_active=True,
            )
            session.add(template)
            await session.commit()
            await session.refresh(template)
            return _fmt_template(template)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to create SOP template")
        raise HTTPException(status_code=500, detail=str(exc))


# ── Endpoints — Instances ─────────────────────────────────────────────────────

@router.get("/instances", response_model=List[dict])
async def list_sop_instances(
    status: Optional[str] = Query(None, description="Filter: active, completed, aborted"),
    limit: int = Query(50, ge=1, le=200),
    _user=Depends(get_current_user),
):
    """List SOP instances."""
    try:
        async with async_session() as session:
            stmt = select(SOPInstance).order_by(desc(SOPInstance.created_at)).limit(limit)

            if status:
                stmt = stmt.where(SOPInstance.status == status)

            result = await session.execute(stmt)
            instances = result.scalars().all()

            # Batch-fetch related templates
            template_ids = list({inst.template_id for inst in instances})
            templates_map: dict = {}
            if template_ids:
                tmpl_result = await session.execute(
                    select(SOPTemplate).where(SOPTemplate.id.in_(template_ids))
                )
                for t in tmpl_result.scalars().all():
                    templates_map[t.id] = t

            return [
                _fmt_instance(inst, templates_map.get(inst.template_id))
                for inst in instances
            ]
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to list SOP instances")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/instances/{template_id}/activate", response_model=dict, status_code=201)
async def activate_sop_instance(
    template_id: uuid.UUID,
    user=Depends(require_role(UserRole.OPERATOR)),
):
    """Create a new SOPInstance from a template."""
    try:
        async with async_session() as session:
            # Validate template exists
            tmpl_result = await session.execute(
                select(SOPTemplate).where(SOPTemplate.id == template_id)
            )
            template = tmpl_result.scalar_one_or_none()
            if not template:
                raise HTTPException(status_code=404, detail="SOP template not found")
            if not template.is_active:
                raise HTTPException(status_code=409, detail="SOP template is not active")

            instance = SOPInstance(
                template_id=template.id,
                current_stage=0,
                stage_history=[
                    {
                        "stage": 0,
                        "action": "started",
                        "operator_id": str(user.id),
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    }
                ],
                status="active",
            )
            session.add(instance)
            await session.commit()
            await session.refresh(instance)
            return _fmt_instance(instance, template)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to activate SOP instance")
        raise HTTPException(status_code=500, detail=str(exc))


@router.put("/instances/{instance_id}/advance", response_model=dict)
async def advance_sop_instance(
    instance_id: uuid.UUID,
    body: SOPAdvanceRequest,
    user=Depends(require_role(UserRole.OPERATOR)),
):
    """Advance an SOP instance to the next workflow stage."""
    try:
        async with async_session() as session:
            result = await session.execute(
                select(SOPInstance).where(SOPInstance.id == instance_id)
            )
            instance = result.scalar_one_or_none()
            if not instance:
                raise HTTPException(status_code=404, detail="SOP instance not found")
            if instance.status != "active":
                raise HTTPException(status_code=409, detail="SOP instance is not active")

            # Get template to check total stages
            tmpl_result = await session.execute(
                select(SOPTemplate).where(SOPTemplate.id == instance.template_id)
            )
            template = tmpl_result.scalar_one_or_none()
            total_stages = len(template.workflow_stages) if template else 0

            next_stage = instance.current_stage + 1

            # Record stage transition in stage_history JSONB
            history = list(instance.stage_history or [])
            history.append({
                "stage": next_stage,
                "action": "advanced",
                "operator_id": str(user.id),
                "notes": body.notes,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
            instance.stage_history = history
            instance.current_stage = next_stage
            instance.updated_at = datetime.now(timezone.utc)

            # Auto-complete if last stage reached
            if total_stages > 0 and next_stage >= total_stages:
                instance.status = "completed"
                history.append({
                    "stage": next_stage,
                    "action": "completed",
                    "operator_id": str(user.id),
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                })
                instance.stage_history = history

            await session.commit()
            await session.refresh(instance)
            return _fmt_instance(instance, template)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to advance SOP instance %s", instance_id)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/instances/{instance_id}/abort", response_model=dict)
async def abort_sop_instance(
    instance_id: uuid.UUID,
    user=Depends(require_role(UserRole.OPERATOR)),
):
    """Abort an active SOP instance — set status to 'aborted'."""
    try:
        async with async_session() as session:
            result = await session.execute(
                select(SOPInstance).where(SOPInstance.id == instance_id)
            )
            instance = result.scalar_one_or_none()
            if not instance:
                raise HTTPException(status_code=404, detail="SOP instance not found")
            if instance.status != "active":
                raise HTTPException(status_code=409, detail="SOP instance is not active")

            history = list(instance.stage_history or [])
            history.append({
                "stage": instance.current_stage,
                "action": "aborted",
                "operator_id": str(user.id),
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
            instance.stage_history = history
            instance.status = "aborted"
            instance.updated_at = datetime.now(timezone.utc)

            await session.commit()
            await session.refresh(instance)

            # Fetch template for response
            tmpl_result = await session.execute(
                select(SOPTemplate).where(SOPTemplate.id == instance.template_id)
            )
            template = tmpl_result.scalar_one_or_none()

            return _fmt_instance(instance, template)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to abort SOP instance %s", instance_id)
        raise HTTPException(status_code=500, detail=str(exc))
