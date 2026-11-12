//! Bringing an existing database from an older revision to the head.
//!
//! The Python server ran its Alembic chain here (`alembic upgrade head`). This is the same chain: one module per
//! revision, each the port of that revision's `upgrade()`, applied in the order Alembic applies them and stamped
//! in `alembic_version` the way Alembic stamps, so a database can still go back to a 4.x app.
//!
//! **Order.** The chain has two places where it forks and merges. The pending revisions are found as Alembic finds
//! them (everything the head needs, minus what the stamped revisions already contain) and sorted by its topological
//! sort, so a database stamped anywhere gets the revisions in the order the Python server would have run them.
//!
//! **Transaction.** `database::init_db` opens one transaction and the whole upgrade runs inside it. On SQLite and
//! PostgreSQL the schema changes are part of that transaction: a step that fails undoes every step before it and the
//! database stays at its old revision. That is safer than what the Python server did on SQLite: its driver only
//! opened the transaction at the first statement that changed rows, so the schema changes of the first pending
//! revisions were already permanent when a later one failed, and the next start met a half-migrated database whose
//! stamp said nothing had happened. MySQL and MariaDB commit at every schema change, under Python as here; the
//! revisions that run there check what is already present, so running them again is safe.
//!
//! **Engines.** PostgreSQL and MySQL databases were first made by app 3.37.0, at revision `e8b0d2f4a6c9`
//! (commit 287f197f, "Choose your database"), from the models and not by this chain. Only the revisions after it
//! ever ran on a server database and only those are written for the three engines; an older stamp on a server
//! database is refused.

mod ops;

mod m_03a006e7b66e_merge_ai_accounts_and_resources;
mod m_1e1bb4aa5fa4_merge_multiple_heads;
mod m_46d50ad33691_fix_idea_status_and_color_values;
mod m_551353060a20_initial_schema;
mod m_8f3a9c2d1e4b_add_blocks_blocked_by;
mod m_9a4b5c6d7e8f_fix_blocks_blocked_by_columns;
mod m_a1b2c3d4e5f6_add_block_done_guards;
mod m_a1b2c3d4e5f7_notifications;
mod m_a1d0c5a1b2c3_docs_ai;
mod m_a2b3c4d5e6f7_add_idea_ticket_promoted_unique;
mod m_a2b4c6d8e0f1_ai_v2_reset;
mod m_a3b4c5d6e7f8_ai_where_you_work;
mod m_a3c5e7f9b1d4_ai_ticket_pace;
mod m_a4b5c6d7e8f9_diagram_preview_kind;
mod m_a6b7c8d9e0f1_ai_ticket_work;
mod m_a7c1e3f5b9d2_ai_accounts;
mod m_a7c9e1f3b567_ai_pause_facts;
mod m_a7c9e1f3b5d8_ai_repo_scan_job;
mod m_a8b9c0d1e2f3_add_sub_tasks;
mod m_a9b8c7d6e5f4_ai_members;
mod m_b1c2d3e4f5a6_ai_board_assistant;
mod m_b2c3d4e5f6a7_add_wont_do_reason;
mod m_b3c4d5e6f7a8_add_branches_column;
mod m_b3d5f7a9c1e4_ai_v2_repair_columns;
mod m_b3e1c9d7a5f2_ai_team_v2_repair;
mod m_b3e5f7a9c1d2_docs_ai_page_sessions;
mod m_b5c6d7e8f9a0_docs_edit_policy;
mod m_b5e7d9f1a3c4_wave5_pinned_wave_and_run_retention;
mod m_b7c8d9e0f1a2_ai_auto_trip;
mod m_b8c2d4e6f801_ai_run_report_back;
mod m_b8c9d0e1f2a3_canvas;
mod m_b8d0f2a4c678_ai_resources;
mod m_b8d0f2a4c6e9_notifications_v2_kinds;
mod m_b9c0d1e2f3a4_add_docs;
mod m_c0d1e2f3a4b5_docs_v2;
mod m_c1d2e3f4a5b7_canvas_pin_anchor;
mod m_c2d3e4f5a6b7_ai_schedules;
mod m_c3d4e5f6a7b8_add_members_and_ticket_assignee;
mod m_c3d5e7f9a012_ai_run_tokens_cached;
mod m_c3d9a1b7e5f2_sketches;
mod m_c4d5e6f7a8b9_add_workspace_settings;
mod m_c4e6a8b0d2f1_repair_docs_ai_ignore;
mod m_c4e6a8b0d2f3_ai_session_history;
mod m_c5d7e9f1a3b6_ai_team_manager;
mod m_c6d7e8f9a0b1_docs_title_aliases;
mod m_c6f8a0b2d4e6_ai_run_details_removed_at;
mod m_c8d9e0f1a2b3_ai_member_projects;
mod m_c9d0e1f2a3b4_idea_ai_helpers;
mod m_d1e2f3a4b5c6_add_reopen_and_pending_fields;
mod m_d3e4f5a6b7c8_ai_members_polish;
mod m_d4e5f6a7b8c9_add_start_date;
mod m_d4e6f8a0b123_ai_origin;
mod m_d5e6f7a8b9c0_add_project_repo_path;
mod m_d5f7b9c1e3a4_ai_chat_seen_at;
mod m_d7a9c1e3f5b8_ai_memory_notes;
mod m_d7e8f9a0b1c2_docs_seen_and_autosaves;
mod m_d8a0c2e4f6b8_review_requested_from;
mod m_d8e0f2a4b6c8_story_and_decisions;
mod m_d9e0f1a2b3c4_ai_chat_feedback;
mod m_e1f3a5c7b9d2_ai_grant_role;
mod m_e2a4c6e8b0d1_ai_touch_mark;
mod m_e2f3a4b5c6d7_docs_comments;
mod m_e4f5a6b7c8d9_ai_safety_cost;
mod m_e5f6a7b8c9d0_add_links;
mod m_e5f7a9b1c234_ai_team_dismissed;
mod m_e6611f7871e7_ai_team_v2;
mod m_e6a8c0d2f4b6_docs_ai_v1_leftovers;
mod m_e6f7a8b9c0d1_add_ticket_repo_path;
mod m_e7f1a2b3c4d5_ai_run_context;
mod m_e8b0d2f4a6c9_board_lookup_indexes;
mod m_e8f9a0b1c2d3_ai_run_limit_defaults;
mod m_f1a2b3c4d5e6_add_idea_ticket_table;
mod m_f1c3e5a7b9d2_run_hold_index_on_servers;
mod m_f3a4b5c6d7e8_diagrams;
mod m_f4a6b8c0d2e4_idea_space_model;
mod m_f5a6b7c8d9e0_ai_provider_config;
mod m_f6a8b0c2d345_ai_autopilot;
mod m_f7a8b9c0d1e2_add_project_worktree_settings;
mod m_f7b9d1e3a5c7_ai_run_depth;
mod m_fd73ce3d5800_merge_canvas_and_the_ai_team;

use std::collections::HashSet;

use sea_orm::{ConnectionTrait, DbBackend};

use crate::database::{DatabaseError, SchemaError};
use crate::schema::{self, CHAIN, Revision};
use crate::sql;

/// The head of app 3.37.0, the first that could run on PostgreSQL and MySQL: a server database is stamped with this
/// revision or a later one.
pub const SERVER_BASE: &str = "e8b0d2f4a6c9";

fn revision(id: &str) -> Option<&'static Revision> {
    CHAIN.iter().find(|r| r.id == id)
}

/// A revision and everything it follows.
fn ancestors(id: &'static str) -> HashSet<&'static str> {
    let mut seen = HashSet::new();
    let mut todo = vec![id];
    while let Some(next) = todo.pop() {
        if seen.insert(next) {
            if let Some(rev) = revision(next) {
                todo.extend(rev.down.iter().copied());
            }
        }
    }
    seen
}

/// Whether the revision `id` runs on PostgreSQL and MySQL: every revision after `SERVER_BASE`.
pub fn runs_on_servers(id: &str) -> bool {
    match revision(id) {
        Some(rev) => rev.id != SERVER_BASE && ancestors(rev.id).contains(SERVER_BASE),
        None => false,
    }
}

/// Alembic's `RevisionMap._topological_sort`: the revisions of `todo` from the head down, a revision always
/// before the ones it follows. Where the chain forks, the walk goes down the first parent of a merge until it
/// reaches a revision another open branch also leads to, and then finishes that branch first.
fn topological_sort(mut todo: HashSet<&'static str>, head: &'static str) -> Vec<&'static str> {
    let mut current_heads: Vec<&'static str> = if todo.contains(head) { vec![head] } else { Vec::new() };
    let mut ancestors_by_idx: Vec<HashSet<&'static str>> = current_heads.iter().map(|h| ancestors(h)).collect();
    let mut output = Vec::new();
    let mut idx = 0;
    while !current_heads.is_empty() {
        let candidate = current_heads[idx];
        // another head leads to this revision too: that branch has to be walked first
        if let Some(other) = (0..current_heads.len()).find(|&i| i != idx && ancestors_by_idx[i].contains(candidate)) {
            idx = other;
            continue;
        }
        if todo.remove(candidate) {
            output.push(candidate);
        }
        let down: &[&'static str] = revision(candidate).map(|r| r.down.as_slice()).unwrap_or(&[]);
        let heads_to_add: Vec<&'static str> =
            down.iter().copied().filter(|r| todo.contains(r) && !current_heads.contains(r)).collect();
        if heads_to_add.is_empty() {
            current_heads.remove(idx);
            ancestors_by_idx.remove(idx);
            idx = idx.saturating_sub(1);
        } else if down.len() == 1 {
            current_heads[idx] = heads_to_add[0];
            ancestors_by_idx[idx].remove(candidate);
        } else {
            current_heads[idx] = heads_to_add[0];
            ancestors_by_idx[idx] = ancestors(heads_to_add[0]);
            for extra in &heads_to_add[1..] {
                current_heads.push(extra);
                ancestors_by_idx.push(ancestors(extra));
            }
        }
    }
    output
}

/// The revisions a database stamped with `current` still needs to reach `target`, in the order Alembic runs them
/// (`ScriptDirectory._upgrade_revs(target, current)`). `None` when a revision is not in the chain.
pub fn plan_to(current: &[String], target: &str) -> Option<Vec<&'static Revision>> {
    let target = revision(target)?.id;
    let mut have: HashSet<&'static str> = HashSet::new();
    for id in current {
        have.extend(ancestors(revision(id)?.id));
    }
    let needs: HashSet<&'static str> = ancestors(target).into_iter().filter(|id| !have.contains(id)).collect();
    let mut order = topological_sort(needs, target);
    order.reverse();
    Some(order.into_iter().filter_map(revision).collect())
}

/// The revisions a database stamped with `current` still needs to reach the head (`alembic upgrade head`).
pub fn plan(current: &[String]) -> Option<Vec<&'static Revision>> {
    plan_to(current, schema::head_revision())
}

/// Alembic's `HeadMaintainer.update_to_step` for one upgrade step: `alembic_version` holds one row per open
/// branch. A revision that follows a stamped one replaces it; one that follows none of them (the first revision of
/// a second branch) is added; a merge whose parents are both stamped leaves one row.
async fn stamp<C: ConnectionTrait>(conn: &C, heads: &mut Vec<String>, rev: &Revision) -> Result<(), sea_orm::DbErr> {
    let backend = conn.get_database_backend();
    let stamped: Vec<String> =
        rev.down.iter().filter(|d| heads.iter().any(|h| h == *d)).map(|d| d.to_string()).collect();
    match stamped.split_last() {
        None => {
            conn.execute_raw(sql::statement(
                backend,
                "INSERT INTO alembic_version (version_num) VALUES (?)",
                [rev.id.into()],
            ))
            .await?;
        }
        Some((update, delete)) => {
            for gone in delete {
                conn.execute_raw(sql::statement(
                    backend,
                    "DELETE FROM alembic_version WHERE version_num = ?",
                    [gone.as_str().into()],
                ))
                .await?;
            }
            conn.execute_raw(sql::statement(
                backend,
                "UPDATE alembic_version SET version_num = ? WHERE version_num = ?",
                [rev.id.into(), update.as_str().into()],
            ))
            .await?;
        }
    }
    heads.retain(|h| !stamped.contains(h));
    heads.push(rev.id.to_string());
    Ok(())
}

/// Run the `upgrade()` of one revision.
async fn apply<C: ConnectionTrait>(conn: &C, id: &str) -> ops::StepResult {
    match id {
        "551353060a20" => m_551353060a20_initial_schema::upgrade(conn).await,
        "8f3a9c2d1e4b" => m_8f3a9c2d1e4b_add_blocks_blocked_by::upgrade(conn).await,
        "b2c3d4e5f6a7" => m_b2c3d4e5f6a7_add_wont_do_reason::upgrade(conn).await,
        "c3d4e5f6a7b8" => m_c3d4e5f6a7b8_add_members_and_ticket_assignee::upgrade(conn).await,
        "d4e5f6a7b8c9" => m_d4e5f6a7b8c9_add_start_date::upgrade(conn).await,
        "e5f6a7b8c9d0" => m_e5f6a7b8c9d0_add_links::upgrade(conn).await,
        "9a4b5c6d7e8f" => m_9a4b5c6d7e8f_fix_blocks_blocked_by_columns::upgrade(conn).await,
        "a1b2c3d4e5f6" => m_a1b2c3d4e5f6_add_block_done_guards::upgrade(conn).await,
        "1e1bb4aa5fa4" => m_1e1bb4aa5fa4_merge_multiple_heads::upgrade(conn).await,
        "f1a2b3c4d5e6" => m_f1a2b3c4d5e6_add_idea_ticket_table::upgrade(conn).await,
        "a2b3c4d5e6f7" => m_a2b3c4d5e6f7_add_idea_ticket_promoted_unique::upgrade(conn).await,
        "46d50ad33691" => m_46d50ad33691_fix_idea_status_and_color_values::upgrade(conn).await,
        "b3c4d5e6f7a8" => m_b3c4d5e6f7a8_add_branches_column::upgrade(conn).await,
        "c4d5e6f7a8b9" => m_c4d5e6f7a8b9_add_workspace_settings::upgrade(conn).await,
        "d5e6f7a8b9c0" => m_d5e6f7a8b9c0_add_project_repo_path::upgrade(conn).await,
        "e6f7a8b9c0d1" => m_e6f7a8b9c0d1_add_ticket_repo_path::upgrade(conn).await,
        "f7a8b9c0d1e2" => m_f7a8b9c0d1e2_add_project_worktree_settings::upgrade(conn).await,
        "a8b9c0d1e2f3" => m_a8b9c0d1e2f3_add_sub_tasks::upgrade(conn).await,
        "b9c0d1e2f3a4" => m_b9c0d1e2f3a4_add_docs::upgrade(conn).await,
        "c0d1e2f3a4b5" => m_c0d1e2f3a4b5_docs_v2::upgrade(conn).await,
        "d1e2f3a4b5c6" => m_d1e2f3a4b5c6_add_reopen_and_pending_fields::upgrade(conn).await,
        "e2f3a4b5c6d7" => m_e2f3a4b5c6d7_docs_comments::upgrade(conn).await,
        "f3a4b5c6d7e8" => m_f3a4b5c6d7e8_diagrams::upgrade(conn).await,
        "a9b8c7d6e5f4" => m_a9b8c7d6e5f4_ai_members::upgrade(conn).await,
        "b1c2d3e4f5a6" => m_b1c2d3e4f5a6_ai_board_assistant::upgrade(conn).await,
        "c2d3e4f5a6b7" => m_c2d3e4f5a6b7_ai_schedules::upgrade(conn).await,
        "d3e4f5a6b7c8" => m_d3e4f5a6b7c8_ai_members_polish::upgrade(conn).await,
        "e4f5a6b7c8d9" => m_e4f5a6b7c8d9_ai_safety_cost::upgrade(conn).await,
        "f5a6b7c8d9e0" => m_f5a6b7c8d9e0_ai_provider_config::upgrade(conn).await,
        "a6b7c8d9e0f1" => m_a6b7c8d9e0f1_ai_ticket_work::upgrade(conn).await,
        "b7c8d9e0f1a2" => m_b7c8d9e0f1a2_ai_auto_trip::upgrade(conn).await,
        "c8d9e0f1a2b3" => m_c8d9e0f1a2b3_ai_member_projects::upgrade(conn).await,
        "d9e0f1a2b3c4" => m_d9e0f1a2b3c4_ai_chat_feedback::upgrade(conn).await,
        "a4b5c6d7e8f9" => m_a4b5c6d7e8f9_diagram_preview_kind::upgrade(conn).await,
        "b5c6d7e8f9a0" => m_b5c6d7e8f9a0_docs_edit_policy::upgrade(conn).await,
        "c6d7e8f9a0b1" => m_c6d7e8f9a0b1_docs_title_aliases::upgrade(conn).await,
        "d7e8f9a0b1c2" => m_d7e8f9a0b1c2_docs_seen_and_autosaves::upgrade(conn).await,
        "e8f9a0b1c2d3" => m_e8f9a0b1c2d3_ai_run_limit_defaults::upgrade(conn).await,
        "a1d0c5a1b2c3" => m_a1d0c5a1b2c3_docs_ai::upgrade(conn).await,
        "b3e5f7a9c1d2" => m_b3e5f7a9c1d2_docs_ai_page_sessions::upgrade(conn).await,
        "f4a6b8c0d2e4" => m_f4a6b8c0d2e4_idea_space_model::upgrade(conn).await,
        "c9d0e1f2a3b4" => m_c9d0e1f2a3b4_idea_ai_helpers::upgrade(conn).await,
        "a3b4c5d6e7f8" => m_a3b4c5d6e7f8_ai_where_you_work::upgrade(conn).await,
        "c3d9a1b7e5f2" => m_c3d9a1b7e5f2_sketches::upgrade(conn).await,
        "e7f1a2b3c4d5" => m_e7f1a2b3c4d5_ai_run_context::upgrade(conn).await,
        "b8c2d4e6f801" => m_b8c2d4e6f801_ai_run_report_back::upgrade(conn).await,
        "c3d5e7f9a012" => m_c3d5e7f9a012_ai_run_tokens_cached::upgrade(conn).await,
        "d4e6f8a0b123" => m_d4e6f8a0b123_ai_origin::upgrade(conn).await,
        "e5f7a9b1c234" => m_e5f7a9b1c234_ai_team_dismissed::upgrade(conn).await,
        "f6a8b0c2d345" => m_f6a8b0c2d345_ai_autopilot::upgrade(conn).await,
        "a7c9e1f3b567" => m_a7c9e1f3b567_ai_pause_facts::upgrade(conn).await,
        "b8d0f2a4c678" => m_b8d0f2a4c678_ai_resources::upgrade(conn).await,
        "a7c1e3f5b9d2" => m_a7c1e3f5b9d2_ai_accounts::upgrade(conn).await,
        "b8c9d0e1f2a3" => m_b8c9d0e1f2a3_canvas::upgrade(conn).await,
        "c1d2e3f4a5b7" => m_c1d2e3f4a5b7_canvas_pin_anchor::upgrade(conn).await,
        "03a006e7b66e" => m_03a006e7b66e_merge_ai_accounts_and_resources::upgrade(conn).await,
        "fd73ce3d5800" => m_fd73ce3d5800_merge_canvas_and_the_ai_team::upgrade(conn).await,
        "a1b2c3d4e5f7" => m_a1b2c3d4e5f7_notifications::upgrade(conn).await,
        "e6611f7871e7" => m_e6611f7871e7_ai_team_v2::upgrade(conn).await,
        "b3e1c9d7a5f2" => m_b3e1c9d7a5f2_ai_team_v2_repair::upgrade(conn).await,
        "c5d7e9f1a3b6" => m_c5d7e9f1a3b6_ai_team_manager::upgrade(conn).await,
        "d8e0f2a4b6c8" => m_d8e0f2a4b6c8_story_and_decisions::upgrade(conn).await,
        "e1f3a5c7b9d2" => m_e1f3a5c7b9d2_ai_grant_role::upgrade(conn).await,
        "a7c9e1f3b5d8" => m_a7c9e1f3b5d8_ai_repo_scan_job::upgrade(conn).await,
        "b5e7d9f1a3c4" => m_b5e7d9f1a3c4_wave5_pinned_wave_and_run_retention::upgrade(conn).await,
        "c6f8a0b2d4e6" => m_c6f8a0b2d4e6_ai_run_details_removed_at::upgrade(conn).await,
        "d8a0c2e4f6b8" => m_d8a0c2e4f6b8_review_requested_from::upgrade(conn).await,
        "d7a9c1e3f5b8" => m_d7a9c1e3f5b8_ai_memory_notes::upgrade(conn).await,
        "a3c5e7f9b1d4" => m_a3c5e7f9b1d4_ai_ticket_pace::upgrade(conn).await,
        "c4e6a8b0d2f1" => m_c4e6a8b0d2f1_repair_docs_ai_ignore::upgrade(conn).await,
        "e8b0d2f4a6c9" => m_e8b0d2f4a6c9_board_lookup_indexes::upgrade(conn).await,
        "f1c3e5a7b9d2" => m_f1c3e5a7b9d2_run_hold_index_on_servers::upgrade(conn).await,
        "a2b4c6d8e0f1" => m_a2b4c6d8e0f1_ai_v2_reset::upgrade(conn).await,
        "b3d5f7a9c1e4" => m_b3d5f7a9c1e4_ai_v2_repair_columns::upgrade(conn).await,
        "c4e6a8b0d2f3" => m_c4e6a8b0d2f3_ai_session_history::upgrade(conn).await,
        "d5f7b9c1e3a4" => m_d5f7b9c1e3a4_ai_chat_seen_at::upgrade(conn).await,
        "e2a4c6e8b0d1" => m_e2a4c6e8b0d1_ai_touch_mark::upgrade(conn).await,
        "e6a8c0d2f4b6" => m_e6a8c0d2f4b6_docs_ai_v1_leftovers::upgrade(conn).await,
        "f7b9d1e3a5c7" => m_f7b9d1e3a5c7_ai_run_depth::upgrade(conn).await,
        "b8d0f2a4c6e9" => m_b8d0f2a4c6e9_notifications_v2_kinds::upgrade(conn).await,
        other => Err(DatabaseError::Other(format!("Migration {other} is not part of this app."))),
    }
}

/// Apply the migrations the database has not had yet, in the transaction `conn` is (`alembic upgrade head`).
///
/// Nothing is committed here: the caller commits when every step has passed, and a failed step leaves the database
/// at the revision it had.
pub async fn upgrade<C: ConnectionTrait>(conn: &C) -> Result<(), DatabaseError> {
    upgrade_to(conn, schema::head_revision()).await
}

/// `alembic upgrade <target>`: apply the migrations between what the database is stamped with and `target`. A
/// database without `alembic_version` starts at the first migration, as under Alembic.
pub async fn upgrade_to<C: ConnectionTrait>(conn: &C, target: &str) -> Result<(), DatabaseError> {
    if !schema::has_table(conn, "alembic_version").await? {
        conn.execute_unprepared(
            "CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL, \
             CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num))",
        )
        .await?;
    }
    let current = schema::current_revisions(conn).await?;
    let Some(pending) = plan_to(&current, target) else {
        let unknown = current.iter().find(|id| revision(id).is_none()).cloned().unwrap_or_else(|| target.to_string());
        let short: String = unknown.chars().take(8).collect();
        return Err(SchemaError {
            code: "newer",
            message: format!(
                "This database was made by a newer version of the app (migration {short}…). Update the app first; \
                 the board will not touch it."
            ),
        }
        .into());
    };
    if pending.is_empty() {
        return Ok(());
    }
    if conn.get_database_backend() != DbBackend::Sqlite {
        if let Some(old) = pending.iter().find(|rev| !runs_on_servers(rev.id)) {
            return Err(SchemaError {
                code: "older",
                message: format!(
                    "This database is at migration {}, which is older than the first version of the app that could \
                     use PostgreSQL or MySQL (migration {SERVER_BASE}). Its next migration ({}) only exists for SQLite, \
                     so the board will not touch it.",
                    current.first().map(String::as_str).unwrap_or("(none)"),
                    old.id
                ),
            }
            .into());
        }
    }
    let mut heads = current;
    for rev in pending {
        tracing::info!("Running upgrade {} -> {}, {}", rev.down.join(", "), rev.id, rev.file);
        if let Err(err) = apply(conn, rev.id).await {
            tracing::error!("Migration {} ({}) failed, the database stays as it was: {err}", rev.id, rev.file);
            return Err(err);
        }
        stamp(conn, &mut heads, rev).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(current: &[&str]) -> Vec<&'static str> {
        let current: Vec<String> = current.iter().map(|s| s.to_string()).collect();
        plan(&current).unwrap().into_iter().map(|r| r.id).collect()
    }

    #[test]
    fn a_new_chain_runs_in_the_order_of_the_exported_list() {
        // `schema/revisions.txt` was exported in Alembic's own order for an empty database
        assert_eq!(ids(&[]), CHAIN.iter().map(|r| r.id).collect::<Vec<_>>());
        assert!(ids(&[schema::head_revision()]).is_empty());
    }

    #[test]
    fn a_database_on_one_branch_gets_the_other_branch_before_the_merge() {
        // stamped on the AI accounts branch: the AI resources branch is still to run, then canvas, then the merges
        let order = ids(&["a7c1e3f5b9d2"]);
        let at = |id: &str| order.iter().position(|r| *r == id).unwrap();
        assert!(!order.contains(&"c3d9a1b7e5f2") && !order.contains(&"a7c1e3f5b9d2"));
        assert!(at("e7f1a2b3c4d5") < at("b8d0f2a4c678"));
        assert!(at("b8d0f2a4c678") < at("03a006e7b66e"));
        assert!(at("c1d2e3f4a5b7") < at("fd73ce3d5800"));
        assert!(at("03a006e7b66e") < at("fd73ce3d5800"));
        // both branches stamped: only what follows them
        assert_eq!(&ids(&["b8d0f2a4c678", "c1d2e3f4a5b7"])[..2], ["03a006e7b66e", "fd73ce3d5800"]);
        assert!(plan(&["0123456789ab".to_string()]).is_none());
    }

    #[test]
    fn only_the_revisions_after_the_first_server_version_run_on_servers() {
        let on_servers: Vec<&str> = CHAIN.iter().map(|r| r.id).filter(|id| runs_on_servers(id)).collect();
        assert_eq!(
            on_servers,
            [
                "f1c3e5a7b9d2",
                "a2b4c6d8e0f1",
                "b3d5f7a9c1e4",
                "c4e6a8b0d2f3",
                "d5f7b9c1e3a4",
                "e2a4c6e8b0d1",
                "e6a8c0d2f4b6",
                "f7b9d1e3a5c7",
                "b8d0f2a4c6e9"
            ]
        );
    }
}
