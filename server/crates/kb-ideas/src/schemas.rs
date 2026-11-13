//! Request and response models of the Idea Space routes: `models.py` lines 2324-2565 (`IdeaTicketCreateBody`,
//! `IdeaTicketUpdate`, `IdeaTicketRead` and the assumption view) and the models declared in `api/idea_tickets.py` and
//! `api/idea_space.py`.

use kb_board::schemas::parse_json_list;
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value, json};

use crate::error::Error;
use crate::model::{IDEA_COLORS, Idea, idea_readiness};

/// A `Literal[...]` of strings: an enum that reads and shows the exact values.
macro_rules! literal {
    ($(#[$doc:meta])* $name:ident { $($variant:ident => $text:literal),* $(,)? }) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $text)] $variant,)*
        }

        impl $name {
            /// The value as it is stored.
            pub fn as_str(self) -> &'static str {
                match self {
                    $($name::$variant => $text,)*
                }
            }
        }
    };
}

literal! {
    /// `Literal["seed", "concept", "hot", "big_bet"]`.
    Energy { Seed => "seed", Concept => "concept", Hot => "hot", BigBet => "big_bet" }
}
literal! {
    /// `Literal["manual", "selection", "doc", "comment", "ticket", "picture", "ai", "import"]`.
    Source {
        Manual => "manual", Selection => "selection", Doc => "doc", Comment => "comment", Ticket => "ticket",
        Picture => "picture", Ai => "ai", Import => "import",
    }
}
literal! {
    /// `Literal["inbox", "exploring", "ready", "building", "parked", "shipped", "archived"]` (`Stage`).
    Stage {
        Inbox => "inbox", Exploring => "exploring", Ready => "ready", Building => "building", Parked => "parked",
        Shipped => "shipped", Archived => "archived",
    }
}
literal! {
    /// `Literal["low", "medium", "high"]` (`Impact`).
    Impact { Low => "low", Medium => "medium", High => "high" }
}
literal! {
    /// `Literal["untested", "testing", "validated", "disproved", "invalidated"]` (`AssumptionState`).
    AssumptionState {
        Untested => "untested", Testing => "testing", Validated => "validated", Disproved => "disproved",
        Invalidated => "invalidated",
    }
}
literal! {
    /// `Literal["already_exists", "too_big", "not_now", "wrong_direction", "other"]`.
    ArchiveReason {
        AlreadyExists => "already_exists", TooBig => "too_big", NotNow => "not_now",
        WrongDirection => "wrong_direction", Other => "other",
    }
}
literal! {
    /// `Literal["worked", "partly", "no"]`.
    Outcome { Worked => "worked", Partly => "partly", No => "no" }
}
literal! {
    /// `Literal["open_then_30", "30_days", "forever"]`.
    Retention { OpenThen30 => "open_then_30", ThirtyDays => "30_days", Forever => "forever" }
}
literal! {
    /// `Literal["comment", "file", "link", "ticket", "sketch", "diagram", "note"]`.
    EvidenceKind {
        Comment => "comment", File => "file", Link => "link", Ticket => "ticket", Sketch => "sketch",
        Diagram => "diagram", Note => "note",
    }
}
literal! {
    /// `Literal["note", "research", "interview", "experiment", "finding", "decision"]`.
    LogKind {
        Note => "note", Research => "research", Interview => "interview", Experiment => "experiment",
        Finding => "finding", Decision => "decision",
    }
}
literal! {
    /// `Literal["validated", "disproved", "unsure"]`.
    Resolution { Validated => "validated", Disproved => "disproved", Unsure => "unsure" }
}
literal! {
    /// `Literal["bug", "feature", "task", "chore"]`.
    PromoteType { Bug => "bug", Feature => "feature", Task => "task", Chore => "chore" }
}
literal! {
    /// `Literal["low", "medium", "high", "critical"]`.
    Priority { Low => "low", Medium => "medium", High => "high", Critical => "critical" }
}
literal! {
    /// `Literal["backlog", "todo", "in-progress", "review", "testing"]`.
    PromoteStatus {
        Backlog => "backlog", Todo => "todo", InProgress => "in-progress", Review => "review", Testing => "testing",
    }
}
literal! {
    /// `Literal["move", "copy", "leave"]`.
    WorkspaceMode { Move => "move", Copy => "copy", Leave => "leave" }
}
literal! {
    /// `Literal["project", "all", "none"]`.
    Scope { Project => "project", All => "all", None => "none" }
}
literal! {
    /// `Literal["readiness", "updated", "created", "votes", "title"]`.
    Sort { Readiness => "readiness", Updated => "updated", Created => "created", Votes => "votes", Title => "title" }
}
literal! {
    /// `Literal["idea", "ticket", "doc"]`.
    Kind { Idea => "idea", Ticket => "ticket", Doc => "doc" }
}
literal! {
    /// `Literal["stage", "assumptions", "evidence", "page", "ai", "links"]`.
    ActivityFilter {
        Stage => "stage", Assumptions => "assumptions", Evidence => "evidence", Page => "page", Ai => "ai",
        Links => "links",
    }
}

/// `Field(max_length=N)` of a `str`: at most N characters.
pub(crate) fn max_chars<'de, D: Deserializer<'de>, const MAX: usize>(deserializer: D) -> Result<String, D::Error> {
    let text = String::deserialize(deserializer)?;
    if text.chars().count() > MAX {
        return Err(D::Error::custom(format!("String should have at most {MAX} characters")));
    }
    Ok(text)
}

/// `Field(min_length=MIN, max_length=MAX)` of a `str`.
pub(crate) fn chars_between<'de, D: Deserializer<'de>, const MIN: usize, const MAX: usize>(
    deserializer: D,
) -> Result<String, D::Error> {
    let text = String::deserialize(deserializer)?;
    let n = text.chars().count();
    if n < MIN {
        return Err(D::Error::custom(format!(
            "String should have at least {MIN} character{}",
            if MIN == 1 { "" } else { "s" }
        )));
    }
    if n > MAX {
        return Err(D::Error::custom(format!("String should have at most {MAX} characters")));
    }
    Ok(text)
}

/// `Optional[str] = Field(default=None, max_length=N)`: None, or at most N characters.
pub(crate) fn opt_max_chars<'de, D: Deserializer<'de>, const MAX: usize>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    match Option::<String>::deserialize(deserializer)? {
        Some(text) if text.chars().count() > MAX => {
            Err(D::Error::custom(format!("String should have at most {MAX} characters")))
        }
        other => Ok(other),
    }
}

/// A field that was sent, with its value or null (`Some(None)`); a field left out stays `None`.
pub(crate) fn sent<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// `str | None` that was sent, at most N characters.
pub(crate) fn sent_max_chars<'de, D: Deserializer<'de>, const MAX: usize>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    opt_max_chars::<D, MAX>(deserializer).map(Some)
}

/// `Optional[int]` as Pydantic reads a JSON value: a whole number, also written as a float (`3.0`) or a bool.
fn int_of<E: serde::de::Error>(value: &Value) -> Result<i64, E> {
    match value {
        Value::Bool(flag) => Ok(i64::from(*flag)),
        Value::Number(n) => {
            if let Some(whole) = n.as_i64() {
                return Ok(whole);
            }
            match n.as_f64() {
                Some(f) if f.fract() == 0.0 && f.abs() < 9.0e15 => Ok(f as i64),
                _ => Err(E::custom("Input should be a valid integer, got a number with a fractional part")),
            }
        }
        _ => Err(E::custom("Input should be a valid integer")),
    }
}

/// `Optional[int] = Field(default=None, ge=1, le=5)` that was sent.
fn sent_ice<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Option<i64>>, D::Error> {
    match Value::deserialize(deserializer)? {
        Value::Null => Ok(Some(None)),
        value => {
            let n = int_of::<D::Error>(&value)?;
            if n < 1 {
                return Err(D::Error::custom("Input should be greater than or equal to 1"));
            }
            if n > 5 {
                return Err(D::Error::custom("Input should be less than or equal to 5"));
            }
            Ok(Some(Some(n)))
        }
    }
}

fn palette_error<E: serde::de::Error>() -> E {
    let mut sorted = IDEA_COLORS.to_vec();
    sorted.sort_unstable();
    E::custom(format!("Value error, idea_color must be one of: {}", sorted.join(", ")))
}

/// `idea_color: str` with the palette check of `validate_color`.
fn color<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let text = String::deserialize(deserializer)?;
    if !IDEA_COLORS.contains(&text.as_str()) {
        return Err(palette_error());
    }
    Ok(text)
}

/// `idea_color: Optional[str]` that was sent, with the palette check.
fn sent_color<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Option<String>>, D::Error> {
    match Option::<String>::deserialize(deserializer)? {
        Some(text) if !IDEA_COLORS.contains(&text.as_str()) => Err(palette_error()),
        other => Ok(Some(other)),
    }
}

fn default_description() -> String {
    String::new()
}

fn default_color() -> String {
    "yellow".to_string()
}

fn default_emoji() -> String {
    "💡".to_string()
}

fn default_source() -> Source {
    Source::Manual
}

/// Request body to create an idea ticket (`IdeaTicketCreateBody`).
#[derive(Debug, Clone, Deserialize)]
pub struct IdeaTicketCreateBody {
    /// None: the idea belongs to no project yet.
    #[serde(default)]
    pub project_id: Option<String>,
    pub title: String,
    #[serde(default = "default_description")]
    pub description: String,
    #[serde(default = "default_color", deserialize_with = "color")]
    pub idea_color: String,
    #[serde(default = "default_emoji")]
    pub idea_emoji: String,
    #[serde(default)]
    pub idea_energy: Option<Energy>,
    #[serde(default)]
    pub tags: Vec<Value>,
    #[serde(default)]
    pub problem_statement: Option<String>,
    #[serde(default = "default_source")]
    pub source: Source,
    #[serde(default)]
    pub source_ref: Option<Map<String, Value>>,
}

/// The fields of `IdeaTicketUpdate`, each one absent, null or a value of its type.
#[derive(Debug, Default, Deserialize)]
struct IdeaTicketUpdateFields {
    #[serde(default, deserialize_with = "sent")]
    title: Option<Option<String>>,
    #[serde(default, deserialize_with = "sent")]
    description: Option<Option<String>>,
    #[serde(default, deserialize_with = "sent_color")]
    idea_color: Option<Option<String>>,
    #[serde(default, deserialize_with = "sent")]
    idea_emoji: Option<Option<String>>,
    #[serde(default, deserialize_with = "sent")]
    idea_energy: Option<Option<Energy>>,
    #[serde(default, deserialize_with = "sent")]
    tags: Option<Option<Vec<Value>>>,
    #[serde(default, deserialize_with = "sent")]
    problem_statement: Option<Option<String>>,
    #[serde(default, deserialize_with = "sent_ice")]
    ice_impact: Option<Option<i64>>,
    #[serde(default, deserialize_with = "sent_ice")]
    ice_effort: Option<Option<i64>>,
    #[serde(default, deserialize_with = "sent_ice")]
    ice_confidence: Option<Option<i64>>,
    #[serde(default, deserialize_with = "sent")]
    revisit_date: Option<Option<String>>,
}

/// Partial update of an idea ticket (`IdeaTicketUpdate`): `fields` is `model_dump(exclude_unset=True)`, the fields
/// that were sent (a null included), in the order the model declares them. Anything else in the body is dropped.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct IdeaTicketUpdate {
    /// The fields that were sent.
    pub fields: Map<String, Value>,
}

impl<'de> Deserialize<'de> for IdeaTicketUpdate {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let f = IdeaTicketUpdateFields::deserialize(deserializer)?;
        let mut fields = Map::new();
        let mut put = |name: &str, value: Option<Value>| {
            if let Some(value) = value {
                fields.insert(name.to_string(), value);
            }
        };
        put("title", f.title.map(|v| json!(v)));
        put("description", f.description.map(|v| json!(v)));
        put("idea_color", f.idea_color.map(|v| json!(v)));
        put("idea_emoji", f.idea_emoji.map(|v| json!(v)));
        put("idea_energy", f.idea_energy.map(|v| json!(v.map(Energy::as_str))));
        put("tags", f.tags.map(|v| json!(v)));
        put("problem_statement", f.problem_statement.map(|v| json!(v)));
        put("ice_impact", f.ice_impact.map(|v| json!(v)));
        put("ice_effort", f.ice_effort.map(|v| json!(v)));
        put("ice_confidence", f.ice_confidence.map(|v| json!(v)));
        put("revisit_date", f.revisit_date.map(|v| json!(v)));
        Ok(Self { fields })
    }
}

/// `_parse_json_dict(value)`: the object a JSON column holds (`{}` for anything else).
fn parse_json_dict(value: &str) -> Map<String, Value> {
    if value.is_empty() {
        return Map::new();
    }
    match serde_json::from_str::<Value>(value) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// `_LEGACY_ASSUMPTION_STATUS`: what the current Idea board understands of the new assumption statuses.
fn legacy_assumption_status(status: &str) -> &str {
    match status {
        "testing" => "untested",
        "disproved" => "invalidated",
        other => other,
    }
}

/// `_assumption_view(a)`: an assumption as the API returns it: the old keys, plus the fields of the new model.
fn assumption_view(a: &crate::model::AssumptionRecord) -> Value {
    let evidence: Vec<Value> = a
        .evidence
        .iter()
        .map(|e| {
            json!({
                "id": e.id,
                "kind": e.kind,
                "title": e.title,
                "ref": e.r#ref,
                "created_by": e.created_by,
                "created_at": e.created_at,
            })
        })
        .collect();
    json!({
        "id": a.row.id,
        "text": a.row.text,
        "status": legacy_assumption_status(&a.row.status),
        "at": a.row.created_at,
        "state": a.row.status,
        "impact": a.row.impact,
        "test_ticket_id": a.row.test_ticket_id,
        "ai": a.row.ai,
        "evidence": evidence,
    })
}

/// Idea ticket as returned by the API (`IdeaTicketRead`).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct IdeaTicketRead {
    pub id: String,
    pub project_id: Option<String>,
    pub title: String,
    pub description: String,
    pub idea_status: String,
    pub stage: String,
    pub park_until: Option<String>,
    pub archive_reason: Option<String>,
    pub source: String,
    pub body: String,
    pub details: String,
    pub votes: usize,
    pub voters: Vec<String>,
    pub source_ref: Map<String, Value>,
    pub created_by: Option<String>,
    pub owner: Option<String>,
    pub park_note: Option<String>,
    pub archive_note: Option<String>,
    pub stage_changed_at: Option<String>,
    pub merged_into_id: Option<String>,
    pub merged_at: Option<String>,
    pub shipped_at: Option<String>,
    pub outcome: Option<String>,
    pub outcome_note: Option<String>,
    pub effort_guess: Option<String>,
    pub workspace_retention: String,
    pub former_ticket_id: Option<String>,
    pub comment_count: usize,
    pub log_count: usize,
    pub evidence_count: usize,
    pub readiness: Map<String, Value>,
    /// The ticket it became, filled in by the API layer: `{id, title, status, project_id}`.
    pub ticket: Option<Value>,
    /// Whether the current actor may move and edit it (viewers can only add, vote and comment); API layer.
    pub can_edit: bool,
    pub idea_color: String,
    pub idea_emoji: String,
    pub idea_energy: Option<String>,
    pub tags: Vec<Value>,
    pub problem_statement: Option<String>,
    pub ice_impact: i32,
    pub ice_effort: i32,
    pub ice_confidence: i32,
    pub revisit_date: Option<String>,
    pub last_touched_at: Option<String>,
    pub promoted_to_ticket_id: Option<String>,
    pub promoted_at: Option<String>,
    pub activity_trail: Vec<Value>,
    pub microthoughts: Vec<Value>,
    pub assumptions: Vec<Value>,
    pub created_at: String,
    pub updated_at: String,
}

impl IdeaTicketRead {
    /// `IdeaTicketRead.from_idea_ticket(ticket)`: the read model of a stored idea. A column that holds invalid JSON
    /// is Python's `JSONDecodeError`, a 500.
    pub fn from_idea_ticket(idea: &Idea) -> Result<Self, Error> {
        let row = &idea.row;
        let list = |text: &str| parse_json_list(text).map_err(|err| Error::Other(err.to_string()));
        Ok(Self {
            id: row.id.clone(),
            project_id: row.project_id.clone(),
            title: row.title.clone(),
            description: row.description.clone(),
            idea_status: row.idea_status.clone(),
            stage: row.stage.clone(),
            park_until: row.park_until.clone(),
            archive_reason: row.archive_reason.clone(),
            source: row.source.clone(),
            body: row.body.clone(),
            details: row.details.clone(),
            votes: idea.vote_records.len(),
            voters: idea.vote_records.iter().map(|v| v.voter.clone()).collect(),
            source_ref: parse_json_dict(&row.source_ref),
            created_by: row.created_by.clone(),
            owner: row.owner.clone(),
            park_note: row.park_note.clone(),
            archive_note: row.archive_note.clone(),
            stage_changed_at: row.stage_changed_at.clone(),
            merged_into_id: row.merged_into_id.clone(),
            merged_at: row.merged_at.clone(),
            shipped_at: row.shipped_at.clone(),
            outcome: row.outcome.clone(),
            outcome_note: row.outcome_note.clone(),
            effort_guess: row.effort_guess.clone(),
            workspace_retention: row.workspace_retention.clone(),
            former_ticket_id: row.former_ticket_id.clone(),
            comment_count: idea.comment_records.len(),
            log_count: idea.log_records.len(),
            evidence_count: idea.assumption_records.iter().map(|a| a.evidence.len()).sum(),
            readiness: idea_readiness(idea.assumptions()),
            ticket: None,
            can_edit: true,
            idea_color: row.idea_color.clone(),
            idea_emoji: row.idea_emoji.clone(),
            idea_energy: row.idea_energy.clone(),
            tags: list(&row.tags)?,
            problem_statement: row.problem_statement.clone(),
            ice_impact: row.ice_impact,
            ice_effort: row.ice_effort,
            ice_confidence: row.ice_confidence,
            revisit_date: row.revisit_date.clone(),
            last_touched_at: row.last_touched_at.clone(),
            promoted_to_ticket_id: row.promoted_to_ticket_id.clone(),
            promoted_at: row.promoted_at.clone(),
            activity_trail: list(&row.activity_trail)?,
            microthoughts: idea
                .comment_records
                .iter()
                .map(|c| json!({"id": c.id, "text": c.body, "at": c.created_at}))
                .collect(),
            assumptions: idea.assumption_records.iter().map(assumption_view).collect(),
            created_at: row.created_at.clone(),
            updated_at: row.updated_at.clone(),
        })
    }
}

/// An idea as a list row: the idea with its warnings (stale, waiting too long, at risk) (`IdeaListRow`).
#[derive(Debug, Clone, Serialize)]
pub struct IdeaListRow {
    #[serde(flatten)]
    pub idea: IdeaTicketRead,
    pub warnings: Vec<String>,
}

// ── api/idea_tickets.py ────────────────────────────────────────────────────

/// Request body to add an assumption (`AssumptionBody`).
#[derive(Debug, Clone, Deserialize)]
pub struct AssumptionBody {
    #[serde(deserialize_with = "max_chars::<_, 500>")]
    pub text: String,
    #[serde(default = "medium")]
    pub impact: Impact,
}

fn medium() -> Impact {
    Impact::Medium
}

/// Request body to change an assumption's status (`AssumptionStatusBody`).
#[derive(Debug, Clone, Deserialize)]
pub struct AssumptionStatusBody {
    pub status: AssumptionState,
}

/// Request body to add a microthought (`MicrothoughtBody`).
#[derive(Debug, Clone, Deserialize)]
pub struct MicrothoughtBody {
    #[serde(deserialize_with = "max_chars::<_, 500>")]
    pub text: String,
}

/// Request body to change an idea's status (`IdeaStatusUpdateBody`).
#[derive(Debug, Clone, Deserialize)]
pub struct IdeaStatusUpdateBody {
    pub new_status: String,
    #[serde(default, deserialize_with = "opt_max_chars::<_, 500>")]
    pub reason: Option<String>,
}

// ── api/idea_space.py ──────────────────────────────────────────────────────

/// Move an idea to a stage (Keep, Park, Archive, Restore or drag) (`StageBody`).
#[derive(Debug, Clone, Deserialize)]
pub struct StageBody {
    pub to: Stage,
    #[serde(default)]
    pub park_until: Option<String>,
    #[serde(default, deserialize_with = "opt_max_chars::<_, 500>")]
    pub park_note: Option<String>,
    #[serde(default)]
    pub archive_reason: Option<ArchiveReason>,
    #[serde(default, deserialize_with = "opt_max_chars::<_, 500>")]
    pub archive_note: Option<String>,
    #[serde(default)]
    pub force: bool,
    #[serde(default, deserialize_with = "opt_max_chars::<_, 40>")]
    pub via: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
}

/// `Field(min_length=MIN, max_length=MAX)` of a list.
fn list_between<'de, D, T, const MIN: usize, const MAX: usize>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    let items = Vec::<T>::deserialize(deserializer)?;
    if items.len() < MIN {
        return Err(D::Error::custom(format!(
            "List should have at least {MIN} item{}",
            if MIN == 1 { "" } else { "s" }
        )));
    }
    if items.len() > MAX {
        return Err(D::Error::custom(format!("List should have at most {MAX} items")));
    }
    Ok(items)
}

/// Park several ideas for the same time (`ParkManyBody`).
#[derive(Debug, Clone, Deserialize)]
pub struct ParkManyBody {
    #[serde(deserialize_with = "list_between::<_, String, 1, 200>")]
    pub ids: Vec<String>,
    pub park_until: String,
    #[serde(default, deserialize_with = "opt_max_chars::<_, 500>")]
    pub park_note: Option<String>,
}

/// Merge this idea into another (`MergeBody`).
#[derive(Debug, Clone, Deserialize)]
pub struct MergeBody {
    pub into_id: String,
}

fn yes() -> bool {
    true
}

/// Add or remove "I want this"; the voter defaults to the current actor (`VoteBody`).
#[derive(Debug, Clone, Deserialize)]
pub struct VoteBody {
    #[serde(default)]
    pub voter: Option<String>,
    #[serde(default = "yes")]
    pub on: bool,
}

/// The answer to "Did it work as expected?" after an idea shipped (`OutcomeBody`).
#[derive(Debug, Clone, Deserialize)]
pub struct OutcomeBody {
    pub outcome: Outcome,
    #[serde(default, deserialize_with = "opt_max_chars::<_, 1000>")]
    pub note: Option<String>,
}

/// Edit the idea page and the small fields next to it; omitted fields stay as they are (`PageBody`).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct PageBody {
    #[serde(default, deserialize_with = "opt_max_chars::<_, 200000>")]
    pub body: Option<String>,
    #[serde(default, deserialize_with = "opt_max_chars::<_, 20000>")]
    pub details: Option<String>,
    #[serde(default, deserialize_with = "opt_max_chars::<_, 200>")]
    pub title: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    /// `Some(None)`: sent as null, which clears the owner.
    #[serde(default, deserialize_with = "sent")]
    pub owner: Option<Option<String>>,
    /// `Some(None)`: sent as null, which clears the guess.
    #[serde(default, deserialize_with = "sent")]
    pub effort_guess: Option<Option<String>>,
    #[serde(default)]
    pub workspace_retention: Option<Retention>,
    #[serde(default)]
    pub ai: bool,
}

/// Assign the idea to a project, move it to another, or take it out of its project (null) (`ProjectBody`).
#[derive(Debug, Clone, Deserialize)]
pub struct ProjectBody {
    #[serde(default)]
    pub project_id: Option<String>,
}

/// A new assumption: "We believe ..." (`AssumptionCreate`).
#[derive(Debug, Clone, Deserialize)]
pub struct AssumptionCreate {
    #[serde(deserialize_with = "chars_between::<_, 1, 500>")]
    pub text: String,
    #[serde(default = "medium")]
    pub impact: Impact,
    #[serde(default)]
    pub ai: bool,
}

/// Change an assumption; omitted fields stay as they are (`AssumptionEdit`). A field that was sent as null counts as
/// sent (`model_dump(exclude_unset=True)`).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct AssumptionEdit {
    #[serde(default, deserialize_with = "sent_max_chars::<_, 500>")]
    pub text: Option<Option<String>>,
    #[serde(default, deserialize_with = "sent")]
    pub impact: Option<Option<Impact>>,
    #[serde(default, deserialize_with = "sent")]
    pub status: Option<Option<AssumptionState>>,
    #[serde(default, deserialize_with = "sent")]
    pub test_ticket_id: Option<Option<String>>,
}

/// Create a small ticket that tests an assumption (`TestTicketBody`).
#[derive(Debug, Clone, Deserialize)]
pub struct TestTicketBody {
    #[serde(default, deserialize_with = "opt_max_chars::<_, 200>")]
    pub title: Option<String>,
    #[serde(default)]
    pub assignee: Option<String>,
}

/// What the test showed (`ResolveBody`).
#[derive(Debug, Clone, Deserialize)]
pub struct ResolveBody {
    pub outcome: Resolution,
}

/// A piece of evidence for one or more assumptions (`EvidenceBody`).
#[derive(Debug, Clone, Deserialize)]
pub struct EvidenceBody {
    #[serde(deserialize_with = "list_between::<_, String, 1, 1_000_000>")]
    pub assumption_ids: Vec<String>,
    pub kind: EvidenceKind,
    #[serde(rename = "ref", deserialize_with = "chars_between::<_, 1, 4000>")]
    pub reference: String,
    #[serde(default, deserialize_with = "max_chars::<_, 300>")]
    pub title: String,
}

/// The text of a comment (`CommentBody`).
#[derive(Debug, Clone, Deserialize)]
pub struct CommentBody {
    #[serde(deserialize_with = "chars_between::<_, 1, 20000>")]
    pub body: String,
}

fn note() -> LogKind {
    LogKind::Note
}

/// `list[dict[str, str]]`: every value of every entry is text.
fn text_dicts<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<Value>, D::Error> {
    let items = list_between::<D, Map<String, Value>, 0, 20>(deserializer)?;
    for item in &items {
        if item.values().any(|v| !v.is_string()) {
            return Err(D::Error::custom("Input should be a valid string"));
        }
    }
    Ok(items.into_iter().map(Value::Object).collect())
}

/// A research log entry (`LogBody`).
#[derive(Debug, Clone, Deserialize)]
pub struct LogBody {
    #[serde(default = "note")]
    pub kind: LogKind,
    #[serde(deserialize_with = "chars_between::<_, 1, 20000>")]
    pub body: String,
    #[serde(default)]
    pub assumption_id: Option<String>,
    #[serde(default, deserialize_with = "text_dicts")]
    pub attachments: Vec<Value>,
    #[serde(default)]
    pub ticket_id: Option<String>,
    #[serde(default)]
    pub ai: bool,
}

/// Edit, re-kind or pin a log entry (`LogPatch`).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct LogPatch {
    #[serde(default, deserialize_with = "opt_max_chars::<_, 20000>")]
    pub body: Option<String>,
    #[serde(default)]
    pub kind: Option<LogKind>,
    #[serde(default)]
    pub pinned: Option<bool>,
}

/// The assumption a finding supports (`LogEvidenceBody`).
#[derive(Debug, Clone, Deserialize)]
pub struct LogEvidenceBody {
    pub assumption_id: String,
}

fn feature() -> PromoteType {
    PromoteType::Feature
}

fn medium_priority() -> Priority {
    Priority::Medium
}

fn backlog() -> PromoteStatus {
    PromoteStatus::Backlog
}

fn leave() -> WorkspaceMode {
    WorkspaceMode::Leave
}

/// Create the ticket from an idea (`PromoteBody`).
#[derive(Debug, Clone, Deserialize)]
pub struct PromoteBody {
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default, deserialize_with = "opt_max_chars::<_, 200>")]
    pub title: Option<String>,
    #[serde(default = "feature")]
    pub r#type: PromoteType,
    #[serde(default = "medium_priority")]
    pub priority: Priority,
    #[serde(default = "backlog")]
    pub status: PromoteStatus,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, deserialize_with = "list_between::<_, String, 0, 10>")]
    pub sub_tickets: Vec<String>,
    #[serde(default)]
    pub acknowledge_not_ready: bool,
    #[serde(default = "leave")]
    pub workspace: WorkspaceMode,
}
