//! One module per table, generated from the Python models by `contract/gen_entities.py`.
//!
//! Columns are what the database holds: times are ISO strings, lists and objects are JSON text. Links between
//! tables are kept by the app, never enforced by the database (`PRAGMA foreign_keys` stays off).

pub mod ai_account;
pub mod ai_account_state;
pub mod ai_assist_settings;
pub mod ai_audit;
pub mod ai_chat;
pub mod ai_chat_message;
pub mod ai_config_state;
pub mod ai_digest;
pub mod ai_insight;
pub mod ai_knowledge_doc;
pub mod ai_lesson;
pub mod ai_library_item;
pub mod ai_memory_note;
pub mod ai_plugin;
pub mod ai_project_knowledge;
pub mod ai_project_settings;
pub mod ai_repo_scan;
pub mod ai_role_pack;
pub mod ai_run;
pub mod ai_run_agent;
pub mod ai_run_command;
pub mod ai_run_message;
pub mod ai_run_step;
pub mod ai_run_transcript;
pub mod ai_schedule;
pub mod ai_schedule_run;
pub mod ai_session_history;
pub mod ai_skill_use;
pub mod ai_team;
pub mod ai_touch_mark;
pub mod ai_usage;
pub mod ai_watched_pr;
pub mod ai_worktree;
pub mod canvas;
pub mod canvas_comment;
pub mod canvas_proposal;
pub mod canvas_thread;
pub mod canvas_version;
pub mod diagram;
pub mod diagram_settings;
pub mod diagram_version;
pub mod docs_ai_health;
pub mod docs_ai_ignore;
pub mod docs_ai_job;
pub mod docs_ai_session;
pub mod docs_ai_settings;
pub mod docs_anchor_aliases;
pub mod docs_comment;
pub mod docs_comment_event;
pub mod docs_comment_read;
pub mod docs_comment_thread;
pub mod docs_draft;
pub mod docs_link;
pub mod docs_page;
pub mod docs_page_seen;
pub mod docs_title_aliases;
pub mod docs_version;
pub mod idea_advice;
pub mod idea_ai_settings;
pub mod idea_assumption;
pub mod idea_comment;
pub mod idea_counter;
pub mod idea_digest;
pub mod idea_evidence;
pub mod idea_log_entry;
pub mod idea_ticket;
pub mod idea_vote;
pub mod member;
pub mod notification;
pub mod notify_event;
pub mod notify_follow;
pub mod notify_prefs;
pub mod project;
pub mod sketch;
pub mod story;
pub mod ticket;
pub mod workspace_settings;

/// Every table of the app, in the order the Python metadata sorts them (parents before children).
pub const TABLES: &[&str] = &[
    "ai_account",
    "ai_account_state",
    "ai_assist_settings",
    "ai_audit",
    "ai_knowledge_doc",
    "ai_lesson",
    "ai_memory_note",
    "ai_plugin",
    "ai_project_knowledge",
    "ai_repo_scan",
    "ai_role_pack",
    "ai_run_agent",
    "ai_run_command",
    "ai_run_message",
    "ai_run_step",
    "ai_run_transcript",
    "ai_session_history",
    "ai_skill_use",
    "ai_touch_mark",
    "ai_watched_pr",
    "ai_worktree",
    "diagram_settings",
    "docs_ai_ignore",
    "idea_ai_settings",
    "idea_counter",
    "idea_digest",
    "notification",
    "notify_event",
    "notify_follow",
    "notify_prefs",
    "project",
    "workspace_settings",
    "ai_chat",
    "ai_digest",
    "ai_insight",
    "ai_library_item",
    "ai_project_settings",
    "ai_schedule",
    "ai_usage",
    "canvas",
    "diagram",
    "docs_ai_health",
    "docs_ai_job",
    "docs_ai_session",
    "docs_ai_settings",
    "docs_page",
    "idea_ticket",
    "member",
    "sketch",
    "ai_chat_message",
    "ai_run",
    "ai_schedule_run",
    "ai_team",
    "canvas_proposal",
    "canvas_thread",
    "canvas_version",
    "diagram_version",
    "docs_anchor_aliases",
    "docs_comment_event",
    "docs_comment_thread",
    "docs_draft",
    "docs_link",
    "docs_page_seen",
    "docs_title_aliases",
    "docs_version",
    "idea_advice",
    "idea_assumption",
    "idea_comment",
    "idea_log_entry",
    "idea_vote",
    "ticket",
    "ai_config_state",
    "canvas_comment",
    "docs_comment",
    "docs_comment_read",
    "idea_evidence",
    "story",
];
