//! `services/idea_similarity.py`: duplicate and related-work search for ideas: a plain local similarity search, no
//! model, works offline.
//!
//! Texts are cut into lowercase words, common words are dropped, and each candidate is scored against the query with
//! TF-IDF cosine similarity over all candidates, so words that appear everywhere count for little. The scores are
//! what Python computes bit for bit: the sums are `sum()` of Python 3.12 (Neumaier's compensated sum) and the words
//! are cut with Python's `\w`.

use std::collections::{HashMap, HashSet};

use kb_db::Session;
use kb_db::entities::{docs_page, docs_version, idea_ticket, ticket};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Select};
use kb_doctext::pystr::is_word;
use serde_json::{Map, Value, json};

use crate::error::Error;
use crate::model::load_many;

/// The words that carry no meaning (`_STOP`).
const STOP: &str = "the and for are but not you all can her was one our out has have had this that with from they will \
would there their what about which when your how why who its into than then them been were being \
should could may might must also just like more most some such only over very";

/// Lowest score worth showing (`MIN_SCORE`).
pub const MIN_SCORE: f64 = 0.2;

/// The words of a text that carry meaning: lowercase, at least 3 letters, no common words.
pub fn words(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let mut out = Vec::new();
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut Vec<String>| {
        // `[^\W_]{3,}`: a run of letters and digits of at least three characters
        if run.chars().count() >= 3 && !STOP.split_whitespace().any(|stop| stop == run.as_str()) {
            out.push(std::mem::take(run));
        } else {
            run.clear();
        }
    };
    for c in lower.chars() {
        if is_word(c) && c != '_' {
            run.push(c);
        } else {
            flush(&mut run, &mut out);
        }
    }
    flush(&mut run, &mut out);
    out
}

/// `sum(values)` of floats in Python 3.12: Neumaier's improved Kahan-Babuska summation.
fn py_sum(values: impl IntoIterator<Item = f64>) -> f64 {
    let mut total = 0.0_f64;
    let mut compensation = 0.0_f64;
    for x in values {
        let t = total + x;
        if total.abs() >= x.abs() {
            compensation += (total - t) + x;
        } else {
            compensation += (x - t) + total;
        }
        total = t;
    }
    if compensation != 0.0 && compensation.is_finite() {
        total += compensation;
    }
    total
}

/// A term vector: the words in the order they first appear (a Python dict's order), with their weights.
struct Vector {
    order: Vec<String>,
    weights: HashMap<String, f64>,
}

/// `_vector(tokens, idf)`.
fn vector(tokens: &[String], idf: &HashMap<String, f64>) -> Vector {
    let mut order: Vec<String> = Vec::new();
    let mut counts: HashMap<&str, u64> = HashMap::new();
    for token in tokens {
        let n = counts.entry(token.as_str()).or_insert(0);
        if *n == 0 {
            order.push(token.clone());
        }
        *n += 1;
    }
    let weights = order
        .iter()
        .map(|w| {
            let c = counts[w.as_str()];
            (w.clone(), (1.0 + (c as f64).ln()) * idf.get(w).copied().unwrap_or(1.0))
        })
        .collect();
    Vector { order, weights }
}

/// `_cosine(a, b)`.
fn cosine(a: &Vector, b: &Vector) -> f64 {
    if a.order.is_empty() || b.order.is_empty() {
        return 0.0;
    }
    let dot = py_sum(a.order.iter().map(|w| a.weights[w] * b.weights.get(w).copied().unwrap_or(0.0)));
    let na = py_sum(a.order.iter().map(|w| a.weights[w] * a.weights[w])).sqrt();
    let nb = py_sum(b.order.iter().map(|w| b.weights[w] * b.weights[w])).sqrt();
    if na != 0.0 && nb != 0.0 { dot / (na * nb) } else { 0.0 }
}

/// `round(value, 2)`: the float nearest to the value rounded half to even on its exact decimal expansion.
pub fn round2(value: f64) -> f64 {
    format!("{value:.2}").parse().unwrap_or(value)
}

/// A candidate of `rank`: the text to score, and what the result carries besides its score.
#[derive(Debug, Clone)]
pub struct Candidate {
    /// The text that is scored (`candidate["text"]`).
    pub text: String,
    /// The other keys of the candidate dict, in order.
    pub fields: Map<String, Value>,
}

/// The cosine score of every candidate against the query, unrounded and unfiltered, in the order of `candidates`.
pub fn scores(query: &str, candidates: &[Candidate]) -> Vec<f64> {
    let q_tokens = words(query);
    let docs: Vec<Vec<String>> = candidates.iter().map(|c| words(&c.text)).collect();
    let n = docs.len() + 1;
    let mut df: HashMap<&str, u64> = HashMap::new();
    for tokens in std::iter::once(&q_tokens).chain(docs.iter()) {
        let unique: HashSet<&str> = tokens.iter().map(String::as_str).collect();
        for w in unique {
            *df.entry(w).or_insert(0) += 1;
        }
    }
    let idf: HashMap<String, f64> =
        df.iter().map(|(w, c)| ((*w).to_string(), (1.0 + n as f64 / *c as f64).ln())).collect();
    let qv = vector(&q_tokens, &idf);
    docs.iter().map(|tokens| cosine(&qv, &vector(tokens, &idf))).collect()
}

/// Score `candidates` against `query`; best first, without those below `min_score`.
///
/// Each result is the candidate's fields plus `score` (0 to 1, rounded to 2 places).
pub fn rank(query: &str, candidates: &[Candidate], min_score: f64) -> Vec<Map<String, Value>> {
    let mut out: Vec<(f64, Map<String, Value>)> = Vec::new();
    for (cand, score) in candidates.iter().zip(scores(query, candidates)) {
        if score >= min_score {
            let mut item = cand.fields.clone();
            let rounded = round2(score);
            item.insert("score".into(), json!(rounded));
            out.push((rounded, item));
        }
    }
    // `sorted(out, key=lambda i: -i["score"])`: stable, best first
    out.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    out.into_iter().map(|(_, item)| item).collect()
}

/// `select(Ticket)`, in the order SQLite gives a scan (the other engines, creation order).
fn select_tickets(session: &Session) -> Select<ticket::Entity> {
    let stmt = ticket::Entity::find();
    if session.dialect() == "sqlite" {
        stmt
    } else {
        stmt.order_by_asc(ticket::Column::CreatedAt).order_by_asc(ticket::Column::Id)
    }
}

/// Ideas, tickets and Docs that look like `text`.
///
/// `exclude_idea_id`: an idea to leave out (the one being looked at). `project_id`: look at this project's tickets
/// and Docs (ideas are searched in every project). `kinds`: which of "idea", "ticket" and "doc" to search. `limit`:
/// how many results to return. `min_score`: lowest score (0 to 1) worth showing. Returns `[{kind, id, title, score,
/// stage? (ideas), status? (tickets), project_id}]` best first.
pub async fn find_similar(
    session: &Session,
    text: &str,
    exclude_idea_id: Option<&str>,
    project_id: Option<&str>,
    kinds: &[&str],
    limit: usize,
    min_score: f64,
) -> Result<Vec<Map<String, Value>>, Error> {
    if words(text).is_empty() {
        return Ok(Vec::new());
    }
    let project_id = project_id.filter(|p| !p.is_empty());
    let mut candidates: Vec<Candidate> = Vec::new();
    if kinds.contains(&"idea") {
        let rows = crate::idea_tickets::select_ideas(session).all(session).await?;
        for idea in load_many(session, rows).await? {
            if Some(idea.row.id.as_str()) == exclude_idea_id
                || idea.row.merged_into_id.as_deref().is_some_and(|m| !m.is_empty())
            {
                continue;
            }
            let page = if idea.row.body.is_empty() { &idea.row.description } else { &idea.row.body };
            let assumptions: Vec<&str> = idea.assumptions().map(|a| a.text.as_str()).collect();
            let mut fields = Map::new();
            fields.insert("kind".into(), json!("idea"));
            fields.insert("id".into(), json!(idea.row.id));
            fields.insert("title".into(), json!(idea.row.title));
            fields.insert("stage".into(), json!(idea.row.stage));
            fields.insert("project_id".into(), json!(idea.row.project_id));
            fields.insert("votes".into(), json!(idea.vote_records.len()));
            candidates.push(Candidate {
                text: format!("{} {} {} {}", idea.row.title, idea.row.title, page, assumptions.join(" ")),
                fields,
            });
        }
    }
    if kinds.contains(&"ticket") {
        let mut stmt = select_tickets(session);
        if let Some(project_id) = project_id {
            stmt = stmt.filter(ticket::Column::ProjectId.eq(project_id));
        }
        for t in stmt.all(session).await? {
            let mut fields = Map::new();
            fields.insert("kind".into(), json!("ticket"));
            fields.insert("id".into(), json!(t.id));
            fields.insert("title".into(), json!(t.title));
            fields.insert("status".into(), json!(t.status));
            fields.insert("project_id".into(), json!(t.project_id));
            candidates.push(Candidate { text: format!("{} {} {}", t.title, t.title, t.description), fields });
        }
    }
    if kinds.contains(&"doc") {
        let mut pstmt = docs_page::Entity::find().filter(docs_page::Column::DeletedAt.is_null());
        if session.dialect() != "sqlite" {
            pstmt = pstmt.order_by_asc(docs_page::Column::CreatedAt).order_by_asc(docs_page::Column::Id);
        }
        if let Some(project_id) = project_id {
            pstmt = pstmt.filter(docs_page::Column::ProjectId.eq(project_id));
        }
        for page in pstmt.all(session).await? {
            let version = docs_version::Entity::find()
                .filter(docs_version::Column::PageId.eq(page.id.as_str()))
                .filter(docs_version::Column::Version.eq(page.version))
                .one(session)
                .await?;
            let mut fields = Map::new();
            fields.insert("kind".into(), json!("doc"));
            fields.insert("id".into(), json!(page.id));
            fields.insert("title".into(), json!(page.title));
            fields.insert("project_id".into(), json!(page.project_id));
            let markdown = version.map(|v| v.markdown).unwrap_or_default();
            candidates.push(Candidate { text: format!("{} {} {}", page.title, page.title, markdown), fields });
        }
    }
    let mut ranked = rank(text, &candidates, min_score);
    ranked.truncate(limit);
    Ok(ranked)
}

/// Tags worth suggesting: the ones most used by the ideas and tickets that look like `text`.
pub async fn suggest_tags(session: &Session, text: &str, exclude_idea_id: Option<&str>) -> Result<Vec<String>, Error> {
    let similar = find_similar(session, text, exclude_idea_id, None, &["idea", "ticket"], 8, 0.15).await?;
    // a Counter keeps the order tags were first counted in
    let mut counts: Vec<(String, u64)> = Vec::new();
    for item in similar {
        let id = item.get("id").and_then(Value::as_str).unwrap_or("");
        let raw = if item.get("kind").and_then(Value::as_str) == Some("idea") {
            idea_ticket::Entity::find_by_id(id).one(session).await?.map(|row| row.tags)
        } else {
            ticket::Entity::find_by_id(id).one(session).await?.map(|row| row.tags)
        };
        // `json.loads(row.tags) if row and row.tags else []`, `[]` for JSON that does not parse; a value that is not
        // iterable (`null`) is a `TypeError`
        let tags: Vec<Value> = match raw.as_deref().filter(|t| !t.is_empty()) {
            None => Vec::new(),
            Some(text) if serde_json::from_str::<Value>(text).is_err() => Vec::new(),
            Some(text) => crate::idea_tickets::iterate_json(text)?,
        };
        for tag in tags {
            let tag = kb_base::pyjson::py_str(&tag);
            if tag == "idea-test" {
                continue;
            }
            match counts.iter_mut().find(|(name, _)| *name == tag) {
                Some((_, n)) => *n += 1,
                None => counts.push((tag, 1)),
            }
        }
    }
    counts.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    Ok(counts.into_iter().take(5).map(|(tag, _)| tag).collect())
}
