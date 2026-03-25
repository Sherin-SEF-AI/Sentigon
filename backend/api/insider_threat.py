"""Insider Threat API — behavioral analysis profiles and anomaly detection."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.auth import get_current_user, require_role
from backend.database import get_db, async_session
from backend.models.models import UserRole
from backend.models.phase2_models import InsiderThreatProfile, AccessEvent

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/insider-threat", tags=["insider-threat"])


# ── Schemas ───────────────────────────────────────────────────

class InsiderThreatProfileResponse(BaseModel):
    id: str
    user_id: Optional[str]
    risk_score: float
    baseline_access_pattern: dict
    anomaly_count: int
    behavioral_flags: list
    status: str
    created_at: Optional[str]
    updated_at: Optional[str]


class AnomalyResponse(BaseModel):
    profile_id: str
    user_id: Optional[str]
    anomaly_type: str
    description: str
    risk_score: float
    timestamp: Optional[str]


class BaselineBuildRequest(BaseModel):
    lookback_days: int = Field(30, ge=7, le=90, description="Days of history to analyze for baseline")


class BaselineBuildResponse(BaseModel):
    user_id: str
    profile_id: str
    baseline_access_pattern: dict
    status: str
    message: str


# ── Helpers ───────────────────────────────────────────────────

def _fmt_profile(p: InsiderThreatProfile) -> dict:
    return {
        "id": str(p.id),
        "user_id": str(p.user_id) if p.user_id else None,
        "risk_score": p.risk_score or 0.0,
        "baseline_access_pattern": p.baseline_access_pattern or {},
        "anomaly_count": p.anomaly_count or 0,
        "behavioral_flags": p.behavioral_flags or [],
        "status": p.status or "monitoring",
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }


# ── Endpoints ─────────────────────────────────────────────────

@router.get("/profiles", response_model=List[dict])
async def list_insider_threat_profiles(
    status: Optional[str] = Query(None, description="Filter: monitoring, flagged, cleared"),
    min_risk_score: Optional[float] = Query(None, ge=0.0, le=1.0),
    limit: int = Query(50, ge=1, le=200),
    _user=Depends(get_current_user),
):
    """List insider threat profiles with optional filters."""
    try:
        async with async_session() as session:
            stmt = select(InsiderThreatProfile).order_by(
                desc(InsiderThreatProfile.risk_score)
            ).limit(limit)

            if status:
                stmt = stmt.where(InsiderThreatProfile.status == status)
            if min_risk_score is not None:
                stmt = stmt.where(InsiderThreatProfile.risk_score >= min_risk_score)

            result = await session.execute(stmt)
            return [_fmt_profile(p) for p in result.scalars().all()]
    except Exception as e:
        logger.error(f"Error listing insider threat profiles: {e}")
        raise HTTPException(status_code=500, detail="Failed to list insider threat profiles")


@router.get("/profiles/{profile_id}", response_model=dict)
async def get_insider_threat_profile(
    profile_id: uuid.UUID,
    _user=Depends(get_current_user),
):
    """Get detailed insider threat profile."""
    try:
        async with async_session() as session:
            result = await session.execute(
                select(InsiderThreatProfile).where(InsiderThreatProfile.id == profile_id)
            )
            profile = result.scalar_one_or_none()
            if not profile:
                raise HTTPException(status_code=404, detail="Insider threat profile not found")

            data = _fmt_profile(profile)

            # Enrich with recent access events if user_id is available
            if profile.user_id:
                cutoff = datetime.now(timezone.utc) - timedelta(hours=48)
                events_result = await session.execute(
                    select(AccessEvent)
                    .where(
                        AccessEvent.user_identifier == str(profile.user_id),
                        AccessEvent.timestamp >= cutoff,
                    )
                    .order_by(desc(AccessEvent.timestamp))
                    .limit(20)
                )
                events = events_result.scalars().all()
                data["recent_access_events"] = [
                    {
                        "id": str(e.id),
                        "door_id": e.door_id,
                        "event_type": e.event_type,
                        "timestamp": e.timestamp.isoformat() if e.timestamp else None,
                    }
                    for e in events
                ]
            else:
                data["recent_access_events"] = []

            return data
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching insider threat profile {profile_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch insider threat profile")


@router.get("/anomalies", response_model=List[dict])
async def list_recent_anomalies(
    hours: int = Query(24, ge=1, le=168),
    limit: int = Query(50, ge=1, le=200),
    _user=Depends(get_current_user),
):
    """List recent behavioral anomalies from insider threat profiles."""
    try:
        async with async_session() as session:
            cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)

            # Get profiles with recent anomalies (flagged or with high risk)
            result = await session.execute(
                select(InsiderThreatProfile)
                .where(
                    InsiderThreatProfile.updated_at >= cutoff,
                    InsiderThreatProfile.anomaly_count > 0,
                )
                .order_by(desc(InsiderThreatProfile.risk_score))
                .limit(limit)
            )
            profiles = result.scalars().all()

            anomalies = []
            for p in profiles:
                for flag in (p.behavioral_flags or []):
                    if isinstance(flag, dict):
                        anomalies.append({
                            "profile_id": str(p.id),
                            "user_id": str(p.user_id) if p.user_id else None,
                            "anomaly_type": flag.get("type", "unknown"),
                            "description": flag.get("description", "Behavioral anomaly detected"),
                            "risk_score": p.risk_score or 0.0,
                            "timestamp": flag.get("timestamp", p.updated_at.isoformat() if p.updated_at else None),
                        })
                    else:
                        anomalies.append({
                            "profile_id": str(p.id),
                            "user_id": str(p.user_id) if p.user_id else None,
                            "anomaly_type": "behavioral_flag",
                            "description": str(flag),
                            "risk_score": p.risk_score or 0.0,
                            "timestamp": p.updated_at.isoformat() if p.updated_at else None,
                        })

            # Sort by risk_score descending
            anomalies.sort(key=lambda x: x["risk_score"], reverse=True)
            return anomalies[:limit]
    except Exception as e:
        logger.error(f"Error listing anomalies: {e}")
        raise HTTPException(status_code=500, detail="Failed to list anomalies")


@router.post("/baseline/{user_id}", response_model=dict)
async def build_user_baseline(
    user_id: uuid.UUID,
    body: BaselineBuildRequest,
    _user=Depends(require_role(UserRole.ANALYST)),
):
    """Build or rebuild behavioral baseline for a specific user from access event history."""
    try:
        async with async_session() as session:
            cutoff = datetime.now(timezone.utc) - timedelta(days=body.lookback_days)

            # Gather access events for baseline
            events_result = await session.execute(
                select(AccessEvent)
                .where(
                    AccessEvent.user_identifier == str(user_id),
                    AccessEvent.timestamp >= cutoff,
                )
                .order_by(AccessEvent.timestamp)
            )
            events = events_result.scalars().all()

            # Compute baseline access pattern
            door_frequency: dict = {}
            hour_frequency: dict = {}
            event_type_counts: dict = {}
            for e in events:
                if e.door_id:
                    door_frequency[e.door_id] = door_frequency.get(e.door_id, 0) + 1
                if e.timestamp:
                    hour = str(e.timestamp.hour)
                    hour_frequency[hour] = hour_frequency.get(hour, 0) + 1
                event_type_counts[e.event_type] = event_type_counts.get(e.event_type, 0) + 1

            baseline = {
                "total_events": len(events),
                "lookback_days": body.lookback_days,
                "door_frequency": door_frequency,
                "hour_frequency": hour_frequency,
                "event_type_counts": event_type_counts,
                "computed_at": datetime.now(timezone.utc).isoformat(),
            }

            # Find or create insider threat profile
            profile_result = await session.execute(
                select(InsiderThreatProfile).where(
                    InsiderThreatProfile.user_id == user_id
                )
            )
            profile = profile_result.scalar_one_or_none()

            if profile:
                profile.baseline_access_pattern = baseline
                profile.updated_at = datetime.now(timezone.utc)
            else:
                profile = InsiderThreatProfile(
                    user_id=user_id,
                    risk_score=0.0,
                    baseline_access_pattern=baseline,
                    anomaly_count=0,
                    behavioral_flags=[],
                    status="monitoring",
                )
                session.add(profile)

            await session.commit()
            await session.refresh(profile)

            return {
                "user_id": str(user_id),
                "profile_id": str(profile.id),
                "baseline_access_pattern": baseline,
                "status": profile.status,
                "message": f"Baseline built from {len(events)} events over {body.lookback_days} days",
            }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error building baseline for user {user_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to build user baseline")
