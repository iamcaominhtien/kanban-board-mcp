//! Request models of the AI routers (`api/ai_accounts.py`, `api/ai_knowledge.py`); the models of the other routers are
//! next to their handlers. The replies are the dicts the
//! services build, so there is no response model.

use serde::Deserialize;

/// A new account, or a new name for one (`AccountBody`).
#[derive(Debug, Clone, Deserialize)]
pub struct AccountBody {
    /// The name of the account.
    pub name: String,
    /// The CLI it is made for.
    #[serde(default)]
    pub cli: Option<String>,
}

/// The project's instructions for every AI (`InstructionsBody`).
#[derive(Debug, Clone, Deserialize)]
pub struct InstructionsBody {
    /// The new text.
    pub instructions: String,
}

/// A lesson a person writes (kept at once) (`LessonBody`).
#[derive(Debug, Clone, Deserialize)]
pub struct LessonBody {
    /// The lesson.
    pub text: String,
}

/// `Literal["proposed", "kept", "dropped"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LessonState {
    /// An AI suggested it.
    Proposed,
    /// A person keeps it.
    Kept,
    /// A person said no.
    Dropped,
}

impl LessonState {
    /// The stored text.
    pub fn as_str(self) -> &'static str {
        match self {
            LessonState::Proposed => "proposed",
            LessonState::Kept => "kept",
            LessonState::Dropped => "dropped",
        }
    }
}

/// Keep, edit or drop a lesson (`LessonPatch`).
#[derive(Debug, Clone, Deserialize)]
pub struct LessonPatch {
    /// The new text.
    #[serde(default)]
    pub text: Option<String>,
    /// The new state.
    #[serde(default)]
    pub state: Option<LessonState>,
}

/// `Literal["role", "member", "ticket"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteScope {
    /// A role's memory.
    Role,
    /// A member's memory.
    Member,
    /// A ticket's memory.
    Ticket,
}

impl NoteScope {
    /// The stored text.
    pub fn as_str(self) -> &'static str {
        match self {
            NoteScope::Role => "role",
            NoteScope::Member => "member",
            NoteScope::Ticket => "ticket",
        }
    }
}

/// `Literal["learned", "feedback"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteKind {
    /// An AI learned it.
    Learned,
    /// A person's correction.
    Feedback,
}

impl NoteKind {
    /// The stored text.
    pub fn as_str(self) -> &'static str {
        match self {
            NoteKind::Learned => "learned",
            NoteKind::Feedback => "feedback",
        }
    }
}

/// A note a person writes into an AI memory, or an edit of one (`NoteBody`).
#[derive(Debug, Clone, Deserialize)]
pub struct NoteBody {
    /// The note.
    pub text: String,
    /// Whose memory.
    #[serde(default)]
    pub scope: Option<NoteScope>,
    /// The role, member or ticket.
    #[serde(default)]
    pub scope_key: Option<String>,
    /// What kind of note.
    #[serde(default)]
    pub kind: Option<NoteKind>,
}

/// The account an AI member should run as, or null for the login already on this computer (`AssignBody`).
#[derive(Debug, Clone, Deserialize)]
pub struct AssignBody {
    /// The account.
    #[serde(default)]
    pub account_id: Option<String>,
}
