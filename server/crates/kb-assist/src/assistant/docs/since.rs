//! "Changes since you last viewed" (`services/docs_ai/history.py`, `changed_since_viewed` and `since_viewed_handler`):
//! the server finds the pages published since the person last saw them and the assistant says what changed in each.

use std::collections::HashMap;

use chrono::{Duration, Utc};
use kb_base::{pyjson, pytext, time};
use kb_db::Session;
use kb_db::entities::{docs_ai_job, docs_page, docs_page_seen, docs_version};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::sync::LazyLock;

use super::{TurnExtra, boxed, clip, cost, items, merge, text_of, turn};
use crate::docs_ai::errors::Error;
use crate::docs_ai::jobs::HandlerFuture;

/// The most pages one digest lists.
pub const MAX_DIGEST_PAGES: usize = 8;
/// How many days a page that the person never opened still counts as new.
pub const NEW_PAGE_DAYS: i64 = 14;

/// `^\W*(.+?):\s+(.+)$`: a "Title: what changed" line, a bullet or other marks before the title allowed.
static LINE: LazyLock<Regex> = LazyLock::new(|| match Regex::new(r"^\W*(.+?):\s+(.+)$") {
    Ok(re) => re,
    Err(err) => unreachable!("the line pattern is a constant: {err}"),
});

/// Why a page is in the digest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    /// The person saw an older version of the page.
    Changed,
    /// The person never opened the page and it was made lately by someone else.
    New,
}

impl Change {
    /// The word the Docs UI reads (`kind`).
    fn word(self) -> &'static str {
        match self {
            Change::Changed => "changed",
            Change::New => "new",
        }
    }
}

/// A page of the digest.
#[derive(Debug, Clone)]
pub struct Changed {
    /// The page, at its published version.
    pub page: docs_page::Model,
    /// Why it is listed.
    pub kind: Change,
    /// The version the person saw (0 when never).
    pub from: i32,
}

/// Pages published since `person` last viewed them, newest first. A page the person never viewed counts only when it
/// is new (made in the last `NEW_PAGE_DAYS` days by somebody else); a page they changed themselves and have seen
/// since is left out.
pub async fn changed_since_viewed(session: &Session, project_id: &str, person: &str) -> Result<Vec<Changed>, Error> {
    let cutoff = time::iso(&(Utc::now() - Duration::days(NEW_PAGE_DAYS)));
    let seen: HashMap<String, i32> = docs_page_seen::Entity::find()
        .filter(docs_page_seen::Column::Viewer.eq(person))
        .all(session)
        .await?
        .into_iter()
        .map(|s| (s.page_id, s.version))
        .collect();
    let pages = docs_page::Entity::find()
        .filter(docs_page::Column::ProjectId.eq(project_id))
        .filter(docs_page::Column::DeletedAt.is_null())
        .filter(docs_page::Column::Version.gt(0))
        .all(session)
        .await?;
    let mut out = Vec::new();
    for page in pages {
        match seen.get(&page.id) {
            Some(&version) if page.updated_by == person && version >= page.version => {}
            Some(&version) if page.version > version => {
                out.push(Changed { page, kind: Change::Changed, from: version });
            }
            Some(_) => {}
            None if page.created_at >= cutoff && page.created_by != person => {
                out.push(Changed { page, kind: Change::New, from: 0 });
            }
            None => {}
        }
    }
    out.sort_by(|a, b| b.page.updated_at.cmp(&a.page.updated_at));
    out.truncate(MAX_DIGEST_PAGES);
    Ok(out)
}

/// A rich version of a page as JSON, `None` for a Markdown version or one that is not there.
async fn rich_version(session: &Session, page_id: &str, version: i32) -> Result<Option<Value>, Error> {
    if version <= 0 {
        return Ok(None);
    }
    let row = docs_version::Entity::find()
        .filter(docs_version::Column::PageId.eq(page_id))
        .filter(docs_version::Column::Version.eq(version))
        .one(session)
        .await?;
    Ok(row.filter(|v| v.format == "rich").and_then(|v| v.content).and_then(|c| serde_json::from_str(&c).ok()))
}

/// The top-level blocks of a rich page.
fn top(doc: &Value) -> Vec<&Value> {
    doc.get("content").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default()
}

/// One block of a digest row: `{block_id, type, level, n, change}`. `type` is the block's node type (`paragraph`,
/// `heading`, `pullQuote`…), `level` a heading's level, `n` its place among the page's blocks of that type (1-based;
/// `None` when it is the only one), `change` `edited` or `added`.
fn block_chip(doc: &Value, block: &Value, change: &str) -> Value {
    let ty = block.get("type").and_then(Value::as_str).unwrap_or("");
    let id = kb_docs::docs::blocks::block_id_of(block);
    let same: Vec<&Value> =
        top(doc).into_iter().filter(|b| b.get("type").and_then(Value::as_str) == Some(ty)).collect();
    let n = id
        .and_then(|id| same.iter().position(|b| kb_docs::docs::blocks::block_id_of(b) == Some(id)))
        .filter(|_| same.len() > 1)
        .map(|i| i + 1);
    json!({
        "block_id": id,
        "type": ty,
        "level": block.get("attrs").and_then(|a| a.get("level")).cloned().unwrap_or(Value::Null),
        "n": n,
        "change": change,
    })
}

/// What changed in a page's blocks since the version the person saw: `{edited, added, removed, blocks}` (`blocks`:
/// the edited and added ones in page order, at most 12, as [`block_chip`] writes them). For a new page every block
/// counts as added and `blocks` is empty. `None` when either version is not a rich page.
async fn block_changes(session: &Session, row: &Changed) -> Result<Option<Value>, Error> {
    let Some(new) = rich_version(session, &row.page.id, row.page.version).await? else { return Ok(None) };
    if row.kind == Change::New {
        let n = top(&new).len();
        return Ok(Some(json!({"edited": 0, "added": n, "removed": 0, "blocks": []})));
    }
    let Some(old) = rich_version(session, &row.page.id, row.from).await? else { return Ok(None) };
    let changes = kb_docs::docs_suggestions::diff_blocks(&old, &new);
    // a page saved as Markdown gets new block ids: a new block with the words of a removed one is the same block,
    // and one of the same kind in its place is that block edited
    let text = |b: &Option<Value>| b.as_ref().map(kb_docs::docs::blocks::block_text).unwrap_or_default();
    let ty = |b: &Option<Value>| b.as_ref().and_then(|b| b.get("type")).and_then(Value::as_str).map(str::to_string);
    let mut deletes: Vec<&kb_docs::docs_suggestions::BlockChange> =
        changes.iter().filter(|c| c.kind == "delete").collect();
    let mut kinds: Vec<(&kb_docs::docs_suggestions::BlockChange, &str)> = Vec::new();
    let mut inserts = Vec::new();
    for c in &changes {
        match c.kind {
            "delete" => {}
            "insert" => match deletes.iter().position(|d| text(&d.before) == text(&c.content)) {
                Some(at) => {
                    deletes.remove(at);
                }
                None => inserts.push(c),
            },
            _ => kinds.push((c, "edited")),
        }
    }
    for c in inserts {
        match deletes.iter().position(|d| ty(&d.before) == ty(&c.content)) {
            Some(at) => {
                deletes.remove(at);
                kinds.push((c, "edited"));
            }
            None => kinds.push((c, "added")),
        }
    }
    // in page order
    let order: Vec<&str> = top(&new).into_iter().filter_map(kb_docs::docs::blocks::block_id_of).collect();
    kinds.sort_by_key(|(c, _)| c.block_id.as_deref().and_then(|id| order.iter().position(|o| *o == id)));
    let edited = kinds.iter().filter(|(_, k)| *k == "edited").count();
    let added = kinds.iter().filter(|(_, k)| *k == "added").count();
    let removed = deletes.len();
    let mut chips = Vec::new();
    for (c, change) in &kinds {
        let block = c.block_id.as_deref().and_then(|id| kb_docs::docs::blocks::find_block(&new, id));
        if let Some(block) = block.filter(|_| chips.len() < 12) {
            chips.push(block_chip(&new, block, change));
        }
    }
    Ok(Some(json!({"edited": edited, "added": added, "removed": removed, "blocks": chips})))
}

/// A title as a model writes it at the start of a line: marks and quotes around it do not count.
fn title_key(title: &str) -> String {
    title.trim_matches(|c| matches!(c, '*' | '\u{201c}' | '\u{201d}' | ' ')).to_lowercase()
}

/// The line the assistant wrote for each page: `lines` holds "Title: what changed" texts, or objects with the page's
/// `page_id` (or `title`) and its `line`. A page the assistant said nothing about has `None`.
fn lines_by_page(rows: &[Changed], lines: &[Value]) -> Vec<Option<String>> {
    let mut found: Vec<Option<String>> = vec![None; rows.len()];
    for entry in lines {
        // (the page's id when the answer gives it, the page's title as written, the line)
        let (page_id, title, line) = match entry {
            Value::String(raw) => {
                let Some(m) = LINE.captures(pytext::strip(raw)) else { continue };
                (None, title_key(&m[1]), m[2].trim().to_string())
            }
            Value::Object(map) => {
                let said = |key: &str| map.get(key).filter(|v| pyjson::truthy(v)).map(text_of);
                let line = said("line").or_else(|| said("text")).unwrap_or_default();
                let title = said("title").or_else(|| said("page")).unwrap_or_default();
                (said("page_id"), title_key(&title), line.trim().to_string())
            }
            _ => continue,
        };
        if line.is_empty() {
            continue;
        }
        let at = rows.iter().enumerate().position(|(i, r)| {
            found[i].is_none()
                && match &page_id {
                    Some(id) => r.page.id == *id,
                    None => title_key(&r.page.title) == title,
                }
        });
        if let Some(at) = at {
            found[at] = Some(line);
        }
    }
    found
}

/// What changed in the space since the person last looked, one line per page.
///
/// The server picks the pages (`changed_since_viewed`) and gives the skill `pages` [{page_id, title, seen_version}];
/// the result is `{pages: [{page_id, title, kind, from_version, to_version, line, by, at, blocks}], count, lines}`
/// (`by` and `at`: who published the page last and when; `blocks`: what changed block by block, [`block_changes`]).
/// Without a changed page no turn is run.
pub fn since_viewed_job(job: docs_ai_job::Model) -> HandlerFuture {
    boxed(async move {
        let rows = {
            let session = kb_db::database::session();
            changed_since_viewed(&session, &job.project_id, &job.started_by).await?
        };
        let mut lines: Vec<Value> = Vec::new();
        let mut spent = Map::new();
        if !rows.is_empty() {
            let pages: Vec<Value> = rows
                .iter()
                .map(|r| json!({"page_id": r.page.id, "title": r.page.title, "seen_version": r.from}))
                .collect();
            let mut inputs = Map::new();
            inputs.insert("task".into(), json!("since_viewed"));
            inputs.insert("project_id".into(), json!(job.project_id));
            inputs.insert("pages".into(), Value::Array(pages));
            let name = format!("docs-ask:{}", job.project_id);
            let out = turn(&job, "docs-history", inputs, Some(name), TurnExtra::default()).await?;
            lines = items(out.data().get("lines"));
            spent = cost(&out);
        }
        let found = lines_by_page(&rows, &lines);
        let mut changes = Vec::new();
        {
            let session = kb_db::database::session();
            for r in &rows {
                changes.push(block_changes(&session, r).await?);
            }
        }
        let pages: Vec<Value> = rows
            .iter()
            .zip(found)
            .zip(changes)
            .map(|((r, line), blocks)| {
                json!({
                    "page_id": r.page.id,
                    "title": r.page.title,
                    "kind": r.kind.word(),
                    "from_version": r.from,
                    "to_version": r.page.version,
                    "line": line.map(|l| clip(&l, 400)),
                    "by": r.page.updated_by,
                    "at": r.page.updated_at,
                    "blocks": blocks,
                })
            })
            .collect();
        let mut result = Map::new();
        let count = pages.len();
        result.insert("pages".into(), Value::Array(pages));
        result.insert("count".into(), json!(count));
        result.insert("lines".into(), Value::Array(lines));
        if spent.is_empty() {
            spent.insert("cost".into(), json!(0.0));
            spent.insert("metered".into(), json!(false));
        }
        Ok(merge(result, spent))
    })
}
