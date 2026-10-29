"""ai: run limits apply to scheduled and AI-started runs only (new defaults: 15 per ticket, 100 per board); a Board AI
chat keeps one Claude Code session (ai_chat.session_id)

Revision ID: e8f9a0b1c2d3
Revises: d7e8f9a0b1c2
Create Date: 2026-10-29 16:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e8f9a0b1c2d3"
down_revision: Union[str, Sequence[str], None] = "d7e8f9a0b1c2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("ai_chat") as batch:
        batch.add_column(sa.Column("session_id", sa.String(), nullable=True))
    # Only settings still at the old defaults move; a value somebody chose stays as it is
    op.execute(
        "UPDATE ai_project_settings SET runs_per_ticket_per_day = 15 WHERE runs_per_ticket_per_day = 6"
    )
    op.execute(
        "UPDATE ai_project_settings SET board_runs_per_day = 100 WHERE board_runs_per_day = 60"
    )


def downgrade() -> None:
    with op.batch_alter_table("ai_chat") as batch:
        batch.drop_column("session_id")
