"""Analytics and metrics API."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import uuid
from fastapi import APIRouter, Depends, Query
from sqlalchemy import desc
from sqlalchemy import select, func, and_, case, extract
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
from backend.models import Event, Alert, Camera, Zone, AuditLog, User
from backend.models.models import AlertSeverity, AlertStatus, CameraStatus
from backend.schemas import AnalyticsResponse, SOCMetrics
from backend.api.auth import get_current_user

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


# ── Helpers ────────────────────────────────────────────────────

def _parse_time_range(
    hours: int,
    start: Optional[datetime],
    end: Optional[datetime],
) -> tuple[datetime, datetime]:
    """Return (start, end) datetimes. If neither is supplied, use last `hours` hours."""
    now = datetime.now(timezone.utc)
    if start and end:
        return start, end
    if start:
        return start, now
    if end:
        return end - timedelta(hours=hours), end
    return now - timedelta(hours=hours), now


# ── Endpoints ──────────────────────────────────────────────────

@router.get("/soc-metrics", response_model=SOCMetrics)
async def soc_metrics(
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Live SOC dashboard metrics — aggregate counts for the command centre."""
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    # Total and active cameras
    total_cam = await db.execute(select(func.count(Camera.id)))
    active_cam = await db.execute(
        select(func.count(Camera.id)).where(Camera.status == CameraStatus.ONLINE)
    )

    # Alert counts
    total_alerts = await db.execute(
        select(func.count(Alert.id)).where(
            Alert.status.in_([AlertStatus.NEW, AlertStatus.ACKNOWLEDGED, AlertStatus.INVESTIGATING, AlertStatus.ESCALATED])
        )
    )
    critical_alerts = await db.execute(
        select(func.count(Alert.id)).where(
            and_(
                Alert.severity == AlertSeverity.CRITICAL,
                Alert.status.in_([AlertStatus.NEW, AlertStatus.ACKNOWLEDGED, AlertStatus.INVESTIGATING, AlertStatus.ESCALATED]),
            )
        )
    )

    # Open cases
    from backend.models import Case
    from backend.models.models import CaseStatus
    open_cases = await db.execute(
        select(func.count(Case.id)).where(
            Case.status.in_([CaseStatus.OPEN, CaseStatus.INVESTIGATING])
        )
    )

    # Detections today
    detections_today = await db.execute(
        select(func.count(Event.id)).where(Event.timestamp >= today_start)
    )

    # Average response time (acknowledged_at - created_at) for alerts resolved/acked today
    avg_resp = await db.execute(
        select(
            func.avg(
                extract("epoch", Alert.acknowledged_at) - extract("epoch", Alert.created_at)
            )
        ).where(
            and_(
                Alert.acknowledged_at.isnot(None),
                Alert.acknowledged_at >= today_start,
            )
        )
    )
    avg_response_seconds = avg_resp.scalar()

    # Determine threat level
    crit_count = critical_alerts.scalar() or 0
    total_open = total_alerts.scalar() or 0

    if crit_count >= 5:
        threat_level = "critical"
    elif crit_count >= 2:
        threat_level = "high"
    elif total_open >= 10:
        threat_level = "elevated"
    else:
        threat_level = "normal"

    return SOCMetrics(
        total_cameras=total_cam.scalar() or 0,
        active_cameras=active_cam.scalar() or 0,
        total_alerts=total_open,
        critical_alerts=crit_count,
        open_cases=open_cases.scalar() or 0,
        total_detections_today=detections_today.scalar() or 0,
        avg_response_time=round(avg_response_seconds, 1) if avg_response_seconds else None,
        threat_level=threat_level,
    )


@router.get("/events-over-time", response_model=AnalyticsResponse)
async def events_over_time(
    hours: int = Query(24, ge=1, le=720, description="Look-back window in hours"),
    bucket_minutes: int = Query(60, ge=5, le=1440, description="Bucket size in minutes"),
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Time-series of event counts bucketed by time interval."""
    range_start, range_end = _parse_time_range(hours, start, end)

    # Use date_trunc to bucket by the requested interval
    # For simplicity, use truncation to the nearest hour or custom grouping
    bucket_seconds = bucket_minutes * 60
    result = await db.execute(
        select(
            func.date_trunc("hour", Event.timestamp).label("bucket"),
            func.count(Event.id).label("count"),
        )
        .where(and_(Event.timestamp >= range_start, Event.timestamp <= range_end))
        .group_by("bucket")
        .order_by("bucket")
    )
    rows = result.all()

    data: List[Dict[str, Any]] = []
    for row in rows:
        data.append({
            "timestamp": row.bucket.isoformat() if row.bucket else None,
            "count": row.count,
        })

    return AnalyticsResponse(
        metric="events_over_time",
        data=data,
        summary={
            "range_start": range_start.isoformat(),
            "range_end": range_end.isoformat(),
            "total_events": sum(d["count"] for d in data),
            "buckets": len(data),
        },
    )


@router.get("/alerts-by-severity", response_model=AnalyticsResponse)
async def alerts_by_severity(
    include_resolved: bool = Query(False, description="Include resolved/dismissed alerts"),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Alert distribution by severity level."""
    stmt = select(
        Alert.severity,
        func.count(Alert.id).label("count"),
    )

    if not include_resolved:
        stmt = stmt.where(
            Alert.status.notin_([AlertStatus.RESOLVED, AlertStatus.DISMISSED])
        )

    stmt = stmt.group_by(Alert.severity)
    result = await db.execute(stmt)
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

    # Ensure all severities are represented
    present = {d["severity"] for d in data}
    for sev in AlertSeverity:
        if sev.value not in present:
            data.append({"severity": sev.value, "count": 0})

    # Sort by severity order
    severity_order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
    data.sort(key=lambda d: severity_order.get(d["severity"], 99))

    return AnalyticsResponse(
        metric="alerts_by_severity",
        data=data,
        summary={"total": total, "include_resolved": include_resolved},
    )


@router.get("/zone-occupancy", response_model=AnalyticsResponse)
async def zone_occupancy(
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Current occupancy data per zone."""
    result = await db.execute(
        select(Zone).where(Zone.is_active == True).order_by(Zone.name)  # noqa: E712
    )
    zones = result.scalars().all()

    data: List[Dict[str, Any]] = []
    total_occupancy = 0
    zones_at_capacity = 0

    for z in zones:
        occupancy = z.current_occupancy or 0
        max_occ = z.max_occupancy
        pct = round((occupancy / max_occ) * 100, 1) if max_occ and max_occ > 0 else None

        if max_occ and occupancy >= max_occ:
            zones_at_capacity += 1

        total_occupancy += occupancy
        data.append({
            "zone_id": str(z.id),
            "zone_name": z.name,
            "zone_type": z.zone_type,
            "current_occupancy": occupancy,
            "max_occupancy": max_occ,
            "occupancy_pct": pct,
            "alert_on_breach": z.alert_on_breach,
        })

    return AnalyticsResponse(
        metric="zone_occupancy",
        data=data,
        summary={
            "total_zones": len(data),
            "total_occupancy": total_occupancy,
            "zones_at_capacity": zones_at_capacity,
        },
    )


@router.get("/camera-activity", response_model=AnalyticsResponse)
async def camera_activity(
    hours: int = Query(24, ge=1, le=720),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Activity scores per camera based on recent event volume."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)

    # Count events per camera in the window
    event_counts = await db.execute(
        select(
            Event.camera_id,
            func.count(Event.id).label("event_count"),
        )
        .where(Event.timestamp >= cutoff)
        .group_by(Event.camera_id)
    )
    counts_map: Dict[uuid.UUID, int] = {row.camera_id: row.event_count for row in event_counts.all()}

    # Fetch all cameras
    cam_result = await db.execute(select(Camera).order_by(Camera.name))
    cameras = cam_result.scalars().all()

    max_count = max(counts_map.values()) if counts_map else 1

    data: List[Dict[str, Any]] = []
    for cam in cameras:
        event_count = counts_map.get(cam.id, 0)
        # Normalised activity score 0-100
        activity_score = round((event_count / max_count) * 100, 1) if max_count > 0 else 0.0

        data.append({
            "camera_id": str(cam.id),
            "camera_name": cam.name,
            "location": cam.location,
            "status": cam.status.value if cam.status else "unknown",
            "event_count": event_count,
            "activity_score": activity_score,
        })

    # Sort by activity score descending
    data.sort(key=lambda d: d["activity_score"], reverse=True)

    return AnalyticsResponse(
        metric="camera_activity",
        data=data,
        summary={
            "period_hours": hours,
            "total_cameras": len(data),
            "total_events": sum(d["event_count"] for d in data),
        },
    )


@router.get("/threat-trends", response_model=AnalyticsResponse)
async def threat_trends(
    days: int = Query(7, ge=1, le=90, description="Number of days to analyse"),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Threat trend data — daily alert counts by severity over time."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)

    result = await db.execute(
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
        second_half = data[len(data) // 2 :]
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

    return AnalyticsResponse(
        metric="threat_trends",
        data=data,
        summary={
            "period_days": days,
            "total_alerts": total_alerts,
            "avg_alerts_per_day": avg_per_day,
            "trend": trend,
        },
    )


@router.get("/response-times", response_model=AnalyticsResponse)
async def response_times(
    days: int = Query(7, ge=1, le=90),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Average alert response times (time to acknowledge and time to resolve)."""
    try:
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)

        # Time to acknowledge
        ack_result = await db.execute(
            select(
                func.date_trunc("day", Alert.created_at).label("day"),
                func.avg(
                    extract("epoch", Alert.acknowledged_at) - extract("epoch", Alert.created_at)
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
        resolve_result = await db.execute(
            select(
                func.date_trunc("day", Alert.created_at).label("day"),
                func.avg(
                    extract("epoch", Alert.resolved_at) - extract("epoch", Alert.created_at)
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

        overall_ack = round(total_ack_sum / ack_total_count, 1) if ack_total_count else None
        overall_resolve = round(total_resolve_sum / resolve_total_count, 1) if resolve_total_count else None

        return AnalyticsResponse(
            metric="response_times",
            data=data,
            summary={
                "period_days": days,
                "overall_avg_acknowledge_seconds": overall_ack,
                "overall_avg_resolve_seconds": overall_resolve,
                "total_acknowledged": ack_total_count,
                "total_resolved": resolve_total_count,
            },
        )
    except Exception as e:
        import logging
        logging.getLogger(__name__).error(f"Error in response_times endpoint: {e}", exc_info=True)
        # Return empty data instead of failing
        return AnalyticsResponse(
            metric="response_times",
            data=[],
            summary={
                "period_days": days,
                "overall_avg_acknowledge_seconds": None,
                "overall_avg_resolve_seconds": None,
                "total_acknowledged": 0,
                "total_resolved": 0,
                "error": str(e),
            },
        )


@router.get("/audit-log")
async def audit_log(
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Paginated audit log for the settings page."""
    total_q = await db.execute(select(func.count(AuditLog.id)))
    total = total_q.scalar() or 0

    stmt = (
        select(AuditLog, User.email)
        .outerjoin(User, AuditLog.user_id == User.id)
        .order_by(desc(AuditLog.timestamp))
        .offset(offset)
        .limit(limit)
    )
    result = await db.execute(stmt)
    rows = result.all()

    items = []
    for row in rows:
        entry = row[0]
        user_email = row[1]
        items.append({
            "id": str(entry.id),
            "timestamp": entry.timestamp.isoformat() if entry.timestamp else None,
            "user_email": user_email,
            "action": entry.action,
            "details": str(entry.details) if entry.details else None,
        })

    return {"items": items, "total": total}


@router.get("/sla-compliance")
async def get_sla_compliance(
    hours: int = Query(24, ge=1, le=720),
    db: AsyncSession = Depends(get_db),
):
    """Server-side SLA compliance computation."""
    SLA_TARGETS = {"critical": 2, "high": 10, "medium": 30, "low": 120}  # minutes
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    result = await db.execute(
        select(Alert).where(Alert.created_at >= cutoff)
    )
    alerts = result.scalars().all()

    total = len(alerts)
    within_sla = 0
    breached = 0
    by_severity = {}

    for a in alerts:
        sev = a.severity.value if hasattr(a.severity, "value") else str(a.severity)
        target_min = SLA_TARGETS.get(sev, 30)
        if a.acknowledged_at and a.created_at:
            response_seconds = (a.acknowledged_at - a.created_at).total_seconds()
            met = response_seconds <= target_min * 60
        elif a.resolved_at and a.created_at:
            response_seconds = (a.resolved_at - a.created_at).total_seconds()
            met = response_seconds <= target_min * 60
        else:
            response_seconds = None
            elapsed = (datetime.now(timezone.utc) - a.created_at).total_seconds() if a.created_at else 0
            met = elapsed <= target_min * 60

        if met:
            within_sla += 1
        else:
            breached += 1

        if sev not in by_severity:
            by_severity[sev] = {"total": 0, "met": 0, "breached": 0, "target_minutes": target_min}
        by_severity[sev]["total"] += 1
        by_severity[sev]["met" if met else "breached"] += 1

    return {
        "compliance_pct": round(within_sla / max(total, 1) * 100, 1),
        "total_alerts": total,
        "within_sla": within_sla,
        "breached": breached,
        "by_severity": by_severity,
        "hours": hours,
    }


@router.get("/monthly-summary")
async def get_monthly_summary(db: AsyncSession = Depends(get_db)):
    """Server-side monthly summary for customer portal."""
    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    total_q = await db.execute(
        select(func.count()).select_from(Alert).where(Alert.created_at >= month_start)
    )
    total = total_q.scalar() or 0

    resolved_q = await db.execute(
        select(func.count()).select_from(Alert)
        .where(Alert.created_at >= month_start)
        .where(Alert.status == AlertStatus.RESOLVED)
    )
    resolved = resolved_q.scalar() or 0

    critical_q = await db.execute(
        select(func.count()).select_from(Alert)
        .where(Alert.created_at >= month_start)
        .where(Alert.severity == AlertSeverity.CRITICAL)
    )
    critical = critical_q.scalar() or 0

    cam_q = await db.execute(
        select(func.count()).select_from(Camera).where(Camera.is_active.is_(True))
    )
    cameras = cam_q.scalar() or 0

    online_q = await db.execute(
        select(func.count()).select_from(Camera)
        .where(Camera.is_active.is_(True))
        .where(Camera.status == CameraStatus.ONLINE)
    )
    online = online_q.scalar() or 0

    return {
        "month": now.strftime("%B %Y"),
        "total_alerts": total,
        "resolved_alerts": resolved,
        "critical_alerts": critical,
        "resolution_rate": round(resolved / max(total, 1) * 100, 1),
        "cameras_total": cameras,
        "cameras_online": online,
        "uptime_pct": round(online / max(cameras, 1) * 100, 1),
    }
