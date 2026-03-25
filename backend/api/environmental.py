"""Environmental Safety API — smoke, fire, flooding, and hazard monitoring."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func, desc
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.auth import get_current_user
from backend.database import async_session
from backend.models.models import Event, Alert, AlertSeverity, AlertStatus

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/environmental", tags=["environmental"])


# ── Hazard type configuration ────────────────────────────────

HAZARD_TYPES = {
    "smoke": {"label": "Smoke Detection", "icon": "cloud", "color": "gray", "critical_threshold": 6},
    "fire_flame": {"label": "Fire/Flame", "icon": "flame", "color": "red", "critical_threshold": 4},
    "electrical_sparking": {"label": "Electrical Sparking", "icon": "zap", "color": "yellow", "critical_threshold": 5},
    "water_flooding": {"label": "Water/Flooding", "icon": "droplets", "color": "blue", "critical_threshold": 5},
    "gas_fog": {"label": "Gas/Fog", "icon": "wind", "color": "purple", "critical_threshold": 5},
    "structural_damage": {"label": "Structural Damage", "icon": "building", "color": "orange", "critical_threshold": 4},
    "chemical_spill": {"label": "Chemical Spill", "icon": "flask", "color": "green", "critical_threshold": 4},
    "unusual_lighting": {"label": "Unusual Lighting", "icon": "lightbulb", "color": "amber", "critical_threshold": 7},
}

ENV_EVENT_TYPES = list(HAZARD_TYPES.keys())


def _is_env_event(event: Event) -> bool:
    return event.event_type in ENV_EVENT_TYPES or (
        event.event_type == "environmental_hazard"
    )


def _fmt_event(e: Event) -> dict:
    analysis = e.gemini_analysis or {}
    hazard = analysis.get("hazard_details", {})
    return {
        "id": str(e.id),
        "hazard_type": hazard.get("hazard_type", e.event_type),
        "severity": SEVERITY_MAP.get(e.severity.value if e.severity else "info", 3),
        "confidence": e.confidence,
        "camera_id": str(e.camera_id),
        "camera_name": "",
        "description": e.description or hazard.get("description", ""),
        "recommended_action": hazard.get("recommended_action", ""),
        "status": "new",
        "created_at": e.timestamp.isoformat() if e.timestamp else None,
        "acknowledged_at": None,
        "resolved_at": None,
    }


SEVERITY_MAP = {
    "critical": 5,
    "high": 4,
    "medium": 3,
    "low": 2,
    "info": 1,
}


# ── 1. Dashboard ────────────────────────────────────────────

@router.get("/stats")
async def environmental_stats(_user=Depends(get_current_user)):
    """Get environmental monitoring statistics."""
    async with async_session() as session:
        # Count environmental events
        all_types = ENV_EVENT_TYPES + ["environmental_hazard"]
        total = (await session.execute(
            select(func.count(Event.id)).where(Event.event_type.in_(all_types))
        )).scalar() or 0

        cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
        active = (await session.execute(
            select(func.count(Event.id)).where(
                Event.event_type.in_(all_types),
                Event.timestamp >= cutoff,
            )
        )).scalar() or 0

        # Resolved: alerts for environmental events that have been resolved
        resolved = (await session.execute(
            select(func.count(Alert.id)).where(
                Alert.status == AlertStatus.RESOLVED,
                Alert.threat_type.in_(all_types),
            )
        )).scalar() or 0

        # Average severity from actual events
        sev_rows = (await session.execute(
            select(Event.severity, func.count(Event.id)).where(
                Event.event_type.in_(all_types)
            ).group_by(Event.severity)
        )).all()
        if sev_rows:
            total_weighted = sum(SEVERITY_MAP.get(row[0].value if row[0] else "info", 1) * row[1] for row in sev_rows)
            total_count = sum(row[1] for row in sev_rows)
            avg_severity = round(total_weighted / total_count, 1) if total_count else 0.0
        else:
            avg_severity = 0.0

        # Cameras monitored: distinct cameras that have produced environmental events
        cameras_monitored = (await session.execute(
            select(func.count(func.distinct(Event.camera_id))).where(
                Event.event_type.in_(all_types)
            )
        )).scalar() or 0

        return {
            "total_events": total,
            "active_hazards": active,
            "resolved": resolved,
            "avg_severity": avg_severity,
            "cameras_monitored": cameras_monitored,
        }


# ── 2. Hazard events ────────────────────────────────────────

@router.get("/events")
async def list_hazard_events(
    limit: int = Query(50, ge=1, le=500),
    hazard_type: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    min_severity: int = Query(0, ge=0, le=10),
    _user=Depends(get_current_user),
):
    """Get hazard events with filters."""
    async with async_session() as session:
        all_types = ENV_EVENT_TYPES + ["environmental_hazard"]
        query = select(Event).where(Event.event_type.in_(all_types))

        if hazard_type:
            query = query.where(Event.event_type == hazard_type)

        query = query.order_by(desc(Event.timestamp)).limit(limit)
        result = await session.execute(query)
        events = result.scalars().all()
        return [_fmt_event(e) for e in events]


# ── 3. Acknowledge/resolve ──────────────────────────────────

@router.post("/events/{event_id}/acknowledge")
async def acknowledge_hazard(event_id: str, _user=Depends(get_current_user)):
    """Acknowledge a hazard event."""
    async with async_session() as session:
        result = await session.execute(
            select(Alert).where(Alert.event_id == uuid.UUID(event_id))
        )
        alert = result.scalar_one_or_none()
        if alert:
            alert.status = AlertStatus.ACKNOWLEDGED
            alert.acknowledged_at = datetime.now(timezone.utc)
            await session.commit()
            return {"status": "acknowledged", "event_id": event_id}
        raise HTTPException(status_code=404, detail="Event not found")


@router.post("/events/{event_id}/resolve")
async def resolve_hazard(event_id: str, _user=Depends(get_current_user)):
    """Resolve a hazard event."""
    async with async_session() as session:
        result = await session.execute(
            select(Alert).where(Alert.event_id == uuid.UUID(event_id))
        )
        alert = result.scalar_one_or_none()
        if alert:
            alert.status = AlertStatus.RESOLVED
            alert.resolved_at = datetime.now(timezone.utc)
            await session.commit()
            return {"status": "resolved", "event_id": event_id}
        raise HTTPException(status_code=404, detail="Event not found")


# ── 4. Hazard type configuration ────────────────────────────

@router.get("/types")
async def get_hazard_types(_user=Depends(get_current_user)):
    """Get configured hazard types with event counts."""
    async with async_session() as session:
        result = []
        for type_key, config in HAZARD_TYPES.items():
            count = (await session.execute(
                select(func.count(Event.id)).where(Event.event_type == type_key)
            )).scalar() or 0
            result.append({
                "type": type_key,
                "label": config["label"],
                "icon": config["icon"],
                "color": config["color"],
                "count": count,
            })
        return result
