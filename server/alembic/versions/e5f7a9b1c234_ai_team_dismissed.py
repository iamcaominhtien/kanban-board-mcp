"""ai_team_dismissed: suggestions dismissed in AI Team › Health

Revision ID: e5f7a9b1c234
Revises: d4e6f8a0b123
Create Date: 2026-10-31 14:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e5f7a9b1c234"
down_revision: Union[str, Sequence[str], None] = "d4e6f8a0b123"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("ai_project_settings") as batch_op:
        batch_op.add_column(
            sa.Column(
                "team_dismissed", sa.String(), nullable=False, server_default="[]"
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("ai_project_settings") as batch_op:
        batch_op.drop_column("team_dismissed")
