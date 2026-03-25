"""initial_schema

Revision ID: 69da4343ec10
Revises: 
Create Date: 2026-02-15 19:30:43.029008
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '69da4343ec10'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Tables created via Base.metadata.create_all() in main.py lifespan.
    # This migration serves as the baseline stamp for all existing tables.
    # To regenerate: alembic revision --autogenerate -m "initial_schema"
    pass


def downgrade() -> None:
    # Dropping all tables is handled by Base.metadata.drop_all() if needed.
    pass
