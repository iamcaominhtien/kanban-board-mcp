//! What one Claude Code run is started with (AI v2): the command line, the environment, the files it reads. Port of
//! `services/ai/launch.py`.
//!
//! Nothing is written into the person's repository. Each run gets a folder under the board's data directory with the
//! team's agents (`--agents`), its system prompt files, the report schema and the debug log; the board's own plugin
//! (hooks that report progress) and the skills plugin are shared and travel by `--plugin-dir`.
//!
//! The Python module is one file; here it is this file (lines 1 to 300: the report schema, the notes of a run a
//! message started, `Launch`, the folders and the board's plugin) and two more in the order of the Python text:
//! `prompts` (302 to 548: the rules of the lead and of its roles, the first user message) and `command` (550 to 845:
//! the MCP config, the settings, the command line, `prepare`). Every name of the Python module is `launch::<name>` here
//! too.
//!
//! Everything built here is read by Claude Code and by the agent: every text is the Python one character for
//! character, every JSON object keeps the key order of the Python dict and is written as `json.dumps` writes it
//! (`contract/golden/ai_launch.json` decides).

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use kb_ai::hook_guard;
use kb_ai::profiles::Env;
use kb_base::{pyjson, pytext};
use kb_db::database;
use kb_db::sea_orm::DbErr;
use serde_json::{Map, Value, json};

mod command;
mod prompts;

pub use command::*;
pub use prompts::*;

/// The version of the board's plugin: its folder is written once per version.
pub const BOARD_PLUGIN_VERSION: &str = "2.1.2";
/// what a transcript shows in place of the run's MCP token
pub const RUN_TOKEN_SHOWN: &str = "<run token>";
/// The deny rules every run gets before the project's own.
pub const DEFAULT_DENY: [&str; 8] = [
    "Bash(git push --force*)",
    "Bash(git push -f *)",
    "Bash(git push -f)",
    // the flag after the remote and the branch: `git push origin main --force`
    "Bash(git push * --force*)",
    "Bash(git push * -f)",
    "Bash(git push * -f *)",
    "Bash(rm -rf /*)",
    "Bash(rm -rf ~*)",
];

/// `REPORT_SCHEMA`: the JSON schema of a lead's final report (`--json-schema`).
pub static REPORT_SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "type": "object",
        "properties": {
            "status": {
                "type": "string",
                "enum": ["done", "partial", "blocked", "question", "nothing_to_do"],
                "description": "done: the work is complete; partial: some of it; blocked: you could not continue; question: you need a person's answer (also asked with ai_run ask); nothing_to_do: the ticket needed no change",
            },
            "summary": {
                "type": "string",
                "description": "What you did, for the ticket's people, 3 to 10 lines of Markdown",
            },
            "branch": {
                "type": "string",
                "description": "The git branch holding the work, if any",
            },
            "pr_url": {
                "type": "string",
                "description": "The pull request, if one was opened",
            },
            "tests": {
                "type": "object",
                "properties": {
                    "passed": {"type": "integer"},
                    "failed": {"type": "integer"},
                    "command": {"type": "string"},
                },
            },
            "open_items": {
                "type": "array",
                "items": {"type": "string"},
                "description": "What is left or needs a person",
            },
            "lessons": {
                "type": "array",
                "items": {"type": "string"},
                "description": "One-line lessons about this project worth keeping for the next runs (commands that work, traps, conventions); empty if none",
            },
            "findings": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Problems a Reviewer role found, one line each; leave it out if none",
            },
            "asks": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Questions a person must answer before the work can continue",
            },
            "skills": {
                "type": "array",
                "items": {"type": "string"},
                "description": "The skills you and your roles opened with the Skill tool, by name (kanban-board:docs-pages)",
            },
            "comment_needed": {
                "type": "boolean",
                "description": "Set it in a run a person's chat message started. false: your chat answer (ai_run reply) is enough and you changed nothing, so the board does not post this report as a comment. true: you did something worth a trace (a file, a status, a result) or left something open for people, so the board posts it. Leave it out in other runs: the board always posts the report.",
            },
        },
        "required": ["status", "summary"],
    })
});

/// After the request of a run a message started (the ticket chat): how to answer it, and when the ticket needs a
/// comment.
pub const CHAT_RUN_NOTE: &str = "<board trusted>\n\
This run began with a message from the ticket chat. Answer it there with ai_run(action='reply').\n\
Chat is for talking; a ticket comment is for news of the work, results and what others must read later.\n\
If your chat answer is enough and you changed nothing, set comment_needed to false in your final report:\n\
the board then posts no comment. If you did anything worth a trace (a file, a status, a result), or left\n\
something open for people, set comment_needed to true: the board posts your report as the ticket's comment.\n\
</board trusted>";

// A run that a note started (not a person's assignment): where the note came from, and so how to answer it. A run
// whose trigger is not here has no note. The chat's note asks for `ai_run reply`; no other source is a chat, so none
// of them gets that.

/// The note of a run that comment threads sent from a Docs page started.
pub const DOCS_RUN_NOTE: &str = "<board trusted>\n\
This run began with comment threads sent from a Docs page (a person pressed Send to AI there). The person is on the\n\
page, not in a chat: do not use ai_run(action='reply'). Work as the note says: change the page with\n\
docs_write(action='edit'), answer in each thread with docs_write(action='reply', thread_id, body), and close a thread\n\
only as the skill `kanban-board:docs-comment-threads` says (open it with the Skill tool before you start). Say in your final report what you changed on the page\n\
(section, version) and which threads stay open and why; the board posts that report as a comment on this ticket.\n\
</board trusted>";
/// The note of a run that another AI's note started.
pub const AI_MESSAGE_RUN_NOTE: &str = "<board trusted>\n\
This run began with a note from another AI (it says who). It is not a person's chat message: answer by doing the\n\
work it asks for and reporting, or reply to that AI with ai_run(action='message', to=...) when it needs an answer\n\
(that hand-off is counted: after a few the board refuses another). Do not use ai_run(action='reply').\n\
</board trusted>";
/// The note of a run that a red CI of the pull request started.
pub const CI_RUN_NOTE: &str = "<board trusted>\n\
This run began because the pull request's CI is red (the failing log is in the note). Fix what the log shows,\n\
push to the branch and say in your report what you changed. It is not a chat message: do not use ai_run(action='reply').\n\
</board trusted>";
/// The note of a run that a reviewer's comments on the pull request started.
pub const REVIEW_RUN_NOTE: &str = "<board trusted>\n\
This run began because a reviewer commented on the pull request (the comments are in the note). Answer each\n\
comment by changing the code or saying why not, push to the branch and report. It is not a chat message: do not\n\
use ai_run(action='reply').\n\
</board trusted>";

/// `RUN_NOTES`: the note of a run by what started it.
pub const RUN_NOTES: [(&str, &str); 5] = [
    ("message", CHAT_RUN_NOTE),
    ("docs_threads", DOCS_RUN_NOTE),
    ("ai_message", AI_MESSAGE_RUN_NOTE),
    ("ci_red", CI_RUN_NOTE),
    ("review_comments", REVIEW_RUN_NOTE),
];

/// `RUN_NOTES.get(trigger)`.
pub fn run_note(trigger: &str) -> Option<&'static str> {
    RUN_NOTES.iter().find(|(key, _)| *key == trigger).map(|(_, note)| *note)
}

/// What a function of this module fails with.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// `ValueError`: a run id that would lead out of the runs folder.
    #[error("{0}")]
    Value(String),
    /// `RuntimeError`: there is no CLI to start; the message says why (`cli.missing`).
    #[error("{0}")]
    Runtime(String),
    /// The database call failed.
    #[error(transparent)]
    Db(#[from] DbErr),
    /// A folder or a file of the run could not be written (`OSError`).
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// Any other exception (the account's environment could not be built).
    #[error("{0}")]
    Other(String),
}

/// Everything `runs` needs to start the CLI.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Launch {
    /// The command line.
    pub args: Vec<String>,
    /// The folder the CLI works in.
    pub cwd: String,
    /// The CLI's environment.
    pub env: Env,
    /// The first user message.
    pub prompt: String,
    /// The system prompt of the lead.
    pub system: String,
    /// Whether the CLI takes its messages on stdin (stream-json).
    pub live: bool,
    /// Whether the run continues a session.
    pub resume: bool,
    /// The CLI session of the run.
    pub session_id: String,
    /// The run's folder.
    pub run_dir: String,
    /// Folders to remove when the run ends.
    pub scratch: Vec<String>,
    /// The plugin folders the CLI loads.
    pub plugin_dirs: Vec<String>,
    /// The team's roles as `--agents` takes them.
    pub agents: Map<String, Value>,
    /// `args` as the transcript keeps them: the board's MCP header says <run token>, never the token itself
    pub record_args: Vec<String>,
}

// ---------------------------------------------------------------------------
// Folders and the board's plugin
// ---------------------------------------------------------------------------

/// Where the board keeps what its runs are started with.
pub fn data_root() -> std::io::Result<PathBuf> {
    let db = database::get_db_path();
    let root = db.parent().map(Path::to_path_buf).unwrap_or_default().join("ai-v2");
    std::fs::create_dir_all(&root)?;
    Ok(root)
}

/// `_hook_script_posix`: the script that posts a hook event to the board.
pub fn hook_script_posix() -> String {
    concat!(
        "#!/bin/sh\n",
        "# Reports a Claude Code hook event to the board (AI v2). Never blocks the AI: exit 0 whatever happens.\n",
        "[ -n \"$KANBAN_URL\" ] && [ -n \"$KANBAN_RUN_TOKEN\" ] || exit 0\n",
        "curl -s -m 5 -X POST \"$KANBAN_URL/ai/hooks\" -H \"Content-Type: application/json\" ",
        "-H \"Authorization: Bearer $KANBAN_RUN_TOKEN\" --data-binary @- >/dev/null 2>&1\n",
        "exit 0\n",
    )
    .to_string()
}

/// `_hook_script_windows`: the same for `cmd.exe`.
pub fn hook_script_windows() -> String {
    concat!(
        "@echo off\r\n",
        "if \"%KANBAN_URL%\"==\"\" exit /b 0\r\n",
        "if \"%KANBAN_RUN_TOKEN%\"==\"\" exit /b 0\r\n",
        "curl.exe -s -m 5 -X POST \"%KANBAN_URL%/ai/hooks\" -H \"Content-Type: application/json\" ",
        "-H \"Authorization: Bearer %KANBAN_RUN_TOKEN%\" --data-binary @- >nul 2>&1\r\n",
        "exit /b 0\r\n",
    )
    .to_string()
}

/// `str(path)`.
pub(crate) fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The board's plugin: hooks that tell the board what a run does. Written once per version.
pub fn board_plugin_dir() -> std::io::Result<String> {
    let root = data_root()?.join("board-plugin").join(BOARD_PLUGIN_VERSION);
    let stamp = root.join(".ready");
    if stamp.exists() {
        return Ok(path_text(&root));
    }
    std::fs::create_dir_all(root.join(".claude-plugin"))?;
    std::fs::create_dir_all(root.join("hooks"))?;
    std::fs::write(
        root.join(".claude-plugin").join("plugin.json"),
        pyjson::dumps(&json!({
            "name": "kanban-board",
            "version": BOARD_PLUGIN_VERSION,
            "description": "The board follows the run: edits, subagents, plans and the end of the run reach it as events.",
        })),
    )?;
    let win = cfg!(windows);
    // quoted: the plugin lives under the data folder, whose path may hold spaces ("Application Support" on macOS, a
    // user name with a space on Windows); an unquoted path made every hook fail with exit 127 and nothing reached the
    // board
    let script =
        if win { "\"${CLAUDE_PLUGIN_ROOT}/hooks/post.cmd\"" } else { "sh \"${CLAUDE_PLUGIN_ROOT}/hooks/post.sh\"" };
    let one = json!([{"type": "command", "command": script, "timeout": 10}]);
    // the one safety rule (docs/specs/ai-v2.md section 2): no force push to the main branch, no recursive rm outside
    // the run's folder. It answers with JSON and never fails the run (services/ai/hook_guard.py)
    let guard = if win {
        "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"${CLAUDE_PLUGIN_ROOT}/hooks/guard.ps1\""
    } else {
        "sh \"${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh\""
    };
    let hooks = json!({
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "Bash|PowerShell",
                    "hooks": [{"type": "command", "command": guard, "timeout": 10}],
                }
            ],
            "PostToolUse": [
                {
                    "matcher": "Edit|Write|MultiEdit|NotebookEdit|TaskCreate|TaskUpdate|TodoWrite",
                    "hooks": one,
                }
            ],
            "Stop": [{"hooks": one}],
        }
    });
    std::fs::write(root.join("hooks").join("hooks.json"), pyjson::Dumps::new().indent(1).dump(&hooks))?;
    let sh = root.join("hooks").join("post.sh");
    std::fs::write(&sh, hook_script_posix())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&sh, std::fs::Permissions::from_mode(0o755))?;
    }
    std::fs::write(root.join("hooks").join("post.cmd"), hook_script_windows())?;
    std::fs::write(root.join("hooks").join("guard.sh"), hook_guard::POSIX)?;
    std::fs::write(root.join("hooks").join("guard.ps1"), hook_guard::POWERSHELL)?;
    std::fs::write(&stamp, "ok")?;
    Ok(path_text(&root))
}

/// `Path(path).resolve()`: absolute, without `.`, `..` or symbolic links; a part that does not exist is kept as
/// written.
fn resolve(path: &Path) -> PathBuf {
    let absolute =
        if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(path) };
    let mut todo: Vec<std::ffi::OsString> = Vec::new();
    let push_parts = |todo: &mut Vec<std::ffi::OsString>, p: &Path| {
        let parts: Vec<std::ffi::OsString> = p
            .components()
            .filter_map(|c| match c {
                std::path::Component::Normal(name) => Some(name.to_os_string()),
                std::path::Component::ParentDir => Some("..".into()),
                _ => None,
            })
            .collect();
        todo.extend(parts.into_iter().rev());
    };
    let root_of = |p: &Path| -> PathBuf {
        p.components()
            .take_while(|c| matches!(c, std::path::Component::Prefix(_) | std::path::Component::RootDir))
            .collect()
    };
    let mut out = root_of(&absolute);
    push_parts(&mut todo, &absolute);
    let mut links = 0;
    while let Some(part) = todo.pop() {
        if part == ".." {
            out.pop();
            continue;
        }
        let next = out.join(&part);
        match std::fs::read_link(&next) {
            // a loop of links: Python keeps the path as written
            Ok(target) if links < 40 => {
                links += 1;
                if target.is_absolute() {
                    out = root_of(&target);
                }
                push_parts(&mut todo, &target);
            }
            _ => out = next,
        }
    }
    out
}

/// The folder of one run (its prompts, agents and debug log). A run id that would lead out of the runs folder is
/// refused (`Error::Value`).
pub fn run_dir(run_id: &str, create: bool) -> Result<PathBuf, Error> {
    let root = resolve(&data_root()?.join("runs"));
    let folder = resolve(&root.join(run_id));
    if folder.parent() != Some(root.as_path()) {
        return Err(Error::Value(format!("Not a run id: {}", pytext::repr(run_id))));
    }
    if create {
        std::fs::create_dir_all(&folder)?;
    }
    Ok(folder)
}

/// Remove a run's folder.
pub fn forget_run_dir(run_id: &str) {
    if let Ok(root) = data_root() {
        let _ = std::fs::remove_dir_all(root.join("runs").join(run_id));
    }
}
