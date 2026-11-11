//! Request and response models of the board's routes (`models.py`, "Request / Response schemas").

use kb_base::pyjson;
use kb_db::entities::{member, project, ticket};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Payload to create a project.
#[derive(Debug, Clone, Deserialize)]
pub struct ProjectCreate {
    pub name: String,
    pub prefix: String,
    pub color: String,
}

/// `Literal["everyone", "members", "admins"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DocsEditPolicy {
    Everyone,
    Members,
    Admins,
}

impl DocsEditPolicy {
    /// The value as it is stored.
    pub fn as_str(self) -> &'static str {
        match self {
            DocsEditPolicy::Everyone => "everyone",
            DocsEditPolicy::Members => "members",
            DocsEditPolicy::Admins => "admins",
        }
    }
}

/// Partial update of a project. A field that is absent or null is left as it is (`exclude_none`).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ProjectUpdate {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    /// empty string clears the link
    #[serde(default)]
    pub repo_path: Option<String>,
    #[serde(default)]
    pub worktree_template: Option<String>,
    #[serde(default)]
    pub worktree_by_default: Option<bool>,
    #[serde(default)]
    pub docs_enabled: Option<bool>,
    #[serde(default)]
    pub docs_edit_policy: Option<DocsEditPolicy>,
}

/// Project as returned by the API.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProjectRead {
    pub id: String,
    pub name: String,
    pub prefix: String,
    pub color: String,
    pub ticket_counter: i32,
    pub repo_path: Option<String>,
    pub worktree_template: Option<String>,
    pub worktree_by_default: bool,
    pub docs_enabled: bool,
    pub docs_edit_policy: String,
}

impl From<project::Model> for ProjectRead {
    /// `ProjectRead.model_validate(project)`.
    fn from(p: project::Model) -> Self {
        Self {
            id: p.id,
            name: p.name,
            prefix: p.prefix,
            color: p.color,
            ticket_counter: p.ticket_counter,
            repo_path: p.repo_path,
            worktree_template: p.worktree_template,
            worktree_by_default: p.worktree_by_default,
            docs_enabled: p.docs_enabled,
            docs_edit_policy: p.docs_edit_policy,
        }
    }
}

fn default_role() -> String {
    "member".to_string()
}

/// Payload to add a member to a project.
#[derive(Debug, Clone, Deserialize)]
pub struct MemberCreate {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default = "default_role")]
    pub role: String,
}

/// Payload to change a member's Docs role.
#[derive(Debug, Clone, Deserialize)]
pub struct MemberRoleUpdate {
    pub role: String,
}

/// Member as returned by the API.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MemberRead {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub color: String,
    pub role: String,
    pub kind: String,
    pub created_at: String,
}

impl From<member::Model> for MemberRead {
    /// `MemberRead.model_validate(member)`.
    fn from(m: member::Model) -> Self {
        Self {
            id: m.id,
            project_id: m.project_id,
            name: m.name,
            color: m.color,
            role: m.role,
            kind: m.kind,
            created_at: m.created_at,
        }
    }
}

/// Partial update of the workspace settings. A field that is absent or null is left as it is.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct WorkspaceSettingsUpdate {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub root_path: Option<String>,
    #[serde(default)]
    pub default_retention_days: Option<i32>,
}

/// `_parse_json_list`: the list a JSON column holds (`[]` for an empty column or JSON that is not a list).
pub fn parse_json_list(text: &str) -> Result<Vec<Value>, serde_json::Error> {
    if text.is_empty() {
        return Ok(Vec::new());
    }
    Ok(match serde_json::from_str::<Value>(text)? {
        Value::Array(items) => items,
        _ => Vec::new(),
    })
}

/// `_completion_of`: when and by whom a closed ticket was closed, from its latest move into Done or Won't Do.
fn completion_of(status: &str, activity_log: &[Value]) -> (Option<String>, Option<String>) {
    if status != "done" && status != "wont_do" {
        return (None, None);
    }
    for entry in activity_log.iter().rev() {
        let Some(entry) = entry.as_object() else { continue };
        if entry.get("field") == Some(&Value::String("status".into())) && entry.get("to") == Some(&json!(status)) {
            let text = |key: &str| entry.get(key).and_then(Value::as_str).map(str::to_string);
            return (text("at"), text("actor"));
        }
    }
    (None, None)
}

/// Ticket as returned by the API, with JSON columns parsed.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TicketRead {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub description: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub status: String,
    pub priority: String,
    pub estimate: Option<f64>,
    pub due_date: Option<String>,
    pub start_date: Option<String>,
    pub tags: Vec<Value>,
    pub parent_id: Option<String>,
    pub comments: Vec<Value>,
    pub acceptance_criteria: Vec<Value>,
    pub sub_tasks: Vec<Value>,
    pub activity_log: Vec<Value>,
    pub work_log: Vec<Value>,
    pub test_cases: Vec<Value>,
    pub wont_do_reason: Option<String>,
    pub created_by: Option<String>,
    pub assignee: Option<String>,
    pub blocks: Vec<Value>,
    pub blocked_by: Vec<Value>,
    pub block_done_if_acs_incomplete: bool,
    pub block_done_if_tcs_incomplete: bool,
    pub links: Vec<Value>,
    pub branches: Vec<Value>,
    pub workspace_retention_days: Option<i32>,
    pub repo_path: Option<String>,
    pub reopen_count: i32,
    pub last_reopened_at: Option<String>,
    pub last_reopened_by: Option<String>,
    pub last_reopen_reason: Option<String>,
    pub reopen_history: Vec<Value>,
    pub pending: bool,
    pub pending_reason_type: Option<String>,
    pub pending_ticket_id: Option<String>,
    pub pending_member_id: Option<String>,
    pub pending_party: Option<String>,
    pub pending_note: Option<String>,
    pub pending_since: Option<String>,
    pub pending_by: Option<String>,
    pub from_idea_id: Option<String>,
    pub tests_assumption_id: Option<String>,
    pub wave_pin: Option<i32>,
    pub review_requested_from: Option<String>,
    pub completed_at: Option<String>,
    pub completed_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl TicketRead {
    /// `TicketRead.from_ticket(ticket)`: build the read model from a stored ticket. A JSON column that does not parse
    /// is the `json.loads` error (a 500).
    pub fn from_ticket(t: ticket::Model) -> Result<Self, serde_json::Error> {
        let activity_log = parse_json_list(&t.activity_log)?;
        let (completed_at, completed_by) = completion_of(&t.status, &activity_log);
        let comments = parse_json_list(&t.comments)?
            .into_iter()
            .filter(|c| !(c.is_object() && c.get("deleted_at").is_some_and(pyjson::truthy)))
            .collect();
        Ok(Self {
            tags: parse_json_list(&t.tags)?,
            comments,
            acceptance_criteria: parse_json_list(&t.acceptance_criteria)?,
            sub_tasks: parse_json_list(&t.sub_tasks)?,
            work_log: parse_json_list(&t.work_log)?,
            test_cases: parse_json_list(&t.test_cases)?,
            blocks: parse_json_list(&t.blocks)?,
            blocked_by: parse_json_list(&t.blocked_by)?,
            links: parse_json_list(&t.links)?,
            branches: parse_json_list(&t.branches)?,
            reopen_history: parse_json_list(&t.reopen_history)?,
            activity_log,
            id: t.id,
            project_id: t.project_id,
            title: t.title,
            description: t.description,
            r#type: t.r#type,
            status: t.status,
            priority: t.priority,
            estimate: t.estimate,
            due_date: t.due_date,
            start_date: t.start_date,
            parent_id: t.parent_id,
            wont_do_reason: t.wont_do_reason,
            created_by: t.created_by,
            assignee: t.assignee,
            block_done_if_acs_incomplete: t.block_done_if_acs_incomplete,
            block_done_if_tcs_incomplete: t.block_done_if_tcs_incomplete,
            workspace_retention_days: t.workspace_retention_days,
            repo_path: t.repo_path,
            reopen_count: t.reopen_count,
            last_reopened_at: t.last_reopened_at,
            last_reopened_by: t.last_reopened_by,
            last_reopen_reason: t.last_reopen_reason,
            pending: t.pending,
            pending_reason_type: t.pending_reason_type,
            pending_ticket_id: t.pending_ticket_id,
            pending_member_id: t.pending_member_id,
            pending_party: t.pending_party,
            pending_note: t.pending_note,
            pending_since: t.pending_since,
            pending_by: t.pending_by,
            from_idea_id: t.from_idea_id,
            tests_assumption_id: t.tests_assumption_id,
            wave_pin: t.wave_pin,
            review_requested_from: t.review_requested_from,
            completed_at,
            completed_by,
            created_at: t.created_at,
            updated_at: t.updated_at,
        })
    }
}
