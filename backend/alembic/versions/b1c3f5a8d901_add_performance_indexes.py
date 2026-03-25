"""Add performance indexes on frequently queried columns.

Revision ID: b1c3f5a8d901
Revises: a0320c41e922
Create Date: 2026-03-05
"""
from alembic import op

revision = "b1c3f5a8d901"
down_revision = "a0320c41e922"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index("ix_alerts_created_at", "alerts", ["created_at"])
    op.create_index("ix_alerts_severity", "alerts", ["severity"])
    op.create_index("ix_alerts_threat_type", "alerts", ["threat_type"])
    op.create_index("ix_events_timestamp", "events", ["timestamp"])
    op.create_index("ix_events_event_type", "events", ["event_type"])
    op.create_index("ix_events_camera_id", "events", ["camera_id"])


def downgrade() -> None:
    op.drop_index("ix_events_camera_id", table_name="events")
    op.drop_index("ix_events_event_type", table_name="events")
    op.drop_index("ix_events_timestamp", table_name="events")
    op.drop_index("ix_alerts_threat_type", table_name="alerts")
    op.drop_index("ix_alerts_severity", table_name="alerts")
    op.drop_index("ix_alerts_created_at", table_name="alerts")
