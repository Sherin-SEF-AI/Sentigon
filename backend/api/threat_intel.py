"""Threat Intelligence Feed API — external threat data ingestion."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.auth import get_current_user, require_role
from backend.database import async_session
from backend.models.models import UserRole
from backend.models.advanced_models import ThreatIntelEntry, VehicleWatchlist

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/threat-intel", tags=["threat-intel"])


class ThreatIntelWebhook(BaseModel):
    source: str
    alert_type: str
    details: dict
    severity: str = "medium"
    valid_until: Optional[str] = None


def _fmt(entry: ThreatIntelEntry) -> dict:
    return {
        "id": str(entry.id),
        "source": entry.source,
        "alert_type": entry.alert_type,
        "details": entry.details,
        "severity": entry.severity,
        "valid_until": entry.valid_until.isoformat() if entry.valid_until else None,
        "auto_actions_taken": entry.auto_actions_taken,
        "created_at": entry.created_at.isoformat() if entry.created_at else None,
    }


@router.post("/webhook")
async def ingest_webhook(body: ThreatIntelWebhook, _user=Depends(get_current_user)):
    """Process incoming threat intelligence webhook."""
    async with async_session() as session:
        valid_until = None
        if body.valid_until:
            try:
                valid_until = datetime.fromisoformat(body.valid_until)
            except ValueError:
                pass

        auto_actions = []

        # Auto-add vehicle plates to watchlist
        if body.alert_type == "bolo_vehicle" and body.details.get("plate"):
            plate = body.details["plate"].upper().strip()
            existing = (await session.execute(
                select(VehicleWatchlist).where(VehicleWatchlist.plate_text == plate)
            )).scalar_one_or_none()

            if not existing:
                wl_entry = VehicleWatchlist(
                    plate_text=plate,
                    reason=body.details.get("reason", f"Threat intel: {body.source}"),
                    severity=body.severity,
                    notes=f"Auto-added from threat intel source: {body.source}",
                    active=True,
                )
                session.add(wl_entry)
                auto_actions.append({"action": "watchlist_add", "plate": plate})

        entry = ThreatIntelEntry(
            source=body.source,
            alert_type=body.alert_type,
            details=body.details,
            severity=body.severity,
            valid_until=valid_until,
            auto_actions_taken=auto_actions if auto_actions else None,
        )
        session.add(entry)
        await session.commit()
        await session.refresh(entry)
        return _fmt(entry)


@router.get("/active")
async def get_active_intel(_user=Depends(get_current_user)):
    """Get all active (non-expired) threat intelligence entries."""
    async with async_session() as session:
        now = datetime.now(timezone.utc)
        result = await session.execute(
            select(ThreatIntelEntry)
            .where(
                (ThreatIntelEntry.valid_until == None) | (ThreatIntelEntry.valid_until > now)
            )
            .order_by(desc(ThreatIntelEntry.created_at))
        )
        return [_fmt(e) for e in result.scalars().all()]


# ── Feed Management ──────────────────────────────────────────


class FeedCreate(BaseModel):
    name: str
    feed_type: str = "webhook_incoming"
    url: Optional[str] = None
    api_key: Optional[str] = None
    poll_interval_seconds: int = 300
    transform_config: Optional[dict] = None
    default_severity: str = "medium"
    default_auto_actions: Optional[dict] = None
    is_active: bool = True


class FeedUpdate(BaseModel):
    name: Optional[str] = None
    feed_type: Optional[str] = None
    url: Optional[str] = None
    api_key: Optional[str] = None
    poll_interval_seconds: Optional[int] = None
    transform_config: Optional[dict] = None
    default_severity: Optional[str] = None
    default_auto_actions: Optional[dict] = None
    is_active: Optional[bool] = None


@router.get("/feeds")
async def list_feeds(_user=Depends(get_current_user)):
    """List all configured threat intel feeds."""
    from backend.services.threat_intel_service import threat_intel_service
    return await threat_intel_service.get_feeds()


@router.post("/feeds")
async def create_feed(body: FeedCreate, user=Depends(require_role(UserRole.ADMIN))):
    """Create a new threat intel feed configuration."""
    from backend.services.threat_intel_service import threat_intel_service
    return await threat_intel_service.create_feed(body.model_dump())


@router.put("/feeds/{feed_id}")
async def update_feed(feed_id: uuid.UUID, body: FeedUpdate, user=Depends(require_role(UserRole.ADMIN))):
    """Update a threat intel feed."""
    from backend.services.threat_intel_service import threat_intel_service
    data = {k: v for k, v in body.model_dump().items() if v is not None}
    result = await threat_intel_service.update_feed(str(feed_id), data)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@router.delete("/feeds/{feed_id}")
async def delete_feed(feed_id: uuid.UUID, user=Depends(require_role(UserRole.ADMIN))):
    """Delete a threat intel feed."""
    from backend.services.threat_intel_service import threat_intel_service
    if not await threat_intel_service.delete_feed(str(feed_id)):
        raise HTTPException(status_code=404, detail="Feed not found")
    return {"status": "deleted"}


# ── External Webhook Receiver ────────────────────────────────


@router.post("/webhook/{feed_id}")
async def receive_feed_webhook(feed_id: uuid.UUID, payload: dict):
    """Receive webhook from a specific feed (no auth — external sources)."""
    from backend.services.threat_intel_service import threat_intel_service
    result = await threat_intel_service.process_webhook(str(feed_id), payload)
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


# ── Context Endpoints ────────────────────────────────────────


@router.get("/context")
async def get_active_context(_user=Depends(get_current_user)):
    """Get current active threat context for operators."""
    from backend.services.threat_intel_service import threat_intel_service
    return await threat_intel_service.get_active_context()


@router.get("/context/agent-summary")
async def get_agent_summary(_user=Depends(get_current_user)):
    """Get natural language threat context summary for agents."""
    from backend.services.threat_intel_service import threat_intel_service
    summary = await threat_intel_service.get_contextual_summary()
    return {"summary": summary}


@router.get("/threshold-adjustments/{zone_id}")
async def get_threshold_adjustments(zone_id: uuid.UUID, _user=Depends(get_current_user)):
    """Get recommended threshold adjustments for a zone."""
    from backend.services.threat_intel_service import threat_intel_service
    adjustments = await threat_intel_service.compute_threshold_adjustments(str(zone_id))
    return {"zone_id": str(zone_id), "adjustments": adjustments}


# ── Structured Ingestion ─────────────────────────────────────


class PoliceAlertIngest(BaseModel):
    alert_type: str = "police_alert"
    severity: str = "high"
    description: str
    plate: Optional[str] = None
    suspect_description: Optional[str] = None
    location: Optional[str] = None
    source: str = "police_dispatch"
    impact_zones: Optional[list] = None


class WeatherIngest(BaseModel):
    warning_type: str
    severity: str = "medium"
    description: str
    duration_hours: int = 24
    impact_zones: Optional[list] = None
    threshold_adjustments: Optional[dict] = None


class EventCalendarIngest(BaseModel):
    event_name: str
    description: str
    start_time: str
    end_time: Optional[str] = None
    expected_crowd_size: Optional[int] = None
    location: Optional[str] = None
    impact_zones: Optional[list] = None
    threshold_adjustments: Optional[dict] = None


@router.post("/ingest/police-alert")
async def ingest_police_alert(body: PoliceAlertIngest, _user=Depends(get_current_user)):
    """Ingest a structured police alert."""
    from backend.services.threat_intel_service import threat_intel_service
    entry_data = {
        "intel_type": "police_alert",
        "alert_type": body.alert_type,
        "severity": body.severity,
        "details": {
            "description": body.description,
            "plate": body.plate,
            "suspect_description": body.suspect_description,
            "location": body.location,
        },
        "impact_zones": body.impact_zones,
    }
    return await threat_intel_service.ingest_entry(entry_data, source=body.source)


@router.post("/ingest/weather")
async def ingest_weather(body: WeatherIngest, _user=Depends(get_current_user)):
    """Ingest a weather warning."""
    from backend.services.threat_intel_service import threat_intel_service
    valid_until = (datetime.now(timezone.utc) + timedelta(hours=body.duration_hours)).isoformat()
    entry_data = {
        "intel_type": "weather_warning",
        "alert_type": body.warning_type,
        "severity": body.severity,
        "details": {"description": body.description, "warning_type": body.warning_type},
        "valid_until": valid_until,
        "impact_zones": body.impact_zones,
        "threshold_adjustments": body.threshold_adjustments,
    }
    return await threat_intel_service.ingest_entry(entry_data, source="weather_service")


@router.post("/ingest/event-calendar")
async def ingest_event(body: EventCalendarIngest, _user=Depends(get_current_user)):
    """Ingest a calendar event that may affect security operations."""
    from backend.services.threat_intel_service import threat_intel_service
    entry_data = {
        "intel_type": "event_calendar",
        "alert_type": "scheduled_event",
        "severity": "low",
        "details": {
            "description": body.description,
            "event_name": body.event_name,
            "start_time": body.start_time,
            "end_time": body.end_time,
            "expected_crowd_size": body.expected_crowd_size,
            "location": body.location,
        },
        "valid_until": body.end_time,
        "impact_zones": body.impact_zones,
        "threshold_adjustments": body.threshold_adjustments,
    }
    return await threat_intel_service.ingest_entry(entry_data, source="event_calendar")
