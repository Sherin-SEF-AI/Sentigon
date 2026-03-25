"""Insider Threat Analyzer — baseline building, anomaly detection, risk profiling."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import func, select, update

logger = logging.getLogger(__name__)


class InsiderThreatAnalyzer:
    """Analyse access-event history to detect insider threat indicators.

    The service builds per-user behavioural baselines (typical hours,
    doors, frequency) and scores new access events against the baseline
    to surface anomalies.
    """

    # ── Baseline building ────────────────────────────────────────

    async def build_baseline(
        self,
        user_id: uuid.UUID,
        lookback_days: int = 30,
    ) -> Dict[str, Any]:
        """Analyse a user's AccessEvent history to compute a behavioural baseline.

        The baseline captures:
        * ``typical_hours`` — set of hours (0-23) in which >5 % of accesses occur.
        * ``typical_doors`` — set of door IDs comprising >= 90 % of accesses.
        * ``avg_daily_events`` — average number of access events per day.
        * ``event_type_distribution`` — relative frequency of each event type.

        The computed baseline is persisted to InsiderThreatProfile.

        Args:
            user_id: UUID of the user to baseline.
            lookback_days: Number of past days to consider.

        Returns:
            The baseline dict.
        """
        try:
            from backend.database import async_session
            from backend.models.phase2_models import AccessEvent, InsiderThreatProfile

            cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)

            async with async_session() as session:
                stmt = (
                    select(AccessEvent)
                    .where(AccessEvent.user_identifier == str(user_id))
                    .where(AccessEvent.timestamp >= cutoff)
                    .order_by(AccessEvent.timestamp)
                )
                result = await session.execute(stmt)
                events = result.scalars().all()

                if not events:
                    logger.info("No access events found for user %s in last %d days", user_id, lookback_days)
                    return {"user_id": str(user_id), "baseline": {}, "event_count": 0}

                # Hour distribution
                hour_counts: Dict[int, int] = {}
                door_counts: Dict[str, int] = {}
                type_counts: Dict[str, int] = {}
                total = len(events)

                for ev in events:
                    h = ev.timestamp.hour if ev.timestamp else 0
                    hour_counts[h] = hour_counts.get(h, 0) + 1
                    if ev.door_id:
                        door_counts[ev.door_id] = door_counts.get(ev.door_id, 0) + 1
                    etype = ev.event_type or "unknown"
                    type_counts[etype] = type_counts.get(etype, 0) + 1

                # Typical hours: hours with >= 5% of traffic
                threshold = total * 0.05
                typical_hours = sorted([h for h, c in hour_counts.items() if c >= threshold])

                # Typical doors: doors covering 90% of events (sorted desc by count)
                sorted_doors = sorted(door_counts.items(), key=lambda x: x[1], reverse=True)
                cumulative = 0
                typical_doors: List[str] = []
                for door_id, cnt in sorted_doors:
                    typical_doors.append(door_id)
                    cumulative += cnt
                    if cumulative >= total * 0.90:
                        break

                # Average daily events
                first_ts = events[0].timestamp
                last_ts = events[-1].timestamp
                span_days = max((last_ts - first_ts).days, 1)
                avg_daily = total / span_days

                # Event type distribution (normalised)
                type_dist = {k: round(v / total, 3) for k, v in type_counts.items()}

                baseline = {
                    "typical_hours": typical_hours,
                    "typical_doors": typical_doors,
                    "avg_daily_events": round(avg_daily, 2),
                    "event_type_distribution": type_dist,
                    "total_events_analysed": total,
                    "lookback_days": lookback_days,
                    "computed_at": datetime.now(timezone.utc).isoformat(),
                }

                # Upsert InsiderThreatProfile
                profile_stmt = select(InsiderThreatProfile).where(
                    InsiderThreatProfile.user_id == user_id
                )
                profile_result = await session.execute(profile_stmt)
                profile = profile_result.scalar_one_or_none()

                if profile:
                    profile.baseline_access_pattern = baseline
                    profile.updated_at = datetime.now(timezone.utc)
                else:
                    profile = InsiderThreatProfile(
                        user_id=user_id,
                        baseline_access_pattern=baseline,
                        risk_score=0.0,
                        anomaly_count=0,
                        behavioral_flags=[],
                        status="monitoring",
                    )
                    session.add(profile)

                await session.commit()
                logger.info(
                    "Baseline built for user %s: %d events, %d typical hours, %d typical doors",
                    user_id, total, len(typical_hours), len(typical_doors),
                )
                return {"user_id": str(user_id), "baseline": baseline, "event_count": total}

        except Exception as exc:
            logger.error("Failed to build baseline for user %s: %s", user_id, exc, exc_info=True)
            raise

    # ── Anomaly check ────────────────────────────────────────────

    async def check_anomaly(
        self,
        user_id: uuid.UUID,
        access_event: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Compare a single access event against the user's baseline.

        Deviation factors scored (each 0-1, then averaged):
        * **hour_deviation** — 1.0 if the access hour is outside typical hours.
        * **door_deviation** — 1.0 if the door is not in the typical set.
        * **type_deviation** — 1.0 if the event type was never seen in baseline.

        The overall ``deviation_score`` (0.0 - 1.0) is the mean of the
        individual factors.  A score >= 0.6 is flagged as anomalous.

        Returns:
            Dict with ``deviation_score``, factor breakdown, and ``is_anomaly``.
        """
        try:
            from backend.database import async_session
            from backend.models.phase2_models import InsiderThreatProfile

            async with async_session() as session:
                stmt = select(InsiderThreatProfile).where(
                    InsiderThreatProfile.user_id == user_id
                )
                result = await session.execute(stmt)
                profile = result.scalar_one_or_none()

                if not profile or not profile.baseline_access_pattern:
                    logger.info("No baseline for user %s — cannot score anomaly", user_id)
                    return {
                        "user_id": str(user_id),
                        "deviation_score": 0.0,
                        "is_anomaly": False,
                        "reason": "no_baseline",
                    }

                baseline = profile.baseline_access_pattern
                typical_hours = set(baseline.get("typical_hours", []))
                typical_doors = set(baseline.get("typical_doors", []))
                type_dist = baseline.get("event_type_distribution", {})

                # Score each factor
                event_hour = access_event.get("hour")
                if event_hour is None and access_event.get("timestamp"):
                    try:
                        ts = datetime.fromisoformat(access_event["timestamp"])
                        event_hour = ts.hour
                    except (ValueError, TypeError):
                        event_hour = None

                hour_deviation = 0.0
                if event_hour is not None and typical_hours:
                    hour_deviation = 0.0 if event_hour in typical_hours else 1.0

                door_id = access_event.get("door_id", "")
                door_deviation = 0.0
                if door_id and typical_doors:
                    door_deviation = 0.0 if door_id in typical_doors else 1.0

                event_type = access_event.get("event_type", "")
                type_deviation = 0.0
                if event_type and type_dist:
                    type_deviation = 0.0 if event_type in type_dist else 1.0

                deviation_score = round(
                    (hour_deviation + door_deviation + type_deviation) / 3.0, 3
                )
                is_anomaly = deviation_score >= 0.6

                # Update anomaly count if anomalous
                if is_anomaly:
                    profile.anomaly_count = (profile.anomaly_count or 0) + 1
                    profile.risk_score = min(
                        1.0,
                        (profile.risk_score or 0.0) + deviation_score * 0.1,
                    )
                    profile.updated_at = datetime.now(timezone.utc)
                    await session.commit()

                logger.info(
                    "Anomaly check user=%s score=%.3f anomaly=%s (h=%.1f d=%.1f t=%.1f)",
                    user_id, deviation_score, is_anomaly,
                    hour_deviation, door_deviation, type_deviation,
                )
                return {
                    "user_id": str(user_id),
                    "deviation_score": deviation_score,
                    "is_anomaly": is_anomaly,
                    "factors": {
                        "hour_deviation": hour_deviation,
                        "door_deviation": door_deviation,
                        "type_deviation": type_deviation,
                    },
                    "event": access_event,
                }

        except Exception as exc:
            logger.error("Failed anomaly check for user %s: %s", user_id, exc, exc_info=True)
            return {
                "user_id": str(user_id),
                "deviation_score": 0.0,
                "is_anomaly": False,
                "error": str(exc),
            }

    # ── Risk profile ─────────────────────────────────────────────

    async def get_risk_profile(self, user_id: uuid.UUID) -> Dict[str, Any]:
        """Return the InsiderThreatProfile for a user.

        Returns:
            Dict with risk_score, anomaly_count, baseline info, status, and flags.
        """
        try:
            from backend.database import async_session
            from backend.models.phase2_models import InsiderThreatProfile

            async with async_session() as session:
                stmt = select(InsiderThreatProfile).where(
                    InsiderThreatProfile.user_id == user_id
                )
                result = await session.execute(stmt)
                profile = result.scalar_one_or_none()

                if not profile:
                    return {
                        "user_id": str(user_id),
                        "risk_score": 0.0,
                        "anomaly_count": 0,
                        "status": "no_profile",
                        "behavioral_flags": [],
                        "baseline_access_pattern": {},
                    }

                return {
                    "id": str(profile.id),
                    "user_id": str(profile.user_id),
                    "risk_score": profile.risk_score,
                    "anomaly_count": profile.anomaly_count,
                    "status": profile.status,
                    "behavioral_flags": profile.behavioral_flags or [],
                    "baseline_access_pattern": profile.baseline_access_pattern or {},
                    "created_at": profile.created_at.isoformat() if profile.created_at else None,
                    "updated_at": profile.updated_at.isoformat() if profile.updated_at else None,
                }
        except Exception as exc:
            logger.error("Failed to get risk profile for user %s: %s", user_id, exc, exc_info=True)
            return {"user_id": str(user_id), "risk_score": 0.0, "error": str(exc)}

    # ── Flag user ────────────────────────────────────────────────

    async def flag_user(
        self,
        user_id: uuid.UUID,
        flags: List[str],
    ) -> Dict[str, Any]:
        """Update a user's behavioural flags and set status to ``"flagged"``.

        Flags are *appended* to any existing flags (duplicates removed).

        Args:
            user_id: UUID of the user.
            flags: List of flag strings (e.g. ``["after_hours_access", "unusual_door"]``).

        Returns:
            Updated profile dict.
        """
        try:
            from backend.database import async_session
            from backend.models.phase2_models import InsiderThreatProfile

            async with async_session() as session:
                stmt = select(InsiderThreatProfile).where(
                    InsiderThreatProfile.user_id == user_id
                )
                result = await session.execute(stmt)
                profile = result.scalar_one_or_none()

                if not profile:
                    # Create a new profile in flagged state
                    profile = InsiderThreatProfile(
                        user_id=user_id,
                        risk_score=0.5,
                        anomaly_count=0,
                        behavioral_flags=flags,
                        status="flagged",
                        baseline_access_pattern={},
                    )
                    session.add(profile)
                else:
                    existing_flags = list(profile.behavioral_flags or [])
                    merged = list(dict.fromkeys(existing_flags + flags))  # preserve order, deduplicate
                    profile.behavioral_flags = merged
                    profile.status = "flagged"
                    profile.updated_at = datetime.now(timezone.utc)

                await session.commit()
                await session.refresh(profile)

                logger.info(
                    "User flagged: user=%s flags=%s status=%s",
                    user_id, profile.behavioral_flags, profile.status,
                )
                return {
                    "id": str(profile.id),
                    "user_id": str(profile.user_id),
                    "behavioral_flags": profile.behavioral_flags,
                    "status": profile.status,
                    "risk_score": profile.risk_score,
                }
        except Exception as exc:
            logger.error("Failed to flag user %s: %s", user_id, exc, exc_info=True)
            raise


# ── Singleton ────────────────────────────────────────────────────
insider_threat_analyzer = InsiderThreatAnalyzer()
