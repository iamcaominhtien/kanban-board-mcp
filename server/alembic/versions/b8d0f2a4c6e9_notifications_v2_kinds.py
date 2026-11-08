"""Notifications: drop the kinds AI v2 no longer sends.

KBM-38: the board has no approval layer, so `approval` ("An approval request") and `blocked` ("An AI was blocked by a
permission") are gone, and a restart for memory is written on the run instead of being a notification
(`run_restarted`). The `story_*` kinds were never sent by anything. Their old rows and events are deleted; nothing
reads them any more.

Revision ID: b8d0f2a4c6e9
Revises: f7b9d1e3a5c7
Create Date: 2026-11-08
"""

from typing import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b8d0f2a4c6e9"
down_revision: str | Sequence[str] | None = "f7b9d1e3a5c7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

KINDS = (
    "approval",
    "blocked",
    "run_restarted",
    "story_plan",
    "story_blocked",
    "story_done",
)


def upgrade() -> None:
    """Delete the rows and events of the removed kinds."""
    names = ", ".join(f"'{k}'" for k in KINDS)
    bind = op.get_bind()
    have = set(sa.inspect(bind).get_table_names())
    for table in ("notification", "notify_event"):
        if table in have:
            op.execute(sa.text(f"DELETE FROM {table} WHERE kind IN ({names})"))


def downgrade() -> None:
    """Nothing to restore: the deleted rows are not kept."""
