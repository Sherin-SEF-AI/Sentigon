"""Analytics aggregation engine — time-series, severity breakdowns, trends."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select, func, and_, extract
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import async_session
from backend.models import Alert, Camera, Event, Zone
from backend.models.models import AlertSeverity, AlertStatus, CameraStatus, CaseStatus

logger = logging.getLogger(__name__)


class AnalyticsEngine:
    """Service-layer analytics aggregation.

    Every public method opens its own ``async_session`` so callers do not
    need to manage database sessions.
    """

    # ── Events over time ─────────────────────────────────────

    async def events_over_time(
        self,
        hours: int = 24,
        bucket_minutes: int = 60,
        start: Optional[datetime] = None,
        end: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """Return a time-series of event counts bucketed by interval.

        Parameters
        ----------
        hours : int
            Look-back window when explicit *start*/*end* are not given.
        bucket_minutes : int
            Width of each time bucket (only "hour" truncation is used
            on the DB side for simplicity; finer bucketing can be added).
        start, end : datetime, optional
            Explicit time range.
        """
        range_start, range_end = self._resolve_range(hours, start, end)

        try:
            async with async_session() as session:
                result = await session.execute(
                    select(
                        func.date_trunc("hour", Event.timestamp).label("bucket"),
                        func.count(Event.id).label("count"),
                    )
                    .where(
                        and_(
                            Event.timestamp >= range_start,
                            Event.timestamp <= range_end,
                        )
                    )
                    .group_by("bucket")
                    .order_by("bucket")
                )
                rows = result.all()

                data = [
                    {
                        "timestamp": row.bucket.isoformat() if row.bucket else None,
                        "count": row.count,
                    }
                    for row in rows
                ]

                return {
                    "metric": "events_over_time",
                    "data": data,
                    "summary": {
                        "range_start": range_start.isoformat(),
                        "range_end": range_end.isoformat(),
                        "total_events": sum(d["count"] for d in data),
                        "buckets": len(data),
                    },
                }
        except Exception as exc:
            logger.error("events_over_time failed: %s", exc)
            return {"metric": "events_over_time", "data": [], "summary": {"error": str(exc)}}

    # ── Alerts by severity ───────────────────────────────────

    async def alerts_by_severity(
        self,
        include_resolved: bool = False,
    ) -> Dict[str, Any]:
        """Return alert count breakdown by severity level."""
        try:
            async with async_session() as session:
                stmt = select(
                    Alert.severity,
                    func.count(Alert.id).label("count"),
                )

                if not include_resolved:
                    stmt = stmt.where(
                        Alert.status.notin_([AlertStatus.RESOLVED, AlertStatus.DISMISSED])
                    )

                stmt = stmt.group_by(Alert.severity)
                result = await session.execute(stmt)
                rows = result.all()

                data: List[Dict[str, Any]] = []
                total = 0
                for row in rows:
                    count = row.count
                    total += count
                    data.append({
                        "severity": row.severity.value if row.severity else "unknown",
                        "count": count,
                    })

                # Ensure every severity level is represented
                present = {d["severity"] for d in data}
                for sev in AlertSeverity:
                    if sev.value not in present:
                        data.append({"severity": sev.value, "count": 0})

                severity_order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
                data.sort(key=lambda d: severity_order.get(d["severity"], 99))

                return {
                    "metric": "alerts_by_severity",
                    "data": data,
                    "summary": {"total": total, "include_resolved": include_resolved},
                }
        except Exception as exc:
            logger.error("alerts_by_severity failed: %s", exc)
            return {"metric": "alerts_by_severity", "data": [], "summary": {"error": str(exc)}}

    # ── Zone occupancy history ───────────────────────────────

    async def zone_occupancy_history(
        self,
        zone_id: Optional[str] = None,
        hours: int = 24,
    ) -> Dict[str, Any]:
        """Return current or historical occupancy for zones.

        If *zone_id* is given, only that zone is returned; otherwise all
        active zones are included.  (True historical time-series would
        require a dedicated occupancy-log table; this implementation
        returns the current snapshot plus recent detection-based counts.)
        """
        range_start = datetime.now(timezone.utc) - timedelta(hours=hours)

        try:
            async with async_session() as session:
                # Current snapshot
                zone_query = select(Zone).where(Zone.is_active == True)  # noqa: E712
                if zone_id:
                    zone_query = zone_query.where(Zone.id == uuid.UUID(zone_id))
                zone_query = zone_query.order_by(Zone.name)

                zone_result = await session.execute(zone_query)
                zones = zone_result.scalars().all()

                data: List[Dict[str, Any]] = []
                total_occupancy = 0
                zones_at_capacity = 0

                for z in zones:
                    occ = z.current_occupancy or 0
                    max_occ = z.max_occupancy
                    pct = round((occ / max_occ) * 100, 1) if max_occ and max_occ > 0 else None

                    if max_occ and occ >= max_occ:
                        zones_at_capacity += 1
                    total_occupancy += occ

                    # Event count in the zone over the look-back window
                    event_count_q = await session.execute(
                        select(func.count(Event.id)).where(
                            and_(
                                Event.zone_id == z.id,
                                Event.timestamp >= range_start,
                            )
                        )
                    )
                    recent_events = event_count_q.scalar() or 0

                    data.append({
                        "zone_id": str(z.id),
                        "zone_name": z.name,
                        "zone_type": z.zone_type,
                        "current_occupancy": occ,
                        "max_occupancy": max_occ,
                        "occupancy_pct": pct,
                        "alert_on_breach": z.alert_on_breach,
                        "recent_events": recent_events,
                    })

                return {
                    "metric": "zone_occupancy_history",
                    "data": data,
                    "summary": {
                        "total_zones": len(data),
                        "total_occupancy": total_occupancy,
                        "zones_at_capacity": zones_at_capacity,
                        "period_hours": hours,
                    },
                }
        except Exception as exc:
            logger.error("zone_occupancy_history failed: %s", exc)
            return {"metric": "zone_occupancy_history", "data": [], "summary": {"error": str(exc)}}

    # ── Camera activity scores ───────────────────────────────

    async def camera_activity_scores(
        self,
        hours: int = 24,
    ) -> Dict[str, Any]:
        """Normalised 0-100 activity score per camera based on recent events."""
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)

        try:
            async with async_session() as session:
                # Events per camera
                event_counts = await session.execute(
                    select(
                        Event.camera_id,
                        func.count(Event.id).label("event_count"),
                    )
                    .where(Event.timestamp >= cutoff)
                    .group_by(Event.camera_id)
                )
                counts_map: Dict[uuid.UUID, int] = {
                    row.camera_id: row.event_count for row in event_counts.all()
                }

                cam_result = await session.execute(
                    select(Camera).order_by(Camera.name)
                )
                cameras = cam_result.scalars().all()

                max_count = max(counts_map.values()) if counts_map else 1

                data: List[Dict[str, Any]] = []
                for cam in cameras:
                    event_count = counts_map.get(cam.id, 0)
                    activity_score = (
                        round((event_count / max_count) * 100, 1) if max_count > 0 else 0.0
                    )
                    data.append({
                        "camera_id": str(cam.id),
                        "camera_name": cam.name,
                        "location": cam.location,
                        "status": cam.status.value if cam.status else "unknown",
                        "event_count": event_count,
                        "activity_score": activity_score,
                    })

                data.sort(key=lambda d: d["activity_score"], reverse=True)

                return {
                    "metric": "camera_activity",
                    "data": data,
                    "summary": {
                        "period_hours": hours,
                        "total_cameras": len(data),
                        "total_events": sum(d["event_count"] for d in data),
                    },
                }
        except Exception as exc:
            logger.error("camera_activity_scores failed: %s", exc)
            return {"metric": "camera_activity", "data": [], "summary": {"error": str(exc)}}

    # ── Threat trends ────────────────────────────────────────

    async def threat_trends(
        self,
        days: int = 7,
    ) -> Dict[str, Any]:
        """Daily alert counts by severity with trend direction analysis."""
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)

        try:
            async with async_session() as session:
                result = await session.execute(
                    select(
                        func.date_trunc("day", Alert.created_at).label("day"),
                        Alert.severity,
                        func.count(Alert.id).label("count"),
                    )
                    .where(Alert.created_at >= cutoff)
                    .group_by("day", Alert.severity)
                    .order_by("day")
                )
                rows = result.all()

                # Pivot into per-day records
                day_map: Dict[str, Dict[str, Any]] = {}
                for row in rows:
                    day_key = row.day.strftime("%Y-%m-%d") if row.day else "unknown"
                    if day_key not in day_map:
                        day_map[day_key] = {"date": day_key, "total": 0}
                        for sev in AlertSeverity:
                            day_map[day_key][sev.value] = 0

                    sev_val = row.severity.value if row.severity else "info"
                    day_map[day_key][sev_val] = row.count
                    day_map[day_key]["total"] += row.count

                data = sorted(day_map.values(), key=lambda d: d["date"])
                total_alerts = sum(d["total"] for d in data)
                avg_per_day = round(total_alerts / max(len(data), 1), 1)

                # Trend direction
                if len(data) >= 2:
                    first_half = data[: len(data) // 2]
                    second_half = data[len(data) // 2:]
                    avg_first = sum(d["total"] for d in first_half) / max(len(first_half), 1)
                    avg_second = sum(d["total"] for d in second_half) / max(len(second_half), 1)
                    if avg_second > avg_first * 1.2:
                        trend = "increasing"
                    elif avg_second < avg_first * 0.8:
                        trend = "decreasing"
                    else:
                        trend = "stable"
                else:
                    trend = "insufficient_data"

                return {
                    "metric": "threat_trends",
                    "data": data,
                    "summary": {
                        "period_days": days,
                        "total_alerts": total_alerts,
                        "avg_alerts_per_day": avg_per_day,
                        "trend": trend,
                    },
                }
        except Exception as exc:
            logger.error("threat_trends failed: %s", exc)
            return {"metric": "threat_trends", "data": [], "summary": {"error": str(exc)}}

    # ── Response time metrics ────────────────────────────────

    async def response_time_metrics(
        self,
        days: int = 7,
    ) -> Dict[str, Any]:
        """Average alert acknowledge and resolve times per day."""
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)

        try:
            async with async_session() as session:
                # Time to acknowledge
                ack_result = await session.execute(
                    select(
                        func.date_trunc("day", Alert.created_at).label("day"),
                        func.avg(
                            extract("epoch", Alert.acknowledged_at)
                            - extract("epoch", Alert.created_at)
                        ).label("avg_ack_seconds"),
                        func.count(Alert.id).label("ack_count"),
                    )
                    .where(
                        and_(
                            Alert.created_at >= cutoff,
                            Alert.acknowledged_at.isnot(None),
                        )
                    )
                    .group_by("day")
                    .order_by("day")
                )
                ack_rows = {
                    row.day.strftime("%Y-%m-%d") if row.day else "unknown": {
                        "avg_ack_seconds": round(row.avg_ack_seconds, 1) if row.avg_ack_seconds else None,
                        "ack_count": row.ack_count,
                    }
                    for row in ack_result.all()
                }

                # Time to resolve
                resolve_result = await session.execute(
                    select(
                        func.date_trunc("day", Alert.created_at).label("day"),
                        func.avg(
                            extract("epoch", Alert.resolved_at)
                            - extract("epoch", Alert.created_at)
                        ).label("avg_resolve_seconds"),
                        func.count(Alert.id).label("resolve_count"),
                    )
                    .where(
                        and_(
                            Alert.created_at >= cutoff,
                            Alert.resolved_at.isnot(None),
                        )
                    )
                    .group_by("day")
                    .order_by("day")
                )
                resolve_rows = {
                    row.day.strftime("%Y-%m-%d") if row.day else "unknown": {
                        "avg_resolve_seconds": round(row.avg_resolve_seconds, 1) if row.avg_resolve_seconds else None,
                        "resolve_count": row.resolve_count,
                    }
                    for row in resolve_result.all()
                }

                all_days = sorted(set(list(ack_rows.keys()) + list(resolve_rows.keys())))

                data: List[Dict[str, Any]] = []
                total_ack_sum = 0.0
                total_resolve_sum = 0.0
                ack_total_count = 0
                resolve_total_count = 0

                for day in all_days:
                    ack = ack_rows.get(day, {})
                    res = resolve_rows.get(day, {})

                    avg_ack = ack.get("avg_ack_seconds")
                    avg_res = res.get("avg_resolve_seconds")
                    a_count = ack.get("ack_count", 0)
                    r_count = res.get("resolve_count", 0)

                    if avg_ack is not None:
                        total_ack_sum += avg_ack * a_count
                        ack_total_count += a_count
                    if avg_res is not None:
                        total_resolve_sum += avg_res * r_count
                        resolve_total_count += r_count

                    data.append({
                        "date": day,
                        "avg_acknowledge_seconds": avg_ack,
                        "avg_resolve_seconds": avg_res,
                        "acknowledged_count": a_count,
                        "resolved_count": r_count,
                    })

                overall_ack = (
                    round(total_ack_sum / ack_total_count, 1) if ack_total_count else None
                )
                overall_resolve = (
                    round(total_resolve_sum / resolve_total_count, 1) if resolve_total_count else None
                )

                return {
                    "metric": "response_times",
                    "data": data,
                    "summary": {
                        "period_days": days,
                        "overall_avg_acknowledge_seconds": overall_ack,
                        "overall_avg_resolve_seconds": overall_resolve,
                        "total_acknowledged": ack_total_count,
                        "total_resolved": resolve_total_count,
                    },
                }
        except Exception as exc:
            logger.error("response_time_metrics failed: %s", exc)
            return {"metric": "response_times", "data": [], "summary": {"error": str(exc)}}

    # ── Private helpers ──────────────────────────────────────

    @staticmethod
    def _resolve_range(
        hours: int,
        start: Optional[datetime],
        end: Optional[datetime],
    ) -> tuple[datetime, datetime]:
        now = datetime.now(timezone.utc)
        if start and end:
            return start, end
        if start:
            return start, now
        if end:
            return end - timedelta(hours=hours), end
        return now - timedelta(hours=hours), now


# Singleton
analytics_engine = AnalyticsEngine()
