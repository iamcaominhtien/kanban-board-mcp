"""ai_origin: where a person's decision or run start came from (a tool acting for them)

Revision ID: d4e6f8a0b123
Revises: c3d5e7f9a012
Create Date: 2026-10-31 13:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d4e6f8a0b123"
down_revision: Union[str, Sequence[str], None] = "c3d5e7f9a012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("ai_approval") as batch_op:
        batch_op.add_column(sa.Column("decided_via", sa.String(), nullable=True))
    with op.batch_alter_table("ai_run") as batch_op:
        batch_op.add_column(sa.Column("started_via", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("ai_run") as batch_op:
        batch_op.drop_column("started_via")
    with op.batch_alter_table("ai_approval") as batch_op:
        batch_op.drop_column("decided_via")
