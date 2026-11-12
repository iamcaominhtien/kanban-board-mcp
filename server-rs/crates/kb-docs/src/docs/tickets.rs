//! Ticket mentions, backlinks, page stats and the ticket-to-page links (`services/docs.py` lines 1659-2209).

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use kb_base::{pyjson, time};
use kb_db::Session;
use kb_db::entities::{canvas, docs_link, docs_page, project as project_table, ticket};
use kb_db::sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, EntityTrait, IntoActiveModel, ModelTrait, QueryFilter, Set,
};
use kb_doctext::docs_text::page_ref_contexts;
use regex::Regex;
use serde_json::{Map, Value, json};

use super::pages::{all_pages, get_page};
use super::refs::{PageRef, aliases_by_page, headings_by_page, resolve_page_ref, title_aliases};
use crate::docs_search::path_titles;
use crate::util::word_count;
use crate::{Result, docs_err, docs_search};

/// `_json_list`: a JSON text read as a list (anything else is an empty one).
pub(crate) fn json_list(raw: &str) -> Vec<Value> {
    match pyjson::loads(if raw.is_empty() { "[]" } else { raw }) {
        Some(Value::Array(list)) => list,
        _ => Vec::new(),
    }
}

/// `str(value)` of a JSON value that was truthy.
fn text_of(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => pyjson::py_str(other),
    }
}

/// `(origin, detail, text)` for every text field of a ticket that can hold a `[[reference]]`.
///
/// `detail` names the exact place for the "Mentioned in test case TC-3" wording.
pub fn ticket_texts(t: &ticket::Model) -> Vec<(String, String, String)> {
    let mut out = vec![("description".to_string(), String::new(), t.description.clone())];
    let truthy = |v: Option<&Value>| v.is_some_and(pyjson::truthy);
    for c in json_list(&t.comments) {
        if c.is_object() && truthy(c.get("text")) && !truthy(c.get("deleted_at")) {
            out.push(("comment".into(), String::new(), text_of(&c["text"])));
        }
    }
    for ac in json_list(&t.acceptance_criteria) {
        if ac.is_object() && truthy(ac.get("text")) {
            out.push(("acceptance_criterion".into(), String::new(), text_of(&ac["text"])));
        }
    }
    for tc in json_list(&t.test_cases) {
        if !tc.is_object() {
            continue;
        }
        let code = if truthy(tc.get("code")) { text_of(&tc["code"]) } else { String::new() };
        for key in ["description", "expected_result", "notes", "test_data"] {
            if let Some(s) = tc.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()) {
                out.push(("test_case".into(), code.clone(), s.to_string()));
            }
        }
    }
    for w in json_list(&t.work_log) {
        if w.is_object() && truthy(w.get("note")) {
            out.push(("debug_note".into(), String::new(), text_of(&w["note"])));
        }
    }
    out
}

static CANVAS_REF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\(canvas:(cv_[0-9a-f]{8})(?:#((?:b|p)_[0-9a-f]{8}))?\)")
        .expect("the canvas reference pattern is valid")
});

/// `canvases.refs_in`: the canvas ids a markdown text references, in order, without repeats.
pub fn canvas_refs_in(markdown: &str) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for m in CANVAS_REF.captures_iter(markdown) {
        let id = m[1].to_string();
        if !seen.contains(&id) {
            seen.push(id);
        }
    }
    seen
}

async fn tickets_mentioning_pages(session: &Session, project_id: &str) -> Result<Vec<ticket::Model>> {
    Ok(ticket::Entity::find()
        .filter(ticket::Column::ProjectId.eq(project_id))
        .filter(
            Condition::any()
                .add(ticket::Column::Description.contains("[["))
                .add(ticket::Column::Comments.contains("[["))
                .add(ticket::Column::AcceptanceCriteria.contains("[["))
                .add(ticket::Column::TestCases.contains("[["))
                .add(ticket::Column::WorkLog.contains("[[")),
        )
        .all(session)
        .await?)
}

/// A `[[page]]` mention in a ticket's text, resolved to a page.
pub struct Mention {
    /// The ticket that mentions the page.
    pub ticket: ticket::Model,
    /// Where in the ticket (`description`, `comment`...).
    pub origin: String,
    /// The exact place (a test case code).
    pub detail: String,
    /// The page it names.
    pub page_id: String,
    /// The heading text of the section it names.
    pub section: Option<String>,
    /// The sentence it is in.
    pub context: String,
    /// About 120 characters around it.
    pub excerpt: String,
    /// The `#section` part as written.
    pub anchor: Option<String>,
}

/// Every [[page]] mention in ticket descriptions/comments, resolved to a page.
pub async fn ticket_mentions(session: &Session, project_id: &str) -> Result<Vec<Mention>> {
    let tickets = tickets_mentioning_pages(session, project_id).await?;
    if tickets.is_empty() {
        return Ok(Vec::new());
    }
    let pages = all_pages(session, project_id, false).await?;
    let headings = headings_by_page(session, &pages).await?;
    let ids: Vec<String> = pages.iter().map(|p| p.id.clone()).collect();
    let aliases = aliases_by_page(session, &ids).await?;
    let renamed = title_aliases(session, &ids).await?;
    let mut out = Vec::new();
    for t in tickets {
        for (origin, detail, body) in ticket_texts(&t) {
            if !body.contains("[[") {
                continue;
            }
            for r in page_ref_contexts(&body) {
                let request = PageRef { title: &r.title, anchor: r.anchor.as_deref(), by_slug: false };
                let res = resolve_page_ref(&pages, &[], &request, &headings, Some(&aliases), Some(&renamed));
                let Some(page_id) = res.get("page_id").and_then(Value::as_str) else { continue };
                let (mut context, mut excerpt) = (r.context.clone(), r.excerpt.clone());
                let old = &r.title;
                let new_title = res.get("title").and_then(Value::as_str).unwrap_or("");
                if !old.contains('/') && new_title.to_lowercase() != old.to_lowercase() {
                    // written with an old title: show the new one
                    context = context.replacen(old.as_str(), new_title, 1);
                    excerpt = excerpt.replacen(&format!("[[{old}"), &format!("[[{new_title}"), 1);
                }
                out.push(Mention {
                    ticket: t.clone(),
                    origin: origin.clone(),
                    detail: detail.clone(),
                    page_id: page_id.to_string(),
                    section: res.get("section").and_then(Value::as_str).map(str::to_string),
                    context,
                    excerpt,
                    anchor: r.anchor.clone(),
                });
            }
        }
    }
    Ok(out)
}

/// The sentence and excerpt of the reference a link row stands for (the link's snippet when the page no longer has
/// it).
async fn page_row_context(
    session: &Session,
    link: &docs_link::Model,
    src: &docs_page::Model,
) -> Result<(String, String)> {
    let contents = docs_search::contents(session, std::slice::from_ref(src)).await?;
    let wanted = link.target_title.clone().unwrap_or_default().to_lowercase();
    let refs: Vec<_> = page_ref_contexts(contents.get(&src.id).map(String::as_str).unwrap_or(""))
        .into_iter()
        .filter(|r| r.title.to_lowercase() == wanted)
        .collect();
    for r in &refs {
        if r.section == link.source_section {
            return Ok((r.context.clone(), r.excerpt.clone()));
        }
    }
    Ok(match refs.first() {
        Some(r) => (r.context.clone(), r.excerpt.clone()),
        None => (link.snippet.clone(), link.snippet.clone()),
    })
}

/// The heading text behind a section slug of a page (the slug itself when the heading is gone).
pub async fn section_label(session: &Session, page: &docs_page::Model, slug: Option<&str>) -> Result<Option<String>> {
    let Some(slug) = slug.filter(|s| !s.is_empty()) else { return Ok(None) };
    let headings = headings_by_page(session, std::slice::from_ref(page)).await?;
    let found = headings.get(&page.id).and_then(|h| h.iter().find(|(s, _)| s == slug)).map(|(_, text)| text.clone());
    Ok(Some(found.unwrap_or_else(|| slug.to_string())))
}

fn ticket_row(
    t: &ticket::Model,
    origin: &str,
    detail: &str,
    context: &str,
    excerpt: &str,
    anchor: Option<&str>,
) -> Value {
    json!({
        "ticket_id": t.id,
        "title": t.title,
        "status": t.status,
        "origin": origin,
        "detail": detail,
        "context": context,
        "excerpt": excerpt,
        "target_anchor": anchor,
    })
}

/// Pages and tickets that reference this page (the 'Referenced by' panel): `{pages, tickets}`.
pub async fn backlinks(session: &Session, page_id: &str) -> Result<Map<String, Value>> {
    let page = get_page(session, page_id, false, false).await?;
    let rows = docs_link::Entity::find()
        .filter(docs_link::Column::TargetPageId.eq(page.id.as_str()))
        .filter(docs_link::Column::Origin.eq("page"))
        .all(session)
        .await?;
    let mut seen: HashSet<(String, Option<String>)> = HashSet::new();
    let mut pages_out: Vec<Value> = Vec::new();
    for link in rows {
        let src = docs_page::Entity::find_by_id(link.source_page_id.as_str()).one(session).await?;
        let Some(src) = src.filter(|s| s.deleted_at.as_deref().is_none_or(str::is_empty) && s.id != page.id) else {
            continue;
        };
        let key = (src.id.clone(), link.source_section.clone());
        if !seen.insert(key) {
            continue;
        }
        let parent = match src.parent_id.as_deref().filter(|p| !p.is_empty()) {
            Some(p) => docs_page::Entity::find_by_id(p).one(session).await?,
            None => None,
        };
        let (context, excerpt) = page_row_context(session, &link, &src).await?;
        let label = section_label(session, &src, link.source_section.as_deref()).await?.filter(|l| !l.is_empty());
        pages_out.push(json!({
            "page_id": src.id,
            "title": src.title,
            "in": label.or_else(|| parent.map(|p| p.title)),
            "snippet": link.snippet,
            "origin": "page",
            "context": context,
            "excerpt": excerpt,
            "target_anchor": link.target_anchor,
        }));
    }
    let mut tickets_out: Vec<Value> = Vec::new();
    let mut seen_tickets: HashSet<(String, String, String)> = HashSet::new();
    for m in ticket_mentions(session, &page.project_id).await? {
        let key = (m.ticket.id.clone(), m.origin.clone(), m.detail.clone());
        if m.page_id != page.id || seen_tickets.contains(&key) {
            continue;
        }
        seen_tickets.insert(key);
        tickets_out.push(ticket_row(&m.ticket, &m.origin, &m.detail, &m.context, &m.excerpt, m.anchor.as_deref()));
    }
    let manual = docs_link::Entity::find()
        .filter(docs_link::Column::SourcePageId.eq(page.id.as_str()))
        .filter(docs_link::Column::Origin.eq("manual"))
        .filter(docs_link::Column::TargetTicketId.is_not_null())
        .all(session)
        .await?;
    for link in manual {
        let Some(tid) = link.target_ticket_id.as_deref() else { continue };
        let t = ticket::Entity::find_by_id(tid).one(session).await?;
        if let Some(t) = t {
            if seen_tickets.insert((t.id.clone(), "manual".into(), String::new())) {
                tickets_out.push(ticket_row(&t, "manual", "", "", "", None));
            }
        }
    }
    if page.kind == "canvas" {
        canvas_backlinks(session, &page, &mut tickets_out, &mut seen_tickets).await?;
    }
    let mut out = Map::new();
    out.insert("pages".into(), Value::Array(pages_out));
    out.insert("tickets".into(), Value::Array(tickets_out));
    Ok(out)
}

/// A canvas page lists the tickets that show it ("KAN-142 uses this canvas") in its backlinks.
async fn canvas_backlinks(
    session: &Session,
    page: &docs_page::Model,
    tickets_out: &mut Vec<Value>,
    seen_tickets: &mut HashSet<(String, String, String)>,
) -> Result<()> {
    let Some(c) = canvas::Entity::find().filter(canvas::Column::PageId.eq(page.id.as_str())).one(session).await? else {
        return Ok(());
    };
    let tickets =
        ticket::Entity::find().filter(ticket::Column::ProjectId.eq(page.project_id.as_str())).all(session).await?;
    for t in tickets {
        for (origin, detail, body) in ticket_texts(&t) {
            if canvas_refs_in(&body).contains(&c.id)
                && seen_tickets.insert((t.id.clone(), origin.clone(), detail.clone()))
            {
                tickets_out.push(ticket_row(
                    &t,
                    &origin,
                    &detail,
                    &format!("Shows this canvas: {}", c.title),
                    "",
                    None,
                ));
            }
        }
    }
    Ok(())
}

/// Return word, linked-ticket and inbound-link counts for a page: `{words, linked_tickets, inbound_links}`.
pub async fn page_stats(session: &Session, page: &docs_page::Model, markdown: &str) -> Result<Value> {
    let inbound = docs_link::Entity::find()
        .filter(docs_link::Column::TargetPageId.eq(page.id.as_str()))
        .filter(docs_link::Column::Origin.eq("page"))
        .all(session)
        .await?;
    let sources: HashSet<String> = inbound.into_iter().map(|l| l.source_page_id).filter(|s| *s != page.id).collect();
    let mut live = 0;
    for sid in &sources {
        let src = docs_page::Entity::find_by_id(sid.as_str()).one(session).await?;
        if src.is_some_and(|s| s.deleted_at.as_deref().is_none_or(str::is_empty)) {
            live += 1;
        }
    }
    let mut tickets: HashSet<String> = HashSet::new();
    let outbound = docs_link::Entity::find()
        .filter(docs_link::Column::SourcePageId.eq(page.id.as_str()))
        .filter(docs_link::Column::TargetTicketId.is_not_null())
        .all(session)
        .await?;
    tickets.extend(outbound.into_iter().filter_map(|l| l.target_ticket_id).filter(|t| !t.is_empty()));
    for m in ticket_mentions(session, &page.project_id).await? {
        if m.page_id == page.id {
            tickets.insert(m.ticket.id.clone());
        }
    }
    Ok(json!({"words": word_count(markdown), "linked_tickets": tickets.len(), "inbound_links": live}))
}

fn origin_order(origin: &str) -> usize {
    match origin {
        "description" => 0,
        "acceptance_criterion" => 1,
        "test_case" => 2,
        "comment" => 3,
        "debug_note" => 4,
        "manual" => 5,
        _ => 6,
    }
}

async fn ticket_or_404(session: &Session, ticket_id: &str) -> Result<ticket::Model> {
    match ticket::Entity::find_by_id(ticket_id).one(session).await? {
        Some(t) => Ok(t),
        None => docs_err(404, "ticket_not_found", "Ticket not found"),
    }
}

/// The rows `docs_for_ticket` builds, without repeats of (page, origin, detail).
struct Rows {
    out: Vec<Map<String, Value>>,
    seen: HashSet<(String, String, String)>,
}

impl Rows {
    fn add(
        &mut self,
        page: &docs_page::Model,
        by_id: &HashMap<String, docs_page::Model>,
        origin: &str,
        section: Option<&str>,
        snippet: &str,
        detail: &str,
    ) {
        if !self.seen.insert((page.id.clone(), origin.to_string(), detail.to_string())) {
            return;
        }
        let mut m = Map::new();
        m.insert("page_id".into(), json!(page.id));
        m.insert("project_id".into(), json!(page.project_id));
        m.insert("title".into(), json!(page.title));
        m.insert("path".into(), json!(path_titles(page, by_id)));
        m.insert("section".into(), json!(section));
        m.insert("snippet".into(), json!(snippet));
        m.insert("origin".into(), json!(origin));
        m.insert("detail".into(), json!(detail));
        m.insert("version".into(), json!(page.version));
        self.out.push(m);
    }
}

/// Pages tied to a ticket: mentioned in it (description/comment), linked by hand, or mentioning it.
pub async fn docs_for_ticket(session: &Session, ticket_id: &str) -> Result<Vec<Map<String, Value>>> {
    let t = ticket::Entity::find_by_id(ticket_id).one(session).await?;
    let proj = match &t {
        Some(t) => project_table::Entity::find_by_id(t.project_id.as_str()).one(session).await?,
        None => None,
    };
    if let (Some(_), Some(p)) = (&t, &proj) {
        if !p.docs_enabled {
            return Ok(Vec::new());
        }
    }
    let pages = match &t {
        Some(t) => all_pages(session, &t.project_id, false).await?,
        None => Vec::new(),
    };
    let mut by_id: HashMap<String, docs_page::Model> = pages.iter().map(|p| (p.id.clone(), p.clone())).collect();
    let mut rows = Rows { out: Vec::new(), seen: HashSet::new() };

    if let Some(t) = &t {
        let texts = ticket_texts(t);
        let joined = texts.iter().map(|(_, _, x)| x.as_str()).collect::<Vec<_>>().join(" ");
        if !pages.is_empty() && joined.contains("[[") {
            let headings = headings_by_page(session, &pages).await?;
            let ids: Vec<String> = pages.iter().map(|p| p.id.clone()).collect();
            let aliases = aliases_by_page(session, &ids).await?;
            let renamed = title_aliases(session, &ids).await?;
            for (origin, detail, body) in &texts {
                if !body.contains("[[") {
                    continue;
                }
                for r in page_ref_contexts(body) {
                    let request = PageRef { title: &r.title, anchor: r.anchor.as_deref(), by_slug: false };
                    let res = resolve_page_ref(&pages, &[], &request, &headings, Some(&aliases), Some(&renamed));
                    if let Some(pid) = res.get("page_id").and_then(Value::as_str) {
                        if let Some(page) = by_id.get(pid).cloned() {
                            rows.add(
                                &page,
                                &by_id,
                                origin,
                                res.get("section").and_then(Value::as_str),
                                &r.context,
                                detail,
                            );
                        }
                    }
                }
            }
        }
    }
    let links = docs_link::Entity::find().filter(docs_link::Column::TargetTicketId.eq(ticket_id)).all(session).await?;
    for link in links {
        let src = docs_page::Entity::find_by_id(link.source_page_id.as_str()).one(session).await?;
        let Some(src) = src.filter(|s| s.deleted_at.as_deref().is_none_or(str::is_empty)) else { continue };
        by_id.entry(src.id.clone()).or_insert_with(|| src.clone());
        let label = section_label(session, &src, link.source_section.as_deref()).await?;
        rows.add(
            &src,
            &by_id,
            if link.origin == "manual" { "manual" } else { "page" },
            label.as_deref(),
            &link.snippet,
            "",
        );
    }
    if let Some(t) = &t {
        canvas_rows(session, t, &by_id, &mut rows).await?;
    }
    rows.out.sort_by(|a, b| {
        let key = |m: &Map<String, Value>| {
            (origin_order(m["origin"].as_str().unwrap_or("")), m["title"].as_str().unwrap_or("").to_lowercase())
        };
        key(a).cmp(&key(b))
    });
    Ok(rows.out)
}

const ORIGIN_WORDS: [(&str, &str); 8] = [
    ("description", "the ticket's description links it"),
    ("acceptance_criterion", "a criterion links it"),
    ("test_case", "a test case links it"),
    ("comment", "a comment links it"),
    ("debug_note", "a work-log note links it"),
    ("manual", "linked by hand"),
    ("page", "the page mentions this ticket"),
    ("canvas", "a canvas on the page is linked"),
];

/// The Docs pages tied to a ticket, one row per page, for an agent: `{page_id, title, path, sections, why,
/// version}`. A page tied in several ways is one row with every reason. `hidden` lists page ids to leave out.
pub async fn linked_pages(session: &Session, ticket_id: &str, hidden: Option<&HashSet<String>>) -> Result<Vec<Value>> {
    let mut by_page: Vec<(String, Map<String, Value>)> = Vec::new();
    for r in docs_for_ticket(session, ticket_id).await? {
        let pid = r["page_id"].as_str().unwrap_or("").to_string();
        if hidden.is_some_and(|h| h.contains(&pid)) {
            continue;
        }
        let at = match by_page.iter().position(|(id, _)| *id == pid) {
            Some(at) => at,
            None => {
                let mut row = Map::new();
                row.insert("page_id".into(), r["page_id"].clone());
                row.insert("title".into(), r["title"].clone());
                row.insert("path".into(), r["path"].clone());
                row.insert("sections".into(), json!([]));
                row.insert("why".into(), json!([]));
                row.insert("version".into(), r["version"].clone());
                by_page.push((pid, row));
                by_page.len() - 1
            }
        };
        let row = &mut by_page[at].1;
        if let Some(section) = r.get("section").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            let sections = row["sections"].as_array_mut().expect("sections is a list");
            if !sections.iter().any(|s| s == section) {
                sections.push(json!(section));
            }
        }
        let origin = r["origin"].as_str().unwrap_or("");
        let why = ORIGIN_WORDS.iter().find(|(k, _)| *k == origin).map_or(origin, |(_, w)| *w);
        let whys = row["why"].as_array_mut().expect("why is a list");
        if !whys.iter().any(|w| w == why) {
            whys.push(json!(why));
        }
    }
    Ok(by_page.into_iter().map(|(_, row)| Value::Object(row)).collect())
}

/// A canvas shown in a ticket (inline or as a Docs page) is listed with the layers icon, as a referenced page is.
async fn canvas_rows(
    session: &Session,
    t: &ticket::Model,
    by_id: &HashMap<String, docs_page::Model>,
    rows: &mut Rows,
) -> Result<()> {
    let mut seen: HashSet<(String, String)> = HashSet::new();
    for (origin, detail, body) in ticket_texts(t) {
        for cid in canvas_refs_in(&body) {
            if !seen.insert((cid.clone(), origin.clone())) {
                continue;
            }
            let c = canvas::Entity::find_by_id(cid.as_str()).one(session).await?;
            let Some(c) = c.filter(|c| {
                c.deleted_at.as_deref().is_none_or(str::is_empty)
                    && c.project_id.as_deref() == Some(t.project_id.as_str())
            }) else {
                continue;
            };
            if let Some(page) = c.page_id.as_deref().and_then(|p| by_id.get(p)) {
                let before = rows.out.len();
                rows.add(page, by_id, &origin, None, &c.title, &detail);
                for r in &mut rows.out[before..] {
                    r.insert("kind".into(), json!("canvas"));
                    r.insert("canvas_id".into(), json!(c.id));
                }
                continue;
            }
            let mut m = Map::new();
            m.insert("page_id".into(), json!(c.id));
            m.insert("project_id".into(), json!(c.project_id));
            m.insert("title".into(), json!(c.title));
            m.insert("path".into(), json!([]));
            m.insert("section".into(), Value::Null);
            m.insert(
                "snippet".into(),
                json!(format!("{} board{}", c.board_count, if c.board_count != 1 { "s" } else { "" })),
            );
            m.insert("origin".into(), json!(origin));
            m.insert("detail".into(), json!(detail));
            m.insert("version".into(), json!(c.version));
            m.insert("kind".into(), json!("canvas"));
            m.insert("canvas_id".into(), json!(c.id));
            rows.out.push(m);
        }
    }
    Ok(())
}

fn mention_words(origin: &str) -> &'static str {
    match origin {
        "page" => "the page names the ticket",
        "description" => "the ticket's description names the page",
        "comment" => "a comment of the ticket names the page",
        "acceptance_criterion" => "an acceptance criterion names the page",
        "test_case" => "a test case names the page",
        "debug_note" => "a debug note names the page",
        _ => "the text names it",
    }
}

/// A Linked docs change in the ticket's Activity, as a [[reference]] added or removed by hand (TicketDocRefs E).
async fn ticket_activity(session: &Session, t: &ticket::Model, field: &str, from: Value, to: Value) -> Result<()> {
    let mut log = t.activity_log.clone();
    kb_base::activity::record(&mut log, field, from, to, Some("Linked docs"), None);
    let mut row = kb_db::edit(t.clone());
    row.activity_log = Set(log);
    row.updated_at = Set(time::now_iso());
    row.update(session).await?;
    Ok(())
}

/// Manually link a ticket to a page.
///
/// Returns the link row; when a mention already links them, that row, with `already_linked` and a `message` (no
/// manual link is added). Fails with 422 if the page and ticket are in different projects.
pub async fn link_ticket_doc(session: &Session, ticket_id: &str, page_id: &str) -> Result<Map<String, Value>> {
    let t = ticket_or_404(session, ticket_id).await?;
    let page = get_page(session, page_id, false, false).await?;
    if page.project_id != t.project_id {
        return docs_err(422, "bad_project", "The page and the ticket belong to different projects");
    }
    let existing = docs_link::Entity::find()
        .filter(docs_link::Column::SourcePageId.eq(page.id.as_str()))
        .filter(docs_link::Column::TargetTicketId.eq(ticket_id))
        .filter(docs_link::Column::Origin.eq("manual"))
        .one(session)
        .await?;
    if existing.is_none() {
        // A page and a ticket tied by a mention (the ticket's text names the page, or the page names the ticket) are
        // already linked both ways; a second, manual link would only draw the page twice on the ticket.
        let mention = docs_for_ticket(session, ticket_id)
            .await?
            .into_iter()
            .find(|r| r["page_id"] == json!(page.id) && r["origin"] != json!("manual"));
        if let Some(mention) = mention {
            let mut out = mention.clone();
            out.insert("already_linked".into(), json!("mention"));
            out.insert(
                "message".into(),
                json!(format!(
                    "Already linked by a mention ({}): nothing was added. A manual link is for a page the text does not name; if the mention is removed later, link it then.",
                    mention_words(mention["origin"].as_str().unwrap_or(""))
                )),
            );
            return Ok(out);
        }
        let mut link = docs_link::new();
        link.source_page_id = Set(page.id.clone());
        link.target_ticket_id = Set(Some(ticket_id.to_string()));
        link.origin = Set("manual".to_string());
        link.snippet = Set(String::new());
        link.insert(session).await?;
        ticket_activity(session, &t, "doc_ref_added", Value::Null, json!(page.title)).await?;
        session.commit().await?;
    }
    let rows = docs_for_ticket(session, ticket_id).await?;
    match rows.into_iter().find(|r| r["page_id"] == json!(page.id) && r["origin"] == json!("manual")) {
        Some(row) => Ok(row),
        None => Err(crate::Error::Other("the manual link is not listed".to_string())),
    }
}

/// Remove a manual ticket-to-page link: `{removed}` with the number of links removed.
pub async fn unlink_ticket_doc(session: &Session, ticket_id: &str, page_id: &str) -> Result<Map<String, Value>> {
    let t = ticket_or_404(session, ticket_id).await?;
    let rows = docs_link::Entity::find()
        .filter(docs_link::Column::SourcePageId.eq(page_id))
        .filter(docs_link::Column::TargetTicketId.eq(ticket_id))
        .filter(docs_link::Column::Origin.eq("manual"))
        .all(session)
        .await?;
    let mut removed = 0;
    for link in rows {
        link.delete(session).await?;
        removed += 1;
    }
    if removed > 0 {
        let page = docs_page::Entity::find_by_id(page_id).one(session).await?;
        let from = page.map(|p| p.title).unwrap_or_else(|| page_id.to_string());
        ticket_activity(session, &t, "doc_ref_removed", json!(from), Value::Null).await?;
    }
    session.commit().await?;
    let mut out = Map::new();
    out.insert("removed".into(), json!(removed));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canvas_references_come_in_order_without_repeats() {
        let md = "a (canvas:cv_0123abcd) b (canvas:cv_ffffffff#b_00000001) c (canvas:cv_0123abcd#p_12345678) (canvas:cv_xyz)";
        assert_eq!(canvas_refs_in(md), vec!["cv_0123abcd", "cv_ffffffff"]);
    }
}
