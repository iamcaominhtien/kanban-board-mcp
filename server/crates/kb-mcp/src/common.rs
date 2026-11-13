//! Shared by the MCP operations and tools: output shaping, errors, and the change hook.
//!
//! Conventions (kept in sync with the server `instructions` in `instructions.rs`):
//! - Errors are returned as `ToolError` (the client sees `isError: true` plus a message that says how to fix the
//!   call); operations never return `null` or `{"error": ...}` for a failure.
//! - Operations that change a ticket return the updated ticket *without* its activity log.
//! - Every changing operation is attributed to the AI agent in the Activity tab (`notify_on_success`).
//!
//! The parameter types of the Python module (`ProjectId`, `TicketId`, the `Literal`s) are the tools' input schemas
//! here (`contract/mcp-tools.json`), which `validation` enforces; the lists of allowed values an operation checks
//! itself are kept below.

use std::collections::{BTreeSet, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex};

use kb_base::{activity, ctx, events, pyjson, time};
use kb_board::schemas::TicketRead;
use kb_board::tickets as svc_tickets;
use kb_db::Session;
use kb_db::entities::{ai_team, ai_worktree, ticket};
use kb_db::sea_orm::{DbErr, EntityTrait};
use serde_json::{Map, Value, json};

use crate::hooks::{self, GuardedCall, RunContext};

/// Why a tool call failed. The text is what the agent reads after `Error executing tool <name>: `.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolError {
    /// `ValueError`: a bad call, refused on purpose ("ticket not found"); logged as a warning.
    Value(String),
    /// Anything else raised inside a tool: a bug or a failing database; logged as an error.
    Other(String),
}

impl ToolError {
    /// `ValueError(message)`.
    pub fn value(message: impl Into<String>) -> Self {
        ToolError::Value(message.into())
    }

    /// `str(exc)`.
    pub fn message(&self) -> &str {
        match self {
            ToolError::Value(message) | ToolError::Other(message) => message,
        }
    }
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for ToolError {}

impl From<DbErr> for ToolError {
    fn from(err: DbErr) -> Self {
        ToolError::Other(err.to_string())
    }
}

impl From<serde_json::Error> for ToolError {
    fn from(err: serde_json::Error) -> Self {
        ToolError::Other(err.to_string())
    }
}

impl From<svc_tickets::Error> for ToolError {
    fn from(err: svc_tickets::Error) -> Self {
        match err {
            svc_tickets::Error::Value(message) => ToolError::Value(message),
            svc_tickets::Error::NoResult(message) | svc_tickets::Error::Other(message) => ToolError::Other(message),
            svc_tickets::Error::Db(err) => err.into(),
        }
    }
}

/// What a tool or an operation returns: the value FastMCP turns into the result's content.
pub type ToolResult = Result<Value, ToolError>;

/// A database session. Looked up on every call so a re-initialised database is picked up.
pub fn async_session() -> Session {
    kb_db::session()
}

// ---------------------------------------------------------------------------
// The request behind a call, and the AI run it may come from
// ---------------------------------------------------------------------------

/// The `Authorization` header of the HTTP request being handled (set by the HTTP transport; absent over stdio).
#[derive(Debug, Clone, Default)]
pub struct RequestAuthorization(pub Option<String>);

/// The `Authorization` header of the request being handled, as it was sent.
pub fn request_authorization() -> Option<String> {
    ctx::get::<RequestAuthorization>().and_then(|a| a.0)
}

/// The run token in an `Authorization` header (`Bearer kbr_…`, the word in any case), when it holds one.
pub fn request_token_of(auth: &str) -> Option<String> {
    if !auth.to_lowercase().starts_with("bearer kbr_") {
        return None;
    }
    // `auth.split(None, 1)[1].strip()`
    let rest = kb_base::pytext::strip(auth);
    let after = rest.find(kb_base::pytext::is_space).map(|at| &rest[at..]).unwrap_or_default();
    Some(kb_base::pytext::strip(after).to_string())
}

/// `guard._request_token()`: the run token of the current MCP request (`Authorization: Bearer kbr_…`).
pub fn request_token() -> Option<String> {
    request_token_of(&request_authorization().unwrap_or_default())
}

/// `guard.resolve()`: the AI run making this call, or `None` for a person or another client.
pub async fn resolve() -> Result<Option<RunContext>, ToolError> {
    match hooks::ai_guard() {
        Some(guard) => guard.resolve(request_authorization().as_deref()).await.map_err(ToolError::Value),
        None => Ok(None),
    }
}

/// `guard.guarded(tool, action, given, call)`: run `call(given)`, attributed to the AI run the call comes from.
pub async fn guarded(tool: &str, action: &str, given: Map<String, Value>, call: GuardedCall) -> ToolResult {
    match hooks::ai_guard() {
        Some(guard) => guard.guarded(tool, action, given, request_authorization().as_deref(), call).await,
        None => call(given).await,
    }
}

/// `os.path.expanduser(path)` as text.
fn expanduser(path: &str) -> String {
    kb_base::config::expanduser(path).to_string_lossy().into_owned()
}

/// The working folders of the AI run making this call, the one it works in first (None for a person or another
/// client): the ticket's worktree when the board made one, then the member's own folder, then the ticket's
/// Workspace. A run in a worktree saves its screenshots there, so looking only in the member's folder refused files
/// that were where they should be.
pub async fn run_folder() -> Result<Option<Vec<String>>, ToolError> {
    let Some(run) = resolve().await? else {
        return Ok(None);
    };
    // `if ctx.ticket_id:`
    let ticket_id = run.ticket_id.as_deref().filter(|id| !id.is_empty());
    let mut folders: Vec<String> = Vec::new();
    let member = {
        let session = async_session();
        let member = ai_team::Entity::find_by_id(run.member_id.as_str()).one(&session).await?;
        if let Some(ticket_id) = ticket_id {
            // `worktrees.for_ticket(session, ticket_id)`: the worktree's row is keyed by the ticket
            let tree = ai_worktree::Entity::find_by_id(ticket_id).one(&session).await?;
            if let Some(tree) = tree {
                if ["active", "conflict", "kept"].contains(&tree.state.as_str())
                    && !tree.path.is_empty()
                    && std::path::Path::new(&tree.path).is_dir()
                {
                    folders.push(tree.path);
                }
            }
        }
        member
    };
    let main = member.and_then(|m| m.working_dir).map(|dir| expanduser(&dir)).unwrap_or_default();
    if !main.is_empty() {
        folders.push(main);
    }
    if let Some(ticket_id) = ticket_id.filter(|_| !folders.is_empty()) {
        // the ticket's Workspace, where a run keeps the outputs a person should see (issue #269)
        let session = async_session();
        let ws = kb_board::workspace::get_workspace_path(&session, ticket_id, false)
            .await
            .map_err(|err| ToolError::Other(format!("{err:?}")))?;
        if let Some(ws) = ws {
            if pyjson::truthy(&ws["enabled"]) && pyjson::truthy(&ws["exists"]) {
                folders.push(ws["path"].as_str().unwrap_or_default().to_string());
            }
        }
    }
    Ok((!folders.is_empty()).then_some(folders))
}

/// Where the caller's files may be attached from: an AI run's working folders; for an agent outside any board run
/// (only the MCP server, on this computer) any absolute path, as `docs_write(import)` reads (keys, `.env` and dot
/// folders stay refused, `kb_board::proofs`); None for a run with no folder at all.
pub async fn attach_folder() -> Result<Option<Vec<String>>, ToolError> {
    if resolve().await?.is_none() {
        return Ok(Some(vec![kb_board::proofs::OUTSIDE_RUN.to_string()]));
    }
    run_folder().await
}

/// `markdown` written by an AI with the pictures, and the documents it links (an Excel sheet, a PDF), named by a
/// path in its working folder (outside a board run: an absolute path) copied into the board, as on a Docs page
/// (`kb_board::proofs`). What `current` (the text being replaced) already named stays as written.
pub async fn attach_from_run(markdown: Option<&str>, current: Option<&str>) -> Result<Option<String>, ToolError> {
    let Some(text) = markdown.filter(|m| !m.is_empty() && m.contains("](")) else {
        return Ok(markdown.map(str::to_string));
    };
    let Some(folder) = attach_folder().await? else {
        return Ok(Some(text.to_string()));
    };
    let keep: HashSet<String> = match current.filter(|c| !c.is_empty()) {
        Some(current) => kb_board::proofs::targets(Some(current)).into_iter().collect(),
        None => HashSet::new(),
    };
    kb_board::proofs::localize(Some(text), &folder, true, &keep).await.map_err(|err| ToolError::Value(err.0))
}

// ---------------------------------------------------------------------------
// Allowed values (the `Literal`s of the Python module)
// ---------------------------------------------------------------------------

pub const TICKET_TYPES: [&str; 5] = ["bug", "feature", "task", "chore", "story"];
pub const PRIORITIES: [&str; 4] = ["low", "medium", "high", "critical"];
pub const STATUSES: [&str; 7] = ["backlog", "todo", "in-progress", "review", "testing", "done", "wont_do"];
pub const WORK_LOG_KINDS: [&str; 5] = ["investigation", "fix_attempt", "root_cause", "blocked", "resolved"];
pub const WORK_LOG_ROLES: [&str; 6] = ["PM", "Developer", "BA", "Tester", "Designer", "Other"];
pub const TEST_CASE_STATUSES: [&str; 4] = ["pending", "running", "pass", "fail"];
pub const BRANCH_STATUSES: [&str; 5] = ["baseline", "open", "merged", "stale", "archived"];
pub const RELATION_TYPES: [&str; 5] = ["relates_to", "causes", "caused_by", "duplicates", "duplicated_by"];

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/// A text argument (`None` when left out or null).
pub fn arg_str(args: &Map<String, Value>, name: &str) -> Option<String> {
    args.get(name).and_then(Value::as_str).map(str::to_string)
}

/// A boolean argument (`None` when left out or null).
pub fn arg_bool(args: &Map<String, Value>, name: &str) -> Option<bool> {
    args.get(name).and_then(Value::as_bool)
}

/// An integer argument (`None` when left out or null).
pub fn arg_int(args: &Map<String, Value>, name: &str) -> Option<i64> {
    args.get(name).and_then(Value::as_i64)
}

/// A number argument (`None` when left out or null).
pub fn arg_f64(args: &Map<String, Value>, name: &str) -> Option<f64> {
    args.get(name).and_then(Value::as_f64)
}

/// A list argument as it came (`None` when left out or null).
pub fn arg_list(args: &Map<String, Value>, name: &str) -> Option<Vec<Value>> {
    args.get(name).and_then(Value::as_array).cloned()
}

/// A list of texts argument (`None` when left out or null).
pub fn arg_strings(args: &Map<String, Value>, name: &str) -> Option<Vec<String>> {
    args.get(name)
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
}

/// A text argument the caller has made sure is there (a required parameter after validation); empty otherwise.
pub fn arg_text(args: &Map<String, Value>, name: &str) -> String {
    arg_str(args, name).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Output shaping and errors
// ---------------------------------------------------------------------------

/// `camelCase` to `snake_case`: an underscore before each capital that follows a lower-case letter or a digit.
pub(crate) fn snake(key: &str) -> String {
    let mut out = String::with_capacity(key.len() + 4);
    let mut previous: Option<char> = None;
    for c in key.chars() {
        if c.is_ascii_uppercase() && previous.is_some_and(|p| p.is_ascii_lowercase() || p.is_ascii_digit()) {
            out.push('_');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
        previous = Some(c);
    }
    out
}

/// Stored sub-items carry both snake_case and camelCase copies of each key (for the web UI). The AI only needs one
/// of them.
pub(crate) fn drop_camel_twins(items: &[Value]) -> Vec<Value> {
    items
        .iter()
        .map(|item| match item {
            Value::Object(map) => Value::Object(
                map.iter()
                    .filter(|(k, _)| {
                        let snake = snake(k);
                        !(**k != snake && map.contains_key(&snake))
                    })
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect(),
            ),
            other => other.clone(),
        })
        .collect()
}

const SUB_ITEM_FIELDS: [&str; 5] = ["branches", "test_cases", "work_log", "comments", "links"];

/// Serialize a ticket. The activity log is ~80% of a typical ticket's size, so it is opt-in.
pub fn ticket_to_dict(ticket: ticket::Model, include_activity: bool) -> Result<Map<String, Value>, ToolError> {
    let read = TicketRead::from_ticket(ticket)?;
    let Value::Object(mut data) = serde_json::to_value(read)? else {
        return Err(ToolError::Other("a ticket is an object".to_string()));
    };
    if !include_activity {
        data.shift_remove("activity_log");
    }
    for field in SUB_ITEM_FIELDS {
        if let Some(Value::Array(items)) = data.get(field) {
            let kept = drop_camel_twins(items);
            data.insert(field.to_string(), Value::Array(kept));
        }
    }
    Ok(data)
}

/// `_loads`: a JSON column as a list (empty when it is not one).
pub fn loads(value: &str) -> Vec<Value> {
    if value.is_empty() {
        return Vec::new();
    }
    match serde_json::from_str::<Value>(value) {
        Ok(Value::Array(items)) => items,
        _ => Vec::new(),
    }
}

/// The few fields needed to triage a list of tickets.
pub fn ticket_summary(ticket: &ticket::Model) -> Value {
    let acs = loads(&ticket.acceptance_criteria);
    let tcs = loads(&ticket.test_cases);
    json!({
        "id": ticket.id,
        "title": ticket.title,
        "type": ticket.r#type,
        "status": ticket.status,
        "priority": ticket.priority,
        "assignee": ticket.assignee,
        "parent_id": ticket.parent_id,
        "tags": loads(&ticket.tags),
        "estimate": ticket.estimate,
        "start_date": ticket.start_date,
        "due_date": ticket.due_date,
        "blocked_by": loads(&ticket.blocked_by),
        "wave_pin": ticket.wave_pin,
        "pending": ticket.pending,
        "reopen_count": ticket.reopen_count,
        "acceptance_criteria": {
            "done": acs.iter().filter(|a| a.get("done").is_some_and(pyjson::truthy)).count(),
            "total": acs.len(),
        },
        "test_cases": {
            "passed": tcs.iter().filter(|t| t.get("status").and_then(Value::as_str) == Some("pass")).count(),
            "total": tcs.len(),
        },
        "comments": loads(&ticket.comments).len(),
        "branches": loads(&ticket.branches).len(),
        "updated_at": ticket.updated_at,
    })
}

/// `datetime.now(timezone.utc).isoformat()`.
pub fn now_iso() -> String {
    time::now_iso()
}

/// The error for a ticket id that names no ticket.
pub fn missing_ticket(ticket_id: &str) -> ToolError {
    ToolError::Value(format!(
        "Ticket '{ticket_id}' not found. Ticket IDs look like 'IAM-12' (project prefix + number); use list_tickets to \
         see the IDs of a project."
    ))
}

/// The error for an idea id that names no idea.
pub fn missing_idea(ticket_id: &str) -> ToolError {
    ToolError::Value(format!(
        "Idea ticket '{ticket_id}' not found. Idea IDs look like 'IDEA-3'; use list_idea_tickets to see them."
    ))
}

/// For each sub-item list: the ticket column, a label for messages, and which keys may identify an item.
fn item_kind(kind: &str) -> Option<(&'static str, &'static str, &'static [&'static str])> {
    Some(match kind {
        "comment" => ("comments", "Comment", &["id"]),
        "criterion" => ("acceptance_criteria", "Acceptance criterion", &["id"]),
        "sub_task" => ("sub_tasks", "Sub-task", &["id"]),
        "work_log" => ("work_log", "Work log entry", &["id"]),
        "test_case" => ("test_cases", "Test case", &["id", "code"]),
        "branch" => ("branches", "Branch", &["id", "name"]),
        _ => return None,
    })
}

/// Check that `reference` names an existing sub-item of the ticket and return its real id. Lets the call fail with
/// the list of valid ids instead of silently doing nothing.
pub async fn resolve_item(
    session: &Session,
    ticket_id: &str,
    kind: &str,
    reference: &str,
) -> Result<String, ToolError> {
    let (column, label, keys) = item_kind(kind).ok_or_else(|| ToolError::Other(format!("'{kind}'")))?;
    let Some(ticket) = svc_tickets::get_ticket(session, ticket_id).await? else {
        return Err(missing_ticket(ticket_id));
    };
    let stored = match column {
        "comments" => &ticket.comments,
        "acceptance_criteria" => &ticket.acceptance_criteria,
        "sub_tasks" => &ticket.sub_tasks,
        "work_log" => &ticket.work_log,
        "test_cases" => &ticket.test_cases,
        _ => &ticket.branches,
    };
    let items = loads(stored);
    for item in &items {
        if keys.iter().any(|k| item.get(*k).and_then(Value::as_str) == Some(reference)) {
            return Ok(item.get("id").and_then(Value::as_str).unwrap_or_default().to_string());
        }
    }
    let shown_key = if matches!(kind, "test_case" | "branch") { keys[keys.len() - 1] } else { "id" };
    let existing: Vec<String> =
        items.iter().take(20).map(|item| pyjson::py_str(item.get(shown_key).unwrap_or(&Value::Null))).collect();
    let shown = if existing.is_empty() { "none".to_string() } else { existing.join(", ") };
    Err(ToolError::Value(format!(
        "{label} '{reference}' not found on {ticket_id}. Existing: {shown}. Call get_ticket('{ticket_id}') to see the \
         ids."
    )))
}

/// Run a service call that returns the updated ticket and serialize it. `item = (kind, reference)` first verifies
/// and resolves a sub-item reference; `op(session, Some(item_id))` then gets its id.
pub async fn edit_ticket<F, Fut>(ticket_id: &str, item: Option<(&str, &str)>, op: F) -> ToolResult
where
    F: FnOnce(Session, Option<String>) -> Fut,
    Fut: Future<Output = Result<Option<ticket::Model>, ToolError>>,
{
    let session = async_session();
    let item_id = match item {
        Some((kind, reference)) => Some(resolve_item(&session, ticket_id, kind, reference).await?),
        None => None,
    };
    let Some(ticket) = op(session, item_id).await? else {
        return Err(missing_ticket(ticket_id));
    };
    Ok(Value::Object(ticket_to_dict(ticket, false)?))
}

/// The tables a tool's commits wrote (`kb_db::changes` tells each write's), to say what changed in its announcement
/// (`_written`; unset outside a tool).
#[derive(Clone, Default)]
struct Written(Arc<Mutex<BTreeSet<String>>>);

fn note_written(tables: &BTreeSet<String>) {
    if let Some(Written(written)) = ctx::get::<Written>() {
        written.lock().unwrap_or_else(|e| e.into_inner()).extend(tables.iter().cloned());
    }
}

/// `changes.on_write_commit(_note_written)`, which Python runs when this module is imported: every process that
/// serves MCP tools calls it at startup (a second call changes nothing).
pub fn install_write_listener() {
    kb_db::changes::on_write_commit("mcp_tool_written", note_written);
}

/// What the app refetches for a table (`ui/src/hooks/invalidationTopics.ts`). A ticket holds its comments, criteria,
/// sub-tasks and logs; its text can name Docs pages, so the pages a ticket names and the backlinks follow it.
const TABLE_TOPICS: [(&str, &[&str]); 5] = [
    ("ticket", &["tickets", "ticket_docs"]),
    // the notification centre announces its own changes (topic "notifications")
    ("notification", &[]),
    ("notify_event", &[]),
    ("notify_follow", &[]),
    ("ai_audit", &[]),
];
const DOCS_PREFIXES: [&str; 3] = ["docs_", "canvas", "diagram"];

/// The topics of an announcement for a change of these tables; `None` when one of them has no topic (refetch all).
pub fn topics_for<'a>(tables: impl IntoIterator<Item = &'a str>) -> Option<BTreeSet<&'static str>> {
    let mut topics = BTreeSet::new();
    for table in tables {
        if let Some((_, named)) = TABLE_TOPICS.iter().find(|(name, _)| *name == table) {
            topics.extend(named.iter().copied());
        } else if DOCS_PREFIXES.iter().any(|prefix| table.starts_with(prefix)) {
            topics.insert("docs");
        } else {
            return None;
        }
    }
    Some(topics)
}

/// Attribute the change to the AI agent and publish an SSE invalidation after a successful mutation. (The Python
/// decorator; here it wraps the operation's body.)
///
/// The invalidation names what the tool wrote (the tables of its commits), so the board refetches only that: with ten
/// AIs at work, a plain invalidation from every call refetched every list of the board a few times a second. A tool
/// that wrote a table without a topic, or nothing the commits saw, announces a plain one, as before.
pub async fn notify_on_success<Fut>(operation: Fut) -> ToolResult
where
    Fut: Future<Output = ToolResult>,
{
    // Changes made through MCP tools are attributed to the AI agent (by name when it is a board AI member's run)
    let ai = activity::current_ai();
    let member_name =
        ai.as_ref().and_then(|ai| ai.get("member_name")).and_then(Value::as_str).filter(|n| !n.is_empty());
    let token = activity::set_actor(Some(member_name.unwrap_or(activity::AGENT_ACTOR)));
    let written = Written::default();
    let seen = ctx::set(written.clone());
    let result = operation.await;
    ctx::reset(seen);
    ctx::reset(token);
    let result = result?;
    if !result.is_null() {
        let written = written.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let topics = if written.is_empty() { None } else { topics_for(written.iter().map(String::as_str)) };
        match topics {
            None => events::publish(events::INVALIDATE, &[]).await,
            Some(topics) if !topics.is_empty() => {
                let topics: Vec<&str> = topics.into_iter().collect();
                events::publish(events::INVALIDATE, &topics).await;
            }
            Some(_) => events::mark_announced(),
        }
    }
    Ok(result)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn camel_twins_are_dropped() {
        assert_eq!(snake("createdAt"), "created_at");
        assert_eq!(snake("worktreePath2X"), "worktree_path2_x");
        assert_eq!(snake("URL"), "URL");
        let items = [json!({"id": "1", "created_at": "t", "createdAt": "t", "onlyCamel": 1}), json!("text")];
        assert_eq!(drop_camel_twins(&items), [json!({"id": "1", "created_at": "t", "onlyCamel": 1}), json!("text")]);
    }

    #[tokio::test]
    async fn the_run_token_is_read_from_the_authorization_header() {
        ctx::scope(async {
            assert_eq!(request_token(), None);
            let _t = ctx::set(RequestAuthorization(Some("Bearer kbr_abc ".to_string())));
            assert_eq!(request_token().as_deref(), Some("kbr_abc"));
            let _t = ctx::set(RequestAuthorization(Some("bearer KBR_x".to_string())));
            assert_eq!(request_token().as_deref(), Some("KBR_x"));
            let _t = ctx::set(RequestAuthorization(Some("Bearer other".to_string())));
            assert_eq!(request_token(), None);
        })
        .await;
    }

    /// The tests that count what was published, and those that publish (a tool call through `notify_on_success`),
    /// take turns: they share the process's one event bus.
    pub(crate) static TURN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// `test_an_mcp_tool_announces_what_it_wrote` (tests/test_runner_announcements.py): an MCP mutation names the
    /// tables it wrote: a ticket refetches the tickets and the Docs a ticket reaches, a table with no topic
    /// everything, and a write the app does not show nothing.
    #[tokio::test]
    async fn test_an_mcp_tool_announces_what_it_wrote() {
        let _turn = TURN.lock().await;
        install_write_listener();
        let dir = std::env::temp_dir().join(format!("kb-mcp-written-{}", time::uuid4_hex()));
        std::fs::create_dir_all(&dir).expect("a folder");
        let target = kb_db::targets::Target::sqlite(dir.join("mcp.db").to_string_lossy().into_owned());
        let engine = kb_db::targets::make_engine(&target, None).await.expect("an engine");
        for table in ["ticket", "project", "notification"] {
            kb_db::sea_orm::ConnectionTrait::execute_unprepared(&engine, &format!("CREATE TABLE {table} (id TEXT)"))
                .await
                .expect("a table");
        }
        let tool = |table: &'static str| {
            let engine = engine.clone();
            ctx::scope(notify_on_success(async move {
                let session = Session::new(engine);
                let insert = kb_db::sea_orm::Statement::from_string(
                    kb_db::sea_orm::DbBackend::Sqlite,
                    format!("INSERT INTO \"{table}\" VALUES ('1')"),
                );
                kb_db::sea_orm::ConnectionTrait::execute_raw(&session, insert)
                    .await
                    .map_err(|e| ToolError::Other(e.to_string()))?;
                session.commit().await.map_err(|e| ToolError::Other(e.to_string()))?;
                Ok(json!({"ok": true}))
            }))
        };
        let q = events::subscribe();
        tool("ticket").await.expect("written");
        assert_eq!(q.try_recv().as_deref(), Some(r#"{"type": "invalidate", "topics": ["ticket_docs", "tickets"]}"#));
        tool("project").await.expect("written");
        assert_eq!(q.try_recv().as_deref(), Some("invalidate"));
        let published = events::published();
        tool("notification").await.expect("written");
        assert_eq!(q.try_recv(), None);
        assert_eq!(events::published(), published + 1);
        events::unsubscribe(&q);
        assert_eq!(topics_for(["docs_page", "docs_version"]), Some(BTreeSet::from(["docs"])));
        assert_eq!(topics_for(["*"]), None);
        assert_eq!(topics_for(["canvas_frame", "diagram"]), Some(BTreeSet::from(["docs"])));
        drop(engine);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_change_is_attributed_to_the_agent_and_announced() {
        let _turn = TURN.lock().await;
        ctx::scope(async {
            let _user = activity::set_actor(Some("Tien"));
            let before = events::published();
            let seen = notify_on_success(async { Ok(json!(activity::current_actor())) }).await;
            assert_eq!(seen, Ok(json!("agent")));
            assert_eq!(events::published(), before + 1);
            assert_eq!(activity::current_actor(), "Tien");
            // a board AI member's run: its name; a failure announces nothing
            let _ai = activity::set_ai(Some(json!({"member_id": "m", "member_name": "Dev team"})));
            assert_eq!(notify_on_success(async { Ok(json!(activity::current_actor())) }).await, Ok(json!("Dev team")));
            let before = events::published();
            let failed = notify_on_success(async { Err(ToolError::value("no")) }).await;
            assert_eq!(failed, Err(ToolError::value("no")));
            assert_eq!(notify_on_success(async { Ok(Value::Null) }).await, Ok(Value::Null));
            assert_eq!(events::published(), before);
        })
        .await;
    }
}
