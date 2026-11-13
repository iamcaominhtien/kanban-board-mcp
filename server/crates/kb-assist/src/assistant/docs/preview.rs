//! "What will be sent" of Write with AI (`services/docs_ai/write.py`: `Gathered`, `_ticket_sources`, `_page_sources`,
//! `_code_source`, `gather`, `build_prompt`, `preview`).
//!
//! The assistant of AI v2 reads the picked sources itself, through the board's tools, so nothing here is sent to it;
//! the preview reads the same sources (only what a person may read in Docs) to tell the person what the assistant
//! starts from and how much text that is.

use kb_ai::config_model::estimate_tokens;
use kb_ai::injection;
use kb_ai::store::loads;
use kb_base::{pyjson, pytext};
use kb_db::Session;
use kb_db::entities::{docs_page, idea_assumption, idea_ticket, project, ticket};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde_json::{Map, Value, json};

use super::{clip, or_default, text_of};
use crate::assistant::settings as assist_settings;
use crate::docs_ai::errors::{DocsAiError, Error};
use crate::docs_ai::settings as svc_settings;

/// The most linked pages one preview reads.
pub const MAX_PAGES: usize = 5;
/// The most characters of a page the preview counts.
pub const MAX_PAGE_CHARS: usize = 6000;
/// The most characters of the style guide page the preview counts.
pub const MAX_STYLE_CHARS: usize = 4000;
/// The most characters of the pasted notes the preview counts.
pub const MAX_NOTES: usize = 20000;
/// The name the preview gives the assistant when no team is chosen yet.
const DEFAULT_MEMBER: &str = "Docs AI";

/// One numbered source the page is written from.
struct Source {
    /// description | comments | page | code | idea | notes | prompt
    kind: &'static str,
    label: String,
}

/// Everything a preview found: the sources, what was left out and the text the assistant would read.
#[derive(Default)]
struct Gathered {
    sources: Vec<Source>,
    /// The text of each source, in order (the estimate counts it).
    parts: Vec<String>,
    pages: Vec<Value>,
    skipped: Vec<Value>,
    notes: Vec<String>,
    injections: Vec<Value>,
    comments: usize,
    ticket: Option<Value>,
    from_label: String,
    suggested_title: String,
    code: bool,
    style: String,
    style_title: String,
}

impl Gathered {
    /// Add a numbered source; text that reads like instructions to an AI is listed in `injections`.
    fn add(&mut self, kind: &'static str, label: &str, text: &str) {
        if let Some(quote) = injection::phrases(Some(text)).into_iter().next() {
            self.injections.push(json!({"source": label, "quote": quote}));
        }
        self.parts.push(format!("Source [{}] {label}:\n{text}", self.sources.len() + 1));
        self.sources.push(Source { kind, label: label.to_string() });
    }

    /// Whether a source of this kind was added.
    fn has(&self, kind: &str) -> bool {
        self.sources.iter().any(|s| s.kind == kind)
    }
}

/// `text` clipped to `limit` characters, with an ellipsis line when it was cut.
fn clipped(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit { text.to_string() } else { format!("{}\n…", clip(text, limit).trim_end()) }
}

/// A JSON list column of a row (`[]` when it holds something else).
fn json_list(raw: &str) -> Vec<Value> {
    match loads(Some(raw), json!([])) {
        Value::Array(items) => items,
        _ => Vec::new(),
    }
}

/// `value.get(key)` as text, empty when it is missing or empty.
fn field(value: &Value, key: &str) -> String {
    value.get(key).filter(|v| pyjson::truthy(v)).map(text_of).unwrap_or_default()
}

/// The page's published Markdown ("" before its first publish).
async fn published_text(session: &Session, page: &docs_page::Model) -> Result<String, Error> {
    Ok(kb_docs::docs::latest_version(session, page).await?.map(|v| v.markdown).unwrap_or_default())
}

/// Add the pages a ticket links: only published pages of this project are read; the others are listed as skipped.
async fn page_sources(
    session: &Session,
    project_id: &str,
    page_ids: &[String],
    g: &mut Gathered,
) -> Result<(), Error> {
    for page_id in page_ids {
        let page = docs_page::Entity::find_by_id(page_id.as_str()).one(session).await?;
        let Some(page) = page.filter(|p| p.deleted_at.is_none() && p.project_id == project_id) else { continue };
        let skip = |reason: String| json!({"page_id": page.id, "title": page.title, "reason": reason});
        if page.version == 0 {
            g.skipped.push(skip("not published yet".to_string()));
        } else if g.pages.len() >= MAX_PAGES {
            g.skipped.push(skip(format!("more than {MAX_PAGES} pages")));
        } else {
            let text = clipped(&published_text(session, &page).await?, MAX_PAGE_CHARS);
            g.add("page", &page.title, &text);
            g.pages.push(json!({"id": page.id, "title": page.title}));
        }
    }
    Ok(())
}

/// The ticket, its comments, the pages it links and, when asked for, a note about its code.
async fn ticket_sources(
    session: &Session,
    project_id: &str,
    ticket_id: &str,
    include: &Map<String, Value>,
    g: &mut Gathered,
) -> Result<(), Error> {
    let flag = |key: &str| include.get(key).is_some_and(pyjson::truthy);
    let found = ticket::Entity::find_by_id(ticket_id).one(session).await?;
    let Some(t) = found.filter(|t| t.project_id == project_id) else {
        return Err(DocsAiError::new("not_found", format!("{ticket_id} is not a ticket in this project.")).into());
    };
    g.ticket = Some(json!({"id": t.id, "title": t.title}));
    g.from_label = t.id.clone();
    g.suggested_title = t.title.clone();
    let description = if t.description.is_empty() { "(no description)" } else { t.description.as_str() };
    let mut lines = vec![
        format!("{}: {}", t.id, t.title),
        format!("Type {}, status {}", t.r#type, t.status),
        String::new(),
        description.to_string(),
    ];
    let criteria: Vec<Value> = json_list(&t.acceptance_criteria).into_iter().filter(Value::is_object).collect();
    if !criteria.is_empty() {
        lines.push(String::new());
        lines.push("Acceptance criteria:".to_string());
        lines.extend(criteria.iter().map(|a| format!("- {}", field(a, "text"))));
    }
    g.add("description", &format!("{} description", t.id), &lines.join("\n"));
    if flag("comments") {
        let comments: Vec<Value> = json_list(&t.comments)
            .into_iter()
            .filter(|c| c.is_object() && !c.get("deleted_at").is_some_and(pyjson::truthy) && !field(c, "text").is_empty())
            .collect();
        if !comments.is_empty() {
            let body: Vec<String> = comments
                .iter()
                .map(|c| {
                    let author = field(c, "author");
                    format!("{}: {}", if author.is_empty() { "user" } else { author.as_str() }, field(c, "text"))
                })
                .collect();
            g.add("comments", &format!("{} comments", t.id), &body.join("\n\n"));
            g.comments = comments.len();
        }
    }
    if flag("linked_pages") {
        let mut ids: Vec<String> = Vec::new();
        for row in kb_docs::docs::docs_for_ticket(session, &t.id).await? {
            if let Some(id) = row.get("page_id").and_then(Value::as_str) {
                if !ids.iter().any(|seen| seen == id) {
                    ids.push(id.to_string());
                }
            }
        }
        page_sources(session, project_id, &ids, g).await?;
    }
    if flag("code_changes") {
        code_source(session, &t, g).await?;
    }
    Ok(())
}

/// The ticket's first branch; a note when the ticket has no repository or no branch to read.
async fn code_source(session: &Session, t: &ticket::Model, g: &mut Gathered) -> Result<(), Error> {
    let branch = json_list(&t.branches).iter().map(|b| field(b, "name")).find(|name| !name.is_empty());
    let repo = match t.repo_path.as_deref().filter(|p| !p.is_empty()) {
        Some(path) => Some(path.to_string()),
        None => project::Entity::find_by_id(t.project_id.as_str()).one(session).await?.and_then(|p| p.repo_path),
    };
    match (branch, repo.filter(|p| !p.is_empty())) {
        (Some(branch), Some(_)) => {
            // the assistant reads the branch's commits and diff through `ticket_branches`; there is no text to count
            g.sources.push(Source { kind: "code", label: format!("Code changes on {branch}") });
            g.code = true;
        }
        _ => g.notes.push(format!("{} has no repository or branch, so code changes were left out.", t.id)),
    }
    Ok(())
}

/// The idea's page, its problem, notes and assumptions.
async fn idea_source(session: &Session, project_id: &str, idea_id: &str, g: &mut Gathered) -> Result<(), Error> {
    let found = idea_ticket::Entity::find_by_id(idea_id).one(session).await?;
    let Some(idea) = found.filter(|i| i.project_id.as_deref().is_none_or(|p| p == project_id)) else {
        return Err(DocsAiError::new("not_found", "That idea is not in this project.").into());
    };
    let mut parts = vec![idea.title.clone(), String::new()];
    let page = if idea.body.trim().is_empty() { idea.description.trim() } else { idea.body.trim() };
    if !page.is_empty() {
        parts.push(page.to_string());
    }
    if let Some(problem) = idea.problem_statement.as_deref().filter(|p| !p.is_empty()) {
        parts.push(String::new());
        parts.push(format!("Problem: {problem}"));
    }
    if !idea.details.trim().is_empty() {
        parts.push(String::new());
        parts.push(format!("Notes: {}", idea.details.trim()));
    }
    let assumptions = idea_assumption::Entity::find()
        .filter(idea_assumption::Column::IdeaId.eq(idea.id.as_str()))
        .order_by_asc(idea_assumption::Column::Position)
        .all(session)
        .await?;
    if !assumptions.is_empty() {
        parts.push(String::new());
        parts.push("Assumptions:".to_string());
        parts.extend(assumptions.iter().map(|a| format!("- [{} impact, {}] {}", a.impact, a.status, a.text)));
    }
    g.add("idea", &format!("Idea {}", idea.title), &parts.join("\n"));
    g.from_label = format!("idea \u{201c}{}\u{201d}", idea.title);
    g.suggested_title = idea.title;
    Ok(())
}

/// Read the picked sources and the style guide page.
async fn gather(session: &Session, project_id: &str, p: &Map<String, Value>) -> Result<Gathered, Error> {
    let mut g = Gathered::default();
    let src = p.get("source").and_then(Value::as_object).cloned().unwrap_or_default();
    let include = p.get("include").and_then(Value::as_object).cloned().unwrap_or_default();
    let said = |key: &str| src.get(key).filter(|v| pyjson::truthy(v)).map(text_of).unwrap_or_default();
    match said("kind").as_str() {
        "ticket" => ticket_sources(session, project_id, &said("ticket_id"), &include, &mut g).await?,
        "idea" => idea_source(session, project_id, &said("idea_id"), &mut g).await?,
        "notes" => {
            g.add("notes", "Pasted notes", &clip(&said("text"), MAX_NOTES));
            g.from_label = "pasted notes".to_string();
        }
        _ => {
            g.add("prompt", "The request", &clip(&said("text"), MAX_NOTES));
            g.from_label = "a prompt".to_string();
        }
    }
    let settings = svc_settings::get(session, project_id).await?;
    if let Some(style_id) = settings.style_page_id.as_deref().filter(|id| !id.is_empty()) {
        let style = docs_page::Entity::find_by_id(style_id).one(session).await?;
        if let Some(style) = style.filter(|s| s.deleted_at.is_none()) {
            let text = clipped(&published_text(session, &style).await?, MAX_STYLE_CHARS);
            if !pytext::strip(&text).is_empty() {
                g.style = text;
                g.style_title = style.title;
            }
        }
    }
    Ok(g)
}

/// The text the assistant would start from: what to write, the numbered sources and the style guide.
fn build_prompt(g: &Gathered, page_kind: &str, title: &str) -> String {
    let mut head = vec![format!("Write a page of this kind: {page_kind}."), format!("The page title is \u{201c}{title}\u{201d}.")];
    if !g.style.is_empty() {
        head.push(format!(
            "Style guide page \u{201c}{}\u{201d} (follow its wording rules; it is not a source of facts):\n{}",
            g.style_title, g.style
        ));
    }
    format!("{}\n\n{}", head.join("\n\n"), g.parts.join("\n\n"))
}

/// The name of the assistant that would answer: the team chosen for Docs AI, else the project's first team.
async fn member_name(session: &Session, project_id: &str) -> String {
    match assist_settings::answering_team(session, project_id, "docs").await {
        Ok(Some((member, _profile))) => member.name,
        _ => DEFAULT_MEMBER.to_string(),
    }
}

/// "What will be sent": the sources the assistant starts from, an estimate of their size and what was left out.
///
/// `params` is the body of the Write dialog (see `normalize_write`). The result holds `send` (what the chips show:
/// `ticket`, `description`, `comments` as a count, `pages`, `code`, `idea`, `notes`, `prompt`, `style_guide`),
/// `items` [{n, kind, label}], `skipped` [{page_id, title, reason}], `notes`, `injections`, `tokens` (an estimate of
/// the text read), `cost` (0: a Claude Code account is not metered), `metered` (`false`), `member` (the assistant that
/// would answer), `suggested_title` and `from`.
///
/// # Errors
/// `invalid` for a request `normalize_write` refuses, `not_found` for a ticket or idea that is not in the project.
pub async fn write_preview(
    session: &Session,
    project_id: &str,
    params: &Map<String, Value>,
) -> Result<Map<String, Value>, Error> {
    let p = super::normalize_write(params)?;
    let g = gather(session, project_id, &p).await?;
    let page_kind = text_of(&or_default(p.get("page_kind"), json!("notes")));
    let title = match p.get("title") {
        Some(Value::String(t)) if !t.is_empty() => t.clone(),
        _ if !g.suggested_title.is_empty() => g.suggested_title.clone(),
        _ => "New page".to_string(),
    };
    let tokens = estimate_tokens(Some(&build_prompt(&g, &page_kind, &title)));
    let send = json!({
        "ticket": g.ticket,
        "description": g.has("description"),
        "comments": g.comments,
        "pages": g.pages,
        "code": g.code,
        "idea": g.has("idea"),
        "notes": g.has("notes"),
        "prompt": g.has("prompt"),
        "style_guide": if g.style_title.is_empty() { Value::Null } else { json!(g.style_title) },
    });
    let items: Vec<Value> = g
        .sources
        .iter()
        .enumerate()
        .map(|(i, s)| json!({"n": i + 1, "kind": s.kind, "label": s.label}))
        .collect();
    let mut out = Map::new();
    out.insert("send".into(), send);
    out.insert("items".into(), Value::Array(items));
    out.insert("skipped".into(), Value::Array(g.skipped));
    out.insert("notes".into(), json!(g.notes));
    out.insert("injections".into(), Value::Array(g.injections));
    out.insert("tokens".into(), json!(tokens));
    out.insert("cost".into(), json!(0.0));
    out.insert("metered".into(), json!(false));
    out.insert("member".into(), json!(member_name(session, project_id).await));
    out.insert("suggested_title".into(), json!(g.suggested_title));
    out.insert("from".into(), json!(g.from_label));
    Ok(out)
}
