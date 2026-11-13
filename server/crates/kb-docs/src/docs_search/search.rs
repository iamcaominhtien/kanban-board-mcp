//! The search itself and "similar pages" (`services/docs_search.py` lines 404-853).

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use chrono::{Duration, Utc};
use kb_base::time;
use kb_db::Session;
use kb_db::entities::{docs_link, docs_page, member, project, ticket};
use kb_db::sea_orm::sea_query::{Alias, Expr, ExprTrait, Order, Query as SqlQuery};
use kb_db::sea_orm::{ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, Value};
use kb_db::sql::statement;
use kb_doctext::docs_text::heading_anchors;
use kb_doctext::pystr::{self, is_word};
use kb_fuzzy::{fuzz, process};
use serde_json::{Map, Value as Json, json};

use super::index::{contents, ensure_fts};
use super::query::{Query, build_matches, contains, count_matches, highlight, passes, plain_line, window};
use crate::util::casefold;
use crate::{Result, docs_err};

/// The filters, paging and sorting of a search (the query parameters of the route).
#[derive(Debug, Clone)]
pub struct SearchParams {
    /// "space" (pages), "tickets" or "all".
    pub scope: String,
    /// Page size.
    pub limit: i64,
    /// Results to skip.
    pub offset: i64,
    /// Search inside this page only (find-in-page).
    pub page_id: Option<String>,
    /// "headings" to match headings only.
    pub mode: Option<String>,
    /// Only pages last edited by this author.
    pub author: Option<String>,
    /// Only pages edited after this ISO time (or `7d`).
    pub edited_since: Option<String>,
    /// Only this page's sub-tree.
    pub under_page: Option<String>,
    /// Only pages that do (or do not) reference tickets.
    pub has_tickets: Option<bool>,
    /// Only tickets in this status (applied to pages, as the Python code does).
    pub status: Option<String>,
    /// "relevance" or "edited_at".
    pub sort: String,
}

impl Default for SearchParams {
    fn default() -> Self {
        Self {
            scope: "space".into(),
            limit: 20,
            offset: 0,
            page_id: None,
            mode: None,
            author: None,
            edited_since: None,
            under_page: None,
            has_tickets: None,
            status: None,
            sort: "relevance".into(),
        }
    }
}

/// `_parse_since`: `7d` is seven days ago, anything else must be an ISO date or time.
fn parse_since(value: &str) -> Result<String> {
    let value = kb_base::pytext::strip(value);
    let days = value.strip_suffix('d').filter(|d| (1..=4).contains(&d.len()) && d.bytes().all(|b| b.is_ascii_digit()));
    if let Some(days) = days {
        let days: i64 = days.parse().unwrap_or(0);
        return Ok(time::iso(&(Utc::now() - Duration::days(days))));
    }
    if time::parse_iso(value).is_none() {
        return docs_err(422, "bad_filter", "edited_since must be a date (2026-01-31) or like '7d'");
    }
    Ok(value.to_string())
}

/// A dict of page id to score that keeps the order its keys were first set in.
#[derive(Default)]
struct Scores {
    order: Vec<String>,
    values: HashMap<String, f64>,
}

impl Scores {
    fn set(&mut self, id: String, score: f64) {
        if self.values.insert(id.clone(), score).is_none() {
            self.order.push(id);
        }
    }
}

/// The MATCH itself: page id and score (higher is better) in the order SQLite gives them, or None when the MATCH
/// fails (a syntax error of FTS5).
pub async fn fts_ranks(session: &Session, expr: &str, project_ids: &[String]) -> Result<Option<Vec<(String, f64)>>> {
    let marks = vec!["?"; project_ids.len()].join(", ");
    let sql = format!(
        "SELECT docs_fts.page_id, bm25(docs_fts, 0.0, 0.0, 10.0, 5.0, 1.0) \
         FROM docs_fts JOIN docs_page p ON p.id = docs_fts.page_id \
         WHERE docs_fts MATCH ? AND p.deleted_at IS NULL AND p.project_id IN ({marks})"
    );
    let mut values: Vec<Value> = vec![expr.into()];
    values.extend(project_ids.iter().map(|p| Value::from(p.as_str())));
    let Ok(rows) = session.query_all_raw(statement(session.get_database_backend(), &sql, values)).await else {
        return Ok(None);
    };
    let mut out = Vec::new();
    for row in rows {
        let pid: String = row.try_get_by_index(0)?;
        let rank: f64 = row.try_get_by_index(1)?;
        out.push((pid, -rank));
    }
    Ok(Some(out))
}

/// page_id -> score from FTS5, or None when FTS5 is unavailable or the MATCH failed.
async fn fts_candidates(
    session: &Session,
    query: &Query,
    project_ids: &[String],
    headings_only: bool,
) -> Result<Option<Scores>> {
    if !ensure_fts(session).await? {
        return Ok(None);
    }
    let mut expr = query.fts();
    if headings_only {
        expr = format!("headings : ({expr})");
    }
    let Some(rows) = fts_ranks(session, &expr, project_ids).await? else { return Ok(None) };
    let mut scores = Scores::default();
    for (pid, score) in rows {
        scores.set(pid, score);
    }
    Ok(Some(scores))
}

/// The same query evaluated over the pages in Rust.
fn fallback_candidates(
    query: &Query,
    pages: &[docs_page::Model],
    contents: &HashMap<String, String>,
    headings_only: bool,
) -> Scores {
    let mut out = Scores::default();
    for p in pages {
        let md = contents.get(&p.id).map(String::as_str).unwrap_or("");
        let heads = heading_anchors(md).into_iter().map(|h| h.text).collect::<Vec<_>>().join("\n");
        if headings_only {
            if !passes(query, &[&heads]) {
                continue;
            }
            out.set(p.id.clone(), 5.0);
            continue;
        }
        if !passes(query, &[&p.title, &heads, md]) {
            continue;
        }
        let mut score = 0.0;
        let folded = casefold(md);
        for t in query.positive() {
            score +=
                10.0 * f64::from(u8::from(contains(&p.title, &t))) + 5.0 * f64::from(u8::from(contains(&heads, &t)));
            let n = folded.matches(&casefold(&t)).count().min(10);
            score += n as f64 * 0.1;
        }
        out.set(p.id.clone(), score);
    }
    out
}

/// `_path_titles`: the titles of a page's ancestors, root first.
pub fn path_titles(page: &docs_page::Model, by_id: &HashMap<String, docs_page::Model>) -> Vec<String> {
    let mut titles = Vec::new();
    let mut cur = page;
    let mut seen: HashSet<&str> = HashSet::from([page.id.as_str()]);
    while let Some(parent_id) = cur.parent_id.as_deref().filter(|p| !p.is_empty()) {
        let Some(parent) = by_id.get(parent_id) else { break };
        if seen.contains(parent_id) {
            break;
        }
        cur = parent;
        seen.insert(cur.id.as_str());
        titles.insert(0, cur.title.clone());
    }
    titles
}

/// `_root_of`: the top-level ancestor of a page (itself when it has none).
fn root_of<'a>(page: &'a docs_page::Model, by_id: &'a HashMap<String, docs_page::Model>) -> &'a docs_page::Model {
    let mut cur = page;
    let mut seen: HashSet<&str> = HashSet::from([page.id.as_str()]);
    while let Some(parent_id) = cur.parent_id.as_deref().filter(|p| !p.is_empty()) {
        let Some(parent) = by_id.get(parent_id) else { break };
        if seen.contains(parent_id) {
            break;
        }
        cur = parent;
        seen.insert(cur.id.as_str());
    }
    cur
}

/// `_is_under`: the page is the ancestor itself or sits under it.
fn is_under(page: &docs_page::Model, ancestor_id: &str, by_id: &HashMap<String, docs_page::Model>) -> bool {
    let mut cur = Some(page);
    let mut seen: HashSet<&str> = HashSet::new();
    while let Some(p) = cur {
        if seen.contains(p.id.as_str()) {
            break;
        }
        if p.id == ancestor_id {
            return true;
        }
        seen.insert(p.id.as_str());
        cur = p.parent_id.as_deref().filter(|x| !x.is_empty()).and_then(|x| by_id.get(x));
    }
    false
}

async fn search_tickets(
    session: &Session,
    query: &Query,
    project_ids: Option<&[String]>,
) -> Result<Vec<Map<String, Json>>> {
    let mut stmt = ticket::Entity::find();
    if let Some(ids) = project_ids {
        stmt = stmt.filter(ticket::Column::ProjectId.is_in(ids.to_vec()));
    }
    let positive = query.positive();
    let mut scored: Vec<(f64, ticket::Model)> = Vec::new();
    for t in stmt.all(session).await? {
        let desc = t.description.clone();
        if !passes(query, &[&t.id, &t.title, &desc]) {
            continue;
        }
        let score: f64 = positive
            .iter()
            .map(|w| {
                10.0 * f64::from(u8::from(contains(&t.title, w) || contains(&t.id, w)))
                    + f64::from(u8::from(contains(&desc, w)))
            })
            .sum();
        scored.push((score, t));
    }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.1.id.cmp(&b.1.id)));
    let ids: HashSet<String> =
        scored.iter().filter_map(|(_, t)| t.assignee.clone().filter(|a| !a.is_empty())).collect();
    let mut names: HashMap<String, String> = HashMap::new();
    if !ids.is_empty() {
        let rows = member::Entity::find()
            .filter(member::Column::Id.is_in(ids.into_iter().collect::<Vec<_>>()))
            .all(session)
            .await?;
        names = rows.into_iter().map(|m| (m.id, m.name)).collect();
    }
    let mut out = Vec::new();
    for (_score, t) in scored {
        let desc_plain = plain_line(&kb_base::pytext::split(&t.description).join(" "));
        let hit_in_desc = positive.iter().any(|w| contains(&desc_plain, w));
        let source = if hit_in_desc { desc_plain } else { t.title.clone() };
        let mut m = Map::new();
        m.insert("ticket_id".into(), json!(t.id));
        m.insert("title".into(), json!(t.title));
        m.insert("status".into(), json!(t.status));
        m.insert(
            "assignee".into(),
            t.assignee
                .as_ref()
                .filter(|a| !a.is_empty())
                .and_then(|a| names.get(a))
                .map(|n| json!(n))
                .unwrap_or(Json::Null),
        );
        m.insert("snippet".into(), json!(highlight(&window(&source, &positive, 150), &positive)));
        out.push(m);
    }
    Ok(out)
}

/// The tickets each page references or is linked to, as `{ticket_id, status}` chips.
async fn tickets_of_pages(
    session: &Session,
    page_ids: &[String],
    per_page: usize,
) -> Result<HashMap<String, Vec<Json>>> {
    let mut out: HashMap<String, Vec<Json>> = HashMap::new();
    if page_ids.is_empty() {
        return Ok(out);
    }
    let select = SqlQuery::select()
        .column((Alias::new("docs_link"), Alias::new("source_page_id")))
        .column((Alias::new("docs_link"), Alias::new("target_ticket_id")))
        .column((Alias::new("ticket"), Alias::new("status")))
        .from(Alias::new("docs_link"))
        .inner_join(
            Alias::new("ticket"),
            Expr::col((Alias::new("ticket"), Alias::new("id")))
                .equals((Alias::new("docs_link"), Alias::new("target_ticket_id"))),
        )
        .and_where(Expr::col((Alias::new("docs_link"), Alias::new("source_page_id"))).is_in(page_ids.to_vec()))
        .order_by((Alias::new("docs_link"), Alias::new("target_ticket_id")), Order::Asc)
        .to_owned();
    for row in session.query_all(&select).await? {
        let page_id: String = row.try_get_by_index(0)?;
        let ticket_id: String = row.try_get_by_index(1)?;
        let status: String = row.try_get_by_index(2)?;
        let chips = out.entry(page_id).or_default();
        if chips.len() < per_page && chips.iter().all(|c| c["ticket_id"] != json!(ticket_id)) {
            chips.push(json!({"ticket_id": ticket_id, "status": status}));
        }
    }
    Ok(out)
}

/// Maximal runs of 3 or more word characters (`re.findall(r"\w{3,}", text)`).
fn word_runs(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for c in text.chars().chain(std::iter::once(' ')) {
        if is_word(c) {
            cur.push(c);
        } else {
            if cur.chars().count() >= 3 {
                out.push(std::mem::take(&mut cur));
            }
            cur.clear();
        }
    }
    out
}

/// A corrected query when a word is a near miss of a word in a page title. The Python code hands a `set` to
/// `extractOne`, so a tie is broken by hash order there; here the vocabulary is walked in sorted order.
fn suggest(query: &Query, pages: &[docs_page::Model]) -> Option<String> {
    let mut vocab: Vec<String> = pages.iter().flat_map(|p| word_runs(&casefold(&p.title))).collect();
    vocab.sort();
    vocab.dedup();
    if vocab.is_empty() || query.words.is_empty() {
        return None;
    }
    let mut changed = false;
    let mut fixed: Vec<String> = Vec::new();
    for w in &query.words {
        let folded = casefold(w);
        if vocab.binary_search(&folded).is_ok() {
            fixed.push(w.clone());
            continue;
        }
        match process::extract_one(&folded, &vocab, fuzz::ratio, Some(70.0)) {
            Some((best, _, _)) => {
                fixed.push(best.to_string());
                changed = true;
            }
            None => fixed.push(w.clone()),
        }
    }
    if !changed {
        return None;
    }
    fixed.extend(query.phrases.iter().map(|p| format!("\"{p}\"")));
    Some(fixed.join(" "))
}

fn empty_result() -> Map<String, Json> {
    let mut m = Map::new();
    m.insert("total".into(), json!(0));
    m.insert("match_count".into(), json!(0));
    m.insert("took_ms".into(), json!(0));
    m.insert("pages".into(), json!([]));
    m.insert("tickets".into(), json!([]));
    m.insert("suggestion".into(), Json::Null);
    m.insert(
        "facets".into(),
        json!({"authors": [], "under": [], "status": [], "edited": {"any": 0, "day": 0, "week": 0, "month": 0}, "has_tickets": 0}),
    );
    m
}

/// Search pages and/or tickets by scope, with filters, sorting and paging: pages, tickets, totals and timing.
///
/// `q` supports `"phrases"` and `-excluded` terms. Fails with a 422 `DocsError` for an invalid `scope`, `sort` or
/// `mode`.
pub async fn search(session: &Session, project_id: &str, q: &str, params: &SearchParams) -> Result<Map<String, Json>> {
    let started = Instant::now();
    if !["space", "all", "tickets"].contains(&params.scope.as_str()) {
        return docs_err(422, "bad_scope", "scope must be space, all or tickets");
    }
    if !["relevance", "edited_at"].contains(&params.sort.as_str()) {
        return docs_err(422, "bad_sort", "sort must be relevance or edited_at");
    }
    let mode = params.mode.as_deref();
    if ![None, Some(""), Some("headings"), Some("all")].contains(&mode) {
        return docs_err(422, "bad_mode", "mode must be headings or omitted");
    }
    let since = match params.edited_since.as_deref().filter(|s| !s.is_empty()) {
        Some(v) => Some(parse_since(v)?),
        None => None,
    };
    let headings_only = mode == Some("headings");
    let mut q = q.to_string();
    if headings_only {
        q = pystr::lstrip(&q).trim_start_matches('#').to_string();
    }
    let query = Query::new(&q);
    let limit = params.limit.clamp(1, 100) as usize;
    let offset = Ord::max(params.offset, 0) as usize;
    let mut empty = empty_result();
    if query.positive().is_empty() {
        return Ok(empty);
    }

    let mut project_ids = vec![project_id.to_string()];
    let mut projects: HashMap<String, project::Model> = HashMap::new();
    if params.scope == "all" {
        let rows = project::Entity::find().filter(project::Column::DocsEnabled.eq(true)).all(session).await?;
        let ids: Vec<String> = rows.iter().map(|p| p.id.clone()).collect();
        projects = rows.into_iter().map(|p| (p.id.clone(), p)).collect();
        if !ids.is_empty() {
            project_ids = ids;
        }
    }
    if let Some(own) = project::Entity::find_by_id(project_id).one(session).await? {
        projects.insert(own.id.clone(), own);
    }
    let ticket_pool: Option<Vec<String>> =
        if params.scope == "all" { None } else { Some(vec![project_id.to_string()]) };

    let pages = docs_page::Entity::find()
        .filter(docs_page::Column::ProjectId.is_in(project_ids.clone()))
        .filter(docs_page::Column::DeletedAt.is_null())
        .all(session)
        .await?;
    let by_id: HashMap<String, docs_page::Model> = pages.iter().map(|p| (p.id.clone(), p.clone())).collect();

    let ticket_hits = search_tickets(session, &query, ticket_pool.as_deref()).await?;
    if params.scope == "tickets" {
        empty.insert("total".into(), json!(ticket_hits.len()));
        empty.insert("took_ms".into(), json!(started.elapsed().as_millis() as i64));
        let window: Vec<Json> = ticket_hits.into_iter().skip(offset).take(limit).map(Json::Object).collect();
        empty.insert("tickets".into(), Json::Array(window));
        empty.insert("suggestion".into(), Json::Null);
        return Ok(empty);
    }

    let mut contents_map: HashMap<String, String> = HashMap::new();
    let scores = match fts_candidates(session, &query, &project_ids, headings_only).await? {
        Some(scores) => scores,
        None => {
            contents_map = contents(session, &pages).await?;
            fallback_candidates(&query, &pages, &contents_map, headings_only)
        }
    };
    // FTS prefix-matches words; keep only pages that really hold every phrase/word as written
    let candidates: Vec<&docs_page::Model> = scores.order.iter().filter_map(|pid| by_id.get(pid)).collect();
    let score_of = |p: &docs_page::Model| scores.values.get(&p.id).copied().unwrap_or(0.0);

    // facets are counted over everything the query matches, before the filters narrow it
    let mut authors: HashMap<&str, i64> = HashMap::new();
    let mut unders: HashMap<String, i64> = HashMap::new();
    let mut statuses: HashMap<&str, i64> = HashMap::new();
    for p in &candidates {
        *authors.entry(p.updated_by.as_str()).or_default() += 1;
        *statuses.entry(p.status.as_str()).or_default() += 1;
        *unders.entry(root_of(p, &by_id).id.clone()).or_default() += 1;
    }
    let now = Utc::now();
    let mut edited_facet = json!({"any": candidates.len(), "day": 0, "week": 0, "month": 0});
    for (key, days) in [("day", 1), ("week", 7), ("month", 30)] {
        let cutoff = time::iso(&(now - Duration::days(days)));
        edited_facet[key] = json!(candidates.iter().filter(|p| p.updated_at >= cutoff).count());
    }
    let mut ticket_linked: HashSet<String> = HashSet::new();
    if !candidates.is_empty() {
        let rows = docs_link::Entity::find()
            .filter(docs_link::Column::SourcePageId.is_in(candidates.iter().map(|p| p.id.clone()).collect::<Vec<_>>()))
            .filter(docs_link::Column::TargetTicketId.is_not_null())
            .all(session)
            .await?;
        ticket_linked = rows.into_iter().map(|l| l.source_page_id).collect();
    }

    let scope_root = params
        .under_page
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| params.page_id.clone().filter(|s| !s.is_empty()));
    let mut filtered: Vec<&docs_page::Model> = Vec::new();
    for p in &candidates {
        if params.author.as_deref().is_some_and(|a| !a.is_empty() && p.updated_by != a) {
            continue;
        }
        if since.as_ref().is_some_and(|s| p.updated_at < *s) {
            continue;
        }
        if params.status.as_deref().is_some_and(|s| !s.is_empty() && p.status != s) {
            continue;
        }
        if params.has_tickets.is_some_and(|h| ticket_linked.contains(&p.id) != h) {
            continue;
        }
        if scope_root.as_deref().is_some_and(|r| !is_under(p, r, &by_id)) {
            continue;
        }
        filtered.push(p);
    }
    if params.sort == "edited_at" {
        filtered.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    } else {
        filtered.sort_by(|a, b| {
            score_of(b)
                .partial_cmp(&score_of(a))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| casefold(&a.title).cmp(&casefold(&b.title)))
        });
    }

    let window_pages: Vec<&docs_page::Model> = filtered.iter().skip(offset).take(limit).copied().collect();
    if contents_map.is_empty() {
        let owned: Vec<docs_page::Model> = window_pages.iter().map(|p| (*p).clone()).collect();
        contents_map = contents(session, &owned).await?;
    }
    let page_tickets =
        tickets_of_pages(session, &window_pages.iter().map(|p| p.id.clone()).collect::<Vec<_>>(), 4).await?;
    // "28 matches in 9 pages": every section that holds a hit, not only the 3 shown per result
    let counted: Vec<&docs_page::Model> = filtered.iter().take(300).copied().collect();
    let extra: Vec<docs_page::Model> =
        counted.iter().filter(|p| !contents_map.contains_key(&p.id)).map(|p| (*p).clone()).collect();
    let mut all_content = contents_map.clone();
    all_content.extend(contents(session, &extra).await?);
    let positive = query.positive();
    let match_count: usize = counted
        .iter()
        .map(|p| {
            count_matches(all_content.get(&p.id).map(String::as_str).unwrap_or(""), &positive, headings_only, 1000)
                .max(1)
        })
        .sum();
    let mut out_pages: Vec<Json> = Vec::new();
    for p in &window_pages {
        let mut m = Map::new();
        m.insert("page_id".into(), json!(p.id));
        m.insert("project_id".into(), json!(p.project_id));
        m.insert("project_name".into(), json!(projects.get(&p.project_id).map(|x| x.name.as_str()).unwrap_or("")));
        m.insert("title".into(), json!(p.title));
        m.insert("title_snippet".into(), json!(highlight(&p.title, &positive)));
        m.insert("path".into(), json!(path_titles(p, &by_id)));
        m.insert("status".into(), json!(p.status));
        m.insert("version".into(), json!(p.version));
        m.insert("updated_at".into(), json!(p.updated_at));
        m.insert("updated_by".into(), json!(p.updated_by));
        m.insert("tickets".into(), Json::Array(page_tickets.get(&p.id).cloned().unwrap_or_default()));
        let matches =
            build_matches(contents_map.get(&p.id).map(String::as_str).unwrap_or(""), &positive, headings_only, 3);
        m.insert("matches".into(), Json::Array(matches.into_iter().map(Json::Object).collect()));
        out_pages.push(Json::Object(m));
    }
    let suggestion = if filtered.is_empty() && ticket_hits.is_empty() { suggest(&query, &pages) } else { None };
    let mut under_rows: Vec<(String, i64)> = unders.into_iter().collect();
    under_rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| by_id[&a.0].title.cmp(&by_id[&b.0].title)));
    let under_facet: Vec<Json> = under_rows
        .into_iter()
        .take(8)
        .map(|(rid, n)| json!({"page_id": rid, "title": by_id[&rid].title, "count": n}))
        .collect();
    let mut author_rows: Vec<(&str, i64)> = authors.into_iter().collect();
    author_rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    let mut status_rows: Vec<(&str, i64)> = statuses.into_iter().collect();
    status_rows.sort_by(|a, b| a.0.cmp(b.0));

    let mut result = Map::new();
    result.insert("total".into(), json!(filtered.len()));
    result.insert("match_count".into(), json!(match_count));
    result.insert("took_ms".into(), json!(started.elapsed().as_millis() as i64));
    result.insert("pages".into(), Json::Array(out_pages));
    result.insert("tickets".into(), Json::Array(ticket_hits.into_iter().take(5).map(Json::Object).collect()));
    result.insert("suggestion".into(), suggestion.map(Json::from).unwrap_or(Json::Null));
    result.insert(
        "facets".into(),
        json!({
            "authors": author_rows.iter().map(|(n, c)| json!({"name": n, "count": c})).collect::<Vec<_>>(),
            "under": under_facet,
            "status": status_rows.iter().map(|(n, c)| json!({"name": n, "count": c})).collect::<Vec<_>>(),
            "edited": edited_facet,
            "has_tickets": ticket_linked.len(),
        }),
    );
    Ok(result)
}

/// Suggest up to 4 pages whose slug or title resembles a slug (for the "page not found" screen): `{page_id, title,
/// path}`, best first.
pub async fn similar(session: &Session, project_id: &str, slug: &str) -> Result<Vec<Json>> {
    let last = kb_base::pytext::strip(slug).trim_matches('/').rsplit('/').next().unwrap_or("").to_string();
    let needle = last.replace(['-', '_'], " ");
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let pages = docs_page::Entity::find()
        .filter(docs_page::Column::ProjectId.eq(project_id))
        .filter(docs_page::Column::DeletedAt.is_null())
        .all(session)
        .await?;
    let by_id: HashMap<String, docs_page::Model> = pages.iter().map(|p| (p.id.clone(), p.clone())).collect();
    let folded = casefold(&needle);
    let mut scored: Vec<(f64, &docs_page::Model)> = Vec::new();
    for p in &pages {
        let s =
            fuzz::wratio(&folded, &casefold(&p.slug.replace('-', " "))).max(fuzz::wratio(&folded, &casefold(&p.title)));
        if s >= 60.0 {
            scored.push((s, p));
        }
    }
    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.1.title.cmp(&b.1.title))
    });
    Ok(scored
        .into_iter()
        .take(4)
        .map(|(_, p)| json!({"page_id": p.id, "title": p.title, "path": path_titles(p, &by_id)}))
        .collect())
}
