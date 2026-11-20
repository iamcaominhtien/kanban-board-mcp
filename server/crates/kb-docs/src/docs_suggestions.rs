//! AI suggestions at block level (design board "AI teams on rich pages").
//!
//! When an AI team changes a page and the page (or the team) is set to "Suggest first" — the default — the change
//! is not published: it is split into one suggestion per top-level block (replace, insert, delete, attributes) that
//! people accept or reject. A suggestion keeps a snapshot of the block as the team saw it; when a person changed the
//! block since, the suggestion is *stale*: Accept stays off until the reviewer has looked at it, and Accept all skips
//! it. Accepting publishes a new version (marked "with AI"). Blocks the page locks for teams (`lockedBlocks`) are
//! never changed: the team's edit to them is dropped and reported ("Left this block as it is"). A rewrite that would
//! remove a block's formatting (a colour, a highlight, a link, a font…) is not applied either: the block stays as it
//! is and the team's words are kept with a note (design G 36), which a person can copy, use or dismiss.
//!
//! Such a note is a row of the same table in the state `note`, of kind `locked` or `formatting`; it leaves when a
//! person dismisses it or the same team's next change reaches the block.

use kb_base::{activity, events, time};
use kb_db::Session;
use kb_db::entities::{docs_draft, docs_page, docs_suggestion};
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set};
use kb_richdoc::RandomIds;
use serde_json::{Map, Value, json};

use crate::docs::settings::read_settings;
use crate::docs::versions::commit_version;
use crate::docs::{PageBody, get_page, latest_version, page_detail, project};
use crate::{Result, docs_err};

/// How an AI team's change reaches a page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyMode {
    /// Saved as suggestions that wait for a person.
    Suggest,
    /// Published at once (Undo is in History).
    Direct,
}

/// How a team's changes reach this page: the page's setting wins, then the project's setting for the team, then
/// "suggest first". A page the team created itself (its first version is the team's) is always direct.
///
/// # Errors
/// A database error.
pub async fn apply_mode(
    session: &Session,
    page: &docs_page::Model,
    member_id: Option<&str>,
    author: &str,
) -> Result<ApplyMode> {
    let settings = read_settings(page.settings.as_deref());
    match settings.get("aiApply").and_then(Value::as_str) {
        Some("direct") => return Ok(ApplyMode::Direct),
        Some("suggest") => return Ok(ApplyMode::Suggest),
        _ => {}
    }
    if page.created_by == author {
        return Ok(ApplyMode::Direct);
    }
    let project = project(session, &page.project_id, false).await?;
    let space = crate::docs::space::read(&project);
    let team = member_id.and_then(|m| space.get("aiApply").and_then(|a| a.get(m))).and_then(Value::as_str);
    Ok(if team == Some("direct") { ApplyMode::Direct } else { ApplyMode::Suggest })
}

/// The block ids a page locks for teams ("Teams cannot change this").
pub fn locked_blocks(page: &docs_page::Model) -> Vec<String> {
    read_settings(page.settings.as_deref())
        .get("lockedBlocks")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

fn block_id(b: &Value) -> Option<&str> {
    b.get("attrs").and_then(|a| a.get("blockId")).and_then(Value::as_str)
}

fn without_attrs(b: &Value) -> Value {
    let mut c = b.clone();
    if let Some(o) = c.as_object_mut() {
        o.remove("attrs");
    }
    c
}

/// One change between two versions of a page, at top-level block level.
#[derive(Debug, Clone, PartialEq)]
pub struct BlockChange {
    /// `replace`, `insert`, `delete` or `attrs`.
    pub kind: &'static str,
    /// The block changed (replace, delete, attrs).
    pub block_id: Option<String>,
    /// Where an inserted block goes (after this block; `None`: at the start).
    pub after_block_id: Option<String>,
    /// The new block (replace, insert) or the new attrs (attrs).
    pub content: Option<Value>,
    /// The block before the change (replace, delete, attrs).
    pub before: Option<Value>,
}

/// Splits the change from `old` to `new` into top-level block changes (by block id).
pub fn diff_blocks(old: &Value, new: &Value) -> Vec<BlockChange> {
    let olds: Vec<&Value> =
        old.get("content").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default();
    let news: Vec<&Value> =
        new.get("content").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default();
    let old_by_id: std::collections::HashMap<&str, &Value> =
        olds.iter().filter_map(|b| block_id(b).map(|id| (id, *b))).collect();
    let new_ids: std::collections::HashSet<&str> = news.iter().filter_map(|b| block_id(b)).collect();
    let mut out = Vec::new();
    let mut prev: Option<String> = None;
    for b in &news {
        match block_id(b).and_then(|id| old_by_id.get(id).map(|o| (id, *o))) {
            Some((id, o)) => {
                if *o != **b {
                    let kind = if without_attrs(o) == without_attrs(b) { "attrs" } else { "replace" };
                    out.push(BlockChange {
                        kind,
                        block_id: Some(id.to_string()),
                        after_block_id: None,
                        content: Some(if kind == "attrs" {
                            b.get("attrs").cloned().unwrap_or(json!({}))
                        } else {
                            (*b).clone()
                        }),
                        before: Some(o.clone()),
                    });
                }
                prev = Some(id.to_string());
            }
            None => {
                out.push(BlockChange {
                    kind: "insert",
                    block_id: block_id(b).map(str::to_string),
                    after_block_id: prev.clone(),
                    content: Some((*b).clone()),
                    before: None,
                });
                prev = block_id(b).map(str::to_string);
            }
        }
    }
    for o in &olds {
        if let Some(id) = block_id(o).filter(|id| !new_ids.contains(id)) {
            out.push(BlockChange {
                kind: "delete",
                block_id: Some(id.to_string()),
                after_block_id: None,
                content: None,
                before: Some((*o).clone()),
            });
        }
    }
    out
}

/// What became of a team's change: `{mode, suggestions, left_alone}` (`left_alone`: locked block ids it touched).
///
/// Stores the changes from the page's latest published content to `new_doc` as suggestions (or, with
/// `ApplyMode::Direct`, publishes `new_doc` with the locked blocks kept as they were).
///
/// # Errors
/// 409 `nothing_to_suggest` on a page never published; database errors.
pub async fn propose(
    session: &Session,
    page_id: &str,
    new_doc: &Value,
    mode: ApplyMode,
    member_id: Option<&str>,
    run_id: Option<&str>,
    note: Option<&str>,
) -> Result<Value> {
    let mut page = get_page(session, page_id, false, true).await?;
    let author = activity::current_actor();
    let Some(latest) = latest_version(session, &page).await? else {
        return docs_err(409, "nothing_to_suggest", "The page has no published version yet.");
    };
    let current = PageBody::of_version(&latest).into_rich();
    let old = current.content.clone().unwrap_or(json!({"type": "doc", "content": []}));
    let locked = locked_blocks(&page);
    let (changes, left): (Vec<BlockChange>, Vec<BlockChange>) = diff_blocks(&old, new_doc)
        .into_iter()
        .partition(|c| c.block_id.as_deref().is_none_or(|id| !locked.iter().any(|l| l == id)) || c.kind == "insert");
    // a rewrite that would remove a block's formatting is kept as a note, the block as it is
    let (changes, kept): (Vec<BlockChange>, Vec<BlockChange>) = changes.into_iter().partition(|c| !loses_formatting(c));
    let left_alone: Vec<String> = left.iter().filter_map(|c| c.block_id.clone()).collect();
    let kept_ids: Vec<String> = kept.iter().filter_map(|c| c.block_id.clone()).collect();
    let noted: Vec<(&BlockChange, NoteKind)> =
        left.iter().map(|c| (c, NoteKind::Locked)).chain(kept.iter().map(|c| (c, NoteKind::Formatting))).collect();
    store_notes(session, &page, &author, member_id, run_id, &noted).await?;
    if mode == ApplyMode::Direct {
        let mut doc = old.clone();
        apply_changes(&mut doc, &changes);
        let body = PageBody::from_doc(doc);
        let title = page.title.clone();
        commit_version(session, &mut page, &body, &title, &author, note, None, true).await?;
        return Ok(json!({"mode": "direct", "suggestions": 0, "changed": changes.len(), "left_alone": left_alone,
                         "kept_formatting": kept_ids}));
    }
    // a team's newer suggestion on a block replaces its older pending one
    let pending = pending_rows(session, page_id).await?;
    for c in &changes {
        for p in pending.iter().filter(|p| p.author == author && p.block_id.is_some() && p.block_id == c.block_id) {
            let mut row = kb_db::edit(p.clone());
            row.state = Set("rejected".into());
            row.decided_by = Set(Some(author.clone()));
            row.decided_at = Set(Some(time::now_iso()));
            row.update(session).await?;
        }
        let mut row = docs_suggestion::new();
        row.page_id = Set(page.id.clone());
        row.block_id = Set(c.block_id.clone());
        row.after_block_id = Set(c.after_block_id.clone());
        row.kind = Set(c.kind.to_string());
        row.content = Set(c.content.as_ref().map(Value::to_string));
        row.before = Set(c.before.as_ref().map(Value::to_string));
        row.base_version = Set(page.version);
        row.author = Set(author.clone());
        row.member_id = Set(member_id.map(str::to_string));
        row.run_id = Set(run_id.map(str::to_string));
        row.note = Set(note.map(str::to_string));
        row.insert(session).await?;
    }
    session.commit().await?;
    announce(page_id).await;
    Ok(json!({"mode": "suggest", "suggestions": changes.len(), "left_alone": left_alone, "kept_formatting": kept_ids}))
}

/// Why a team's change to a block was not made.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteKind {
    /// The page locks the block for teams ("Teams cannot change this").
    Locked,
    /// The rewrite would have removed the block's formatting.
    Formatting,
}

impl NoteKind {
    /// The word stored in `kind` and sent to the UI.
    pub fn word(self) -> &'static str {
        match self {
            NoteKind::Locked => "locked",
            NoteKind::Formatting => "formatting",
        }
    }
}

/// The inline formatting of a block, counted by kind: `colour`, `highlight`, `link`, `font`, `underline`, `chip` (a
/// page or ticket chip) and `formula`. Kinds a block does not use are left out.
pub fn formatting_of(block: &Value) -> Map<String, Value> {
    fn walk(n: &Value, out: &mut std::collections::BTreeMap<&'static str, u64>) {
        match n.get("type").and_then(Value::as_str) {
            Some("docRef" | "ticketRef") => *out.entry("chip").or_default() += 1,
            Some("mathInline") => *out.entry("formula").or_default() += 1,
            _ => {}
        }
        for m in n.get("marks").and_then(Value::as_array).into_iter().flatten() {
            let attrs = m.get("attrs");
            let set = |k: &str| attrs.and_then(|a| a.get(k)).is_some_and(|v| !v.is_null() && v != "");
            match m.get("type").and_then(Value::as_str) {
                Some("link") => *out.entry("link").or_default() += 1,
                Some("highlight") => *out.entry("highlight").or_default() += 1,
                Some("underline") => *out.entry("underline").or_default() += 1,
                Some("textStyle") => {
                    if set("color") {
                        *out.entry("colour").or_default() += 1;
                    }
                    if set("fontFamily") || set("fontSize") {
                        *out.entry("font").or_default() += 1;
                    }
                }
                _ => {}
            }
        }
        for c in n.get("content").and_then(Value::as_array).into_iter().flatten() {
            walk(c, out);
        }
    }
    let mut counts = std::collections::BTreeMap::new();
    walk(block, &mut counts);
    counts.into_iter().map(|(k, v)| (k.to_string(), json!(v))).collect()
}

/// The formatting a block had that its new version lacks, by kind (`formatting_of`'s kinds, the number lost).
pub fn lost_formatting(before: &Value, after: &Value) -> Map<String, Value> {
    let (old, new) = (formatting_of(before), formatting_of(after));
    old.into_iter()
        .filter_map(|(k, v)| {
            let had = v.as_u64().unwrap_or(0);
            let has = new.get(&k).and_then(Value::as_u64).unwrap_or(0);
            (has < had).then(|| (k, json!(had - has)))
        })
        .collect()
}

/// Whether a change rewrites a block of the same kind and leaves out some of its inline formatting.
fn loses_formatting(c: &BlockChange) -> bool {
    let (Some(before), Some(after)) = (&c.before, &c.content) else { return false };
    c.kind == "replace" && before.get("type") == after.get("type") && !lost_formatting(before, after).is_empty()
}

/// Stores a note for each change that was not made, and retires the team's older notes on those blocks.
async fn store_notes(
    session: &Session,
    page: &docs_page::Model,
    author: &str,
    member_id: Option<&str>,
    run_id: Option<&str>,
    noted: &[(&BlockChange, NoteKind)],
) -> Result<()> {
    if noted.is_empty() {
        return Ok(());
    }
    let older = note_rows(session, &page.id).await?;
    for (c, kind) in noted {
        for o in older.iter().filter(|o| o.author == author && o.block_id == c.block_id) {
            let mut row = kb_db::edit(o.clone());
            row.state = Set("dismissed".into());
            row.update(session).await?;
        }
        let mut row = docs_suggestion::new();
        row.page_id = Set(page.id.clone());
        row.block_id = Set(c.block_id.clone());
        row.kind = Set(kind.word().to_string());
        row.content = Set(c.content.as_ref().filter(|_| c.kind == "replace").map(Value::to_string));
        row.before = Set(c.before.as_ref().map(Value::to_string));
        row.base_version = Set(page.version);
        row.author = Set(author.to_string());
        row.member_id = Set(member_id.map(str::to_string));
        row.run_id = Set(run_id.map(str::to_string));
        row.state = Set("note".into());
        row.insert(session).await?;
    }
    Ok(())
}

async fn note_rows(session: &Session, page_id: &str) -> Result<Vec<docs_suggestion::Model>> {
    Ok(docs_suggestion::Entity::find()
        .filter(docs_suggestion::Column::PageId.eq(page_id))
        .filter(docs_suggestion::Column::State.eq("note"))
        .order_by_asc(docs_suggestion::Column::CreatedAt)
        .all(session)
        .await?)
}

/// The notes of the page's blocks that are still there, as `list` sends them: `{id, kind, block_id, author,
/// member_id, run_id, created_at, wrote, after, lost}` (`wrote`: the team's version as plain text, `after` its block,
/// both `None` for a change other than a rewrite; `lost`: the formatting the rewrite would have removed).
fn notes_json(rows: &[docs_suggestion::Model], current: &Value) -> Vec<Value> {
    let here = |id: &str| {
        current.get("content").and_then(Value::as_array).is_some_and(|a| a.iter().any(|b| block_id(b) == Some(id)))
    };
    rows.iter()
        .filter(|n| n.block_id.as_deref().is_some_and(here))
        .map(|n| {
            let after = parse(n.content.as_deref());
            let before = parse(n.before.as_deref());
            let wrote = (!after.is_null()).then(|| crate::docs::blocks::block_text(&after));
            let lost = if after.is_null() { Map::new() } else { lost_formatting(&before, &after) };
            json!({
                "id": n.id,
                "kind": n.kind,
                "block_id": n.block_id,
                "author": n.author,
                "member_id": n.member_id,
                "run_id": n.run_id,
                "created_at": n.created_at,
                "wrote": wrote,
                "after": after,
                "lost": lost,
            })
        })
        .collect()
}

/// Dismisses notes of a page ("Dismiss"): `{dismissed}`.
///
/// # Errors
/// The page errors (edit rights).
pub async fn dismiss_notes(session: &Session, page_id: &str, ids: &[String]) -> Result<Value> {
    get_page(session, page_id, false, true).await?;
    let mut n = 0;
    for row in note_rows(session, page_id).await? {
        if !ids.contains(&row.id) {
            continue;
        }
        let mut row = kb_db::edit(row);
        row.state = Set("dismissed".into());
        row.decided_by = Set(Some(activity::current_actor()));
        row.decided_at = Set(Some(time::now_iso()));
        row.update(session).await?;
        n += 1;
    }
    session.commit().await?;
    announce(page_id).await;
    Ok(json!({"dismissed": n}))
}

/// Uses the team's version of a block a note kept as it was ("Replace the block"): publishes one new version, as
/// accepting a suggestion does, and returns the page.
///
/// # Errors
/// 404 `suggestion_not_found` for an unknown note or one without a version of the block (a locked block's delete);
/// the page errors (edit rights).
pub async fn replace_from_note(session: &Session, page_id: &str, note_id: &str) -> Result<Map<String, Value>> {
    get_page(session, page_id, false, true).await?;
    let Some(row) = note_rows(session, page_id).await?.into_iter().find(|n| n.id == note_id && n.content.is_some())
    else {
        return docs_err(404, "suggestion_not_found", "Suggestion not found");
    };
    let mut row = kb_db::edit(row);
    row.kind = Set("replace".into());
    row.state = Set("pending".into());
    row.update(session).await?;
    accept(session, page_id, &[note_id.to_string()], true).await
}

/// The formatting a page uses, named in words as the Gaps panel of a team's draft lists it (design E 25): "Title and
/// subtitle centred", "Pull quote", "Image floated right", "Cover image"… One line per kind, in page order; plain
/// paragraphs, lists and headings left as they come are not named.
///
/// `cover`: whether the page has a cover image (a page setting, not a block).
pub fn formatting_used(doc: &Value, cover: bool) -> Vec<String> {
    let blocks: Vec<&Value> = kb_richdoc::top_level_blocks(doc);
    let ty = |b: &Value| b.get("type").and_then(Value::as_str).unwrap_or("").to_string();
    let at =
        |b: &Value, k: &str| b.get("attrs").and_then(|a| a.get(k)).and_then(Value::as_str).unwrap_or("").to_string();
    let centred = |b: &Value| at(b, "textAlign") == "center";
    let mut out: Vec<String> = Vec::new();
    let mut add = |line: &str| {
        if !out.iter().any(|o| o == line) {
            out.push(line.to_string());
        }
    };
    // the title: a centred first heading, with the line under it when that one is centred too
    let mut start = 0;
    if blocks.first().is_some_and(|b| ty(b) == "heading" && centred(b)) {
        if blocks.get(1).is_some_and(|b| centred(b) && ty(b) != "heading") {
            add("Title and subtitle centred");
            start = 2;
        } else {
            add("Title centred");
            start = 1;
        }
    }
    for b in &blocks[start.min(blocks.len())..] {
        match ty(b).as_str() {
            "heading" if centred(b) => add("Headings centred"),
            "paragraph" if centred(b) => add("Text centred"),
            "paragraph" if at(b, "textAlign") == "right" => add("Text aligned right"),
            "pullQuote" => add("Pull quote"),
            "blockquote" => add("Quote"),
            "callout" => add("Callout"),
            "columns" => add("Columns"),
            "table" => add("Table"),
            "image" => match at(b, "placement").as_str() {
                "floatRight" => add("Image floated right"),
                "floatLeft" => add("Image floated left"),
                "wide" | "full" => add("Wide image"),
                _ => add("Image"),
            },
            "video" => add("Video"),
            "diagram" => add("Diagram"),
            "codeBlock" => add("Code block"),
            "taskList" => add("Task list"),
            _ => {}
        }
        let marks = formatting_of(b);
        if marks.contains_key("colour") {
            add("Coloured text");
        }
        if marks.contains_key("highlight") {
            add("Highlights");
        }
    }
    if cover {
        add("Cover image");
    }
    out
}

/// Marks the page's draft as written by an AI ("Drafted with AI"): merges `source` (`{kind, from, member_id, gaps,
/// sources}`) into the draft's `ai_source` and adds `formatting`, the formatting the draft uses
/// ([`formatting_used`]). `author`: whose draft (`None`: the draft saved last). Returns false when there is no such
/// draft (nothing is marked).
///
/// # Errors
/// A database error.
pub async fn mark_ai_draft(
    session: &Session,
    page_id: &str,
    author: Option<&str>,
    source: Map<String, Value>,
) -> Result<bool> {
    let mut find = docs_draft::Entity::find().filter(docs_draft::Column::PageId.eq(page_id));
    if let Some(author) = author {
        find = find.filter(docs_draft::Column::Author.eq(author));
    }
    let Some(draft) = find.order_by_desc(docs_draft::Column::UpdatedAt).one(session).await? else {
        return Ok(false);
    };
    let page = docs_page::Entity::find_by_id(page_id).one(session).await?;
    let cover =
        page.as_ref().is_some_and(|p| read_settings(p.settings.as_deref()).get("cover").is_some_and(Value::is_object));
    let mut merged = match parse(draft.ai_source.as_deref()) {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    for (k, v) in source {
        if !v.is_null() {
            merged.insert(k, v);
        }
    }
    let formatting = draft
        .content
        .as_deref()
        .map(|c| parse(Some(c)))
        .filter(Value::is_object)
        .map(|doc| formatting_used(&doc, cover))
        .unwrap_or_default();
    merged.insert("formatting".into(), json!(formatting));
    let mut row = kb_db::edit(draft);
    row.ai_source = Set(Some(Value::Object(merged).to_string()));
    row.update(session).await?;
    session.commit().await?;
    Ok(true)
}

/// Applies block changes to a document in order (a change whose block is gone is skipped).
pub fn apply_changes(doc: &mut Value, changes: &[BlockChange]) {
    let Some(blocks) = doc.get_mut("content").and_then(Value::as_array_mut) else { return };
    for c in changes {
        let at = c.block_id.as_deref().and_then(|id| blocks.iter().position(|b| block_id(b) == Some(id)));
        match (c.kind, at) {
            ("replace", Some(i)) => {
                if let Some(new) = &c.content {
                    blocks[i] = new.clone();
                }
            }
            ("attrs", Some(i)) => {
                if let (Some(new), Some(o)) = (c.content.as_ref().and_then(Value::as_object), blocks[i].as_object_mut())
                {
                    o.insert("attrs".into(), Value::Object(new.clone()));
                }
            }
            ("delete", Some(i)) => {
                blocks.remove(i);
            }
            ("insert", _) => {
                if let Some(new) = &c.content {
                    let pos = match c.after_block_id.as_deref() {
                        None => 0,
                        Some(after) => {
                            blocks.iter().position(|b| block_id(b) == Some(after)).map_or(blocks.len(), |p| p + 1)
                        }
                    };
                    blocks.insert(pos, new.clone());
                }
            }
            _ => {}
        }
    }
    if blocks.is_empty() {
        blocks.push(json!({"type": "paragraph"}));
    }
}

async fn pending_rows(session: &Session, page_id: &str) -> Result<Vec<docs_suggestion::Model>> {
    Ok(docs_suggestion::Entity::find()
        .filter(docs_suggestion::Column::PageId.eq(page_id))
        .filter(docs_suggestion::Column::State.eq("pending"))
        .order_by_asc(docs_suggestion::Column::CreatedAt)
        .all(session)
        .await?)
}

async fn announce(page_id: &str) {
    events::publish(&json!({"type": "docs_suggestions", "page_id": page_id}).to_string(), &[]).await;
}

fn parse(raw: Option<&str>) -> Value {
    raw.and_then(|r| serde_json::from_str(r).ok()).unwrap_or(Value::Null)
}

/// Whether a person changed the block since the team saw it (or removed it).
fn is_stale(s: &docs_suggestion::Model, current: &Value) -> bool {
    let Some(id) = s.block_id.as_deref() else { return false };
    if s.kind == "insert" {
        return false;
    }
    let now = current.get("content").and_then(Value::as_array).and_then(|a| a.iter().find(|b| block_id(b) == Some(id)));
    match now {
        None => true,
        Some(b) => *b != parse(s.before.as_deref()),
    }
}

fn change_of(s: &docs_suggestion::Model) -> BlockChange {
    let kind = match s.kind.as_str() {
        "insert" => "insert",
        "delete" => "delete",
        "attrs" => "attrs",
        _ => "replace",
    };
    BlockChange {
        kind,
        block_id: s.block_id.clone(),
        after_block_id: s.after_block_id.clone(),
        content: Some(parse(s.content.as_deref())).filter(|v| !v.is_null()),
        before: Some(parse(s.before.as_deref())).filter(|v| !v.is_null()),
    }
}

/// The page's pending suggestions, in page order where possible: `{suggestions: [...], count, notes}`; each with its
/// before/after block, author, note, `stale` and, when stale, `changed_by` (who published the block as it is now)
/// and `at_same_time` (the team's run is still working: a person and the team changed the block at the same time).
/// `notes` are the changes a team did not make (`notes_json`).
///
/// # Errors
/// The page errors.
pub async fn list(session: &Session, page_id: &str) -> Result<Map<String, Value>> {
    let page = get_page(session, page_id, false, false).await?;
    let current = match latest_version(session, &page).await? {
        Some(v) => PageBody::of_version(&v).into_rich().content.unwrap_or(Value::Null),
        None => Value::Null,
    };
    let order: Vec<String> = current
        .get("content")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|b| block_id(b).map(str::to_string)).collect())
        .unwrap_or_default();
    let mut rows = pending_rows(session, page_id).await?;
    rows.sort_by_key(|s| {
        let key = s.block_id.as_deref().or(s.after_block_id.as_deref());
        key.and_then(|k| order.iter().position(|o| o == k)).unwrap_or(0)
    });
    // who changed a block under the team: the author of the version the page is at
    let changed_by = latest_version(session, &page).await?.map(|v| v.author);
    // the runs still working: a block changed under one of them was "edited at the same time" (G 37)
    let run_ids: Vec<&str> = rows.iter().filter_map(|s| s.run_id.as_deref()).collect();
    let live_runs: std::collections::HashSet<String> = if run_ids.is_empty() {
        std::collections::HashSet::new()
    } else {
        kb_db::entities::ai_run::Entity::find()
            .filter(kb_db::entities::ai_run::Column::Id.is_in(run_ids))
            .filter(kb_db::entities::ai_run::Column::State.is_in(crate::docs_work::LIVE))
            .all(session)
            .await?
            .into_iter()
            .map(|r| r.id)
            .collect()
    };
    let list: Vec<Value> = rows
        .iter()
        .map(|s| {
            let stale = is_stale(s, &current);
            json!({
                "id": s.id,
                "kind": s.kind,
                "block_id": s.block_id,
                "after_block_id": s.after_block_id,
                "after": parse(s.content.as_deref()),
                "before": parse(s.before.as_deref()),
                "author": s.author,
                "member_id": s.member_id,
                "run_id": s.run_id,
                "note": s.note,
                "base_version": s.base_version,
                "created_at": s.created_at,
                "stale": stale,
                "changed_by": if stale { json!(changed_by) } else { Value::Null },
                "at_same_time": stale && s.run_id.as_deref().is_some_and(|r| live_runs.contains(r)),
            })
        })
        .collect();
    let notes = notes_json(&note_rows(session, page_id).await?, &current);
    let mut out = Map::new();
    out.insert("count".into(), json!(list.len()));
    out.insert("suggestions".into(), Value::Array(list));
    out.insert("notes".into(), Value::Array(notes));
    Ok(out)
}

/// Accepts suggestions: applies them to the latest published page and publishes one new version (marked with
/// AI). A stale suggestion is accepted only when `looked` is true (the reviewer chose "Look at it").
///
/// # Errors
/// 409 `suggestion_stale` for a stale suggestion not looked at; 404 `suggestion_not_found`; 409
/// `suggestion_settled` when it was already accepted or rejected; the page errors (edit rights).
pub async fn accept(session: &Session, page_id: &str, ids: &[String], looked: bool) -> Result<Map<String, Value>> {
    let mut page = get_page(session, page_id, false, true).await?;
    let me = activity::current_actor();
    let Some(latest) = latest_version(session, &page).await? else {
        return docs_err(409, "nothing_to_suggest", "The page has no published version yet.");
    };
    let mut doc = PageBody::of_version(&latest).into_rich().content.unwrap_or(json!({"type": "doc", "content": []}));
    let pending = pending_rows(session, page_id).await?;
    let mut chosen = Vec::new();
    for id in ids {
        let Some(s) = pending.iter().find(|s| &s.id == id) else {
            let settled = docs_suggestion::Entity::find_by_id(id.as_str()).one(session).await?.is_some();
            return if settled {
                docs_err(409, "suggestion_settled", "This suggestion was already accepted or rejected.")
            } else {
                docs_err(404, "suggestion_not_found", "Suggestion not found")
            };
        };
        if is_stale(s, &doc) && !looked {
            return docs_err(409, "suggestion_stale", "Changed since the team wrote it. Look at it first.");
        }
        chosen.push(s.clone());
    }
    let changes: Vec<BlockChange> = chosen.iter().map(change_of).collect();
    apply_changes(&mut doc, &changes);
    kb_richdoc::ensure_block_ids(&mut doc, &mut RandomIds);
    let body = PageBody::from_doc(doc);
    let teams: Vec<String> = {
        let mut t: Vec<String> = chosen.iter().map(|s| s.author.clone()).collect();
        t.dedup();
        t
    };
    let note = format!(
        "Accepted {} suggestion{} from {}",
        chosen.len(),
        if chosen.len() == 1 { "" } else { "s" },
        teams.join(", ")
    );
    let title = page.title.clone();
    commit_version(session, &mut page, &body, &title, &me, Some(&note), None, false).await?;
    // the version holds a team's words: marked "with AI" like a version a team published itself
    if let Some(v) = latest_version(session, &page).await? {
        let mut row = kb_db::edit(v);
        row.with_ai = Set(true);
        row.update(session).await?;
    }
    let now = time::now_iso();
    for s in chosen {
        let mut row = kb_db::edit(s);
        row.state = Set("accepted".into());
        row.decided_by = Set(Some(me.clone()));
        row.decided_at = Set(Some(now.clone()));
        row.update(session).await?;
    }
    session.commit().await?;
    announce(page_id).await;
    page_detail(session, page_id).await
}

/// Accepts every pending suggestion that is not stale: `{accepted, skipped_stale, page}`.
///
/// # Errors
/// As `accept`.
pub async fn accept_all(session: &Session, page_id: &str) -> Result<Value> {
    let page = get_page(session, page_id, false, true).await?;
    let current = match latest_version(session, &page).await? {
        Some(v) => PageBody::of_version(&v).into_rich().content.unwrap_or(Value::Null),
        None => Value::Null,
    };
    let pending = pending_rows(session, page_id).await?;
    let (fresh, stale): (Vec<_>, Vec<_>) = pending.iter().partition(|s| !is_stale(s, &current));
    let ids: Vec<String> = fresh.iter().map(|s| s.id.clone()).collect();
    let detail = if ids.is_empty() {
        page_detail(session, page_id).await?
    } else {
        accept(session, page_id, &ids, false).await?
    };
    Ok(json!({"accepted": ids.len(), "skipped_stale": stale.len(), "page": detail}))
}

/// Rejects suggestions (all pending ones when `ids` is empty): the page stays as it is. Returns `{rejected}`.
///
/// # Errors
/// The page errors (edit rights).
pub async fn reject(session: &Session, page_id: &str, ids: &[String]) -> Result<Value> {
    get_page(session, page_id, false, true).await?;
    let me = activity::current_actor();
    let now = time::now_iso();
    let mut n = 0;
    for s in pending_rows(session, page_id).await? {
        if !ids.is_empty() && !ids.contains(&s.id) {
            continue;
        }
        let mut row = kb_db::edit(s);
        row.state = Set("rejected".into());
        row.decided_by = Set(Some(me.clone()));
        row.decided_at = Set(Some(now.clone()));
        row.update(session).await?;
        n += 1;
    }
    session.commit().await?;
    announce(page_id).await;
    Ok(json!({"rejected": n}))
}

/// Pending suggestion counts per page of a project (the tree's ✦ marker): `{page_id: n}`.
///
/// # Errors
/// A database error.
pub async fn counts(session: &Session, page_ids: &[String]) -> Result<Map<String, Value>> {
    let mut out = Map::new();
    if page_ids.is_empty() {
        return Ok(out);
    }
    let rows = docs_suggestion::Entity::find()
        .filter(docs_suggestion::Column::PageId.is_in(page_ids.iter().map(String::as_str)))
        .filter(docs_suggestion::Column::State.eq("pending"))
        .all(session)
        .await?;
    for r in rows {
        let n = out.get(&r.page_id).and_then(Value::as_u64).unwrap_or(0) + 1;
        out.insert(r.page_id, json!(n));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(id: &str, text: &str) -> Value {
        json!({"type": "paragraph", "attrs": {"blockId": id}, "content": [{"type": "text", "text": text}]})
    }

    #[test]
    fn a_diff_names_each_kind_of_change() {
        let old = json!({"type": "doc", "content": [p("b-1", "a"), p("b-2", "b"), p("b-3", "c")]});
        let mut b2 = p("b-2", "b");
        b2["attrs"]["textAlign"] = json!("center");
        let new = json!({"type": "doc", "content": [p("b-1", "A"), b2, p("b-9", "new")]});
        let d = diff_blocks(&old, &new);
        let kinds: Vec<(&str, Option<&str>)> = d.iter().map(|c| (c.kind, c.block_id.as_deref())).collect();
        assert_eq!(
            kinds,
            [("replace", Some("b-1")), ("attrs", Some("b-2")), ("insert", Some("b-9")), ("delete", Some("b-3"))]
        );
        assert_eq!(d[2].after_block_id.as_deref(), Some("b-2"));
        let mut doc = old.clone();
        apply_changes(&mut doc, &d);
        assert_eq!(doc, new);
    }

    fn styled(id: &str) -> Value {
        json!({"type": "paragraph", "attrs": {"blockId": id}, "content": [
            {"type": "text", "text": "work", "marks": [{"type": "textStyle", "attrs": {"color": "green"}}]},
            {"type": "text", "text": " Hoa ", "marks": [{"type": "highlight", "attrs": {"color": "yellow"}}]},
            {"type": "text", "text": "board", "marks": [{"type": "link", "attrs": {"href": "/x"}}]},
        ]})
    }

    #[test]
    fn a_rewrite_that_drops_formatting_is_named_by_what_it_loses() {
        let before = styled("b-1");
        assert_eq!(
            formatting_of(&before),
            json!({"colour": 1, "highlight": 1, "link": 1}).as_object().cloned().unwrap()
        );
        let plain = p("b-1", "work Hoa board, rewritten");
        assert_eq!(
            lost_formatting(&before, &plain),
            json!({"colour": 1, "highlight": 1, "link": 1}).as_object().cloned().unwrap()
        );
        let c = BlockChange {
            kind: "replace",
            block_id: Some("b-1".into()),
            after_block_id: None,
            content: Some(plain),
            before: Some(before.clone()),
        };
        assert!(loses_formatting(&c));
        // the same formatting kept: not a loss; another kind of block: not compared
        let kept = BlockChange { content: Some(styled("b-1")), ..c.clone() };
        assert!(!loses_formatting(&kept));
        let heading = json!({"type": "heading", "attrs": {"blockId": "b-1", "level": 2}, "content": [{"type": "text", "text": "x"}]});
        assert!(!loses_formatting(&BlockChange { content: Some(heading), ..c }));
    }

    #[test]
    fn the_formatting_a_draft_uses_is_named_in_words() {
        let doc = json!({"type": "doc", "content": [
            {"type": "heading", "attrs": {"blockId": "b-1", "level": 1, "textAlign": "center"}, "content": [{"type": "text", "text": "T"}]},
            {"type": "paragraph", "attrs": {"blockId": "b-2", "textAlign": "center"}, "content": [{"type": "text", "text": "S"}]},
            {"type": "image", "attrs": {"blockId": "b-3", "src": "/uploads/a.png", "placement": "floatRight"}},
            p("b-4", "Body"),
            {"type": "pullQuote", "attrs": {"blockId": "b-5"}, "content": [{"type": "text", "text": "Q"}]},
        ]});
        assert_eq!(
            formatting_used(&doc, true),
            ["Title and subtitle centred", "Image floated right", "Pull quote", "Cover image"]
        );
        assert!(formatting_used(&json!({"type": "doc", "content": [p("b-1", "x")]}), false).is_empty());
    }
}
