//! What to fix, and the verdict in words (`services/ai/health.py` lines 250 to 518): `_fixes`, `_sentence`,
//! `_reason`.

use std::collections::{BTreeSet, HashMap};

use kb_base::{pyjson, pytext};
use kb_db::entities::{ai_run, member, ticket};
use serde_json::{Map, Value, json};

use super::{MAX_FIXES, MIN_CASES, MIN_CASES_MEMORY, NOT_THE_TEAM, first_finish, reopens_after, text_or};
use crate::pynum::round_int;
use crate::touches;

/// `Counter(items).most_common(1)[0]`: the most frequent item and how often; of several, the one met first.
fn most_common<T: PartialEq + Clone>(items: impl IntoIterator<Item = T>) -> Option<(T, usize)> {
    let mut counts: Vec<(T, usize)> = Vec::new();
    for item in items {
        match counts.iter_mut().find(|(seen, _)| *seen == item) {
            Some((_, n)) => *n += 1,
            None => counts.push((item, 1)),
        }
    }
    let mut best: Option<(T, usize)> = None;
    for (item, n) in counts {
        if best.as_ref().is_none_or(|(_, most)| n > *most) {
            best = Some((item, n));
        }
    }
    best
}

/// `text[:n]` (characters).
fn head(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

/// `sorted({ticket ids})[:4]`.
fn four_tickets<'a>(ids: impl IntoIterator<Item = Option<&'a str>>) -> Vec<&'a str> {
    let set: BTreeSet<&str> = ids.into_iter().flatten().filter(|id| !id.is_empty()).collect();
    set.into_iter().take(4).collect()
}

/// `_fixes`: what to fix, worked out from rules, worst first, at most five. `rows` is the page's row of each team
/// (its id and the row), in the order the page built them.
pub fn fixes(
    runs: &[&ai_run::Model],
    tks: &[&Map<String, Value>],
    teams: &HashMap<&str, &member::Model>,
    rows: &[(String, Value)],
    tickets: &HashMap<String, ticket::Model>,
    memory_limit: i64,
    since_iso: &str,
) -> Vec<Value> {
    let mut out: Vec<(i64, Value)> = Vec::new(); // (weight, the finding)
    let name = |team_id: &str| teams.get(team_id).map_or("A team", |m| m.name.as_str()).to_string();

    // a ticket whose runs keep failing, and the reason
    let mut failing: Vec<((&str, &str), Vec<&ai_run::Model>)> = Vec::new();
    for r in runs {
        let Some(ticket_id) = r.ticket_id.as_deref().filter(|t| !t.is_empty()) else { continue };
        if matches!(r.state.as_str(), "failed" | "timed_out")
            && !r.stop_code.as_deref().is_some_and(|code| NOT_THE_TEAM.contains(&code))
        {
            let key = (ticket_id, r.member_id.as_str());
            match failing.iter_mut().find(|(k, _)| *k == key) {
                Some((_, rs)) => rs.push(r),
                None => failing.push((key, vec![r])),
            }
        }
    }
    for ((tid, team_id), mut rs) in failing {
        rs.sort_by(|a, b| a.queued_at.cmp(&b.queued_at));
        let memory: Vec<&ai_run::Model> =
            rs.iter().copied().filter(|r| r.stop_code.as_deref() == Some("memory")).collect();
        let Some(last) = rs.last() else { continue };
        if memory.len() >= MIN_CASES_MEMORY {
            let peak = memory.iter().map(|r| r.peak_rss_mb.unwrap_or(0.0)).fold(0.0f64, f64::max);
            let peak_text = if peak != 0.0 { format!(" (peak {} MB)", round_int(peak)) } else { String::new() };
            out.push((
                memory.len() as i64,
                json!({
                    "id": format!("memory:{tid}:{team_id}"),
                    "severity": "fix",
                    "title": format!("{tid} failed {} times, stopped for memory", memory.len()),
                    "evidence": format!(
                        "{} runs of {} on {tid} ended because Claude Code went over {memory_limit} MB{peak_text}.",
                        memory.len(),
                        name(team_id)
                    ),
                    "suggestion": format!(
                        "Raise Memory of one run (now {memory_limit} MB), or split the ticket so one run needs less."
                    ),
                    "tickets": [tid],
                    "team_id": team_id,
                    "run_id": last.id,
                    "action": {
                        "type": "setting",
                        "label": "Open Memory of one run",
                        "page": "ai",
                        "setting": "ai-limits",
                    },
                }),
            ));
        } else if rs.len() >= MIN_CASES {
            let reasons = most_common(rs.iter().map(|r| match r.ended_reason.as_deref().filter(|e| !e.is_empty()) {
                Some(reason) => reason.to_string(),
                None => r.state.clone(),
            }))
            .map(|(reason, _)| reason)
            .unwrap_or_default();
            out.push((
                rs.len() as i64,
                json!({
                    "id": format!("failing:{tid}:{team_id}"),
                    "severity": "fix",
                    "title": format!("{tid} failed {} times", rs.len()),
                    "evidence": format!(
                        "{} runs of {} on {tid} failed or timed out. Most often: “{}”.",
                        rs.len(),
                        name(team_id),
                        reason(&reasons, 140)
                    ),
                    "suggestion": "Read the last run: the ticket may be too big, or missing something the team needs.",
                    "tickets": [tid],
                    "team_id": team_id,
                    "run_id": last.id,
                    "action": {
                        "type": "run",
                        "label": "Open the last run",
                        "run_id": last.id,
                    },
                }),
            ));
        }
    }

    // a team that fails often
    for (team_id, row) in rows {
        let rel = &row["measures"]["reliability"];
        let (ended, ok) = (rel["ended"].as_i64().unwrap_or(0), rel["ok"].as_i64().unwrap_or(0));
        let Some(value) = rel["value"].as_f64() else { continue };
        if ended >= 5 && value < 0.7 {
            out.push((
                ended - ok,
                json!({
                    "id": format!("reliability:{team_id}"),
                    "severity": "fix",
                    "title": format!("{} finishes only {}% of its runs", name(team_id), round_int(value * 100.0)),
                    "evidence": format!(
                        "{ok} of {ended} runs finished OK. Failed: {}, timed out: {}, cancelled: {}.",
                        rel["failed"], rel["timed_out"], rel["cancelled"]
                    ),
                    "suggestion": "Look at the failed runs together: the same cause often repeats. Check the team's model, \
                                   working folder and caps.",
                    "tickets": [],
                    "team_id": team_id,
                    "run_id": null,
                    "action": {
                        "type": "team",
                        "label": "Open the team",
                        "team_id": team_id,
                    },
                }),
            ));
        }
    }

    // the same question again and again (every answered question of the range counts, also a run's earlier ones)
    let mut asked: Vec<(String, Vec<(&ai_run::Model, Map<String, Value>)>)> = Vec::new();
    for r in runs {
        for a in touches::answers_of(r) {
            let text = pytext::squash(&text_or(a.get("text"), "").to_lowercase());
            let at = a.get("at").and_then(Value::as_str).unwrap_or("");
            if !text.is_empty() && !at.is_empty() && at >= since_iso {
                match asked.iter_mut().find(|(seen, _)| *seen == text) {
                    Some((_, pairs)) => pairs.push((r, a)),
                    None => asked.push((text, vec![(r, a)])),
                }
            }
        }
    }
    for (_, mut pairs) in asked {
        if pairs.len() < MIN_CASES {
            continue;
        }
        let at_of = |a: &Map<String, Value>| a.get("at").and_then(Value::as_str).unwrap_or("").to_string();
        pairs.sort_by_key(|(_, a)| at_of(a));
        let (Some((first_run, first)), Some((last_run, _))) = (pairs.first(), pairs.last()) else { continue };
        let q = text_or(first.get("text"), "");
        let team_id =
            most_common(pairs.iter().map(|(r, _)| r.member_id.as_str())).map(|(id, _)| id).unwrap_or_default();
        let (answer, times) =
            most_common(pairs.iter().map(|(_, a)| head(&pytext::squash(&text_or(a.get("answer"), "")), 80)))
                .unwrap_or_default();
        out.push((
            pairs.len() as i64,
            json!({
                "id": format!("asked:{}:{}", first_run.id, first.get("index").and_then(Value::as_u64).unwrap_or(0)),
                "severity": "watch",
                "title": format!("{} asks the same question again and again", name(team_id)),
                "evidence": format!(
                    "Asked “{}” {} times; the answer was “{answer}” {times} time{}.",
                    head(&q, 120),
                    pairs.len(),
                    if times != 1 { "s" } else { "" }
                ),
                "suggestion": "Write the answer down once as a lesson, so the team stops asking.",
                "tickets": four_tickets(pairs.iter().map(|(r, _)| r.ticket_id.as_deref())),
                "team_id": team_id,
                "run_id": last_run.id,
                "action": {
                    "type": "tab",
                    "label": "Add a lesson in Memory",
                    "tab": "memory",
                },
            }),
        ));
    }

    // touches marked avoidable
    let avoidable: Vec<&Map<String, Value>> =
        tks.iter().copied().filter(|t| t.get("mark").and_then(Value::as_str) == Some("avoidable")).collect();
    if avoidable.len() >= MIN_CASES {
        let (kind, times) = most_common(avoidable.iter().map(|t| t.get("kind").and_then(Value::as_str).unwrap_or("")))
            .unwrap_or_default();
        out.push((
            avoidable.len() as i64,
            json!({
                "id": "avoidable",
                "severity": "watch",
                "title": format!("{} touches were avoidable", avoidable.len()),
                "evidence": format!(
                    "You marked {} of {} touches Avoidable; the most common: {} ({times}).",
                    avoidable.len(),
                    tks.len(),
                    touches::kind_label(kind).unwrap_or("").to_lowercase()
                ),
                "suggestion": "Open them one by one and make a lesson, a rule or a setting out of each.",
                "tickets": four_tickets(avoidable.iter().map(|t| t.get("ticket_id").and_then(Value::as_str))),
                "team_id": null,
                "run_id": null,
                "action": {
                    "type": "tab",
                    "label": "Open the avoidable touches",
                    "tab": "stepped",
                    "mark": "avoidable",
                },
            }),
        ));
    }

    // work the AI finished that came back (reopened after the first finish, at least twice)
    let mut finished = first_finish(runs);
    finished.sort();
    for (tid, at) in &finished {
        let Some(t) = tickets.get(tid) else { continue };
        let n = reopens_after(Some(t), Some(at), None);
        if n >= 2 {
            out.push((
                n as i64,
                json!({
                    "id": format!("reopened:{tid}"),
                    "severity": "watch",
                    "title": format!("{tid} was reopened {n} times after the AI finished it"),
                    "evidence": format!(
                        "A run finished {tid} and a person reopened it {n} times since: “{}”.",
                        head(&t.title, 100)
                    ),
                    "suggestion": "Rewrite the acceptance criteria so the team and the reviewer read them the same way.",
                    "tickets": [tid],
                    "team_id": null,
                    "run_id": null,
                    "action": {
                        "type": "ticket",
                        "label": "Open the ticket",
                        "ticket_id": tid,
                    },
                }),
            ));
        }
    }

    // cost against the caps
    for (team_id, row) in rows {
        let c = &row["measures"]["cost"];
        let over = c["runs_over_cap"].as_i64().unwrap_or(0);
        let share = c["month_share"].as_f64();
        if over >= 2 || share.is_some_and(|share| share > 0.9) {
            let why = if over >= 2 {
                format!(
                    "{over} runs cost more than the ${:.2} cap of one run.",
                    c["cap_per_run"].as_f64().unwrap_or(0.0)
                )
            } else {
                format!(
                    "The last 30 days cost ${:.2}, {}% of the ${:.2} monthly cap.",
                    c["month_spend"].as_f64().unwrap_or(0.0),
                    round_int(share.unwrap_or(0.0) * 100.0),
                    c["monthly_cap"].as_f64().unwrap_or(0.0)
                )
            };
            out.push((
                if over != 0 { over } else { 1 },
                json!({
                    "id": format!("cost:{team_id}"),
                    "severity": if share.unwrap_or(0.0) > 0.9 { "fix" } else { "watch" },
                    "title": format!("{} is near or over its caps", name(team_id)),
                    "evidence": why,
                    "suggestion": "Raise the cap if the spend is worth it, or look at why one run costs so much.",
                    "tickets": [],
                    "team_id": team_id,
                    "run_id": null,
                    "action": {
                        "type": "team",
                        "label": "Open the team's caps",
                        "team_id": team_id,
                    },
                }),
            ));
        }
    }

    out.sort_by(|(wa, a), (wb, b)| {
        let key = |w: i64, f: &Value| (f["severity"] != "fix", -w, f["id"].as_str().unwrap_or("").to_string());
        key(*wa, a).cmp(&key(*wb, b))
    });
    out.into_iter().take(MAX_FIXES).map(|(_, finding)| finding).collect()
}

/// `_sentence`: the verdict in plain words.
pub fn sentence(m: &Value, prev: Option<&Value>, fixes: &[Value], bad_teams: &[String]) -> String {
    let reliable = match m["reliability"]["verdict"].as_str() {
        Some("good") => "reliable",
        Some("watch") => "mostly reliable",
        Some("fix") => "not reliable yet",
        _ => "running",
    };
    let speed = m["speed"]["run_median_s"].as_f64();
    let was = prev.and_then(|prev| prev["speed"]["run_median_s"].as_f64());
    let faster = match (speed, was) {
        (Some(speed), Some(was)) if (speed - was).abs() > 60.0 => {
            if speed < was {
                " and getting faster"
            } else {
                " and getting slower"
            }
        }
        _ => "",
    };
    let mut parts = vec![format!("The AI teams are {reliable}{faster}")];
    if matches!(m["autonomy"]["verdict"].as_str(), Some("watch" | "fix")) {
        let av = m["autonomy"]["avoidable"].as_i64().unwrap_or(0);
        parts.push(format!(
            "but people still step in too often ({} touches per ticket{})",
            pyjson::py_str(&m["autonomy"]["value"]),
            if av != 0 { format!(", {av} marked avoidable") } else { String::new() }
        ));
    }
    let mut text = format!("{}.", parts.join(", "));
    if !bad_teams.is_empty() {
        let two: Vec<&str> = bad_teams.iter().take(2).map(String::as_str).collect();
        text.push_str(&format!(
            " {} {} fixing first.",
            two.join(", "),
            if bad_teams.len() == 1 { "needs" } else { "need" }
        ));
    }
    if !fixes.is_empty() {
        text.push_str(&format!(" {} thing{} to fix below.", fixes.len(), if fixes.len() != 1 { "s" } else { "" }));
    }
    text
}

/// `_reason`: a run's end reason for a sentence: no closing full stop of its own, cut with an ellipsis, not
/// mid-word (Python's default `limit`: 140).
pub fn reason(text: &str, limit: usize) -> String {
    let squashed = pytext::squash(text);
    let t = squashed.trim_end_matches('.');
    let count = t.chars().count();
    if count <= limit {
        return t.to_string();
    }
    // `t[: limit - 1]`: with a limit of 0 the slice ends one character before the end
    let cut: String = t.chars().take(if limit == 0 { count - 1 } else { limit - 1 }).collect();
    // `rsplit(" ", 1)[0]`: what is before the last space, or all of it when there is none
    let kept = cut.rsplit_once(' ').map_or(cut.as_str(), |(before, _)| before);
    format!("{}…", kept.trim_end_matches([',', ';', ':', ' ']))
}
