"""ai_resources: RAM of a run's CLI (peak, last, restarts), the memory limit and a member's resource tools

Revision ID: b8d0f2a4c678
Revises: a7c9e1f3b567
Create Date: 2026-10-31 21:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b8d0f2a4c678"
down_revision: Union[str, Sequence[str], None] = "a7c9e1f3b567"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("ai_run") as batch_op:
        batch_op.add_column(sa.Column("peak_rss_mb", sa.Float(), nullable=True))
        batch_op.add_column(sa.Column("last_rss_mb", sa.Float(), nullable=True))
        batch_op.add_column(
            sa.Column("restarts", sa.String(), nullable=False, server_default="[]")
        )
    with op.batch_alter_table("ai_member") as batch_op:
        batch_op.add_column(
            sa.Column(
                "resource_access", sa.String(), nullable=False, server_default="none"
            )
        )
    with op.batch_alter_table("ai_project_settings") as batch_op:
        batch_op.add_column(
            sa.Column(
                "run_memory_limit_mb",
                sa.Integer(),
                nullable=False,
                server_default="4096",
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("ai_project_settings") as batch_op:
        batch_op.drop_column("run_memory_limit_mb")
    with op.batch_alter_table("ai_member") as batch_op:
        batch_op.drop_column("resource_access")
    with op.batch_alter_table("ai_run") as batch_op:
        batch_op.drop_column("restarts")
        batch_op.drop_column("last_rss_mb")
        batch_op.drop_column("peak_rss_mb")
