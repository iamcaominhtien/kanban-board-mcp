"""AI v2 repair: add the columns a pre-release run of the AI v2 reset did not make yet.

The reset migration (a2b4c6d8e0f1) gained `ai_run.live`, `ai_run.waiting_reason`, `ai_run_agent.claude_id`,
`ai_run_step.tool_id` and its index after a development build had already applied it to one database (2026-11-05).
A database made by the final reset already has them: this adds only what is missing.

Revision ID: b3d5f7a9c1e4
Revises: a2b4c6d8e0f1
Create Date: 2026-11-05
"""

from typing import Sequence

import sqlalchemy as sa
from alembic import op

from dbkit.types import LongText

revision: str = "b3d5f7a9c1e4"
down_revision: str | Sequence[str] | None = "a2b4c6d8e0f1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

COLUMNS = [
    (
        "ai_run",
        sa.Column("live", sa.Boolean(), nullable=False, server_default=sa.false()),
    ),
    ("ai_run", sa.Column("waiting_reason", LongText(), nullable=True)),
    ("ai_run_agent", sa.Column("claude_id", LongText(), nullable=True)),
    ("ai_run_step", sa.Column("tool_id", LongText(), nullable=True)),
]


def upgrade() -> None:
    """Add each missing column, then the index on ai_run_step.tool_id."""
    insp = sa.inspect(op.get_bind())
    tables = set(insp.get_table_names())
    for table, column in COLUMNS:
        if table not in tables:
            continue
        if column.name in {c["name"] for c in insp.get_columns(table)}:
            continue
        with op.batch_alter_table(table) as batch_op:
            batch_op.add_column(column)
    if "ai_run_step" in tables:
        names = {
            ix["name"] for ix in sa.inspect(op.get_bind()).get_indexes("ai_run_step")
        }
        if "ix_ai_run_step_tool_id" not in names:
            op.create_index("ix_ai_run_step_tool_id", "ai_run_step", ["tool_id"])


def downgrade() -> None:
    """Nothing: the reset migration owns these columns."""
