//! Part of `services/notifications.py`: lines 54 to 136, the module's constants: the kinds and their rules, the
//! sounds, the reminder choices, the grouping limits and the default settings.

use serde_json::{Value, json};

/// The SSE topic of "the log moved".
pub const TOPIC: &str = "notifications";

/// One notification kind: (label in Settings, Needs you, desktop by default, can be dismissed).
#[derive(Debug, Clone, Copy)]
pub struct Kind {
    /// The kind's name.
    pub name: &'static str,
    /// Its label in Settings.
    pub label: &'static str,
    /// Needs you (may interrupt) rather than for information.
    pub needs: bool,
    /// Desktop notification on by default.
    pub desktop: bool,
    /// Can be dismissed from the row.
    pub dismissable: bool,
}

const fn kind(name: &'static str, label: &'static str, needs: bool, desktop: bool, dismissable: bool) -> Kind {
    Kind { name, label, needs, desktop, dismissable }
}

/// `KINDS`, in the Python dict's order.
pub static KINDS: &[Kind] = &[
    // Needs you: may interrupt. In app is locked on.
    kind("question", "A question from an AI", true, true, false),
    kind("run_failed", "A run failed or timed out", true, true, true),
    kind("account_signed_out", "An AI account signed out", true, true, false),
    kind("mention", "Someone mentioned you", true, true, true),
    kind("run_stopped_memory", "A run was stopped for memory", true, true, true),
    kind("budget", "Budget or cap reached", true, true, true),
    kind("auto_trip", "AI was paused (auto-trip or Pause all AI)", true, true, true),
    kind("offline", "An AI team went offline", true, false, true),
    // AI team v2 (design/screens/ai-operations.md C, D; ai-board-wave3.md L)
    kind("run_stuck", "An AI stopped moving", true, true, true),
    kind("board_fault", "The board failed an AI (a board fault)", true, true, true),
    kind("merge_conflict", "A merge conflict", true, true, false),
    kind("arbitration", "Two AIs could not agree", true, true, false),
    kind("window_urgent", "Urgent work waits for a usage window", true, true, true),
    kind("workflow_step", "A workflow waits for you (the design to approve)", true, true, false),
    kind("workflow_blocked", "A workflow step cannot start, or a ticket reached its token cap", true, true, false),
    // For information: never interrupts.
    kind("ai_finished", "An AI finished work", false, false, false),
    kind("schedule", "A scheduled run finished or was skipped", false, false, false),
    kind("schedule_started", "A scheduled run started", false, false, false),
    kind("page_published", "A page was published", false, false, false),
    kind("comment", "A new comment in a thread you follow", false, false, false),
    kind("run_cancelled", "A run was cancelled", false, false, false),
    kind("budget_warning", "Budget passed a warning level", false, false, false),
    kind("access_request", "Someone asked for access to Docs", false, false, false),
    kind("day_card", "The day in one card", false, false, false),
    kind("window_wait", "Runs wait for the next usage window", false, false, false),
    kind("lesson", "An AI proposed a lesson for the project", false, false, false),
];

/// `KINDS.get(name)`.
pub fn kind_info(name: &str) -> Option<&'static Kind> {
    KINDS.iter().find(|k| k.name == name)
}

/// `NEEDS_KINDS`: the order of the Settings table (L).
pub fn needs_kinds() -> impl Iterator<Item = &'static Kind> {
    KINDS.iter().filter(|k| k.needs)
}

/// `INFO_KINDS`.
pub fn info_kinds() -> impl Iterator<Item = &'static Kind> {
    KINDS.iter().filter(|k| !k.needs)
}

/// The sounds a person can pick (the desktop app and the browser play the same three, see desktop/sounds.js and
/// ui/src/utils/notificationSound.ts).
pub const SOUND_NAMES: [&str; 3] = ["chime", "drop", "bell"];
/// What "Remind me if unanswered" offers, in minutes (0 = off).
pub const REMIND_CHOICES: [i64; 6] = [0, 5, 10, 15, 30, 60];
/// The longest "remind after", in minutes.
pub const REMIND_MAX_MIN: i64 = 24 * 60;
/// How often the loop looks for Needs you rows that waited long enough, in seconds.
pub const REMIND_EVERY_S: f64 = 30.0;

/// Same-kind events of one project inside this many minutes are one row.
pub const GROUP_WINDOW_MINUTES: i64 = 10;
/// Above this a grouped row says "20+".
pub const GROUP_NAMES_MAX: i64 = 20;
/// How many events a grouped row keeps.
pub const GROUP_ITEMS_KEPT: usize = 50;
/// The bell panel shows the last this many days.
pub const PANEL_DAYS: i64 = 30;
/// How long notifications and the log are kept unless set otherwise.
pub const DEFAULT_RETENTION_DAYS: i64 = 90;

/// `DEFAULT_PREFS` (a new copy: callers change it).
pub fn default_prefs() -> Value {
    json!({
        "events": {},
        "quiet": {"on": true, "start": "22:00", "end": "08:00"},
        // the master switch: no OS notification at all when off
        "desktop_on": true,
        "dnd": true,
        // A short sound for Needs you events (never for information): on by default, a choice of a few (#270)
        "sound": true,
        "sound_name": "chime",
        // Minutes a Needs you row may stay unanswered before it notifies once more; 0 = never remind
        "remind_after_min": 15,
        "day_card": {"on": true, "time": "18:00", "days": [0, 1, 2, 3, 4]},
    })
}

/// What a recipient key looks like when it is the board's own user.
pub const SELF_NAMES: [&str; 4] = ["", "user", "you", "me"];

/// Who an AI team is called when the team is gone.
pub const AN_AI_TEAM: &str = "An AI team";
