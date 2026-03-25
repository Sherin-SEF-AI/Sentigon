"""PPE Compliance API — safety equipment monitoring for industrial zones."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func, desc

from backend.api.auth import get_current_user
from backend.database import async_session
from backend.models.advanced_models import PPEComplianceEvent

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/compliance", tags=["compliance"])


def _fmt(e: PPEComplianceEvent) -> dict:
    return {
        "id": str(e.id),
        "camera_id": str(e.camera_id),
        "zone_id": str(e.zone_id) if e.zone_id else None,
        "timestamp": e.timestamp.isoformat() if e.timestamp else None,
        "required_ppe": e.required_ppe,
        "detected_ppe": e.detected_ppe,
        "missing_ppe": e.missing_ppe,
        "compliance_status": e.compliance_status,
    }


@router.get("/ppe/stats")
async def ppe_stats(
    zone_id: Optional[str] = Query(None),
    hours: int = Query(24, ge=1, le=168),
    _user=Depends(get_current_user),
):
    """Get PPE compliance statistics."""
    async with async_session() as session:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
        query = select(PPEComplianceEvent).where(PPEComplianceEvent.timestamp >= cutoff)
        if zone_id:
            query = query.where(PPEComplianceEvent.zone_id == uuid.UUID(zone_id))

        result = await session.execute(query)
        events = result.scalars().all()

        total = len(events)
        compliant = sum(1 for e in events if e.compliance_status == "compliant")
        non_compliant = sum(1 for e in events if e.compliance_status == "non_compliant")
        partial = sum(1 for e in events if e.compliance_status == "partially_compliant")

        return {
            "total_checks": total,
            "compliant": compliant,
            "non_compliant": non_compliant,
            "partially_compliant": partial,
            "compliance_rate": round(compliant / max(total, 1) * 100, 1),
            "period_hours": hours,
        }


@router.get("/ppe")
async def ppe_events(
    zone_id: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
    _user=Depends(get_current_user),
):
    """Get PPE compliance events."""
    async with async_session() as session:
        query = select(PPEComplianceEvent)
        if zone_id:
            query = query.where(PPEComplianceEvent.zone_id == uuid.UUID(zone_id))
        if status:
            query = query.where(PPEComplianceEvent.compliance_status == status)
        query = query.order_by(desc(PPEComplianceEvent.timestamp)).limit(limit)
        result = await session.execute(query)
        return [_fmt(e) for e in result.scalars().all()]


@router.post("/ppe/{event_id}/acknowledge")
async def acknowledge_ppe_event(
    event_id: str,
    _user=Depends(get_current_user),
):
    """Acknowledge a PPE compliance event."""
    async with async_session() as session:
        result = await session.execute(
            select(PPEComplianceEvent).where(PPEComplianceEvent.id == uuid.UUID(event_id))
        )
        event = result.scalar_one_or_none()
        if not event:
            raise HTTPException(status_code=404, detail="PPE event not found")
        event.compliance_status = "acknowledged"
        await session.commit()
        return {"status": "acknowledged", "id": str(event.id)}
