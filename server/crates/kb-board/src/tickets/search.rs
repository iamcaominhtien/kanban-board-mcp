//! `services/tickets.py`, lines 28-36 and 215-242: the fuzzy search of the ticket list (`q`), scored in process
//! with rapidfuzz's `partial_ratio`.

use kb_base::pyjson;
use kb_base::pytext;
use kb_db::entities::ticket;
use kb_fuzzy::fuzz;

use super::{Error, loads};

// Fuzzy search: per-field ranking weight, and the min unweighted score a
// field needs to count as a match at all.
pub(crate) const SEARCH_WEIGHT_ID: f64 = 2.0;
pub(crate) const SEARCH_WEIGHT_TITLE: f64 = 1.5;
pub(crate) const SEARCH_WEIGHT_DESCRIPTION: f64 = 1.0;
pub(crate) const SEARCH_WEIGHT_TAG: f64 = 1.0;
pub(crate) const SEARCH_MATCH_THRESHOLD: f64 = 70.0;

/// Weighted fuzzy-match score of `query` against id/title/description/tags,
/// or 0 if nothing matches closely enough.
pub(crate) fn fuzzy_score(ticket: &ticket::Model, query: &str) -> Result<f64, Error> {
    let query = pytext::strip(query).to_lowercase();
    if query.is_empty() {
        return Ok(100.0);
    }

    let mut best = 0.0_f64;
    for (value, weight) in [
        (&ticket.id, SEARCH_WEIGHT_ID),
        (&ticket.title, SEARCH_WEIGHT_TITLE),
        (&ticket.description, SEARCH_WEIGHT_DESCRIPTION),
    ] {
        if value.is_empty() {
            continue;
        }
        let raw = fuzz::partial_ratio(&query, &value.to_lowercase());
        if raw >= SEARCH_MATCH_THRESHOLD {
            best = best.max(raw * weight);
        }
    }

    for tag in loads(&ticket.tags)? {
        if !pyjson::truthy(&tag) {
            continue;
        }
        let raw = fuzz::partial_ratio(&query, &pyjson::py_str(&tag).to_lowercase());
        if raw >= SEARCH_MATCH_THRESHOLD {
            best = best.max(raw * SEARCH_WEIGHT_TAG);
        }
    }

    Ok(best)
}

/// The `q` filter of `list_tickets`: the tickets that match, best first; tickets of the same score keep the order
/// they came in (Python's sort is stable, also with `reverse=True`).
pub(crate) fn rank(tickets: Vec<ticket::Model>, q: &str) -> Result<Vec<ticket::Model>, Error> {
    let mut scored: Vec<(ticket::Model, f64)> = Vec::with_capacity(tickets.len());
    for ticket in tickets {
        let score = fuzzy_score(&ticket, q)?;
        if score > 0.0 {
            scored.push((ticket, score));
        }
    }
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    Ok(scored.into_iter().map(|(ticket, _)| ticket).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tickets::blank_ticket;
    use serde_json::Value;

    /// `contract/golden/ticket_search.json`: the Python scores of 240 tickets for a few hundred queries (typos,
    /// partial words, tags, Vietnamese, ids), and the order `list_tickets` returns the matches in.
    #[test]
    fn scores_and_order_are_those_of_the_python_search() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../contract/golden/ticket_search.json");
        let text = std::fs::read_to_string(path).expect("golden file ticket_search.json exists");
        let golden: Value = serde_json::from_str(&text).expect("golden file parses");
        let tickets: Vec<ticket::Model> = golden["tickets"]
            .as_array()
            .expect("tickets")
            .iter()
            .map(|t| {
                let text = |key: &str| t[key].as_str().expect(key).to_string();
                let mut row = blank_ticket(&text("id"));
                (row.title, row.description, row.tags) = (text("title"), text("description"), text("tags"));
                row
            })
            .collect();
        let cases = golden["cases"].as_array().expect("cases");
        assert!(tickets.len() >= 200 && cases.len() >= 200, "{} tickets, {} queries", tickets.len(), cases.len());
        let mut matches = 0;
        for case in cases {
            let q = case["q"].as_str().expect("q");
            let scores: Vec<f64> = tickets.iter().map(|t| fuzzy_score(t, q).expect("score")).collect();
            // written as `repr(score)`: `serde_json` does not read every float to the last bit, `str::parse` does
            let expected: Vec<f64> = case["scores"]
                .as_array()
                .expect("scores")
                .iter()
                .map(|s| s.as_str().expect("score").parse().expect("a float"))
                .collect();
            // the same bits: a score a hair off would change the order of two tickets somewhere
            for ((ticket, got), want) in tickets.iter().zip(&scores).zip(&expected) {
                assert_eq!(got.to_bits(), want.to_bits(), "{q:?} against {}: {got} != {want}", ticket.id);
            }
            matches += scores.iter().filter(|s| **s > 0.0).count();
            if !pytext::strip(q).is_empty() {
                let order: Vec<String> = rank(tickets.clone(), q).expect("ranked").into_iter().map(|t| t.id).collect();
                let expected: Vec<&str> =
                    case["order"].as_array().expect("order").iter().map(|id| id.as_str().expect("id")).collect();
                assert_eq!(order, expected, "{q:?}");
            }
        }
        assert!(matches > 1000, "{matches} matches");
    }
}
