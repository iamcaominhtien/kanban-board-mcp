//! An AI helps when a copy stops (design D4): it reads what the board knows about the stop and proposes a fix; the
//! board applies it, resumes the copy and re-checks the counts itself. The AI's own words never decide whether the
//! copy succeeded.
//!
//! What the AI is shown: the error, the table and column names, the column types on both sides, the length of the
//! value that would not fit, the engines and row counts. Not the rows themselves and never a password or a host's
//! credentials.
//!
//! It answers through the board's assistant (`hooks::AssistantHook`). A proposal is only ever ALTER TABLE statements
//! on the board's own tables (`check_statements`).

use std::sync::LazyLock;

use kb_base::{pyjson, pytext};
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::hooks;
use crate::move_db::{Stop, app_tables};

pub const SYSTEM: &str = "You help a person move a Kanban board's database between SQLite, PostgreSQL and MySQL/MariaDB. A copy stopped \
because a value would not go into the new database. You are given what the board knows (never the rows). \
Explain the likely cause in two or three plain sentences, then propose the smallest change to the NEW database \
that lets the copy go on without losing or truncating data. Only ALTER TABLE statements on the named tables, in \
the dialect of the target and valid for its version; never DROP a table or a column, never change the source. \
Mind the target's limits (on MySQL an indexed VARCHAR column can hold at most 768 characters in utf8mb4, and a \
TEXT column cannot be indexed without a prefix). If more columns are likely to hit the same limit, say which.\n\
Reply with JSON only: {\"cause\": str, \"statements\": [str], \"affects\": str, \"other_columns\": [str], \
\"confidence\": \"high\"|\"medium\"|\"low\", \"answer\": str}. `answer` replies to the person's question when \
there is one, else is empty.";

static ALTER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)^\s*ALTER\s+TABLE\s+[`"]?(?P<table>[A-Za-z_][A-Za-z0-9_]*)[`"]?\s+(?P<rest>.+?)\s*;?\s*$"#)
        .expect("a pattern written in the code compiles")
});
static FORBIDDEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(DROP|RENAME|TRUNCATE|DELETE|INSERT|UPDATE|GRANT|REVOKE|CREATE|ATTACH)\b")
        .expect("a pattern written in the code compiles")
});
static DROP_ALLOWED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bDROP\s+(NOT\s+NULL|DEFAULT)\b").expect("a pattern written in the code compiles")
});
static OBJECT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)\{.*\}").expect("a pattern written in the code compiles"));

/// No AI can answer, or a proposal cannot be applied; the message says why.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct AssistError(pub String);

/// `text[:n]` in characters.
fn head(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

/// What the AI is shown about a stop (no values, no credentials).
pub fn bundle(stop: &Stop, plan: Option<&Map<String, Value>>) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("table".into(), json!(stop.table));
    out.insert("rows_in_table".into(), json!(stop.total));
    out.insert("stopped_at_row".into(), json!(stop.row));
    out.insert("rows_before_it".into(), json!(stop.copied));
    out.insert("tables_done".into(), json!(stop.tables_done));
    out.insert("tables_total".into(), json!(stop.tables_total));
    out.insert("error".into(), json!(stop.error));
    out.insert("error_code".into(), json!(stop.code));
    out.insert("column".into(), json!(stop.column));
    out.insert("value_length_chars".into(), json!(stop.value_length));
    out.insert("value_is_empty".into(), json!(stop.value_null));
    out.insert("column_type_source".into(), json!(stop.source_type));
    out.insert("column_type_target".into(), json!(stop.target_type));
    out.insert("column_target_nullable".into(), json!(stop.target_nullable));
    out.insert("column_target_default".into(), json!(stop.target_default));
    out.insert("column_target_indexes".into(), json!(stop.target_indexes));
    out.insert("source_engine".into(), json!(stop.source_engine));
    out.insert("target_engine".into(), json!(stop.target_engine));
    out.insert("target_version".into(), json!(stop.target_version));
    if let Some(plan) = plan.filter(|p| !p.is_empty()) {
        let problems: Vec<Value> = plan
            .get("problems")
            .and_then(Value::as_array)
            .map(|problems| {
                problems
                    .iter()
                    .take(20)
                    .map(|p| {
                        json!({
                            "table": p.get("table").cloned().unwrap_or(Value::Null),
                            "column": p.get("column").cloned().unwrap_or(Value::Null),
                            "title": p.get("title").cloned().unwrap_or(Value::Null),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.insert("problems_found_by_the_check".into(), Value::Array(problems));
    }
    out
}

/// Statements the board may run on the target: ALTER TABLE on one of the app's tables, one at a time, nothing that
/// removes data. Returns them cleaned; fails with `AssistError` naming the first that is refused.
pub fn check_statements(statements: &[String]) -> Result<Vec<String>, AssistError> {
    let mut out = Vec::new();
    for raw in statements {
        let s = pytext::strip(raw);
        if s.is_empty() || s.starts_with("--") {
            continue;
        }
        let body = pytext::strip(s.trim_end_matches(';'));
        if body.contains(';') {
            return Err(AssistError("One statement at a time: split it at the semicolon.".into()));
        }
        let Some(m) = ALTER.captures(body) else {
            return Err(AssistError(format!("Only ALTER TABLE statements can be applied here: {}", head(s, 80))));
        };
        let table = &m["table"];
        if !app_tables().iter().any(|t| t.name == table) {
            return Err(AssistError(format!("{table} is not one of the board's tables.")));
        }
        let rest = DROP_ALLOWED.replace_all(&m["rest"], "");
        if FORBIDDEN.is_match(&rest) {
            return Err(AssistError(format!("This statement would remove or rename something: {}", head(s, 80))));
        }
        out.push(body.to_string());
    }
    if out.is_empty() {
        return Err(AssistError("There is no statement to apply.".into()));
    }
    Ok(out)
}

/// The name of who answers: the board's assistant, when Claude Code is on this computer.
pub async fn pick_member() -> Result<String, AssistError> {
    let path = match hooks::assistant() {
        Some(engine) => engine.any_cli().await,
        None => None,
    };
    if path.is_none_or(|p| p.is_empty()) {
        return Err(AssistError(
            "No AI can answer: install Claude Code on this computer (or add an AI team in a project), then ask again."
                .into(),
        ));
    }
    Ok("Board AI".into())
}

/// `str(value or "").strip()`.
fn text_of(value: Option<&Value>) -> String {
    match value {
        Some(value) if pyjson::truthy(value) => pytext::strip(&pyjson::py_str(value)).to_string(),
        _ => String::new(),
    }
}

/// `data.get(key) or []` as a list.
fn list_of<'a>(data: &'a Map<String, Value>, key: &str) -> &'a [Value] {
    data.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn parse(text: &str) -> Result<Map<String, Value>, AssistError> {
    let Some(m) = OBJECT.find(text) else {
        return Err(AssistError("The AI did not answer with a proposal. Ask again.".into()));
    };
    let data = match serde_json::from_str::<Value>(m.as_str()) {
        Ok(Value::Object(data)) => data,
        _ => return Err(AssistError("The AI's answer could not be read. Ask again.".into())),
    };
    let statements: Vec<String> = list_of(&data, "statements")
        .iter()
        .map(pyjson::py_str)
        .filter(|s| !pytext::strip(s).is_empty())
        .collect();
    let mut out = Map::new();
    out.insert("cause".into(), json!(text_of(data.get("cause"))));
    out.insert("statements".into(), json!(statements));
    out.insert("affects".into(), json!(text_of(data.get("affects"))));
    out.insert(
        "other_columns".into(),
        json!(list_of(&data, "other_columns").iter().take(20).map(pyjson::py_str).collect::<Vec<_>>()),
    );
    out.insert(
        "confidence".into(),
        json!(match data.get("confidence") {
            Some(value) if pyjson::truthy(value) => pyjson::py_str(value),
            _ => "medium".to_string(),
        }),
    );
    out.insert("answer".into(), json!(text_of(data.get("answer"))));
    Ok(out)
}

/// Ask the AI about `stop`; returns its proposal (statements checked, `applicable` false when they were refused).
///
/// One answer of the board's assistant with the `db-fix` skill: no tools, and nothing written to the database that
/// is being moved.
pub async fn ask(
    stop: &Stop,
    plan: Option<&Map<String, Value>>,
    question: Option<&str>,
    previous: Option<&Map<String, Value>>,
    member: Option<String>,
) -> Result<Map<String, Value>, AssistError> {
    let name = match member {
        Some(name) => name,
        None => pick_member().await?,
    };
    let inputs = json!({
        "stop": bundle(stop, plan),
        "previous": previous.filter(|p| !p.is_empty()).map(|p| json!({
            "cause": p.get("cause").cloned().unwrap_or(Value::Null),
            "statements": p.get("statements").cloned().unwrap_or(Value::Null),
            "affects": p.get("affects").cloned().unwrap_or(Value::Null),
        })),
        "question": question.filter(|q| !q.is_empty()).map(|q| head(pytext::strip(q), 1000)),
    });
    let out = match hooks::assistant() {
        Some(engine) => engine.oneshot("db-fix", &inputs).await,
        None => Err("Claude Code was not found on this computer. Install it, then ask again.".to_string()),
    }
    .map_err(|exc| AssistError(format!("{name} could not answer: {exc}")))?;
    if out.state != "finished" {
        return Err(AssistError(format!(
            "{name} could not answer: {}",
            out.error.as_deref().filter(|e| !e.is_empty()).unwrap_or("no answer")
        )));
    }
    let mut proposal = match out.structured.as_ref().filter(|s| !s.is_empty()) {
        Some(structured) => parse(&pyjson::dumps(structured))?,
        None => parse(&out.text)?,
    };
    let statements: Vec<String> =
        list_of(&proposal, "statements").iter().filter_map(Value::as_str).map(str::to_string).collect();
    match check_statements(&statements) {
        Ok(clean) => {
            proposal.insert("statements".into(), json!(clean));
            proposal.insert("applicable".into(), json!(true));
            proposal.insert("refused".into(), Value::Null);
        }
        Err(exc) => {
            proposal.insert("applicable".into(), json!(false));
            proposal.insert("refused".into(), json!(exc.0));
        }
    }
    proposal.insert("member".into(), json!(name));
    proposal.insert("elapsed_s".into(), json!(out.elapsed_s));
    proposal.insert("cost".into(), json!(out.cost));
    proposal.insert("shown".into(), Value::Object(bundle(stop, plan)));
    Ok(proposal)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(statements: &[&str]) -> Result<Vec<String>, String> {
        check_statements(&statements.iter().map(|s| s.to_string()).collect::<Vec<_>>()).map_err(|e| e.0)
    }

    #[test]
    fn only_alter_table_on_the_boards_tables_is_applied() {
        assert_eq!(
            check(&["  ALTER TABLE project ADD COLUMN extra TEXT; ", "", "-- a note"]).unwrap(),
            ["ALTER TABLE project ADD COLUMN extra TEXT"]
        );
        assert_eq!(
            check(&["alter table `ticket` modify title LONGTEXT NOT NULL"]).unwrap(),
            ["alter table `ticket` modify title LONGTEXT NOT NULL"]
        );
        assert_eq!(
            check(&["ALTER TABLE \"ticket\" ALTER COLUMN title DROP NOT NULL"]).unwrap(),
            ["ALTER TABLE \"ticket\" ALTER COLUMN title DROP NOT NULL"]
        );
        assert_eq!(
            check(&["DROP TABLE ticket"]).unwrap_err(),
            "Only ALTER TABLE statements can be applied here: DROP TABLE ticket"
        );
        assert_eq!(
            check(&["ALTER TABLE project RENAME TO x"]).unwrap_err(),
            "This statement would remove or rename something: ALTER TABLE project RENAME TO x"
        );
        assert_eq!(check(&["ALTER TABLE nope ADD x INT"]).unwrap_err(), "nope is not one of the board's tables.");
        assert_eq!(
            check(&["ALTER TABLE project ADD a INT; ALTER TABLE project ADD b INT"]).unwrap_err(),
            "One statement at a time: split it at the semicolon."
        );
        assert_eq!(check(&["ALTER TABLE project DROP COLUMN name"]).unwrap_err().split(':').next().unwrap(), "This statement would remove or rename something");
        assert_eq!(check(&[" ", "--x"]).unwrap_err(), "There is no statement to apply.");
    }

    #[test]
    fn an_answer_is_read_from_the_json_in_it() {
        let got = parse(
            "Here you go:\n```json\n{\"cause\": \" too small \", \"statements\": [\"A\", \" \", 3], \"confidence\": \"\"}\n```",
        )
        .unwrap();
        assert_eq!(
            Value::Object(got),
            json!({"cause": "too small", "statements": ["A", "3"], "affects": "", "other_columns": [],
                   "confidence": "medium", "answer": ""})
        );
        assert_eq!(parse("no json").unwrap_err().0, "The AI did not answer with a proposal. Ask again.");
        assert_eq!(parse("{broken}").unwrap_err().0, "The AI's answer could not be read. Ask again.");
    }

    #[test]
    fn the_bundle_names_no_value() {
        let stop = Stop { table: "project".into(), row: 3, copied: 2, total: 9, value_length: Some(300), ..Stop::default() };
        let plan = json!({"problems": [{"table": "t", "column": "c", "title": "x", "detail": "d"}]});
        let shown = bundle(&stop, plan.as_object());
        assert_eq!(shown["stopped_at_row"], 3);
        assert_eq!(shown["value_length_chars"], 300);
        assert_eq!(shown["problems_found_by_the_check"], json!([{"table": "t", "column": "c", "title": "x"}]));
        assert_eq!(shown.len(), 20);
        assert_eq!(bundle(&stop, None).len(), 19);
    }
}
