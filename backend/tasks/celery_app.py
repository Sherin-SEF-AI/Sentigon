"""Celery application setup for SENTINEL AI background tasks."""

from celery import Celery
from celery.schedules import crontab

from backend.config import settings

celery_app = Celery(
    "sentinel",
    broker=settings.CELERY_BROKER_URL,
)

celery_app.conf.update(
    result_backend=settings.REDIS_URL,
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    beat_schedule={
        "escalation-check-every-60s": {
            "task": "sentinel.periodic_escalation_check",
            "schedule": 60.0,
        },
        "daily-report": {
            "task": "sentinel.generate_report",
            "schedule": crontab(hour=1, minute=0),
            "kwargs": {"report_type": "daily"},
        },
        "weekly-cleanup": {
            "task": "sentinel.cleanup_old_recordings",
            "schedule": crontab(hour=3, minute=0, day_of_week="sunday"),
            "kwargs": {"retention_days": 30},
        },
    },
)

# Auto-discover tasks inside the tasks package
celery_app.autodiscover_tasks(["backend.tasks"])

# Explicit imports to guarantee registration
import backend.tasks.background_tasks  # noqa: F401, E402
