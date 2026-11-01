"""ai_autopilot: ask-before-Docs-edits switch and the Autopilot delegation

Revision ID: f6a8b0c2d345
Revises: e5f7a9b1c234
Create Date: 2026-10-31 18:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f6a8b0c2d345"
down_revision: Union[str, Sequence[str], None] = "e5f7a9b1c234"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("ai_project_settings") as batch_op:
        batch_op.add_column(
            sa.Column(
                "docs_edits_ask", sa.Boolean(), nullable=False, server_default="0"
            )
        )
        batch_op.add_column(
            sa.Column("autopilot", sa.String(), nullable=False, server_default="{}")
        )


def downgrade() -> None:
    with op.batch_alter_table("ai_project_settings") as batch_op:
        batch_op.drop_column("autopilot")
        batch_op.drop_column("docs_edits_ask")
