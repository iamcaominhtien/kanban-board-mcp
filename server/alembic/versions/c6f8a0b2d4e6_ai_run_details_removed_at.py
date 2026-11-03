"""OPS-7: mark a run whose details (transcript, steps, prompt) the run history retention removed

Additive and nullable: every existing run starts with it empty (nothing removed), as before.

Revision ID: c6f8a0b2d4e6
Revises: b5e7d9f1a3c4
Create Date: 2026-11-02 23:55:00.000000

"""

from typing import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c6f8a0b2d4e6"
down_revision: str | Sequence[str] | None = "b5e7d9f1a3c4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("ai_run") as batch_op:
        batch_op.add_column(sa.Column("details_removed_at", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("ai_run") as batch_op:
        batch_op.drop_column("details_removed_at")
