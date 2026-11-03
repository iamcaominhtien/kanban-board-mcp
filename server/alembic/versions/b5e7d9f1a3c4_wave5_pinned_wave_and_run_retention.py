"""wave 5: a sub-ticket's pinned execution wave (TDP-1) and the run history retention (OPS-7)

Both columns are nullable and start empty for every existing row: a ticket with no pinned wave computes it from
Blocked by, and a project with no run retention keeps every run forever, as before.

Revision ID: b5e7d9f1a3c4
Revises: a7c9e1f3b5d8
Create Date: 2026-11-02 23:30:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b5e7d9f1a3c4"
down_revision: Union[str, Sequence[str], None] = "a7c9e1f3b5d8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("ticket") as batch_op:
        batch_op.add_column(sa.Column("wave_pin", sa.Integer(), nullable=True))
    with op.batch_alter_table("ai_project_settings") as batch_op:
        batch_op.add_column(
            sa.Column("run_retention_days", sa.Integer(), nullable=True)
        )


def downgrade() -> None:
    with op.batch_alter_table("ai_project_settings") as batch_op:
        batch_op.drop_column("run_retention_days")
    with op.batch_alter_table("ticket") as batch_op:
        batch_op.drop_column("wave_pin")
