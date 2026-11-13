//! `server/alembic/versions/a2b4c6d8e0f1_ai_v2_reset.py`
//!
//! AI v2 reset: the old AI tables go, the kept ones start empty, the v2 tables are made.
//! The board's AI is rebuilt around Claude Code (docs/specs/ai-v2.md): one lead session per ticket with the pack's roles
//! as subagents, no permission matrix, no approvals, no handoff. Nothing of the old AI data is carried over (decided
//! 2026-11-05): members become teams that people make again, runs and their steps start from zero, accounts are found
//! again on this computer.

use sea_orm::ConnectionTrait;

use super::ops::Kind::{Bool, Float, Int, S, Serial, T};
use super::ops::{self, StepResult, Types};

const DROPPED: [&str; 19] = [
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
];

const WIPED: [&str; 17] = [
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
];

/// `upgrade()` of revision `a2b4c6d8e0f1`: drop the old AI tables, empty the kept ones, make the v2 tables, add
/// ai_role_pack.roles.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    for name in DROPPED {
        if ops::has_table(conn, name).await? {
            ops::exec(conn, &format!("DROP TABLE {name}")).await?;
        }
    }
    for name in WIPED {
        if ops::has_table(conn, name).await? {
            ops::exec(conn, &format!("DELETE FROM {name}")).await?;
        }
    }
    if ops::has_table(conn, "member").await? {
        // AI members were the teams' identity rows; tickets they held go back to nobody
        if ops::has_table(conn, "ticket").await? {
            ops::exec(
                conn,
                "UPDATE ticket SET assignee = NULL WHERE assignee IN \
                 (SELECT id FROM member WHERE kind IN ('ai', 'ai_removed'))",
            )
            .await?;
        }
        ops::exec(conn, "DELETE FROM member WHERE kind IN ('ai', 'ai_removed')").await?;
    }
    if ops::has_table(conn, "ai_role_pack").await? {
        let types = Types::of(conn);
        let roles = format!("{} {}", types.t, types.not_null_default("'[]'"));
        ops::add_missing_columns(conn, "ai_role_pack", &[("roles", &roles)]).await?;
    }
    ops::create_table_if_missing(
        conn,
        "ai_team",
        &[
            ("id", S, false),
            ("project_id", S, false),
            ("provider", T, false),
            ("connection", T, false),
            ("description", T, false),
            ("cli_path", T, true),
            ("working_dir", T, true),
            ("model", T, true),
            ("effort", T, true),
            ("persona", T, false),
            ("pack_key", T, true),
            ("config", T, false),
            ("permission_mode", T, false),
            ("max_parallel", Int, false),
            ("daily_budget", Float, true),
            ("monthly_cap", Float, true),
            ("max_runs_per_day", Int, true),
            ("tokens_per_day", Int, true),
            ("cap_per_run", Float, true),
            ("scope", T, false),
            ("paused", Bool, false),
            ("paused_at", T, true),
            ("paused_reason", T, true),
            ("health", T, false),
            ("health_detail", T, true),
            ("checked_at", T, true),
            ("account_id", S, true),
            ("mcp_last_used_at", T, true),
            ("created_by", T, true),
            ("created_at", T, false),
            ("updated_at", T, false),
        ],
        "id",
    )
    .await?;
    ops::create_index_if_missing(conn, "ix_ai_team_account_id", "ai_team", &["account_id"]).await?;
    ops::create_index_if_missing(conn, "ix_ai_team_project_id", "ai_team", &["project_id"]).await?;
    ops::create_table_if_missing(
        conn,
        "ai_run",
        &[
            ("id", S, false),
            ("project_id", S, false),
            ("kind", T, false),
            ("ticket_id", S, true),
            ("target", S, true),
            ("member_id", S, false),
            ("number", Int, false),
            ("mode", T, false),
            ("trigger", T, false),
            ("state", S, false),
            ("started_by", T, false),
            ("instruction", T, false),
            ("reply_comment_id", T, true),
            ("queued_at", T, false),
            ("started_at", T, true),
            ("ended_at", T, true),
            ("last_output_at", T, true),
            ("ended_reason", T, true),
            ("ended_by", T, true),
            ("exit_code", Int, true),
            ("summary", T, true),
            ("report", T, false),
            ("question", T, true),
            ("answer", T, true),
            ("session_id", T, true),
            ("session_name", T, true),
            ("files", T, false),
            ("tokens_in", Int, false),
            ("tokens_out", Int, false),
            ("tokens_cached", Int, true),
            ("cost_usd", Float, false),
            ("metered", Bool, false),
            ("context_used", Int, true),
            ("context_window", Int, true),
            ("pid", Int, true),
            ("token_hash", S, true),
            ("model", T, true),
            ("effort", T, true),
            ("paused", Bool, false),
            ("paused_at", T, true),
            ("stop_code", T, true),
            ("peak_rss_mb", Float, true),
            ("last_rss_mb", Float, true),
            ("restarts", T, false),
            ("diagnosis", T, true),
            ("retries", T, false),
            ("retry_at", T, true),
            ("account_id", S, true),
            ("debug_log", T, true),
            ("steps_count", Int, false),
            ("waiting_reason", T, true),
            ("live", Bool, false),
            ("details_removed_at", T, true),
        ],
        "id",
    )
    .await?;
    for column in ["account_id", "member_id", "project_id", "state", "target", "ticket_id", "token_hash"] {
        ops::create_index_if_missing(conn, &format!("ix_ai_run_{column}"), "ai_run", &[column]).await?;
    }
    ops::create_table_if_missing(
        conn,
        "ai_run_step",
        &[
            ("id", Serial, false),
            ("run_id", S, false),
            ("seq", Int, false),
            ("at", T, false),
            ("agent_id", T, true),
            ("kind", T, false),
            ("tool", T, true),
            ("title", T, false),
            ("detail", T, false),
            ("output", T, true),
            ("parent_tool_id", T, true),
            ("tool_id", T, true),
        ],
        "id",
    )
    .await?;
    ops::create_index_if_missing(conn, "ix_ai_run_step_run_id", "ai_run_step", &["run_id"]).await?;
    ops::create_index_if_missing(conn, "ix_ai_run_step_tool_id", "ai_run_step", &["tool_id"]).await?;
    ops::create_index_if_missing(conn, "ix_ai_run_step_run_seq", "ai_run_step", &["run_id", "seq"]).await?;
    ops::create_table_if_missing(
        conn,
        "ai_run_agent",
        &[
            ("id", S, false),
            ("run_id", S, false),
            ("agent_type", T, false),
            ("claude_id", T, true),
            ("started_at", T, false),
            ("ended_at", T, true),
            ("steps_count", Int, false),
            ("last_text", T, true),
        ],
        "id",
    )
    .await?;
    ops::create_index_if_missing(conn, "ix_ai_run_agent_run_id", "ai_run_agent", &["run_id"]).await?;
    ops::create_table_if_missing(
        conn,
        "ai_run_message",
        &[
            ("id", S, false),
            ("run_id", S, false),
            ("direction", T, false),
            ("peer", T, false),
            ("text", T, false),
            ("at", T, false),
            ("delivered_at", T, true),
        ],
        "id",
    )
    .await?;
    ops::create_index_if_missing(conn, "ix_ai_run_message_run_id", "ai_run_message", &["run_id"]).await?;
    ops::create_table_if_missing(
        conn,
        "ai_run_command",
        &[
            ("id", Serial, false),
            ("run_id", S, false),
            ("command", T, false),
            ("payload", T, false),
            ("created_at", T, false),
            ("taken_at", T, true),
        ],
        "id",
    )
    .await?;
    ops::create_index_if_missing(conn, "ix_ai_run_command_run_id", "ai_run_command", &["run_id"]).await?;
    ops::create_table_if_missing(
        conn,
        "ai_project_settings",
        &[
            ("project_id", S, false),
            ("paused_all", Bool, false),
            ("paused_at", T, true),
            ("paused_reason", T, true),
            ("board_daily_cap", Float, true),
            ("board_monthly_budget", Float, true),
            ("board_tokens_per_day", Int, true),
            ("board_max_parallel", Int, false),
            ("board_runs_per_day", Int, true),
            ("board_at_cap", T, false),
            ("run_memory_limit_mb", Int, false),
            ("audit_retention_days", Int, true),
            ("run_retention_days", Int, true),
            ("permission_mode", T, false),
            ("deny_list", T, false),
            ("lessons_mode", T, false),
            ("lessons_max", Int, false),
            ("ops", T, false),
        ],
        "project_id",
    )
    .await?;
    Ok(())
}
