//! AI suggestions at block level (design board "AI teams on rich pages").
//!
//! When an AI team changes a page and the page (or the team) is set to "Suggest first" — the default — the change
//! is not published: it is split into one suggestion per top-level block (replace, insert, delete, attributes) that
//! people accept or reject. A suggestion keeps a snapshot of the block as the team saw it; when a person changed the
//! block since, the suggestion is *stale*: Accept stays off until the reviewer has looked at it, and Accept all skips
//! it. Accepting publishes a new version (marked "with AI"). Blocks the page locks for teams (`lockedBlocks`) are
//! never changed: the team's edit to them is dropped and reported ("Left this block as it is").

use kb_base::{activity, events, time};
use kb_db::Session;
use kb_db::entities::{docs_page, docs_suggestion};
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
    let left_alone: Vec<String> = left.iter().filter_map(|c| c.block_id.clone()).collect();
    if mode == ApplyMode::Direct {
        let mut doc = old.clone();
        apply_changes(&mut doc, &changes);
        let body = PageBody::from_doc(doc);
        let title = page.title.clone();
        commit_version(session, &mut page, &body, &title, &author, note, None, true).await?;
        return Ok(json!({"mode": "direct", "suggestions": 0, "changed": changes.len(), "left_alone": left_alone}));
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
    Ok(json!({"mode": "suggest", "suggestions": changes.len(), "left_alone": left_alone}))
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

/// The page's pending suggestions, in page order where possible: `{suggestions: [...], count}`; each with its
/// before/after block, author, note and `stale`.
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
    let list: Vec<Value> = rows
        .iter()
        .map(|s| {
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
                "stale": is_stale(s, &current),
            })
        })
        .collect();
    let mut out = Map::new();
    out.insert("count".into(), json!(list.len()));
    out.insert("suggestions".into(), Value::Array(list));
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
}
