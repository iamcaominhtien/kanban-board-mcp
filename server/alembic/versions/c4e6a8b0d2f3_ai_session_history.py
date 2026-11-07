"""AI v2: the history of a team's conversations on a ticket.

A team's lead keeps one Claude Code conversation on a ticket. When a person starts it over, the old one is closed into a
row here: a title, a summary and the ids of its sessions and runs. Other AIs read these rows (`ai_run` action `history`)
and a new conversation is told of the last ones.

Revision ID: c4e6a8b0d2f3
Revises: b3d5f7a9c1e4
Create Date: 2026-11-07
"""

from typing import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op

from dbkit.types import LongText

revision: str = "c4e6a8b0d2f3"
down_revision: str | Sequence[str] | None = "b3d5f7a9c1e4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_S = sqlmodel.sql.sqltypes.AutoString


def upgrade() -> None:
    """Make the table and its indexes unless a database made from the models already has them."""
    insp = sa.inspect(op.get_bind())
    if not insp.has_table("ai_session_history"):
        op.create_table(
            "ai_session_history",
            sa.Column("id", _S(), nullable=False),
            sa.Column("project_id", _S(), nullable=False),
            sa.Column("ticket_id", _S(), nullable=False),
            sa.Column("member_id", _S(), nullable=False),
            sa.Column("title", LongText(), nullable=False),
            sa.Column("summary", LongText(), nullable=False),
            sa.Column("session_ids", LongText(), nullable=False),
            sa.Column("run_ids", LongText(), nullable=False),
            sa.Column("started_at", LongText(), nullable=True),
            sa.Column("ended_at", LongText(), nullable=False),
            sa.Column("created_by", LongText(), nullable=False),
            sa.Column("summarised_by", LongText(), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
    existing = {
        ix["name"] for ix in sa.inspect(op.get_bind()).get_indexes("ai_session_history")
    }
    for name, column in (
        ("ix_ai_session_history_project_id", "project_id"),
        ("ix_ai_session_history_ticket_id", "ticket_id"),
    ):
        if name not in existing:
            op.create_index(name, "ai_session_history", [column], unique=False)


def downgrade() -> None:
    """Drop the table."""
    if sa.inspect(op.get_bind()).has_table("ai_session_history"):
        op.drop_table("ai_session_history")
