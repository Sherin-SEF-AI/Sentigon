"""intercom persistence — devices

Revision ID: intercom_persist_0003
Revises: alarm_persist_0002
Create Date: 2026-06-09
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "intercom_persist_0003"
down_revision: Union[str, None] = "alarm_persist_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "intercom_devices",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("zone", sa.String(128), server_default=""),
        sa.Column("ip_address", sa.String(64), server_default=""),
        sa.Column("sip_uri", sa.String(255), server_default=""),
        sa.Column("has_door_release", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("has_camera", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("camera_id", sa.String(64), nullable=True),
        sa.Column("volume", sa.Integer(), server_default="75"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("intercom_devices")
