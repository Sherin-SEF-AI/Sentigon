"""alarm persistence — panels + zones

Revision ID: alarm_persist_0002
Revises: pacs_persist_0001
Create Date: 2026-06-09
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "alarm_persist_0002"
down_revision: Union[str, None] = "pacs_persist_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "alarm_panels",
        sa.Column("panel_id", sa.String(64), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("model", sa.String(128), server_default=""),
        sa.Column("ip_address", sa.String(64), server_default=""),
        sa.Column("port", sa.Integer(), server_default="0"),
        sa.Column("arm_state", sa.String(32), server_default="disarmed"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_table(
        "alarm_zones",
        sa.Column("panel_id", sa.String(64), sa.ForeignKey("alarm_panels.panel_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("zone_number", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("zone_type", sa.String(32), server_default="burglary"),
        sa.Column("partition", sa.Integer(), server_default="1"),
        sa.Column("camera_id", sa.Integer(), nullable=True),
        sa.Column("bypassed", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("alarm_zones")
    op.drop_table("alarm_panels")
