"""ai_run_tokens_cached

Revision ID: c3d5e7f9a012
Revises: b8c2d4e6f801
Create Date: 2026-10-31 12:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c3d5e7f9a012"
down_revision: Union[str, Sequence[str], None] = "b8c2d4e6f801"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("ai_run") as batch_op:
        batch_op.add_column(sa.Column("tokens_cached", sa.Integer(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("ai_run") as batch_op:
        batch_op.drop_column("tokens_cached")
