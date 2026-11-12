//! Memory a run can write, and keeping the project's memory honest (issue #274). Port of `services/ai/memory.py`.
//!
//! Three layers reach a run's prompt (`knowledge` builds the block):
//!
//! - **Lessons** (project-wide, every AI): a person keeps them. An AI (the lead's report, or
//!   `knowledge(action='remember')`) or an outside agent only proposes.
//! - **Notes** (this module): what one role learned for itself across runs: what works in this repository, the
//!   commands, where things are, a person's feedback. Kept per **role** (every Dev reads the Dev notes: a second Dev
//!   must not pay for the first one's mistake again) or per **member** when the member has no role; and per
//!   **ticket**, so what one run learned about a ticket reaches the next run on it. An AI writes them itself with
//!   `knowledge(action='remember')` (the `keeping-memory` skill says when); they are live at once, shown to people,
//!   editable, and capped.
//! - **Hygiene**: a lesson or note that names a file the repository no longer has, or that a newer one says something
//!   close to, is flagged for a person. Nothing is dropped by the board.
//!
//! Decided: notes per role (not per project: a project-wide fact is a lesson, which a person keeps; not per member: two
//! members of one role learn the same repository), per member only for a member without a role, and per ticket.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use fancy_regex::Regex as FancyRegex;
use kb_ai::config_model::estimate_tokens;
use kb_ai::{ops, store};
use kb_base::{pypath, pytext};
use kb_db::Session;
use kb_db::entities::{ai_lesson, ai_memory_note, ai_team, member, ticket};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, ModelTrait, QueryFilter, QueryOrder};
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::packs;

/// `NOTE_CHARS`.
pub const NOTE_CHARS: usize = 500;
/// `MAX_NOTES`: the most notes one scope keeps: past it, a write is refused and the AI is told to replace or forget
/// one, so the memory is curated instead of growing.
pub fn max_notes(scope: &str) -> usize {
    match scope {
        "ticket" => 15,
        _ => 30,
    }
}
/// `MAX_NOTES` as the API shows it.
pub fn max_notes_json() -> Value {
    json!({"role": 30, "member": 30, "ticket": 15})
}
/// `PROMPT_TOKENS`: tokens of notes in a run's prompt, per scope: the newest and most used first.
pub fn prompt_tokens(scope: &str) -> i64 {
    match scope {
        "ticket" => 800,
        _ => 1200,
    }
}
/// `SCOPES`.
pub const SCOPES: [&str; 3] = ["role", "member", "ticket"];
/// `KINDS`.
pub const KINDS: [&str; 2] = ["learned", "feedback"];
/// `SIMILAR`.
pub const SIMILAR: f64 = 0.5;

/// What a function of this module fails with.
#[derive(Debug)]
pub enum Error {
    /// `ValueError`: the text is the message.
    Value(String),
    /// `LookupError`: the text is the message.
    Lookup(String),
    /// The database call failed.
    Db(DbErr),
}

impl From<DbErr> for Error {
    fn from(err: DbErr) -> Self {
        Error::Db(err)
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Value(text) | Error::Lookup(text) => f.write_str(text),
            Error::Db(err) => write!(f, "{err}"),
        }
    }
}

fn now() -> String {
    kb_base::time::now_iso()
}

/// One line, trimmed to the cap.
pub fn clean(text: Option<&str>) -> String {
    pytext::squash(text.unwrap_or("")).chars().take(NOTE_CHARS).collect()
}

/// Where a member's own notes live: its role's, or its own when it has no role.
pub fn own_scope(role: Option<&str>, member_id: &str) -> (&'static str, String) {
    match role.filter(|r| !r.is_empty()) {
        Some(role) => ("role", role.to_string()),
        None => ("member", member_id.to_string()),
    }
}

/// A project's notes, newest first, optionally of one scope (and key).
pub async fn notes(
    session: &Session,
    project_id: &str,
    scope: Option<&str>,
    key: Option<&str>,
) -> Result<Vec<ai_memory_note::Model>, DbErr> {
    let mut stmt = ai_memory_note::Entity::find().filter(ai_memory_note::Column::ProjectId.eq(project_id));
    if let Some(scope) = scope.filter(|s| !s.is_empty()) {
        stmt = stmt.filter(ai_memory_note::Column::Scope.eq(scope));
    }
    if let Some(key) = key {
        stmt = stmt.filter(ai_memory_note::Column::ScopeKey.eq(key));
    }
    stmt.order_by_desc(ai_memory_note::Column::UpdatedAt).all(session).await
}

/// What `write` takes beside the note itself.
#[derive(Debug, Clone, Default)]
pub struct WriteOpts<'a> {
    /// `kind`: "learned" (the default) or "feedback".
    pub kind: Option<&'a str>,
    /// `note_id`: replace this note.
    pub note_id: Option<&'a str>,
    /// `source_run_id`.
    pub source_run_id: Option<&'a str>,
    /// `source_ticket_id`.
    pub source_ticket_id: Option<&'a str>,
}

/// Add a note, or replace one (`note_id`). Returns (note, "added" | "updated" | "unchanged").
pub async fn write(
    session: &Session,
    project_id: &str,
    scope: &str,
    key: &str,
    text: &str,
    by: &str,
    opts: WriteOpts<'_>,
) -> Result<(ai_memory_note::Model, &'static str), Error> {
    if !SCOPES.contains(&scope) {
        return Err(Error::Value("A note is kept by a role, a member or a ticket.".into()));
    }
    if key.is_empty() {
        return Err(Error::Value("Say whose note it is.".into()));
    }
    let body = clean(Some(text));
    if body.is_empty() {
        return Err(Error::Value("Write the note.".into()));
    }
    let kind = opts.kind.filter(|k| KINDS.contains(k)).unwrap_or("learned");
    if let Some(note_id) = opts.note_id.filter(|n| !n.is_empty()) {
        let row = ai_memory_note::Entity::find_by_id(note_id).one(session).await?;
        let Some(row) = row.filter(|r| r.project_id == project_id) else {
            return Err(Error::Lookup("No such note in this project.".into()));
        };
        let mut active = ai_memory_note::ActiveModel::from(row);
        active.text = Set(body);
        active.kind = Set(kind.to_string());
        active.updated_at = Set(now());
        active.written_by = Set(Some(by.to_string()));
        let saved = active.update(session).await?;
        session.commit().await?;
        return Ok((saved, "updated"));
    }
    let rows = notes(session, project_id, Some(scope), Some(key)).await?;
    let lowered = body.to_lowercase();
    if let Some(same) = rows.iter().find(|r| r.text.to_lowercase() == lowered) {
        return Ok((same.clone(), "unchanged"));
    }
    if rows.len() >= max_notes(scope) {
        let mut oldest: Vec<&ai_memory_note::Model> = rows.iter().collect();
        oldest.sort_by(|a, b| (a.uses, &a.updated_at).cmp(&(b.uses, &b.updated_at)));
        let least: Vec<String> = oldest
            .iter()
            .take(3)
            .map(|r| format!("{} “{}”", r.id, r.text.chars().take(60).collect::<String>()))
            .collect();
        return Err(Error::Value(format!(
            "This memory is full ({} notes). Replace one (note_id) or forget one first; the least used: {}",
            max_notes(scope),
            least.join(", ")
        )));
    }
    let mut row = ai_memory_note::new();
    row.project_id = Set(project_id.to_string());
    row.scope = Set(scope.to_string());
    row.scope_key = Set(key.to_string());
    row.text = Set(body);
    row.kind = Set(kind.to_string());
    row.written_by = Set(Some(by.to_string()));
    row.source_run_id = Set(opts.source_run_id.map(str::to_string));
    row.source_ticket_id = Set(opts.source_ticket_id.map(str::to_string));
    let saved = row.insert(session).await?;
    session.commit().await?;
    Ok((saved, "added"))
}

/// Remove a note.
pub async fn forget(session: &Session, project_id: &str, note_id: &str) -> Result<ai_memory_note::Model, Error> {
    let row = ai_memory_note::Entity::find_by_id(note_id).one(session).await?;
    let Some(row) = row.filter(|r| r.project_id == project_id) else {
        return Err(Error::Lookup("No such note in this project.".into()));
    };
    row.clone().delete(session).await?;
    session.commit().await?;
    Ok(row)
}

/// A sort key that puts the newest ISO time first (`chr(0x10FFFF - ord(ch))` of each character).
pub fn neg(stamp: Option<&str>) -> Vec<u32> {
    stamp.unwrap_or("").chars().map(|c| 0x10FFFF - c as u32).collect()
}

/// Rows with a `uses` count, a kind and a time, for `pick`.
pub trait Pickable {
    /// The text that costs tokens.
    fn text(&self) -> &str;
    /// `kind != "feedback"` sorts a person's feedback first.
    fn not_feedback(&self) -> bool;
    /// `uses or 0`.
    fn uses(&self) -> i64;
    /// The time the row was last changed.
    fn stamp(&self) -> &str;
}

impl Pickable for ai_memory_note::Model {
    fn text(&self) -> &str {
        &self.text
    }
    fn not_feedback(&self) -> bool {
        self.kind != "feedback"
    }
    fn uses(&self) -> i64 {
        i64::from(self.uses)
    }
    fn stamp(&self) -> &str {
        &self.updated_at
    }
}

/// Notes up to `cap` tokens: a person's feedback first, then the most used, then the newest.
pub fn pick<T: Pickable>(rows: &[T], cap: i64) -> Vec<&T> {
    let mut ordered: Vec<&T> = rows.iter().collect();
    ordered.sort_by_key(|r| (r.not_feedback(), -r.uses(), neg(Some(r.stamp()))));
    let mut out = Vec::new();
    let mut used = 0;
    for r in ordered {
        let cost = estimate_tokens(Some(r.text()));
        if used + cost > cap {
            continue;
        }
        out.push(r);
        used += cost;
    }
    out
}

/// (own notes, ticket notes) that go in a run's prompt.
pub async fn for_run(
    session: &Session,
    project_id: &str,
    role: Option<&str>,
    member_id: Option<&str>,
    ticket_id: Option<&str>,
) -> Result<(Vec<ai_memory_note::Model>, Vec<ai_memory_note::Model>), DbErr> {
    let mut own = Vec::new();
    if let Some(member_id) = member_id.filter(|m| !m.is_empty()) {
        let (scope, key) = own_scope(role, member_id);
        let rows = notes(session, project_id, Some(scope), Some(&key)).await?;
        own = pick(&rows, prompt_tokens(scope)).into_iter().cloned().collect();
    }
    let mut on_ticket = Vec::new();
    if let Some(ticket_id) = ticket_id.filter(|t| !t.is_empty()) {
        let rows = notes(session, project_id, Some("ticket"), Some(ticket_id)).await?;
        on_ticket = pick(&rows, prompt_tokens("ticket")).into_iter().cloned().collect();
    }
    Ok((own, on_ticket))
}

/// A name a person reads for each note's owner: the role's name, the member's, the ticket's key and title.
pub async fn labels(
    session: &Session,
    rows: &[ai_memory_note::Model],
) -> Result<HashMap<(String, String), String>, DbErr> {
    let mut out: HashMap<(String, String), String> = HashMap::new();
    for r in rows {
        let k = (r.scope.clone(), r.scope_key.clone());
        if out.contains_key(&k) {
            continue;
        }
        let label = if r.scope == "role" {
            let name = packs::role_name(Some(&r.scope_key));
            if name.is_empty() { r.scope_key.clone() } else { name }
        } else if r.scope == "member" {
            match member::Entity::find_by_id(r.scope_key.as_str()).one(session).await? {
                Some(m) => m.name,
                None => r.scope_key.clone(),
            }
        } else {
            match ticket::Entity::find_by_id(r.scope_key.as_str()).one(session).await? {
                Some(t) => format!("{} · {}", r.scope_key, t.title),
                None => r.scope_key.clone(),
            }
        };
        out.insert(k, label);
    }
    Ok(out)
}

/// A note for the API and MCP.
pub fn note_dict(r: &ai_memory_note::Model) -> Value {
    json!({
        "id": r.id,
        "scope": r.scope,
        "scope_key": r.scope_key,
        "text": r.text,
        "kind": r.kind,
        "tokens": estimate_tokens(Some(&r.text)),
        "written_by": r.written_by,
        "source_run_id": r.source_run_id,
        "source_ticket_id": r.source_ticket_id,
        "uses": r.uses,
        "last_used_at": r.last_used_at,
        "created_at": r.created_at,
        "updated_at": r.updated_at,
    })
}

// ---------------------------------------------------------------------------
// Hygiene: flag what went stale, for a person to decide
// ---------------------------------------------------------------------------

static PATH: LazyLock<Option<FancyRegex>> = LazyLock::new(|| {
    FancyRegex::new(concat!(
        r"(?<![\w@:/.-])((?:[\w.-]+/)*[\w-]+\.(?:py|tsx?|jsx?|mjs|cjs|md|json|toml|ya?ml|css|scss|html|sql|sh|txt|cfg|ini|lock|go|rs|java|kt|rb|php|cs|swift|vue|svelte))(?![\w/])",
        r#"|(?<![\w@:/.-])((?:[\w.-]+/){1,}[\w.-]*/?)(?=[\s,.;:)"'`]|$)"#
    ))
    .ok()
});
static WORD: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"[a-z0-9_]{4,}").ok());
static NEGATION: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(?i)\b(not|never|no longer|don't|do not|instead|stop|avoid)\b").ok());
const STOP: [&str; 21] = [
    "this", "that", "with", "from", "they", "them", "when", "what", "then", "than", "have", "must", "should", "into",
    "only", "always", "never", "does", "every", "before", "after",
];

/// File and folder paths a text names (`server/models.py`, `ui/src/`), without URLs.
pub fn paths_in(text: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let Some(re) = PATH.as_ref() else { return found };
    for m in re.captures_iter(text).flatten() {
        let raw = m.get(1).or_else(|| m.get(2)).map(|g| g.as_str()).filter(|s| !s.is_empty()).unwrap_or("");
        let raw = raw.trim_matches(['`', '\'', '"']);
        let p = raw.trim_end_matches(['/', '.']);
        if p.is_empty() || p.contains("://") || p.starts_with("http") || p.starts_with("www.") {
            continue;
        }
        if found.iter().any(|f| f == p) {
            continue;
        }
        if !raw.contains('/') && !p.contains('.') {
            continue;
        }
        found.push(p.to_string());
    }
    found
}

fn words(text: &str) -> HashSet<String> {
    let Some(re) = WORD.as_ref() else { return HashSet::new() };
    re.find_iter(&text.to_lowercase()).map(|m| m.as_str().to_string()).filter(|w| !STOP.contains(&w.as_str())).collect()
}

/// Whether a text says "not", "never", "no longer", "instead"... (`_NEGATION.search(text)`).
pub fn negates(text: &str) -> bool {
    NEGATION.as_ref().is_some_and(|re| re.is_match(text))
}

/// Word overlap of two texts (0 to 1).
pub fn similarity(a: &str, b: &str) -> f64 {
    let (wa, wb) = (words(a), words(b));
    if wa.is_empty() || wb.is_empty() {
        return 0.0;
    }
    wa.intersection(&wb).count() as f64 / wa.union(&wb).count() as f64
}

/// The folders the project's AIs work in: the worktrees' main checkout and each member's working folder.
pub async fn repo_roots(session: &Session, project_id: &str) -> Result<Vec<PathBuf>, DbErr> {
    let settings = store::get_settings(session, project_id).await?;
    let cfg = ops::get(Some(&settings));
    let mut candidates: Vec<String> = Vec::new();
    if let Some(Value::Object(w)) = cfg.get("worktrees").filter(|v| kb_base::pyjson::truthy(v)) {
        if let Some(Value::String(repo)) = w.get("repo").filter(|v| kb_base::pyjson::truthy(v)) {
            candidates.push(repo.clone());
        }
    }
    for m in ai_team::Entity::find().filter(ai_team::Column::ProjectId.eq(project_id)).all(session).await? {
        if let Some(dir) = m.working_dir.filter(|d| !d.is_empty()) {
            candidates.push(dir);
        }
    }
    let mut found: Vec<PathBuf> = Vec::new();
    for c in candidates {
        let p = PathBuf::from(pypath::expanduser(&c));
        if p.is_dir() && !found.contains(&p) {
            found.push(p);
        }
    }
    Ok(found)
}

fn missing(paths: &[String], roots: &[PathBuf]) -> Vec<String> {
    let mut out = Vec::new();
    for p in paths {
        let rel = p.trim_start_matches(['.', '/']);
        if Path::new(p).is_absolute() {
            if !Path::new(p).exists() {
                out.push(p.clone());
            }
            continue;
        }
        if !roots.iter().any(|r| r.join(rel).exists()) {
            out.push(p.clone());
        }
    }
    out
}

/// What a person should look at again: `{lesson or note id: [{kind, text, other_id?}]}`, in the order the ids were first
/// flagged.
///
/// - `missing_path`: it names a file or folder none of the project's checkouts has (moved or deleted). Only when the
///   board knows where the repository is.
/// - `newer`: a newer kept lesson (or a newer note of the same scope) says something close; when one of the two
///   negates ("never", "instead", "no longer"), it may contradict the older one.
pub async fn flags(session: &Session, project_id: &str) -> Result<Vec<(String, Vec<Map<String, Value>>)>, DbErr> {
    let mut out: Vec<(String, Vec<Map<String, Value>>)> = Vec::new();
    fn add(out: &mut Vec<(String, Vec<Map<String, Value>>)>, id: &str, flag: Map<String, Value>) {
        match out.iter_mut().find(|(k, _)| k == id) {
            Some(slot) => slot.1.push(flag),
            None => out.push((id.to_string(), vec![flag])),
        }
    }
    let kept = ai_lesson::Entity::find()
        .filter(ai_lesson::Column::ProjectId.eq(project_id))
        .filter(ai_lesson::Column::State.eq("kept"))
        .all(session)
        .await?;
    let all_notes = notes(session, project_id, None, None).await?;
    let roots = repo_roots(session, project_id).await?;
    // (id, text, group, created_at)
    let mut items: Vec<(String, String, String, String)> =
        kept.iter().map(|r| (r.id.clone(), r.text.clone(), "lesson".to_string(), r.created_at.clone())).collect();
    items.extend(
        all_notes
            .iter()
            .map(|n| (n.id.clone(), n.text.clone(), format!("{}:{}", n.scope, n.scope_key), n.created_at.clone())),
    );
    if !roots.is_empty() {
        for (item_id, text, _group, _at) in &items {
            let gone = missing(&paths_in(text), &roots);
            if !gone.is_empty() {
                let shown: Vec<String> = gone.iter().take(3).map(|g| format!("`{g}`")).collect();
                let mut flag = Map::new();
                flag.insert("kind".into(), json!("missing_path"));
                flag.insert(
                    "text".into(),
                    json!(format!("Names {}, which the repository no longer has. Still true?", shown.join(", "))),
                );
                flag.insert("paths".into(), json!(gone));
                add(&mut out, item_id, flag);
            }
        }
    }
    let mut by_group: Vec<(String, Vec<(String, String, String)>)> = Vec::new();
    for (item_id, text, group, at) in items {
        match by_group.iter_mut().find(|(g, _)| *g == group) {
            Some(slot) => slot.1.push((item_id, text, at)),
            None => by_group.push((group, vec![(item_id, text, at)])),
        }
    }
    for (_group, mut rows) in by_group {
        rows.sort_by(|a, b| a.2.cmp(&b.2));
        for (i, (old_id, old_text, _at)) in rows.iter().enumerate() {
            for (new_id, new_text, _nat) in &rows[i + 1..] {
                if similarity(old_text, new_text) < SIMILAR {
                    continue;
                }
                let contradicts = negates(old_text) != negates(new_text);
                let mut flag = Map::new();
                flag.insert("kind".into(), json!("newer"));
                flag.insert("other_id".into(), json!(new_id));
                let lead = if contradicts {
                    "A newer one may contradict it: “"
                } else {
                    "A newer one says something close: “"
                };
                flag.insert(
                    "text".into(),
                    json!(format!("{lead}{}”. Keep one.", new_text.chars().take(120).collect::<String>())),
                );
                add(&mut out, old_id, flag);
                break;
            }
        }
    }
    Ok(out)
}
