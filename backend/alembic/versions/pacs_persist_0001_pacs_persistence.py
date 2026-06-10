"""pacs persistence — doors + badge holders

Revision ID: pacs_persist_0001
Revises: 69da4343ec10
Create Date: 2026-06-09
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "pacs_persist_0001"
down_revision: Union[str, None] = "69da4343ec10"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "pacs_doors",
        sa.Column("door_id", sa.String(64), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("location", sa.String(255), server_default=""),
        sa.Column("zone", sa.String(128), server_default=""),
        sa.Column("locked", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("reader_in", sa.String(64), nullable=True),
        sa.Column("reader_out", sa.String(64), nullable=True),
        sa.Column("held_open_timeout", sa.Integer(), server_default="30"),
        sa.Column("requires_access_level", sa.Integer(), server_default="1"),
        sa.Column("anti_passback_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("camera_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_table(
        "pacs_badge_holders",
        sa.Column("card_number", sa.String(64), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("department", sa.String(128), server_default=""),
        sa.Column("access_level", sa.Integer(), server_default="0"),
        sa.Column("zones_allowed", postgresql.JSONB(), nullable=True),
        sa.Column("valid_from", sa.DateTime(timezone=True), nullable=True),
        sa.Column("valid_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("photo_url", sa.String(512), nullable=True),
        sa.Column("anti_passback_zone", sa.String(128), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )


def downgrade() -> None:
    op.drop_table("pacs_badge_holders")
    op.drop_table("pacs_doors")
