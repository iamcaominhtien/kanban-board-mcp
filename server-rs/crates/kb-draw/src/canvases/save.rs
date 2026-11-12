//! `services/canvases.py` lines 659-882: saving layout changes, merged per item.

use kb_base::{activity, pyjson};
use kb_db::Session;
use kb_doctext::docs_text::DocsError;
use regex::Regex;
use serde_json::{Map, Value, json};

use super::rows::{get_row, member_role, persist, touch};
use super::*;
use crate::{Result, canvas_locks, sketches};

/// `KINDS`: the lists of the canvas file and the prefix of their ids, in the order Python has them.
pub const KINDS: [(&str, &str); 5] =
    [("pages", "p"), ("boards", "b"), ("notes", "n"), ("arrows", "a"), ("labels", "t")];

fn kind_prefix(key: &str) -> Option<&'static str> {
    KINDS.iter().find(|(k, _)| *k == key).map(|(_, p)| *p)
}

/// `_conflict(c, ids)`.
fn conflict(c: &kb_db::entities::canvas::Model, ids: &[String]) -> DocsError {
    DocsError::new(
        409,
        "canvas_conflict",
        format!("{} saved a newer version of the same frame or note while you were working.", c.updated_by),
    )
    .with("latest_rev", c.rev)
    .with("latest_author", c.updated_by.clone())
    .with("latest_at", c.updated_at.clone())
    .with("conflicts", json!(ids))
}

/// What `save` is told.
#[derive(Debug, Clone, Default)]
pub struct SaveArgs {
    /// The revision the editor loaded (kept for the error message; the check is per item).
    pub base_rev: i64,
    /// `{pages|boards|notes|arrows|labels: [item]}` in the order sent. An item that exists must carry the `rev` the
    /// editor saw; a new note, arrow, label or page has no `rev`. Boards are only moved/renamed here.
    pub upsert: Vec<(String, Vec<Map<String, Value>>)>,
    /// Ids of items to delete.
    pub remove: Vec<String>,
    /// New canvas name.
    pub title: Option<String>,
    /// Overwrite items somebody else changed ("Replace theirs").
    pub force: bool,
    /// Make a version of the whole canvas (Done).
    pub checkpoint: bool,
    /// Name for that version.
    pub name: Option<String>,
    /// Note for that version.
    pub note: Option<String>,
}

/// Save layout changes, merged per item. Returns `{rev, version, doc, saved}`. Fails with 403 for viewers, 409
/// `canvas_conflict` if the same item was changed by both, and 422 for limits.
pub async fn save(session: &Session, canvas_id: &str, args: SaveArgs) -> Result<Map<String, Value>> {
    let _guard = serial(canvas_id).await;
    let mut c = get_row(session, canvas_id, false).await?;
    member_role(session, &c).await?;
    let mut doc = read_doc(&c.id)?;
    let actor = activity::current_actor();
    let new_rev = i64::from(c.rev) + 1;
    let mut conflicts: Vec<String> = Vec::new();
    let mut changed = 0u32;
    let id_form = |prefix: &str| Regex::new(&format!("^{prefix}_[0-9a-f]{{8}}$")).expect("static pattern");

    for (key, items) in &args.upsert {
        let Some(prefix) = kind_prefix(key) else {
            return Err(DocsError::new(422, "invalid_canvas", format!("Unknown list \u{201c}{key}\u{201d}.")).into());
        };
        for src in items {
            let item_id = text(src.get("id"), 40);
            let existing_at = if item_id.is_empty() { None } else { find(list(&doc, key), &item_id) };
            if let Some(at) = existing_at {
                let existing = list(&doc, key)[at].clone();
                if !py_eq_opt(src.get("rev"), existing.get("rev")) && !args.force {
                    conflicts.push(item_id);
                    continue;
                }
                let before = pyjson::Dumps::new().sort_keys(true).dump(&existing);
                let mut item = existing.as_object().cloned().unwrap_or_default();
                apply(&doc, key, &mut item, src, &actor)?;
                let after = pyjson::Dumps::new().sort_keys(true).dump(&item);
                if after != before {
                    item.insert("rev".into(), json!(new_rev));
                    changed += 1;
                }
                list_mut(&mut doc, key)[at] = Value::Object(item);
                continue;
            }
            let src_rev_set = src.get("rev").is_some_and(|r| !r.is_null());
            if key == "boards" {
                if src_rev_set {
                    // it was there when the editor loaded it, and somebody deleted it: a conflict, not a refusal
                    conflicts.push(item_id);
                    continue;
                }
                return Err(DocsError::new(
                    422,
                    "invalid_canvas",
                    "A frame is added with its content (POST /canvases/{id}/boards).",
                )
                .into());
            }
            if src_rev_set && !args.force {
                // it existed when the editor loaded it, and somebody deleted it
                conflicts.push(item_id);
                continue;
            }
            let id = if id_form(prefix).is_match(&item_id) { item_id } else { new_id(prefix) };
            let mut item = Map::new();
            item.insert("id".into(), json!(id));
            // `doc[key].append(item)` comes before `_apply`: the item is in the doc while its fields are checked
            list_mut(&mut doc, key).push(Value::Object(item.clone()));
            apply(&doc, key, &mut item, src, &actor)?;
            item.insert("rev".into(), json!(new_rev));
            let at = list(&doc, key).len() - 1;
            list_mut(&mut doc, key)[at] = Value::Object(item);
            changed += 1;
        }
    }

    for item_id in &args.remove {
        let Some(key) = KINDS.iter().find(|(_, p)| item_id.starts_with(&format!("{p}_"))).map(|(k, _)| *k) else {
            continue;
        };
        let Some(at) = find(list(&doc, key), item_id) else { continue };
        // a frame (or a page tab holding one) that somebody else is editing is not taken away from under them
        let doomed: Vec<String> = match key {
            "boards" => vec![item_id.clone()],
            "pages" => list(&doc, "boards")
                .iter()
                .filter(|b| b.get("page").and_then(Value::as_str) == Some(item_id.as_str()))
                .filter_map(|b| b.get("id").and_then(Value::as_str).map(str::to_string))
                .collect(),
            _ => Vec::new(),
        };
        for bid in &doomed {
            if let Some(held) = canvas_locks::holder_of(&c.id, bid) {
                if held.holder != actor {
                    return Err(DocsError::new(
                        423,
                        "board_locked",
                        format!(
                            "{} is editing a frame you are removing. Remove it once they save or leave.",
                            held.holder
                        ),
                    )
                    .with("holder", held.holder.clone())
                    .with("board_id", bid.clone())
                    .into());
                }
            }
        }
        list_mut(&mut doc, key).remove(at);
        canvas_locks::release_all(&c.id, Some(&doomed));
        if key == "pages" {
            for k in ["boards", "notes", "labels", "arrows"] {
                list_mut(&mut doc, k).retain(|i| i.get("page").and_then(Value::as_str) != Some(item_id.as_str()));
            }
        }
        changed += 1;
    }

    if !conflicts.is_empty() {
        return Err(conflict(&c, &conflicts).into());
    }

    check_doc(&mut doc)?;
    let removed_boards: Vec<String> = args.remove.iter().filter(|i| i.starts_with("b_")).cloned().collect();
    if !removed_boards.is_empty() {
        canvas_locks::release_all(&c.id, Some(&removed_boards));
    }
    if let Some(title) = &args.title {
        c.title = sketches::title(Some(title), &c.title);
    }
    if changed > 0 || args.title.is_some() || args.checkpoint {
        c.rev = (new_rev - 1) as i32;
        touch(&mut c, &doc);
        write_doc(&c.id, &doc)?;
        c = persist(session, &c).await?;
        session.commit().await?;
        if args.checkpoint {
            versions::version(session, &mut c, "done", args.name.as_deref(), args.note.as_deref(), None).await?;
        } else if c.page_id.as_deref().is_some_and(|p| !p.is_empty())
            && versions::older_than(versions::last_version_time(session, &c.id).await?.as_deref(), AUTO_VERSION_SECONDS)
        {
            versions::version(session, &mut c, "auto", None, None, None).await?;
        }
        session.commit().await?;
    }
    if changed > 0 {
        rows::reindex(session, &c).await?;
    }
    let mut out = Map::new();
    out.insert("rev".into(), json!(c.rev));
    out.insert("version".into(), json!(c.version));
    out.insert("doc".into(), Value::Object(doc));
    out.insert("saved".into(), json!(changed));
    Ok(out)
}

/// `_apply(doc, key, item, src, actor)`: the fields a client may set on one item.
fn apply(doc: &Doc, key: &str, item: &mut Map<String, Value>, src: &Map<String, Value>, actor: &str) -> Result<()> {
    match key {
        "boards" => {
            for (k, v) in clean_board_layout(src, Some(item)) {
                item.insert(k, v);
            }
            let known =
                list(doc, "pages").iter().any(|p| item.get("page").is_some_and(|ip| py_eq_opt(p.get("id"), Some(ip))));
            if !known {
                item.insert("page".into(), list(doc, "pages")[0]["id"].clone());
            }
        }
        "notes" => {
            for (k, v) in clean_note(src, Some(item), actor) {
                item.insert(k, v);
            }
        }
        "labels" => {
            for (k, v) in clean_label(src, Some(item)) {
                item.insert(k, v);
            }
        }
        "arrows" => {
            for (k, v) in clean_arrow(src, Some(item)) {
                item.insert(k, v);
            }
            let same = item.get("from") == item.get("to");
            if !arrow_ends_exist(doc, item) || same {
                return Err(DocsError::new(
                    422,
                    "invalid_canvas",
                    "An arrow joins two different frames or notes on this canvas.",
                )
                .into());
            }
        }
        "pages" => {
            let name = text(Some(src.get("name").or_else(|| item.get("name")).unwrap_or(&json!("Page"))), 80);
            let name = kb_base::pytext::strip(&name).to_string();
            item.insert("name".into(), json!(if name.is_empty() { "Page".to_string() } else { name }));
            let default = item.get("order").cloned().unwrap_or_else(|| json!(list(doc, "pages").len()));
            item.insert("order".into(), json!(as_int(&num(src.get("order"), &default, 0, 1000))));
        }
        _ => {}
    }
    Ok(())
}

/// `_check_doc(doc)`: the limits, and the fallbacks that keep every item on a page tab that exists.
pub fn check_doc(doc: &mut Doc) -> std::result::Result<(), DocsError> {
    if list(doc, "pages").len() > MAX_PAGES {
        return Err(DocsError::new(422, "too_many_pages", format!("A canvas has up to {MAX_PAGES} page tabs."))
            .with("limit_pages", MAX_PAGES));
    }
    if list(doc, "pages").is_empty() {
        return Err(DocsError::new(422, "invalid_canvas", "A canvas needs at least one page tab."));
    }
    if list(doc, "boards").len() > MAX_BOARDS {
        return Err(DocsError::new(422, "too_many_boards", format!("A canvas holds up to {MAX_BOARDS} frames."))
            .with("limit_boards", MAX_BOARDS));
    }
    if list(doc, "notes").len() > MAX_NOTES
        || list(doc, "arrows").len() > MAX_ARROWS
        || list(doc, "labels").len() > MAX_LABELS
    {
        return Err(DocsError::new(422, "too_many_items", "This canvas has too many notes, arrows or labels."));
    }
    let page_ids: Vec<Value> = list(doc, "pages").iter().map(|p| p.get("id").cloned().unwrap_or(Value::Null)).collect();
    let first = page_ids[0].clone();
    for k in ["boards", "notes", "labels", "arrows"] {
        for i in list_mut(doc, k) {
            if let Value::Object(m) = i {
                let page = m.get("page").cloned().unwrap_or(Value::Null);
                if !page_ids.iter().any(|p| py_eq(p, &page)) {
                    m.insert("page".into(), first.clone());
                }
            }
        }
    }
    let ends: Vec<String> = ["boards", "notes"]
        .iter()
        .flat_map(|k| {
            list(doc, k)
                .iter()
                .filter_map(|i| i.get("id").and_then(Value::as_str).map(str::to_string))
                .collect::<Vec<_>>()
        })
        .collect();
    list_mut(doc, "arrows").retain(|a| {
        let end = |k: &str| a.get(k).and_then(Value::as_str).is_some_and(|v| ends.iter().any(|e| e == v));
        end("from") && end("to")
    });
    Ok(())
}
