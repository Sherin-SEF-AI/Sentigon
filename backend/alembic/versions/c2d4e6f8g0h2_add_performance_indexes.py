"""Add composite performance indexes for high-frequency query patterns.

Revision ID: c2d4e6f8g0h2
Revises: b1c3f5a8d901
Create Date: 2026-03-13
"""
from alembic import op

revision = "c2d4e6f8g0h2"
down_revision = "b1c3f5a8d901"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── alerts ────────────────────────────────────────────────
    op.create_index(
        "ix_alerts_severity_status_created",
        "alerts",
        ["severity", "status", "created_at"],
    )
    op.create_index(
        "ix_alerts_source_camera_created",
        "alerts",
        ["source_camera", "created_at"],
    )
    op.create_index(
        "ix_alerts_assigned_status",
        "alerts",
        ["assigned_to", "status"],
    )

    # ── events ────────────────────────────────────────────────
    op.create_index(
        "ix_events_camera_timestamp",
        "events",
        ["camera_id", "timestamp"],
    )
    op.create_index(
        "ix_events_type_severity",
        "events",
        ["event_type", "severity"],
    )
    op.create_index(
        "ix_events_zone_timestamp",
        "events",
        ["zone_id", "timestamp"],
    )

    # ── recordings ────────────────────────────────────────────
    op.create_index(
        "ix_recordings_camera_start",
        "recordings",
        ["camera_id", "start_time"],
    )

    # ── audit_logs ────────────────────────────────────────────
    op.create_index(
        "ix_audit_logs_user_timestamp",
        "audit_logs",
        ["user_id", "timestamp"],
    )
    op.create_index(
        "ix_audit_logs_resource_timestamp",
        "audit_logs",
        ["resource_type", "timestamp"],
    )

    # ── cases ─────────────────────────────────────────────────
    op.create_index(
        "ix_cases_status_priority",
        "cases",
        ["status", "priority"],
    )
    op.create_index(
        "ix_cases_assigned_status",
        "cases",
        ["assigned_to", "status"],
    )


def downgrade() -> None:
    op.drop_index("ix_cases_assigned_status", table_name="cases")
    op.drop_index("ix_cases_status_priority", table_name="cases")
    op.drop_index("ix_audit_logs_resource_timestamp", table_name="audit_logs")
    op.drop_index("ix_audit_logs_user_timestamp", table_name="audit_logs")
    op.drop_index("ix_recordings_camera_start", table_name="recordings")
    op.drop_index("ix_events_zone_timestamp", table_name="events")
    op.drop_index("ix_events_type_severity", table_name="events")
    op.drop_index("ix_events_camera_timestamp", table_name="events")
    op.drop_index("ix_alerts_assigned_status", table_name="alerts")
    op.drop_index("ix_alerts_source_camera_created", table_name="alerts")
    op.drop_index("ix_alerts_severity_status_created", table_name="alerts")
