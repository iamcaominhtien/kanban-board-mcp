-- mysql schema as `database.create_schema` makes it from the models (exported from the Python server).

CREATE TABLE ai_account (
	id VARCHAR(255) NOT NULL, 
	name VARCHAR(255) NOT NULL, 
	cli LONGTEXT NOT NULL, 
	folder LONGTEXT NOT NULL, 
	status LONGTEXT NOT NULL, 
	status_detail LONGTEXT, 
	email LONGTEXT, 
	plan LONGTEXT, 
	method LONGTEXT, 
	checked_at LONGTEXT, 
	signed_out_at LONGTEXT, 
	signed_out_how LONGTEXT, 
	created_by LONGTEXT, 
	created_at LONGTEXT NOT NULL, 
	updated_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE UNIQUE INDEX ix_ai_account_name ON ai_account (name);

CREATE TABLE ai_account_state (
	`key` VARCHAR(255) NOT NULL, 
	max_parallel INTEGER NOT NULL, 
	move_urgent BOOL NOT NULL, 
	five_hour_used FLOAT, 
	five_hour_resets_at LONGTEXT, 
	five_hour_status LONGTEXT, 
	seven_day_used FLOAT, 
	seven_day_resets_at LONGTEXT, 
	seven_day_status LONGTEXT, 
	held_until LONGTEXT, 
	held_reason LONGTEXT, 
	updated_at LONGTEXT, 
	PRIMARY KEY (`key`)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE ai_assist_settings (
	id INTEGER NOT NULL, 
	features LONGTEXT NOT NULL, 
	language LONGTEXT NOT NULL, 
	tone LONGTEXT NOT NULL, 
	style_guide LONGTEXT NOT NULL, 
	monthly_cap FLOAT, 
	per_request_cap FLOAT, 
	over_cap LONGTEXT NOT NULL, 
	data_scope LONGTEXT NOT NULL, 
	excluded_docs LONGTEXT NOT NULL, 
	health LONGTEXT NOT NULL, 
	paused_until LONGTEXT, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE ai_audit (
	id VARCHAR(255) NOT NULL, 
	seq INTEGER NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	member_id VARCHAR(255), 
	member_name LONGTEXT NOT NULL, 
	on_behalf_of LONGTEXT, 
	run_id VARCHAR(255), 
	action LONGTEXT NOT NULL, 
	target LONGTEXT, 
	result LONGTEXT NOT NULL, 
	detail LONGTEXT NOT NULL, 
	created_at LONGTEXT NOT NULL, 
	reverted_at LONGTEXT, 
	reverted_by LONGTEXT, 
	prev_hash LONGTEXT NOT NULL, 
	hash LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_audit_member_id ON ai_audit (member_id);

CREATE INDEX ix_ai_audit_project_id ON ai_audit (project_id);

CREATE INDEX ix_ai_audit_run_id ON ai_audit (run_id);

CREATE INDEX ix_ai_audit_seq ON ai_audit (seq);

CREATE TABLE ai_chat (
	id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	owner VARCHAR(255) NOT NULL, 
	title LONGTEXT NOT NULL, 
	scope LONGTEXT NOT NULL, 
	ticket_id LONGTEXT, 
	doc_id LONGTEXT, 
	scope_id VARCHAR(255), 
	member_id LONGTEXT, 
	include_docs LONGTEXT NOT NULL, 
	cost FLOAT NOT NULL, 
	tokens INTEGER NOT NULL, 
	applied BOOL NOT NULL, 
	session_id LONGTEXT, 
	summary LONGTEXT NOT NULL, 
	summary_upto LONGTEXT, 
	compactions INTEGER NOT NULL, 
	seen_at LONGTEXT, 
	created_at LONGTEXT NOT NULL, 
	updated_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_chat_owner ON ai_chat (owner);

CREATE INDEX ix_ai_chat_project_id ON ai_chat (project_id);

CREATE INDEX ix_ai_chat_scope_id ON ai_chat (scope_id);

CREATE TABLE ai_chat_message (
	id VARCHAR(255) NOT NULL, 
	chat_id VARCHAR(255) NOT NULL, 
	`role` LONGTEXT NOT NULL, 
	text LONGTEXT NOT NULL, 
	state LONGTEXT NOT NULL, 
	steps LONGTEXT NOT NULL, 
	context LONGTEXT NOT NULL, 
	actions LONGTEXT NOT NULL, 
	draft_id LONGTEXT, 
	error LONGTEXT NOT NULL, 
	retry_at LONGTEXT, 
	member_id LONGTEXT, 
	model LONGTEXT, 
	cost FLOAT NOT NULL, 
	tokens_in INTEGER NOT NULL, 
	tokens_out INTEGER NOT NULL, 
	metered BOOL NOT NULL, 
	feedback LONGTEXT NOT NULL, 
	created_at LONGTEXT NOT NULL, 
	finished_at LONGTEXT, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_chat_message_chat_id ON ai_chat_message (chat_id);

CREATE TABLE ai_config_state (
	member_id VARCHAR(255) NOT NULL, 
	version INTEGER NOT NULL, 
	synced_at LONGTEXT, 
	synced_files INTEGER NOT NULL, 
	ticks LONGTEXT NOT NULL, 
	files LONGTEXT NOT NULL, 
	hooks_ok LONGTEXT NOT NULL, 
	reset_snapshot LONGTEXT, 
	updated_at LONGTEXT NOT NULL, 
	PRIMARY KEY (member_id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE ai_digest (
	id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	day LONGTEXT NOT NULL, 
	summary LONGTEXT NOT NULL, 
	member_id LONGTEXT, 
	cost FLOAT NOT NULL, 
	tokens INTEGER NOT NULL, 
	created_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_digest_project_id ON ai_digest (project_id);

CREATE TABLE ai_insight (
	id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	kind LONGTEXT NOT NULL, 
	`key` VARCHAR(255) NOT NULL, 
	ticket_id LONGTEXT, 
	title LONGTEXT NOT NULL, 
	detail LONGTEXT NOT NULL, 
	data LONGTEXT NOT NULL, 
	score FLOAT NOT NULL, 
	state LONGTEXT NOT NULL, 
	snoozed_until LONGTEXT, 
	seen BOOL NOT NULL, 
	draft_id LONGTEXT, 
	created_at LONGTEXT NOT NULL, 
	updated_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_insight_key ON ai_insight (`key`);

CREATE INDEX ix_ai_insight_project_id ON ai_insight (project_id);

CREATE TABLE ai_knowledge_doc (
	id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255), 
	store VARCHAR(255) NOT NULL, 
	title LONGTEXT NOT NULL, 
	kind LONGTEXT NOT NULL, 
	text LONGTEXT NOT NULL, 
	summary LONGTEXT, 
	keywords LONGTEXT NOT NULL, 
	answers LONGTEXT NOT NULL, 
	described_by LONGTEXT, 
	source_name LONGTEXT, 
	upload_url LONGTEXT, 
	private BOOL NOT NULL, 
	tokens INTEGER NOT NULL, 
	created_by LONGTEXT, 
	created_at LONGTEXT NOT NULL, 
	last_read_at LONGTEXT, 
	deleted_at LONGTEXT, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_knowledge_doc_project_id ON ai_knowledge_doc (project_id);

CREATE INDEX ix_ai_knowledge_doc_store ON ai_knowledge_doc (store);

CREATE TABLE ai_lesson (
	id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	text LONGTEXT NOT NULL, 
	state VARCHAR(255) NOT NULL, 
	source_ticket_id VARCHAR(255), 
	source_run_id LONGTEXT, 
	proposed_by LONGTEXT, 
	kept_by LONGTEXT, 
	uses INTEGER NOT NULL, 
	last_used_at LONGTEXT, 
	created_at LONGTEXT NOT NULL, 
	updated_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_lesson_project_id ON ai_lesson (project_id);

CREATE INDEX ix_ai_lesson_source_ticket_id ON ai_lesson (source_ticket_id);

CREATE INDEX ix_ai_lesson_state ON ai_lesson (state);

CREATE TABLE ai_library_item (
	id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	type LONGTEXT NOT NULL, 
	name LONGTEXT NOT NULL, 
	description LONGTEXT NOT NULL, 
	content LONGTEXT NOT NULL, 
	version INTEGER NOT NULL, 
	history LONGTEXT NOT NULL, 
	created_by LONGTEXT, 
	created_at LONGTEXT NOT NULL, 
	updated_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_library_item_project_id ON ai_library_item (project_id);

CREATE TABLE ai_memory_note (
	id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	scope VARCHAR(255) NOT NULL, 
	scope_key VARCHAR(255) NOT NULL, 
	text LONGTEXT NOT NULL, 
	kind LONGTEXT NOT NULL, 
	written_by LONGTEXT, 
	source_run_id LONGTEXT, 
	source_ticket_id LONGTEXT, 
	uses INTEGER NOT NULL, 
	last_used_at LONGTEXT, 
	created_at LONGTEXT NOT NULL, 
	updated_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_memory_note_project_id ON ai_memory_note (project_id);

CREATE INDEX ix_ai_memory_note_scope ON ai_memory_note (scope);

CREATE INDEX ix_ai_memory_note_scope_key ON ai_memory_note (scope_key);

CREATE TABLE ai_plugin (
	id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255), 
	name VARCHAR(255) NOT NULL, 
	source_kind LONGTEXT NOT NULL, 
	source LONGTEXT NOT NULL, 
	ref LONGTEXT, 
	plugin LONGTEXT, 
	skills_wanted LONGTEXT NOT NULL, 
	commit LONGTEXT, 
	version LONGTEXT, 
	description LONGTEXT, 
	path LONGTEXT, 
	skills LONGTEXT NOT NULL, 
	hooks INTEGER NOT NULL, 
	mcp INTEGER NOT NULL, 
	size_bytes INTEGER NOT NULL, 
	pinned BOOL NOT NULL, 
	default_on BOOL NOT NULL, 
	roles LONGTEXT NOT NULL, 
	members LONGTEXT NOT NULL, 
	previous LONGTEXT, 
	installed_by LONGTEXT, 
	installed_at LONGTEXT NOT NULL, 
	updated_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_plugin_name ON ai_plugin (name);

CREATE INDEX ix_ai_plugin_project_id ON ai_plugin (project_id);

CREATE TABLE ai_project_knowledge (
	project_id VARCHAR(255) NOT NULL, 
	instructions LONGTEXT NOT NULL, 
	history LONGTEXT NOT NULL, 
	updated_at LONGTEXT, 
	updated_by LONGTEXT, 
	PRIMARY KEY (project_id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE ai_project_settings (
	project_id VARCHAR(255) NOT NULL, 
	paused_all BOOL NOT NULL, 
	paused_at LONGTEXT, 
	paused_reason LONGTEXT, 
	board_daily_cap FLOAT, 
	board_monthly_budget FLOAT, 
	board_tokens_per_day INTEGER, 
	board_max_parallel INTEGER NOT NULL, 
	board_runs_per_day INTEGER, 
	board_at_cap LONGTEXT NOT NULL, 
	run_memory_limit_mb INTEGER NOT NULL, 
	audit_retention_days INTEGER, 
	run_retention_days INTEGER, 
	permission_mode LONGTEXT NOT NULL, 
	deny_list LONGTEXT NOT NULL, 
	lessons_mode LONGTEXT NOT NULL, 
	lessons_max INTEGER NOT NULL, 
	ops LONGTEXT NOT NULL, 
	PRIMARY KEY (project_id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE ai_repo_scan (
	id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	folder LONGTEXT NOT NULL, 
	found LONGTEXT NOT NULL, 
	suggested LONGTEXT NOT NULL, 
	trial LONGTEXT NOT NULL, 
	job LONGTEXT NOT NULL, 
	proposal LONGTEXT NOT NULL, 
	applied_at LONGTEXT, 
	created_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_repo_scan_project_id ON ai_repo_scan (project_id);

CREATE TABLE ai_role_pack (
	id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	`key` VARCHAR(255) NOT NULL, 
	name LONGTEXT NOT NULL, 
	version INTEGER NOT NULL, 
	body LONGTEXT NOT NULL, 
	roles LONGTEXT NOT NULL, 
	history LONGTEXT NOT NULL, 
	created_at LONGTEXT NOT NULL, 
	updated_at LONGTEXT NOT NULL, 
	updated_by LONGTEXT, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_role_pack_key ON ai_role_pack (`key`);

CREATE INDEX ix_ai_role_pack_project_id ON ai_role_pack (project_id);

CREATE TABLE ai_run (
	id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	kind LONGTEXT NOT NULL, 
	ticket_id VARCHAR(255), 
	target VARCHAR(255), 
	member_id VARCHAR(255) NOT NULL, 
	number INTEGER NOT NULL, 
	mode LONGTEXT NOT NULL, 
	`trigger` LONGTEXT NOT NULL, 
	depth INTEGER NOT NULL, 
	state VARCHAR(255) NOT NULL, 
	started_by LONGTEXT NOT NULL, 
	instruction LONGTEXT NOT NULL, 
	reply_comment_id LONGTEXT, 
	queued_at LONGTEXT NOT NULL, 
	started_at LONGTEXT, 
	ended_at LONGTEXT, 
	last_output_at LONGTEXT, 
	ended_reason LONGTEXT, 
	ended_by LONGTEXT, 
	exit_code INTEGER, 
	summary LONGTEXT, 
	report LONGTEXT NOT NULL, 
	question LONGTEXT, 
	answer LONGTEXT, 
	session_id LONGTEXT, 
	session_name LONGTEXT, 
	files LONGTEXT NOT NULL, 
	tokens_in INTEGER NOT NULL, 
	tokens_out INTEGER NOT NULL, 
	tokens_cached INTEGER, 
	cost_usd FLOAT NOT NULL, 
	metered BOOL NOT NULL, 
	context_used INTEGER, 
	context_window INTEGER, 
	pid INTEGER, 
	token_hash VARCHAR(255), 
	model LONGTEXT, 
	effort LONGTEXT, 
	paused BOOL NOT NULL, 
	paused_at LONGTEXT, 
	stop_code LONGTEXT, 
	peak_rss_mb FLOAT, 
	last_rss_mb FLOAT, 
	restarts LONGTEXT NOT NULL, 
	diagnosis LONGTEXT, 
	retries LONGTEXT NOT NULL, 
	retry_at LONGTEXT, 
	account_id VARCHAR(255), 
	debug_log LONGTEXT, 
	steps_count INTEGER NOT NULL, 
	waiting_reason LONGTEXT, 
	live BOOL NOT NULL, 
	details_removed_at LONGTEXT, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_run_account_id ON ai_run (account_id);

CREATE INDEX ix_ai_run_member_id ON ai_run (member_id);

CREATE INDEX ix_ai_run_project_id ON ai_run (project_id);

CREATE INDEX ix_ai_run_state ON ai_run (state);

CREATE INDEX ix_ai_run_target ON ai_run (target);

CREATE INDEX ix_ai_run_ticket_id ON ai_run (ticket_id);

CREATE INDEX ix_ai_run_token_hash ON ai_run (token_hash);

CREATE TABLE ai_run_agent (
	id VARCHAR(255) NOT NULL, 
	run_id VARCHAR(255) NOT NULL, 
	agent_type LONGTEXT NOT NULL, 
	claude_id LONGTEXT, 
	started_at LONGTEXT NOT NULL, 
	ended_at LONGTEXT, 
	steps_count INTEGER NOT NULL, 
	last_text LONGTEXT, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_run_agent_run_id ON ai_run_agent (run_id);

CREATE TABLE ai_run_command (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	run_id VARCHAR(255) NOT NULL, 
	command LONGTEXT NOT NULL, 
	payload LONGTEXT NOT NULL, 
	created_at LONGTEXT NOT NULL, 
	taken_at LONGTEXT, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_run_command_run_id ON ai_run_command (run_id);

CREATE TABLE ai_run_message (
	id VARCHAR(255) NOT NULL, 
	run_id VARCHAR(255) NOT NULL, 
	direction LONGTEXT NOT NULL, 
	peer LONGTEXT NOT NULL, 
	text LONGTEXT NOT NULL, 
	at LONGTEXT NOT NULL, 
	delivered_at LONGTEXT, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_run_message_run_id ON ai_run_message (run_id);

CREATE TABLE ai_run_step (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	run_id VARCHAR(255) NOT NULL, 
	seq INTEGER NOT NULL, 
	at LONGTEXT NOT NULL, 
	agent_id LONGTEXT, 
	kind LONGTEXT NOT NULL, 
	tool LONGTEXT, 
	title LONGTEXT NOT NULL, 
	detail LONGTEXT NOT NULL, 
	output LONGTEXT, 
	parent_tool_id LONGTEXT, 
	tool_id VARCHAR(255), 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_run_step_run_id ON ai_run_step (run_id);

CREATE INDEX ix_ai_run_step_run_seq ON ai_run_step (run_id, seq);

CREATE INDEX ix_ai_run_step_tool_id ON ai_run_step (tool_id);

CREATE TABLE ai_run_transcript (
	run_id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	member_id VARCHAR(255), 
	path LONGTEXT NOT NULL, 
	bytes INTEGER NOT NULL, 
	events INTEGER NOT NULL, 
	pinned BOOL NOT NULL, 
	pinned_by LONGTEXT, 
	started_at LONGTEXT NOT NULL, 
	ended_at VARCHAR(255), 
	deleted_at LONGTEXT, 
	PRIMARY KEY (run_id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_run_transcript_ended_at ON ai_run_transcript (ended_at);

CREATE INDEX ix_ai_run_transcript_member_id ON ai_run_transcript (member_id);

CREATE INDEX ix_ai_run_transcript_project_id ON ai_run_transcript (project_id);

CREATE TABLE ai_schedule (
	id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	ticket_id VARCHAR(255) NOT NULL, 
	member_id VARCHAR(255) NOT NULL, 
	backup_member_id LONGTEXT, 
	created_by LONGTEXT NOT NULL, 
	kind LONGTEXT NOT NULL, 
	run_at LONGTEXT, 
	days LONGTEXT NOT NULL, 
	time LONGTEXT NOT NULL, 
	tz LONGTEXT NOT NULL, 
	ends LONGTEXT NOT NULL, 
	ends_after INTEGER, 
	ends_on LONGTEXT, 
	window_end LONGTEXT, 
	checks LONGTEXT NOT NULL, 
	review LONGTEXT NOT NULL, 
	limits LONGTEXT NOT NULL, 
	catch_up LONGTEXT NOT NULL, 
	catch_up_hours FLOAT NOT NULL, 
	notify LONGTEXT NOT NULL, 
	notify_people LONGTEXT NOT NULL, 
	instruction LONGTEXT NOT NULL, 
	state VARCHAR(255) NOT NULL, 
	paused_reason LONGTEXT, 
	failures_in_row INTEGER NOT NULL, 
	runs_count INTEGER NOT NULL, 
	next_run_at VARCHAR(255), 
	ticket_seen_at LONGTEXT, 
	created_at LONGTEXT NOT NULL, 
	updated_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_schedule_member_id ON ai_schedule (member_id);

CREATE INDEX ix_ai_schedule_next_run_at ON ai_schedule (next_run_at);

CREATE INDEX ix_ai_schedule_project_id ON ai_schedule (project_id);

CREATE INDEX ix_ai_schedule_state ON ai_schedule (state);

CREATE INDEX ix_ai_schedule_ticket_id ON ai_schedule (ticket_id);

CREATE TABLE ai_schedule_run (
	id VARCHAR(255) NOT NULL, 
	schedule_id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	ticket_id VARCHAR(255) NOT NULL, 
	slot_at VARCHAR(255) NOT NULL, 
	state VARCHAR(255) NOT NULL, 
	catch_up BOOL NOT NULL, 
	member_id LONGTEXT, 
	run_ids LONGTEXT NOT NULL, 
	attempts INTEGER NOT NULL, 
	fix_round INTEGER NOT NULL, 
	results LONGTEXT NOT NULL, 
	review LONGTEXT NOT NULL, 
	note LONGTEXT, 
	started_at LONGTEXT, 
	ended_at LONGTEXT, 
	duration_s INTEGER NOT NULL, 
	cost_usd FLOAT NOT NULL, 
	created_at LONGTEXT NOT NULL, 
	updated_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_schedule_run_project_id ON ai_schedule_run (project_id);

CREATE INDEX ix_ai_schedule_run_schedule_id ON ai_schedule_run (schedule_id);

CREATE INDEX ix_ai_schedule_run_state ON ai_schedule_run (state);

CREATE INDEX ix_ai_schedule_run_ticket_id ON ai_schedule_run (ticket_id);

CREATE UNIQUE INDEX ux_ai_schedule_slot ON ai_schedule_run (schedule_id, slot_at);

CREATE TABLE ai_session_history (
	id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	ticket_id VARCHAR(255) NOT NULL, 
	member_id LONGTEXT NOT NULL, 
	title LONGTEXT NOT NULL, 
	summary LONGTEXT NOT NULL, 
	session_ids LONGTEXT NOT NULL, 
	run_ids LONGTEXT NOT NULL, 
	started_at LONGTEXT, 
	ended_at LONGTEXT NOT NULL, 
	created_by LONGTEXT NOT NULL, 
	summarised_by LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_session_history_project_id ON ai_session_history (project_id);

CREATE INDEX ix_ai_session_history_ticket_id ON ai_session_history (ticket_id);

CREATE TABLE ai_skill_use (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	run_id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	member_id VARCHAR(255), 
	kind LONGTEXT NOT NULL, 
	name VARCHAR(255) NOT NULL, 
	plugin VARCHAR(255), 
	at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_skill_use_member_id ON ai_skill_use (member_id);

CREATE INDEX ix_ai_skill_use_name ON ai_skill_use (name);

CREATE INDEX ix_ai_skill_use_plugin ON ai_skill_use (plugin);

CREATE INDEX ix_ai_skill_use_project_id ON ai_skill_use (project_id);

CREATE INDEX ix_ai_skill_use_run_id ON ai_skill_use (run_id);

CREATE TABLE ai_team (
	id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	provider LONGTEXT NOT NULL, 
	connection LONGTEXT NOT NULL, 
	description LONGTEXT NOT NULL, 
	cli_path LONGTEXT, 
	working_dir LONGTEXT, 
	model LONGTEXT, 
	effort LONGTEXT, 
	persona LONGTEXT NOT NULL, 
	pack_key LONGTEXT, 
	config LONGTEXT NOT NULL, 
	permission_mode LONGTEXT NOT NULL, 
	max_parallel INTEGER NOT NULL, 
	daily_budget FLOAT, 
	monthly_cap FLOAT, 
	max_runs_per_day INTEGER, 
	tokens_per_day INTEGER, 
	cap_per_run FLOAT, 
	scope LONGTEXT NOT NULL, 
	paused BOOL NOT NULL, 
	paused_at LONGTEXT, 
	paused_reason LONGTEXT, 
	health LONGTEXT NOT NULL, 
	health_detail LONGTEXT, 
	checked_at LONGTEXT, 
	account_id VARCHAR(255), 
	mcp_last_used_at LONGTEXT, 
	created_by LONGTEXT, 
	created_at LONGTEXT NOT NULL, 
	updated_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_team_account_id ON ai_team (account_id);

CREATE INDEX ix_ai_team_project_id ON ai_team (project_id);

CREATE TABLE ai_touch_mark (
	`key` VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	mark LONGTEXT NOT NULL, 
	marked_by LONGTEXT, 
	marked_at LONGTEXT NOT NULL, 
	lesson_id LONGTEXT, 
	PRIMARY KEY (`key`)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_touch_mark_project_id ON ai_touch_mark (project_id);

CREATE TABLE ai_usage (
	id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	feature VARCHAR(255) NOT NULL, 
	member_id LONGTEXT, 
	person LONGTEXT, 
	cost FLOAT NOT NULL, 
	tokens_in INTEGER NOT NULL, 
	tokens_out INTEGER NOT NULL, 
	metered BOOL NOT NULL, 
	created_at VARCHAR(255) NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_usage_created_at ON ai_usage (created_at);

CREATE INDEX ix_ai_usage_feature ON ai_usage (feature);

CREATE INDEX ix_ai_usage_project_id ON ai_usage (project_id);

CREATE TABLE ai_watched_pr (
	ticket_id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	number INTEGER NOT NULL, 
	url LONGTEXT, 
	branch LONGTEXT NOT NULL, 
	repo LONGTEXT NOT NULL, 
	state LONGTEXT NOT NULL, 
	ci LONGTEXT, 
	red LONGTEXT, 
	seen_comments LONGTEXT NOT NULL, 
	pending_comments LONGTEXT NOT NULL, 
	checked_at LONGTEXT, 
	last_error LONGTEXT, 
	PRIMARY KEY (ticket_id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_watched_pr_project_id ON ai_watched_pr (project_id);

CREATE TABLE ai_worktree (
	ticket_id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	repo LONGTEXT NOT NULL, 
	path LONGTEXT NOT NULL, 
	branch LONGTEXT NOT NULL, 
	base LONGTEXT NOT NULL, 
	port INTEGER, 
	state VARCHAR(255) NOT NULL, 
	handover LONGTEXT, 
	pr_url LONGTEXT, 
	pr_number INTEGER, 
	conflict_files LONGTEXT NOT NULL, 
	prepared_at LONGTEXT, 
	prepare_s INTEGER, 
	created_at LONGTEXT NOT NULL, 
	last_used_at LONGTEXT, 
	merged_at LONGTEXT, 
	PRIMARY KEY (ticket_id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ai_worktree_project_id ON ai_worktree (project_id);

CREATE INDEX ix_ai_worktree_state ON ai_worktree (state);

CREATE TABLE canvas (
	id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255), 
	owner_kind LONGTEXT NOT NULL, 
	owner_id VARCHAR(255) NOT NULL, 
	page_id VARCHAR(255), 
	title LONGTEXT NOT NULL, 
	rev INTEGER NOT NULL, 
	version INTEGER NOT NULL, 
	board_count INTEGER NOT NULL, 
	total_bytes INTEGER NOT NULL, 
	created_by LONGTEXT NOT NULL, 
	created_at LONGTEXT NOT NULL, 
	updated_by LONGTEXT NOT NULL, 
	updated_at LONGTEXT NOT NULL, 
	deleted_at LONGTEXT, 
	deleted_by LONGTEXT, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_canvas_owner_id ON canvas (owner_id);

CREATE INDEX ix_canvas_page_id ON canvas (page_id);

CREATE INDEX ix_canvas_project_id ON canvas (project_id);

CREATE TABLE canvas_comment (
	id VARCHAR(255) NOT NULL, 
	thread_id VARCHAR(255) NOT NULL, 
	author LONGTEXT NOT NULL, 
	body LONGTEXT NOT NULL, 
	mentions LONGTEXT NOT NULL, 
	ai LONGTEXT, 
	created_at LONGTEXT NOT NULL, 
	edited_at LONGTEXT, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_canvas_comment_thread_id ON canvas_comment (thread_id);

CREATE TABLE canvas_proposal (
	id VARCHAR(255) NOT NULL, 
	canvas_id VARCHAR(255) NOT NULL, 
	author LONGTEXT NOT NULL, 
	member_id LONGTEXT, 
	job_id LONGTEXT, 
	request LONGTEXT NOT NULL, 
	note LONGTEXT NOT NULL, 
	status LONGTEXT NOT NULL, 
	changes LONGTEXT NOT NULL, 
	version INTEGER, 
	created_at LONGTEXT NOT NULL, 
	decided_by LONGTEXT, 
	decided_at LONGTEXT, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_canvas_proposal_canvas_id ON canvas_proposal (canvas_id);

CREATE TABLE canvas_thread (
	id VARCHAR(255) NOT NULL, 
	canvas_id VARCHAR(255) NOT NULL, 
	number INTEGER NOT NULL, 
	board_id LONGTEXT, 
	x FLOAT NOT NULL, 
	y FLOAT NOT NULL, 
	page LONGTEXT, 
	anchor LONGTEXT, 
	status LONGTEXT NOT NULL, 
	created_by LONGTEXT NOT NULL, 
	created_at LONGTEXT NOT NULL, 
	resolved_by LONGTEXT, 
	resolved_at LONGTEXT, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_canvas_thread_canvas_id ON canvas_thread (canvas_id);

CREATE TABLE canvas_version (
	id VARCHAR(255) NOT NULL, 
	canvas_id VARCHAR(255) NOT NULL, 
	version INTEGER NOT NULL, 
	name LONGTEXT, 
	reason LONGTEXT NOT NULL, 
	author LONGTEXT NOT NULL, 
	note LONGTEXT, 
	changes LONGTEXT NOT NULL, 
	summary LONGTEXT NOT NULL, 
	doc LONGTEXT NOT NULL, 
	created_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_canvas_version UNIQUE (canvas_id, version)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_canvas_version_canvas_id ON canvas_version (canvas_id);

CREATE TABLE diagram (
	id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	label LONGTEXT NOT NULL, 
	summary LONGTEXT NOT NULL, 
	item_kind LONGTEXT, 
	item_id VARCHAR(255), 
	version INTEGER NOT NULL, 
	created_by LONGTEXT NOT NULL, 
	created_at LONGTEXT NOT NULL, 
	updated_by LONGTEXT NOT NULL, 
	updated_at LONGTEXT NOT NULL, 
	deleted_at LONGTEXT, 
	deleted_by LONGTEXT, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_diagram_item_id ON diagram (item_id);

CREATE INDEX ix_diagram_project_id ON diagram (project_id);

CREATE TABLE diagram_settings (
	id INTEGER NOT NULL, 
	mode LONGTEXT NOT NULL, 
	url LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE diagram_version (
	id VARCHAR(255) NOT NULL, 
	diagram_id VARCHAR(255) NOT NULL, 
	version INTEGER NOT NULL, 
	source LONGTEXT NOT NULL, 
	svg LONGTEXT NOT NULL, 
	preview_kind LONGTEXT NOT NULL, 
	author LONGTEXT NOT NULL, 
	note LONGTEXT, 
	created_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_diagram_version_diagram_id ON diagram_version (diagram_id);

CREATE TABLE docs_ai_health (
	project_id VARCHAR(255) NOT NULL, 
	data LONGTEXT NOT NULL, 
	checked_at LONGTEXT, 
	digest_at LONGTEXT, 
	PRIMARY KEY (project_id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE docs_ai_ignore (
	page_id VARCHAR(255) NOT NULL, 
	`key` VARCHAR(255) NOT NULL, 
	`by` LONGTEXT NOT NULL, 
	at LONGTEXT NOT NULL, 
	PRIMARY KEY (page_id, `key`)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE docs_ai_job (
	id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	page_id VARCHAR(255), 
	thread_id VARCHAR(255), 
	comment_id LONGTEXT, 
	member_id VARCHAR(255), 
	kind VARCHAR(255) NOT NULL, 
	state VARCHAR(255) NOT NULL, 
	started_by LONGTEXT NOT NULL, 
	instruction LONGTEXT NOT NULL, 
	session_id LONGTEXT, 
	`reads` LONGTEXT NOT NULL, 
	steps LONGTEXT NOT NULL, 
	result LONGTEXT NOT NULL, 
	error LONGTEXT NOT NULL, 
	tokens_in INTEGER NOT NULL, 
	tokens_out INTEGER NOT NULL, 
	cost_usd FLOAT NOT NULL, 
	metered BOOL NOT NULL, 
	reply_comment_id LONGTEXT, 
	queued_at LONGTEXT NOT NULL, 
	started_at LONGTEXT, 
	ended_at LONGTEXT, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_docs_ai_job_kind ON docs_ai_job (kind);

CREATE INDEX ix_docs_ai_job_member_id ON docs_ai_job (member_id);

CREATE INDEX ix_docs_ai_job_page_id ON docs_ai_job (page_id);

CREATE INDEX ix_docs_ai_job_project_id ON docs_ai_job (project_id);

CREATE INDEX ix_docs_ai_job_state ON docs_ai_job (state);

CREATE INDEX ix_docs_ai_job_thread_id ON docs_ai_job (thread_id);

CREATE TABLE docs_ai_session (
	scope VARCHAR(255) NOT NULL, 
	member_id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	session_id LONGTEXT NOT NULL, 
	calls INTEGER NOT NULL, 
	updated_at LONGTEXT NOT NULL, 
	PRIMARY KEY (scope, member_id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_docs_ai_session_project_id ON docs_ai_session (project_id);

CREATE TABLE docs_ai_settings (
	project_id VARCHAR(255) NOT NULL, 
	enabled BOOL NOT NULL, 
	member_id LONGTEXT, 
	style_page_id LONGTEXT, 
	freshness_on BOOL NOT NULL, 
	digest_on BOOL NOT NULL, 
	updated_by LONGTEXT, 
	updated_at LONGTEXT NOT NULL, 
	PRIMARY KEY (project_id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE docs_anchor_aliases (
	id VARCHAR(255) NOT NULL, 
	page_id VARCHAR(255) NOT NULL, 
	old_slug LONGTEXT NOT NULL, 
	new_slug LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_docs_anchor_aliases_page_id ON docs_anchor_aliases (page_id);

CREATE TABLE docs_comment (
	id VARCHAR(255) NOT NULL, 
	thread_id VARCHAR(255) NOT NULL, 
	author LONGTEXT NOT NULL, 
	body LONGTEXT NOT NULL, 
	mentions LONGTEXT NOT NULL, 
	created_at LONGTEXT NOT NULL, 
	edited_at LONGTEXT, 
	ai LONGTEXT, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_docs_comment_thread_id ON docs_comment (thread_id);

CREATE TABLE docs_comment_event (
	id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	page_id VARCHAR(255), 
	thread_id LONGTEXT, 
	comment_id LONGTEXT, 
	kind LONGTEXT NOT NULL, 
	actor LONGTEXT NOT NULL, 
	mentioned LONGTEXT NOT NULL, 
	recipients LONGTEXT NOT NULL, 
	page_title LONGTEXT NOT NULL, 
	snippet LONGTEXT NOT NULL, 
	created_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_docs_comment_event_page_id ON docs_comment_event (page_id);

CREATE INDEX ix_docs_comment_event_project_id ON docs_comment_event (project_id);

CREATE TABLE docs_comment_read (
	id VARCHAR(255) NOT NULL, 
	thread_id VARCHAR(255) NOT NULL, 
	reader LONGTEXT NOT NULL, 
	read_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_docs_comment_read_thread_id ON docs_comment_read (thread_id);

CREATE TABLE docs_comment_thread (
	id VARCHAR(255) NOT NULL, 
	page_id VARCHAR(255) NOT NULL, 
	kind LONGTEXT NOT NULL, 
	status LONGTEXT NOT NULL, 
	anchor_quote LONGTEXT, 
	anchor_prefix LONGTEXT NOT NULL, 
	anchor_suffix LONGTEXT NOT NULL, 
	anchor_section LONGTEXT, 
	anchor_state LONGTEXT NOT NULL, 
	anchor_pos INTEGER, 
	created_by LONGTEXT NOT NULL, 
	created_at LONGTEXT NOT NULL, 
	resolved_by LONGTEXT, 
	resolved_at LONGTEXT, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_docs_comment_thread_page_id ON docs_comment_thread (page_id);

CREATE TABLE docs_draft (
	id VARCHAR(255) NOT NULL, 
	page_id VARCHAR(255) NOT NULL, 
	author LONGTEXT NOT NULL, 
	title LONGTEXT NOT NULL, 
	markdown LONGTEXT NOT NULL, 
	base_version INTEGER NOT NULL, 
	saves INTEGER NOT NULL, 
	updated_at LONGTEXT NOT NULL, 
	ai_source LONGTEXT, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_docs_draft_page_id ON docs_draft (page_id);

CREATE TABLE docs_link (
	id VARCHAR(255) NOT NULL, 
	source_page_id VARCHAR(255) NOT NULL, 
	source_section LONGTEXT, 
	target_page_id VARCHAR(255), 
	target_title LONGTEXT, 
	target_anchor LONGTEXT, 
	target_ticket_id VARCHAR(255), 
	display_text LONGTEXT, 
	snippet LONGTEXT NOT NULL, 
	origin LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_docs_link_source_page_id ON docs_link (source_page_id);

CREATE INDEX ix_docs_link_target_page_id ON docs_link (target_page_id);

CREATE INDEX ix_docs_link_target_ticket_id ON docs_link (target_ticket_id);

CREATE TABLE docs_page (
	id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	parent_id VARCHAR(255), 
	position INTEGER NOT NULL, 
	title LONGTEXT NOT NULL, 
	slug LONGTEXT NOT NULL, 
	status LONGTEXT NOT NULL, 
	version INTEGER NOT NULL, 
	created_by LONGTEXT NOT NULL, 
	updated_by LONGTEXT NOT NULL, 
	created_at LONGTEXT NOT NULL, 
	updated_at LONGTEXT NOT NULL, 
	deleted_at LONGTEXT, 
	deleted_by LONGTEXT, 
	deleted_root_id LONGTEXT, 
	kind LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_docs_page_parent_id ON docs_page (parent_id);

CREATE INDEX ix_docs_page_project_id ON docs_page (project_id);

CREATE TABLE docs_page_seen (
	id VARCHAR(255) NOT NULL, 
	page_id VARCHAR(255) NOT NULL, 
	viewer LONGTEXT NOT NULL, 
	version INTEGER NOT NULL, 
	seen_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_docs_page_seen_page_id ON docs_page_seen (page_id);

CREATE TABLE docs_title_aliases (
	id VARCHAR(255) NOT NULL, 
	page_id VARCHAR(255) NOT NULL, 
	old_title LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_docs_title_aliases_page_id ON docs_title_aliases (page_id);

CREATE TABLE docs_version (
	id VARCHAR(255) NOT NULL, 
	page_id VARCHAR(255) NOT NULL, 
	version INTEGER NOT NULL, 
	title LONGTEXT NOT NULL, 
	markdown LONGTEXT NOT NULL, 
	author LONGTEXT NOT NULL, 
	note LONGTEXT, 
	created_at LONGTEXT NOT NULL, 
	diagram_versions LONGTEXT NOT NULL, 
	with_ai BOOL NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_docs_version_page_id ON docs_version (page_id);

CREATE TABLE idea_advice (
	id VARCHAR(255) NOT NULL, 
	idea_id VARCHAR(255) NOT NULL, 
	action LONGTEXT NOT NULL, 
	reason LONGTEXT NOT NULL, 
	confidence LONGTEXT NOT NULL, 
	target_id LONGTEXT, 
	archive_reason LONGTEXT, 
	park_days INTEGER, 
	idea_stamp LONGTEXT NOT NULL, 
	member_id LONGTEXT, 
	cost FLOAT NOT NULL, 
	state LONGTEXT NOT NULL, 
	created_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_idea_advice_idea_id ON idea_advice (idea_id);

CREATE TABLE idea_ai_settings (
	project_id VARCHAR(255) NOT NULL, 
	enabled BOOL NOT NULL, 
	triage_advice BOOL NOT NULL, 
	weekly_grooming BOOL NOT NULL, 
	ask BOOL NOT NULL, 
	read_docs BOOL NOT NULL, 
	read_repo BOOL NOT NULL, 
	daily_cap FLOAT NOT NULL, 
	updated_at LONGTEXT NOT NULL, 
	PRIMARY KEY (project_id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE idea_assumption (
	id VARCHAR(255) NOT NULL, 
	idea_id VARCHAR(255) NOT NULL, 
	position INTEGER NOT NULL, 
	text LONGTEXT NOT NULL, 
	impact LONGTEXT NOT NULL, 
	status LONGTEXT NOT NULL, 
	test_ticket_id LONGTEXT, 
	ai BOOL NOT NULL, 
	created_at LONGTEXT NOT NULL, 
	updated_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_idea_assumption_idea_id ON idea_assumption (idea_id);

CREATE TABLE idea_comment (
	id VARCHAR(255) NOT NULL, 
	idea_id VARCHAR(255) NOT NULL, 
	author LONGTEXT, 
	body LONGTEXT NOT NULL, 
	ai BOOL NOT NULL, 
	run_id LONGTEXT, 
	created_at LONGTEXT NOT NULL, 
	edited_at LONGTEXT, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_idea_comment_idea_id ON idea_comment (idea_id);

CREATE TABLE idea_counter (
	id INTEGER NOT NULL, 
	counter INTEGER NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE idea_digest (
	id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	text LONGTEXT NOT NULL, 
	items LONGTEXT NOT NULL, 
	ai BOOL NOT NULL, 
	member_id LONGTEXT, 
	cost FLOAT NOT NULL, 
	ideas_read INTEGER NOT NULL, 
	created_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_idea_digest_project_id ON idea_digest (project_id);

CREATE TABLE idea_evidence (
	id VARCHAR(255) NOT NULL, 
	assumption_id VARCHAR(255) NOT NULL, 
	kind LONGTEXT NOT NULL, 
	title LONGTEXT NOT NULL, 
	ref LONGTEXT NOT NULL, 
	created_by LONGTEXT, 
	created_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_idea_evidence_assumption_id ON idea_evidence (assumption_id);

CREATE TABLE idea_log_entry (
	id VARCHAR(255) NOT NULL, 
	idea_id VARCHAR(255) NOT NULL, 
	kind LONGTEXT NOT NULL, 
	body LONGTEXT NOT NULL, 
	author LONGTEXT, 
	ai BOOL NOT NULL, 
	pinned BOOL NOT NULL, 
	assumption_id LONGTEXT, 
	attachments LONGTEXT NOT NULL, 
	ticket_id LONGTEXT, 
	created_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_idea_log_entry_idea_id ON idea_log_entry (idea_id);

CREATE TABLE idea_ticket (
	id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255), 
	title LONGTEXT NOT NULL, 
	description LONGTEXT NOT NULL, 
	idea_status LONGTEXT NOT NULL, 
	stage VARCHAR(255) NOT NULL, 
	park_until LONGTEXT, 
	archive_reason LONGTEXT, 
	source LONGTEXT NOT NULL, 
	source_ref LONGTEXT NOT NULL, 
	created_by LONGTEXT, 
	owner LONGTEXT, 
	park_note LONGTEXT, 
	archive_note LONGTEXT, 
	stage_changed_at LONGTEXT, 
	prev_state LONGTEXT NOT NULL, 
	merged_into_id LONGTEXT, 
	merged_at LONGTEXT, 
	merge_undo LONGTEXT NOT NULL, 
	shipped_at LONGTEXT, 
	outcome LONGTEXT, 
	outcome_note LONGTEXT, 
	former_ticket_id LONGTEXT, 
	effort_guess LONGTEXT, 
	workspace_retention LONGTEXT NOT NULL, 
	body LONGTEXT NOT NULL, 
	details LONGTEXT NOT NULL, 
	idea_color LONGTEXT NOT NULL, 
	idea_emoji LONGTEXT NOT NULL, 
	idea_energy LONGTEXT, 
	tags LONGTEXT NOT NULL, 
	problem_statement LONGTEXT, 
	ice_impact INTEGER NOT NULL, 
	ice_effort INTEGER NOT NULL, 
	ice_confidence INTEGER NOT NULL, 
	revisit_date LONGTEXT, 
	last_touched_at LONGTEXT, 
	promoted_to_ticket_id LONGTEXT, 
	promoted_at LONGTEXT, 
	activity_trail LONGTEXT NOT NULL, 
	microthoughts LONGTEXT NOT NULL, 
	assumptions LONGTEXT NOT NULL, 
	created_at LONGTEXT NOT NULL, 
	updated_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_idea_ticket_project_id ON idea_ticket (project_id);

CREATE INDEX ix_idea_ticket_stage ON idea_ticket (stage);

CREATE TABLE idea_vote (
	id VARCHAR(255) NOT NULL, 
	idea_id VARCHAR(255) NOT NULL, 
	voter VARCHAR(255) NOT NULL, 
	created_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_idea_vote_idea_id ON idea_vote (idea_id);

CREATE UNIQUE INDEX uq_idea_vote_idea_voter ON idea_vote (idea_id, voter);

CREATE TABLE `member` (
	id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	name LONGTEXT NOT NULL, 
	color LONGTEXT NOT NULL, 
	`role` LONGTEXT NOT NULL, 
	kind LONGTEXT NOT NULL, 
	created_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_member_project_id ON `member` (project_id);

CREATE TABLE notification (
	id VARCHAR(255) NOT NULL, 
	recipient VARCHAR(255) NOT NULL, 
	event_id INTEGER NOT NULL, 
	last_event_id INTEGER NOT NULL, 
	project_id VARCHAR(255), 
	kind VARCHAR(255) NOT NULL, 
	needs BOOL NOT NULL, 
	group_key VARCHAR(255) NOT NULL, 
	count INTEGER NOT NULL, 
	items LONGTEXT NOT NULL, 
	target_kind LONGTEXT, 
	target_id VARCHAR(255), 
	ticket_id LONGTEXT, 
	page_id LONGTEXT, 
	member_id LONGTEXT, 
	actor LONGTEXT, 
	title LONGTEXT NOT NULL, 
	body LONGTEXT NOT NULL, 
	data LONGTEXT NOT NULL, 
	inapp BOOL NOT NULL, 
	desktop BOOL NOT NULL, 
	read_at LONGTEXT, 
	done_at VARCHAR(255), 
	done_reason LONGTEXT, 
	done_by LONGTEXT, 
	snoozed_until LONGTEXT, 
	cleared_at LONGTEXT, 
	created_at VARCHAR(255) NOT NULL, 
	updated_at VARCHAR(255) NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_notification_created_at ON notification (created_at);

CREATE INDEX ix_notification_event_id ON notification (event_id);

CREATE INDEX ix_notification_group_key ON notification (group_key);

CREATE INDEX ix_notification_kind ON notification (kind);

CREATE INDEX ix_notification_last_event_id ON notification (last_event_id);

CREATE INDEX ix_notification_open_needs ON notification (needs, done_at);

CREATE INDEX ix_notification_project_id ON notification (project_id);

CREATE INDEX ix_notification_recipient ON notification (recipient);

CREATE INDEX ix_notification_recipient_open ON notification (recipient, done_at);

CREATE INDEX ix_notification_target_id ON notification (target_id);

CREATE INDEX ix_notification_updated_at ON notification (updated_at);

CREATE TABLE notify_event (
	id INTEGER NOT NULL AUTO_INCREMENT, 
	project_id VARCHAR(255), 
	kind VARCHAR(255) NOT NULL, 
	op LONGTEXT NOT NULL, 
	needs BOOL NOT NULL, 
	target_kind LONGTEXT, 
	target_id VARCHAR(255), 
	ticket_id LONGTEXT, 
	page_id LONGTEXT, 
	member_id LONGTEXT, 
	actor LONGTEXT, 
	title LONGTEXT NOT NULL, 
	body LONGTEXT NOT NULL, 
	data LONGTEXT NOT NULL, 
	recipients LONGTEXT NOT NULL, 
	created_at VARCHAR(255) NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_notify_event_created_at ON notify_event (created_at);

CREATE INDEX ix_notify_event_kind ON notify_event (kind);

CREATE INDEX ix_notify_event_project_id ON notify_event (project_id);

CREATE INDEX ix_notify_event_target_id ON notify_event (target_id);

CREATE TABLE notify_follow (
	id VARCHAR(255) NOT NULL, 
	recipient VARCHAR(255) NOT NULL, 
	scope LONGTEXT NOT NULL, 
	scope_id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255), 
	level LONGTEXT NOT NULL, 
	until LONGTEXT, 
	label LONGTEXT NOT NULL, 
	created_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_notify_follow_project_id ON notify_follow (project_id);

CREATE INDEX ix_notify_follow_recipient ON notify_follow (recipient);

CREATE INDEX ix_notify_follow_scope_id ON notify_follow (scope_id);

CREATE TABLE notify_prefs (
	recipient VARCHAR(255) NOT NULL, 
	prefs LONGTEXT NOT NULL, 
	updated_at LONGTEXT NOT NULL, 
	PRIMARY KEY (recipient)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE project (
	id VARCHAR(255) NOT NULL, 
	name LONGTEXT NOT NULL, 
	prefix VARCHAR(255) NOT NULL, 
	color LONGTEXT NOT NULL, 
	ticket_counter INTEGER NOT NULL, 
	repo_path LONGTEXT, 
	worktree_template LONGTEXT, 
	worktree_by_default BOOL NOT NULL, 
	docs_enabled BOOL NOT NULL, 
	docs_edit_policy LONGTEXT NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (prefix)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE sketch (
	id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255), 
	owner_kind LONGTEXT NOT NULL, 
	owner_id VARCHAR(255) NOT NULL, 
	title LONGTEXT NOT NULL, 
	width INTEGER NOT NULL, 
	height INTEGER NOT NULL, 
	layer_count INTEGER NOT NULL, 
	version INTEGER NOT NULL, 
	png_bytes INTEGER NOT NULL, 
	source_bytes INTEGER NOT NULL, 
	created_by LONGTEXT NOT NULL, 
	created_at LONGTEXT NOT NULL, 
	updated_by LONGTEXT NOT NULL, 
	updated_at LONGTEXT NOT NULL, 
	deleted_at LONGTEXT, 
	deleted_by LONGTEXT, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_sketch_owner_id ON sketch (owner_id);

CREATE INDEX ix_sketch_project_id ON sketch (project_id);

CREATE TABLE story (
	ticket_id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	state VARCHAR(255) NOT NULL, 
	approve LONGTEXT NOT NULL, 
	budget_tokens INTEGER NOT NULL, 
	pm_id LONGTEXT, 
	plan LONGTEXT NOT NULL, 
	paused BOOL NOT NULL, 
	review_note LONGTEXT, 
	history LONGTEXT NOT NULL, 
	meta LONGTEXT NOT NULL, 
	created_by LONGTEXT, 
	created_at LONGTEXT NOT NULL, 
	handed_at LONGTEXT, 
	started_at LONGTEXT, 
	closed_at LONGTEXT, 
	PRIMARY KEY (ticket_id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_story_project_id ON story (project_id);

CREATE INDEX ix_story_state ON story (state);

CREATE TABLE ticket (
	id VARCHAR(255) NOT NULL, 
	project_id VARCHAR(255) NOT NULL, 
	title LONGTEXT NOT NULL, 
	description LONGTEXT NOT NULL, 
	type LONGTEXT NOT NULL, 
	status VARCHAR(255) NOT NULL, 
	priority LONGTEXT NOT NULL, 
	estimate FLOAT, 
	due_date LONGTEXT, 
	tags LONGTEXT NOT NULL, 
	parent_id VARCHAR(255), 
	comments LONGTEXT NOT NULL, 
	acceptance_criteria LONGTEXT NOT NULL, 
	sub_tasks LONGTEXT NOT NULL, 
	activity_log LONGTEXT NOT NULL, 
	work_log LONGTEXT NOT NULL, 
	test_cases LONGTEXT NOT NULL, 
	start_date LONGTEXT, 
	wont_do_reason LONGTEXT, 
	created_by VARCHAR(255), 
	assignee VARCHAR(255), 
	blocks LONGTEXT NOT NULL, 
	blocked_by LONGTEXT NOT NULL, 
	block_done_if_acs_incomplete BOOL NOT NULL, 
	block_done_if_tcs_incomplete BOOL NOT NULL, 
	links LONGTEXT NOT NULL, 
	branches LONGTEXT NOT NULL, 
	workspace_retention_days INTEGER, 
	repo_path LONGTEXT, 
	reopen_count INTEGER NOT NULL, 
	last_reopened_at LONGTEXT, 
	last_reopened_by LONGTEXT, 
	last_reopen_reason LONGTEXT, 
	reopen_history LONGTEXT NOT NULL, 
	pending BOOL NOT NULL, 
	pending_reason_type LONGTEXT, 
	pending_ticket_id LONGTEXT, 
	pending_member_id LONGTEXT, 
	pending_party LONGTEXT, 
	pending_note LONGTEXT, 
	pending_since LONGTEXT, 
	pending_by LONGTEXT, 
	from_idea_id VARCHAR(255), 
	tests_assumption_id VARCHAR(255), 
	wave_pin INTEGER, 
	review_requested_from LONGTEXT, 
	created_at LONGTEXT NOT NULL, 
	updated_at LONGTEXT NOT NULL, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ticket_assignee ON ticket (assignee);

CREATE INDEX ix_ticket_from_idea_id ON ticket (from_idea_id);

CREATE INDEX ix_ticket_parent_id ON ticket (parent_id);

CREATE INDEX ix_ticket_project_status ON ticket (project_id, status);

CREATE INDEX ix_ticket_tests_assumption_id ON ticket (tests_assumption_id);

CREATE TABLE workspace_settings (
	id INTEGER NOT NULL, 
	enabled BOOL NOT NULL, 
	root_path LONGTEXT NOT NULL, 
	default_retention_days INTEGER, 
	PRIMARY KEY (id)
)ENGINE=InnoDB CHARSET=utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE kanban_change (
	id BIGINT NOT NULL AUTO_INCREMENT, 
	origin VARCHAR(32) NOT NULL, 
	at FLOAT NOT NULL, 
	PRIMARY KEY (id)
);
