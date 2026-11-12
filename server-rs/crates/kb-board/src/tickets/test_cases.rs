//! `services/tickets.py`, lines 1430-1645: the test cases of a ticket, each with a readable `TC-n` code, who ran
//! it and who set its result.

use kb_base::{activity as act, pytext, time};
use kb_db::Session;
use kb_db::entities::ticket;
use kb_db::sea_orm::EntityTrait;
use serde_json::{Value, json};

use super::validate::{MAX_TITLE, clean_text, record_doc_refs};
use super::{Error, commit, dumps, field, loads, put, py_str, value_error};
use kb_base::pyjson::truthy;

/// The arguments of `add_test_case` after the session and the ticket, with the Python defaults.
#[derive(Debug, Clone)]
pub struct NewTestCase<'a> {
    /// Short title.
    pub title: &'a str,
    /// Initial status, e.g. "pending".
    pub status: &'a str,
    /// Evidence for the result (text or link).
    pub proof: Option<&'a str>,
    /// Short note on the result.
    pub note: Option<&'a str>,
    /// What is being tested.
    pub description: Option<&'a str>,
    /// Expected outcome.
    pub expected_result: Option<&'a str>,
    /// Free-form extra notes.
    pub notes: Option<&'a str>,
    /// Member id who runs it.
    pub assignee: Option<&'a str>,
    /// Attached data files.
    pub test_data_files: Option<&'a [Value]>,
    /// Acceptance criterion the case tests (for coverage).
    pub criterion_id: Option<&'a str>,
    /// Board AI that suggested the case, when a person accepted its draft.
    pub suggested_by: Option<&'a str>,
    /// Files beside the Expected result.
    pub expected_files: Option<&'a [Value]>,
    /// Files beside the Notes.
    pub notes_files: Option<&'a [Value]>,
}

impl<'a> NewTestCase<'a> {
    /// A pending test case with a title alone.
    pub fn new(title: &'a str) -> Self {
        Self {
            title,
            status: "pending",
            proof: None,
            note: None,
            description: None,
            expected_result: None,
            notes: None,
            assignee: None,
            test_data_files: None,
            criterion_id: None,
            suggested_by: None,
            expected_files: None,
            notes_files: None,
        }
    }
}

/// `int(text)` for the number of a `TC-n` code: optional sign, ASCII digits, single underscores between digits,
/// spaces around. None where Python raises `ValueError`.
fn py_int(text: &str) -> Option<i64> {
    let text = pytext::strip(text);
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let well_formed = !digits.is_empty()
        && digits.split('_').all(|group| !group.is_empty() && group.bytes().all(|b| b.is_ascii_digit()));
    if !well_formed {
        return None;
    }
    let value: i64 = digits.replace('_', "").parse().ok()?;
    Some(if negative { -value } else { value })
}

/// Append a test case with the next `TC-n` code.
///
/// Returns the updated ticket, or None if it does not exist.
pub async fn add_test_case(
    session: &Session,
    ticket_id: &str,
    new: NewTestCase<'_>,
) -> Result<Option<ticket::Model>, Error> {
    let Some(stored) = ticket::Entity::find_by_id(ticket_id).one(session).await? else {
        return Ok(None);
    };
    let mut ticket = stored.clone();
    let title = clean_text(Some(new.title), "Test case title", MAX_TITLE)?;
    if let Some(criterion_id) = new.criterion_id.filter(|c| !c.is_empty()) {
        if !loads(&ticket.acceptance_criteria)?.iter().any(|a| field(a, "id").as_str() == Some(criterion_id)) {
            return value_error("Unknown acceptance criterion");
        }
    }
    let mut tcs = loads(&ticket.test_cases)?;
    // Determine human-readable TC code (TC-1, TC-2, ...)
    let mut max_num: i64 = 0;
    for item in &tcs {
        let c = field(item, "code").as_str().unwrap_or("");
        if c.starts_with("TC-") {
            if let Some(num) = c.split('-').nth(1).and_then(py_int) {
                if num > max_num {
                    max_num = num;
                }
            }
        }
    }
    let tc_code = format!("TC-{}", (tcs.len() as i64 + 1).max(max_num + 1));
    let now_iso = time::now_iso();

    let running = new.status == "running";
    let decided = matches!(new.status, "pass" | "fail");
    let files = |files: Option<&[Value]>| Value::Array(files.unwrap_or(&[]).to_vec());
    let new_tc = json!({
        "id": time::uuid4(),
        "code": tc_code,
        "title": title,
        "status": new.status,
        "description": new.description,
        "expected_result": new.expected_result,
        "notes": new.notes.or(new.note),
        "proof": new.proof,
        "note": new.note,
        "started_at": running.then_some(&now_iso),
        // who ran it and who set its result, shown under the case ("Started 4m ago by Ha My", "Failed 3h ago by …")
        "started_by": running.then(act::current_actor),
        "status_at": decided.then_some(&now_iso),
        "status_by": decided.then(act::current_actor),
        "created_at": now_iso,
        "updated_at": now_iso,
        "assignee": new.assignee,
        "test_data_files": files(new.test_data_files),
        "expected_files": files(new.expected_files),
        "notes_files": files(new.notes_files),
        "criterion_id": new.criterion_id,
        "suggested_by": new.suggested_by,
    });
    act::record(&mut ticket.activity_log, "test_case", Value::Null, json!(title), Some(&tc_code), None);
    for key in ["description", "expected_result", "notes", "proof"] {
        record_doc_refs(&mut ticket, None, field(&new_tc, key).as_str(), &format!("test case {tc_code}"))?;
    }
    tcs.push(new_tc);
    ticket.test_cases = dumps(&tcs);
    ticket.updated_at = now_iso;
    Ok(Some(commit(session, &stored, ticket).await?))
}

/// The arguments of `update_test_case` after the test case's id: only the fields that are given are changed.
#[derive(Debug, Clone, Default)]
pub struct TestCaseChanges<'a> {
    /// New status.
    pub status: Option<&'a str>,
    /// New evidence.
    pub proof: Option<&'a str>,
    /// New short note.
    pub note: Option<&'a str>,
    /// New title.
    pub title: Option<&'a str>,
    /// New description.
    pub description: Option<&'a str>,
    /// New expected outcome.
    pub expected_result: Option<&'a str>,
    /// New extra notes.
    pub notes: Option<&'a str>,
    /// New assignee member id.
    pub assignee: Option<&'a str>,
    /// Replacement data files.
    pub test_data_files: Option<&'a [Value]>,
    /// The acceptance criterion the case tests; "" unlinks.
    pub criterion_id: Option<&'a str>,
    /// Replacement files beside the Expected result.
    pub expected_files: Option<&'a [Value]>,
    /// Replacement files beside the Notes.
    pub notes_files: Option<&'a [Value]>,
}

/// `value or ''` in an f-string.
fn or_empty(value: &Value) -> String {
    if truthy(value) { py_str(value) } else { String::new() }
}

/// Update a test case; only the fields you pass are changed.
///
/// Returns the updated ticket (also when no test case has this id), or None if the ticket does not exist.
pub async fn update_test_case(
    session: &Session,
    ticket_id: &str,
    tc_id: &str,
    changes: TestCaseChanges<'_>,
) -> Result<Option<ticket::Model>, Error> {
    let Some(stored) = ticket::Entity::find_by_id(ticket_id).one(session).await? else {
        return Ok(None);
    };
    let mut ticket = stored.clone();
    let title = match changes.title {
        Some(title) => Some(clean_text(Some(title), "Test case title", MAX_TITLE)?),
        None => None,
    };
    let status = changes.status;
    let mut tcs = loads(&ticket.test_cases)?;
    for tc in &mut tcs {
        if field(tc, "id").as_str() == Some(tc_id) {
            let old_status = field(tc, "status").clone();
            let label = format!("{} {}", or_empty(field(tc, "code")), or_empty(field(tc, "title")));
            let label = pytext::strip(&label);
            if let Some(status) = status.filter(|status| old_status.as_str() != Some(status)) {
                let log = &mut ticket.activity_log;
                act::record(log, "test_case_status", old_status.clone(), json!(status), Some(label), None);
            }
            if let Some(title) = title.as_deref().filter(|title| field(tc, "title").as_str() != Some(title)) {
                let (from, code) = (field(tc, "title").clone(), field(tc, "code").as_str());
                act::record(&mut ticket.activity_log, "test_case", from, json!(title), code, None);
            }
            if let Some(status) = status {
                put(tc, "status", json!(status));
                if status == "running" && old_status.as_str() != Some("running") {
                    put(tc, "started_at", json!(time::now_iso()));
                    put(tc, "started_by", json!(act::current_actor()));
                }
                if matches!(status, "pass" | "fail") && old_status.as_str() != Some(status) {
                    put(tc, "status_at", json!(time::now_iso()));
                    put(tc, "status_by", json!(act::current_actor()));
                }
            }
            if let Some(title) = &title {
                put(tc, "title", json!(title));
            }
            let place = format!("test case {}", or_empty(field(tc, "code")));
            let place = pytext::strip(&place);
            for (key, value) in [
                ("description", changes.description),
                ("expected_result", changes.expected_result),
                ("notes", changes.notes),
                ("proof", changes.proof),
            ] {
                if let Some(value) = value {
                    record_doc_refs(&mut ticket, field(tc, key).as_str(), Some(value), place)?;
                    put(tc, key, json!(value));
                }
            }
            if let Some(note) = changes.note {
                put(tc, "note", json!(note));
            }
            if let Some(assignee) = changes.assignee {
                put(tc, "assignee", json!(assignee));
            }
            if let Some(files) = changes.test_data_files {
                put(tc, "test_data_files", Value::Array(files.to_vec()));
            }
            if let Some(files) = changes.expected_files {
                put(tc, "expected_files", Value::Array(files.to_vec()));
            }
            if let Some(files) = changes.notes_files {
                put(tc, "notes_files", Value::Array(files.to_vec()));
            }
            if let Some(criterion_id) = changes.criterion_id {
                put(tc, "criterion_id", json!(Some(criterion_id).filter(|c| !c.is_empty())));
            }
            put(tc, "updated_at", json!(time::now_iso()));
            break;
        }
    }
    ticket.test_cases = dumps(&tcs);
    ticket.updated_at = time::now_iso();
    Ok(Some(commit(session, &stored, ticket).await?))
}

/// Remove a test case.
///
/// Returns the updated ticket (also when no test case has this id), or None if the ticket does not exist.
pub async fn delete_test_case(session: &Session, ticket_id: &str, tc_id: &str) -> Result<Option<ticket::Model>, Error> {
    let Some(stored) = ticket::Entity::find_by_id(ticket_id).one(session).await? else {
        return Ok(None);
    };
    let mut ticket = stored.clone();
    let mut tcs = loads(&ticket.test_cases)?;
    if let Some(removed) = tcs.iter().find(|t| field(t, "id").as_str() == Some(tc_id)) {
        let title = field(removed, "title").clone();
        act::record(&mut ticket.activity_log, "test_case", title, Value::Null, field(removed, "code").as_str(), None);
    }
    tcs.retain(|t| field(t, "id").as_str() != Some(tc_id));
    ticket.test_cases = dumps(&tcs);
    ticket.updated_at = time::now_iso();
    Ok(Some(commit(session, &stored, ticket).await?))
}

#[cfg(test)]
mod tests {
    use super::py_int;

    #[test]
    fn the_number_of_a_code_is_read_as_python_reads_an_int() {
        assert_eq!(py_int("12"), Some(12));
        assert_eq!(py_int(" +7 "), Some(7));
        assert_eq!(py_int("-3"), Some(-3));
        assert_eq!(py_int("1_0"), Some(10));
        for bad in ["", "x", "1.5", "1__0", "_1", "1_", "+-1", "1 0"] {
            assert_eq!(py_int(bad), None, "{bad:?}");
        }
    }
}
