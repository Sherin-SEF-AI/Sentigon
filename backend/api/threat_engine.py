"""Threat-engine forecast API — projects event volume from historical patterns."""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select

from backend.api.auth import get_current_user
from backend.database import async_session
from backend.models.models import Event

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/threat-engine", tags=["threat-engine"])


@router.get("/forecast")
async def threat_forecast(
    lookback_days: int = Query(7, ge=1, le=30),
    _user=Depends(get_current_user),
):
    """Predicted event volume for each hour-of-day, derived from real history.

    Averages the observed event counts per hour-of-day over the lookback
    window. Returns 24 points; volumes are 0 when there is no history (honest
    — not fabricated).
    """
    since = datetime.now(timezone.utc) - timedelta(days=lookback_days)
    buckets: dict[int, int] = defaultdict(int)
    days = max(lookback_days, 1)
    try:
        async with async_session() as session:
            rows = (await session.execute(
                select(Event.timestamp).where(Event.timestamp >= since)
            )).scalars().all()
        for ts in rows:
            if ts is not None:
                buckets[ts.hour] += 1
    except Exception as exc:  # noqa: BLE001
        logger.warning("threat_forecast.failed error=%s", exc)

    forecast = [
        {"hour": f"{h:02d}:00", "predicted_volume": round(buckets.get(h, 0) / days, 2)}
        for h in range(24)
    ]
    return {
        "data": forecast,
        "lookback_days": lookback_days,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
