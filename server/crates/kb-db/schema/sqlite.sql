-- SQLite schema at Alembic head b8d0f2a4c6e9, as the migrations leave it (exported from the Python server).

CREATE TABLE ai_account (
	id VARCHAR NOT NULL, 
	name VARCHAR NOT NULL, 
	cli VARCHAR NOT NULL, 
	folder VARCHAR NOT NULL, 
	status VARCHAR DEFAULT 'needs_sign_in' NOT NULL, 
	status_detail VARCHAR, 
	email VARCHAR, 
	"plan" VARCHAR, 
	method VARCHAR, 
	checked_at VARCHAR, 
	signed_out_at VARCHAR, 
	signed_out_how VARCHAR, 
	created_by VARCHAR, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE ai_account_state (
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
);

CREATE TABLE ai_assist_settings (
	id INTEGER NOT NULL, 
	features VARCHAR DEFAULT '{}' NOT NULL, 
	language VARCHAR DEFAULT 'English (US)' NOT NULL, 
	tone VARCHAR DEFAULT 'neutral' NOT NULL, 
	style_guide VARCHAR DEFAULT '' NOT NULL, 
	monthly_cap FLOAT, 
	per_request_cap FLOAT, 
	over_cap VARCHAR DEFAULT 'pause' NOT NULL, 
	data_scope VARCHAR DEFAULT '{}' NOT NULL, 
	excluded_docs VARCHAR DEFAULT '[]' NOT NULL, 
	health VARCHAR DEFAULT '{}' NOT NULL, 
	paused_until VARCHAR, 
	PRIMARY KEY (id)
);

CREATE TABLE ai_audit (
	id VARCHAR NOT NULL, 
	seq INTEGER DEFAULT '0' NOT NULL, 
	project_id VARCHAR NOT NULL, 
	member_id VARCHAR, 
	member_name VARCHAR DEFAULT '' NOT NULL, 
	on_behalf_of VARCHAR, 
	run_id VARCHAR, 
	action VARCHAR NOT NULL, 
	target VARCHAR, 
	result VARCHAR DEFAULT 'allowed' NOT NULL, 
	detail VARCHAR DEFAULT '{}' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	reverted_at VARCHAR, 
	reverted_by VARCHAR, 
	prev_hash VARCHAR DEFAULT '' NOT NULL, 
	hash VARCHAR DEFAULT '' NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE ai_chat (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	owner VARCHAR NOT NULL, 
	title VARCHAR DEFAULT 'New chat' NOT NULL, 
	scope VARCHAR DEFAULT 'project' NOT NULL, 
	ticket_id VARCHAR, 
	doc_id VARCHAR, 
	include_docs VARCHAR DEFAULT '[]' NOT NULL, 
	cost FLOAT DEFAULT '0' NOT NULL, 
	tokens INTEGER DEFAULT '0' NOT NULL, 
	applied BOOLEAN DEFAULT 0 NOT NULL, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, session_id VARCHAR, summary VARCHAR DEFAULT '' NOT NULL, summary_upto VARCHAR, compactions INTEGER DEFAULT '0' NOT NULL, scope_id VARCHAR, member_id VARCHAR, seen_at VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
);

CREATE TABLE ai_chat_message (
	id VARCHAR NOT NULL, 
	chat_id VARCHAR NOT NULL, 
	role VARCHAR NOT NULL, 
	text VARCHAR DEFAULT '' NOT NULL, 
	state VARCHAR DEFAULT 'done' NOT NULL, 
	steps VARCHAR DEFAULT '[]' NOT NULL, 
	context VARCHAR DEFAULT '{}' NOT NULL, 
	actions VARCHAR DEFAULT '[]' NOT NULL, 
	draft_id VARCHAR, 
	error VARCHAR DEFAULT '{}' NOT NULL, 
	retry_at VARCHAR, 
	member_id VARCHAR, 
	model VARCHAR, 
	cost FLOAT DEFAULT '0' NOT NULL, 
	tokens_in INTEGER DEFAULT '0' NOT NULL, 
	tokens_out INTEGER DEFAULT '0' NOT NULL, 
	metered BOOLEAN DEFAULT 1 NOT NULL, 
	created_at VARCHAR NOT NULL, 
	finished_at VARCHAR, feedback VARCHAR DEFAULT '{}' NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(chat_id) REFERENCES ai_chat (id)
);

CREATE TABLE ai_config_state (
	member_id VARCHAR NOT NULL, 
	version INTEGER DEFAULT '1' NOT NULL, 
	synced_at VARCHAR, 
	synced_files INTEGER DEFAULT '0' NOT NULL, 
	ticks VARCHAR DEFAULT '[]' NOT NULL, 
	files VARCHAR DEFAULT '{}' NOT NULL, 
	hooks_ok VARCHAR DEFAULT '{}' NOT NULL, 
	reset_snapshot VARCHAR, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (member_id), 
	FOREIGN KEY(member_id) REFERENCES ai_member (id)
);

CREATE TABLE ai_digest (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	day VARCHAR NOT NULL, 
	summary VARCHAR DEFAULT '{}' NOT NULL, 
	member_id VARCHAR, 
	cost FLOAT DEFAULT '0' NOT NULL, 
	tokens INTEGER DEFAULT '0' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
);

CREATE TABLE ai_insight (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	kind VARCHAR NOT NULL, 
	"key" VARCHAR NOT NULL, 
	ticket_id VARCHAR, 
	title VARCHAR NOT NULL, 
	detail VARCHAR DEFAULT '' NOT NULL, 
	data VARCHAR DEFAULT '{}' NOT NULL, 
	score FLOAT DEFAULT '0' NOT NULL, 
	state VARCHAR DEFAULT 'open' NOT NULL, 
	snoozed_until VARCHAR, 
	seen BOOLEAN DEFAULT 0 NOT NULL, 
	draft_id VARCHAR, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
);

CREATE TABLE ai_knowledge_doc (
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
);

CREATE TABLE ai_lesson (
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
);

CREATE TABLE ai_library_item (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	type VARCHAR NOT NULL, 
	name VARCHAR NOT NULL, 
	description VARCHAR DEFAULT '' NOT NULL, 
	content VARCHAR DEFAULT '' NOT NULL, 
	version INTEGER DEFAULT '1' NOT NULL, 
	history VARCHAR DEFAULT '[]' NOT NULL, 
	created_by VARCHAR, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
);

CREATE TABLE ai_memory_note (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	scope VARCHAR NOT NULL, 
	scope_key VARCHAR NOT NULL, 
	text VARCHAR NOT NULL, 
	kind VARCHAR NOT NULL, 
	written_by VARCHAR, 
	source_run_id VARCHAR, 
	source_ticket_id VARCHAR, 
	uses INTEGER NOT NULL, 
	last_used_at VARCHAR, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE ai_plugin (
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
);

CREATE TABLE ai_project_knowledge (
	project_id VARCHAR NOT NULL, 
	instructions VARCHAR DEFAULT '' NOT NULL, 
	history VARCHAR DEFAULT '[]' NOT NULL, 
	updated_at VARCHAR, 
	updated_by VARCHAR, 
	PRIMARY KEY (project_id)
);

CREATE TABLE ai_project_settings (
	project_id VARCHAR NOT NULL, 
	paused_all BOOLEAN NOT NULL, 
	paused_at VARCHAR, 
	paused_reason VARCHAR, 
	board_daily_cap FLOAT, 
	board_monthly_budget FLOAT, 
	board_tokens_per_day INTEGER, 
	board_max_parallel INTEGER NOT NULL, 
	board_runs_per_day INTEGER, 
	board_at_cap VARCHAR NOT NULL, 
	run_memory_limit_mb INTEGER NOT NULL, 
	audit_retention_days INTEGER, 
	run_retention_days INTEGER, 
	permission_mode VARCHAR NOT NULL, 
	deny_list VARCHAR NOT NULL, 
	lessons_mode VARCHAR NOT NULL, 
	lessons_max INTEGER NOT NULL, 
	ops VARCHAR NOT NULL, 
	PRIMARY KEY (project_id)
);

CREATE TABLE ai_repo_scan (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	folder VARCHAR NOT NULL, 
	found VARCHAR DEFAULT '{}' NOT NULL, 
	suggested VARCHAR DEFAULT '{}' NOT NULL, 
	trial VARCHAR DEFAULT '{}' NOT NULL, 
	applied_at VARCHAR, 
	created_at VARCHAR NOT NULL, job VARCHAR DEFAULT '{}' NOT NULL, proposal VARCHAR DEFAULT '{}' NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE ai_role_pack (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	"key" VARCHAR NOT NULL, 
	name VARCHAR NOT NULL, 
	version INTEGER DEFAULT '1' NOT NULL, 
	body VARCHAR DEFAULT '{}' NOT NULL, 
	history VARCHAR DEFAULT '[]' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	updated_by VARCHAR, roles VARCHAR DEFAULT '[]' NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE ai_run (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	kind VARCHAR NOT NULL, 
	ticket_id VARCHAR, 
	target VARCHAR, 
	member_id VARCHAR NOT NULL, 
	number INTEGER NOT NULL, 
	mode VARCHAR NOT NULL, 
	"trigger" VARCHAR NOT NULL, 
	state VARCHAR NOT NULL, 
	started_by VARCHAR NOT NULL, 
	instruction VARCHAR NOT NULL, 
	reply_comment_id VARCHAR, 
	queued_at VARCHAR NOT NULL, 
	started_at VARCHAR, 
	ended_at VARCHAR, 
	last_output_at VARCHAR, 
	ended_reason VARCHAR, 
	ended_by VARCHAR, 
	exit_code INTEGER, 
	summary VARCHAR, 
	report VARCHAR NOT NULL, 
	question VARCHAR, 
	answer VARCHAR, 
	session_id VARCHAR, 
	session_name VARCHAR, 
	files VARCHAR NOT NULL, 
	tokens_in INTEGER NOT NULL, 
	tokens_out INTEGER NOT NULL, 
	tokens_cached INTEGER, 
	cost_usd FLOAT NOT NULL, 
	metered BOOLEAN NOT NULL, 
	context_used INTEGER, 
	context_window INTEGER, 
	pid INTEGER, 
	token_hash VARCHAR, 
	model VARCHAR, 
	effort VARCHAR, 
	paused BOOLEAN NOT NULL, 
	paused_at VARCHAR, 
	stop_code VARCHAR, 
	peak_rss_mb FLOAT, 
	last_rss_mb FLOAT, 
	restarts VARCHAR NOT NULL, 
	diagnosis VARCHAR, 
	retries VARCHAR NOT NULL, 
	retry_at VARCHAR, 
	account_id VARCHAR, 
	debug_log VARCHAR, 
	steps_count INTEGER NOT NULL, 
	waiting_reason VARCHAR, 
	live BOOLEAN NOT NULL, 
	details_removed_at VARCHAR, depth INTEGER DEFAULT '0' NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE ai_run_agent (
	id VARCHAR NOT NULL, 
	run_id VARCHAR NOT NULL, 
	agent_type VARCHAR NOT NULL, 
	claude_id VARCHAR, 
	started_at VARCHAR NOT NULL, 
	ended_at VARCHAR, 
	steps_count INTEGER NOT NULL, 
	last_text VARCHAR, 
	PRIMARY KEY (id)
);

CREATE TABLE ai_run_command (
	id INTEGER NOT NULL, 
	run_id VARCHAR NOT NULL, 
	command VARCHAR NOT NULL, 
	payload VARCHAR NOT NULL, 
	created_at VARCHAR NOT NULL, 
	taken_at VARCHAR, 
	PRIMARY KEY (id)
);

CREATE VIRTUAL TABLE ai_run_fts USING fts5(run_id UNINDEXED, project_id UNINDEXED, body, tokenize = 'unicode61 remove_diacritics 2');

CREATE TABLE ai_run_message (
	id VARCHAR NOT NULL, 
	run_id VARCHAR NOT NULL, 
	direction VARCHAR NOT NULL, 
	peer VARCHAR NOT NULL, 
	text VARCHAR NOT NULL, 
	at VARCHAR NOT NULL, 
	delivered_at VARCHAR, 
	PRIMARY KEY (id)
);

CREATE TABLE ai_run_step (
	id INTEGER NOT NULL, 
	run_id VARCHAR NOT NULL, 
	seq INTEGER NOT NULL, 
	at VARCHAR NOT NULL, 
	agent_id VARCHAR, 
	kind VARCHAR NOT NULL, 
	tool VARCHAR, 
	title VARCHAR NOT NULL, 
	detail VARCHAR NOT NULL, 
	output VARCHAR, 
	parent_tool_id VARCHAR, 
	tool_id VARCHAR, 
	PRIMARY KEY (id)
);

CREATE TABLE ai_run_transcript (
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
);

CREATE TABLE ai_schedule (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	ticket_id VARCHAR NOT NULL, 
	member_id VARCHAR NOT NULL, 
	backup_member_id VARCHAR, 
	created_by VARCHAR DEFAULT 'user' NOT NULL, 
	kind VARCHAR DEFAULT 'repeat' NOT NULL, 
	run_at VARCHAR, 
	days VARCHAR DEFAULT '[0,1,2,3,4]' NOT NULL, 
	time VARCHAR DEFAULT '02:00' NOT NULL, 
	tz VARCHAR DEFAULT 'UTC' NOT NULL, 
	ends VARCHAR DEFAULT 'never' NOT NULL, 
	ends_after INTEGER, 
	ends_on VARCHAR, 
	window_end VARCHAR, 
	checks VARCHAR DEFAULT '{}' NOT NULL, 
	review VARCHAR DEFAULT '{}' NOT NULL, 
	limits VARCHAR DEFAULT '{}' NOT NULL, 
	catch_up VARCHAR DEFAULT 'run' NOT NULL, 
	catch_up_hours FLOAT DEFAULT '2' NOT NULL, 
	notify VARCHAR DEFAULT '[]' NOT NULL, 
	notify_people VARCHAR DEFAULT '[]' NOT NULL, 
	instruction VARCHAR DEFAULT '' NOT NULL, 
	state VARCHAR DEFAULT 'active' NOT NULL, 
	paused_reason VARCHAR, 
	failures_in_row INTEGER DEFAULT '0' NOT NULL, 
	runs_count INTEGER DEFAULT '0' NOT NULL, 
	next_run_at VARCHAR, 
	ticket_seen_at VARCHAR, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
);

CREATE TABLE ai_schedule_run (
	id VARCHAR NOT NULL, 
	schedule_id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	ticket_id VARCHAR NOT NULL, 
	slot_at VARCHAR NOT NULL, 
	state VARCHAR DEFAULT 'waiting' NOT NULL, 
	catch_up BOOLEAN DEFAULT 0 NOT NULL, 
	member_id VARCHAR, 
	run_ids VARCHAR DEFAULT '[]' NOT NULL, 
	attempts INTEGER DEFAULT '0' NOT NULL, 
	fix_round INTEGER DEFAULT '0' NOT NULL, 
	results VARCHAR DEFAULT '[]' NOT NULL, 
	review VARCHAR DEFAULT '{}' NOT NULL, 
	note VARCHAR, 
	started_at VARCHAR, 
	ended_at VARCHAR, 
	duration_s INTEGER DEFAULT '0' NOT NULL, 
	cost_usd FLOAT DEFAULT '0' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(schedule_id) REFERENCES ai_schedule (id)
);

CREATE TABLE ai_session_history (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	ticket_id VARCHAR NOT NULL, 
	member_id VARCHAR NOT NULL, 
	title VARCHAR NOT NULL, 
	summary VARCHAR NOT NULL, 
	session_ids VARCHAR NOT NULL, 
	run_ids VARCHAR NOT NULL, 
	started_at VARCHAR, 
	ended_at VARCHAR NOT NULL, 
	created_by VARCHAR NOT NULL, 
	summarised_by VARCHAR NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE ai_skill_use (
	id INTEGER NOT NULL, 
	run_id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	member_id VARCHAR, 
	kind VARCHAR DEFAULT 'skill' NOT NULL, 
	name VARCHAR NOT NULL, 
	plugin VARCHAR, 
	at VARCHAR NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE ai_team (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	provider VARCHAR NOT NULL, 
	connection VARCHAR NOT NULL, 
	description VARCHAR NOT NULL, 
	cli_path VARCHAR, 
	working_dir VARCHAR, 
	model VARCHAR, 
	effort VARCHAR, 
	persona VARCHAR NOT NULL, 
	pack_key VARCHAR, 
	config VARCHAR NOT NULL, 
	permission_mode VARCHAR NOT NULL, 
	max_parallel INTEGER NOT NULL, 
	daily_budget FLOAT, 
	monthly_cap FLOAT, 
	max_runs_per_day INTEGER, 
	tokens_per_day INTEGER, 
	cap_per_run FLOAT, 
	scope VARCHAR NOT NULL, 
	paused BOOLEAN NOT NULL, 
	paused_at VARCHAR, 
	paused_reason VARCHAR, 
	health VARCHAR NOT NULL, 
	health_detail VARCHAR, 
	checked_at VARCHAR, 
	account_id VARCHAR, 
	mcp_last_used_at VARCHAR, 
	created_by VARCHAR, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE ai_touch_mark (
	"key" VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	mark VARCHAR NOT NULL, 
	marked_by VARCHAR, 
	marked_at VARCHAR NOT NULL, 
	lesson_id VARCHAR, 
	PRIMARY KEY ("key")
);

CREATE TABLE ai_usage (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	feature VARCHAR NOT NULL, 
	member_id VARCHAR, 
	person VARCHAR, 
	cost FLOAT DEFAULT '0' NOT NULL, 
	tokens_in INTEGER DEFAULT '0' NOT NULL, 
	tokens_out INTEGER DEFAULT '0' NOT NULL, 
	metered BOOLEAN DEFAULT 1 NOT NULL, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
);

CREATE TABLE ai_watched_pr (
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
);

CREATE TABLE ai_worktree (
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
);

CREATE TABLE alembic_version (
	version_num VARCHAR(32) NOT NULL, 
	CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
);

CREATE TABLE canvas (
	id VARCHAR NOT NULL, 
	project_id VARCHAR, 
	owner_kind VARCHAR DEFAULT 'doc' NOT NULL, 
	owner_id VARCHAR DEFAULT '' NOT NULL, 
	page_id VARCHAR, 
	title VARCHAR DEFAULT 'Canvas' NOT NULL, 
	rev INTEGER DEFAULT '1' NOT NULL, 
	version INTEGER DEFAULT '0' NOT NULL, 
	board_count INTEGER DEFAULT '0' NOT NULL, 
	total_bytes INTEGER DEFAULT '0' NOT NULL, 
	created_by VARCHAR NOT NULL, 
	created_at VARCHAR NOT NULL, 
	updated_by VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	deleted_at VARCHAR, 
	deleted_by VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
);

CREATE TABLE canvas_comment (
	id VARCHAR NOT NULL, 
	thread_id VARCHAR NOT NULL, 
	author VARCHAR NOT NULL, 
	body VARCHAR DEFAULT '' NOT NULL, 
	mentions VARCHAR DEFAULT '[]' NOT NULL, 
	ai VARCHAR, 
	created_at VARCHAR NOT NULL, 
	edited_at VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(thread_id) REFERENCES canvas_thread (id)
);

CREATE TABLE canvas_proposal (
	id VARCHAR NOT NULL, 
	canvas_id VARCHAR NOT NULL, 
	author VARCHAR NOT NULL, 
	member_id VARCHAR, 
	job_id VARCHAR, 
	request VARCHAR DEFAULT '' NOT NULL, 
	note VARCHAR DEFAULT '' NOT NULL, 
	status VARCHAR DEFAULT 'open' NOT NULL, 
	changes VARCHAR DEFAULT '[]' NOT NULL, 
	version INTEGER, 
	created_at VARCHAR NOT NULL, 
	decided_by VARCHAR, 
	decided_at VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(canvas_id) REFERENCES canvas (id)
);

CREATE TABLE canvas_thread (
	id VARCHAR NOT NULL, 
	canvas_id VARCHAR NOT NULL, 
	number INTEGER DEFAULT '1' NOT NULL, 
	board_id VARCHAR, 
	x FLOAT DEFAULT '0.5' NOT NULL, 
	y FLOAT DEFAULT '0.5' NOT NULL, 
	page VARCHAR, 
	status VARCHAR DEFAULT 'open' NOT NULL, 
	created_by VARCHAR NOT NULL, 
	created_at VARCHAR NOT NULL, 
	resolved_by VARCHAR, 
	resolved_at VARCHAR, anchor VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(canvas_id) REFERENCES canvas (id)
);

CREATE TABLE canvas_version (
	id VARCHAR NOT NULL, 
	canvas_id VARCHAR NOT NULL, 
	version INTEGER NOT NULL, 
	name VARCHAR, 
	reason VARCHAR DEFAULT 'done' NOT NULL, 
	author VARCHAR NOT NULL, 
	note VARCHAR, 
	changes VARCHAR DEFAULT '{}' NOT NULL, 
	summary VARCHAR DEFAULT '' NOT NULL, 
	doc VARCHAR DEFAULT '{}' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(canvas_id) REFERENCES canvas (id)
);

CREATE TABLE diagram (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	label VARCHAR DEFAULT 'Diagram' NOT NULL, 
	summary VARCHAR DEFAULT '' NOT NULL, 
	item_kind VARCHAR, 
	item_id VARCHAR, 
	version INTEGER DEFAULT '1' NOT NULL, 
	created_by VARCHAR NOT NULL, 
	created_at VARCHAR NOT NULL, 
	updated_by VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	deleted_at VARCHAR, 
	deleted_by VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
);

CREATE TABLE diagram_settings (
	id INTEGER NOT NULL, 
	mode VARCHAR DEFAULT 'self-hosted' NOT NULL, 
	url VARCHAR DEFAULT '' NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE diagram_version (
	id VARCHAR NOT NULL, 
	diagram_id VARCHAR NOT NULL, 
	version INTEGER NOT NULL, 
	source VARCHAR DEFAULT '' NOT NULL, 
	svg VARCHAR DEFAULT '' NOT NULL, 
	author VARCHAR NOT NULL, 
	note VARCHAR, 
	created_at VARCHAR NOT NULL, preview_kind VARCHAR DEFAULT 'editor' NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(diagram_id) REFERENCES diagram (id)
);

CREATE TABLE docs_ai_health (
	project_id VARCHAR NOT NULL, 
	data VARCHAR DEFAULT '{}' NOT NULL, 
	checked_at VARCHAR, 
	digest_at VARCHAR, 
	PRIMARY KEY (project_id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
);

CREATE TABLE docs_ai_ignore (
	page_id VARCHAR NOT NULL, 
	"key" VARCHAR NOT NULL, 
	"by" VARCHAR DEFAULT 'user' NOT NULL, 
	at VARCHAR NOT NULL, 
	PRIMARY KEY (page_id, "key")
);

CREATE TABLE docs_ai_job (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	page_id VARCHAR, 
	thread_id VARCHAR, 
	comment_id VARCHAR, 
	member_id VARCHAR, 
	kind VARCHAR NOT NULL, 
	state VARCHAR DEFAULT 'queued' NOT NULL, 
	started_by VARCHAR DEFAULT 'user' NOT NULL, 
	instruction VARCHAR DEFAULT '' NOT NULL, 
	session_id VARCHAR, 
	reads VARCHAR DEFAULT '[]' NOT NULL, 
	steps VARCHAR DEFAULT '[]' NOT NULL, 
	result VARCHAR DEFAULT '{}' NOT NULL, 
	error VARCHAR DEFAULT '{}' NOT NULL, 
	tokens_in INTEGER DEFAULT '0' NOT NULL, 
	tokens_out INTEGER DEFAULT '0' NOT NULL, 
	cost_usd FLOAT DEFAULT '0' NOT NULL, 
	metered BOOLEAN DEFAULT 0 NOT NULL, 
	reply_comment_id VARCHAR, 
	queued_at VARCHAR NOT NULL, 
	started_at VARCHAR, 
	ended_at VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
);

CREATE TABLE docs_ai_session (
	scope VARCHAR NOT NULL, 
	member_id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	session_id VARCHAR NOT NULL, 
	calls INTEGER DEFAULT '0' NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (scope, member_id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
);

CREATE TABLE "docs_ai_settings" (
	project_id VARCHAR NOT NULL, 
	enabled BOOLEAN DEFAULT 1 NOT NULL, 
	member_id VARCHAR, 
	style_page_id VARCHAR, 
	freshness_on BOOLEAN DEFAULT 1 NOT NULL, 
	digest_on BOOLEAN DEFAULT 1 NOT NULL, 
	updated_by VARCHAR, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (project_id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
);

CREATE TABLE docs_anchor_aliases (
	id VARCHAR NOT NULL, 
	page_id VARCHAR NOT NULL, 
	old_slug VARCHAR NOT NULL, 
	new_slug VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(page_id) REFERENCES docs_page (id)
);

CREATE TABLE docs_comment (
	id VARCHAR NOT NULL, 
	thread_id VARCHAR NOT NULL, 
	author VARCHAR NOT NULL, 
	body VARCHAR NOT NULL, 
	mentions VARCHAR DEFAULT '[]' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	edited_at VARCHAR, ai VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(thread_id) REFERENCES docs_comment_thread (id)
);

CREATE TABLE "docs_comment_event" (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	page_id VARCHAR, 
	thread_id VARCHAR, 
	comment_id VARCHAR, 
	kind VARCHAR NOT NULL, 
	actor VARCHAR NOT NULL, 
	mentioned VARCHAR DEFAULT '[]' NOT NULL, 
	recipients VARCHAR DEFAULT '[]' NOT NULL, 
	page_title VARCHAR DEFAULT ('') NOT NULL, 
	snippet VARCHAR DEFAULT ('') NOT NULL, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(page_id) REFERENCES docs_page (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
);

CREATE TABLE docs_comment_read (
	id VARCHAR NOT NULL, 
	thread_id VARCHAR NOT NULL, 
	reader VARCHAR NOT NULL, 
	read_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(thread_id) REFERENCES docs_comment_thread (id)
);

CREATE TABLE docs_comment_thread (
	id VARCHAR NOT NULL, 
	page_id VARCHAR NOT NULL, 
	kind VARCHAR DEFAULT 'inline' NOT NULL, 
	status VARCHAR DEFAULT 'open' NOT NULL, 
	anchor_quote VARCHAR, 
	anchor_prefix VARCHAR DEFAULT '' NOT NULL, 
	anchor_suffix VARCHAR DEFAULT '' NOT NULL, 
	anchor_section VARCHAR, 
	anchor_state VARCHAR DEFAULT 'attached' NOT NULL, 
	anchor_pos INTEGER, 
	created_by VARCHAR NOT NULL, 
	created_at VARCHAR NOT NULL, 
	resolved_by VARCHAR, 
	resolved_at VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(page_id) REFERENCES docs_page (id)
);

CREATE TABLE docs_draft (
	id VARCHAR NOT NULL, 
	page_id VARCHAR NOT NULL, 
	author VARCHAR DEFAULT 'user' NOT NULL, 
	title VARCHAR NOT NULL, 
	markdown VARCHAR DEFAULT '' NOT NULL, 
	base_version INTEGER DEFAULT '0' NOT NULL, 
	updated_at VARCHAR NOT NULL, saves INTEGER DEFAULT '1' NOT NULL, ai_source VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(page_id) REFERENCES docs_page (id)
);

CREATE VIRTUAL TABLE docs_fts USING fts5(page_id UNINDEXED, project_id UNINDEXED, title, headings, body, tokenize = 'unicode61 remove_diacritics 2');

CREATE TABLE docs_link (
	id VARCHAR NOT NULL, 
	source_page_id VARCHAR NOT NULL, 
	source_section VARCHAR, 
	target_page_id VARCHAR, 
	target_title VARCHAR, 
	target_anchor VARCHAR, 
	target_ticket_id VARCHAR, 
	display_text VARCHAR, 
	snippet VARCHAR DEFAULT '' NOT NULL, origin VARCHAR DEFAULT 'page' NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(source_page_id) REFERENCES docs_page (id)
);

CREATE TABLE "docs_page" (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	parent_id VARCHAR, 
	position INTEGER DEFAULT '0' NOT NULL, 
	title VARCHAR NOT NULL, 
	slug VARCHAR NOT NULL, 
	status VARCHAR DEFAULT 'draft' NOT NULL, 
	version INTEGER DEFAULT '0' NOT NULL, 
	created_by VARCHAR DEFAULT 'user' NOT NULL, 
	updated_by VARCHAR DEFAULT 'user' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	deleted_at VARCHAR, 
	deleted_by VARCHAR, 
	deleted_root_id VARCHAR, 
	kind VARCHAR DEFAULT 'page' NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id), 
	FOREIGN KEY(parent_id) REFERENCES docs_page (id)
);

CREATE TABLE docs_page_seen (
	id VARCHAR NOT NULL, 
	page_id VARCHAR NOT NULL, 
	viewer VARCHAR NOT NULL, 
	version INTEGER DEFAULT '0' NOT NULL, 
	seen_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(page_id) REFERENCES docs_page (id)
);

CREATE TABLE docs_title_aliases (
	id VARCHAR NOT NULL, 
	page_id VARCHAR NOT NULL, 
	old_title VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(page_id) REFERENCES docs_page (id)
);

CREATE TABLE "docs_version" (
	id VARCHAR NOT NULL, 
	page_id VARCHAR NOT NULL, 
	version INTEGER NOT NULL, 
	title VARCHAR NOT NULL, 
	markdown VARCHAR DEFAULT ('') NOT NULL, 
	author VARCHAR DEFAULT 'user' NOT NULL, 
	note VARCHAR, 
	created_at VARCHAR NOT NULL, 
	diagram_versions VARCHAR DEFAULT '{}' NOT NULL, 
	with_ai BOOLEAN DEFAULT 0 NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(page_id) REFERENCES docs_page (id)
);

CREATE TABLE idea_advice (
	id VARCHAR NOT NULL, 
	idea_id VARCHAR NOT NULL, 
	action VARCHAR NOT NULL, 
	reason VARCHAR DEFAULT '' NOT NULL, 
	confidence VARCHAR DEFAULT 'medium' NOT NULL, 
	target_id VARCHAR, 
	archive_reason VARCHAR, 
	park_days INTEGER, 
	idea_stamp VARCHAR DEFAULT '' NOT NULL, 
	member_id VARCHAR, 
	cost FLOAT DEFAULT '0' NOT NULL, 
	state VARCHAR DEFAULT 'open' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(idea_id) REFERENCES idea_ticket (id)
);

CREATE TABLE idea_ai_settings (
	project_id VARCHAR NOT NULL, 
	enabled BOOLEAN DEFAULT 1 NOT NULL, 
	triage_advice BOOLEAN DEFAULT 1 NOT NULL, 
	weekly_grooming BOOLEAN DEFAULT 1 NOT NULL, 
	ask BOOLEAN DEFAULT 1 NOT NULL, 
	read_docs BOOLEAN DEFAULT 1 NOT NULL, 
	read_repo BOOLEAN DEFAULT 1 NOT NULL, 
	daily_cap FLOAT DEFAULT '1.0' NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (project_id)
);

CREATE TABLE idea_assumption (
	id VARCHAR NOT NULL, 
	idea_id VARCHAR NOT NULL, 
	position INTEGER DEFAULT '0' NOT NULL, 
	text VARCHAR NOT NULL, 
	impact VARCHAR DEFAULT 'medium' NOT NULL, 
	status VARCHAR DEFAULT 'untested' NOT NULL, 
	test_ticket_id VARCHAR, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, ai BOOLEAN DEFAULT 0 NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(idea_id) REFERENCES idea_ticket (id)
);

CREATE TABLE idea_comment (
	id VARCHAR NOT NULL, 
	idea_id VARCHAR NOT NULL, 
	author VARCHAR, 
	body VARCHAR DEFAULT '' NOT NULL, 
	ai BOOLEAN DEFAULT 0 NOT NULL, 
	run_id VARCHAR, 
	created_at VARCHAR NOT NULL, 
	edited_at VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(idea_id) REFERENCES idea_ticket (id)
);

CREATE TABLE idea_counter (
	id INTEGER NOT NULL, 
	counter INTEGER DEFAULT '0' NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE idea_digest (
	id VARCHAR NOT NULL, 
	project_id VARCHAR DEFAULT '' NOT NULL, 
	text VARCHAR DEFAULT '' NOT NULL, 
	items VARCHAR DEFAULT '[]' NOT NULL, 
	ai BOOLEAN DEFAULT 0 NOT NULL, 
	member_id VARCHAR, 
	cost FLOAT DEFAULT '0' NOT NULL, 
	ideas_read INTEGER DEFAULT '0' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE idea_evidence (
	id VARCHAR NOT NULL, 
	assumption_id VARCHAR NOT NULL, 
	kind VARCHAR DEFAULT 'link' NOT NULL, 
	title VARCHAR DEFAULT '' NOT NULL, 
	ref VARCHAR DEFAULT '' NOT NULL, 
	created_by VARCHAR, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(assumption_id) REFERENCES idea_assumption (id)
);

CREATE TABLE idea_log_entry (
	id VARCHAR NOT NULL, 
	idea_id VARCHAR NOT NULL, 
	kind VARCHAR DEFAULT 'note' NOT NULL, 
	body VARCHAR DEFAULT '' NOT NULL, 
	author VARCHAR, 
	ai BOOLEAN DEFAULT 0 NOT NULL, 
	pinned BOOLEAN DEFAULT 0 NOT NULL, 
	assumption_id VARCHAR, 
	attachments VARCHAR DEFAULT '[]' NOT NULL, 
	ticket_id VARCHAR, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(idea_id) REFERENCES idea_ticket (id)
);

CREATE TABLE "idea_ticket" (
	id VARCHAR NOT NULL, 
	project_id VARCHAR, 
	title VARCHAR NOT NULL, 
	description VARCHAR DEFAULT ('') NOT NULL, 
	idea_status VARCHAR DEFAULT 'draft' NOT NULL, 
	idea_color VARCHAR DEFAULT '#F5C518' NOT NULL, 
	idea_emoji VARCHAR DEFAULT '💡' NOT NULL, 
	idea_energy VARCHAR, 
	tags VARCHAR DEFAULT '[]' NOT NULL, 
	problem_statement VARCHAR, 
	ice_impact INTEGER DEFAULT '3' NOT NULL, 
	ice_effort INTEGER DEFAULT '3' NOT NULL, 
	ice_confidence INTEGER DEFAULT '3' NOT NULL, 
	revisit_date VARCHAR, 
	last_touched_at VARCHAR, 
	promoted_to_ticket_id VARCHAR, 
	promoted_at VARCHAR, 
	activity_trail VARCHAR DEFAULT '[]' NOT NULL, 
	microthoughts VARCHAR DEFAULT '[]' NOT NULL, 
	assumptions VARCHAR DEFAULT '[]' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	stage VARCHAR DEFAULT 'inbox' NOT NULL, 
	park_until VARCHAR, 
	archive_reason VARCHAR, 
	source VARCHAR DEFAULT 'manual' NOT NULL, 
	body VARCHAR DEFAULT '' NOT NULL, 
	details VARCHAR DEFAULT '' NOT NULL, 
	created_by VARCHAR, 
	owner VARCHAR, 
	park_note VARCHAR, 
	archive_note VARCHAR, 
	stage_changed_at VARCHAR, 
	merged_into_id VARCHAR, 
	merged_at VARCHAR, 
	shipped_at VARCHAR, 
	outcome VARCHAR, 
	outcome_note VARCHAR, 
	former_ticket_id VARCHAR, 
	effort_guess VARCHAR, 
	source_ref VARCHAR DEFAULT '{}' NOT NULL, 
	prev_state VARCHAR DEFAULT '{}' NOT NULL, 
	merge_undo VARCHAR DEFAULT '{}' NOT NULL, 
	workspace_retention VARCHAR DEFAULT 'open_then_30' NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_idea_ticket_promoted_to_ticket_id UNIQUE (promoted_to_ticket_id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
);

CREATE TABLE idea_vote (
	id VARCHAR NOT NULL, 
	idea_id VARCHAR NOT NULL, 
	voter VARCHAR NOT NULL, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(idea_id) REFERENCES idea_ticket (id)
);

CREATE VIRTUAL TABLE kb_fts USING fts5(doc_id UNINDEXED, project_id UNINDEXED, store UNINDEXED, title, summary, keywords, body, tokenize = 'unicode61 remove_diacritics 2');

CREATE TABLE member (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	name VARCHAR NOT NULL, 
	color VARCHAR NOT NULL, 
	created_at VARCHAR NOT NULL, role VARCHAR DEFAULT 'member' NOT NULL, kind VARCHAR DEFAULT 'human' NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
);

CREATE TABLE notification (
	id VARCHAR NOT NULL, 
	recipient VARCHAR NOT NULL, 
	event_id INTEGER NOT NULL, 
	last_event_id INTEGER NOT NULL, 
	project_id VARCHAR, 
	kind VARCHAR NOT NULL, 
	needs BOOLEAN DEFAULT '0' NOT NULL, 
	group_key VARCHAR NOT NULL, 
	count INTEGER DEFAULT '1' NOT NULL, 
	items VARCHAR DEFAULT '[]' NOT NULL, 
	target_kind VARCHAR, 
	target_id VARCHAR, 
	ticket_id VARCHAR, 
	page_id VARCHAR, 
	member_id VARCHAR, 
	actor VARCHAR, 
	title VARCHAR DEFAULT '' NOT NULL, 
	body VARCHAR DEFAULT '' NOT NULL, 
	data VARCHAR DEFAULT '{}' NOT NULL, 
	inapp BOOLEAN DEFAULT '1' NOT NULL, 
	desktop BOOLEAN DEFAULT '0' NOT NULL, 
	read_at VARCHAR, 
	done_at VARCHAR, 
	done_reason VARCHAR, 
	done_by VARCHAR, 
	snoozed_until VARCHAR, 
	cleared_at VARCHAR, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE notify_event (
	id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, 
	project_id VARCHAR, 
	kind VARCHAR NOT NULL, 
	op VARCHAR DEFAULT 'new' NOT NULL, 
	needs BOOLEAN DEFAULT '0' NOT NULL, 
	target_kind VARCHAR, 
	target_id VARCHAR, 
	ticket_id VARCHAR, 
	page_id VARCHAR, 
	member_id VARCHAR, 
	actor VARCHAR, 
	title VARCHAR DEFAULT '' NOT NULL, 
	body VARCHAR DEFAULT '' NOT NULL, 
	data VARCHAR DEFAULT '{}' NOT NULL, 
	recipients VARCHAR DEFAULT '[]' NOT NULL, 
	created_at VARCHAR NOT NULL
);

CREATE TABLE notify_follow (
	id VARCHAR NOT NULL, 
	recipient VARCHAR NOT NULL, 
	scope VARCHAR NOT NULL, 
	scope_id VARCHAR NOT NULL, 
	project_id VARCHAR, 
	level VARCHAR DEFAULT 'follow' NOT NULL, 
	until VARCHAR, 
	label VARCHAR DEFAULT '' NOT NULL, 
	created_at VARCHAR NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE notify_prefs (
	recipient VARCHAR NOT NULL, 
	prefs VARCHAR DEFAULT '{}' NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	PRIMARY KEY (recipient)
);

CREATE TABLE "project" (
	id VARCHAR NOT NULL, 
	name VARCHAR NOT NULL, 
	prefix VARCHAR NOT NULL, 
	color VARCHAR NOT NULL, 
	ticket_counter INTEGER NOT NULL, 
	repo_path VARCHAR, 
	worktree_template VARCHAR, 
	worktree_by_default BOOLEAN DEFAULT 0 NOT NULL, docs_enabled BOOLEAN DEFAULT 1 NOT NULL, docs_edit_policy VARCHAR DEFAULT 'members' NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (prefix)
);

CREATE TABLE sketch (
	id VARCHAR NOT NULL, 
	project_id VARCHAR, 
	owner_kind VARCHAR DEFAULT 'doc' NOT NULL, 
	owner_id VARCHAR DEFAULT '' NOT NULL, 
	title VARCHAR DEFAULT 'Sketch' NOT NULL, 
	width INTEGER DEFAULT '840' NOT NULL, 
	height INTEGER DEFAULT '500' NOT NULL, 
	layer_count INTEGER DEFAULT '1' NOT NULL, 
	version INTEGER DEFAULT '1' NOT NULL, 
	png_bytes INTEGER DEFAULT '0' NOT NULL, 
	source_bytes INTEGER DEFAULT '0' NOT NULL, 
	created_by VARCHAR NOT NULL, 
	created_at VARCHAR NOT NULL, 
	updated_by VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	deleted_at VARCHAR, 
	deleted_by VARCHAR, 
	PRIMARY KEY (id), 
	FOREIGN KEY(project_id) REFERENCES project (id)
);

CREATE TABLE story (
	ticket_id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	state VARCHAR DEFAULT 'draft' NOT NULL, 
	approve VARCHAR DEFAULT 'person' NOT NULL, 
	budget_tokens INTEGER DEFAULT '0' NOT NULL, 
	pm_id VARCHAR, 
	"plan" VARCHAR DEFAULT '{}' NOT NULL, 
	paused BOOLEAN DEFAULT 0 NOT NULL, 
	review_note VARCHAR, 
	history VARCHAR DEFAULT '[]' NOT NULL, 
	meta VARCHAR DEFAULT '{}' NOT NULL, 
	created_by VARCHAR, 
	created_at VARCHAR NOT NULL, 
	handed_at VARCHAR, 
	started_at VARCHAR, 
	closed_at VARCHAR, 
	PRIMARY KEY (ticket_id), 
	FOREIGN KEY(ticket_id) REFERENCES ticket (id)
);

CREATE TABLE "ticket" (
	id VARCHAR NOT NULL, 
	project_id VARCHAR NOT NULL, 
	title VARCHAR NOT NULL, 
	description VARCHAR NOT NULL, 
	type VARCHAR NOT NULL, 
	status VARCHAR NOT NULL, 
	priority VARCHAR NOT NULL, 
	estimate FLOAT, 
	due_date VARCHAR, 
	tags VARCHAR NOT NULL, 
	parent_id VARCHAR, 
	comments VARCHAR NOT NULL, 
	acceptance_criteria VARCHAR NOT NULL, 
	activity_log VARCHAR NOT NULL, 
	work_log VARCHAR NOT NULL, 
	test_cases VARCHAR NOT NULL, 
	created_at VARCHAR NOT NULL, 
	updated_at VARCHAR NOT NULL, 
	wont_do_reason VARCHAR, 
	created_by VARCHAR, 
	assignee VARCHAR, 
	start_date VARCHAR, 
	links VARCHAR DEFAULT '[]' NOT NULL, 
	blocks VARCHAR DEFAULT '[]' NOT NULL, 
	blocked_by VARCHAR DEFAULT '[]' NOT NULL, 
	block_done_if_acs_incomplete BOOLEAN DEFAULT 0 NOT NULL, 
	block_done_if_tcs_incomplete BOOLEAN DEFAULT 0 NOT NULL, 
	branches VARCHAR DEFAULT '[]' NOT NULL, 
	workspace_retention_days INTEGER, 
	repo_path VARCHAR, 
	sub_tasks VARCHAR DEFAULT '[]' NOT NULL, 
	reopen_count INTEGER DEFAULT '0' NOT NULL, 
	last_reopened_at VARCHAR, 
	last_reopened_by VARCHAR, 
	last_reopen_reason VARCHAR, 
	reopen_history VARCHAR DEFAULT '[]' NOT NULL, 
	pending BOOLEAN DEFAULT 0 NOT NULL, 
	pending_reason_type VARCHAR, 
	pending_ticket_id VARCHAR, 
	pending_member_id VARCHAR, 
	pending_party VARCHAR, 
	pending_note VARCHAR, 
	pending_since VARCHAR, 
	pending_by VARCHAR, from_idea_id VARCHAR, tests_assumption_id VARCHAR, wave_pin INTEGER, review_requested_from VARCHAR, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_ticket_assignee FOREIGN KEY(assignee) REFERENCES member (id), 
	CONSTRAINT fk_ticket_created_by FOREIGN KEY(created_by) REFERENCES member (id), 
	FOREIGN KEY(project_id) REFERENCES project (id), 
	FOREIGN KEY(parent_id) REFERENCES ticket (id)
);

CREATE TABLE workspace_settings (
	id INTEGER NOT NULL, 
	enabled BOOLEAN DEFAULT 1 NOT NULL, 
	root_path VARCHAR DEFAULT '~/kanban-workspace' NOT NULL, 
	default_retention_days INTEGER DEFAULT '14', 
	PRIMARY KEY (id)
);

CREATE UNIQUE INDEX ix_ai_account_name ON ai_account (name);

CREATE INDEX ix_ai_audit_member_id ON ai_audit (member_id);

CREATE INDEX ix_ai_audit_project_id ON ai_audit (project_id);

CREATE INDEX ix_ai_audit_run_id ON ai_audit (run_id);

CREATE INDEX ix_ai_audit_seq ON ai_audit (seq);

CREATE INDEX ix_ai_chat_owner ON ai_chat (owner);

CREATE INDEX ix_ai_chat_project_id ON ai_chat (project_id);

CREATE INDEX ix_ai_chat_scope_id ON ai_chat (scope_id);

CREATE INDEX ix_ai_chat_message_chat_id ON ai_chat_message (chat_id);

CREATE INDEX ix_ai_digest_project_id ON ai_digest (project_id);

CREATE INDEX ix_ai_insight_key ON ai_insight ("key");

CREATE INDEX ix_ai_insight_project_id ON ai_insight (project_id);

CREATE INDEX ix_ai_knowledge_doc_project_id ON ai_knowledge_doc (project_id);

CREATE INDEX ix_ai_knowledge_doc_store ON ai_knowledge_doc (store);

CREATE INDEX ix_ai_lesson_project_id ON ai_lesson (project_id);

CREATE INDEX ix_ai_lesson_source_ticket_id ON ai_lesson (source_ticket_id);

CREATE INDEX ix_ai_lesson_state ON ai_lesson (state);

CREATE INDEX ix_ai_library_item_project_id ON ai_library_item (project_id);

CREATE INDEX ix_ai_memory_note_project_id ON ai_memory_note (project_id);

CREATE INDEX ix_ai_memory_note_scope ON ai_memory_note (scope);

CREATE INDEX ix_ai_memory_note_scope_key ON ai_memory_note (scope_key);

CREATE INDEX ix_ai_plugin_name ON ai_plugin (name);

CREATE INDEX ix_ai_plugin_project_id ON ai_plugin (project_id);

CREATE INDEX ix_ai_repo_scan_project_id ON ai_repo_scan (project_id);

CREATE INDEX ix_ai_role_pack_key ON ai_role_pack ("key");

CREATE INDEX ix_ai_role_pack_project_id ON ai_role_pack (project_id);

CREATE INDEX ix_ai_run_account_id ON ai_run (account_id);

CREATE INDEX ix_ai_run_member_id ON ai_run (member_id);

CREATE INDEX ix_ai_run_project_id ON ai_run (project_id);

CREATE INDEX ix_ai_run_state ON ai_run (state);

CREATE INDEX ix_ai_run_target ON ai_run (target);

CREATE INDEX ix_ai_run_ticket_id ON ai_run (ticket_id);

CREATE INDEX ix_ai_run_token_hash ON ai_run (token_hash);

CREATE INDEX ix_ai_run_agent_run_id ON ai_run_agent (run_id);

CREATE INDEX ix_ai_run_command_run_id ON ai_run_command (run_id);

CREATE INDEX ix_ai_run_message_run_id ON ai_run_message (run_id);

CREATE INDEX ix_ai_run_step_run_id ON ai_run_step (run_id);

CREATE INDEX ix_ai_run_step_run_seq ON ai_run_step (run_id, seq);

CREATE INDEX ix_ai_run_step_tool_id ON ai_run_step (tool_id);

CREATE INDEX ix_ai_run_transcript_ended_at ON ai_run_transcript (ended_at);

CREATE INDEX ix_ai_run_transcript_member_id ON ai_run_transcript (member_id);

CREATE INDEX ix_ai_run_transcript_project_id ON ai_run_transcript (project_id);

CREATE INDEX ix_ai_schedule_member_id ON ai_schedule (member_id);

CREATE INDEX ix_ai_schedule_next_run_at ON ai_schedule (next_run_at);

CREATE INDEX ix_ai_schedule_project_id ON ai_schedule (project_id);

CREATE INDEX ix_ai_schedule_state ON ai_schedule (state);

CREATE INDEX ix_ai_schedule_ticket_id ON ai_schedule (ticket_id);

CREATE INDEX ix_ai_schedule_run_project_id ON ai_schedule_run (project_id);

CREATE INDEX ix_ai_schedule_run_schedule_id ON ai_schedule_run (schedule_id);

CREATE INDEX ix_ai_schedule_run_state ON ai_schedule_run (state);

CREATE INDEX ix_ai_schedule_run_ticket_id ON ai_schedule_run (ticket_id);

CREATE UNIQUE INDEX ux_ai_schedule_slot ON ai_schedule_run (schedule_id, slot_at);

CREATE INDEX ix_ai_session_history_project_id ON ai_session_history (project_id);

CREATE INDEX ix_ai_session_history_ticket_id ON ai_session_history (ticket_id);

CREATE INDEX ix_ai_skill_use_member_id ON ai_skill_use (member_id);

CREATE INDEX ix_ai_skill_use_name ON ai_skill_use (name);

CREATE INDEX ix_ai_skill_use_plugin ON ai_skill_use (plugin);

CREATE INDEX ix_ai_skill_use_project_id ON ai_skill_use (project_id);

CREATE INDEX ix_ai_skill_use_run_id ON ai_skill_use (run_id);

CREATE INDEX ix_ai_team_account_id ON ai_team (account_id);

CREATE INDEX ix_ai_team_project_id ON ai_team (project_id);

CREATE INDEX ix_ai_touch_mark_project_id ON ai_touch_mark (project_id);

CREATE INDEX ix_ai_usage_created_at ON ai_usage (created_at);

CREATE INDEX ix_ai_usage_feature ON ai_usage (feature);

CREATE INDEX ix_ai_usage_project_id ON ai_usage (project_id);

CREATE INDEX ix_ai_watched_pr_project_id ON ai_watched_pr (project_id);

CREATE INDEX ix_ai_worktree_project_id ON ai_worktree (project_id);

CREATE INDEX ix_ai_worktree_state ON ai_worktree (state);

CREATE INDEX ix_canvas_owner_id ON canvas (owner_id);

CREATE INDEX ix_canvas_page_id ON canvas (page_id);

CREATE INDEX ix_canvas_project_id ON canvas (project_id);

CREATE INDEX ix_canvas_comment_thread_id ON canvas_comment (thread_id);

CREATE INDEX ix_canvas_proposal_canvas_id ON canvas_proposal (canvas_id);

CREATE INDEX ix_canvas_thread_canvas_id ON canvas_thread (canvas_id);

CREATE INDEX ix_canvas_version_canvas_id ON canvas_version (canvas_id);

CREATE UNIQUE INDEX uq_canvas_version ON canvas_version (canvas_id, version);

CREATE INDEX ix_diagram_item_id ON diagram (item_id);

CREATE INDEX ix_diagram_project_id ON diagram (project_id);

CREATE INDEX ix_diagram_version_diagram_id ON diagram_version (diagram_id);

CREATE INDEX ix_docs_ai_job_kind ON docs_ai_job (kind);

CREATE INDEX ix_docs_ai_job_member_id ON docs_ai_job (member_id);

CREATE INDEX ix_docs_ai_job_page_id ON docs_ai_job (page_id);

CREATE INDEX ix_docs_ai_job_project_id ON docs_ai_job (project_id);

CREATE INDEX ix_docs_ai_job_state ON docs_ai_job (state);

CREATE INDEX ix_docs_ai_job_thread_id ON docs_ai_job (thread_id);

CREATE INDEX ix_docs_ai_session_project_id ON docs_ai_session (project_id);

CREATE INDEX ix_docs_anchor_aliases_page_id ON docs_anchor_aliases (page_id);

CREATE INDEX ix_docs_comment_thread_id ON docs_comment (thread_id);

CREATE INDEX ix_docs_comment_event_page_id ON docs_comment_event (page_id);

CREATE INDEX ix_docs_comment_event_project_id ON docs_comment_event (project_id);

CREATE INDEX ix_docs_comment_read_thread_id ON docs_comment_read (thread_id);

CREATE INDEX ix_docs_comment_thread_page_id ON docs_comment_thread (page_id);

CREATE INDEX ix_docs_draft_page_id ON docs_draft (page_id);

CREATE INDEX ix_docs_link_source_page_id ON docs_link (source_page_id);

CREATE INDEX ix_docs_link_target_page_id ON docs_link (target_page_id);

CREATE INDEX ix_docs_link_target_ticket_id ON docs_link (target_ticket_id);

CREATE INDEX ix_docs_page_parent_id ON docs_page (parent_id);

CREATE INDEX ix_docs_page_project_id ON docs_page (project_id);

CREATE INDEX ix_docs_page_seen_page_id ON docs_page_seen (page_id);

CREATE INDEX ix_docs_title_aliases_page_id ON docs_title_aliases (page_id);

CREATE INDEX ix_docs_version_page_id ON docs_version (page_id);

CREATE INDEX ix_idea_advice_idea_id ON idea_advice (idea_id);

CREATE INDEX ix_idea_assumption_idea_id ON idea_assumption (idea_id);

CREATE INDEX ix_idea_comment_idea_id ON idea_comment (idea_id);

CREATE INDEX ix_idea_digest_project_id ON idea_digest (project_id);

CREATE INDEX ix_idea_evidence_assumption_id ON idea_evidence (assumption_id);

CREATE INDEX ix_idea_log_entry_idea_id ON idea_log_entry (idea_id);

CREATE INDEX ix_idea_ticket_project_id ON idea_ticket (project_id);

CREATE INDEX ix_idea_ticket_stage ON idea_ticket (stage);

CREATE INDEX ix_idea_vote_idea_id ON idea_vote (idea_id);

CREATE UNIQUE INDEX uq_idea_vote_idea_voter ON idea_vote (idea_id, voter);

CREATE INDEX ix_member_project_id ON member (project_id);

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

CREATE INDEX ix_notify_event_created_at ON notify_event (created_at);

CREATE INDEX ix_notify_event_kind ON notify_event (kind);

CREATE INDEX ix_notify_event_project_id ON notify_event (project_id);

CREATE INDEX ix_notify_event_target_id ON notify_event (target_id);

CREATE INDEX ix_notify_follow_project_id ON notify_follow (project_id);

CREATE INDEX ix_notify_follow_recipient ON notify_follow (recipient);

CREATE INDEX ix_notify_follow_scope_id ON notify_follow (scope_id);

CREATE INDEX ix_sketch_owner_id ON sketch (owner_id);

CREATE INDEX ix_sketch_project_id ON sketch (project_id);

CREATE INDEX ix_story_project_id ON story (project_id);

CREATE INDEX ix_story_state ON story (state);

CREATE INDEX ix_ticket_assignee ON ticket (assignee);

CREATE INDEX ix_ticket_from_idea_id ON ticket (from_idea_id);

CREATE INDEX ix_ticket_parent_id ON ticket (parent_id);

CREATE INDEX ix_ticket_project_status ON ticket (project_id, status);

CREATE INDEX ix_ticket_tests_assumption_id ON ticket (tests_assumption_id);
