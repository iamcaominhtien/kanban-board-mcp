//! "Changes since you last viewed" (`services/docs_ai/history.py`, `changed_since_viewed` and `since_viewed_handler`):
//! the server finds the pages published since the person last saw them and the assistant says what changed in each.

use std::collections::HashMap;

use chrono::{Duration, Utc};
use kb_base::{pyjson, pytext, time};
use kb_db::Session;
use kb_db::entities::{docs_ai_job, docs_page, docs_page_seen};
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
/// the result is `{pages: [{page_id, title, kind, from_version, to_version, line}], count, lines}`. Without a changed
/// page no turn is run.
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
        let pages: Vec<Value> = rows
            .iter()
            .zip(found)
            .map(|(r, line)| {
                json!({
                    "page_id": r.page.id,
                    "title": r.page.title,
                    "kind": r.kind.word(),
                    "from_version": r.from,
                    "to_version": r.page.version,
                    "line": line.map(|l| clip(&l, 400)),
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
