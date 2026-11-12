//! Docs health (design/screens/docs-ai-care.md, A3): one list for the whole space of pages that may no longer match
//! the board. Nothing here changes a page (`services/docs_ai/health.py`, lines 1 to 394).
//!
//! Out of date comes from the freshness checks. Missing docs (Done tickets no page links), Broken links (`[[links]]`
//! and sections that do not resolve) and Overlaps (pages with strongly similar titles or text) are found by rules on
//! the space's own data, with no model. Every live page is included (AI v2 reads what people read). Dismissals
//! (this time, 30 days, never) are remembered per item in `docs_ai_health.data.dismissed`.

use std::collections::HashSet;
use std::sync::LazyLock;

use chrono::{DateTime, Duration, FixedOffset, Utc};
use kb_ai::store::{loads, now_iso, parse_iso};
use kb_base::{pyjson, time};
use kb_db::Session;
use kb_db::database;
use kb_db::entities::{docs_ai_health, docs_link, docs_page, ticket};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter};
use regex::Regex;
use serde_json::{Map, Value, json};

use super::errors::{DocsAiError, Error};
use super::settings as svc_settings;

/// The kinds of finding.
pub const KINDS: [&str; 4] = ["out_of_date", "missing", "broken", "overlaps"];
/// Done tickets of the last 30 days.
pub const MISSING_DAYS: i64 = 30;
/// The most pages compared in pairs.
pub const MAX_PAIR_PAGES: usize = 200;
/// The title score (0 to 100) from which two titles are almost the same.
pub const TITLE_SIMILARITY: f64 = 92.0;
/// The share of the same text from which two pages overlap.
pub const TEXT_SIMILARITY: f64 = 0.6;
/// The fewest words a page needs to be compared by its text.
pub const MIN_WORDS: usize = 40;
/// The origins of a link that count as a page about the ticket.
const DIRECT: [&str; 6] = ["page", "manual", "description", "acceptance_criterion", "test_case", "debug_note"];

/// `_readable_pages`: the project's live pages (AI v2 reads what people read).
async fn readable_pages(session: &Session, project_id: &str) -> Result<Vec<docs_page::Model>, Error> {
    Ok(docs_page::Entity::find()
        .filter(docs_page::Column::ProjectId.eq(project_id))
        .filter(docs_page::Column::DeletedAt.is_null())
        .all(session)
        .await?)
}

/// The project's health row, created on first use.
pub async fn row_of(session: &Session, project_id: &str) -> Result<docs_ai_health::Model, Error> {
    if let Some(row) = docs_ai_health::Entity::find_by_id(project_id).one(session).await? {
        return Ok(row);
    }
    let mut new = docs_ai_health::new();
    new.project_id = Set(project_id.to_string());
    database::insert_missing(session, new).await?;
    session.commit().await?;
    docs_ai_health::Entity::find_by_id(project_id)
        .one(session)
        .await?
        .ok_or_else(|| Error::Other(format!("docs_ai_health {project_id} is missing")))
}

/// `data if isinstance(data, dict) else {}` of a stored `data` column.
fn data_map(raw: &str) -> Map<String, Value> {
    match loads(Some(raw), json!({})) {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// The stored findings of the last run.
pub async fn data_of(session: &Session, project_id: &str) -> Result<Map<String, Value>, Error> {
    Ok(data_map(&row_of(session, project_id).await?.data))
}

/// `_when`.
fn when(iso: Option<&str>) -> Option<DateTime<FixedOffset>> {
    parse_iso(iso)
}

/// `_closed_at`: when the ticket got its current status (its last status change), else when it was last updated.
fn closed_at(t: &ticket::Model) -> Option<DateTime<FixedOffset>> {
    let log = match loads(Some(&t.activity_log), json!([])) {
        Value::Array(items) => items,
        _ => Vec::new(),
    };
    for e in log.iter().rev() {
        if e.is_object()
            && e.get("field").and_then(Value::as_str) == Some("status")
            && e.get("to").and_then(Value::as_str) == Some(t.status.as_str())
        {
            return when(e.get("at").and_then(Value::as_str));
        }
    }
    when(Some(&t.updated_at))
}

/// `_ago_note`.
fn ago_note(at: Option<DateTime<FixedOffset>>) -> String {
    let Some(at) = at else { return "Done".to_string() };
    // `timedelta.days` floors
    let seconds = (Utc::now() - at.with_timezone(&Utc)).num_seconds();
    let days = seconds.div_euclid(86_400);
    if days <= 0 {
        "Done today".to_string()
    } else {
        format!("Done {days} day{} ago", if days != 1 { "s" } else { "" })
    }
}

/// `_missing`: Done tickets (of the last 30 days, not sub-tasks) that no page about the ticket links to.
async fn missing(session: &Session, project_id: &str, readable: &HashSet<String>) -> Result<Vec<Value>, Error> {
    let since = Utc::now() - Duration::days(MISSING_DAYS);
    let tickets = ticket::Entity::find()
        .filter(ticket::Column::ProjectId.eq(project_id))
        .filter(ticket::Column::Status.eq("done"))
        .all(session)
        .await?;
    let mut out: Vec<Value> = Vec::new();
    for t in tickets {
        let done_at = closed_at(&t);
        if t.parent_id.as_deref().is_some_and(|p| !p.is_empty())
            || done_at.is_some_and(|d| d.with_timezone(&Utc) < since)
        {
            continue;
        }
        let rows: Vec<Map<String, Value>> = kb_docs::docs::docs_for_ticket(session, &t.id)
            .await?
            .into_iter()
            .filter(|r| r.get("page_id").and_then(Value::as_str).is_some_and(|p| readable.contains(p)))
            .collect();
        if rows.iter().any(|r| r.get("origin").and_then(Value::as_str).is_some_and(|o| DIRECT.contains(&o))) {
            continue;
        }
        let note = if rows.is_empty() { "No page links to it." } else { "Mentioned only in a comment." };
        out.push(json!({
            "ticket_id": t.id,
            "title": t.title,
            "done_at": done_at.map(|d| time::iso(&d)),
            "note": format!("{}. {note}", ago_note(done_at)),
        }));
    }
    // `sort(key=done_at or "", reverse=True)` keeps equal items in order
    out.sort_by(|a, b| {
        let key = |v: &Value| v.get("done_at").and_then(Value::as_str).unwrap_or("").to_string();
        key(b).cmp(&key(a))
    });
    Ok(out)
}

/// `_broken`: `[[links]]` that point at a missing page, a page in the bin or a missing section.
async fn broken(session: &Session, project_id: &str, pages: &[docs_page::Model]) -> Result<Vec<Value>, Error> {
    let ids: Vec<String> = pages.iter().map(|p| p.id.clone()).collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let links = docs_link::Entity::find()
        .filter(docs_link::Column::SourcePageId.is_in(ids))
        .filter(docs_link::Column::TargetTitle.is_not_null())
        .all(session)
        .await?;
    if links.is_empty() {
        return Ok(Vec::new());
    }
    let refs: Vec<Value> =
        links.iter().map(|lk| json!({"kind": "page", "title": lk.target_title, "anchor": lk.target_anchor})).collect();
    let results = kb_docs::docs::refs::resolve_refs(session, project_id, &refs, false).await?;
    let mut out = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    for (lk, res) in links.iter().zip(results.iter()) {
        let status = res.get("status").and_then(Value::as_str).unwrap_or("");
        if !matches!(status, "missing" | "in_bin" | "section_missing") {
            continue;
        }
        let anchor = lk.target_anchor.as_deref().filter(|a| !a.is_empty());
        let reference = format!(
            "[[{}{}]]",
            lk.target_title.as_deref().unwrap_or("None"),
            anchor.map_or(String::new(), |a| format!("#{a}"))
        );
        if !seen.insert((lk.source_page_id.clone(), reference.clone())) {
            continue;
        }
        let title = pages.iter().find(|p| p.id == lk.source_page_id).map(|p| p.title.clone()).unwrap_or_default();
        out.push(json!({"page_id": lk.source_page_id, "title": title, "ref": reference, "status": status}));
    }
    Ok(out)
}

/// `_words`: the words of a text outside code blocks, lower-cased.
pub fn words(text: &str) -> Vec<String> {
    static FENCED: LazyLock<Regex> = LazyLock::new(|| match Regex::new(r"(?s)```.*?```") {
        Ok(re) => re,
        Err(err) => unreachable!("the pattern is a constant: {err}"),
    });
    static WORD: LazyLock<Regex> = LazyLock::new(|| match Regex::new(r"\w+") {
        Ok(re) => re,
        Err(err) => unreachable!("the pattern is a constant: {err}"),
    });
    let plain = FENCED.replace_all(text, " ").to_lowercase();
    WORD.find_iter(&plain).map(|m| m.as_str().to_string()).collect()
}

/// `_shingles`: the runs of `n` words.
pub fn shingles(words: &[String], n: usize) -> HashSet<String> {
    let count = (words.len() + 1).saturating_sub(n);
    (0..count).map(|i| words[i..i + n].join(" ")).collect()
}

/// `_overlaps`: pages whose titles are almost the same, or whose text is.
async fn overlaps(_session: &Session, pages: &[docs_page::Model]) -> Result<Vec<Value>, Error> {
    let pages = &pages[..pages.len().min(MAX_PAIR_PAGES)];
    let mut by_page: std::collections::HashMap<&str, HashSet<String>> = std::collections::HashMap::new();
    for p in pages {
        // `getattr(p, "content", "") or ""`: a page row has no `content`, so the text of a page is never compared
        let w = words("");
        if w.len() >= MIN_WORDS {
            by_page.insert(p.id.as_str(), shingles(&w, 4));
        }
    }
    let mut out = Vec::new();
    for (i, a) in pages.iter().enumerate() {
        for b in &pages[i + 1..] {
            let mut why = String::new();
            if kb_fuzzy::fuzz::token_sort_ratio(&kb_docs::util::casefold(&a.title), &kb_docs::util::casefold(&b.title))
                >= TITLE_SIMILARITY
            {
                why = format!("The titles “{}” and “{}” are almost the same.", a.title, b.title);
            }
            if let (Some(sa), Some(sb)) = (by_page.get(a.id.as_str()), by_page.get(b.id.as_str())) {
                if !sa.is_empty() && !sb.is_empty() {
                    let union = sa.union(sb).count().max(1);
                    let sim = sa.intersection(sb).count() as f64 / union as f64;
                    if sim >= TEXT_SIMILARITY {
                        why = format!(
                            "{}{}% of the text is the same.",
                            if why.is_empty() { String::new() } else { format!("{why} ") },
                            (sim * 100.0).round_ties_even()
                        );
                    }
                }
            }
            if !why.is_empty() {
                out.push(json!({
                    "pages": [{"page_id": a.id, "title": a.title}, {"page_id": b.id, "title": b.title}],
                    "why": why,
                }));
            }
        }
    }
    Ok(out)
}

/// Recompute Missing docs, Broken links and Overlaps (no model), and, with `check`, run the freshness checks of pages
/// whose dependencies changed (at most `cap` model calls). Returns what `get` returns.
pub async fn run(
    session: &Session,
    project_id: &str,
    _by: &str,
    _check: bool,
    freshness_day: Option<&str>,
    _cap: i64,
) -> Result<Map<String, Value>, Error> {
    svc_settings::require_enabled(session, project_id).await?;
    let asked = json!({"checked": 0, "asked": 0, "deferred": 0, "stopped": null});
    let pages = readable_pages(session, project_id).await?;
    let readable: HashSet<String> = pages.iter().map(|p| p.id.clone()).collect();
    let row = row_of(session, project_id).await?;
    let mut data = data_map(&row.data);
    data.insert("missing".into(), Value::Array(missing(session, project_id, &readable).await?));
    data.insert("broken".into(), Value::Array(broken(session, project_id, &pages).await?));
    data.insert("overlaps".into(), Value::Array(overlaps(session, &pages).await?));
    if let Some(day) = freshness_day.filter(|d| !d.is_empty()) {
        data.insert("freshness_day".into(), json!(day));
    }
    let mut changed = row.into_active_model();
    changed.data = Set(pyjson::dumps(&data));
    changed.checked_at = Set(Some(now_iso()));
    changed.update(session).await?;
    session.commit().await?;
    let mut out = get_stored(session, project_id).await?;
    out.insert("checks".into(), asked);
    Ok(out)
}

/// `_item_id`.
fn item_id(kind: &str, item: &Value) -> String {
    let text = |key: &str| item.get(key).map(super::super::assistant::docs::text_of).unwrap_or_default();
    match kind {
        "missing" => text("ticket_id"),
        "broken" => format!("{}|{}", text("page_id"), text("ref")),
        "overlaps" => {
            let mut ids: Vec<String> = item
                .get("pages")
                .and_then(Value::as_array)
                .map(|pages| {
                    pages
                        .iter()
                        .map(|p| p.get("page_id").map(super::super::assistant::docs::text_of).unwrap_or_default())
                        .collect()
                })
                .unwrap_or_default();
            ids.sort();
            ids.join(",")
        }
        _ => text("page_id"),
    }
}

/// `_dismissed`: whether a person dismissed the item (never, until a date, or until the next run).
fn dismissed(entries: &[Map<String, Value>], kind: &str, id: &str, run_at: Option<&str>) -> bool {
    let now = Utc::now();
    for e in entries {
        if e.get("kind").and_then(Value::as_str) != Some(kind) || e.get("id").and_then(Value::as_str) != Some(id) {
            continue;
        }
        match e.get("level").and_then(Value::as_str) {
            Some("never") => return true,
            Some("30d") => {
                let until = when(e.get("until").and_then(Value::as_str));
                if until.is_some_and(|u| u.with_timezone(&Utc) > now) {
                    return true;
                }
            }
            // "this time": until the next run
            _ => {
                if e.get("run").and_then(Value::as_str) == run_at {
                    return true;
                }
            }
        }
    }
    false
}

/// `_out_of_date`: freshness checks come back with the assistant (AI v2, stage 7).
async fn out_of_date(_session: &Session, _project_id: &str, _pages: &HashSet<String>) -> Result<Vec<Value>, Error> {
    Ok(Vec::new())
}

/// The Docs health lists with dismissed items left out, and the counts.
///
/// The first call of a project runs the deterministic part once (`compute_missing`).
pub async fn get(session: &Session, project_id: &str, compute_missing: bool) -> Result<Map<String, Value>, Error> {
    if compute_missing {
        svc_settings::require_enabled(session, project_id).await?;
        let row = row_of(session, project_id).await?;
        if row.checked_at.as_deref().is_none_or(str::is_empty) {
            return run(session, project_id, "system", false, None, 50).await;
        }
    }
    get_stored(session, project_id).await
}

/// `get(..., compute_missing=False)`.
async fn get_stored(session: &Session, project_id: &str) -> Result<Map<String, Value>, Error> {
    let cfg = svc_settings::require_enabled(session, project_id).await?;
    let row = row_of(session, project_id).await?;
    let data = data_of(session, project_id).await?;
    let pages: HashSet<String> = readable_pages(session, project_id).await?.into_iter().map(|p| p.id).collect();
    let entries: Vec<Map<String, Value>> = match data.get("dismissed") {
        Some(Value::Array(items)) => items.iter().filter_map(|e| e.as_object().cloned()).collect(),
        _ => Vec::new(),
    };
    let run_at = row.checked_at.clone();
    let listed = |name: &str| -> Vec<Value> {
        match data.get(name) {
            Some(Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        }
    };
    let keep = |kind: &str, items: Vec<Value>| -> Vec<Value> {
        let mut out = Vec::new();
        for it in items {
            let page_known = |v: Option<&Value>| v.and_then(Value::as_str).is_some_and(|p| pages.contains(p));
            if kind == "broken" && !page_known(it.get("page_id")) {
                continue;
            }
            if kind == "overlaps"
                && it
                    .get("pages")
                    .and_then(Value::as_array)
                    .is_some_and(|ps| ps.iter().any(|p| !page_known(p.get("page_id"))))
            {
                continue;
            }
            if !dismissed(&entries, kind, &item_id(kind, &it), run_at.as_deref()) {
                out.push(it);
            }
        }
        out
    };
    let out_of_date: Vec<Value> = out_of_date(session, project_id, &pages)
        .await?
        .into_iter()
        .filter(|it| {
            let id = it.get("page_id").map(super::super::assistant::docs::text_of).unwrap_or_default();
            !dismissed(&entries, "out_of_date", &id, run_at.as_deref())
        })
        .collect();
    let missing_items = keep("missing", listed("missing"));
    let broken_items = keep("broken", listed("broken"));
    let overlap_items = keep("overlaps", listed("overlaps"));
    let mut counts = Map::new();
    counts.insert("out_of_date".into(), json!(out_of_date.len()));
    counts.insert("missing".into(), json!(missing_items.len()));
    counts.insert("broken".into(), json!(broken_items.len()));
    counts.insert("overlaps".into(), json!(overlap_items.len()));
    let total = out_of_date.len() + missing_items.len() + broken_items.len() + overlap_items.len();
    counts.insert("total".into(), json!(total));
    let mut out = Map::new();
    out.insert("checked_at".into(), json!(row.checked_at));
    out.insert("digest".into(), json!({"on": cfg.digest_on, "schedule": "Monday 09:00", "last_sent": row.digest_at}));
    out.insert("out_of_date".into(), Value::Array(out_of_date));
    out.insert("missing".into(), Value::Array(missing_items));
    out.insert("broken".into(), Value::Array(broken_items));
    out.insert("overlaps".into(), Value::Array(overlap_items));
    out.insert("counts".into(), Value::Object(counts));
    Ok(out)
}

/// The number beside "Docs health" in the tree (cheap: no model, nothing recomputed after the first run).
pub async fn count(session: &Session, project_id: &str) -> Result<i64, Error> {
    let out = get(session, project_id, true).await?;
    Ok(out.get("counts").and_then(|c| c.get("total")).and_then(Value::as_i64).unwrap_or(0))
}

/// Dismiss one item of a list: this time (until the next run), 30 days, or never.
pub async fn dismiss(
    session: &Session,
    project_id: &str,
    kind: &str,
    item_id: &str,
    level: &str,
    by: &str,
) -> Result<Map<String, Value>, Error> {
    if !KINDS.contains(&kind) {
        return Err(DocsAiError::new("invalid", "Unknown kind of finding.").into());
    }
    if !matches!(level, "once" | "month" | "never") {
        return Err(DocsAiError::new("invalid", "Dismiss this time, for 30 days or never.").into());
    }
    svc_settings::require_enabled(session, project_id).await?;
    let row = row_of(session, project_id).await?;
    let mut data = data_map(&row.data);
    let mut entries: Vec<Value> = match data.get("dismissed") {
        Some(Value::Array(items)) => items
            .iter()
            .filter(|e| {
                e.is_object()
                    && !(e.get("kind").and_then(Value::as_str) == Some(kind)
                        && e.get("id").and_then(Value::as_str) == Some(item_id))
            })
            .cloned()
            .collect(),
        _ => Vec::new(),
    };
    // `level == "30d"` is never true of a validated level: the stored `until` is None
    let until = if level == "30d" { json!(time::iso(&(Utc::now() + Duration::days(30)))) } else { Value::Null };
    entries.push(json!({"kind": kind, "id": item_id, "level": level, "until": until, "run": row.checked_at, "by": by}));
    data.insert("dismissed".into(), Value::Array(entries));
    let mut changed = row.into_active_model();
    changed.data = Set(pyjson::dumps(&data));
    changed.update(session).await?;
    session.commit().await?;
    get_stored(session, project_id).await
}
