"""Story (a ticket the PM owns from the goal to Done) and the decisions the PM took in a person's place

Revision ID: d8e0f2a4b6c8
Revises: c5d7e9f1a3b6
Create Date: 2026-11-02 00:00:00.000000

"""

from typing import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d8e0f2a4b6c8"
down_revision: str | Sequence[str] | None = "c5d7e9f1a3b6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "story",
        sa.Column(
            "ticket_id", sa.String(), sa.ForeignKey("ticket.id"), primary_key=True
        ),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("state", sa.String(), nullable=False, server_default="draft"),
        sa.Column("approve", sa.String(), nullable=False, server_default="person"),
        sa.Column("budget_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("pm_id", sa.String(), nullable=True),
        sa.Column("plan", sa.String(), nullable=False, server_default="{}"),
        sa.Column("paused", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("review_note", sa.String(), nullable=True),
        sa.Column("history", sa.String(), nullable=False, server_default="[]"),
        sa.Column("meta", sa.String(), nullable=False, server_default="{}"),
        sa.Column("created_by", sa.String(), nullable=True),
        sa.Column("created_at", sa.String(), nullable=False),
        sa.Column("handed_at", sa.String(), nullable=True),
        sa.Column("started_at", sa.String(), nullable=True),
        sa.Column("closed_at", sa.String(), nullable=True),
    )
    op.create_index("ix_story_project_id", "story", ["project_id"])
    op.create_index("ix_story_state", "story", ["state"])
    op.create_table(
        "ai_decision",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("ticket_id", sa.String(), nullable=True),
        sa.Column("story_id", sa.String(), nullable=True),
        sa.Column("member_id", sa.String(), nullable=True),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("why", sa.String(), nullable=False, server_default=""),
        sa.Column("ref", sa.String(), nullable=False, server_default="{}"),
        sa.Column("state", sa.String(), nullable=False, server_default="in_effect"),
        sa.Column("overridden_by", sa.String(), nullable=True),
        sa.Column("overridden_at", sa.String(), nullable=True),
        sa.Column("override_note", sa.String(), nullable=True),
        sa.Column("at", sa.String(), nullable=False),
    )
    for c in ("project_id", "ticket_id", "story_id", "at"):
        op.create_index(f"ix_ai_decision_{c}", "ai_decision", [c])


def downgrade() -> None:
    op.drop_table("ai_decision")
    op.drop_table("story")
