"""add_project_worktree_settings

Revision ID: f7a8b9c0d1e2
Revises: e6f7a8b9c0d1
Create Date: 2026-10-04 00:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f7a8b9c0d1e2"
down_revision: Union[str, Sequence[str], None] = "e6f7a8b9c0d1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("project") as batch_op:
        batch_op.add_column(sa.Column("worktree_template", sa.String(), nullable=True))
        batch_op.add_column(
            sa.Column(
                "worktree_by_default",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("project") as batch_op:
        batch_op.drop_column("worktree_by_default")
        batch_op.drop_column("worktree_template")
