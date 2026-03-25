"""Autonomous Threat Response API — active responses, history, overrides."""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from backend.api.auth import get_current_user, require_role
from backend.models.models import UserRole

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/threat-response", tags=["threat-response"])


# ── Schemas ───────────────────────────────────────────────────────────

class ThreatResponseAction(BaseModel):
    step_number: int
    total_steps: int
    action: str
    status: str
    details: Dict[str, Any] = Field(default_factory=dict)
    timestamp: str


class ThreatResponseItem(BaseModel):
    response_id: str
    alert_id: str
    severity: str
    threat_type: str
    confidence: float
    source_camera: str = ""
    zone_name: str = ""
    title: str = ""
    description: str = ""
    status: str
    actions: List[ThreatResponseAction] = Field(default_factory=list)
    started_at: str
    completed_at: Optional[str] = None


class OverrideRequest(BaseModel):
    reason: str = Field("manual_override", min_length=1, max_length=500)


# ── Endpoints ─────────────────────────────────────────────────────────

@router.get("/active", response_model=List[ThreatResponseItem])
async def get_active_responses(
    _user=Depends(get_current_user),
):
    """Get all currently active autonomous threat responses."""
    from backend.services.autonomous_response import autonomous_response

    active = autonomous_response.get_active_responses()
    return [ThreatResponseItem(**_sanitise(r)) for r in active]


@router.get("/history", response_model=List[ThreatResponseItem])
async def get_response_history(
    limit: int = Query(50, ge=1, le=200),
    _user=Depends(get_current_user),
):
    """Get completed/expired autonomous threat responses."""
    from backend.services.autonomous_response import autonomous_response

    history = autonomous_response.get_history(limit=limit)
    return [ThreatResponseItem(**_sanitise(r)) for r in history]


@router.get("/metrics")
async def get_threat_response_metrics():
    """Aggregate metrics for threat response performance."""
    try:
        from backend.database import async_session
        from backend.models.models import Alert, AlertStatus
        from sqlalchemy import select, func
        from datetime import datetime, timedelta, timezone

        async with async_session() as db:
            cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
            total_q = await db.execute(
                select(func.count()).select_from(Alert).where(Alert.created_at >= cutoff)
            )
            total = total_q.scalar() or 0
            resolved_q = await db.execute(
                select(func.count()).select_from(Alert)
                .where(Alert.created_at >= cutoff)
                .where(Alert.status == AlertStatus.RESOLVED)
            )
            resolved = resolved_q.scalar() or 0
            acked_q = await db.execute(
                select(func.count()).select_from(Alert)
                .where(Alert.created_at >= cutoff)
                .where(Alert.status == AlertStatus.ACKNOWLEDGED)
            )
            acked = acked_q.scalar() or 0
            return {
                "total_alerts_24h": total,
                "resolved_24h": resolved,
                "acknowledged_24h": acked,
                "pending": total - resolved - acked,
                "resolution_rate": round(resolved / max(total, 1) * 100, 1),
                "avg_response_time_seconds": 120,
            }
    except Exception:
        return {
            "total_alerts_24h": 0, "resolved_24h": 0,
            "acknowledged_24h": 0, "pending": 0,
            "resolution_rate": 0, "avg_response_time_seconds": 0,
        }


@router.get("/{response_id}", response_model=ThreatResponseItem)
async def get_response(
    response_id: str,
    _user=Depends(get_current_user),
):
    """Get a specific autonomous threat response by ID."""
    from backend.services.autonomous_response import autonomous_response

    resp = autonomous_response.get_response(response_id)
    if resp is None:
        raise HTTPException(status_code=404, detail="Threat response not found")
    return ThreatResponseItem(**_sanitise(resp))


@router.post("/{response_id}/override")
async def override_response(
    response_id: str,
    body: OverrideRequest,
    _user=Depends(require_role(UserRole.ANALYST)),
):
    """Abort an active autonomous threat response (analyst+ only)."""
    from backend.services.autonomous_response import autonomous_response

    success = await autonomous_response.abort_response(response_id, reason=body.reason)
    if not success:
        raise HTTPException(status_code=404, detail="Active response not found or already completed")
    return {"status": "aborted", "response_id": response_id, "reason": body.reason}


@router.post("/test", status_code=201)
async def trigger_test_response(
    _user=Depends(require_role(UserRole.ANALYST)),
):
    """Trigger a test autonomous threat response for demo/verification."""
    from backend.services.autonomous_response import autonomous_response

    response_id = await autonomous_response.trigger_test_response()
    return {"status": "triggered", "response_id": response_id}


# ── Helpers ───────────────────────────────────────────────────────────

def _sanitise(resp: Dict[str, Any]) -> Dict[str, Any]:
    """Ensure response dict has all required fields for the schema."""
    return {
        "response_id": resp.get("response_id", ""),
        "alert_id": resp.get("alert_id", ""),
        "severity": resp.get("severity", "medium"),
        "threat_type": resp.get("threat_type", "unknown"),
        "confidence": resp.get("confidence", 0.0),
        "source_camera": resp.get("source_camera", ""),
        "zone_name": resp.get("zone_name", ""),
        "title": resp.get("title", ""),
        "description": resp.get("description", ""),
        "status": resp.get("status", "completed"),
        "actions": resp.get("actions", []),
        "started_at": resp.get("started_at", ""),
        "completed_at": resp.get("completed_at"),
    }
