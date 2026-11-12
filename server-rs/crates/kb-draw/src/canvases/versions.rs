//! `services/canvases.py` lines 884-1228: versions (a frozen copy of the canvas file), compare and the source diff of a
//! frame.

use kb_base::{activity, pyjson};
use kb_db::Session;
use kb_db::entities::{canvas, canvas_version};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use kb_doctext::docs_text::DocsError;
use serde_json::{Map, Value, json};

use super::rows::{get_canvas, get_row, member_role, persist, touch};
use super::*;
use crate::{Result, canvas_locks};

/// The latest version row of a canvas.
async fn latest_version(session: &Session, canvas_id: &str) -> Result<Option<canvas_version::Model>> {
    Ok(canvas_version::Entity::find()
        .filter(canvas_version::Column::CanvasId.eq(canvas_id))
        .order_by_desc(canvas_version::Column::Version)
        .limit(1)
        .one(session)
        .await?)
}

/// `_older_than(iso, seconds)`: whether a time is at least that long ago (an unreadable one counts as old).
pub fn older_than(iso: Option<&str>, seconds: i64) -> bool {
    let Some(iso) = iso.filter(|s| !s.is_empty()) else { return true };
    match kb_base::time::parse_iso(iso) {
        Some(parsed) => (chrono::Utc::now() - parsed.utc()).num_milliseconds() as f64 / 1000.0 >= seconds as f64,
        None => true,
    }
}

/// `_last_version_time(session, canvas_id)`.
pub async fn last_version_time(session: &Session, canvas_id: &str) -> Result<Option<String>> {
    Ok(latest_version(session, canvas_id).await?.map(|v| v.created_at))
}

fn boards_by_id(doc: &Doc) -> Vec<(String, &Value)> {
    list(doc, "boards").iter().map(|b| (b.get("id").and_then(Value::as_str).unwrap_or("").to_string(), b)).collect()
}

fn content_rev(b: &Value) -> Option<&Value> {
    b.get("content").filter(|c| pyjson::truthy(c)).and_then(|c| c.get("rev"))
}

/// What changed between two canvas files: boards added, removed and changed (content or name), and whether notes,
/// arrows, labels or the layout moved.
pub fn diff_docs(old: Option<&Doc>, new: &Doc) -> Value {
    let empty = Map::new();
    let old = old.unwrap_or(&empty);
    let old_b = boards_by_id(old);
    let new_b = boards_by_id(new);
    let in_old = |id: &str| old_b.iter().find(|(k, _)| k == id).map(|(_, b)| *b);
    let in_new = |id: &str| new_b.iter().find(|(k, _)| k == id).map(|(_, b)| *b);
    let added: Vec<&str> = new_b.iter().filter(|(i, _)| in_old(i).is_none()).map(|(i, _)| i.as_str()).collect();
    let removed: Vec<&str> = old_b.iter().filter(|(i, _)| in_new(i).is_none()).map(|(i, _)| i.as_str()).collect();
    let changed: Vec<&str> = new_b
        .iter()
        .filter(|(i, nb)| {
            in_old(i).is_some_and(|ob| {
                !py_eq_opt(content_rev(ob), content_rev(nb))
                    || !py_eq_opt(ob.get("ref"), nb.get("ref"))
                    || !py_eq_opt(ob.get("name"), nb.get("name"))
            })
        })
        .map(|(i, _)| i.as_str())
        .collect();
    let layout = new_b.iter().any(|(i, nb)| {
        in_old(i).is_some_and(|ob| ["x", "y", "w", "h", "page"].iter().any(|k| !py_eq_opt(ob.get(*k), nb.get(*k))))
    });
    let strip = |items: &[Value]| -> Vec<Value> {
        items
            .iter()
            .map(|i| match i {
                Value::Object(m) => {
                    Value::Object(m.iter().filter(|(k, _)| *k != "rev").map(|(k, v)| (k.clone(), v.clone())).collect())
                }
                other => other.clone(),
            })
            .collect()
    };
    let mut out = Map::new();
    out.insert("added".into(), json!(added));
    out.insert("removed".into(), json!(removed));
    out.insert("changed".into(), json!(changed));
    out.insert("layout".into(), json!(layout));
    for k in ["notes", "arrows", "labels", "pages"] {
        let differs = !py_eq(&Value::Array(strip(list(old, k))), &Value::Array(strip(list(new, k))));
        out.insert(k.into(), json!(differs));
    }
    Value::Object(out)
}

/// A short sentence for History: "Sign in edited, 1 board added".
pub fn describe_changes(ch: &Value, names: &[(String, String)]) -> String {
    let ids = |k: &str| -> Vec<String> {
        ch.get(k)
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default()
    };
    let flag = |k: &str| ch.get(k).is_some_and(pyjson::truthy);
    let plural = |n: usize| if n != 1 { "s" } else { "" };
    let (changed, added, removed) = (ids("changed"), ids("added"), ids("removed"));
    let mut parts: Vec<String> = Vec::new();
    if !changed.is_empty() {
        let shown: Vec<&str> = changed
            .iter()
            .take(2)
            .map(|i| names.iter().find(|(k, _)| k == i).map_or("a frame", |(_, n)| n.as_str()))
            .collect();
        let more = if changed.len() > 2 { format!(" and {} more", changed.len() - 2) } else { String::new() };
        parts.push(format!("{} edited{more}", shown.join(", ")));
    }
    if !added.is_empty() {
        parts.push(format!("{} frame{} added", added.len(), plural(added.len())));
    }
    if !removed.is_empty() {
        parts.push(format!("{} frame{} removed", removed.len(), plural(removed.len())));
    }
    if parts.is_empty() {
        let extra: Vec<&str> = [("Notes", "notes"), ("Arrows", "arrows"), ("Labels", "labels")]
            .iter()
            .filter(|(_, k)| flag(k))
            .map(|(w, _)| *w)
            .collect();
        if !extra.is_empty() {
            // `" and ".join(extra).lower().capitalize()`
            let joined = extra.join(" and ").to_lowercase();
            let mut chars = joined.chars();
            let first = chars.next().map(|c| c.to_uppercase().collect::<String>()).unwrap_or_default();
            parts.push(format!("{first}{}", chars.as_str()));
        } else if flag("layout") || flag("pages") {
            parts.push("Layout changed".into());
        }
    }
    parts.join(", ")
}

/// Freeze the current file as the next version (the row is written; the caller commits).
pub async fn version(
    session: &Session,
    c: &mut canvas::Model,
    reason: &str,
    name: Option<&str>,
    note: Option<&str>,
    author: Option<&str>,
) -> Result<canvas_version::Model> {
    let doc = read_doc(&c.id)?;
    let prev = latest_version(session, &c.id).await?;
    let old: Option<Doc> = match &prev {
        Some(p) => match pyjson::loads(&p.doc) {
            Some(Value::Object(o)) => Some(o),
            _ => return Err(crate::Error::Value("a stored version is not JSON".into())),
        },
        None => None,
    };
    let ch = diff_docs(old.as_ref(), &doc);
    // `{new names} | {old names}`: an old name wins
    let mut names: Vec<(String, String)> = Vec::new();
    let mut put = |id: String, name: String| match names.iter_mut().find(|(k, _)| *k == id) {
        Some(slot) => slot.1 = name,
        None => names.push((id, name)),
    };
    for (id, b) in boards_by_id(&doc) {
        put(id, b.get("name").and_then(Value::as_str).unwrap_or("").to_string());
    }
    if let Some(old) = &old {
        for (id, b) in boards_by_id(old) {
            put(id, b.get("name").and_then(Value::as_str).unwrap_or("").to_string());
        }
    }
    c.version += 1;
    let mut row = canvas_version::new();
    row.canvas_id = Set(c.id.clone());
    row.version = Set(c.version);
    // `(name or None) and _text(name, 80)`
    row.name = Set(name.filter(|n| !n.is_empty()).map(|n| text(Some(&json!(n)), 80)));
    row.reason = Set(reason.to_string());
    row.author = Set(author.map(str::to_string).unwrap_or_else(activity::current_actor));
    row.note = Set(note.map(str::to_string));
    row.changes = Set(pyjson::dumps(&ch));
    row.summary = Set(if prev.is_some() {
        describe_changes(&ch, &names)
    } else {
        note.filter(|n| !n.is_empty()).unwrap_or("Created").to_string()
    });
    row.doc = Set(pyjson::Dumps::new().ensure_ascii(false).dump(&doc));
    let v = row.insert(session).await?;
    *c = persist(session, c).await?;
    Ok(v)
}

/// `_version_out(v, with_doc=...)`.
pub fn version_out(v: &canvas_version::Model, with_doc: bool) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("version".into(), json!(v.version));
    out.insert("name".into(), json!(v.name));
    out.insert("reason".into(), json!(v.reason));
    out.insert("author".into(), json!(v.author));
    out.insert("note".into(), json!(v.note));
    out.insert("summary".into(), json!(v.summary));
    let changes = if v.changes.is_empty() { json!({}) } else { pyjson::loads(&v.changes).unwrap_or(json!({})) };
    out.insert("changes".into(), changes);
    out.insert("created_at".into(), json!(v.created_at));
    if with_doc {
        out.insert("doc".into(), pyjson::loads(&v.doc).unwrap_or(Value::Null));
    }
    out
}

/// The canvas's versions, newest first.
pub async fn list_versions(session: &Session, canvas_id: &str) -> Result<Vec<Map<String, Value>>> {
    get_row(session, canvas_id, false).await?;
    let rows = canvas_version::Entity::find()
        .filter(canvas_version::Column::CanvasId.eq(canvas_id))
        .order_by_desc(canvas_version::Column::Version)
        .all(session)
        .await?;
    Ok(rows.iter().map(|v| version_out(v, false)).collect())
}

/// `_get_version(session, canvas_id, n)`. Fails with 404 for a number that is not there.
pub async fn get_version_row(session: &Session, canvas_id: &str, n: i32) -> Result<canvas_version::Model> {
    canvas_version::Entity::find()
        .filter(canvas_version::Column::CanvasId.eq(canvas_id))
        .filter(canvas_version::Column::Version.eq(n))
        .one(session)
        .await?
        .ok_or_else(|| {
            DocsError::new(404, "version_not_found", format!("There is no version {n} of this canvas.")).into()
        })
}

/// One version with the canvas file as it was.
pub async fn get_version(session: &Session, canvas_id: &str, n: i32) -> Result<Map<String, Value>> {
    get_row(session, canvas_id, false).await?;
    Ok(version_out(&get_version_row(session, canvas_id, n).await?, true))
}

/// Name (or unname) a version.
pub async fn name_version(
    session: &Session,
    canvas_id: &str,
    n: i32,
    name: Option<&str>,
) -> Result<Map<String, Value>> {
    let c = get_row(session, canvas_id, false).await?;
    member_role(session, &c).await?;
    let v = get_version_row(session, canvas_id, n).await?;
    let cleaned = text(name.map(|n| json!(n)).as_ref(), 80);
    let cleaned = kb_base::pytext::strip(&cleaned).to_string();
    let mut am: canvas_version::ActiveModel = v.into();
    am.name = Set(if cleaned.is_empty() { None } else { Some(cleaned) });
    let v = am.update(session).await?;
    session.commit().await?;
    Ok(version_out(&v, false))
}

/// Make a version of the canvas as it is now.
pub async fn make_version(
    session: &Session,
    canvas_id: &str,
    name: Option<&str>,
    note: Option<&str>,
    reason: &str,
) -> Result<Map<String, Value>> {
    let _guard = serial(canvas_id).await;
    let mut c = get_row(session, canvas_id, false).await?;
    member_role(session, &c).await?;
    let v = version(session, &mut c, reason, name, note, None).await?;
    session.commit().await?;
    Ok(version_out(&v, false))
}

/// Restore a version. Restoring makes a *new* version; nothing is lost. Fails with 403 for viewers and 423
/// `board_locked` while somebody is editing a frame.
pub async fn restore_version(session: &Session, canvas_id: &str, n: i32) -> Result<Map<String, Value>> {
    let _guard = serial(canvas_id).await;
    let mut c = get_row(session, canvas_id, false).await?;
    member_role(session, &c).await?;
    let live = canvas_locks::locks_of(&c.id);
    if let Some(first) = live.first() {
        return Err(DocsError::new(
            423,
            "board_locked",
            format!(
                "{} is editing a frame. Restore once they save or leave.",
                kb_base::pyjson::py_str(first.get("holder").unwrap_or(&Value::Null))
            ),
        )
        .with("locks", Value::Array(live.into_iter().map(Value::Object).collect()))
        .into());
    }
    let old = pyjson::loads(&get_version_row(session, canvas_id, n).await?.doc).unwrap_or(Value::Null);
    let mut doc = normalize(old)?;
    let new_rev = c.rev + 1;
    for k in save::KINDS.iter().map(|(k, _)| *k) {
        for item in list_mut(&mut doc, k) {
            if let Value::Object(m) = item {
                // everybody still working on the old state conflicts on their next save
                m.insert("rev".into(), json!(new_rev));
            }
        }
    }
    c.rev = new_rev - 1;
    touch(&mut c, &doc);
    write_doc(&c.id, &doc)?;
    c = persist(session, &c).await?;
    session.commit().await?;
    version(session, &mut c, "restore", None, Some(&format!("Restored version {n}")), None).await?;
    session.commit().await?;
    rows::reindex(session, &c).await?;
    get_canvas(session, &c.id).await
}

fn version_doc(v: &canvas_version::Model) -> Doc {
    match pyjson::loads(&v.doc) {
        Some(Value::Object(o)) => o,
        _ => Map::new(),
    }
}

/// Compare two versions board by board: `same`, `changed`, `added` or `removed` (`b` against `a`).
pub async fn compare(session: &Session, canvas_id: &str, a: i32, b: i32) -> Result<Map<String, Value>> {
    get_row(session, canvas_id, false).await?;
    let da = version_doc(&get_version_row(session, canvas_id, a).await?);
    let db = version_doc(&get_version_row(session, canvas_id, b).await?);
    let ba = boards_by_id(&da);
    let bb = boards_by_id(&db);
    let mut ids: Vec<&str> = bb.iter().map(|(i, _)| i.as_str()).collect();
    ids.extend(ba.iter().map(|(i, _)| i.as_str()).filter(|i| !bb.iter().any(|(k, _)| k == i)));
    let mut rows = Vec::new();
    for bid in ids {
        let x = ba.iter().find(|(k, _)| k == bid).map(|(_, v)| *v);
        let y = bb.iter().find(|(k, _)| k == bid).map(|(_, v)| *v);
        let state = match (x, y) {
            (None, _) => "added",
            (_, None) => "removed",
            (Some(x), Some(y)) => {
                if !py_eq_opt(content_rev(x), content_rev(y)) || !py_eq_opt(x.get("ref"), y.get("ref")) {
                    "changed"
                } else {
                    "same"
                }
            }
        };
        let pick = y.or(x).unwrap_or(&Value::Null);
        let mut row = Map::new();
        row.insert("board_id".into(), json!(bid));
        row.insert("name".into(), pick.get("name").cloned().unwrap_or(Value::Null));
        row.insert("state".into(), json!(state));
        row.insert("kind".into(), pick.get("kind").cloned().unwrap_or(Value::Null));
        row.insert("a".into(), x.cloned().unwrap_or(Value::Null));
        row.insert("b".into(), y.cloned().unwrap_or(Value::Null));
        rows.push(Value::Object(row));
    }
    let mut out = Map::new();
    out.insert("a".into(), json!(a));
    out.insert("b".into(), json!(b));
    out.insert("boards".into(), Value::Array(rows));
    Ok(out)
}

/// `_read_text(canvas_id, board_id, board, path)`: a text file of a frame at the revision that board holds, or an empty
/// string.
fn read_text(canvas_id: &str, board_id: &str, board: Option<&Value>, path: &str) -> String {
    let Some(content) = board.and_then(|b| b.get("content")).filter(|c| pyjson::truthy(c)) else {
        return String::new();
    };
    let rev = content.get("rev").map_or(0, as_int);
    let read = || -> std::result::Result<String, crate::Error> {
        let file = file_in(&board_dir(canvas_id, board_id, rev)?, path)?;
        Ok(String::from_utf8_lossy(&std::fs::read(file)?).into_owned())
    };
    read().unwrap_or_default()
}

/// Line diff of a board's source between two versions (the entry file, then other text files).
pub async fn source_diff(
    session: &Session,
    canvas_id: &str,
    board_id: &str,
    a: i32,
    b: i32,
) -> Result<Map<String, Value>> {
    get_row(session, canvas_id, false).await?;
    let da = version_doc(&get_version_row(session, canvas_id, a).await?);
    let db = version_doc(&get_version_row(session, canvas_id, b).await?);
    let find_board =
        |d: &Doc| list(d, "boards").iter().find(|x| x.get("id").and_then(Value::as_str) == Some(board_id)).cloned();
    let (xa, xb) = (find_board(&da), find_board(&db));
    let mut paths: Vec<String> = Vec::new();
    for bd in [&xa, &xb].into_iter().flatten() {
        if let Some(content) = bd.get("content").filter(|c| pyjson::truthy(c)) {
            for f in content.get("files").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default() {
                if let Some(p) = f.get("path").and_then(Value::as_str) {
                    if !paths.iter().any(|q| q == p) {
                        paths.push(p.to_string());
                    }
                }
            }
        }
    }
    paths.sort();
    let mut files = Vec::new();
    for path in paths {
        let ext = kb_files::pathlib::suffix(&path).to_lowercase();
        if !TEXT_EXT.contains(&ext.as_str()) {
            continue;
        }
        let before = read_text(canvas_id, board_id, xa.as_ref(), &path);
        let after = read_text(canvas_id, board_id, xb.as_ref(), &path);
        if before == after {
            continue;
        }
        let diff = textdiff::unified_diff(
            &kb_base::pytext::splitlines(&before),
            &kb_base::pytext::splitlines(&after),
            &format!("v{a}/{path}"),
            &format!("v{b}/{path}"),
            2,
        );
        let shown: Vec<&str> = diff.iter().take(2000).map(String::as_str).collect();
        files.push(json!({"path": path, "diff": shown.join("\n")}));
    }
    let mut out = Map::new();
    out.insert("board_id".into(), json!(board_id));
    out.insert("a".into(), json!(a));
    out.insert("b".into(), json!(b));
    out.insert("files".into(), Value::Array(files));
    Ok(out)
}
