//! Execution waves of a parent's sub-tickets (design/components/ticket-detail-parent.md, 1 and 7; comp-2 TDP-1):
//! `services/ticket_waves.py`.
//!
//! A sub-ticket's wave is computed from its Blocked by links to its siblings: one with no sibling blocker is wave 1,
//! any other one wave after its latest sibling blocker. A person may pin a sub-ticket to a wave by hand
//! (`Ticket.wave_pin`, "Auto-set from Blocked by" unchecked); a pinned wave is used as it is, and the siblings it
//! blocks count from it. With no pin anywhere the waves are the computed ones, as before the pin existed. The UI
//! computes the same thing (`ui/src/components/SubTicketsSection.tsx`, `buildRows`).

use std::collections::{HashMap, HashSet};

use kb_base::pyjson;
use kb_db::entities::ticket;
use serde_json::Value;

pub const WAVE_PIN_RANGE: (i64, i64) = (1, 99);

fn blockers(ticket: &ticket::Model) -> Vec<String> {
    let text = if ticket.blocked_by.is_empty() { "[]" } else { ticket.blocked_by.as_str() };
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Array(raw)) => raw.iter().map(pyjson::py_str).collect(),
        _ => Vec::new(),
    }
}

/// The wave of each sub-ticket, by id (in the order they are first settled): its pin when one is set, else 1 + the
/// latest wave of its sibling blockers. Circular blockers stop the descent (that ticket counts as wave 1 on the
/// loop), as the UI does.
pub fn waves(children: &[ticket::Model]) -> Vec<(String, i64)> {
    // `{t.id: t for t in kids}`: of two rows with one id, the later one
    let by_id: HashMap<&str, &ticket::Model> = children.iter().map(|t| (t.id.as_str(), t)).collect();
    let mut out: Vec<(String, i64)> = Vec::new();

    fn wave_of(
        t: &ticket::Model,
        trail: &mut HashSet<String>,
        by_id: &HashMap<&str, &ticket::Model>,
        out: &mut Vec<(String, i64)>,
    ) -> i64 {
        if let Some((_, known)) = out.iter().find(|(id, _)| *id == t.id) {
            return *known;
        }
        if let Some(pin) = t.wave_pin {
            out.push((t.id.clone(), i64::from(pin)));
            return i64::from(pin);
        }
        if trail.contains(&t.id) {
            return 1;
        }
        trail.insert(t.id.clone());
        let mut w = 1;
        for b in blockers(t) {
            if let Some(other) = by_id.get(b.as_str()) {
                w = w.max(wave_of(other, trail, by_id, out) + 1);
            }
        }
        trail.remove(&t.id);
        out.push((t.id.clone(), w));
        w
    }

    for t in children {
        wave_of(t, &mut HashSet::new(), &by_id, &mut out);
    }
    out
}

/// Whether a sub-ticket pinned to a wave may start: every open sibling of an earlier wave is closed. Its own
/// Blocked by links do not hold it back then (that is what pinning it earlier is for).
pub fn pinned_ready(ticket: &ticket::Model, siblings: &[ticket::Model], closed: &HashSet<String>) -> bool {
    let w: HashMap<String, i64> = waves(siblings).into_iter().collect();
    // `ticket.wave_pin or 1`: a pin of 0 counts as 1 here
    let fallback = ticket.wave_pin.map(i64::from).filter(|pin| *pin != 0).unwrap_or(1);
    let mine = w.get(&ticket.id).copied().unwrap_or(fallback);
    siblings
        .iter()
        .filter(|k| k.id != ticket.id && w.get(&k.id).copied().unwrap_or(1) < mine)
        .all(|k| closed.contains(&k.id))
}

/// A pin from the API: None clears it (the wave is computed again); else a whole number in range. The error is the
/// message of the Python `ValueError`.
pub fn clean_pin(value: &Value) -> Result<Option<i64>, String> {
    if value.is_null() {
        return Ok(None);
    }
    let Some(pin) = value.as_i64().filter(|_| value.is_i64() || value.is_u64()) else {
        // a bool, a float, text: `isinstance(value, bool) or not isinstance(value, int)`
        return Err("wave_pin must be a whole number or null".to_string());
    };
    let (lo, hi) = WAVE_PIN_RANGE;
    if !(lo..=hi).contains(&pin) {
        return Err(format!("wave_pin must be between {lo} and {hi}, or null"));
    }
    Ok(Some(pin))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn golden() -> Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../contract/golden/ticket_rules.json");
        let text = std::fs::read_to_string(path).expect("golden file ticket_rules.json exists");
        serde_json::from_str(&text).expect("golden file parses")
    }

    fn row(spec: &Value) -> ticket::Model {
        let mut t = crate::tickets::blank_ticket(spec[0].as_str().expect("id"));
        t.blocked_by = spec[1].as_str().expect("blocked_by").to_string();
        t.wave_pin = spec[2].as_i64().map(|pin| pin as i32);
        t
    }

    #[test]
    fn waves_and_pins_are_computed_as_python_computes_them() {
        let golden = golden();
        let cases = golden["waves"].as_array().expect("waves cases");
        assert!(cases.len() >= 6);
        for case in cases {
            let specs = case["in"].as_array().expect("rows");
            let kids: Vec<ticket::Model> = specs.iter().map(row).collect();
            let closed: HashSet<String> =
                specs.iter().filter(|s| s[3] == json!(true)).map(|s| s[0].as_str().expect("id").to_string()).collect();
            // a Python dict in insertion order: the same pairs, in the same order
            let got: Vec<(String, i64)> = waves(&kids);
            let expected: Vec<(String, i64)> = case["waves"]
                .as_object()
                .expect("waves")
                .iter()
                .map(|(id, w)| (id.clone(), w.as_i64().expect("wave")))
                .collect();
            assert_eq!(got, expected, "{}", case["in"]);
            for kid in &kids {
                assert_eq!(
                    json!(pinned_ready(kid, &kids, &closed)),
                    case["pinned_ready"][&kid.id],
                    "{} of {}",
                    kid.id,
                    case["in"]
                );
            }
        }
    }

    #[test]
    fn a_pin_is_a_whole_number_in_range_or_null() {
        let golden = golden();
        let cases = golden["clean_pin"].as_array().expect("clean_pin cases");
        assert!(cases.len() >= 10);
        for case in cases {
            match clean_pin(&case["in"]) {
                Ok(pin) => assert_eq!(json!(pin), case["out"], "{}", case["in"]),
                Err(message) => assert_eq!(json!(message), case["error"], "{}", case["in"]),
            }
        }
    }
}
