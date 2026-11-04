"""AI v2 reset: the old AI tables go, the kept ones start empty, the v2 tables are made.
The board's AI is rebuilt around Claude Code (docs/specs/ai-v2.md): one lead session per ticket with the pack's roles
as subagents, no permission matrix, no approvals, no handoff. Nothing of the old AI data is carried over (decided
2026-11-05): members become teams that people make again, runs and their steps start from zero, accounts are found
again on this computer.
Revision ID: a2b4c6d8e0f1
Revises: f1c3e5a7b9d2
Create Date: 2026-11-05
"""

from typing import Sequence

import sqlalchemy as sa
import sqlmodel
from alembic import op

from dbkit.types import LongText

revision: str = "a2b4c6d8e0f1"
down_revision: str | Sequence[str] | None = "f1c3e5a7b9d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_S = sqlmodel.sql.sqltypes.AutoString

DROPPED = [
    "ai_approval",
    "ai_grant",
    "ai_notification",
    "ai_decision",
    "ai_standing_order",
    "ai_order_firing",
    "ai_workflow_template",
    "ai_ticket_workflow",
    "ai_ticket_pace",
    "ai_ticket_step",
    "ai_ticket_flag",
    "ai_eval_mark",
    "ai_workspace_defaults",
    "ai_draft",
    "docs_ai_proposal",
    "docs_ai_check",
    "ai_member",
    "ai_run",
    "ai_project_settings",
]
WIPED = [
    "ai_usage",
    "ai_run_transcript",
    "ai_skill_use",
    "ai_schedule_run",
    "ai_schedule",
    "ai_worktree",
    "ai_watched_pr",
    "ai_account_state",
    "ai_account",
    "ai_chat_message",
    "ai_chat",
    "docs_ai_job",
    "docs_ai_session",
    "ai_audit",
    "ai_memory_note",
    "ai_config_state",
    "ai_repo_scan",
]


def _has(name: str) -> bool:
    return sa.inspect(op.get_bind()).has_table(name)


def _create(name: str, *columns) -> None:
    """Make a table unless it is there (a database made from the models already has the v2 tables)."""
    if not _has(name):
        op.create_table(name, *columns)


def _index(index: str, table: str, columns: list[str], unique: bool = False) -> None:
    existing = {ix["name"] for ix in sa.inspect(op.get_bind()).get_indexes(table)}
    if index not in existing:
        op.create_index(index, table, columns, unique=unique)


def upgrade() -> None:
    """Drop the old AI tables, empty the kept ones, make the v2 tables, add ai_role_pack.roles."""
    bind = op.get_bind()
    for name in DROPPED:
        if _has(name):
            op.drop_table(name)
    for name in WIPED:
        if _has(name):
            bind.execute(sa.text(f"DELETE FROM {name}"))
    if _has("member"):
        # AI members were the teams' identity rows; tickets they held go back to nobody
        if _has("ticket"):
            bind.execute(
                sa.text(
                    "UPDATE ticket SET assignee = NULL WHERE assignee IN "
                    "(SELECT id FROM member WHERE kind IN ('ai', 'ai_removed'))"
                )
            )
        bind.execute(sa.text("DELETE FROM member WHERE kind IN ('ai', 'ai_removed')"))
    if _has("ai_role_pack") and "roles" not in {
        c["name"] for c in sa.inspect(bind).get_columns("ai_role_pack")
    }:
        with op.batch_alter_table("ai_role_pack") as batch_op:
            batch_op.add_column(
                sa.Column("roles", LongText(), nullable=False, server_default="[]")
            )
    _create(
        "ai_team",
        sa.Column("id", _S(), nullable=False),
        sa.Column("project_id", _S(), nullable=False),
        sa.Column("provider", LongText(), nullable=False),
        sa.Column("connection", LongText(), nullable=False),
        sa.Column("description", LongText(), nullable=False),
        sa.Column("cli_path", LongText(), nullable=True),
        sa.Column("working_dir", LongText(), nullable=True),
        sa.Column("model", LongText(), nullable=True),
        sa.Column("effort", LongText(), nullable=True),
        sa.Column("persona", LongText(), nullable=False),
        sa.Column("pack_key", LongText(), nullable=True),
        sa.Column("config", LongText(), nullable=False),
        sa.Column("permission_mode", LongText(), nullable=False),
        sa.Column("max_parallel", sa.Integer(), nullable=False),
        sa.Column("daily_budget", sa.Float(), nullable=True),
        sa.Column("monthly_cap", sa.Float(), nullable=True),
        sa.Column("max_runs_per_day", sa.Integer(), nullable=True),
        sa.Column("tokens_per_day", sa.Integer(), nullable=True),
        sa.Column("cap_per_run", sa.Float(), nullable=True),
        sa.Column("scope", LongText(), nullable=False),
        sa.Column("paused", sa.Boolean(), nullable=False),
        sa.Column("paused_at", LongText(), nullable=True),
        sa.Column("paused_reason", LongText(), nullable=True),
        sa.Column("health", LongText(), nullable=False),
        sa.Column("health_detail", LongText(), nullable=True),
        sa.Column("checked_at", LongText(), nullable=True),
        sa.Column("account_id", _S(), nullable=True),
        sa.Column("mcp_last_used_at", LongText(), nullable=True),
        sa.Column("created_by", LongText(), nullable=True),
        sa.Column("created_at", LongText(), nullable=False),
        sa.Column("updated_at", LongText(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    _index("ix_ai_team_account_id", "ai_team", ["account_id"], unique=False)
    _index("ix_ai_team_project_id", "ai_team", ["project_id"], unique=False)
    _create(
        "ai_run",
        sa.Column("id", _S(), nullable=False),
        sa.Column("project_id", _S(), nullable=False),
        sa.Column("kind", LongText(), nullable=False),
        sa.Column("ticket_id", _S(), nullable=True),
        sa.Column("target", _S(), nullable=True),
        sa.Column("member_id", _S(), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("mode", LongText(), nullable=False),
        sa.Column("trigger", LongText(), nullable=False),
        sa.Column("state", _S(), nullable=False),
        sa.Column("started_by", LongText(), nullable=False),
        sa.Column("instruction", LongText(), nullable=False),
        sa.Column("reply_comment_id", LongText(), nullable=True),
        sa.Column("queued_at", LongText(), nullable=False),
        sa.Column("started_at", LongText(), nullable=True),
        sa.Column("ended_at", LongText(), nullable=True),
        sa.Column("last_output_at", LongText(), nullable=True),
        sa.Column("ended_reason", LongText(), nullable=True),
        sa.Column("ended_by", LongText(), nullable=True),
        sa.Column("exit_code", sa.Integer(), nullable=True),
        sa.Column("summary", LongText(), nullable=True),
        sa.Column("report", LongText(), nullable=False),
        sa.Column("question", LongText(), nullable=True),
        sa.Column("answer", LongText(), nullable=True),
        sa.Column("session_id", LongText(), nullable=True),
        sa.Column("session_name", LongText(), nullable=True),
        sa.Column("files", LongText(), nullable=False),
        sa.Column("tokens_in", sa.Integer(), nullable=False),
        sa.Column("tokens_out", sa.Integer(), nullable=False),
        sa.Column("tokens_cached", sa.Integer(), nullable=True),
        sa.Column("cost_usd", sa.Float(), nullable=False),
        sa.Column("metered", sa.Boolean(), nullable=False),
        sa.Column("context_used", sa.Integer(), nullable=True),
        sa.Column("context_window", sa.Integer(), nullable=True),
        sa.Column("pid", sa.Integer(), nullable=True),
        sa.Column("token_hash", _S(), nullable=True),
        sa.Column("model", LongText(), nullable=True),
        sa.Column("effort", LongText(), nullable=True),
        sa.Column("paused", sa.Boolean(), nullable=False),
        sa.Column("paused_at", LongText(), nullable=True),
        sa.Column("stop_code", LongText(), nullable=True),
        sa.Column("peak_rss_mb", sa.Float(), nullable=True),
        sa.Column("last_rss_mb", sa.Float(), nullable=True),
        sa.Column("restarts", LongText(), nullable=False),
        sa.Column("diagnosis", LongText(), nullable=True),
        sa.Column("retries", LongText(), nullable=False),
        sa.Column("retry_at", LongText(), nullable=True),
        sa.Column("account_id", _S(), nullable=True),
        sa.Column("debug_log", LongText(), nullable=True),
        sa.Column("steps_count", sa.Integer(), nullable=False),
        sa.Column("waiting_reason", LongText(), nullable=True),
        sa.Column("live", sa.Boolean(), nullable=False),
        sa.Column("details_removed_at", LongText(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    _index("ix_ai_run_account_id", "ai_run", ["account_id"], unique=False)
    _index("ix_ai_run_member_id", "ai_run", ["member_id"], unique=False)
    _index("ix_ai_run_project_id", "ai_run", ["project_id"], unique=False)
    _index("ix_ai_run_state", "ai_run", ["state"], unique=False)
    _index("ix_ai_run_target", "ai_run", ["target"], unique=False)
    _index("ix_ai_run_ticket_id", "ai_run", ["ticket_id"], unique=False)
    _index("ix_ai_run_token_hash", "ai_run", ["token_hash"], unique=False)
    _create(
        "ai_run_step",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("run_id", _S(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("at", LongText(), nullable=False),
        sa.Column("agent_id", LongText(), nullable=True),
        sa.Column("kind", LongText(), nullable=False),
        sa.Column("tool", LongText(), nullable=True),
        sa.Column("title", LongText(), nullable=False),
        sa.Column("detail", LongText(), nullable=False),
        sa.Column("output", LongText(), nullable=True),
        sa.Column("parent_tool_id", LongText(), nullable=True),
        sa.Column("tool_id", LongText(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    _index("ix_ai_run_step_run_id", "ai_run_step", ["run_id"], unique=False)
    _index("ix_ai_run_step_tool_id", "ai_run_step", ["tool_id"], unique=False)
    _index("ix_ai_run_step_run_seq", "ai_run_step", ["run_id", "seq"], unique=False)
    _create(
        "ai_run_agent",
        sa.Column("id", _S(), nullable=False),
        sa.Column("run_id", _S(), nullable=False),
        sa.Column("agent_type", LongText(), nullable=False),
        sa.Column("claude_id", LongText(), nullable=True),
        sa.Column("started_at", LongText(), nullable=False),
        sa.Column("ended_at", LongText(), nullable=True),
        sa.Column("steps_count", sa.Integer(), nullable=False),
        sa.Column("last_text", LongText(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    _index("ix_ai_run_agent_run_id", "ai_run_agent", ["run_id"], unique=False)
    _create(
        "ai_run_message",
        sa.Column("id", _S(), nullable=False),
        sa.Column("run_id", _S(), nullable=False),
        sa.Column("direction", LongText(), nullable=False),
        sa.Column("peer", LongText(), nullable=False),
        sa.Column("text", LongText(), nullable=False),
        sa.Column("at", LongText(), nullable=False),
        sa.Column("delivered_at", LongText(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    _index("ix_ai_run_message_run_id", "ai_run_message", ["run_id"], unique=False)
    _create(
        "ai_run_command",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("run_id", _S(), nullable=False),
        sa.Column("command", LongText(), nullable=False),
        sa.Column("payload", LongText(), nullable=False),
        sa.Column("created_at", LongText(), nullable=False),
        sa.Column("taken_at", LongText(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    _index("ix_ai_run_command_run_id", "ai_run_command", ["run_id"], unique=False)
    _create(
        "ai_project_settings",
        sa.Column("project_id", _S(), nullable=False),
        sa.Column("paused_all", sa.Boolean(), nullable=False),
        sa.Column("paused_at", LongText(), nullable=True),
        sa.Column("paused_reason", LongText(), nullable=True),
        sa.Column("board_daily_cap", sa.Float(), nullable=True),
        sa.Column("board_monthly_budget", sa.Float(), nullable=True),
        sa.Column("board_tokens_per_day", sa.Integer(), nullable=True),
        sa.Column("board_max_parallel", sa.Integer(), nullable=False),
        sa.Column("board_runs_per_day", sa.Integer(), nullable=True),
        sa.Column("board_at_cap", LongText(), nullable=False),
        sa.Column("run_memory_limit_mb", sa.Integer(), nullable=False),
        sa.Column("audit_retention_days", sa.Integer(), nullable=True),
        sa.Column("run_retention_days", sa.Integer(), nullable=True),
        sa.Column("permission_mode", LongText(), nullable=False),
        sa.Column("deny_list", LongText(), nullable=False),
        sa.Column("lessons_mode", LongText(), nullable=False),
        sa.Column("lessons_max", sa.Integer(), nullable=False),
        sa.Column("ops", LongText(), nullable=False),
        sa.PrimaryKeyConstraint("project_id"),
    )


def downgrade() -> None:
    """The v2 tables go; the old ones are not brought back (their data is gone)."""
    for name in (
        "ai_run_command",
        "ai_run_message",
        "ai_run_agent",
        "ai_run_step",
        "ai_run",
        "ai_team",
        "ai_project_settings",
    ):
        if _has(name):
            op.drop_table(name)
    if _has("ai_role_pack"):
        with op.batch_alter_table("ai_role_pack") as batch_op:
            batch_op.drop_column("roles")
