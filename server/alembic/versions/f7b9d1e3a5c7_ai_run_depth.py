"""AI runs: how many AI-to-AI hand-offs lie behind a run (KBM-24).

A note an AI sends (`ai_run message`, the Board AI routing Docs threads, a team writing to a page) starts a run one
deeper than its sender; the send is refused at `runs.MAX_DEPTH`, so AIs cannot keep each other busy. A person's run is 0.

Revision ID: f7b9d1e3a5c7
Revises: e6a8c0d2f4b6
Create Date: 2026-11-07
"""

from typing import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f7b9d1e3a5c7"
down_revision: str | Sequence[str] | None = "e6a8c0d2f4b6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add the column unless a database made from the models already has it."""
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("ai_run")}
    if "depth" not in cols:
        with op.batch_alter_table("ai_run") as batch:
            batch.add_column(
                sa.Column("depth", sa.Integer(), nullable=False, server_default="0")
            )


def downgrade() -> None:
    """Drop the column."""
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("ai_run")}
    if "depth" in cols:
        with op.batch_alter_table("ai_run") as batch:
            batch.drop_column("depth")
