//! Send a Docs page's comment threads to the AI that should work them (AI v2, KBM-24)
//! (`services/docs_ai/handoff.py`, 848 lines).
//!
//! A comment thread on a page is a request: "this is wrong", "explain this", "add a section". The AI that answers on
//! the page (the page's assistant) knows the page but did not write it; the team that built it (on a ticket)
//! remembers why. So the person picks who gets the threads:
//!
//! 1. **the team of a ticket**: the ticket's lead gets one note (the threads, structured) in the ticket's own
//!    conversation, changes the page with `docs_write(edit)`, replies in each thread and closes the ones that are
//!    settled (the skill `docs-comment-threads` says when);
//! 2. **the Board AI**: it reads the threads, finds the ticket, and sends the note to its team (`ai_run message`) or
//!    answers;
//! 3. **the page's assistant** (the `docs:<page>` conversation): for questions, searches and small changes.
//!
//! Tickets are offered by how they relate to the page (built it, linked to it, named by it, named in the thread, the
//! team that edited it last), then any ticket of the project. A ticket with no team can be given one in the same step.
//!
//! The comments are what people (or AIs) wrote: they go to the AI fenced as data, never as instructions. At most
//! `MAX_THREADS` threads, `COMMENTS_PER_THREAD` comments each.
//!
//! The Python module is one file; here it is this file (lines 1 to 495: the helpers, the teams and their state,
//! `targets`), `note` (the note: `build_note`) and `send` (`threads_of_ticket`, `send`).

use std::collections::HashMap;

use kb_base::pyjson;
use kb_db::Session;
use kb_db::entities::{ai_run, docs_comment, docs_comment_thread, docs_link, docs_page, docs_version, member, ticket};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use kb_doctext::docs_anchors::{self, Block};
use kb_doctext::docs_text::{DocsError, Reference, heading_anchors, parse_references};
use serde_json::{Map, Value, json};

use super::errors::Error;
use crate::assistant::docs as assistant_docs;
use crate::assistant::engine;

mod note;
mod send;

pub use note::{INSTRUCTION, build_note};
pub use send::{DESTINATIONS, SendOpts, open_count_for_ticket, send, threads_of_ticket};

/// The `trigger` a run is woken with by a note of threads.
pub const TRIGGER: &str = "docs_threads";
/// The most threads sent at once.
pub const MAX_THREADS: usize = 20;
/// The most comments of a thread the note shows.
pub const COMMENTS_PER_THREAD: usize = 40;
/// The most characters of a comment the note shows.
pub const COMMENT_CHARS: usize = 2000;
/// The most characters of a thread's quote the note shows.
pub const QUOTE_CHARS: usize = 300;
/// The most other tickets offered.
pub const OTHERS_LIMIT: usize = 300;
/// The longest note.
pub const MAX_NOTE_CHARS: usize = 120_000;
/// The states of a run that holds its ticket.
pub const ACTIVE: [&str; 4] = ["queued", "starting", "running", "needs_input"];

/// How a ticket relates to a page, as the picker's badge says it.
pub const BADGES: [(&str, &str); 8] = [
    ("built", "Built this page"),
    ("section", "Named in this section"),
    ("above", "Named in a section above"),
    ("thread", "Named in this thread"),
    ("linked", "Linked to this page"),
    ("named", "Named in this page"),
    ("mentions", "Mentions this page"),
    ("editor", "Team that edited it last"),
];

/// `DocsError(status, code, message)` as an `Error`.
pub(crate) fn docs_err(status: u16, code: &str, message: impl Into<String>) -> Error {
    Error::Docs(kb_docs::Error::Docs(DocsError::new(status, code, message)))
}

/// `_fence`: text a person or an AI wrote, as data: the AI is told never to follow what is inside.
pub fn fence(source: &str, text: &str) -> String {
    let safe = text.replace("</untrusted>", "<\\/untrusted>");
    format!("<untrusted source=\"{source}\">\n{safe}\n</untrusted>")
}

/// `_page`: a live page, or 404 `not_found`.
pub(crate) async fn page_of(session: &Session, page_id: &str) -> Result<docs_page::Model, Error> {
    match docs_page::Entity::find_by_id(page_id).one(session).await? {
        Some(page) if page.deleted_at.as_deref().is_none_or(str::is_empty) => Ok(page),
        _ => Err(docs_err(404, "not_found", "The page is gone.")),
    }
}

/// `_text`: the page's latest published text.
pub(crate) async fn text_of(session: &Session, page: &docs_page::Model) -> Result<String, Error> {
    let latest = kb_docs::docs::pages::latest_version(session, page).await?;
    Ok(latest.map(|v| v.markdown).unwrap_or_default())
}

/// `_sections_up`: each heading's slug with the slugs of the headings above it, nearest first (h3 -> its h2 -> its
/// h1).
pub fn sections_up(markdown: &str) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    let mut stack: Vec<(usize, String)> = Vec::new();
    for h in heading_anchors(markdown) {
        while stack.last().is_some_and(|(level, _)| *level >= h.level) {
            stack.pop();
        }
        let mut chain = vec![h.slug.clone()];
        chain.extend(stack.iter().rev().map(|(_, slug)| slug.clone()));
        out.insert(h.slug.clone(), chain);
        stack.push((h.level, h.slug));
    }
    out
}

/// `_section_of`: the heading a thread sits under: as stored, else found from where its quote is (a comment made by
/// a tool).
pub fn section_of(thread: &docs_comment_thread::Model, blocks: &[Block]) -> Option<String> {
    if let Some(section) = thread.anchor_section.as_deref().filter(|s| !s.is_empty()) {
        return Some(section.to_string());
    }
    if let Some(pos) = thread.anchor_pos {
        let pos = usize::try_from(pos).unwrap_or(0);
        let mut found = None;
        for b in blocks {
            if b.start > pos {
                break;
            }
            found = b.section.clone();
        }
        return found;
    }
    let quote = thread.anchor_quote.clone().unwrap_or_default();
    blocks.iter().find(|b| !quote.is_empty() && b.text.contains(&quote)).and_then(|b| b.section.clone())
}

/// `_is_board_note`: one of the board's own lines ("Sent to ...").
fn is_board_note(c: &docs_comment::Model) -> bool {
    let Some(ai) = c.ai.as_deref().filter(|a| !a.is_empty()) else { return false };
    pyjson::loads(ai).is_some_and(|v| v.get("kind").and_then(Value::as_str) == Some("sent"))
}

/// `_comments`: what the thread's people said, oldest first (the board's own lines are not what anyone said).
pub(crate) async fn comments(session: &Session, thread_id: &str) -> Result<Vec<docs_comment::Model>, Error> {
    let rows = docs_comment::Entity::find()
        .filter(docs_comment::Column::ThreadId.eq(thread_id))
        .order_by_asc(docs_comment::Column::CreatedAt)
        .order_by_asc(docs_comment::Column::Id)
        .all(session)
        .await?;
    Ok(rows.into_iter().filter(|c| !is_board_note(c)).collect())
}

/// `_keys_in`: the ticket keys the comments name, upper-cased.
fn keys_in(comments: &[docs_comment::Model]) -> Vec<String> {
    let mut out = Vec::new();
    for c in comments {
        let plain = kb_docs::docs_comments::plain_mentions(&c.body);
        for r in parse_references(&plain) {
            if let Reference::Ticket(t) = r {
                out.push(t.key.to_uppercase());
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Teams and their state
// ---------------------------------------------------------------------------

/// The members of a project, in the order `members_of` gives them (a Python dict keyed by id).
pub struct Members(pub Vec<member::Model>);

impl Members {
    /// `members.get(id)`.
    pub fn get(&self, id: &str) -> Option<&member::Model> {
        self.0.iter().find(|m| m.id == id)
    }

    /// The AI members.
    pub fn ai(&self) -> impl Iterator<Item = &member::Model> {
        self.0.iter().filter(|m| m.kind == "ai")
    }
}

/// `{m.id: m for m in members_of(session, project_id)}`.
pub(crate) async fn members_by_id(session: &Session, project_id: &str) -> Result<Members, Error> {
    Ok(Members(kb_doctext::docs_access::members_of(session, project_id).await?))
}

/// `_active_by_ticket`: the run that is going (or queued) on each ticket of the project: the one that holds it.
pub(crate) async fn active_by_ticket(
    session: &Session,
    project_id: &str,
) -> Result<HashMap<String, ai_run::Model>, Error> {
    let rows = ai_run::Entity::find()
        .filter(ai_run::Column::ProjectId.eq(project_id))
        .filter(ai_run::Column::Kind.eq("team"))
        .filter(ai_run::Column::State.is_in(ACTIVE))
        .order_by_asc(ai_run::Column::QueuedAt)
        .all(session)
        .await?;
    let mut out: HashMap<String, ai_run::Model> = HashMap::new();
    for r in rows {
        if let Some(ticket_id) = r.ticket_id.clone().filter(|t| !t.is_empty()) {
            out.entry(ticket_id).or_insert(r);
        }
    }
    Ok(out)
}

/// The team state a run gives: `asking` (it waits for a person's answer), `working` (a run is going or queued).
fn run_state(run: Option<&ai_run::Model>) -> (&'static str, Value) {
    match run {
        Some(run) => (if run.state == "needs_input" { "asking" } else { "working" }, json!(run.number)),
        None => ("idle", Value::Null),
    }
}

/// `_team_of`: the team a note to the ticket reaches: its AI assignee, else (`look_back`) the team that ran on it
/// last. `state`: `working` (a run is going or queued), `asking` (it waits for a person's answer), `idle`.
pub(crate) async fn team_of(
    session: &Session,
    ticket: &ticket::Model,
    members: &Members,
    active: &HashMap<String, ai_run::Model>,
    look_back: bool,
) -> Result<Option<Value>, Error> {
    let run = active.get(&ticket.id);
    let mut found = members.get(ticket.assignee.as_deref().unwrap_or(""));
    if found.is_none_or(|m| m.kind != "ai") {
        found = None;
        if let Some(run) = run {
            found = members.get(&run.member_id);
        } else if look_back {
            let last: Option<String> = ai_run::Entity::find()
                .select_only()
                .column(ai_run::Column::MemberId)
                .filter(ai_run::Column::TicketId.eq(ticket.id.as_str()))
                .order_by_desc(ai_run::Column::QueuedAt)
                .limit(1)
                .into_tuple::<String>()
                .one(session)
                .await?;
            found = members.get(last.as_deref().unwrap_or(""));
        }
    }
    let Some(member) = found.filter(|m| m.kind == "ai") else { return Ok(None) };
    let (state, number) = run_state(run);
    Ok(Some(json!({"id": member.id, "name": member.name, "state": state, "run_number": number})))
}

/// `_ticket_row`.
fn ticket_row(ticket: &ticket::Model, team: Option<Value>, relations: Vec<Value>) -> Value {
    json!({
        "id": ticket.id,
        "title": ticket.title,
        "status": ticket.status,
        "relations": relations,
        "team": team,
    })
}

/// `_badge`.
fn badge(kind: &str) -> Value {
    let label = BADGES.iter().find(|(k, _)| *k == kind).map_or("", |(_, label)| *label);
    json!({"kind": kind, "label": label})
}

/// The tickets whose title says they built a page.
fn is_builder_title(title: &str) -> bool {
    title.starts_with("Write the page") || title.starts_with("Review the page")
}

/// `_builder_team`: the team that built the page: the one on its "Write the page" ticket, else the author of its
/// first version.
async fn builder_team(
    session: &Session,
    page: &docs_page::Model,
    members: &Members,
    built: &[&ticket::Model],
) -> Result<Value, Error> {
    for t in built {
        if let Some(m) = members.get(t.assignee.as_deref().unwrap_or("")).filter(|m| m.kind == "ai") {
            return Ok(json!({"id": m.id, "name": m.name}));
        }
    }
    let first: Option<String> = docs_version::Entity::find()
        .select_only()
        .column(docs_version::Column::Author)
        .filter(docs_version::Column::PageId.eq(page.id.as_str()))
        .order_by_asc(docs_version::Column::Version)
        .limit(1)
        .into_tuple::<String>()
        .one(session)
        .await?;
    let mut by_name: Vec<(String, &member::Model)> = Vec::new();
    for m in members.ai() {
        let key = kb_docs::util::casefold(&m.name);
        match by_name.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = m,
            None => by_name.push((key, m)),
        }
    }
    let wanted = kb_docs::util::casefold(first.as_deref().unwrap_or(""));
    let mut found = by_name.iter().find(|(k, _)| *k == wanted).map(|(_, m)| *m);
    if found.is_none() && by_name.len() == 1 {
        // the project has one team: it is the one
        found = Some(by_name[0].1);
    }
    Ok(found.map_or(Value::Null, |m| json!({"id": m.id, "name": m.name})))
}

/// `docs_work._ticket_ids`: the tickets a page mentions or is mentioned by, once each.
async fn ticket_ids(session: &Session, page_id: &str) -> Result<Vec<String>, Error> {
    let page = kb_docs::docs::get_page(session, page_id, false, false).await?;
    // only the tickets: the pages half of the backlinks reads and parses every page that links here
    let mut ids: Vec<String> = kb_docs::docs::ticket_backlinks(session, &page)
        .await?
        .iter()
        .filter_map(|t| t["ticket_id"].as_str().map(str::to_string))
        .collect();
    let out = docs_link::Entity::find()
        .filter(docs_link::Column::SourcePageId.eq(page.id.as_str()))
        .filter(docs_link::Column::TargetTicketId.is_not_null())
        .all(session)
        .await?;
    ids.extend(out.into_iter().filter_map(|l| l.target_ticket_id).filter(|k| !k.is_empty()));
    let mut unique: Vec<String> = Vec::new();
    for id in ids {
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    Ok(unique)
}

/// The team that built the page (see `_builder_team`), for a caller that has only the page: the team on the "Write
/// the page" / "Review the page" ticket tied to THIS page, else the author of its first version.
pub async fn builder_team_of(session: &Session, page: &docs_page::Model) -> Result<Option<Value>, Error> {
    let members = members_by_id(session, &page.project_id).await?;
    let mut built = Vec::new();
    for tid in ticket_ids(session, &page.id).await? {
        if let Some(t) = ticket::Entity::find_by_id(tid.as_str()).one(session).await? {
            if is_builder_title(&t.title) {
                built.push(t);
            }
        }
    }
    let refs: Vec<&ticket::Model> = built.iter().collect();
    Ok(Some(builder_team(session, page, &members, &refs).await?).filter(|v| !v.is_null()))
}

/// An insertion-ordered map from a ticket id to its row (a Python dict).
struct Tickets(Vec<(String, ticket::Model)>);

impl Tickets {
    fn contains(&self, id: &str) -> bool {
        self.0.iter().any(|(k, _)| k == id)
    }

    fn put(&mut self, id: &str, t: ticket::Model) {
        match self.0.iter_mut().find(|(k, _)| k == id) {
            Some(slot) => slot.1 = t,
            None => self.0.push((id.to_string(), t)),
        }
    }
}

/// `_number`: the number at the end of a ticket key.
fn number_of(key: &str) -> u128 {
    let tail = key.rsplit('-').next().unwrap_or("");
    if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) { tail.parse().unwrap_or(0) } else { 0 }
}

/// Who can receive the page's threads: tickets by how they relate to the page (and, per thread, to the thread),
/// every other ticket of the project, the project's teams, and the team that built the page.
///
/// Returns `{page_id, max_threads, tickets, threads, others, teams, builder_team, board_ai, page_assistant}`:
/// `tickets` are the ones tied to the page (each with `relations` badges and its `team` state), `threads` is one
/// entry per open thread (`default` ticket and `order` of ticket ids with the badge for that thread), `others` every
/// other ticket.
pub async fn targets(session: &Session, page_id: &str) -> Result<Map<String, Value>, Error> {
    let page = page_of(session, page_id).await?;
    let members = members_by_id(session, &page.project_id).await?;
    let active = active_by_ticket(session, &page.project_id).await?;

    // how the page relates to tickets (page level)
    let mut rel: Vec<(String, Vec<&'static str>)> = Vec::new();
    let mut sections: Vec<(String, Vec<String>)> = Vec::new();
    fn add(rel: &mut Vec<(String, Vec<&'static str>)>, tid: &str, kind: &'static str) {
        if tid.is_empty() {
            return;
        }
        match rel.iter_mut().find(|(k, _)| k == tid) {
            Some((_, kinds)) => {
                if !kinds.contains(&kind) {
                    kinds.push(kind);
                }
            }
            None => rel.push((tid.to_string(), vec![kind])),
        }
    }

    let links = docs_link::Entity::find()
        .filter(docs_link::Column::SourcePageId.eq(page.id.as_str()))
        .filter(docs_link::Column::TargetTicketId.is_not_null())
        .all(session)
        .await?;
    for link in &links {
        let tid = link.target_ticket_id.clone().unwrap_or_default();
        if link.origin == "manual" {
            add(&mut rel, &tid, "linked");
        } else {
            add(&mut rel, &tid, "named");
            if let Some(section) = link.source_section.as_deref().filter(|s| !s.is_empty()) {
                match sections.iter_mut().find(|(k, _)| *k == tid) {
                    Some((_, set)) => {
                        if !set.iter().any(|s| s == section) {
                            set.push(section.to_string());
                        }
                    }
                    None => sections.push((tid.clone(), vec![section.to_string()])),
                }
            }
        }
    }
    kb_docs::docs::get_page(session, &page.id, false, false).await?; // the reader check `backlinks` made
    for m in &kb_docs::docs::ticket_backlinks(session, &page).await? {
        let tid = m["ticket_id"].as_str().unwrap_or("");
        let kind = if m["origin"].as_str() != Some("manual") { "mentions" } else { "linked" };
        add(&mut rel, tid, kind);
    }
    let mut tickets = Tickets(Vec::new());
    for (tid, _) in &rel {
        if let Some(t) = ticket::Entity::find_by_id(tid.as_str()).one(session).await? {
            if t.project_id == page.project_id {
                tickets.put(tid, t);
            }
        }
    }
    let built_ids: Vec<String> =
        tickets.0.iter().filter(|(_, t)| is_builder_title(&t.title)).map(|(id, _)| id.clone()).collect();
    for id in &built_ids {
        add(&mut rel, id, "built");
    }
    // the team that edited the page last: the ticket it worked on most recently (a heuristic, not checked further)
    let last_author: Option<String> = docs_version::Entity::find()
        .select_only()
        .column(docs_version::Column::Author)
        .filter(docs_version::Column::PageId.eq(page.id.as_str()))
        .order_by_desc(docs_version::Column::Version)
        .limit(1)
        .into_tuple::<String>()
        .one(session)
        .await?;
    let wanted = kb_docs::util::casefold(last_author.as_deref().unwrap_or(""));
    let editor = members.ai().find(|m| kb_docs::util::casefold(&m.name) == wanted);
    if let Some(editor) = editor {
        let last_run = ai_run::Entity::find()
            .filter(ai_run::Column::MemberId.eq(editor.id.as_str()))
            .filter(ai_run::Column::ProjectId.eq(page.project_id.as_str()))
            .filter(ai_run::Column::TicketId.is_not_null())
            .order_by_desc(ai_run::Column::QueuedAt)
            .limit(1)
            .one(session)
            .await?;
        if let Some(ticket_id) = last_run.and_then(|r| r.ticket_id).filter(|t| !t.is_empty()) {
            if let Some(t) = ticket::Entity::find_by_id(ticket_id.as_str()).one(session).await? {
                let id = t.id.clone();
                tickets.put(&id, t);
                add(&mut rel, &id, "editor");
            }
        }
    }

    const ORDER: [&str; 5] = ["built", "linked", "named", "mentions", "editor"];
    let kinds_of = |tid: &str| -> Vec<&'static str> {
        rel.iter().find(|(k, _)| k == tid).map(|(_, kinds)| kinds.clone()).unwrap_or_default()
    };
    let rank = |tid: &str| -> (usize, String) {
        let best = kinds_of(tid).iter().filter_map(|k| ORDER.iter().position(|o| o == k)).min().unwrap_or(9);
        (best, tid.to_string())
    };
    let mut keys: Vec<String> = tickets.0.iter().map(|(k, _)| k.clone()).collect();
    keys.sort_by_key(|k| rank(k));
    let mut page_level: Vec<Value> = Vec::new();
    for tid in &keys {
        let Some((_, t)) = tickets.0.iter().find(|(k, _)| k == tid) else { continue };
        let mut kinds = kinds_of(tid);
        kinds.sort_by_key(|k| ORDER.iter().position(|o| o == k).unwrap_or(usize::MAX));
        let team = team_of(session, t, &members, &active, true).await?;
        page_level.push(ticket_row(t, team, kinds.iter().map(|k| badge(k)).collect()));
    }

    // per open thread: the section's tickets first, then above, then the ones its comments name, then the page's
    let text = text_of(session, &page).await?;
    let up = sections_up(&text);
    let blocks = docs_anchors::blocks_of(&text);
    let open_threads = docs_comment_thread::Entity::find()
        .filter(docs_comment_thread::Column::PageId.eq(page.id.as_str()))
        .filter(docs_comment_thread::Column::Status.eq("open"))
        .order_by_asc(docs_comment_thread::Column::CreatedAt)
        .all(session)
        .await?;
    let page_level_ids =
        |rows: &[Value]| -> Vec<String> { rows.iter().filter_map(|r| r["id"].as_str().map(str::to_string)).collect() };
    let mut per_thread: Vec<Value> = Vec::new();
    for th in &open_threads {
        let mut seen: Vec<(String, &'static str)> = Vec::new();
        let see = |seen: &mut Vec<(String, &'static str)>, tid: &str, kind: &'static str| {
            if !seen.iter().any(|(k, _)| k == tid) {
                seen.push((tid.to_string(), kind));
            }
        };
        if th.kind == "inline" {
            let chain = up.get(section_of(th, &blocks).as_deref().unwrap_or("")).cloned().unwrap_or_default();
            for (i, slug) in chain.iter().enumerate() {
                for (tid, secs) in &sections {
                    if secs.contains(slug) && tickets.contains(tid) {
                        see(&mut seen, tid, if i == 0 { "section" } else { "above" });
                    }
                }
            }
        }
        let named = keys_in(&comments(session, &th.id).await?);
        for key in named {
            let known =
                tickets.contains(&key) || ticket::Entity::find_by_id(key.as_str()).one(session).await?.is_some();
            if known {
                if !tickets.contains(&key) {
                    match ticket::Entity::find_by_id(key.as_str()).one(session).await? {
                        Some(t) if t.project_id == page.project_id => tickets.put(&key, t),
                        _ => continue,
                    }
                }
                see(&mut seen, &key, "thread");
            }
        }
        let mut ordered: Vec<(String, &str)> = seen.iter().map(|(k, kind)| (k.clone(), *kind)).collect();
        for id in page_level_ids(&page_level) {
            if !seen.iter().any(|(k, _)| *k == id) {
                ordered.push((id, ""));
            }
        }
        let mut pick: Option<String> =
            ordered.iter().find(|(tid, _)| seen.iter().any(|(k, _)| k == tid)).map(|(tid, _)| tid.clone());
        if pick.is_none() && page_level.len() == 1 {
            pick = page_level[0]["id"].as_str().map(str::to_string);
        }
        let order: Vec<Value> = ordered
            .iter()
            .map(|(tid, kind)| {
                let mut entry = Map::new();
                entry.insert("ticket_id".into(), json!(tid));
                if !kind.is_empty() {
                    entry.insert("badge".into(), badge(kind));
                }
                Value::Object(entry)
            })
            .collect();
        per_thread.push(json!({"thread_id": th.id, "default": pick, "order": order}));
    }
    // tickets a thread names that the page does not relate to are page-level rows too (so the UI can show them)
    for (tid, t) in &tickets.0 {
        if !page_level_ids(&page_level).iter().any(|id| id == tid) {
            let team = team_of(session, t, &members, &active, true).await?;
            page_level.push(ticket_row(t, team, Vec::new()));
        }
    }

    let taken: Vec<String> = page_level_ids(&page_level);

    // Only the four columns the list shows (a ticket row also carries its description, comments and logs), newest
    // first by the number in the key (the text order puts KAN-99 above KAN-100).
    let mut light: Vec<(String, String, String, Option<String>)> = ticket::Entity::find()
        .select_only()
        .columns([ticket::Column::Id, ticket::Column::Title, ticket::Column::Status, ticket::Column::Assignee])
        .filter(ticket::Column::ProjectId.eq(page.project_id.as_str()))
        .into_tuple::<(String, String, String, Option<String>)>()
        .all(session)
        .await?;
    // `sorted(reverse=True)` keeps rows with the same number in the order they came
    light.sort_by_key(|row| std::cmp::Reverse(number_of(&row.0)));
    let mut others: Vec<Value> = Vec::new();
    for (tid, title, status, assignee) in light.into_iter().take(OTHERS_LIMIT) {
        if taken.contains(&tid) {
            continue;
        }
        let run = active.get(&tid);
        // the same rule as `_team_of`: an assignee who is not an AI member is ignored, then the run's team
        let mut found = members.get(assignee.as_deref().unwrap_or(""));
        if found.is_none_or(|m| m.kind != "ai") {
            found = run.and_then(|r| members.get(&r.member_id));
        }
        let team = found.filter(|m| m.kind == "ai").map(|m| {
            let (state, number) = run_state(run);
            json!({"id": m.id, "name": m.name, "state": state, "run_number": number})
        });
        others.push(json!({"id": tid, "title": title, "status": status, "relations": [], "team": team}));
    }
    let mut teams: Vec<(String, Value)> =
        members.ai().map(|m| (kb_docs::util::casefold(&m.name), json!({"id": m.id, "name": m.name}))).collect();
    teams.sort_by(|a, b| a.0.cmp(&b.0));

    let docs_ai = assistant_docs::docs_ai_on(session, &page.project_id).await?;
    let ready =
        docs_ai && engine::ready(&page.project_id, "docs").await?.get("state").and_then(Value::as_str) == Some("ready");
    let built: Vec<&ticket::Model> =
        built_ids.iter().filter_map(|id| tickets.0.iter().find(|(k, _)| k == id).map(|(_, t)| t)).collect();
    let mut out = Map::new();
    out.insert("page_id".into(), json!(page.id));
    out.insert("max_threads".into(), json!(MAX_THREADS));
    out.insert("tickets".into(), Value::Array(page_level));
    out.insert("threads".into(), Value::Array(per_thread));
    out.insert("others".into(), Value::Array(others));
    out.insert("teams".into(), Value::Array(teams.into_iter().map(|(_, t)| t).collect()));
    out.insert("builder_team".into(), builder_team(session, &page, &members, &built).await?);
    out.insert("board_ai".into(), json!({"available": ready}));
    out.insert("page_assistant".into(), json!({"available": ready}));
    Ok(out)
}
