"""Emergency Dispatch — resource management, AI recommendations, and intelligence briefs."""
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
from backend.models.phase2_models import DispatchResource

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/dispatch", tags=["dispatch"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class DispatchResourceCreate(BaseModel):
    resource_type: str = Field(..., description="police, fire, ems, security")
    name: str = Field(..., min_length=1, max_length=200)
    status: str = Field("available", description="available, dispatched, en_route, on_scene")
    current_location: dict = Field(default_factory=dict)
    eta_minutes: Optional[int] = None


class DispatchResourceResponse(BaseModel):
    id: str
    resource_type: str
    name: str
    status: str
    current_location: dict
    eta_minutes: Optional[int] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class DispatchRecommendRequest(BaseModel):
    alert_id: str = Field(..., description="Alert ID to recommend dispatch for")
    threat_type: str = Field(..., description="Type of threat")
    severity: str = Field("medium", description="critical, high, medium, low")


class StatusUpdateRequest(BaseModel):
    status: str = Field(..., description="available, dispatched, en_route, on_scene")


class IntelligenceBriefResponse(BaseModel):
    alert_id: str
    brief: dict
    generated_at: str


# ── Helpers ───────────────────────────────────────────────────────────────────

VALID_STATUSES = {"available", "dispatched", "en_route", "on_scene"}

RESOURCE_RECOMMENDATIONS = {
    "critical": {"police": 2, "ems": 1, "fire": 1, "security": 2},
    "high": {"police": 1, "security": 2},
    "medium": {"security": 1},
    "low": {"security": 1},
}


def _fmt_resource(r: DispatchResource) -> dict:
    return {
        "id": str(r.id),
        "resource_type": r.resource_type,
        "name": r.name,
        "status": r.status or "available",
        "current_location": r.current_location or {},
        "eta_minutes": r.eta_minutes,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/resources", response_model=List[dict])
async def list_dispatch_resources(
    status: Optional[str] = Query(None, description="Filter: available, dispatched, en_route, on_scene"),
    _user=Depends(get_current_user),
):
    """List dispatch resources with optional status filter."""
    try:
        async with async_session() as session:
            stmt = select(DispatchResource).order_by(desc(DispatchResource.updated_at))

            if status:
                stmt = stmt.where(DispatchResource.status == status)

            result = await session.execute(stmt)
            return [_fmt_resource(r) for r in result.scalars().all()]
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to list dispatch resources")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/resources", response_model=dict, status_code=201)
async def create_resource(
    body: DispatchResourceCreate,
    _user=Depends(require_role(UserRole.ADMIN)),
):
    """Create a dispatch resource (admin only)."""
    try:
        async with async_session() as session:
            resource = DispatchResource(
                resource_type=body.resource_type,
                name=body.name,
                status=body.status,
                current_location=body.current_location,
                eta_minutes=body.eta_minutes,
            )
            session.add(resource)
            await session.commit()
            await session.refresh(resource)
            return _fmt_resource(resource)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to create dispatch resource")
        raise HTTPException(status_code=500, detail=str(exc))


@router.put("/resources/{resource_id}/status", response_model=dict)
async def update_resource_status(
    resource_id: uuid.UUID,
    body: StatusUpdateRequest,
    _user=Depends(require_role(UserRole.OPERATOR)),
):
    """Update a dispatch resource's status."""
    if body.status not in VALID_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid status. Must be one of: {', '.join(sorted(VALID_STATUSES))}",
        )
    try:
        async with async_session() as session:
            result = await session.execute(
                select(DispatchResource).where(DispatchResource.id == resource_id)
            )
            resource = result.scalar_one_or_none()
            if not resource:
                raise HTTPException(status_code=404, detail="Dispatch resource not found")

            resource.status = body.status
            resource.updated_at = datetime.now(timezone.utc)
            await session.commit()
            await session.refresh(resource)
            return _fmt_resource(resource)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to update resource status")
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/recommend", response_model=dict)
async def recommend_dispatch(
    body: DispatchRecommendRequest,
    _user=Depends(require_role(UserRole.OPERATOR)),
):
    """Recommend dispatch resources based on threat_type and severity.

    Returns matching available resources suitable for the incident.
    """
    try:
        async with async_session() as session:
            # Get available resources
            available_result = await session.execute(
                select(DispatchResource).where(DispatchResource.status == "available")
            )
            available_resources = available_result.scalars().all()

            # Rule-based recommendation
            needed = RESOURCE_RECOMMENDATIONS.get(body.severity, {"security": 1})

            recommended = []
            reasoning_parts = []

            for rtype, count_needed in needed.items():
                matching = [r for r in available_resources if r.resource_type == rtype]
                selected = matching[:count_needed]
                for r in selected:
                    recommended.append({
                        "resource_id": str(r.id),
                        "resource_type": r.resource_type,
                        "name": r.name,
                        "current_location": r.current_location or {},
                        "eta_minutes": r.eta_minutes,
                    })
                reasoning_parts.append(
                    f"{count_needed} {rtype} unit(s) recommended ({len(selected)} available)"
                )

            eta_estimates = [r.eta_minutes for r in available_resources if r.eta_minutes]
            estimated_time = min(eta_estimates) if eta_estimates else None

            reasoning = (
                f"Threat: {body.threat_type}, severity: {body.severity}. "
                + "; ".join(reasoning_parts) + "."
            )

            return {
                "alert_id": body.alert_id,
                "threat_type": body.threat_type,
                "severity": body.severity,
                "recommended_resources": recommended,
                "reasoning": reasoning,
                "estimated_response_time_minutes": estimated_time,
            }
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to generate dispatch recommendation")
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/intelligence-brief/{alert_id}", response_model=dict)
async def get_intelligence_brief(
    alert_id: uuid.UUID,
    _user=Depends(get_current_user),
):
    """Generate intelligence brief for an alert — fetch alert + recent events from same zone."""
    try:
        from backend.models.models import Alert
        from backend.models.phase2_models import AccessEvent

        async with async_session() as session:
            # Get the alert
            alert_result = await session.execute(
                select(Alert).where(Alert.id == alert_id)
            )
            alert = alert_result.scalar_one_or_none()
            if not alert:
                raise HTTPException(status_code=404, detail="Alert not found")

            brief = {
                "alert_id": str(alert.id),
                "title": getattr(alert, "title", None),
                "severity": alert.severity.value if hasattr(alert.severity, "value") else str(alert.severity),
                "threat_type": getattr(alert, "threat_type", None),
                "zone": getattr(alert, "zone_name", None),
                "camera": str(alert.source_camera) if getattr(alert, "source_camera", None) else None,
                "created_at": alert.created_at.isoformat() if alert.created_at else None,
            }

            # Recent access events near alert time
            if alert.created_at:
                window_start = alert.created_at - timedelta(minutes=30)
                window_end = alert.created_at + timedelta(minutes=30)
                ts_col = getattr(AccessEvent, "created_at", None) or getattr(AccessEvent, "timestamp", None)

                access_result = await session.execute(
                    select(AccessEvent)
                    .where(ts_col >= window_start, ts_col <= window_end)
                    .limit(20)
                )
                brief["nearby_events"] = [
                    {
                        "event_type": e.event_type,
                        "door_id": e.door_id,
                        "user_identifier": e.user_identifier,
                    }
                    for e in access_result.scalars().all()
                ]

            # Available resources
            resource_result = await session.execute(
                select(DispatchResource).where(DispatchResource.status == "available")
            )
            brief["available_resources"] = [
                {"type": r.resource_type, "name": r.name, "eta": r.eta_minutes}
                for r in resource_result.scalars().all()
            ]

            return {
                "alert_id": str(alert_id),
                "brief": brief,
                "generated_at": datetime.now(timezone.utc).isoformat(),
            }
    except HTTPException:
        raise
    except ImportError as ie:
        logger.warning("Import error generating intelligence brief: %s", ie)
        return {
            "alert_id": str(alert_id),
            "brief": {"error": "Some models not available for full brief generation"},
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as exc:
        logger.exception("Failed to generate intelligence brief for alert %s", alert_id)
        raise HTTPException(status_code=500, detail=str(exc))
