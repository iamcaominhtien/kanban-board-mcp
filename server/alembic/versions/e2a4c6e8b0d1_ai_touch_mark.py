"""AI v2: the mark a person gives to a touch ("You stepped in" tab: needed | avoidable) and the lesson made from it.

One small table, nullable lesson link, nothing else changes. The touches themselves are worked out from runs,
messages and the audit log; only the person's mark needs a place to live.

Revision ID: e2a4c6e8b0d1
Revises: d5f7b9c1e3a4
Create Date: 2026-11-07
"""

from typing import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "e2a4c6e8b0d1"
down_revision: str | Sequence[str] | None = "d5f7b9c1e3a4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_S = sqlmodel.sql.sqltypes.AutoString


def upgrade() -> None:
    """Make the table and its index unless a database made from the models already has them."""
    insp = sa.inspect(op.get_bind())
    if not insp.has_table("ai_touch_mark"):
        op.create_table(
            "ai_touch_mark",
            sa.Column("key", _S(), nullable=False),
            sa.Column("project_id", _S(), nullable=False),
            sa.Column("mark", _S(), nullable=False),
            sa.Column("marked_by", _S(), nullable=True),
            sa.Column("marked_at", _S(), nullable=False),
            sa.Column("lesson_id", _S(), nullable=True),
            sa.PrimaryKeyConstraint("key"),
        )
    existing = {
        ix["name"] for ix in sa.inspect(op.get_bind()).get_indexes("ai_touch_mark")
    }
    if "ix_ai_touch_mark_project_id" not in existing:
        op.create_index(
            "ix_ai_touch_mark_project_id", "ai_touch_mark", ["project_id"], unique=False
        )


def downgrade() -> None:
    """Drop the table."""
    if sa.inspect(op.get_bind()).has_table("ai_touch_mark"):
        op.drop_table("ai_touch_mark")
