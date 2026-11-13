//! The notification centre: port of `server/services/notifications.py` and `server/api/notifications.py`.
//!
//! One append-only event log (`notify_event`, increasing integer ids) is the source. Each event is written as one
//! `notification` row per recipient: a person's key (a name, lower case; "user" for the board's own user) or
//! "ai:<member id>" for an AI member. Read, done (and why), snoozed and cleared are kept per row.
//!
//! Two kinds of notification:
//! - Needs you: the work cannot go on without a person. It may interrupt (toast, desktop) and it closes itself when
//!   the thing it points at no longer needs a person (`reconcile`), wherever that happened.
//! - For information: it only adds to the list. Same-kind events of one project inside 10 minutes are one row.
//!
//! "Off" means quiet, not unrecorded: every event is written; a switch or a mute only makes a row quiet (`inapp`
//! false: not in the panel or the count, still on the All notifications page and in the day card). A Needs you row
//! is never quiet.
//!
//! The modules follow the sections of the Python file, in its order; each says which lines it is. The functions
//! other areas call are re-exported here under the Python names (`kb_notify::emit`, `kb_notify::person_key`...).

pub mod acting;
pub mod api;
pub mod daycard;
pub mod db;
pub mod delivery;
pub mod error;
pub mod features;
pub mod follow;
pub mod helpers;
pub mod kinds;
pub mod lifecycle;
pub mod reading;
pub mod recipients;
pub mod resolving;
pub mod schemas;
pub mod settings;
pub mod writing;

pub use acting::{
    PER_RECIPIENT_KINDS, PageFilters, clear, clear_read, dismiss, mark_read, mark_target_read, mine, snooze,
};
pub use daycard::{
    build_day_card, card_due, card_of, card_since, day_id, docs_line, failed_line, finished_lines,
    latest_scheduled_card, not_retried, people, prune, published_between, runs_of_the_day, tomorrow_line, waiting_line,
    waiting_of, write_day_cards,
};
pub use delivery::{Event, announce, clear_queues, head_id, mark_dirty};
pub use error::{NotifyError, Result};
pub use features::{
    CHAT_OPEN_FOR_SECONDS, CommentFields, chat_in_front, close_passed_question, comment_body, comment_event,
    comment_notice, drain_background, failed_notice, finished_notice, on_comment_event, on_page_published,
    on_run_ended, on_run_question, on_run_trouble, on_window_urgent, run_end_notice, run_people,
};
pub use follow::{
    follow_label, follow_state, follow_to_dict, follows_of, muted_list, mutes, quiet_by_follows, set_follow, unmute,
};
pub use helpers::{ai_key, is_needs, now_iso, person_key};
pub use kinds::{
    DEFAULT_RETENTION_DAYS, GROUP_ITEMS_KEPT, GROUP_NAMES_MAX, GROUP_WINDOW_MINUTES, KINDS, Kind, PANEL_DAYS,
    REMIND_CHOICES, REMIND_EVERY_S, REMIND_MAX_MIN, SOUND_NAMES, TOPIC, default_prefs, info_kinds, kind_info,
    needs_kinds,
};
pub use lifecycle::{
    RECONCILE_EVERY_S, RECONCILE_MAX_PAUSE_S, backfill_waiting, loop_running, remind_unanswered, start, stop,
    wake_snoozed,
};
pub use reading::{
    DOCS_KINDS, FILTERS, ListOptions, actions, counts, day_card_dict, done_text, feed, is_snoozed, latest_day_card,
    list_rows, log_since, member_names, not_snoozed, readable_by, rows_stmt, snoozed, to_dict, where_family,
    where_page_filter, where_panel, where_search,
};
pub use recipients::{ai_names, followers, managed_projects, may_manage, owners_and_admins, recipient_keys};
pub use resolving::{
    GONE, Why, alive_targets, closes_by_itself, mark_gone, open_needs_groups, reconcile, resolve_rows, resolve_target,
    sign_out_noted, user_and_admins_of, via, watch_accounts, why_account_closed, why_budget_closed, why_closed,
    why_closed_by_kind, why_flag_closed, why_gone, why_pause_closed, why_question_closed, why_retried,
    why_thread_closed, why_trouble_closed, why_window_closed,
};
pub use settings::{
    Prefs, apply_day_card, apply_event_choices, apply_quiet, event_switch, get_prefs, global, hhmm, in_quiet_hours,
    prefs_of, remind_after, retention_days, set_global, settings_for, sound_name, update_settings,
};
pub use writing::{
    EmitFields, PendingEvent, emit, enqueue, flush_pending, group_body, group_key, group_title, keys_to_tell,
    merge_into, point_at_last_run, prepare_pending, recipients_state, ticket_order, write_row,
};
