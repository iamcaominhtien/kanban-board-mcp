"""AI team v2 (docs/specs/ai-claude-code-implementation.md): run transcripts and search, skill use, account windows,
run diagnosis and retries

Revision ID: e6611f7871e7
Revises: a1b2c3d4e5f7
Create Date: 2026-11-02 01:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.exc import DBAPIError

revision: str = "e6611f7871e7"
down_revision: str | Sequence[str] | None = "a1b2c3d4e5f7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_RUN_FTS = (
    "CREATE VIRTUAL TABLE IF NOT EXISTS ai_run_fts USING fts5("
    "run_id UNINDEXED, project_id UNINDEXED, body, tokenize = 'unicode61 remove_diacritics 2')"
)


def upgrade() -> None:
    op.create_table(
        "ai_run_transcript",
        sa.Column("run_id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("member_id", sa.String(), nullable=True),
        sa.Column("path", sa.String(), nullable=False),
        sa.Column("bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("events", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("pinned", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("pinned_by", sa.String(), nullable=True),
        sa.Column("started_at", sa.String(), nullable=False),
        sa.Column("ended_at", sa.String(), nullable=True),
        sa.Column("deleted_at", sa.String(), nullable=True),
    )
    op.create_index(
        "ix_ai_run_transcript_project_id", "ai_run_transcript", ["project_id"]
    )
    op.create_index(
        "ix_ai_run_transcript_member_id", "ai_run_transcript", ["member_id"]
    )
    op.create_index("ix_ai_run_transcript_ended_at", "ai_run_transcript", ["ended_at"])

    op.create_table(
        "ai_skill_use",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("run_id", sa.String(), nullable=False),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("member_id", sa.String(), nullable=True),
        sa.Column("kind", sa.String(), nullable=False, server_default="skill"),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("plugin", sa.String(), nullable=True),
        sa.Column("at", sa.String(), nullable=False),
    )
    for column in ("run_id", "project_id", "member_id", "name", "plugin"):
        op.create_index(f"ix_ai_skill_use_{column}", "ai_skill_use", [column])

    with op.batch_alter_table("ai_run") as batch:
        batch.add_column(sa.Column("diagnosis", sa.String(), nullable=True))
        batch.add_column(sa.Column("retry_at", sa.String(), nullable=True))
        batch.add_column(
            sa.Column("retries", sa.String(), nullable=False, server_default="[]")
        )
        batch.add_column(sa.Column("account_id", sa.String(), nullable=True))

    op.create_table(
        "ai_account_state",
        sa.Column("key", sa.String(), primary_key=True),
        sa.Column("max_parallel", sa.Integer(), nullable=False, server_default="2"),
        sa.Column("move_urgent", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("five_hour_used", sa.Float(), nullable=True),
        sa.Column("five_hour_resets_at", sa.String(), nullable=True),
        sa.Column("five_hour_status", sa.String(), nullable=True),
        sa.Column("seven_day_used", sa.Float(), nullable=True),
        sa.Column("seven_day_resets_at", sa.String(), nullable=True),
        sa.Column("seven_day_status", sa.String(), nullable=True),
        sa.Column("held_until", sa.String(), nullable=True),
        sa.Column("held_reason", sa.String(), nullable=True),
        sa.Column("updated_at", sa.String(), nullable=True),
    )
    with op.batch_alter_table("ai_project_settings") as batch:
        batch.add_column(
            sa.Column("ops", sa.String(), nullable=False, server_default="{}")
        )
    op.create_table(
        "ai_ticket_flag",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("ticket_id", sa.String(), nullable=False),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("data", sa.String(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.String(), nullable=False),
        sa.Column("updated_at", sa.String(), nullable=False),
        sa.Column("resolved_at", sa.String(), nullable=True),
        sa.Column("resolved_by", sa.String(), nullable=True),
        sa.Column("resolution", sa.String(), nullable=True),
    )
    for column in ("ticket_id", "project_id", "kind"):
        op.create_index(f"ix_ai_ticket_flag_{column}", "ai_ticket_flag", [column])
    # NEXT-UPGRADE

    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        try:
            bind.execute(sa.text(_RUN_FTS))
        except DBAPIError:
            pass  # no FTS5 in this SQLite: search falls back to the run's own fields


def downgrade() -> None:
    # NEXT-DOWNGRADE
    for column in ("ticket_id", "project_id", "kind"):
        op.drop_index(f"ix_ai_ticket_flag_{column}", table_name="ai_ticket_flag")
    op.drop_table("ai_ticket_flag")
    with op.batch_alter_table("ai_project_settings") as batch:
        batch.drop_column("ops")
    op.drop_table("ai_account_state")
    with op.batch_alter_table("ai_run") as batch:
        for column in ("account_id", "retries", "retry_at", "diagnosis"):
            batch.drop_column(column)
    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        bind.execute(sa.text("DROP TABLE IF EXISTS ai_run_fts"))
    for column in ("run_id", "project_id", "member_id", "name", "plugin"):
        op.drop_index(f"ix_ai_skill_use_{column}", table_name="ai_skill_use")
    op.drop_table("ai_skill_use")
    op.drop_index("ix_ai_run_transcript_ended_at", table_name="ai_run_transcript")
    op.drop_index("ix_ai_run_transcript_member_id", table_name="ai_run_transcript")
    op.drop_index("ix_ai_run_transcript_project_id", table_name="ai_run_transcript")
    op.drop_table("ai_run_transcript")
