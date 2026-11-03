"""ai_repo_scan_job: the AI setting up a project's commands (its job and its proposal)

Revision ID: a7c9e1f3b5d8
Revises: e1f3a5c7b9d2
Create Date: 2026-11-02 00:00:00.000000

"""

from typing import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a7c9e1f3b5d8"
down_revision: str | Sequence[str] | None = "e1f3a5c7b9d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("ai_repo_scan") as batch_op:
        batch_op.add_column(
            sa.Column("job", sa.String(), nullable=False, server_default="{}")
        )
        batch_op.add_column(
            sa.Column("proposal", sa.String(), nullable=False, server_default="{}")
        )


def downgrade() -> None:
    with op.batch_alter_table("ai_repo_scan") as batch_op:
        batch_op.drop_column("proposal")
        batch_op.drop_column("job")
