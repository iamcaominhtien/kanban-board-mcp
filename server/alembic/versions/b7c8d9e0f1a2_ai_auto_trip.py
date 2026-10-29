"""AI auto-trip rules per project (switches and thresholds).

Revision ID: b7c8d9e0f1a2
Revises: a6b7c8d9e0f1
Create Date: 2026-10-29
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b7c8d9e0f1a2"
down_revision: Union[str, Sequence[str], None] = "a6b7c8d9e0f1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add ai_project_settings.auto_trip."""
    with op.batch_alter_table("ai_project_settings") as batch:
        batch.add_column(
            sa.Column("auto_trip", sa.String(), nullable=False, server_default="{}")
        )


def downgrade() -> None:
    """Drop ai_project_settings.auto_trip."""
    with op.batch_alter_table("ai_project_settings") as batch:
        batch.drop_column("auto_trip")
