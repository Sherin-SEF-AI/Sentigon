"""Celery background tasks for SENTINEL AI.

Tasks run outside the async FastAPI process and use synchronous DB
sessions where needed.  Heavy or periodic work belongs here.
"""

from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict

from backend.tasks.celery_app import celery_app
from backend.config import settings

logger = logging.getLogger(__name__)


# ─── Helpers ─────────────────────────────────────────────────────────

def _get_sync_session():
    """Create a synchronous SQLAlchemy session for Celery workers."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(
        settings.DATABASE_URL_SYNC,
        pool_size=5,
        max_overflow=2,
        pool_pre_ping=True,
    )
    Session = sessionmaker(bind=engine)
    return Session()


# ─── Task: Periodic Escalation Check ────────────────────────────────

@celery_app.task(
    name="sentinel.periodic_escalation_check",
    bind=True,
    max_retries=3,
    default_retry_delay=30,
)
def periodic_escalation_check(self) -> Dict[str, Any]:
    """Check for alerts that should be auto-escalated.

    Walks all NEW alerts and escalates any whose age exceeds the
    severity-specific timeout defined in AlertManager.
    """
    from backend.models.models import Alert, AlertStatus, AlertSeverity

    escalation_timeouts = {
        "critical": 120,
        "high": 300,
        "medium": 900,
        "low": 3600,
    }

    session = _get_sync_session()
    escalated_ids = []

    try:
        now = datetime.now(timezone.utc)
        alerts = (
            session.query(Alert)
            .filter(Alert.status == AlertStatus.NEW)
            .all()
        )

        for alert in alerts:
            timeout = escalation_timeouts.get(alert.severity.value, 900)
            created = alert.created_at
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)

            if (now - created).total_seconds() > timeout:
                alert.status = AlertStatus.ESCALATED
                escalated_ids.append(str(alert.id))

        if escalated_ids:
            session.commit()
            logger.warning(
                "Escalated %d alerts: %s", len(escalated_ids), escalated_ids,
            )
        else:
            logger.info("Escalation check: no alerts to escalate")

        return {
            "status": "completed",
            "escalated_count": len(escalated_ids),
            "escalated_ids": escalated_ids,
            "checked_at": now.isoformat(),
        }

    except Exception as exc:
        logger.exception("Escalation check failed")
        session.rollback()
        raise self.retry(exc=exc)

    finally:
        session.close()


# ─── Task: Generate Report ──────────────────────────────────────────

@celery_app.task(
    name="sentinel.generate_report",
    bind=True,
    max_retries=2,
    default_retry_delay=60,
)
def generate_report(
    self,
    report_type: str = "daily",
    date_str: str | None = None,
) -> Dict[str, Any]:
    """Generate an analytics report for the specified period.

    Parameters
    ----------
    report_type : str
        One of ``"daily"``, ``"weekly"``, ``"monthly"``.
    date_str : str | None
        ISO date string for the report anchor date.  Defaults to
        yesterday (daily) or the most recent completed period.
    """
    from sqlalchemy import func
    from backend.models.models import Alert, Event, AlertSeverity, AlertStatus

    session = _get_sync_session()

    try:
        now = datetime.now(timezone.utc)

        if date_str:
            anchor = datetime.fromisoformat(date_str).replace(tzinfo=timezone.utc)
        else:
            anchor = now - timedelta(days=1)

        # Determine window
        if report_type == "daily":
            start = anchor.replace(hour=0, minute=0, second=0, microsecond=0)
            end = start + timedelta(days=1)
        elif report_type == "weekly":
            start = anchor - timedelta(days=anchor.weekday())
            start = start.replace(hour=0, minute=0, second=0, microsecond=0)
            end = start + timedelta(weeks=1)
        elif report_type == "monthly":
            start = anchor.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
            if start.month == 12:
                end = start.replace(year=start.year + 1, month=1)
            else:
                end = start.replace(month=start.month + 1)
        else:
            start = anchor - timedelta(days=1)
            end = anchor

        # Aggregate alert counts
        alert_counts = dict(
            session.query(Alert.severity, func.count(Alert.id))
            .filter(Alert.created_at.between(start, end))
            .group_by(Alert.severity)
            .all()
        )

        status_counts = dict(
            session.query(Alert.status, func.count(Alert.id))
            .filter(Alert.created_at.between(start, end))
            .group_by(Alert.status)
            .all()
        )

        # Event counts
        total_events = (
            session.query(func.count(Event.id))
            .filter(Event.timestamp.between(start, end))
            .scalar()
        ) or 0

        event_type_counts = dict(
            session.query(Event.event_type, func.count(Event.id))
            .filter(Event.timestamp.between(start, end))
            .group_by(Event.event_type)
            .all()
        )

        report = {
            "report_type": report_type,
            "period_start": start.isoformat(),
            "period_end": end.isoformat(),
            "generated_at": now.isoformat(),
            "alerts": {
                "by_severity": {
                    (k.value if hasattr(k, "value") else str(k)): v
                    for k, v in alert_counts.items()
                },
                "by_status": {
                    (k.value if hasattr(k, "value") else str(k)): v
                    for k, v in status_counts.items()
                },
                "total": sum(alert_counts.values()),
            },
            "events": {
                "total": total_events,
                "by_type": event_type_counts,
            },
        }

        logger.info(
            "Report generated: type=%s period=%s..%s alerts=%d events=%d",
            report_type,
            start.date().isoformat(),
            end.date().isoformat(),
            report["alerts"]["total"],
            total_events,
        )
        return report

    except Exception as exc:
        logger.exception("Report generation failed")
        raise self.retry(exc=exc)

    finally:
        session.close()


# ─── Task: Cleanup Old Recordings ───────────────────────────────────

@celery_app.task(
    name="sentinel.cleanup_old_recordings",
    bind=True,
    max_retries=2,
    default_retry_delay=120,
)
def cleanup_old_recordings(
    self,
    retention_days: int = 30,
) -> Dict[str, Any]:
    """Delete recording files and rows older than *retention_days*.

    Parameters
    ----------
    retention_days : int
        Recordings older than this many days will be purged.
    """
    from backend.models.models import Recording

    session = _get_sync_session()
    deleted_files = 0
    deleted_rows = 0
    errors = []

    try:
        cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)

        recordings = (
            session.query(Recording)
            .filter(Recording.start_time < cutoff)
            .all()
        )

        for rec in recordings:
            # Remove file from disk
            if rec.file_path and os.path.isfile(rec.file_path):
                try:
                    os.remove(rec.file_path)
                    deleted_files += 1
                except OSError as exc:
                    errors.append(
                        f"Failed to delete {rec.file_path}: {exc}"
                    )
                    logger.warning(
                        "Could not delete recording file %s: %s",
                        rec.file_path, exc,
                    )

            session.delete(rec)
            deleted_rows += 1

        session.commit()
        logger.info(
            "Cleanup completed: %d files removed, %d rows deleted, "
            "%d errors (retention=%d days)",
            deleted_files, deleted_rows, len(errors), retention_days,
        )

        return {
            "status": "completed",
            "retention_days": retention_days,
            "cutoff": cutoff.isoformat(),
            "deleted_files": deleted_files,
            "deleted_rows": deleted_rows,
            "errors": errors,
        }

    except Exception as exc:
        logger.exception("Recording cleanup failed")
        session.rollback()
        raise self.retry(exc=exc)

    finally:
        session.close()


# ─── Task: Reindex Vectors ──────────────────────────────────────────

@celery_app.task(
    name="sentinel.reindex_vectors",
    bind=True,
    max_retries=1,
    default_retry_delay=300,
)
def reindex_vectors(
    self,
    batch_size: int = 200,
    days_back: int = 7,
) -> Dict[str, Any]:
    """Re-embed and upsert recent events into the Qdrant vector store.

    Useful after an embedding model upgrade or a Qdrant collection
    rebuild.

    Parameters
    ----------
    batch_size : int
        Number of events to process per DB query batch.
    days_back : int
        Only reindex events from the last *days_back* days.
    """
    from backend.models.models import Event
    from backend.services.vector_store import vector_store

    session = _get_sync_session()
    indexed = 0
    skipped = 0
    errors = 0

    try:
        # Ensure vector store is ready
        vector_store.initialize()

        cutoff = datetime.now(timezone.utc) - timedelta(days=days_back)
        offset = 0

        while True:
            events = (
                session.query(Event)
                .filter(Event.timestamp >= cutoff)
                .order_by(Event.timestamp.asc())
                .offset(offset)
                .limit(batch_size)
                .all()
            )

            if not events:
                break

            for ev in events:
                description = ev.description or ev.event_type or ""
                if not description.strip():
                    skipped += 1
                    continue

                ev_ts = ev.timestamp
                if ev_ts and ev_ts.tzinfo is None:
                    ev_ts = ev_ts.replace(tzinfo=timezone.utc)

                success = vector_store.upsert_event(
                    event_id=str(ev.id),
                    description=description,
                    metadata={
                        "camera_id": str(ev.camera_id) if ev.camera_id else "",
                        "event_type": ev.event_type or "",
                        "timestamp": ev_ts.isoformat() if ev_ts else "",
                        "severity": ev.severity.value if ev.severity else "info",
                    },
                )
                if success:
                    indexed += 1
                else:
                    errors += 1

            offset += batch_size
            logger.info(
                "Reindex progress: indexed=%d skipped=%d errors=%d",
                indexed, skipped, errors,
            )

        logger.info(
            "Vector reindex completed: indexed=%d skipped=%d errors=%d "
            "(days_back=%d)",
            indexed, skipped, errors, days_back,
        )

        return {
            "status": "completed",
            "indexed": indexed,
            "skipped": skipped,
            "errors": errors,
            "days_back": days_back,
        }

    except Exception as exc:
        logger.exception("Vector reindex failed")
        raise self.retry(exc=exc)

    finally:
        session.close()
