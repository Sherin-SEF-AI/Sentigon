"""Alert management API."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select, func, desc
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database import get_db
from backend.models import Alert, Event
from backend.models.models import AlertSeverity, AlertStatus, UserRole
from backend.schemas import AlertCreate, AlertUpdate, AlertResponse
from backend.api.auth import get_current_user, require_role

router = APIRouter(prefix="/api/alerts", tags=["alerts"])


def _record_fp_feedback(threat_type: str, source_camera: str) -> None:
    """Record false-positive feedback in Redis for FP suppression."""
    try:
        import redis as _redis
        from backend.config import settings
        r = _redis.from_url(settings.REDIS_URL)
        fp_key = f"fp_feedback:{threat_type}:{source_camera}"
        r.hincrby(fp_key, "count", 1)
        r.expire(fp_key, 86400)  # 24h
    except Exception:
        pass


# ── Helpers ────────────────────────────────────────────────────

VALID_STATUS_TRANSITIONS: dict[AlertStatus, set[AlertStatus]] = {
    AlertStatus.NEW: {
        AlertStatus.ACKNOWLEDGED,
        AlertStatus.INVESTIGATING,
        AlertStatus.DISMISSED,
        AlertStatus.ESCALATED,
    },
    AlertStatus.ACKNOWLEDGED: {
        AlertStatus.INVESTIGATING,
        AlertStatus.RESOLVED,
        AlertStatus.DISMISSED,
        AlertStatus.ESCALATED,
    },
    AlertStatus.INVESTIGATING: {
        AlertStatus.RESOLVED,
        AlertStatus.DISMISSED,
        AlertStatus.ESCALATED,
    },
    AlertStatus.ESCALATED: {
        AlertStatus.INVESTIGATING,
        AlertStatus.RESOLVED,
        AlertStatus.DISMISSED,
    },
    AlertStatus.RESOLVED: set(),
    AlertStatus.DISMISSED: set(),
}


def _validate_transition(current: AlertStatus, target: AlertStatus) -> None:
    """Raise 409 if the status transition is not allowed."""
    allowed = VALID_STATUS_TRANSITIONS.get(current, set())
    if target not in allowed:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot transition from '{current.value}' to '{target.value}'",
        )


async def _get_alert_or_404(alert_id: uuid.UUID, db: AsyncSession) -> Alert:
    result = await db.execute(select(Alert).where(Alert.id == alert_id))
    alert = result.scalar_one_or_none()
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    return alert


# ── Endpoints ──────────────────────────────────────────────────

@router.get("/stats")
async def alert_stats(
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Get alert statistics — count by severity and by status."""
    # Count by severity
    severity_q = await db.execute(
        select(Alert.severity, func.count(Alert.id))
        .group_by(Alert.severity)
    )
    by_severity = {row[0].value: row[1] for row in severity_q.all()}

    # Count by status
    status_q = await db.execute(
        select(Alert.status, func.count(Alert.id))
        .group_by(Alert.status)
    )
    by_status = {row[0].value: row[1] for row in status_q.all()}

    total = sum(by_status.values())

    return {
        "total": total,
        "by_severity": by_severity,
        "by_status": by_status,
    }


@router.get("", response_model=List[AlertResponse])
async def list_alerts(
    status: Optional[str] = Query(None, description="Filter by status"),
    severity: Optional[str] = Query(None, description="Filter by severity"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """List alerts with optional filters."""
    stmt = select(Alert)

    if status is not None:
        try:
            status_enum = AlertStatus(status)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid status: {status}")
        stmt = stmt.where(Alert.status == status_enum)

    if severity is not None:
        try:
            severity_enum = AlertSeverity(severity)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid severity: {severity}")
        stmt = stmt.where(Alert.severity == severity_enum)

    stmt = stmt.order_by(desc(Alert.created_at)).offset(offset).limit(limit)
    result = await db.execute(stmt)
    alerts = result.scalars().all()
    return [AlertResponse.model_validate(a) for a in alerts]


@router.post("", response_model=AlertResponse, status_code=201)
async def create_alert(
    body: AlertCreate,
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_role(UserRole.OPERATOR)),
):
    """Create a new alert."""
    # Validate event reference if provided
    if body.event_id is not None:
        ev_result = await db.execute(select(Event).where(Event.id == body.event_id))
        if ev_result.scalar_one_or_none() is None:
            raise HTTPException(status_code=404, detail="Referenced event not found")

    # Validate severity enum value
    try:
        severity_enum = AlertSeverity(body.severity)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid severity: {body.severity}")

    alert = Alert(
        event_id=body.event_id,
        title=body.title,
        description=body.description,
        severity=severity_enum,
        status=AlertStatus.NEW,
        threat_type=body.threat_type,
        source_camera=body.source_camera,
        zone_name=body.zone_name,
        confidence=body.confidence,
        metadata_=body.metadata,
    )
    db.add(alert)
    await db.flush()
    await db.refresh(alert)
    return AlertResponse.model_validate(alert)


@router.get("/{alert_id}", response_model=AlertResponse)
async def get_alert(
    alert_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Get a single alert by ID."""
    alert = await _get_alert_or_404(alert_id, db)
    return AlertResponse.model_validate(alert)


@router.patch("/{alert_id}", response_model=AlertResponse)
async def update_alert(
    alert_id: uuid.UUID,
    body: AlertUpdate,
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_role(UserRole.OPERATOR)),
):
    """Update an alert — supports status transitions with timestamps."""
    alert = await _get_alert_or_404(alert_id, db)
    update_data = body.model_dump(exclude_unset=True)

    if "status" in update_data and update_data["status"] is not None:
        try:
            new_status = AlertStatus(update_data["status"])
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid status: {update_data['status']}")

        _validate_transition(alert.status, new_status)
        alert.status = new_status

        now = datetime.now(timezone.utc)
        if new_status == AlertStatus.ACKNOWLEDGED and alert.acknowledged_at is None:
            alert.acknowledged_at = now
        elif new_status == AlertStatus.RESOLVED:
            alert.resolved_at = now
        elif new_status == AlertStatus.DISMISSED:
            _record_fp_feedback(alert.threat_type, str(alert.source_camera))

    if "assigned_to" in update_data:
        alert.assigned_to = update_data["assigned_to"]

    if "resolution_notes" in update_data:
        alert.resolution_notes = update_data["resolution_notes"]

    await db.flush()
    await db.refresh(alert)
    return AlertResponse.model_validate(alert)


@router.post("/{alert_id}/acknowledge", response_model=AlertResponse)
async def acknowledge_alert(
    alert_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_role(UserRole.OPERATOR)),
):
    """Acknowledge an alert — sets acknowledged_at timestamp."""
    alert = await _get_alert_or_404(alert_id, db)
    _validate_transition(alert.status, AlertStatus.ACKNOWLEDGED)

    alert.status = AlertStatus.ACKNOWLEDGED
    alert.acknowledged_at = datetime.now(timezone.utc)
    alert.assigned_to = user.id

    await db.flush()
    await db.refresh(alert)
    return AlertResponse.model_validate(alert)


@router.post("/{alert_id}/resolve", response_model=AlertResponse)
async def resolve_alert(
    alert_id: uuid.UUID,
    resolution_notes: Optional[str] = Query(None, description="Resolution notes (required)"),
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_role(UserRole.OPERATOR)),
):
    """Resolve an alert — requires resolution_notes, sets resolved_at."""
    if not resolution_notes:
        raise HTTPException(status_code=400, detail="resolution_notes is required to resolve an alert")

    alert = await _get_alert_or_404(alert_id, db)
    _validate_transition(alert.status, AlertStatus.RESOLVED)

    now = datetime.now(timezone.utc)
    alert.status = AlertStatus.RESOLVED
    alert.resolved_at = now
    alert.resolution_notes = resolution_notes
    if alert.acknowledged_at is None:
        alert.acknowledged_at = now

    await db.flush()
    await db.refresh(alert)
    return AlertResponse.model_validate(alert)


@router.post("/{alert_id}/dismiss", response_model=AlertResponse)
async def dismiss_alert(
    alert_id: uuid.UUID,
    resolution_notes: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_role(UserRole.OPERATOR)),
):
    """Dismiss an alert."""
    alert = await _get_alert_or_404(alert_id, db)
    _validate_transition(alert.status, AlertStatus.DISMISSED)

    alert.status = AlertStatus.DISMISSED
    if resolution_notes:
        alert.resolution_notes = resolution_notes

    await db.flush()
    await db.refresh(alert)

    _record_fp_feedback(alert.threat_type, str(alert.source_camera))

    return AlertResponse.model_validate(alert)


@router.post("/{alert_id}/investigate", response_model=AlertResponse)
async def investigate_alert(
    alert_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_role(UserRole.OPERATOR)),
):
    """Move an alert to investigating status."""
    alert = await _get_alert_or_404(alert_id, db)
    _validate_transition(alert.status, AlertStatus.INVESTIGATING)

    alert.status = AlertStatus.INVESTIGATING
    alert.assigned_to = user.id
    if alert.acknowledged_at is None:
        alert.acknowledged_at = datetime.now(timezone.utc)

    await db.flush()
    await db.refresh(alert)
    return AlertResponse.model_validate(alert)


@router.post("/{alert_id}/escalate", response_model=AlertResponse)
async def escalate_alert(
    alert_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_role(UserRole.OPERATOR)),
):
    """Escalate an alert."""
    alert = await _get_alert_or_404(alert_id, db)
    _validate_transition(alert.status, AlertStatus.ESCALATED)

    alert.status = AlertStatus.ESCALATED
    # Bump severity one level if possible
    severity_order = [AlertSeverity.INFO, AlertSeverity.LOW, AlertSeverity.MEDIUM, AlertSeverity.HIGH, AlertSeverity.CRITICAL]
    current_idx = severity_order.index(alert.severity) if alert.severity in severity_order else 2
    if current_idx < len(severity_order) - 1:
        alert.severity = severity_order[current_idx + 1]

    await db.flush()
    await db.refresh(alert)
    return AlertResponse.model_validate(alert)


# ── Export Functionality ───────────────────────────────────────

@router.get("/export/csv")
async def export_alerts_csv(
    severity: Optional[str] = None,
    status: Optional[str] = None,
    days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Export alerts to CSV format."""
    import csv
    import io
    from datetime import timedelta
    
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    
    query = select(Alert).where(Alert.created_at >= cutoff).order_by(desc(Alert.created_at))
    
    if severity:
        query = query.where(Alert.severity == AlertSeverity(severity))
    if status:
        query = query.where(Alert.status == AlertStatus(status))
    
    result = await db.execute(query.limit(10000))  # Limit to 10k for export
    alerts = result.scalars().all()
    
    # Create CSV in memory
    output = io.StringIO()
    writer = csv.writer(output)
    
    # Write header
    writer.writerow([
        'ID', 'Title', 'Description', 'Severity', 'Status', 'Threat Type',
        'Camera ID', 'Zone', 'Confidence', 'Created At', 'Acknowledged At', 'Resolved At'
    ])
    
    # Write data
    for alert in alerts:
        writer.writerow([
            str(alert.id),
            alert.title or '',
            alert.description or '',
            alert.severity.value if alert.severity else '',
            alert.status.value if alert.status else '',
            alert.threat_type or '',
            str(alert.source_camera) if alert.source_camera else '',
            alert.zone_name or '',
            alert.confidence or 0.0,
            alert.created_at.isoformat() if alert.created_at else '',
            alert.acknowledged_at.isoformat() if alert.acknowledged_at else '',
            alert.resolved_at.isoformat() if alert.resolved_at else '',
        ])
    
    output.seek(0)
    
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=alerts_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"}
    )


@router.post("/bulk/acknowledge", response_model=dict)
async def bulk_acknowledge_alerts(
    alert_ids: List[uuid.UUID],
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_role(UserRole.OPERATOR)),
):
    """Bulk acknowledge multiple alerts (raw list body)."""
    count = 0
    errors = []

    for alert_id in alert_ids:
        try:
            alert = await _get_alert_or_404(alert_id, db)
            if alert.status == AlertStatus.NEW:
                alert.status = AlertStatus.ACKNOWLEDGED
                alert.acknowledged_at = datetime.now(timezone.utc)
                count += 1
        except Exception as e:
            errors.append({"alert_id": str(alert_id), "error": str(e)})

    await db.flush()

    return {
        "acknowledged": count,
        "total": len(alert_ids),
        "errors": errors,
    }


class BulkAcknowledgeBody(BaseModel):
    alert_ids: List[uuid.UUID]


@router.post("/bulk-acknowledge", response_model=dict)
async def bulk_acknowledge_alerts_v2(
    body: BulkAcknowledgeBody,
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_role(UserRole.OPERATOR)),
):
    """Bulk acknowledge alerts — accepts { alert_ids: [...] } JSON body."""
    count = 0
    errors: list = []

    for alert_id in body.alert_ids:
        try:
            alert = await _get_alert_or_404(alert_id, db)
            if alert.status == AlertStatus.NEW:
                alert.status = AlertStatus.ACKNOWLEDGED
                alert.acknowledged_at = datetime.now(timezone.utc)
                count += 1
        except Exception as e:
            errors.append({"alert_id": str(alert_id), "error": str(e)})

    await db.flush()

    return {
        "acknowledged": count,
        "total": len(body.alert_ids),
        "errors": errors,
    }


@router.post("/bulk/dismiss", response_model=dict)
async def bulk_dismiss_alerts(
    alert_ids: List[uuid.UUID],
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_role(UserRole.OPERATOR)),
):
    """Bulk dismiss multiple alerts."""
    count = 0
    errors = []
    
    for alert_id in alert_ids:
        try:
            alert = await _get_alert_or_404(alert_id, db)
            if alert.status in [AlertStatus.NEW, AlertStatus.ACKNOWLEDGED]:
                alert.status = AlertStatus.DISMISSED
                count += 1
        except Exception as e:
            errors.append({"alert_id": str(alert_id), "error": str(e)})
    
    await db.flush()
    
    return {
        "dismissed": count,
        "total": len(alert_ids),
        "errors": errors
    }
