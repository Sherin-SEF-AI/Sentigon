"""Operation Mode API — switch between Autonomous and HITL modes."""

from __future__ import annotations

import logging
import uuid
from typing import Optional

from typing import List
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from backend.api.auth import get_current_user, require_role
from backend.models.models import UserRole
from backend.services.operation_mode import operation_mode_service, PERFORMANCE_MODES
from backend.services.pending_action_service import pending_action_service
from backend.services.context_profiles import context_profile_service, ENVIRONMENT_PROFILES

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/operation-mode", tags=["operation-mode"])


# ── Request / Response schemas ────────────────────────────────

class ModeUpdate(BaseModel):
    mode: str = Field(..., pattern="^(autonomous|hitl)$")


class TimeoutUpdate(BaseModel):
    timeout: int = Field(..., ge=60, le=3600, description="Auto-approve timeout in seconds (1-60 min)")


class ActionApproval(BaseModel):
    notes: Optional[str] = None
    modified_args: Optional[dict] = None


class ActionRejection(BaseModel):
    notes: Optional[str] = None


class BulkActionRequest(BaseModel):
    action: str = Field(..., pattern="^(approve|reject)$", description="approve or reject")
    ids: List[uuid.UUID] = Field(..., description="List of action UUIDs to process")
    notes: Optional[str] = None


class PerformanceModeUpdate(BaseModel):
    mode: str = Field(..., description="Performance mode: ultra_fast, low_latency, standard, advanced")


class AIProviderUpdate(BaseModel):
    provider: str = Field(..., pattern="^(auto|gemini|groq|ollama|openai)$", description="AI provider: auto, gemini, groq, ollama, openai")


class ContextProfileUpdate(BaseModel):
    profile: Optional[str] = Field(None, description="Environment profile name (null to clear)")


class ScheduleEntry(BaseModel):
    name: str = Field(..., description="Schedule entry name")
    days: List[str] = Field(default_factory=list, description="Days of week: mon,tue,wed,thu,fri,sat,sun")
    start_hour: int = Field(..., ge=0, le=23, description="Start hour (0-23)")
    end_hour: int = Field(..., ge=0, le=23, description="End hour (0-23)")
    mode: Optional[str] = Field(None, pattern="^(autonomous|hitl)$")
    performance: Optional[str] = None
    context_profile: Optional[str] = None


class ScheduleUpdate(BaseModel):
    entries: List[ScheduleEntry] = Field(..., description="List of schedule entries")


# ── Mode endpoints ────────────────────────────────────────────

@router.get("")
async def get_operation_mode(_user=Depends(get_current_user)):
    """Get current operation mode, timeout, and pending action count."""
    return await operation_mode_service.get_status()


@router.put("")
async def set_operation_mode(
    body: ModeUpdate,
    user=Depends(require_role(UserRole.ADMIN)),
):
    """Switch between autonomous and HITL mode (Admin only).

    Switching to autonomous auto-approves all pending actions.
    """
    previous = await operation_mode_service.set_mode(body.mode, user_id=user.id)

    result = {
        "previous_mode": previous,
        "current_mode": body.mode,
        "auto_approved": 0,
    }

    # When switching to autonomous, auto-approve all pending actions
    if body.mode == "autonomous" and previous == "hitl":
        count = await pending_action_service.approve_all(user.id)
        result["auto_approved"] = count

    return result


@router.put("/timeout")
async def set_auto_approve_timeout(
    body: TimeoutUpdate,
    user=Depends(require_role(UserRole.ADMIN)),
):
    """Set the auto-approve timeout in seconds (Admin only)."""
    await operation_mode_service.set_auto_approve_timeout(body.timeout, user_id=user.id)
    return {"timeout": body.timeout}


# ── Performance mode endpoints ───────────────────────────────

@router.get("/performance")
async def get_performance_mode(_user=Depends(get_current_user)):
    """Get current performance mode and all available modes."""
    current = await operation_mode_service.get_performance_mode()
    return {
        "mode": current,
        "modes": PERFORMANCE_MODES,
    }


@router.put("/performance")
async def set_performance_mode(
    body: PerformanceModeUpdate,
    user=Depends(require_role(UserRole.ADMIN)),
):
    """Set the performance mode (Admin only)."""
    if body.mode not in PERFORMANCE_MODES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid mode '{body.mode}'. Valid: {list(PERFORMANCE_MODES.keys())}",
        )
    previous = await operation_mode_service.set_performance_mode(body.mode, user_id=user.id)
    return {
        "previous_mode": previous,
        "current_mode": body.mode,
        "config": PERFORMANCE_MODES[body.mode],
    }


# ── AI Provider endpoints ────────────────────────────────────

@router.get("/ai-provider")
async def get_ai_provider(_user=Depends(get_current_user)):
    """Get current AI provider and available providers."""
    current = await operation_mode_service.get_ai_provider()
    return {
        "provider": current,
        "providers": ["auto", "gemini", "groq", "ollama", "openai"],
    }


@router.put("/ai-provider")
async def set_ai_provider(
    body: AIProviderUpdate,
    user=Depends(require_role(UserRole.ADMIN)),
):
    """Set the AI provider preference (Admin only)."""
    previous = await operation_mode_service.set_ai_provider(body.provider, user_id=user.id)
    return {
        "previous_provider": previous,
        "current_provider": body.provider,
    }


# ── Pending action endpoints ─────────────────────────────────

@router.get("/pending-actions")
async def list_pending_actions(
    severity: Optional[str] = None,
    limit: int = 50,
    _user=Depends(get_current_user),
):
    """List pending actions awaiting approval."""
    return await pending_action_service.get_pending(limit=limit, severity=severity)


@router.get("/pending-actions/count")
async def pending_action_count(_user=Depends(get_current_user)):
    """Get the number of pending actions."""
    return {"count": await pending_action_service.get_pending_count()}


@router.get("/pending-actions/history")
async def pending_action_history(
    status: Optional[str] = None,
    limit: int = 100,
    _user=Depends(get_current_user),
):
    """Get all actions (including resolved) for history view."""
    return await pending_action_service.get_all_actions(limit=limit, status=status)


@router.post("/pending-actions/{action_id}/approve")
async def approve_action(
    action_id: uuid.UUID,
    body: ActionApproval = ActionApproval(),
    user=Depends(require_role(UserRole.OPERATOR)),
):
    """Approve a pending action (Operator+)."""
    result = await pending_action_service.approve(
        action_id=action_id,
        user_id=user.id,
        notes=body.notes,
        modified_args=body.modified_args,
    )
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@router.post("/pending-actions/{action_id}/reject")
async def reject_action(
    action_id: uuid.UUID,
    body: ActionRejection = ActionRejection(),
    user=Depends(require_role(UserRole.OPERATOR)),
):
    """Reject a pending action (Operator+)."""
    success = await pending_action_service.reject(
        action_id=action_id,
        user_id=user.id,
        notes=body.notes,
    )
    if not success:
        raise HTTPException(status_code=404, detail="Action not found or already resolved")
    return {"status": "rejected", "action_id": str(action_id)}


@router.post("/pending-actions/bulk")
async def bulk_action_on_pending(
    body: BulkActionRequest,
    user=Depends(require_role(UserRole.OPERATOR)),
):
    """Bulk approve or reject a selected list of pending actions (Operator+)."""
    if not body.ids:
        raise HTTPException(status_code=400, detail="No action IDs provided")
    result = await pending_action_service.bulk_action(
        action_ids=body.ids,
        action=body.action,
        user_id=user.id,
        notes=body.notes,
    )
    return result


@router.post("/pending-actions/approve-all")
async def approve_all_actions(
    user=Depends(require_role(UserRole.ADMIN)),
):
    """Bulk approve all pending actions (Admin only)."""
    count = await pending_action_service.approve_all(user.id)
    return {"approved": count}


# ── Context Profile endpoints ───────────────────────────────

@router.get("/context-profiles")
async def get_context_profiles(_user=Depends(get_current_user)):
    """Get all available environment context profiles."""
    return {
        "profiles": context_profile_service.get_all_profiles(),
        "active_profile": context_profile_service.active_profile_name,
    }


@router.get("/context-profile")
async def get_context_profile(_user=Depends(get_current_user)):
    """Get the currently active context profile."""
    return context_profile_service.get_status()


@router.put("/context-profile")
async def set_context_profile(
    body: ContextProfileUpdate,
    user=Depends(require_role(UserRole.ADMIN)),
):
    """Set the active environment context profile (Admin only).

    Pass null/None for profile to clear the active profile.
    """
    try:
        previous = context_profile_service.set_active_profile(body.profile)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {
        "previous_profile": previous,
        "current_profile": body.profile,
        "profile_info": context_profile_service.get_profile_info(body.profile) if body.profile else None,
    }


# ── Adaptive Schedule endpoints ─────────────────────────────

@router.get("/schedule")
async def get_schedule(_user=Depends(get_current_user)):
    """Get the adaptive time schedule entries."""
    entries = await operation_mode_service.get_schedule()
    return {"entries": entries}


@router.put("/schedule")
async def set_schedule(
    body: ScheduleUpdate,
    user=Depends(require_role(UserRole.ADMIN)),
):
    """Set adaptive time schedule entries (Admin only).

    Each entry defines a time window with optional mode, performance,
    and context profile overrides.
    """
    entries = [e.model_dump(exclude_none=True) for e in body.entries]
    result = await operation_mode_service.set_schedule(entries, user_id=user.id)
    return {"entries": result}
