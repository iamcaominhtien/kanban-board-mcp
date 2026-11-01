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


def bind_is_sqlite() -> bool:
    return op.get_bind().dialect.name == "sqlite"


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
        batch.add_column(sa.Column("model_override", sa.String(), nullable=True))
        batch.add_column(sa.Column("effort_override", sa.String(), nullable=True))

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
    op.create_table(
        "ai_project_knowledge",
        sa.Column("project_id", sa.String(), primary_key=True),
        sa.Column("instructions", sa.String(), nullable=False, server_default=""),
        sa.Column("history", sa.String(), nullable=False, server_default="[]"),
        sa.Column("updated_at", sa.String(), nullable=True),
        sa.Column("updated_by", sa.String(), nullable=True),
    )
    op.create_table(
        "ai_lesson",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("text", sa.String(), nullable=False, server_default=""),
        sa.Column("state", sa.String(), nullable=False, server_default="proposed"),
        sa.Column("source_ticket_id", sa.String(), nullable=True),
        sa.Column("source_run_id", sa.String(), nullable=True),
        sa.Column("proposed_by", sa.String(), nullable=True),
        sa.Column("kept_by", sa.String(), nullable=True),
        sa.Column("uses", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_used_at", sa.String(), nullable=True),
        sa.Column("created_at", sa.String(), nullable=False),
        sa.Column("updated_at", sa.String(), nullable=False),
    )
    for column in ("project_id", "state", "source_ticket_id"):
        op.create_index(f"ix_ai_lesson_{column}", "ai_lesson", [column])
    op.create_table(
        "ai_worktree",
        sa.Column("ticket_id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("repo", sa.String(), nullable=False),
        sa.Column("path", sa.String(), nullable=False),
        sa.Column("branch", sa.String(), nullable=False),
        sa.Column("base", sa.String(), nullable=False, server_default="main"),
        sa.Column("port", sa.Integer(), nullable=True),
        sa.Column("state", sa.String(), nullable=False, server_default="active"),
        sa.Column("handover", sa.String(), nullable=True),
        sa.Column("pr_url", sa.String(), nullable=True),
        sa.Column("pr_number", sa.Integer(), nullable=True),
        sa.Column("conflict_files", sa.String(), nullable=False, server_default="[]"),
        sa.Column("prepared_at", sa.String(), nullable=True),
        sa.Column("prepare_s", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.String(), nullable=False),
        sa.Column("last_used_at", sa.String(), nullable=True),
        sa.Column("merged_at", sa.String(), nullable=True),
    )
    op.create_index("ix_ai_worktree_project_id", "ai_worktree", ["project_id"])
    op.create_index("ix_ai_worktree_state", "ai_worktree", ["state"])
    op.create_table(
        "ai_plugin",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), nullable=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("source_kind", sa.String(), nullable=False, server_default="git"),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("ref", sa.String(), nullable=True),
        sa.Column("plugin", sa.String(), nullable=True),
        sa.Column("skills_wanted", sa.String(), nullable=False, server_default="[]"),
        sa.Column("commit", sa.String(), nullable=True),
        sa.Column("version", sa.String(), nullable=True),
        sa.Column("description", sa.String(), nullable=True),
        sa.Column("path", sa.String(), nullable=True),
        sa.Column("skills", sa.String(), nullable=False, server_default="[]"),
        sa.Column("hooks", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("mcp", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("size_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("pinned", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("default_on", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("roles", sa.String(), nullable=False, server_default="[]"),
        sa.Column("members", sa.String(), nullable=False, server_default="{}"),
        sa.Column("previous", sa.String(), nullable=True),
        sa.Column("installed_by", sa.String(), nullable=True),
        sa.Column("installed_at", sa.String(), nullable=False),
        sa.Column("updated_at", sa.String(), nullable=False),
    )
    op.create_index("ix_ai_plugin_project_id", "ai_plugin", ["project_id"])
    op.create_index("ix_ai_plugin_name", "ai_plugin", ["name"])
    op.create_table(
        "ai_role_pack",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("key", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("body", sa.String(), nullable=False, server_default="{}"),
        sa.Column("history", sa.String(), nullable=False, server_default="[]"),
        sa.Column("created_at", sa.String(), nullable=False),
        sa.Column("updated_at", sa.String(), nullable=False),
        sa.Column("updated_by", sa.String(), nullable=True),
    )
    op.create_index("ix_ai_role_pack_project_id", "ai_role_pack", ["project_id"])
    op.create_index("ix_ai_role_pack_key", "ai_role_pack", ["key"])
    op.create_table(
        "ai_repo_scan",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("folder", sa.String(), nullable=False),
        sa.Column("found", sa.String(), nullable=False, server_default="{}"),
        sa.Column("suggested", sa.String(), nullable=False, server_default="{}"),
        sa.Column("trial", sa.String(), nullable=False, server_default="{}"),
        sa.Column("applied_at", sa.String(), nullable=True),
        sa.Column("created_at", sa.String(), nullable=False),
    )
    op.create_index("ix_ai_repo_scan_project_id", "ai_repo_scan", ["project_id"])
    op.create_table(
        "ai_workflow_template",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("key", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("body", sa.String(), nullable=False, server_default="{}"),
        sa.Column("history", sa.String(), nullable=False, server_default="[]"),
        sa.Column("created_at", sa.String(), nullable=False),
        sa.Column("updated_at", sa.String(), nullable=False),
        sa.Column("updated_by", sa.String(), nullable=True),
    )
    op.create_index(
        "ix_ai_workflow_template_project_id", "ai_workflow_template", ["project_id"]
    )
    op.create_index("ix_ai_workflow_template_key", "ai_workflow_template", ["key"])
    op.create_table(
        "ai_ticket_workflow",
        sa.Column("ticket_id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("template_key", sa.String(), nullable=False),
        sa.Column("template_name", sa.String(), nullable=False),
        sa.Column("template_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("steps", sa.String(), nullable=False, server_default="[]"),
        sa.Column("state", sa.String(), nullable=False, server_default="active"),
        sa.Column("stop_reason", sa.String(), nullable=True),
        sa.Column("stop_detail", sa.String(), nullable=True),
        sa.Column("review_depth", sa.String(), nullable=True),
        sa.Column("depth_by", sa.String(), nullable=True),
        sa.Column("depth_note", sa.String(), nullable=True),
        sa.Column("rounds", sa.String(), nullable=False, server_default="{}"),
        sa.Column("objections", sa.String(), nullable=False, server_default="[]"),
        sa.Column("rulings", sa.String(), nullable=False, server_default="[]"),
        sa.Column("arbitration_run_id", sa.String(), nullable=True),
        sa.Column("attached_by", sa.String(), nullable=True),
        sa.Column("created_at", sa.String(), nullable=False),
        sa.Column("updated_at", sa.String(), nullable=False),
    )
    op.create_index(
        "ix_ai_ticket_workflow_project_id", "ai_ticket_workflow", ["project_id"]
    )
    op.create_index("ix_ai_ticket_workflow_state", "ai_ticket_workflow", ["state"])
    op.create_table(
        "ai_ticket_step",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("ticket_id", sa.String(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("idx", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("key", sa.String(), nullable=False),
        sa.Column("label", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False, server_default="ai"),
        sa.Column("role", sa.String(), nullable=True),
        sa.Column("state", sa.String(), nullable=False, server_default="pending"),
        sa.Column("attempt", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("member_id", sa.String(), nullable=True),
        sa.Column("run_id", sa.String(), nullable=True),
        sa.Column("note_in", sa.String(), nullable=True),
        sa.Column("note", sa.String(), nullable=True),
        sa.Column("outcome", sa.String(), nullable=True),
        sa.Column("result", sa.String(), nullable=True),
        sa.Column("started_at", sa.String(), nullable=True),
        sa.Column("ended_at", sa.String(), nullable=True),
    )
    for column in ("ticket_id", "state", "run_id"):
        op.create_index(f"ix_ai_ticket_step_{column}", "ai_ticket_step", [column])
    op.create_table(
        "ai_standing_order",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("sentence", sa.String(), nullable=False, server_default=""),
        sa.Column("rule", sa.String(), nullable=False, server_default="{}"),
        sa.Column("state", sa.String(), nullable=False, server_default="off"),
        sa.Column("trial_days", sa.Integer(), nullable=False, server_default="3"),
        sa.Column("trial_started_at", sa.String(), nullable=True),
        sa.Column("trial_fired_at", sa.String(), nullable=True),
        sa.Column("fired", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("would_have", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_fired_at", sa.String(), nullable=True),
        sa.Column("last_summary", sa.String(), nullable=True),
        sa.Column("template", sa.String(), nullable=True),
        sa.Column("created_by", sa.String(), nullable=True),
        sa.Column("created_at", sa.String(), nullable=False),
    )
    op.create_index(
        "ix_ai_standing_order_project_id", "ai_standing_order", ["project_id"]
    )
    op.create_index("ix_ai_standing_order_state", "ai_standing_order", ["state"])
    op.create_table(
        "ai_order_firing",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("order_id", sa.String(), nullable=False),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("at", sa.String(), nullable=False),
        sa.Column("target", sa.String(), nullable=True),
        sa.Column("ticket_id", sa.String(), nullable=True),
        sa.Column("trigger", sa.String(), nullable=False, server_default="{}"),
        sa.Column("action", sa.String(), nullable=False, server_default="{}"),
        sa.Column("would", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("result", sa.String(), nullable=True),
        sa.Column("undo", sa.String(), nullable=True),
        sa.Column("undone_at", sa.String(), nullable=True),
        sa.Column("undone_by", sa.String(), nullable=True),
    )
    for column in ("order_id", "project_id", "at", "target"):
        op.create_index(f"ix_ai_order_firing_{column}", "ai_order_firing", [column])
    op.create_table(
        "ai_watched_pr",
        sa.Column("ticket_id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("url", sa.String(), nullable=True),
        sa.Column("branch", sa.String(), nullable=False),
        sa.Column("repo", sa.String(), nullable=False),
        sa.Column("state", sa.String(), nullable=False, server_default="open"),
        sa.Column("ci", sa.String(), nullable=True),
        sa.Column("red", sa.String(), nullable=True),
        sa.Column("seen_comments", sa.String(), nullable=False, server_default="[]"),
        sa.Column("pending_comments", sa.String(), nullable=False, server_default="[]"),
        sa.Column("checked_at", sa.String(), nullable=True),
        sa.Column("last_error", sa.String(), nullable=True),
    )
    op.create_index("ix_ai_watched_pr_project_id", "ai_watched_pr", ["project_id"])
    op.create_table(
        "ai_knowledge_doc",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("project_id", sa.String(), nullable=True),
        sa.Column("store", sa.String(), nullable=False, server_default="project"),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False, server_default="text"),
        sa.Column("text", sa.String(), nullable=False, server_default=""),
        sa.Column("summary", sa.String(), nullable=True),
        sa.Column("keywords", sa.String(), nullable=False, server_default="[]"),
        sa.Column("answers", sa.String(), nullable=False, server_default="[]"),
        sa.Column("described_by", sa.String(), nullable=True),
        sa.Column("source_name", sa.String(), nullable=True),
        sa.Column("upload_url", sa.String(), nullable=True),
        sa.Column("private", sa.Boolean(), nullable=False, server_default="0"),
        sa.Column("tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_by", sa.String(), nullable=True),
        sa.Column("created_at", sa.String(), nullable=False),
        sa.Column("last_read_at", sa.String(), nullable=True),
        sa.Column("deleted_at", sa.String(), nullable=True),
    )
    op.create_index(
        "ix_ai_knowledge_doc_project_id", "ai_knowledge_doc", ["project_id"]
    )
    op.create_index("ix_ai_knowledge_doc_store", "ai_knowledge_doc", ["store"])
    op.create_table(
        "ai_eval_mark",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("suite", sa.String(), nullable=False),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("member_id", sa.String(), nullable=True),
        sa.Column("model", sa.String(), nullable=True),
        sa.Column("state", sa.String(), nullable=False, server_default="running"),
        sa.Column("score", sa.Float(), nullable=True),
        sa.Column("details", sa.String(), nullable=False, server_default="[]"),
        sa.Column("runs", sa.String(), nullable=False, server_default="[]"),
        sa.Column("created_at", sa.String(), nullable=False),
        sa.Column("ended_at", sa.String(), nullable=True),
    )
    op.create_index("ix_ai_eval_mark_suite", "ai_eval_mark", ["suite"])
    op.create_index("ix_ai_eval_mark_created_at", "ai_eval_mark", ["created_at"])
    if bind_is_sqlite():
        try:
            op.get_bind().execute(
                sa.text(
                    "CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(doc_id UNINDEXED, project_id UNINDEXED, "
                    "store UNINDEXED, title, summary, keywords, body, tokenize = 'unicode61 remove_diacritics 2')"
                )
            )
        except DBAPIError:
            pass
    # NEXT-UPGRADE

    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        try:
            bind.execute(sa.text(_RUN_FTS))
        except DBAPIError:
            pass  # no FTS5 in this SQLite: search falls back to the run's own fields


def downgrade() -> None:
    # NEXT-DOWNGRADE
    if bind_is_sqlite():
        op.get_bind().execute(sa.text("DROP TABLE IF EXISTS kb_fts"))
    op.drop_index("ix_ai_eval_mark_created_at", table_name="ai_eval_mark")
    op.drop_index("ix_ai_eval_mark_suite", table_name="ai_eval_mark")
    op.drop_table("ai_eval_mark")
    op.drop_index("ix_ai_knowledge_doc_store", table_name="ai_knowledge_doc")
    op.drop_index("ix_ai_knowledge_doc_project_id", table_name="ai_knowledge_doc")
    op.drop_table("ai_knowledge_doc")
    op.drop_index("ix_ai_watched_pr_project_id", table_name="ai_watched_pr")
    op.drop_table("ai_watched_pr")
    for column in ("order_id", "project_id", "at", "target"):
        op.drop_index(f"ix_ai_order_firing_{column}", table_name="ai_order_firing")
    op.drop_table("ai_order_firing")
    op.drop_index("ix_ai_standing_order_state", table_name="ai_standing_order")
    op.drop_index("ix_ai_standing_order_project_id", table_name="ai_standing_order")
    op.drop_table("ai_standing_order")
    for column in ("ticket_id", "state", "run_id"):
        op.drop_index(f"ix_ai_ticket_step_{column}", table_name="ai_ticket_step")
    op.drop_table("ai_ticket_step")
    op.drop_index("ix_ai_ticket_workflow_state", table_name="ai_ticket_workflow")
    op.drop_index("ix_ai_ticket_workflow_project_id", table_name="ai_ticket_workflow")
    op.drop_table("ai_ticket_workflow")
    op.drop_index("ix_ai_workflow_template_key", table_name="ai_workflow_template")
    op.drop_index(
        "ix_ai_workflow_template_project_id", table_name="ai_workflow_template"
    )
    op.drop_table("ai_workflow_template")
    op.drop_index("ix_ai_repo_scan_project_id", table_name="ai_repo_scan")
    op.drop_table("ai_repo_scan")
    op.drop_index("ix_ai_role_pack_key", table_name="ai_role_pack")
    op.drop_index("ix_ai_role_pack_project_id", table_name="ai_role_pack")
    op.drop_table("ai_role_pack")
    op.drop_index("ix_ai_plugin_name", table_name="ai_plugin")
    op.drop_index("ix_ai_plugin_project_id", table_name="ai_plugin")
    op.drop_table("ai_plugin")
    op.drop_index("ix_ai_worktree_state", table_name="ai_worktree")
    op.drop_index("ix_ai_worktree_project_id", table_name="ai_worktree")
    op.drop_table("ai_worktree")
    for column in ("project_id", "state", "source_ticket_id"):
        op.drop_index(f"ix_ai_lesson_{column}", table_name="ai_lesson")
    op.drop_table("ai_lesson")
    op.drop_table("ai_project_knowledge")
    for column in ("ticket_id", "project_id", "kind"):
        op.drop_index(f"ix_ai_ticket_flag_{column}", table_name="ai_ticket_flag")
    op.drop_table("ai_ticket_flag")
    with op.batch_alter_table("ai_project_settings") as batch:
        batch.drop_column("ops")
    op.drop_table("ai_account_state")
    with op.batch_alter_table("ai_run") as batch:
        for column in (
            "effort_override",
            "model_override",
            "account_id",
            "retries",
            "retry_at",
            "diagnosis",
        ):
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
