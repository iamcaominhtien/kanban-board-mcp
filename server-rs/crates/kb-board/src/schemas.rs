//! Request and response models of the board's routes (`models.py`, "Request / Response schemas").

use kb_db::entities::{member, project};
use serde::{Deserialize, Serialize};

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
