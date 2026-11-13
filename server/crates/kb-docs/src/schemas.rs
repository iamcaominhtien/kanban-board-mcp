//! Request bodies of the Docs routes (declared in `api/docs.py`; `models.py` has no Docs request or response
//! models, the routes answer plain dicts).

use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};

/// A field that tells "absent" (`None`) from "null" (`Some(None)`), as `model_fields_set` does.
fn present<'de, D, T>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::<T>::deserialize(de)?))
}

fn blank() -> String {
    "blank".to_string()
}

fn review() -> String {
    "review".to_string()
}

/// Request body to create a page.
#[derive(Debug, Deserialize)]
pub struct PageCreate {
    pub title: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default = "blank")]
    pub template: String,
    #[serde(default)]
    pub markdown: Option<String>,
}

/// Request body to rename a page.
#[derive(Debug, Deserialize)]
pub struct PageRename {
    pub title: String,
    #[serde(default)]
    pub rewrite_links: bool,
}

/// Request body to move a page.
#[derive(Debug, Default, Deserialize)]
pub struct PageMove {
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub before_id: Option<String>,
    #[serde(default)]
    pub after_id: Option<String>,
}

/// Request body to duplicate a page.
#[derive(Debug, Default, Deserialize)]
pub struct PageDuplicate {
    #[serde(default)]
    pub title: Option<String>,
    /// `Some(None)` is an explicit null (top level); `None` is "not given" (`"parent_id" in model_fields_set`).
    #[serde(default, deserialize_with = "present")]
    pub parent_id: Option<Option<String>>,
    #[serde(default)]
    pub include_children: bool,
}

/// Request body to save a draft.
#[derive(Debug, Deserialize)]
pub struct DraftSave {
    pub markdown: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub base_version: Option<i32>,
}

/// Request body to follow or unfollow a Docs space.
#[derive(Debug, Deserialize)]
pub struct FollowBody {
    pub on: bool,
}

/// Request body to record the version a person has viewed.
#[derive(Debug, Deserialize)]
pub struct SeenBody {
    pub version: i64,
}

/// Request body to publish a draft.
#[derive(Debug, Deserialize)]
pub struct PublishBody {
    pub base_version: i64,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub markdown: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub notify: bool,
}

/// Request body to restore a version.
#[derive(Debug, Default, Deserialize)]
pub struct RestoreBody {
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub notify: bool,
}

/// Request body listing references to resolve.
#[derive(Debug, Deserialize)]
pub struct ResolveBody {
    pub refs: Vec<Map<String, Value>>,
    /// The references sit in a ticket: it links by page id, so a renamed page's old title still resolves.
    #[serde(default)]
    pub from_ticket: bool,
}

/// Request body to link a ticket to a page.
#[derive(Debug, Deserialize)]
pub struct TicketDocBody {
    pub page_id: String,
}

/// Who gets the page, to write it or review it, and what is asked.
#[derive(Debug, Deserialize)]
pub struct AssignPageBody {
    pub member_id: String,
    #[serde(default = "review")]
    pub kind: String,
    #[serde(default)]
    pub instruction: Option<String>,
}

/// Request body to ask an admin for access to Docs.
#[derive(Debug, Default, Deserialize)]
pub struct AccessRequestBody {
    #[serde(default)]
    pub note: String,
}

/// Request body listing the pages created by an import.
#[derive(Debug, Deserialize)]
pub struct ImportResolveBody {
    pub page_ids: Vec<String>,
}

pub use crate::docs_comments::Anchor as AnchorBody;

fn inline() -> String {
    "inline".to_string()
}

/// Request body to start a comment thread.
#[derive(Debug, Deserialize)]
pub struct ThreadCreate {
    #[serde(default = "inline")]
    pub kind: String,
    pub body: String,
    #[serde(default)]
    pub anchor: Option<AnchorBody>,
    /// What a mention of an AI member means (Docs AI): ask | suggest (work) | notify
    #[serde(default)]
    pub ai_intent: Option<String>,
}

/// Request body to reply to or edit a comment.
#[derive(Debug, Deserialize)]
pub struct CommentBody {
    pub body: String,
    #[serde(default)]
    pub ai_intent: Option<String>,
}

/// Open threads of a page to send to an AI (Send to AI).
#[derive(Debug, Deserialize)]
pub struct SendToAiBody {
    pub thread_ids: Vec<String>,
    /// team: the team of `ticket_id` | board_ai: it routes | page_assistant: the page's own assistant
    #[serde(default = "default_team")]
    pub to: String,
    #[serde(default)]
    pub ticket_id: Option<String>,
    /// A ticket with no team: the team to give it before sending.
    #[serde(default)]
    pub give_team_id: Option<String>,
}

fn default_team() -> String {
    "team".to_string()
}

/// Send a ticket's page comments to its own team.
#[derive(Debug, Deserialize)]
pub struct SendCommentsBody {
    #[serde(default)]
    pub give_team_id: Option<String>,
}

/// Markdown whose effect on open comment anchors should be checked.
#[derive(Debug, Deserialize)]
pub struct AnchorPreviewBody {
    pub markdown: String,
}
