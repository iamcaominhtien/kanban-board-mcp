//! What an AI team is told about a ticket before a run, with untrusted text fenced.
//!
//! Trust comes from who wrote the text, never from its wording: project members are trusted, other AI members are
//! data only, anything else (agent tools, imports) is untrusted. AI v2 has no permission layer: fencing lowers the
//! risk, and the run's short deny list and its own worktree limit what a fooled model can do.

use std::collections::HashSet;

use kb_base::secrets::redact;
use kb_base::{pyjson, pytext};
use kb_db::entities::ticket;
use serde_json::{Map, Value, json};

use crate::injection::trust_of;

/// `STATUS_LABELS.get(status, status)`.
pub fn status_label(status: &str) -> &str {
    match status {
        "backlog" => "Backlog",
        "todo" => "To Do",
        "in-progress" => "In Progress",
        "review" => "Review",
        "testing" => "Testing",
        "done" => "Done",
        "wont_do" => "Won't Do",
        "none" => "None",
        other => other,
    }
}

/// Who is acting while a run's tool calls are handled.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RunContext {
    /// The run it belongs to.
    pub run_id: String,
    /// The AI member (team) it is about.
    pub member_id: String,
    /// The member's name as it was when the entry was written.
    pub member_name: String,
    /// The project it belongs to.
    pub project_id: String,
    /// None for a run that is not on a ticket (Python passes `run.ticket_id` as it is)
    pub ticket_id: Option<String>,
    /// The person the AI acted for.
    pub on_behalf_of: String,
    /// work | ask
    pub mode: String,
    /// What started the run (`assign`, `message`, `schedule`...).
    pub trigger: String,
    /// AI-to-AI hand-offs behind this run (see `runs.MAX_DEPTH`)
    pub depth: i64,
    /// A Board AI chat answer that acts by risk tier (D23): its board tools only read, and its changes go through the
    /// chat's actions block, where the board applies them by tier with one Undo
    pub acts_by_tier: bool,
}

impl RunContext {
    /// Attribution stored on activity entries.
    pub fn activity(&self) -> Map<String, Value> {
        let mut out = Map::new();
        out.insert("member_id".into(), json!(self.member_id));
        out.insert("on_behalf_of".into(), json!(self.on_behalf_of));
        out.insert("run_id".into(), json!(self.run_id));
        out
    }

    fn ticket_text(&self) -> String {
        self.ticket_id.clone().unwrap_or_else(|| "None".to_string())
    }
}

fn fence(source: &str, text: &str) -> String {
    let safe = text.replace("</untrusted>", "<\\/untrusted>");
    format!("<untrusted source=\"{source}\">\n{safe}\n</untrusted>")
}

/// The options of `ticket_block` (the keyword arguments of the Python function).
#[derive(Debug, Clone)]
pub struct TicketBlockOptions<'a> {
    /// Whether the recent comments are shown.
    pub comments: bool,
    /// Whether the acceptance criteria are shown.
    pub criteria: bool,
    /// How many of the newest comments are shown (`items[-n:]`).
    pub comment_limit: i64,
    /// The ticket's sub-tickets, listed under it.
    pub sub_tickets: Option<&'a [ticket::Model]>,
    /// The names of the project's people: a comment by anyone else is an outsider's.
    pub humans: Option<&'a HashSet<String>>,
    /// Whether an outsider's comments are shown (fenced).
    pub allow_external: bool,
}

impl Default for TicketBlockOptions<'_> {
    fn default() -> Self {
        Self {
            comments: true,
            criteria: true,
            comment_limit: 20,
            sub_tickets: None,
            humans: None,
            allow_external: false,
        }
    }
}

/// `items[-n:]` for a Python list: `n` 0 gives all of it, a negative `n` drops that many from the front.
pub(crate) fn tail<T>(items: &[T], n: i64) -> &[T] {
    let len = items.len() as i64;
    let start = if n > 0 { (len - n).max(0) } else { (-n).min(len) };
    &items[start as usize..]
}

fn text_field(c: &Value, key: &str) -> String {
    match c.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => pyjson::py_str(other),
    }
}

/// `c.get("author") or "user"`.
fn author_of(c: &Value) -> String {
    match c.get("author") {
        Some(v) if pyjson::truthy(v) => pyjson::py_str(v),
        _ => "user".to_string(),
    }
}

/// The ticket as the agent sees it: fields trusted, AI-written and unknown-author text fenced. With `humans` given, a
/// comment by anyone who is not a project member is untrusted: it is fenced and shown only when the agent allows
/// external sources.
pub fn ticket_block(ticket: &ticket::Model, ai_names: &HashSet<String>, options: &TicketBlockOptions<'_>) -> String {
    let mut lines: Vec<String> = vec![
        format!("<ticket id=\"{}\" trusted>", ticket.id),
        format!("Title: {}", ticket.title),
        format!("Type: {} · Priority: {} · Status: {}", ticket.r#type, ticket.priority, status_label(&ticket.status)),
    ];
    if let Some(estimate) = ticket.estimate {
        lines.push(format!("Estimate: {}", pyjson::float_repr(estimate.get())));
    }
    lines.push("Description:".into());
    lines.push(redact(if ticket.description.is_empty() { "(empty)" } else { &ticket.description }));
    if options.criteria {
        let acs = crate::store::loads(Some(&ticket.acceptance_criteria), json!([]));
        if let Some(acs) = acs.as_array().filter(|a| !a.is_empty()) {
            lines.push("Acceptance criteria:".into());
            for (i, ac) in acs.iter().enumerate() {
                let done = ac.get("done").is_some_and(pyjson::truthy);
                let text = match ac.get("text") {
                    Some(v) => pyjson::py_str(v),
                    None => String::new(),
                };
                lines.push(format!("  {}. [{}] {}", i + 1, if done { "x" } else { " " }, text));
            }
        }
    }
    if let Some(subs) = options.sub_tickets.filter(|s| !s.is_empty()) {
        lines.push("Sub-tickets:".into());
        for sub in subs {
            lines.push(format!("  - {} {} ({})", sub.id, sub.title, status_label(&sub.status)));
        }
    }
    lines.push("</ticket>".into());
    if options.comments {
        let all = crate::store::loads(Some(&ticket.comments), json!([]));
        let all: Vec<Value> = all.as_array().cloned().unwrap_or_default();
        let items: Vec<&Value> = all.iter().filter(|c| !c.get("deleted_at").is_some_and(pyjson::truthy)).collect();
        let items = tail(&items, options.comment_limit);
        if !items.is_empty() {
            lines.push("Recent comments (oldest first):".into());
            let mut held_back = 0;
            for c in items {
                let author = author_of(c);
                let text = redact(&text_field(c, "text"));
                let trust = match options.humans {
                    Some(humans) => trust_of(&author, humans, ai_names),
                    None if ai_names.contains(&author) => "data_only",
                    None => "trusted",
                };
                if ai_names.contains(&author) {
                    lines.push(fence(&format!("comment · AI member {author}"), &text));
                } else if author == "agent" {
                    lines.push(fence("comment · external agent", &text));
                } else if trust == "untrusted" {
                    if options.allow_external {
                        lines.push(fence(&format!("comment · guest {author}"), &text));
                    } else {
                        held_back += 1;
                    }
                } else {
                    let who = if author == "user" { "board user" } else { author.as_str() };
                    let at: String = match c.get("at") {
                        Some(Value::String(s)) => s.chars().take(16).collect(),
                        _ => String::new(),
                    };
                    lines.push(format!("- {who} ({at}): {text}"));
                }
            }
            if held_back > 0 {
                lines.push(format!(
                    "({held_back} comment(s) from outside the project are not shown to you: this AI member does not read external sources.)"
                ));
            }
        }
    }
    lines.join("\n")
}

/// The comments of a ticket as an AI may read them through a tool (`get_ticket`): deleted ones left out, secrets
/// redacted, text by other AI members, agents and outsiders fenced as data, outsiders' comments held back unless the
/// member reads external sources. Returns (comments, how many were held back). The prompt's `ticket_block` applies the
/// same rules to the comments it prints.
pub fn comments_for_reader(
    raw: &[Value],
    ai_names: &HashSet<String>,
    humans: Option<&HashSet<String>>,
    allow_external: bool,
) -> (Vec<Value>, usize) {
    let mut out = Vec::new();
    let mut held_back = 0;
    for c in raw {
        let Some(map) = c.as_object() else { continue };
        if map.get("deleted_at").is_some_and(pyjson::truthy) {
            continue;
        }
        let author = author_of(c);
        let mut text = redact(&match map.get("text") {
            Some(v) if pyjson::truthy(v) => pyjson::py_str(v),
            _ => String::new(),
        });
        let outsider = match humans {
            Some(humans) if !ai_names.contains(&author) && author != "agent" => {
                trust_of(&author, humans, ai_names) == "untrusted"
            }
            _ => false,
        };
        if ai_names.contains(&author) {
            text = fence(&format!("comment · AI member {author}"), &text);
        } else if author == "agent" {
            text = fence("comment · external agent", &text);
        } else if outsider {
            if !allow_external {
                held_back += 1;
                continue;
            }
            text = fence(&format!("comment · guest {author}"), &text);
        }
        let mut copy = map.clone();
        copy.insert("text".into(), json!(text));
        out.push(Value::Object(copy));
    }
    (out, held_back)
}

/// The request that started the run.
pub fn instruction_block(ctx: &RunContext, instruction: &str, person_trusted: bool) -> String {
    if pytext::strip(instruction).is_empty() {
        if ctx.mode == "ask" {
            return "Answer the latest question in the comments.".to_string();
        }
        return format!("{} assigned {} to you. Do the work it describes.", ctx.on_behalf_of, ctx.ticket_text());
    }
    if person_trusted {
        return format!("<instruction from=\"{}\" trusted>\n{}\n</instruction>", ctx.on_behalf_of, redact(instruction));
    }
    fence("AI member mention", &redact(instruction))
}
