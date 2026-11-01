"""ai_run_context

Revision ID: e7f1a2b3c4d5
Revises: c3d9a1b7e5f2
Create Date: 2026-10-30 00:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e7f1a2b3c4d5"
down_revision: Union[str, Sequence[str], None] = "c3d9a1b7e5f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("ai_run") as batch_op:
        batch_op.add_column(sa.Column("context_used", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("context_window", sa.Integer(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("ai_run") as batch_op:
        batch_op.drop_column("context_window")
        batch_op.drop_column("context_used")
