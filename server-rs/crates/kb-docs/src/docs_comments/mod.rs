//! Docs comments: inline threads tied to selected text, page comments, replies, mentions and events
//! (`services/docs_comments.py`).
//!
//! Comments belong to the page, not to a version. They are re-matched against the new text on every publish; a
//! thread whose text can no longer be found is *orphaned* (kept, warned, can be re-attached).
//!
//! Layout (python lines): this file 1-460 (people, text helpers, lookups, serialization, listing, events), `writes`
//! 459-747 (threads, replies, edit, delete, resolve, reattach, read marks), `anchors_across` 749-868 (anchors across
//! publishes, cleanup), `docs_ai` (the three calls into `services/assistant/docs.py` that the Docs AI port will
//! replace).
//!
//! Where Python adds a comment event it calls `notifications.comment_event(event, session)`, which waits for the
//! session's commit. Here the writing function inserts the event, commits, and then tells the centre
//! ([`kb_notify::comment_event`]).

use std::collections::HashMap;
use std::sync::LazyLock;

use kb_base::{activity, pyjson};
use kb_db::Session;
use kb_db::entities::{docs_comment, docs_comment_event, docs_comment_read, docs_comment_thread, docs_page, member};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, Order, QueryFilter, QueryOrder, QuerySelect};
use kb_doctext::docs_access;
use kb_doctext::docs_anchors as anchors;
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::docs::{get_page, latest_version};
use crate::util::casefold;
use crate::{Result, docs_err};

mod anchors_across;
pub mod docs_ai;
mod writes;

pub use anchors_across::{Rematched, anchor_preview, delete_for_pages, delete_threads, rematch_page};
pub use writes::{
    Anchor, add_board_note, add_reply, create_thread, delete_comment, edit_comment, mark_read, reattach, set_status,
};

/// Longest comment, in characters.
pub const MAX_BODY: usize = 4000;
/// Longest preview of a comment in a notification.
pub const SNIPPET: usize = 140;
/// The Docs roles.
pub const ROLES: [&str; 3] = docs_access::ROLES;
/// The thread filters of the list.
pub const STATES: [&str; 3] = ["all", "open", "resolved"];

pub use docs_access::{members_of, role_in};

/// `_need_member`: viewers can read comments but cannot add them.
pub(crate) fn need_member(role: &str) -> Result<()> {
    if role == "viewer" {
        return docs_err(
            403,
            "read_only",
            "Viewers can read comments but cannot add them. Ask a project member for access.",
        );
    }
    Ok(())
}

/// `\w` of Python's `re` for a `str`: letters, digits and the underscore.
fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

static MEMBER_LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"@\[([^\]\n]{1,200})\]\(member:([\p{L}\p{N}_-]{1,64})\)").expect("the member link pattern is valid")
});

/// Show `@[Name](member:id)` mentions (what the mention picker inserts) as `@Name`.
pub fn plain_mentions(body: &str) -> String {
    MEMBER_LINK.replace_all(body, |caps: &regex::Captures| format!("@{}", &caps[1])).into_owned()
}

static IMAGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"!\[([^\]\n]{0,200})\]\(([^()\s\x1c-\x1f]{0,500})\)").expect("the image pattern is valid")
});
static LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\[([^\]\n]{1,200})\]\(([^()\s\x1c-\x1f]{0,500})\)").expect("the link pattern is valid")
});

/// `_LINK.sub(...)` where the pattern starts `(?<!!)`: a match whose `[` follows a `!` is not one, and the search
/// goes on one character after it.
fn replace_links(text: &str, with: impl Fn(&regex::Captures) -> String) -> String {
    let mut out = String::new();
    let mut copied = 0;
    let mut pos = 0;
    while pos <= text.len() {
        let Some(caps) = LINK.captures_at(text, pos) else { break };
        let whole = caps.get(0).expect("group 0 is the whole match");
        if text[..whole.start()].ends_with('!') {
            pos = whole.start() + 1;
            continue;
        }
        out.push_str(&text[copied..whole.start()]);
        out.push_str(&with(&caps));
        copied = whole.end();
        pos = whole.end();
        if whole.is_empty() {
            pos += 1;
        }
    }
    out.push_str(&text[copied..]);
    out
}

/// One-line preview of a comment for notifications: mentions as `@Name`, images and diagrams as words.
pub fn snippet_of(body: &str) -> String {
    let text = plain_mentions(body);
    let text = IMAGE
        .replace_all(&text, |caps: &regex::Captures| {
            if caps[2].starts_with("diagram:") { "[diagram]" } else { "[image]" }.to_string()
        })
        .into_owned();
    let text = replace_links(&text, |caps| {
        if caps[2].starts_with("diagram:") { "[diagram]".to_string() } else { caps[1].to_string() }
    });
    kb_base::pytext::squash(&text).chars().take(SNIPPET).collect()
}

/// Members @mentioned in a comment body.
///
/// Both the picker's `@[Name](member:id)` and a typed `@Name` count (the longest names first so "@Ann Lee" beats
/// "@Ann"). Names that are not project members are ignored.
pub fn mentions_in<'a>(body: &str, members: &'a [member::Model]) -> Vec<&'a member::Model> {
    let mut found: Vec<&member::Model> = Vec::new();
    let by_id: HashMap<&str, &member::Model> = members.iter().map(|m| (m.id.as_str(), m)).collect();
    for caps in MEMBER_LINK.captures_iter(body) {
        if let Some(hit) = by_id.get(&caps[2]) {
            if !found.iter().any(|f| f.id == hit.id) {
                found.push(hit);
            }
        }
    }
    let text = plain_mentions(body);
    let mut by_length: Vec<&member::Model> = members.iter().collect();
    by_length.sort_by_key(|m| std::cmp::Reverse(m.name.chars().count()));
    for m in by_length {
        if found.iter().any(|f| f.id == m.id) {
            continue;
        }
        if typed_mention(&text, &m.name) {
            found.push(m);
        }
    }
    found
}

/// `re.search(r"(?<![\w@])@" + re.escape(name) + r"(?!\w)", text, re.IGNORECASE)`.
fn typed_mention(text: &str, name: &str) -> bool {
    let Ok(re) = Regex::new(&format!("(?i)@{}", regex::escape(name))) else { return false };
    let mut pos = 0;
    while let Some(hit) = re.find_at(text, pos) {
        let before = text[..hit.start()].chars().next_back();
        let after = text[hit.end()..].chars().next();
        if !before.is_some_and(|c| is_word(c) || c == '@') && !after.is_some_and(is_word) {
            return true;
        }
        pos = hit.start() + 1;
    }
    false
}

/// `_clean_body`: the stripped text of a comment, 422 when empty or longer than [`MAX_BODY`].
pub(crate) fn clean_body(body: Option<&str>) -> Result<String> {
    let text = kb_base::pytext::strip(body.unwrap_or("")).to_string();
    if text.is_empty() {
        return docs_err(422, "empty_comment", "Write something before posting");
    }
    if text.chars().count() > MAX_BODY {
        return docs_err(422, "comment_too_long", format!("A comment is limited to {MAX_BODY} characters"));
    }
    Ok(text)
}

/// `_json_obj`: a stored JSON object, or None.
fn json_obj(raw: Option<&str>) -> Option<Map<String, Value>> {
    let raw = raw.filter(|r| !r.is_empty())?;
    match pyjson::loads(raw)? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// `_json_list`: a stored JSON list, or empty.
pub(crate) fn json_list(raw: &str) -> Vec<Value> {
    match pyjson::loads(if raw.is_empty() { "[]" } else { raw }) {
        Some(Value::Array(items)) => items,
        _ => Vec::new(),
    }
}

// --- lookups ----------------------------------------------------------------

/// `_thread`: a thread, or 404.
pub(crate) async fn thread(session: &Session, thread_id: &str) -> Result<docs_comment_thread::Model> {
    match docs_comment_thread::Entity::find_by_id(thread_id).one(session).await? {
        Some(t) => Ok(t),
        None => docs_err(404, "thread_not_found", "Comment thread not found"),
    }
}

/// `_thread_page`: the page a thread is on (404/410 as `get_page`).
pub(crate) async fn thread_page(session: &Session, thread: &docs_comment_thread::Model) -> Result<docs_page::Model> {
    get_page(session, &thread.page_id, false, false).await
}

/// `_comments_of`: a thread's comments, oldest first.
pub(crate) async fn comments_of(session: &Session, thread_id: &str) -> Result<Vec<docs_comment::Model>> {
    Ok(docs_comment::Entity::find()
        .filter(docs_comment::Column::ThreadId.eq(thread_id))
        .order_by_asc(docs_comment::Column::CreatedAt)
        .order_by_asc(docs_comment::Column::Id)
        .all(session)
        .await?)
}

/// `_page_blocks`: the blocks of the page's latest published text.
pub(crate) async fn page_blocks(session: &Session, page: &docs_page::Model) -> Result<Vec<anchors::Block>> {
    let latest = latest_version(session, page).await?;
    Ok(anchors::blocks_of(latest.as_ref().map(|v| v.markdown.as_str()).unwrap_or("")))
}

// --- serialization -----------------------------------------------------------

/// `_comment_out`.
fn comment_out(c: &docs_comment::Model, members: &[member::Model], actor: &str, role: &str) -> Value {
    let by_id: HashMap<&str, &member::Model> = members.iter().map(|m| (m.id.as_str(), m)).collect();
    let mentioned: Vec<Value> = json_list(&c.mentions)
        .iter()
        .filter_map(|i| i.as_str().and_then(|i| by_id.get(i)))
        .map(|m| json!({"id": m.id, "name": m.name}))
        .collect();
    let mine = c.author == actor;
    let has_ai = c.ai.as_deref().is_some_and(|a| !a.is_empty());
    json!({
        "id": c.id,
        "thread_id": c.thread_id,
        "author": c.author,
        "body": c.body,
        "mentions": mentioned,
        "created_at": c.created_at,
        "edited_at": c.edited_at,
        // set on an AI member's reply: {member_id, job_id, cost, sources, kind?}
        "ai": json_obj(c.ai.as_deref()).map(Value::Object),
        "can_edit": mine && role != "viewer" && !has_ai,
        "can_delete": role != "viewer" && (mine || role == "admin"),
    })
}

/// `_read_marks`: when `reader` last read each thread.
async fn read_marks(session: &Session, thread_ids: &[String], reader: &str) -> Result<HashMap<String, String>> {
    if thread_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = docs_comment_read::Entity::find()
        .filter(docs_comment_read::Column::ThreadId.is_in(thread_ids.to_vec()))
        .filter(docs_comment_read::Column::Reader.eq(reader))
        .all(session)
        .await?;
    Ok(rows.into_iter().map(|r| (r.thread_id, r.read_at)).collect())
}

/// `_numbers`: number the open, attached inline threads in page order (the numbers on the highlights).
pub(crate) fn numbers(threads: &[docs_comment_thread::Model]) -> HashMap<String, usize> {
    let mut live: Vec<&docs_comment_thread::Model> =
        threads.iter().filter(|t| t.kind == "inline" && t.status == "open" && t.anchor_state == "attached").collect();
    live.sort_by(|a, b| {
        (a.anchor_pos.is_none(), a.anchor_pos.unwrap_or(0), &a.created_at, &a.id).cmp(&(
            b.anchor_pos.is_none(),
            b.anchor_pos.unwrap_or(0),
            &b.created_at,
            &b.id,
        ))
    });
    live.iter().enumerate().map(|(i, t)| (t.id.clone(), i + 1)).collect()
}

/// `_serialize`: threads as the comments list shows them.
async fn serialize(
    session: &Session,
    threads: &[&docs_comment_thread::Model],
    members: &[member::Model],
    actor: &str,
    role: &str,
    numbers: &HashMap<String, usize>,
) -> Result<Vec<Map<String, Value>>> {
    let ids: Vec<String> = threads.iter().map(|t| t.id.clone()).collect();
    let mut comments: HashMap<&str, Vec<docs_comment::Model>> = ids.iter().map(|i| (i.as_str(), Vec::new())).collect();
    if !ids.is_empty() {
        let rows = docs_comment::Entity::find()
            .filter(docs_comment::Column::ThreadId.is_in(ids.clone()))
            .order_by_asc(docs_comment::Column::CreatedAt)
            .order_by_asc(docs_comment::Column::Id)
            .all(session)
            .await?;
        for c in rows {
            if let Some(list) = comments.get_mut(c.thread_id.as_str()) {
                list.push(c);
            }
        }
    }
    let marks = read_marks(session, &ids, actor).await?;
    let mut out = Vec::new();
    for t in threads {
        let cs = &comments[t.id.as_str()];
        let seen = marks.get(&t.id);
        let unread = cs.iter().any(|c| c.author != actor && seen.is_none_or(|s| c.created_at > *s));
        let anchor = if t.kind == "inline" {
            json!({
                "quote": t.anchor_quote,
                "prefix": t.anchor_prefix,
                "suffix": t.anchor_suffix,
                "section": t.anchor_section,
                "state": t.anchor_state,
                "pos": t.anchor_pos,
            })
        } else {
            Value::Null
        };
        let mut row = Map::new();
        row.insert("id".into(), json!(t.id));
        row.insert("page_id".into(), json!(t.page_id));
        row.insert("kind".into(), json!(t.kind));
        row.insert("status".into(), json!(t.status));
        row.insert("number".into(), json!(numbers.get(&t.id)));
        row.insert("anchor".into(), anchor);
        row.insert("created_by".into(), json!(t.created_by));
        row.insert("created_at".into(), json!(t.created_at));
        row.insert("resolved_by".into(), json!(t.resolved_by));
        row.insert("resolved_at".into(), json!(t.resolved_at));
        row.insert("unread".into(), json!(unread));
        row.insert("comments".into(), Value::Array(cs.iter().map(|c| comment_out(c, members, actor, role)).collect()));
        row.insert("can_reply".into(), json!(role != "viewer"));
        row.insert("can_resolve".into(), json!(role != "viewer"));
        out.push(row);
    }
    Ok(out)
}

/// List a page's comment threads with counts and the caller's role.
///
/// `state` is `all`, `open` or `resolved` and filters inline threads only; `kind` is `inline` or `page` to list one
/// kind (both when omitted). Returns `{threads, counts, role, me, members, docs_ai}`; inline threads come first,
/// orphaned ones last. Fails with 404 if the page is missing or in the Recycle Bin; 422 on a bad filter.
pub async fn list_comments(
    session: &Session,
    page_id: &str,
    state: &str,
    kind: Option<&str>,
) -> Result<Map<String, Value>> {
    if !STATES.contains(&state) {
        return docs_err(422, "bad_state", format!("state must be one of {}", pyjson::py_repr(&json!(STATES))));
    }
    if !matches!(kind, None | Some("inline") | Some("page")) {
        return docs_err(422, "bad_kind", "kind must be inline or page");
    }
    let page = get_page(session, page_id, false, false).await?;
    let actor = activity::current_actor();
    let members = members_of(session, &page.project_id).await?;
    let role = role_in(&members, &actor);
    let every = docs_comment_thread::Entity::find()
        .filter(docs_comment_thread::Column::PageId.eq(page_id))
        .order_by_asc(docs_comment_thread::Column::CreatedAt)
        .order_by_asc(docs_comment_thread::Column::Id)
        .all(session)
        .await?;
    let numbers = numbers(&every);
    let inline: Vec<&docs_comment_thread::Model> = every.iter().filter(|t| t.kind == "inline").collect();
    let mut shown: Vec<&docs_comment_thread::Model> = every
        .iter()
        .filter(|t| kind.is_none_or(|k| t.kind == k) && (t.kind == "page" || state == "all" || t.status == state))
        .collect();
    shown.sort_by(|a, b| {
        (
            a.kind == "page",
            a.anchor_state == "orphaned",
            a.anchor_pos.is_none(),
            a.anchor_pos.unwrap_or(0),
            &a.created_at,
        )
            .cmp(&(
                b.kind == "page",
                b.anchor_state == "orphaned",
                b.anchor_pos.is_none(),
                b.anchor_pos.unwrap_or(0),
                &b.created_at,
            ))
    });
    let mut out_threads = serialize(session, &shown, &members, &actor, &role, &numbers).await?;
    let docs_ai_on = docs_ai::annotate(session, &page, &mut out_threads).await?;
    let count = |f: &dyn Fn(&docs_comment_thread::Model) -> bool| inline.iter().filter(|t| f(t)).count();
    let mut out = Map::new();
    out.insert("threads".into(), Value::Array(out_threads.into_iter().map(Value::Object).collect()));
    out.insert(
        "counts".into(),
        json!({
            "all": inline.len(),
            "open": count(&|t| t.status == "open"),
            "resolved": count(&|t| t.status == "resolved"),
            "orphaned": count(&|t| t.anchor_state == "orphaned" && t.status == "open"),
            "page": every.iter().filter(|t| t.kind == "page").count(),
        }),
    );
    out.insert("role".into(), json!(role));
    out.insert("me".into(), json!(actor));
    // `kind` human | ai; AI members carry `ai` (status for the @ picker) only while Docs AI is on
    out.insert(
        "members".into(),
        Value::Array(docs_ai::member_rows(session, &page.project_id, &members, docs_ai_on).await?),
    );
    out.insert("docs_ai".into(), json!(docs_ai_on));
    Ok(out)
}

/// `_one`: a thread as the comments list shows it.
pub(crate) async fn one(session: &Session, thread: &docs_comment_thread::Model) -> Result<Map<String, Value>> {
    let page = thread_page(session, thread).await?;
    let actor = activity::current_actor();
    let members = members_of(session, &page.project_id).await?;
    let rows = docs_comment_thread::Entity::find()
        .filter(docs_comment_thread::Column::PageId.eq(page.id.as_str()))
        .all(session)
        .await?;
    let numbers = numbers(&rows);
    let role = role_in(&members, &actor);
    let mut out = serialize(session, &[thread], &members, &actor, &role, &numbers).await?;
    docs_ai::annotate(session, &page, &mut out).await?;
    Ok(out.remove(0))
}

/// One thread as the comments list shows it.
pub async fn get_thread(session: &Session, thread_id: &str) -> Result<Map<String, Value>> {
    let t = thread(session, thread_id).await?;
    one(session, &t).await
}

// --- events -------------------------------------------------------------------

/// `_record_event`: write one Activity entry; `recipients` lists who is notified (never the actor).
///
/// Mentioned people are always notified. For replies, resolves and reopens the thread starter and everyone who
/// replied are notified too. The caller commits and then tells the notification centre with
/// [`kb_notify::comment_event`] (Python queues that on the session's commit).
pub(crate) async fn record_event(
    session: &Session,
    page: &docs_page::Model,
    thread: &docs_comment_thread::Model,
    comment: Option<&docs_comment::Model>,
    kind: &str,
    actor: &str,
    members: &[member::Model],
    notify_thread: bool,
) -> Result<docs_comment_event::Model> {
    use kb_db::sea_orm::ActiveModelTrait;
    use kb_db::sea_orm::ActiveValue::Set;
    let mentioned: Vec<String> =
        comment.map(|c| mentions_in(&c.body, members).iter().map(|m| m.name.clone()).collect()).unwrap_or_default();
    let mut people: Vec<String> = mentioned.clone();
    if notify_thread {
        people.push(thread.created_by.clone());
        for c in comments_of(session, &thread.id).await? {
            people.push(c.author);
        }
    }
    let mut recipients: Vec<String> = Vec::new();
    for p in people {
        let folded = casefold(&p);
        if folded != casefold(actor) && !recipients.iter().any(|r| casefold(r) == folded) {
            recipients.push(p);
        }
    }
    let snippet = snippet_of(match comment {
        Some(c) => &c.body,
        None => thread.anchor_quote.as_deref().unwrap_or(""),
    });
    let mut event = docs_comment_event::new();
    event.project_id = Set(page.project_id.clone());
    event.page_id = Set(Some(page.id.clone()));
    event.thread_id = Set(Some(thread.id.clone()));
    event.comment_id = Set(comment.map(|c| c.id.clone()));
    event.kind = Set(kind.to_string());
    event.actor = Set(actor.to_string());
    event.mentioned = Set(pyjson::dumps(&mentioned));
    event.recipients = Set(pyjson::dumps(&recipients));
    event.page_title = Set(page.title.clone());
    event.snippet = Set(snippet);
    Ok(event.insert(session).await?)
}

/// List a project's comment events (Activity), newest first.
///
/// `recipient` keeps only the events that notify that person (all events when omitted); `limit` is the maximum
/// number of entries.
pub async fn list_events(
    session: &Session,
    project_id: &str,
    recipient: Option<&str>,
    limit: i64,
) -> Result<Vec<Value>> {
    let recipient = recipient.filter(|r| !r.is_empty());
    let keep = limit.clamp(1, 200);
    let rows = docs_comment_event::Entity::find()
        .filter(docs_comment_event::Column::ProjectId.eq(project_id))
        .order_by(docs_comment_event::Column::CreatedAt, Order::Desc)
        .limit((keep * if recipient.is_some() { 4 } else { 1 }) as u64)
        .all(session)
        .await?;
    let mut out = Vec::new();
    for e in rows {
        let recipients = json_list(&e.recipients);
        if let Some(who) = recipient {
            let who = casefold(who);
            if !recipients.iter().any(|r| casefold(&pyjson::py_str(r)) == who) {
                continue;
            }
        }
        out.push(json!({
            "id": e.id,
            "page_id": e.page_id,
            "page_title": e.page_title,
            "thread_id": e.thread_id,
            "comment_id": e.comment_id,
            "kind": e.kind,
            "actor": e.actor,
            "mentioned": json_list(&e.mentioned),
            "recipients": recipients,
            "snippet": e.snippet,
            "created_at": e.created_at,
        }));
    }
    out.truncate(keep as usize);
    Ok(out)
}

/// Tell the notification centre about an event that was just committed.
pub(crate) fn announce(event: &docs_comment_event::Model) {
    kb_notify::comment_event(event);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(id: &str, name: &str) -> member::Model {
        member::Model {
            id: id.into(),
            project_id: "p".into(),
            name: name.into(),
            color: "#000000".into(),
            role: "member".into(),
            kind: "human".into(),
            created_at: "2026-01-01T00:00:00+00:00".into(),
        }
    }

    fn names(found: &[&member::Model]) -> Vec<String> {
        found.iter().map(|m| m.name.clone()).collect()
    }

    #[test]
    fn a_typed_mention_needs_a_word_boundary_and_ignores_case() {
        let members = [member("1", "Ann"), member("2", "Ann Lee"), member("3", "Bo")];
        // the longest names are tried first ("@ann lee" is also "@ann", as in Python); the picker's links come first
        assert_eq!(names(&mentions_in("hi @ann lee and @BO!", &members)), ["Ann Lee", "Ann", "Bo"]);
        // not after a word character or an @, and not before one
        assert!(mentions_in("mail@Ann, @@Bo, @Bobby", &members).is_empty());
        assert_eq!(names(&mentions_in("x @[Ann](member:1) y @Ann Lee", &members)), ["Ann", "Ann Lee"]);
        // a name with regex characters is matched as text
        let odd = [member("4", "A.B (x)")];
        assert_eq!(names(&mentions_in("cc @a.b (X).", &odd)), ["A.B (x)"]);
        assert!(mentions_in("cc @aXb (x).", &odd).is_empty());
    }

    #[test]
    fn a_link_that_follows_a_bang_is_not_a_link() {
        // an image takes the first `[` it can ("![a [b](c)" with the alt "a [b"); the rest is text and links
        assert_eq!(snippet_of("![a [b](c)](d) and [e](f)"), "[image]](d) and e");
        assert_eq!(snippet_of("![alt](diagram:dg_1) [x](diagram:dg_2) [y](z)"), "[diagram] [diagram] y");
        assert_eq!(snippet_of(&"word ".repeat(100)).chars().count(), SNIPPET);
    }

    #[test]
    fn a_comment_is_cleaned_and_limited() {
        assert_eq!(clean_body(Some("  hi \n")).unwrap(), "hi");
        assert!(clean_body(Some("  \n ")).is_err() && clean_body(None).is_err());
        assert!(clean_body(Some(&"é".repeat(MAX_BODY))).is_ok());
        assert!(clean_body(Some(&"é".repeat(MAX_BODY + 1))).is_err());
    }
}
