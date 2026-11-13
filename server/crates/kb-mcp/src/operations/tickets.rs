//! Ticket operations: list, read, create, update, delete.

use std::collections::HashSet;
use std::sync::LazyLock;

use kb_base::{activity, pyjson, time};
use kb_board::hooks::NewAssignee;
use kb_board::tickets::{self as svc_tickets, NewTicket, PendingReason, ReopenOptions, TicketUpdate};
use regex::Regex;
use serde_json::{Map, Value, json};

use super::comments::list_comments;
use crate::common::{
    self, ToolError, ToolResult, edit_ticket, missing_ticket, notify_on_success, ticket_summary, ticket_to_dict,
};
use crate::hooks;

/// The filters and the page of `list_tickets`.
#[derive(Debug, Clone)]
pub struct ListTickets<'a> {
    pub project_id: &'a str,
    pub status: Option<&'a str>,
    pub priority: Option<&'a str>,
    pub q: Option<&'a str>,
    pub include_wont_do: bool,
    pub pending: Option<bool>,
    pub reopened: Option<bool>,
    pub r#type: Option<&'a str>,
    pub parent_id: Option<&'a str>,
    pub detail: bool,
    pub limit: usize,
    pub offset: usize,
}

/// List a project's tickets as compact summaries (id, title, type, status, priority, assignee, parent_id, tags,
/// estimate, dates, blocked_by, and counts of acceptance criteria / test cases / comments / branches).
/// Call get_ticket for the description, comments, work log and the rest.
/// Returns {total, count, offset, has_more, tickets}: when has_more is true, call again with offset=offset+count.
pub async fn list_tickets(query: ListTickets<'_>) -> ToolResult {
    let mut tickets = {
        let session = common::async_session();
        svc_tickets::list_tickets(
            &session,
            query.project_id,
            query.status,
            query.priority,
            query.q,
            query.include_wont_do,
            query.pending,
            query.reopened,
        )
        .await?
    };
    // `if type:` / `if parent_id:`: an empty text is no filter
    if let Some(kind) = query.r#type.filter(|t| !t.is_empty()) {
        tickets.retain(|t| t.r#type == kind);
    }
    if let Some(parent_id) = query.parent_id.filter(|p| !p.is_empty()) {
        tickets.retain(|t| t.parent_id.as_deref() == Some(parent_id));
    }
    let total = tickets.len();
    let page: Vec<_> = tickets.into_iter().skip(query.offset).take(query.limit).collect();
    let count = page.len();
    let shown: Vec<Value> = if query.detail {
        page.into_iter().map(|t| ticket_to_dict(t, false).map(Value::Object)).collect::<Result<_, _>>()?
    } else {
        page.iter().map(ticket_summary).collect()
    };
    Ok(json!({
        "total": total,
        "count": count,
        "offset": query.offset,
        "has_more": query.offset + count < total,
        "tickets": shown,
    }))
}

/// The arguments of `create_ticket` after the project and the title.
#[derive(Debug, Clone)]
pub struct CreateTicket<'a> {
    pub project_id: &'a str,
    pub title: &'a str,
    pub r#type: &'a str,
    pub priority: &'a str,
    pub status: &'a str,
    pub description: &'a str,
    pub parent_id: Option<&'a str>,
    pub estimate: Option<f64>,
    pub due_date: Option<&'a str>,
    pub tags: Option<Vec<Value>>,
    pub start_date: Option<&'a str>,
    pub assignee: Option<&'a str>,
    pub acceptance_criteria: Option<Vec<String>>,
}

/// Create a ticket. Its ID is generated from the project prefix (e.g. 'IAM-5'). Returns the created ticket.
pub async fn create_ticket(args: CreateTicket<'_>) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        let tags = args.tags.unwrap_or_default();
        let new = NewTicket {
            r#type: args.r#type,
            priority: args.priority,
            status: args.status,
            description: args.description,
            parent_id: args.parent_id,
            estimate: args.estimate,
            due_date: args.due_date,
            start_date: args.start_date,
            tags: Some(&tags),
            assignee: args.assignee,
            acceptance_criteria: args.acceptance_criteria.as_deref(),
            ..NewTicket::new(args.title)
        };
        match svc_tickets::create_ticket(&session, args.project_id, new).await {
            Ok(ticket) => Ok(Value::Object(ticket_to_dict(ticket, false)?)),
            Err(svc_tickets::Error::NoResult(_)) => Err(ToolError::Value(format!(
                "Project not found: {}. Use get_projects to see project ids.",
                args.project_id
            ))),
            Err(err) => Err(err.into()),
        }
    })
    .await
}

/// `datetime.fromisoformat(text)` of Python 3.12 as a UTC instant (a time without an offset is read as UTC).
fn from_isoformat(text: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    time::parse_iso(text).map(|moment| moment.utc())
}

/// `_parse_since`.
fn parse_since(value: &str) -> Result<chrono::DateTime<chrono::Utc>, ToolError> {
    let text = kb_base::pytext::strip(value).replace('Z', "+00:00");
    match from_isoformat(&text) {
        Some(moment) => Ok(moment),
        None => Err(ToolError::Value(format!(
            "activity_since must be an ISO date or time such as '2026-10-05T08:00:00Z' (got '{value}')."
        ))),
    }
}

/// `_entry_time`: when an activity entry happened (`None` where its `at` is not a time).
fn entry_time(entry: &Value) -> Option<chrono::DateTime<chrono::Utc>> {
    // `str(entry.get("at", ""))`
    let at = match entry.get("at") {
        None => String::new(),
        Some(value) => pyjson::py_str(value),
    };
    from_isoformat(&at.replace('Z', "+00:00"))
}

/// How many of the most recent activity entries `get_ticket` returns when `activity_limit` is left out.
pub const DEFAULT_ACTIVITY_ENTRIES: usize = 10;
const HOW_TO_WORK: &str = "Before you work on this ticket, read docs_read(action='ticket_guide') (criteria, \
     sub-tickets, work log, comments, evidence, where files go) and docs_read(action='guides') once: how to work a \
     ticket here, show proof, ask, brainstorm, check your work as its user would, and make office files.";
const ACTIVITY_TEXT_CLIP: usize = 300;

/// Description edits store the whole old and new text; for a quick look the start of each is enough.
fn clip_activity(entries: Vec<Value>) -> Vec<Value> {
    entries
        .into_iter()
        .map(|mut entry| {
            if let Value::Object(map) = &mut entry {
                for key in ["from", "to"] {
                    if let Some(Value::String(text)) = map.get(key) {
                        let length = text.chars().count();
                        if length > ACTIVITY_TEXT_CLIP {
                            let clipped: String = text.chars().take(ACTIVITY_TEXT_CLIP).collect();
                            let shown = format!("{clipped}… [{} more chars]", length - ACTIVITY_TEXT_CLIP);
                            map.insert(key.to_string(), Value::String(shown));
                        }
                    }
                }
            }
            entry
        })
        .collect()
}

static UPLOAD_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"/uploads/[^\s)"'\]<>\\|?#]{1,300}"#).expect("a fixed pattern"));

/// Every /uploads/ file the ticket mentions (description, comments, work log, attachments) with its absolute path
/// on disk.
fn upload_files(data: &Map<String, Value>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let dumped = pyjson::dumps(&Value::Object(data.clone()));
    for found in UPLOAD_URL.find_iter(&dumped) {
        let url = found.as_str();
        if !seen.insert(url.to_string()) {
            continue;
        }
        let resolved = kb_files::uploads::resolve_upload_path(&url["/uploads/".len()..]);
        out.push(json!({
            "url": url,
            "path": resolved.as_ref().map(|p| p.to_string_lossy().into_owned()),
            "exists": resolved.as_ref().is_some_and(|p| p.is_file()),
        }));
    }
    out
}

/// The arguments of `get_ticket`.
#[derive(Debug, Clone)]
pub struct GetTicket<'a> {
    pub ticket_id: &'a str,
    pub view: &'a str,
    pub activity_limit: Option<i64>,
    pub activity_since: Option<&'a str>,
    pub comment_ids: Option<Vec<String>>,
}

/// Get one ticket in full: Markdown description, acceptance criteria, test cases, comments, work log (debug notes),
/// branches, relations (blocks / blocked_by / links).
/// `workspace` {path, exists, files}: its scratch folder now; `worktree` {path, branch, uncommitted, outputs}: the AI
/// team's checkout. Look here before you say where a file is.
/// `docs`: the Docs pages tied to the ticket (its spec, design notes): [{page_id, title, path, sections, why}]; read
/// the ones that matter with docs_read(action='get', page_id) before you work.
/// `files`: uploads the ticket mentions, with absolute `path` to read.
/// `held_by`: who has it now. A comment with `handoff` is a handoff note: read the newest first.
/// Sub-item ids (comment, test case, branch, ...) used by the other tools come from here.
/// `activity_log`: the latest changes (who, what, when); `activity_total`: how many there are in all
/// (activity_limit and activity_since widen or narrow).
/// view='comments': just the thread (oldest first), narrowed by comment_ids.
pub async fn get_ticket(args: GetTicket<'_>) -> ToolResult {
    if args.view == "comments" {
        if args.activity_limit.is_some() || args.activity_since.is_some() {
            return Err(ToolError::value(
                "activity_limit / activity_since apply to view='full' only; view='comments' returns just the \
                 comment thread.",
            ));
        }
        return list_comments(args.ticket_id, args.comment_ids.as_deref(), None).await;
    }
    if args.comment_ids.is_some() {
        return Err(ToolError::value(
            "comment_ids applies to view='comments' only; view='full' returns every comment.",
        ));
    }
    // `if activity_since`: an empty text is none
    let since = match args.activity_since.filter(|s| !s.is_empty()) {
        Some(text) => Some(parse_since(text)?),
        None => None,
    };
    let ticket_id = args.ticket_id;
    let mut data = {
        let session = common::async_session();
        let Some(ticket) = svc_tickets::get_ticket(&session, ticket_id).await? else {
            return Err(missing_ticket(ticket_id));
        };
        let project_id = ticket.project_id.clone();
        let mut data = ticket_to_dict(ticket, true)?;
        let raw_comments: Vec<Value> = match data.get("comments") {
            Some(Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        };
        let viewed = match hooks::ai_ticket_view() {
            Some(view) => view
                .comments_for_caller(&project_id, raw_comments, common::request_authorization().as_deref())
                .await
                .map_err(ToolError::Value)?,
            None => None,
        };
        match viewed {
            // an AI run reads the comments as its prompt would show them
            Some((comments, held_back)) => {
                data.insert("comments".into(), Value::Array(comments));
                if held_back != 0 {
                    data.insert("comments_held_back".into(), json!(held_back));
                }
            }
            // an agent outside a board run has no prompt from the board: it skipped the instructions' mention of
            // the guides, but reads what a tool returns (issue #277)
            None => {
                data.insert("how_to_work".into(), json!(HOW_TO_WORK));
            }
        }
        let files = upload_files(&data);
        if !files.is_empty() {
            data.insert("files".into(), Value::Array(files));
        }
        let workspace = kb_board::workspace::brief(&session, ticket_id, 20)
            .await
            .map_err(|err| ToolError::Other(err.to_string()))?;
        if let Some(workspace) = workspace {
            if pyjson::truthy(&workspace["exists"]) {
                data.insert("workspace".into(), workspace.clone());
                data.insert("workspace_path".into(), workspace["path"].clone());
            } else {
                data.insert("workspace".into(), workspace);
            }
        }
        if let Some(view) = hooks::ai_ticket_view() {
            if let Some(tree) = view.worktree_brief(ticket_id).await.map_err(ToolError::Other)? {
                data.insert("worktree".into(), tree);
            }
        }
        let docs = linked_docs(&session, ticket_id).await;
        if !docs.is_empty() {
            data.insert("docs".into(), Value::Array(docs));
        }
        data
    };
    let mut log: Vec<Value> = match data.get("activity_log") {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    data.insert("activity_total".into(), json!(log.len()));
    if let Some(since) = since {
        log.retain(|entry| entry_time(entry).unwrap_or(since) > since);
    }
    if args.activity_limit.is_some_and(|limit| limit < 0) {
        // everything (after `since`, if given), full texts
        data.insert("activity_log".into(), Value::Array(log));
        return Ok(Value::Object(data));
    }
    let mut limit = args.activity_limit;
    if limit.is_none() && since.is_none() {
        limit = Some(DEFAULT_ACTIVITY_ENTRIES as i64);
    }
    if let Some(limit) = limit {
        log = if limit > 0 {
            let keep = (limit as usize).min(log.len());
            log.split_off(log.len() - keep)
        } else {
            Vec::new()
        };
    }
    data.insert("activity_log".into(), Value::Array(clip_activity(log)));
    Ok(Value::Object(data))
}

/// The Docs pages tied to the ticket (its spec, its design notes), as an agent should read them: a page hidden from
/// AI is left out of an AI run's view. Read one with docs_read(action='get', page_id).
async fn linked_docs(session: &kb_db::Session, ticket_id: &str) -> Vec<Value> {
    // the pages are extra context; the ticket reads without them
    kb_docs::docs::linked_pages(session, ticket_id, Some(&HashSet::new())).await.unwrap_or_default()
}

/// Get (and create if missing) the ticket's local scratch folder. Read and write files there directly with your own
/// file tools: logs, repro scripts, screenshots, drafts. Nothing needs to go through MCP.
/// Returns {enabled, path, exists}. If `enabled` is false the Workspace feature is turned off: do not use it.
pub async fn get_ticket_workspace_path(ticket_id: &str) -> ToolResult {
    let session = common::async_session();
    let info = kb_board::workspace::get_workspace_path(&session, ticket_id, true)
        .await
        .map_err(|err| ToolError::Other(err.to_string()))?;
    info.ok_or_else(|| missing_ticket(ticket_id))
}

/// `TicketUpdate(**data)`.
fn ticket_update(data: Map<String, Value>) -> Result<TicketUpdate, ToolError> {
    serde_json::from_value::<TicketUpdate>(Value::Object(data)).map_err(|err| ToolError::Value(err.to_string()))
}

/// Move a ticket to another status; the usual way to start ('in-progress') or finish ('done') work.
/// Moving to 'done' is refused when the ticket's "Done requires" guards are on and its acceptance criteria / test
/// cases are not all passed (the error says which). 'wont_do' needs a reason and is not allowed for sub-tickets.
/// Returns the updated ticket.
pub async fn update_ticket_status(ticket_id: &str, status: &str, wont_do_reason: Option<&str>) -> ToolResult {
    notify_on_success(async {
        let mut data = Map::new();
        data.insert("status".into(), json!(status));
        hooks::before_ticket_change(ticket_id, Some(status), NewAssignee::Unset, false).await?;
        if let Some(reason) = wont_do_reason {
            data.insert("wont_do_reason".into(), json!(reason));
        }
        let update = ticket_update(data)?;
        edit_ticket(ticket_id, None, |s, _| async move {
            svc_tickets::update_ticket(&s, ticket_id, &update).await.map_err(ToolError::from)
        })
        .await
    })
    .await
}

/// The fields `clear_fields` may name.
const CLEARABLE_FIELDS: [&str; 9] = [
    "assignee",
    "due_date",
    "estimate",
    "parent_id",
    "repo_path",
    "review_requested_from",
    "start_date",
    "wave_pin",
    "wont_do_reason",
];

/// Change one or more fields of a ticket; omitted fields are untouched. Use update_ticket_status for plain status
/// moves and the dedicated tools for comments, criteria, test cases, work log and branches. To empty a nullable
/// field (e.g. unassign), name it in `clear_fields`. Returns the updated ticket.
///
/// `fields` are the parameters that were given (a `None` of Python is left out), in the order of the Python
/// function's `fields` dict.
pub async fn update_ticket(
    ticket_id: &str,
    fields: Map<String, Value>,
    clear_fields: Option<Vec<String>>,
) -> ToolResult {
    notify_on_success(async {
        let mut update_data: Map<String, Value> = fields.into_iter().filter(|(_, v)| !v.is_null()).collect();
        for name in clear_fields.unwrap_or_default() {
            if !CLEARABLE_FIELDS.contains(&name.as_str()) {
                let sorted: Vec<Value> = CLEARABLE_FIELDS.iter().map(|f| json!(f)).collect();
                return Err(ToolError::Value(format!(
                    "Cannot clear '{name}'. Clearable fields: {}",
                    pyjson::py_str(&Value::Array(sorted))
                )));
            }
            if update_data.contains_key(&name) {
                return Err(ToolError::Value(format!("'{name}' was both set and listed in clear_fields")));
            }
            update_data.insert(name, Value::Null);
        }
        let assignee = match update_data.get("assignee") {
            Some(value) => NewAssignee::To(value.as_str()),
            None => NewAssignee::Unset,
        };
        let status = update_data.get("status").and_then(Value::as_str);
        hooks::before_ticket_change(ticket_id, status, assignee, false).await?;
        let new_assignee =
            update_data.get("assignee").and_then(Value::as_str).filter(|a| !a.is_empty()).map(str::to_string);
        let update = ticket_update(update_data)?;
        let out = edit_ticket(ticket_id, None, |s, _| async move {
            svc_tickets::update_ticket(&s, ticket_id, &update).await.map_err(ToolError::from)
        })
        .await?;
        if let Some(assignee) = new_assignee {
            // an AI that gives a ticket to another AI has handed it over: the receiver is started
            hooks::wake_new_assignee(ticket_id, &assignee).await?;
        }
        Ok(out)
    })
    .await
}

/// Create a sub-ticket under an existing ticket, in the same project (starts in 'backlog'). One level of
/// nesting is allowed, two under a Story (Story > ticket > sub-ticket). Returns the new ticket.
pub async fn create_child_ticket(
    parent_ticket_id: &str,
    title: &str,
    r#type: &str,
    priority: &str,
    description: &str,
) -> ToolResult {
    notify_on_success(async {
        let session = common::async_session();
        let Some(parent) = svc_tickets::get_ticket(&session, parent_ticket_id).await? else {
            return Err(missing_ticket(parent_ticket_id));
        };
        let new =
            NewTicket { parent_id: Some(parent_ticket_id), r#type, priority, description, ..NewTicket::new(title) };
        let ticket = svc_tickets::create_ticket(&session, &parent.project_id, new).await?;
        Ok(Value::Object(ticket_to_dict(ticket, false)?))
    })
    .await
}

/// PERMANENTLY delete a ticket (cannot be undone). Its sub-tickets are detached (kept), block/link references on
/// other tickets are removed, and its workspace folder is deleted. To retire a ticket but keep its history use
/// update_ticket_status(status='wont_do', wont_do_reason=...) instead. Returns {"deleted": ticket_id}.
pub async fn delete_ticket(ticket_id: &str) -> ToolResult {
    notify_on_success(async {
        hooks::before_ticket_change(ticket_id, None, NewAssignee::Unset, true).await?;
        let found = {
            let session = common::async_session();
            svc_tickets::delete_ticket(&session, ticket_id).await?
        };
        if !found {
            return Err(missing_ticket(ticket_id));
        }
        Ok(json!({"deleted": ticket_id}))
    })
    .await
}

/// Reopen a ticket that is 'done' or 'wont_do': it moves to 'todo', its reopen count goes up and the reopen is added
/// to its history. Refused for tickets in any other status. Returns the updated ticket.
pub async fn reopen_ticket(
    ticket_id: &str,
    reason: Option<&str>,
    reset_ac: bool,
    reset_tests: bool,
    unassign: bool,
    reopen_parent: bool,
) -> ToolResult {
    notify_on_success(edit_ticket(ticket_id, None, |s, _| async move {
        let options = ReopenOptions {
            reason,
            reset_ac,
            reset_tests,
            unassign,
            reopen_parent,
            actor: Some(activity::AGENT_ACTOR),
        };
        svc_tickets::reopen_ticket(&s, ticket_id, options).await.map_err(ToolError::from)
    }))
    .await
}

/// Flag a ticket as Pending: parked while it waits on a ticket, a person or an outside party. Its status and column
/// do not change. Not allowed for 'done' / 'wont_do' tickets. Returns the updated ticket.
pub async fn set_ticket_pending(
    ticket_id: &str,
    reason_type: &str,
    target_ticket_id: Option<&str>,
    member_id: Option<&str>,
    party: Option<&str>,
    note: Option<&str>,
    add_blocked_by: bool,
) -> ToolResult {
    notify_on_success(edit_ticket(ticket_id, None, |s, _| async move {
        let reason = PendingReason {
            ticket_target_id: target_ticket_id,
            member_id,
            party,
            note,
            add_blocked_by,
            actor: Some(activity::AGENT_ACTOR),
            ..PendingReason::new(reason_type)
        };
        svc_tickets::set_pending(&s, ticket_id, reason).await.map_err(ToolError::from)
    }))
    .await
}

/// Clear the Pending flag of a ticket. A ticket that is not pending is returned unchanged. Returns the updated ticket.
pub async fn resume_ticket(ticket_id: &str, reason: Option<&str>, add_comment: bool) -> ToolResult {
    notify_on_success(edit_ticket(ticket_id, None, |s, _| async move {
        svc_tickets::clear_pending(&s, ticket_id, reason, add_comment, Some(activity::AGENT_ACTOR))
            .await
            .map_err(ToolError::from)
    }))
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_date_and_a_time_may_be_separated_by_any_character() {
        // `datetime.fromisoformat("2000-01-01+00:00")` is midnight: the `+` is the separator
        let midnight = from_isoformat("2000-01-01").expect("a date");
        assert_eq!(from_isoformat("2000-01-01+00:00"), Some(midnight));
        assert_eq!(from_isoformat("2000-01-01T00:00:00"), Some(midnight));
        assert_eq!(from_isoformat("2000-01-01T07:00:00+07:00"), Some(midnight));
        assert_eq!(from_isoformat("2000-01-01 00:00:00.000"), Some(midnight));
        assert_eq!(from_isoformat("yesterday"), None);
        assert_eq!(from_isoformat("2000-01-01"), Some(midnight));
        assert_eq!(from_isoformat("2000-13-01"), None);
        // a multi-byte character in the separator's place is not a time
        assert_eq!(from_isoformat("2000-01-01éé"), None);
    }

    #[test]
    fn since_is_read_as_the_server_reads_it() {
        assert_eq!(parse_since(" 2000-01-01Z "), Ok(from_isoformat("2000-01-01").expect("a date")));
        let refused = parse_since("yesterday").expect_err("not a time");
        assert_eq!(
            refused.message(),
            "activity_since must be an ISO date or time such as '2026-10-05T08:00:00Z' (got 'yesterday')."
        );
    }

    #[test]
    fn the_start_of_a_long_edit_is_enough() {
        let long = "x".repeat(305);
        let clipped = clip_activity(vec![json!({"field": "description", "from": "short", "to": long}), json!("text")]);
        assert_eq!(clipped[0]["from"], "short");
        assert_eq!(clipped[0]["to"], format!("{}… [5 more chars]", "x".repeat(300)));
        assert_eq!(clipped[1], "text");
    }

    #[test]
    fn the_uploads_of_a_ticket_are_found_in_its_json() {
        let data = json!({"description": "![a](/uploads/a-1.png) and [b](/uploads/b.pdf), again /uploads/a-1.png?x=1"});
        let dumped = pyjson::dumps(&data);
        let found: Vec<&str> = UPLOAD_URL.find_iter(&dumped).map(|m| m.as_str()).collect();
        assert_eq!(found, ["/uploads/a-1.png", "/uploads/b.pdf", "/uploads/a-1.png"]);
    }
}
