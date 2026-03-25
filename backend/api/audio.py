"""Audio Intelligence API — sound classification, threat detection, and event correlation."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select, func, desc
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.auth import get_current_user
from backend.database import async_session
from backend.models.advanced_models import AudioEvent

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/audio", tags=["audio"])

# Sound classification categories
SOUND_CATEGORIES = [
    "glass_breaking", "shouting_aggression", "gunshot", "alarm_siren",
    "vehicle_horn", "door_slam", "explosion", "running_footsteps",
    "metal_impact", "scream", "dog_barking", "vehicle_crash", "normal_ambient",
]

SEVERITY_ORDER = {"critical": 4, "high": 3, "medium": 2, "low": 1, "none": 0}


def _fmt_event(e: AudioEvent) -> dict:
    return {
        "id": str(e.id),
        "camera_id": str(e.camera_id),
        "classification": e.sound_type,
        "confidence": e.confidence,
        "severity": e.severity,
        "description": e.gemini_analysis or "",
        "timestamp": e.timestamp.isoformat() if e.timestamp else None,
        "duration_seconds": e.duration_seconds,
        "status": "new",
        "correlated_event_id": str(e.correlated_event_id) if e.correlated_event_id else None,
    }


# ── 1. Dashboard stats ──────────────────────────────────────

@router.get("/stats")
async def audio_stats(_user=Depends(get_current_user)):
    """Get audio intelligence statistics."""
    async with async_session() as session:
        now = datetime.now(timezone.utc)
        hour_ago = now - timedelta(hours=1)

        total = (await session.execute(select(func.count(AudioEvent.id)))).scalar() or 0
        last_hour = (await session.execute(
            select(func.count(AudioEvent.id)).where(AudioEvent.timestamp >= hour_ago)
        )).scalar() or 0
        critical_high = (await session.execute(
            select(func.count(AudioEvent.id)).where(
                AudioEvent.severity.in_(["critical", "high"]),
                AudioEvent.timestamp >= hour_ago,
            )
        )).scalar() or 0

        # Classification accuracy: average confidence across all audio events
        avg_conf = (await session.execute(
            select(func.avg(AudioEvent.confidence)).where(AudioEvent.confidence > 0)
        )).scalar()
        classification_accuracy = round(float(avg_conf), 2) if avg_conf else 0.0

        # False positive rate: proportion of low-confidence detections (< 0.5)
        low_conf = (await session.execute(
            select(func.count(AudioEvent.id)).where(AudioEvent.confidence < 0.5)
        )).scalar() or 0
        false_positive_rate = round(low_conf / max(total, 1), 2)

        return {
            "total_events": total,
            "events_last_hour": last_hour,
            "active_alerts": critical_high,
            "classification_accuracy": classification_accuracy,
            "false_positive_rate": false_positive_rate,
        }


# ── 2. Audio events list ────────────────────────────────────

@router.get("/events")
async def list_audio_events(
    limit: int = Query(50, ge=1, le=500),
    severity: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    camera_id: Optional[str] = Query(None),
    _user=Depends(get_current_user),
):
    """Get recent audio events with optional filters."""
    async with async_session() as session:
        query = select(AudioEvent)
        if severity:
            query = query.where(AudioEvent.severity == severity)
        if category:
            query = query.where(AudioEvent.sound_type == category)
        if camera_id:
            query = query.where(AudioEvent.camera_id == uuid.UUID(camera_id))
        query = query.order_by(desc(AudioEvent.timestamp)).limit(limit)
        result = await session.execute(query)
        return [_fmt_event(e) for e in result.scalars().all()]


# ── 3. Audio event timeline ─────────────────────────────────

@router.get("/timeline")
async def audio_timeline(
    hours: int = Query(24, ge=1, le=168),
    _user=Depends(get_current_user),
):
    """Get audio events over time for charting."""
    async with async_session() as session:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
        result = await session.execute(
            select(AudioEvent).where(AudioEvent.timestamp >= cutoff).order_by(AudioEvent.timestamp)
        )
        events = result.scalars().all()

        by_hour: Dict[str, Dict[str, int]] = {}
        for ev in events:
            if ev.timestamp:
                hour_key = ev.timestamp.strftime("%Y-%m-%dT%H")
                if hour_key not in by_hour:
                    by_hour[hour_key] = {"total": 0, "threats": 0}
                by_hour[hour_key]["total"] += 1
                if ev.severity in ("critical", "high"):
                    by_hour[hour_key]["threats"] += 1

        return {
            "timeline": [
                {"hour": k, "total": v["total"], "threats": v["threats"]}
                for k, v in sorted(by_hour.items())
            ],
            "range_hours": hours,
        }


# ── 4. Audio categories ─────────────────────────────────────

@router.get("/categories")
async def get_categories(_user=Depends(get_current_user)):
    """Get available audio classification categories with counts."""
    async with async_session() as session:
        total_q = await session.execute(select(func.count(AudioEvent.id)))
        total = max(total_q.scalar() or 1, 1)

        result = []
        for cat_name in SOUND_CATEGORIES:
            count_q = await session.execute(
                select(func.count(AudioEvent.id)).where(AudioEvent.sound_type == cat_name)
            )
            count = count_q.scalar() or 0
            result.append({
                "category": cat_name,
                "count": count,
                "percentage": round(count / total * 100, 1),
            })
        return result
