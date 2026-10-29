"""AI schedules: an AI member works on a ticket at a set time, and each slot's outcome.

Revision ID: c2d3e4f5a6b7
Revises: b1c2d3e4f5a6
Create Date: 2026-10-29
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c2d3e4f5a6b7"
down_revision: Union[str, Sequence[str], None] = "b1c2d3e4f5a6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _s(name: str, *args, **kw) -> sa.Column:
    return sa.Column(name, sa.String(), *args, **kw)


def upgrade() -> None:
    """Create the schedule tables."""
    op.create_table(
        "ai_schedule",
        _s("id", primary_key=True),
        _s("project_id", sa.ForeignKey("project.id"), nullable=False, index=True),
        _s("ticket_id", nullable=False, index=True),
        _s("member_id", nullable=False, index=True),
        _s("backup_member_id", nullable=True),
        _s("created_by", nullable=False, server_default="user"),
        _s("kind", nullable=False, server_default="repeat"),
        _s("run_at", nullable=True),
        _s("days", nullable=False, server_default="[0,1,2,3,4]"),
        _s("time", nullable=False, server_default="02:00"),
        _s("tz", nullable=False, server_default="UTC"),
        _s("ends", nullable=False, server_default="never"),
        sa.Column("ends_after", sa.Integer(), nullable=True),
        _s("ends_on", nullable=True),
        _s("window_end", nullable=True),
        _s("checks", nullable=False, server_default="{}"),
        _s("review", nullable=False, server_default="{}"),
        _s("limits", nullable=False, server_default="{}"),
        _s("catch_up", nullable=False, server_default="run"),
        sa.Column("catch_up_hours", sa.Float(), nullable=False, server_default="2"),
        _s("notify", nullable=False, server_default="[]"),
        _s("notify_people", nullable=False, server_default="[]"),
        _s("instruction", nullable=False, server_default=""),
        _s("state", nullable=False, server_default="active", index=True),
        _s("paused_reason", nullable=True),
        sa.Column("failures_in_row", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("runs_count", sa.Integer(), nullable=False, server_default="0"),
        _s("next_run_at", nullable=True, index=True),
        _s("ticket_seen_at", nullable=True),
        _s("created_at", nullable=False),
        _s("updated_at", nullable=False),
    )
    op.create_table(
        "ai_schedule_run",
        _s("id", primary_key=True),
        _s("schedule_id", sa.ForeignKey("ai_schedule.id"), nullable=False, index=True),
        _s("project_id", nullable=False, index=True),
        _s("ticket_id", nullable=False, index=True),
        _s("slot_at", nullable=False),
        _s("state", nullable=False, server_default="waiting", index=True),
        sa.Column("catch_up", sa.Boolean(), nullable=False, server_default=sa.false()),
        _s("member_id", nullable=True),
        _s("run_ids", nullable=False, server_default="[]"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("fix_round", sa.Integer(), nullable=False, server_default="0"),
        _s("results", nullable=False, server_default="[]"),
        _s("review", nullable=False, server_default="{}"),
        _s("note", nullable=True),
        _s("started_at", nullable=True),
        _s("ended_at", nullable=True),
        sa.Column("duration_s", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cost_usd", sa.Float(), nullable=False, server_default="0"),
        _s("created_at", nullable=False),
        _s("updated_at", nullable=False),
    )
    op.create_index(
        "ux_ai_schedule_slot",
        "ai_schedule_run",
        ["schedule_id", "slot_at"],
        unique=True,
    )


def downgrade() -> None:
    """Drop the schedule tables."""
    op.drop_index("ux_ai_schedule_slot", table_name="ai_schedule_run")
    op.drop_table("ai_schedule_run")
    op.drop_table("ai_schedule")
