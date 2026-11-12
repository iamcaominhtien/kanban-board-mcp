//! `server/alembic/versions/e6611f7871e7_ai_team_v2.py`
//!
//! AI team v2 (docs/specs/ai-claude-code-implementation.md): run transcripts and search, skill use, account windows,
//! run diagnosis and retries

use sea_orm::ConnectionTrait;

use super::ops::{self, StepResult};

/// `upgrade()` of revision `e6611f7871e7`.
///
/// Every step checks what is already there, so the upgrade can run again on a database that an early build of this
/// revision half-migrated; the next revision (b3e1c9d7a5f2) does exactly that. The Python file also asks which
/// engine it runs on before it makes the two FTS5 tables; this revision is older than the first app that could use
/// a server database, so it only ever runs on SQLite.
pub(super) async fn upgrade<C: ConnectionTrait>(conn: &C) -> StepResult {
    if !ops::has_table(conn, "ai_run_transcript").await? {
        ops::exec(
            conn,
            r"CREATE TABLE ai_run_transcript (
	run_id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	member_id VARCHAR, 
	path VARCHAR NOT NULL, 
	bytes INTEGER DEFAULT '0' NOT NULL, 
	events INTEGER DEFAULT '0' NOT NULL, 
	pinned BOOLEAN DEFAULT '0' NOT NULL, 
	pinned_by VARCHAR, 
	started_at VARCHAR NOT NULL, 
	ended_at VARCHAR, 
	deleted_at VARCHAR, 
	PRIMARY KEY (run_id)
)",
        )
        .await?;
    }
    ops::create_index_if_missing(conn, "ix_ai_run_transcript_project_id", "ai_run_transcript", &["project_id"]).await?;
    ops::create_index_if_missing(conn, "ix_ai_run_transcript_member_id", "ai_run_transcript", &["member_id"]).await?;
    ops::create_index_if_missing(conn, "ix_ai_run_transcript_ended_at", "ai_run_transcript", &["ended_at"]).await?;
    if !ops::has_table(conn, "ai_skill_use").await? {
        ops::exec(
            conn,
            r"CREATE TABLE ai_skill_use (
	id INTEGER NOT NULL, 
	run_id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	member_id VARCHAR, 
	kind VARCHAR DEFAULT 'skill' NOT NULL, 
	name VARCHAR NOT NULL, 
	plugin VARCHAR, 
	at VARCHAR NOT NULL, 
	PRIMARY KEY (id)
)",
        )
        .await?;
    }
    ops::create_index_if_missing(conn, "ix_ai_skill_use_run_id", "ai_skill_use", &["run_id"]).await?;
    ops::create_index_if_missing(conn, "ix_ai_skill_use_project_id", "ai_skill_use", &["project_id"]).await?;
    ops::create_index_if_missing(conn, "ix_ai_skill_use_member_id", "ai_skill_use", &["member_id"]).await?;
    ops::create_index_if_missing(conn, "ix_ai_skill_use_name", "ai_skill_use", &["name"]).await?;
    ops::create_index_if_missing(conn, "ix_ai_skill_use_plugin", "ai_skill_use", &["plugin"]).await?;
    ops::add_missing_columns(
        conn,
        "ai_run",
        &[
            ("diagnosis", "VARCHAR"),
            ("retry_at", "VARCHAR"),
            ("retries", "VARCHAR DEFAULT '[]' NOT NULL"),
            ("account_id", "VARCHAR"),
            ("model_override", "VARCHAR"),
            ("effort_override", "VARCHAR"),
        ],
    )
    .await?;
    if !ops::has_table(conn, "ai_account_state").await? {
        ops::exec(
            conn,
            r#"CREATE TABLE ai_account_state (
	"key" VARCHAR NOT NULL, 
	max_parallel INTEGER DEFAULT '2' NOT NULL, 
	move_urgent BOOLEAN DEFAULT '0' NOT NULL, 
	five_hour_used FLOAT, 
	five_hour_resets_at VARCHAR, 
	five_hour_status VARCHAR, 
	seven_day_used FLOAT, 
	seven_day_resets_at VARCHAR, 
	seven_day_status VARCHAR, 
	held_until VARCHAR, 
	held_reason VARCHAR, 
	updated_at VARCHAR, 
	PRIMARY KEY ("key")
)"#,
        )
        .await?;
    }
    ops::add_missing_columns(
        conn,
        "ai_project_settings",
        &[
            ("ops", "VARCHAR DEFAULT '{}' NOT NULL"),
        ],
    )
    .await?;
    if !ops::has_table(conn, "ai_ticket_flag").await? {
        ops::exec(
            conn,
            r"CREATE TABLE ai_ticket_flag (
	id VARCHAR NOT NULL, 
	ticket_id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	kind VARCHAR NOT NULL, 
	data VARCHAR DEFAULT '{}' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	resolved_at VARCHAR, 
	resolved_by VARCHAR, 
	resolution VARCHAR, 
	PRIMARY KEY (id)
)",
        )
        .await?;
    }
    ops::create_index_if_missing(conn, "ix_ai_ticket_flag_ticket_id", "ai_ticket_flag", &["ticket_id"]).await?;
    ops::create_index_if_missing(conn, "ix_ai_ticket_flag_project_id", "ai_ticket_flag", &["project_id"]).await?;
    ops::create_index_if_missing(conn, "ix_ai_ticket_flag_kind", "ai_ticket_flag", &["kind"]).await?;
    if !ops::has_table(conn, "ai_project_knowledge").await? {
        ops::exec(
            conn,
            r"CREATE TABLE ai_project_knowledge (
	project_id VARCHAR NOT NULL, 
	instructions VARCHAR DEFAULT '' NOT NULL, 
	history VARCHAR DEFAULT '[]' NOT NULL, 
	updated_at VARCHAR, 
	updated_by VARCHAR, 
	PRIMARY KEY (project_id)
)",
        )
        .await?;
    }
    if !ops::has_table(conn, "ai_lesson").await? {
        ops::exec(
            conn,
            r"CREATE TABLE ai_lesson (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	text VARCHAR DEFAULT '' NOT NULL, 
	state VARCHAR DEFAULT 'proposed' NOT NULL, 
	source_ticket_id VARCHAR, 
	source_run_id VARCHAR, 
	proposed_by VARCHAR, 
	kept_by VARCHAR, 
	uses INTEGER DEFAULT '0' NOT NULL, 
	last_used_at VARCHAR, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (id)
)",
        )
        .await?;
    }
    ops::create_index_if_missing(conn, "ix_ai_lesson_project_id", "ai_lesson", &["project_id"]).await?;
    ops::create_index_if_missing(conn, "ix_ai_lesson_state", "ai_lesson", &["state"]).await?;
    ops::create_index_if_missing(conn, "ix_ai_lesson_source_ticket_id", "ai_lesson", &["source_ticket_id"]).await?;
    if !ops::has_table(conn, "ai_worktree").await? {
        ops::exec(
            conn,
            r"CREATE TABLE ai_worktree (
	ticket_id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	repo VARCHAR NOT NULL, 
	path VARCHAR NOT NULL, 
	branch VARCHAR NOT NULL, 
	base VARCHAR DEFAULT 'main' NOT NULL, 
	port INTEGER, 
	state VARCHAR DEFAULT 'active' NOT NULL, 
	handover VARCHAR, 
	pr_url VARCHAR, 
	pr_number INTEGER, 
	conflict_files VARCHAR DEFAULT '[]' NOT NULL, 
	prepared_at VARCHAR, 
	prepare_s INTEGER, 
	created_at VARCHAR NOT NULL, 
	last_used_at VARCHAR, 
	merged_at VARCHAR, 
	PRIMARY KEY (ticket_id)
)",
        )
        .await?;
    }
    ops::create_index_if_missing(conn, "ix_ai_worktree_project_id", "ai_worktree", &["project_id"]).await?;
    ops::create_index_if_missing(conn, "ix_ai_worktree_state", "ai_worktree", &["state"]).await?;
    if !ops::has_table(conn, "ai_plugin").await? {
        ops::exec(
            conn,
            r#"CREATE TABLE ai_plugin (
	id VARCHAR NOT NULL, 
	project_id VARCHAR, 
	name VARCHAR NOT NULL, 
	source_kind VARCHAR DEFAULT 'git' NOT NULL, 
	source VARCHAR NOT NULL, 
	ref VARCHAR, 
	plugin VARCHAR, 
	skills_wanted VARCHAR DEFAULT '[]' NOT NULL, 
	"commit" VARCHAR, 
	version VARCHAR, 
	description VARCHAR, 
	path VARCHAR, 
	skills VARCHAR DEFAULT '[]' NOT NULL, 
	hooks INTEGER DEFAULT '0' NOT NULL, 
	mcp INTEGER DEFAULT '0' NOT NULL, 
	size_bytes INTEGER DEFAULT '0' NOT NULL, 
	pinned BOOLEAN DEFAULT '0' NOT NULL, 
	default_on BOOLEAN DEFAULT '0' NOT NULL, 
	roles VARCHAR DEFAULT '[]' NOT NULL, 
	members VARCHAR DEFAULT '{}' NOT NULL, 
	previous VARCHAR, 
	installed_by VARCHAR, 
	installed_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (id)
)"#,
        )
        .await?;
    }
    ops::create_index_if_missing(conn, "ix_ai_plugin_project_id", "ai_plugin", &["project_id"]).await?;
    ops::create_index_if_missing(conn, "ix_ai_plugin_name", "ai_plugin", &["name"]).await?;
    if !ops::has_table(conn, "ai_role_pack").await? {
        ops::exec(
            conn,
            r#"CREATE TABLE ai_role_pack (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	"key" VARCHAR NOT NULL, 
	name VARCHAR NOT NULL, 
	version INTEGER DEFAULT '1' NOT NULL, 
	body VARCHAR DEFAULT '{}' NOT NULL, 
	history VARCHAR DEFAULT '[]' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	updated_by VARCHAR, 
	PRIMARY KEY (id)
)"#,
        )
        .await?;
    }
    ops::create_index_if_missing(conn, "ix_ai_role_pack_project_id", "ai_role_pack", &["project_id"]).await?;
    ops::create_index_if_missing(conn, "ix_ai_role_pack_key", "ai_role_pack", &["key"]).await?;
    if !ops::has_table(conn, "ai_repo_scan").await? {
        ops::exec(
            conn,
            r"CREATE TABLE ai_repo_scan (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	folder VARCHAR NOT NULL, 
	found VARCHAR DEFAULT '{}' NOT NULL, 
	suggested VARCHAR DEFAULT '{}' NOT NULL, 
	trial VARCHAR DEFAULT '{}' NOT NULL, 
	applied_at VARCHAR, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id)
)",
        )
        .await?;
    }
    ops::create_index_if_missing(conn, "ix_ai_repo_scan_project_id", "ai_repo_scan", &["project_id"]).await?;
    if !ops::has_table(conn, "ai_workflow_template").await? {
        ops::exec(
            conn,
            r#"CREATE TABLE ai_workflow_template (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	"key" VARCHAR NOT NULL, 
	name VARCHAR NOT NULL, 
	version INTEGER DEFAULT '1' NOT NULL, 
	body VARCHAR DEFAULT '{}' NOT NULL, 
	history VARCHAR DEFAULT '[]' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	updated_by VARCHAR, 
	PRIMARY KEY (id)
)"#,
        )
        .await?;
    }
    ops::create_index_if_missing(conn, "ix_ai_workflow_template_project_id", "ai_workflow_template", &["project_id"]).await?;
    ops::create_index_if_missing(conn, "ix_ai_workflow_template_key", "ai_workflow_template", &["key"]).await?;
    if !ops::has_table(conn, "ai_ticket_workflow").await? {
        ops::exec(
            conn,
            r"CREATE TABLE ai_ticket_workflow (
	ticket_id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	template_key VARCHAR NOT NULL, 
	template_name VARCHAR NOT NULL, 
	template_version INTEGER DEFAULT '1' NOT NULL, 
	steps VARCHAR DEFAULT '[]' NOT NULL, 
	state VARCHAR DEFAULT 'active' NOT NULL, 
	stop_reason VARCHAR, 
	stop_detail VARCHAR, 
	review_depth VARCHAR, 
	depth_by VARCHAR, 
	depth_note VARCHAR, 
	rounds VARCHAR DEFAULT '{}' NOT NULL, 
	objections VARCHAR DEFAULT '[]' NOT NULL, 
	rulings VARCHAR DEFAULT '[]' NOT NULL, 
	arbitration_run_id VARCHAR, 
	reviewer_id VARCHAR, 
	seq_base INTEGER DEFAULT '0' NOT NULL, 
	attached_by VARCHAR, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (ticket_id)
)",
        )
        .await?;
    }
    ops::create_index_if_missing(conn, "ix_ai_ticket_workflow_project_id", "ai_ticket_workflow", &["project_id"]).await?;
    ops::create_index_if_missing(conn, "ix_ai_ticket_workflow_state", "ai_ticket_workflow", &["state"]).await?;
    if !ops::has_table(conn, "ai_ticket_step").await? {
        ops::exec(
            conn,
            r#"CREATE TABLE ai_ticket_step (
	id VARCHAR NOT NULL, 
	ticket_id VARCHAR NOT NULL, 
	seq INTEGER DEFAULT '0' NOT NULL, 
	idx INTEGER DEFAULT '0' NOT NULL, 
	"key" VARCHAR NOT NULL, 
	label VARCHAR NOT NULL, 
	kind VARCHAR DEFAULT 'ai' NOT NULL, 
	role VARCHAR, 
	state VARCHAR DEFAULT 'pending' NOT NULL, 
	attempt INTEGER DEFAULT '1' NOT NULL, 
	member_id VARCHAR, 
	run_id VARCHAR, 
	note_in VARCHAR, 
	note VARCHAR, 
	outcome VARCHAR, 
	result VARCHAR, 
	started_at VARCHAR, 
	ended_at VARCHAR, 
	PRIMARY KEY (id)
)"#,
        )
        .await?;
    }
    ops::create_index_if_missing(conn, "ix_ai_ticket_step_ticket_id", "ai_ticket_step", &["ticket_id"]).await?;
    ops::create_index_if_missing(conn, "ix_ai_ticket_step_state", "ai_ticket_step", &["state"]).await?;
    ops::create_index_if_missing(conn, "ix_ai_ticket_step_run_id", "ai_ticket_step", &["run_id"]).await?;
    if !ops::has_table(conn, "ai_standing_order").await? {
        ops::exec(
            conn,
            r"CREATE TABLE ai_standing_order (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	name VARCHAR NOT NULL, 
	sentence VARCHAR DEFAULT '' NOT NULL, 
	rule VARCHAR DEFAULT '{}' NOT NULL, 
	state VARCHAR DEFAULT 'off' NOT NULL, 
	trial_days INTEGER DEFAULT '3' NOT NULL, 
	trial_started_at VARCHAR, 
	trial_fired_at VARCHAR, 
	fired INTEGER DEFAULT '0' NOT NULL, 
	would_have INTEGER DEFAULT '0' NOT NULL, 
	last_fired_at VARCHAR, 
	last_summary VARCHAR, 
	template VARCHAR, 
	created_by VARCHAR, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id)
)",
        )
        .await?;
    }
    ops::create_index_if_missing(conn, "ix_ai_standing_order_project_id", "ai_standing_order", &["project_id"]).await?;
    ops::create_index_if_missing(conn, "ix_ai_standing_order_state", "ai_standing_order", &["state"]).await?;
    if !ops::has_table(conn, "ai_order_firing").await? {
        ops::exec(
            conn,
            r#"CREATE TABLE ai_order_firing (
	id VARCHAR NOT NULL, 
	order_id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	at VARCHAR NOT NULL, 
	target VARCHAR, 
	ticket_id VARCHAR, 
	"trigger" VARCHAR DEFAULT '{}' NOT NULL, 
	action VARCHAR DEFAULT '{}' NOT NULL, 
	would BOOLEAN DEFAULT '0' NOT NULL, 
	result VARCHAR, 
	undo VARCHAR, 
	undone_at VARCHAR, 
	undone_by VARCHAR, 
	PRIMARY KEY (id)
)"#,
        )
        .await?;
    }
    ops::create_index_if_missing(conn, "ix_ai_order_firing_order_id", "ai_order_firing", &["order_id"]).await?;
    ops::create_index_if_missing(conn, "ix_ai_order_firing_project_id", "ai_order_firing", &["project_id"]).await?;
    ops::create_index_if_missing(conn, "ix_ai_order_firing_at", "ai_order_firing", &["at"]).await?;
    ops::create_index_if_missing(conn, "ix_ai_order_firing_target", "ai_order_firing", &["target"]).await?;
    if !ops::has_table(conn, "ai_watched_pr").await? {
        ops::exec(
            conn,
            r"CREATE TABLE ai_watched_pr (
	ticket_id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	number INTEGER NOT NULL, 
	url VARCHAR, 
	branch VARCHAR NOT NULL, 
	repo VARCHAR NOT NULL, 
	state VARCHAR DEFAULT 'open' NOT NULL, 
	ci VARCHAR, 
	red VARCHAR, 
	seen_comments VARCHAR DEFAULT '[]' NOT NULL, 
	pending_comments VARCHAR DEFAULT '[]' NOT NULL, 
	checked_at VARCHAR, 
	last_error VARCHAR, 
	PRIMARY KEY (ticket_id)
)",
        )
        .await?;
    }
    ops::create_index_if_missing(conn, "ix_ai_watched_pr_project_id", "ai_watched_pr", &["project_id"]).await?;
    if !ops::has_table(conn, "ai_knowledge_doc").await? {
        ops::exec(
            conn,
            r"CREATE TABLE ai_knowledge_doc (
	id VARCHAR NOT NULL, 
	project_id VARCHAR, 
	store VARCHAR DEFAULT 'project' NOT NULL, 
	title VARCHAR NOT NULL, 
	kind VARCHAR DEFAULT 'text' NOT NULL, 
	text VARCHAR DEFAULT '' NOT NULL, 
	summary VARCHAR, 
	keywords VARCHAR DEFAULT '[]' NOT NULL, 
	answers VARCHAR DEFAULT '[]' NOT NULL, 
	described_by VARCHAR, 
	source_name VARCHAR, 
	upload_url VARCHAR, 
	private BOOLEAN DEFAULT '0' NOT NULL, 
	tokens INTEGER DEFAULT '0' NOT NULL, 
	created_by VARCHAR, 
	created_at VARCHAR NOT NULL, 
	last_read_at VARCHAR, 
	deleted_at VARCHAR, 
	PRIMARY KEY (id)
)",
        )
        .await?;
    }
    ops::create_index_if_missing(conn, "ix_ai_knowledge_doc_project_id", "ai_knowledge_doc", &["project_id"]).await?;
    ops::create_index_if_missing(conn, "ix_ai_knowledge_doc_store", "ai_knowledge_doc", &["store"]).await?;
    if !ops::has_table(conn, "ai_eval_mark").await? {
        ops::exec(
            conn,
            r"CREATE TABLE ai_eval_mark (
	id VARCHAR NOT NULL, 
	suite VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	member_id VARCHAR, 
	model VARCHAR, 
	state VARCHAR DEFAULT 'running' NOT NULL, 
	score FLOAT, 
	details VARCHAR DEFAULT '[]' NOT NULL, 
	runs VARCHAR DEFAULT '[]' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	ended_at VARCHAR, 
	PRIMARY KEY (id)
)",
        )
        .await?;
    }
    ops::create_index_if_missing(conn, "ix_ai_eval_mark_suite", "ai_eval_mark", &["suite"]).await?;
    ops::create_index_if_missing(conn, "ix_ai_eval_mark_created_at", "ai_eval_mark", &["created_at"]).await?;
    // no FTS5 in this SQLite: search falls back to the run's own fields
    let _ = conn.execute_unprepared(
        "CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(doc_id UNINDEXED, project_id UNINDEXED, store UNINDEXED, title, summary, keywords, body, tokenize = 'unicode61 remove_diacritics 2')",
    )
    .await;
    // no FTS5 in this SQLite: search falls back to the run's own fields
    let _ = conn.execute_unprepared(
        "CREATE VIRTUAL TABLE IF NOT EXISTS ai_run_fts USING fts5(run_id UNINDEXED, project_id UNINDEXED, body, tokenize = 'unicode61 remove_diacritics 2')",
    )
    .await;
    Ok(())
}
