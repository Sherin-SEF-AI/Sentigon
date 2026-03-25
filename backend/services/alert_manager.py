"""Alert lifecycle — creation, deduplication, escalation, correlation."""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import select, and_, func
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models import Alert, Event
from backend.models.models import AlertSeverity, AlertStatus
from backend.database import async_session

logger = logging.getLogger(__name__)


class AlertManager:
    """Manages alert lifecycle with deduplication and escalation."""

    DEDUP_WINDOW_SECONDS = 300  # Suppress duplicate alerts within 5-minute window
    ESCALATION_TIMEOUT = {
        "critical": 120,   # Escalate if not acknowledged within 2 min
        "high": 300,       # 5 min
        "medium": 900,     # 15 min
        "low": 3600,       # 1 hr
    }

    def __init__(self):
        self._recent_alerts: Dict[str, datetime] = {}  # dedup key -> timestamp
        self._subscribers: List[Any] = []  # Notification callbacks

    def subscribe(self, callback):
        """Register a notification callback."""
        self._subscribers.append(callback)

    async def create_alert(
        self,
        title: str,
        description: str = "",
        severity: str = "medium",
        threat_type: str = "",
        source_camera: str = "",
        zone_name: str = "",
        confidence: float = 0.0,
        event_id: Optional[str] = None,
        metadata: Optional[Dict] = None,
    ) -> Optional[Dict[str, Any]]:
        """Create an alert with deduplication."""
        # Deduplication check
        dedup_key = f"{threat_type}:{source_camera}:{severity}"
        now = datetime.now(timezone.utc)

        if dedup_key in self._recent_alerts:
            last_time = self._recent_alerts[dedup_key]
            if (now - last_time).total_seconds() < self.DEDUP_WINDOW_SECONDS:
                logger.debug("Alert deduplicated: %s", dedup_key)
                return None

        self._recent_alerts[dedup_key] = now
        # Clean old dedup entries
        cutoff = now - timedelta(seconds=self.DEDUP_WINDOW_SECONDS * 2)
        self._recent_alerts = {
            k: v for k, v in self._recent_alerts.items() if v > cutoff
        }

        try:
            async with async_session() as session:
                alert = Alert(
                    event_id=uuid.UUID(event_id) if event_id else None,
                    title=title,
                    description=description,
                    severity=AlertSeverity(severity),
                    status=AlertStatus.NEW,
                    threat_type=threat_type,
                    source_camera=source_camera,
                    zone_name=zone_name,
                    confidence=confidence,
                    metadata_=metadata or {},
                )
                session.add(alert)
                await session.commit()
                await session.refresh(alert)

                alert_data = {
                    "id": str(alert.id),
                    "title": alert.title,
                    "description": alert.description,
                    "severity": severity,
                    "status": "new",
                    "threat_type": threat_type,
                    "source_camera": source_camera,
                    "zone_name": zone_name,
                    "confidence": confidence,
                    "created_at": alert.created_at.isoformat() if alert.created_at else now.isoformat(),
                }

                # Notify subscribers
                for cb in self._subscribers:
                    try:
                        await cb(alert_data)
                    except Exception as e:
                        logger.error("Alert notification callback error: %s", e)

                # Auto-trigger incident recording for critical/high alerts
                if severity in ("critical", "high"):
                    try:
                        from backend.services.incident_recorder import incident_recorder
                        if not incident_recorder.get_active_recordings():
                            await incident_recorder.start_recording(
                                title=f"Auto-record: {title}",
                                alert_id=str(alert.id),
                            )
                            logger.info("incident_recorder.auto_started", alert_id=str(alert.id))
                    except Exception as rec_err:
                        logger.debug("incident_recorder.auto_start_failed", error=str(rec_err))

                # Dispatch to external webhooks
                try:
                    from backend.modules.webhook_integration import webhook_dispatcher
                    await webhook_dispatcher.dispatch("alert", alert_data)
                except Exception as wh_err:
                    logger.debug("webhook.dispatch_failed: %s", wh_err)

                # Trigger autonomous threat response for high/critical alerts
                if severity in ("critical", "high"):
                    try:
                        from backend.config import settings as _cfg
                        if _cfg.AUTONOMOUS_RESPONSE_ENABLED:
                            from backend.services.autonomous_response import autonomous_response
                            asyncio.create_task(
                                autonomous_response.trigger_response(str(alert.id), alert_data)
                            )
                            logger.info("Autonomous response triggered for alert %s", str(alert.id)[:8])
                    except Exception as ar_err:
                        logger.debug("autonomous_response.trigger_failed: %s", ar_err)

                logger.info("Alert created: [%s] %s — %s", severity.upper(), title, source_camera)
                return alert_data

        except Exception as e:
            logger.error("Failed to create alert: %s", e)
            return None

    async def check_escalations(self):
        """Check for alerts needing escalation."""
        try:
            async with async_session() as session:
                now = datetime.now(timezone.utc)
                result = await session.execute(
                    select(Alert).where(
                        Alert.status.in_([AlertStatus.NEW]),
                    )
                )
                alerts = result.scalars().all()

                escalated = []
                for alert in alerts:
                    timeout = self.ESCALATION_TIMEOUT.get(alert.severity.value, 900)
                    created = alert.created_at.replace(tzinfo=timezone.utc) if alert.created_at.tzinfo is None else alert.created_at
                    if (now - created).total_seconds() > timeout:
                        alert.status = AlertStatus.ESCALATED
                        escalated.append(str(alert.id))

                if escalated:
                    await session.commit()
                    logger.warning("Escalated %d alerts: %s", len(escalated), escalated)

                return escalated
        except Exception as e:
            logger.error("Escalation check failed: %s", e)
            return []

    async def correlate_alerts(
        self,
        alert_id: str,
        time_window_seconds: int = 300,
    ) -> List[Dict[str, Any]]:
        """Find correlated alerts within a time window."""
        try:
            async with async_session() as session:
                result = await session.execute(
                    select(Alert).where(Alert.id == uuid.UUID(alert_id))
                )
                alert = result.scalar_one_or_none()
                if not alert:
                    return []

                created = alert.created_at.replace(tzinfo=timezone.utc) if alert.created_at.tzinfo is None else alert.created_at
                window_start = created - timedelta(seconds=time_window_seconds)
                window_end = created + timedelta(seconds=time_window_seconds)

                result = await session.execute(
                    select(Alert).where(
                        and_(
                            Alert.id != alert.id,
                            Alert.created_at.between(window_start, window_end),
                        )
                    ).order_by(Alert.created_at)
                )
                correlated = result.scalars().all()

                return [
                    {
                        "id": str(a.id),
                        "title": a.title,
                        "severity": a.severity.value,
                        "threat_type": a.threat_type,
                        "source_camera": a.source_camera,
                        "created_at": a.created_at.isoformat() if a.created_at else "",
                    }
                    for a in correlated
                ]
        except Exception as e:
            logger.error("Alert correlation failed: %s", e)
            return []

    async def get_stats(self) -> Dict[str, Any]:
        """Get current alert statistics."""
        try:
            async with async_session() as session:
                # Count by status
                result = await session.execute(
                    select(Alert.status, func.count(Alert.id)).group_by(Alert.status)
                )
                status_counts = {row[0].value: row[1] for row in result.all()}

                # Count by severity for new/open alerts
                result = await session.execute(
                    select(Alert.severity, func.count(Alert.id))
                    .where(Alert.status.in_([AlertStatus.NEW, AlertStatus.ACKNOWLEDGED, AlertStatus.ESCALATED]))
                    .group_by(Alert.severity)
                )
                severity_counts = {row[0].value: row[1] for row in result.all()}

                return {
                    "by_status": status_counts,
                    "by_severity": severity_counts,
                    "total_open": sum(
                        status_counts.get(s, 0)
                        for s in ["new", "acknowledged", "escalated", "investigating"]
                    ),
                }
        except Exception as e:
            logger.error("Alert stats failed: %s", e)
            return {}


# Singleton
alert_manager = AlertManager()
