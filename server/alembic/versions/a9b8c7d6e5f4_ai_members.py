"""ai members: member kind, AI member profiles, runs (with the one-holder-per-ticket index), approvals, audit

Revision ID: a9b8c7d6e5f4
Revises: f3a4b5c6d7e8
Create Date: 2026-10-28 00:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "a9b8c7d6e5f4"
down_revision: Union[str, Sequence[str], None] = "f3a4b5c6d7e8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_S = sqlmodel.sql.sqltypes.AutoString


def upgrade() -> None:
    with op.batch_alter_table("member") as batch:
        batch.add_column(
            sa.Column("kind", _S(), nullable=False, server_default="human")
        )

    op.create_table(
        "ai_member",
        sa.Column("id", _S(), nullable=False),
        sa.Column("project_id", _S(), nullable=False),
        sa.Column("provider", _S(), nullable=False),
        sa.Column("connection", _S(), nullable=False),
        sa.Column("description", _S(), nullable=False, server_default=""),
        sa.Column("glyph", _S(), nullable=False, server_default="spark"),
        sa.Column("cli_path", _S(), nullable=True),
        sa.Column("working_dir", _S(), nullable=True),
        sa.Column("base_url", _S(), nullable=True),
        sa.Column("model", _S(), nullable=True),
        sa.Column("key_enc", _S(), nullable=True),
        sa.Column("key_last4", _S(), nullable=True),
        sa.Column("persona", _S(), nullable=False, server_default=""),
        sa.Column("max_parallel", sa.Integer(), nullable=False, server_default="2"),
        sa.Column("daily_budget", sa.Float(), nullable=True),
        sa.Column("monthly_cap", sa.Float(), nullable=True),
        sa.Column("max_runs_per_day", sa.Integer(), nullable=True),
        sa.Column("template", _S(), nullable=False, server_default="developer"),
        sa.Column("ceiling", _S(), nullable=False, server_default="review"),
        sa.Column("permissions", _S(), nullable=False, server_default="{}"),
        sa.Column("scope", _S(), nullable=False, server_default="assigned"),
        sa.Column("config", _S(), nullable=False, server_default="{}"),
        sa.Column("paused", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("paused_at", _S(), nullable=True),
        sa.Column("paused_reason", _S(), nullable=True),
        sa.Column("health", _S(), nullable=False, server_default="unknown"),
        sa.Column("health_detail", _S(), nullable=True),
        sa.Column("checked_at", _S(), nullable=True),
        sa.Column("cli_version", _S(), nullable=True),
        sa.Column("account", _S(), nullable=True),
        sa.Column("last_call_at", _S(), nullable=True),
        sa.Column("remove_after_run", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("created_by", _S(), nullable=True),
        sa.Column("created_at", _S(), nullable=False),
        sa.Column("updated_at", _S(), nullable=False),
        sa.ForeignKeyConstraint(["id"], ["member.id"]),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_ai_member_project_id", "ai_member", ["project_id"])

    op.create_table(
        "ai_run",
        sa.Column("id", _S(), nullable=False),
        sa.Column("project_id", _S(), nullable=False),
        sa.Column("ticket_id", _S(), nullable=False),
        sa.Column("member_id", _S(), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("mode", _S(), nullable=False, server_default="work"),
        sa.Column("trigger", _S(), nullable=False, server_default="assign"),
        sa.Column("state", _S(), nullable=False, server_default="queued"),
        sa.Column("started_by", _S(), nullable=False, server_default="user"),
        sa.Column("instruction", _S(), nullable=False, server_default=""),
        sa.Column("source_comment_id", _S(), nullable=True),
        sa.Column("reply_comment_id", _S(), nullable=True),
        sa.Column("include_context", sa.Boolean(), nullable=False, server_default="1"),
        sa.Column("chain", _S(), nullable=False, server_default="[]"),
        sa.Column("queued_at", _S(), nullable=False),
        sa.Column("started_at", _S(), nullable=True),
        sa.Column("ended_at", _S(), nullable=True),
        sa.Column("last_output_at", _S(), nullable=True),
        sa.Column("ended_reason", _S(), nullable=True),
        sa.Column("ended_by", _S(), nullable=True),
        sa.Column("exit_code", sa.Integer(), nullable=True),
        sa.Column("summary", _S(), nullable=True),
        sa.Column("report", _S(), nullable=False, server_default="{}"),
        sa.Column("question", _S(), nullable=True),
        sa.Column("answer", _S(), nullable=True),
        sa.Column("session_id", _S(), nullable=True),
        sa.Column("steps", _S(), nullable=False, server_default="[]"),
        sa.Column("files", _S(), nullable=False, server_default="[]"),
        sa.Column("tokens_in", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("tokens_out", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cost_usd", sa.Float(), nullable=False, server_default="0"),
        sa.Column("metered", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("status_before", _S(), nullable=True),
        sa.Column("status_changes", _S(), nullable=False, server_default="[]"),
        sa.Column("pid", sa.Integer(), nullable=True),
        sa.Column("token_hash", _S(), nullable=True),
        sa.Column("model", _S(), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.ForeignKeyConstraint(["member_id"], ["member.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_ai_run_project_id", "ai_run", ["project_id"])
    op.create_index("ix_ai_run_ticket_id", "ai_run", ["ticket_id"])
    op.create_index("ix_ai_run_member_id", "ai_run", ["member_id"])
    op.create_index("ix_ai_run_state", "ai_run", ["state"])
    op.create_index("ix_ai_run_token_hash", "ai_run", ["token_hash"])
    # One agent holds a ticket at a time: at most one active work run per ticket, even under concurrent requests
    op.create_index(
        "ux_ai_run_ticket_hold",
        "ai_run",
        ["ticket_id"],
        unique=True,
        sqlite_where=sa.text(
            "mode = 'work' AND state IN ('queued', 'starting', 'running', 'needs_input')"
        ),
    )

    op.create_table(
        "ai_approval",
        sa.Column("id", _S(), nullable=False),
        sa.Column("project_id", _S(), nullable=False),
        sa.Column("member_id", _S(), nullable=False),
        sa.Column("run_id", _S(), nullable=True),
        sa.Column("ticket_id", _S(), nullable=True),
        sa.Column("action", _S(), nullable=False),
        sa.Column("summary", _S(), nullable=False, server_default=""),
        sa.Column("payload", _S(), nullable=False, server_default="{}"),
        sa.Column("reason", _S(), nullable=True),
        sa.Column("risk", _S(), nullable=False, server_default="medium"),
        sa.Column("status", _S(), nullable=False, server_default="pending"),
        sa.Column("on_behalf_of", _S(), nullable=True),
        sa.Column("requested_at", _S(), nullable=False),
        sa.Column("expires_at", _S(), nullable=True),
        sa.Column("decided_by", _S(), nullable=True),
        sa.Column("decided_at", _S(), nullable=True),
        sa.Column("decision_note", _S(), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.ForeignKeyConstraint(["member_id"], ["member.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_ai_approval_project_id", "ai_approval", ["project_id"])
    op.create_index("ix_ai_approval_member_id", "ai_approval", ["member_id"])
    op.create_index("ix_ai_approval_ticket_id", "ai_approval", ["ticket_id"])

    op.create_table(
        "ai_audit",
        sa.Column("id", _S(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("project_id", _S(), nullable=False),
        sa.Column("member_id", _S(), nullable=True),
        sa.Column("member_name", _S(), nullable=False, server_default=""),
        sa.Column("on_behalf_of", _S(), nullable=True),
        sa.Column("run_id", _S(), nullable=True),
        sa.Column("action", _S(), nullable=False),
        sa.Column("target", _S(), nullable=True),
        sa.Column("result", _S(), nullable=False, server_default="allowed"),
        sa.Column("detail", _S(), nullable=False, server_default="{}"),
        sa.Column("created_at", _S(), nullable=False),
        sa.Column("reverted_at", _S(), nullable=True),
        sa.Column("reverted_by", _S(), nullable=True),
        sa.Column("prev_hash", _S(), nullable=False, server_default=""),
        sa.Column("hash", _S(), nullable=False, server_default=""),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_ai_audit_seq", "ai_audit", ["seq"])
    op.create_index("ix_ai_audit_project_id", "ai_audit", ["project_id"])
    op.create_index("ix_ai_audit_member_id", "ai_audit", ["member_id"])
    op.create_index("ix_ai_audit_run_id", "ai_audit", ["run_id"])

    op.create_table(
        "ai_project_settings",
        sa.Column("project_id", _S(), nullable=False),
        sa.Column("board_ai_id", _S(), nullable=True),
        sa.Column("paused_all", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("paused_at", _S(), nullable=True),
        sa.Column("paused_by", _S(), nullable=True),
        sa.Column("paused_reason", _S(), nullable=True),
        sa.Column("safe_mode", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("board_daily_cap", sa.Float(), nullable=True),
        sa.Column("board_monthly_budget", sa.Float(), nullable=True),
        sa.Column("max_chain_depth", sa.Integer(), nullable=False, server_default="3"),
        sa.Column(
            "runs_per_ticket_per_day",
            sa.Integer(),
            nullable=False,
            server_default="6",
        ),
        sa.Column(
            "approval_expiry_hours", sa.Integer(), nullable=False, server_default="24"
        ),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.PrimaryKeyConstraint("project_id"),
    )


def downgrade() -> None:
    op.drop_table("ai_project_settings")
    op.drop_table("ai_audit")
    op.drop_table("ai_approval")
    op.drop_index("ux_ai_run_ticket_hold", table_name="ai_run")
    op.drop_table("ai_run")
    op.drop_table("ai_member")
    with op.batch_alter_table("member") as batch:
        batch.drop_column("kind")
