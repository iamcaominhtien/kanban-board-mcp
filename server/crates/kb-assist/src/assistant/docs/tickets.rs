//! From a page to tickets (`services/assistant/docs.py`, lines 644 to 723): ticket drafts from the open items of a
//! page, and creating the reviewed drafts (no model).

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex, MutexGuard};

use kb_base::{activity, pyjson, pytext, time};
use kb_doctext::docs_text;
use kb_board::tickets::{self, NewTicket};
use kb_db::Session;
use kb_db::entities::{docs_ai_job, project};
use kb_db::sea_orm::EntityTrait;
use serde_json::{Map, Value, json};

use super::{TurnExtra, boxed, clip, cost, get, get_or, input, items, merge, text_of, turn};
use crate::docs_ai::errors::{DocsAiError, Error};
use crate::docs_ai::jobs::HandlerFuture;

/// What one creation made, to undo it.
struct Created {
    /// The tickets made, in order.
    ids: Vec<String>,
    /// The page the tickets came from.
    page_id: String,
    /// The person's draft before the ticket ids were put in it (`None`: they had no draft).
    draft_before: Option<String>,
    /// The draft text the creation saved (`None`: the draft was not changed).
    draft_after: Option<String>,
}

/// `_UNDO`: what each creation made, by undo token.
static UNDO: LazyLock<Mutex<HashMap<String, Created>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn undo() -> MutexGuard<'static, HashMap<String, Created>> {
    UNDO.lock().unwrap_or_else(|e| e.into_inner())
}

/// `_norm`: a line's text for comparing (white space squeezed, lower case).
fn norm(text: &str) -> String {
    pytext::split(text).join(" ").to_lowercase()
}

/// `line_text`: the plain text of a list line, with no bullet, checkbox or formatting (what a draft's `text` holds).
fn line_text(raw: &str) -> String {
    pytext::strip(&docs_text::strip_inline(&docs_text::strip_block_prefix(raw, false))).to_string()
}

/// What `chip_lines` made of a draft text.
struct Chipped {
    /// The Markdown with each ticket key at the end of its line.
    markdown: String,
    /// How many lines got a key.
    replaced: usize,
    /// The texts that are on no line of the Markdown.
    missing: Vec<String>,
}

/// `_chip_lines`: appends each ticket key to the line whose text is the draft's text (outside code fences).
///
/// `drafts` holds `(text, ticket key)`; a line takes one draft, the first that matches it. A line that already has
/// the key is left as it is and does not count.
fn chip_lines(base: &str, drafts: &[(String, String)]) -> Chipped {
    let mut lines: Vec<String> = base.split('\n').map(str::to_string).collect();
    let mut used: HashSet<usize> = HashSet::new();
    let mut index: HashMap<String, Vec<usize>> = HashMap::new();
    let mut in_fence = false;
    for (i, raw) in lines.iter().enumerate() {
        if docs_text::is_fence(raw) {
            in_fence = !in_fence;
            continue;
        }
        if !in_fence {
            index.entry(norm(&line_text(raw))).or_default().push(i);
        }
    }
    let mut replaced = 0;
    let mut missing = Vec::new();
    for (text, key) in drafts {
        let at = index.get(&norm(text)).and_then(|rows| rows.iter().copied().find(|i| !used.contains(i)));
        let Some(at) = at.filter(|_| !text.is_empty()) else {
            missing.push(text.clone());
            continue;
        };
        used.insert(at);
        if !lines[at].contains(key.as_str()) {
            lines[at] = format!("{} {key}", lines[at].trim_end());
            replaced += 1;
        }
    }
    Chipped { markdown: lines.join("\n"), replaced, missing }
}

/// Ticket drafts from the open items of a page; nothing is created.
pub fn tickets_draft_job(job: docs_ai_job::Model) -> HandlerFuture {
    boxed(async move {
        let mut inputs = Map::new();
        inputs.insert("page_id".into(), json!(job.page_id));
        inputs.insert("selection".into(), get(&input(&job), "selection"));
        let out = turn(&job, "docs-tickets", inputs, None, TurnExtra::default()).await?;
        let data = out.data();
        let mut drafts = Vec::new();
        for d in items(data.get("drafts")) {
            let Some(d) = d.as_object() else { continue };
            if !d.get("title").is_some_and(pyjson::truthy) {
                continue;
            }
            drafts.push(json!({
                "title": clip(&text_of(&get_or(d, "title", json!(""))), 200),
                "text": get_or(d, "text", json!("")),
                "type": get_or(d, "type", json!("task")),
                "line": get(d, "line"),
            }));
        }
        let mut result = Map::new();
        result.insert("drafts".into(), Value::Array(drafts));
        result.insert("skipped".into(), get_or(&data, "skipped", json!([])));
        Ok(merge(result, cost(&out)))
    })
}

/// `d.get(key)` as text, when it is true.
fn given<'a>(d: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    d.get(key).filter(|v| pyjson::truthy(v)).and_then(Value::as_str)
}

/// Whether to put each ticket's key on the draft line it came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKeys {
    /// Leave the person's draft of the page as it is.
    Keep,
    /// Append the key to the line whose text is the draft's text, in the caller's draft of the page.
    Put,
}

/// Create the reviewed drafts as tickets and link them to the page. No model.
///
/// With `link` each ticket is linked to the page. With `keys` set to `LineKeys::Put` each ticket's key is appended to
/// the line of the page text that the draft came from (the caller's draft of the page, else the published text; the
/// result is saved as the caller's draft).
///
/// Returns `{tickets, undo_token, replaced, not_replaced, linked, draft_markdown}`: `replaced` is how many lines got a
/// key, `not_replaced` the draft texts that were on no line, `linked` how many tickets were linked and
/// `draft_markdown` the text saved as the draft (`null` when the draft was not changed).
///
/// # Errors
/// `invalid` for a project that does not exist; `not_found` and the other Docs errors for the page.
pub async fn create_tickets(
    session: &Session,
    page_id: &str,
    by: &str,
    drafts: &[Value],
    link: bool,
    keys: LineKeys,
) -> Result<Map<String, Value>, Error> {
    let page = kb_docs::docs::get_page(session, page_id, false, true).await?;
    let mut made: Vec<Value> = Vec::new();
    // (text, ticket id) of the drafts made in the page's own project: the ones that have a line on the page
    let mut on_page: Vec<(String, String)> = Vec::new();
    let mut linked = 0;
    for d in drafts {
        let empty = Map::new();
        let d = d.as_object().unwrap_or(&empty);
        let title = pytext::strip(given(d, "title").unwrap_or("")).to_string();
        if title.is_empty() {
            continue;
        }
        let project_id = given(d, "project_id").unwrap_or(page.project_id.as_str()).to_string();
        if project::Entity::find_by_id(project_id.as_str()).one(session).await?.is_none() {
            return Err(DocsAiError::new("invalid", "That project does not exist.").into());
        }
        let mut new = NewTicket::new(&title);
        new.r#type = given(d, "type").unwrap_or("task");
        new.status = given(d, "column").unwrap_or("backlog");
        new.description = given(d, "text").unwrap_or("");
        new.due_date = given(d, "due_date");
        new.assignee = given(d, "assignee_id");
        new.created_by = Some(by);
        let ticket = tickets::create_ticket(session, &project_id, new).await?;
        made.push(json!({
            "id": ticket.id,
            "title": ticket.title,
            "project_id": project_id,
            "status": ticket.status,
            "type": ticket.r#type,
            "assignee": ticket.assignee,
            "due_date": ticket.due_date,
        }));
        if project_id == page.project_id {
            on_page.push((pytext::strip(given(d, "text").unwrap_or("")).to_string(), ticket.id.clone()));
        }
        // a link that fails does not undo the ticket
        if link && kb_docs::docs::link_ticket_doc(session, &ticket.id, &page.id).await.is_ok() {
            linked += 1;
        }
    }
    let mut draft_before = None;
    let mut draft_after = None;
    let mut replaced = 0;
    let mut not_replaced: Vec<String> = Vec::new();
    if keys == LineKeys::Put && !on_page.is_empty() {
        let draft = kb_docs::docs::draft_for(session, &page.id, &activity::current_actor()).await?;
        draft_before = draft.map(|d| d.markdown);
        let base = match &draft_before {
            Some(text) => text.clone(),
            None => kb_docs::docs::latest_version(session, &page).await?.map(|v| v.markdown).unwrap_or_default(),
        };
        let chipped = chip_lines(&base, &on_page);
        replaced = chipped.replaced;
        not_replaced = chipped.missing;
        if replaced > 0 {
            kb_docs::docs::save_draft(session, &page.id, &chipped.markdown, None, None).await?;
            draft_after = Some(chipped.markdown);
        }
    }
    let token = time::uuid4_hex();
    let ids: Vec<String> = made.iter().filter_map(|t| t["id"].as_str().map(str::to_string)).collect();
    undo().insert(
        token.clone(),
        Created { ids, page_id: page.id.clone(), draft_before, draft_after: draft_after.clone() },
    );
    let mut out = Map::new();
    out.insert("tickets".into(), Value::Array(made));
    out.insert("undo_token".into(), json!(token));
    out.insert("replaced".into(), json!(replaced));
    out.insert("not_replaced".into(), json!(not_replaced));
    out.insert("linked".into(), json!(linked));
    out.insert("draft_markdown".into(), json!(draft_after));
    Ok(out)
}

/// Delete the tickets a creation made and put the draft text back when it was not changed since.
///
/// Returns `{deleted, draft_restored, removed}`: how many tickets were deleted, whether the person's draft is back
/// as it was before the ticket keys went in, and the ids deleted.
///
/// # Errors
/// `not_found` when the token is unknown or was used already.
pub async fn undo_tickets(session: &Session, token: &str, _by: &str) -> Result<Map<String, Value>, Error> {
    let entry = undo().remove(token);
    let Some(entry) = entry else {
        return Err(DocsAiError::new("not_found", "Nothing to undo: that creation is too old.").into());
    };
    let mut removed = Vec::new();
    for tid in &entry.ids {
        if tickets::delete_ticket(session, tid).await? {
            removed.push(json!(tid));
        }
    }
    let mut restored = false;
    if let Some(after) = &entry.draft_after {
        let draft = kb_docs::docs::draft_for(session, &entry.page_id, &activity::current_actor()).await?;
        if draft.is_some_and(|d| &d.markdown == after) {
            match &entry.draft_before {
                None => {
                    kb_docs::docs::discard_draft(session, &entry.page_id).await?;
                }
                Some(before) => {
                    kb_docs::docs::save_draft(session, &entry.page_id, before, None, None).await?;
                }
            }
            restored = true;
        }
    }
    let mut out = Map::new();
    out.insert("deleted".into(), json!(removed.len()));
    out.insert("draft_restored".into(), json!(restored));
    out.insert("removed".into(), Value::Array(removed));
    Ok(out)
}
