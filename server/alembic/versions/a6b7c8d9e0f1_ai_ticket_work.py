"""AI work on tickets: pause, a second AI waiting for the hold, raised limits, answer feedback, stop codes.

Revision ID: a6b7c8d9e0f1
Revises: f5a6b7c8d9e0
Create Date: 2026-10-29
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a6b7c8d9e0f1"
down_revision: Union[str, Sequence[str], None] = "f5a6b7c8d9e0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

OLD_WHERE = (
    "mode = 'work' AND state IN ('queued', 'starting', 'running', 'needs_input')"
)
NEW_WHERE = (
    "mode = 'work' AND behind_run_id IS NULL "
    "AND state IN ('queued', 'starting', 'running', 'needs_input')"
)
NEW_COLUMNS = (
    "paused",
    "paused_at",
    "behind_run_id",
    "queue_after_current",
    "limit_min",
    "replaces_comment_id",
    "feedback",
    "stop_code",
    "blocked_move",
    "context_notes",
)


def upgrade() -> None:
    """Add the run columns and let a waiting run (`behind_run_id` set) sit beside the holder of the ticket."""
    op.drop_index("ux_ai_run_ticket_hold", table_name="ai_run")
    with op.batch_alter_table("ai_run") as batch_op:
        batch_op.add_column(
            sa.Column("paused", sa.Boolean(), nullable=False, server_default=sa.false())
        )
        batch_op.add_column(sa.Column("paused_at", sa.String(), nullable=True))
        batch_op.add_column(sa.Column("behind_run_id", sa.String(), nullable=True))
        batch_op.add_column(
            sa.Column(
                "queue_after_current",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            )
        )
        batch_op.add_column(sa.Column("limit_min", sa.Integer(), nullable=True))
        batch_op.add_column(
            sa.Column("replaces_comment_id", sa.String(), nullable=True)
        )
        batch_op.add_column(sa.Column("feedback", sa.String(), nullable=True))
        batch_op.add_column(sa.Column("stop_code", sa.String(), nullable=True))
        batch_op.add_column(sa.Column("blocked_move", sa.String(), nullable=True))
        batch_op.add_column(
            sa.Column("context_notes", sa.String(), nullable=False, server_default="[]")
        )
    op.create_index(
        "ux_ai_run_ticket_hold",
        "ai_run",
        ["ticket_id"],
        unique=True,
        sqlite_where=sa.text(NEW_WHERE),
    )


def downgrade() -> None:
    """Restore the one-active-work-run index and drop the columns."""
    op.drop_index("ux_ai_run_ticket_hold", table_name="ai_run")
    with op.batch_alter_table("ai_run") as batch_op:
        for name in reversed(NEW_COLUMNS):
            batch_op.drop_column(name)
    op.create_index(
        "ux_ai_run_ticket_hold",
        "ai_run",
        ["ticket_id"],
        unique=True,
        sqlite_where=sa.text(OLD_WHERE),
    )
