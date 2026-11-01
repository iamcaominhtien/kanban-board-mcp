"""ai_pause_facts: what Pause all AI chose, saved for the banner and for Resume

Revision ID: a7c9e1f3b567
Revises: f6a8b0c2d345
Create Date: 2026-10-31 20:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a7c9e1f3b567"
down_revision: Union[str, Sequence[str], None] = "f6a8b0c2d345"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("ai_project_settings") as batch_op:
        batch_op.add_column(
            sa.Column(
                "paused_let_finish", sa.Boolean(), nullable=False, server_default="0"
            )
        )
        batch_op.add_column(
            sa.Column(
                "paused_safe_before", sa.Boolean(), nullable=False, server_default="0"
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("ai_project_settings") as batch_op:
        batch_op.drop_column("paused_safe_before")
        batch_op.drop_column("paused_let_finish")
