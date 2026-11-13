//! `services/tickets.py`, lines 1182-1423: the work log of a ticket (the debug notes), with attachments and links
//! to a branch and a test case of the same ticket.

use kb_base::{activity as act, pytext, time};
use kb_db::Session;
use kb_db::entities::ticket;
use serde_json::{Map, Value, json};

use super::{Error, commit, dumps, field, for_edit, loads, put, py_str, value_error};
use kb_base::pyjson::truthy;

pub const WORK_LOG_KINDS: [&str; 5] = ["investigation", "fix_attempt", "root_cause", "blocked", "resolved"];
pub const WORK_LOG_ROLES: [&str; 6] = ["PM", "Developer", "BA", "Tester", "Designer", "Other"];
pub const MAX_WORK_LOG_NOTE: usize = 20_000;

/// `list(names)` as Python prints it: `['a', 'b']`.
fn py_list(names: &[&str]) -> String {
    format!("[{}]", names.iter().map(|name| pytext::repr(name)).collect::<Vec<_>>().join(", "))
}

/// Attachments must point at files stored by /uploads/files (or images).
pub(crate) fn clean_attachments(attachments: Option<&[Value]>) -> Result<Vec<Value>, Error> {
    let mut out: Vec<Value> = Vec::new();
    for raw in attachments.unwrap_or(&[]) {
        if !raw.is_object() {
            return value_error("Each attachment must be an object");
        }
        let text = |key: &str| if truthy(field(raw, key)) { py_str(field(raw, key)) } else { String::new() };
        let url = text("url");
        let name = pytext::strip(&text("name")).to_string();
        if !url.starts_with("/uploads/") || url.contains("..") || name.is_empty() {
            return value_error("Attachments need a name and a /uploads/ url (upload the file first)");
        }
        let mut item = Map::new();
        let id = if truthy(field(raw, "id")) { py_str(field(raw, "id")) } else { time::uuid4() };
        item.insert("id".into(), json!(id));
        item.insert("name".into(), json!(name.chars().take(200).collect::<String>()));
        item.insert("url".into(), json!(url));
        // `isinstance(size, int)`: a whole number, and a bool, which is an int in Python
        let size = field(raw, "size");
        if size.is_i64() || size.is_u64() || size.is_boolean() {
            item.insert("size".into(), size.clone());
        }
        if truthy(field(raw, "type")) {
            item.insert("type".into(), json!(py_str(field(raw, "type")).chars().take(100).collect::<String>()));
        }
        out.push(Value::Object(item));
    }
    Ok(out)
}

/// Links must point at a real branch / test case of this ticket ("" clears).
fn resolve_work_log_links(
    ticket: &ticket::Model,
    linked_branch: Option<&str>,
    linked_test_case: Option<&str>,
) -> Result<(Option<String>, Value), Error> {
    let branch = Some(pytext::strip(linked_branch.unwrap_or(""))).filter(|b| !b.is_empty());
    if let Some(branch) = branch {
        if !loads(&ticket.branches)?.iter().any(|b| field(b, "name").as_str() == Some(branch)) {
            return value_error(format!("Branch '{branch}' does not exist on this ticket"));
        }
    }
    let tc_ref = Some(pytext::strip(linked_test_case.unwrap_or(""))).filter(|t| !t.is_empty());
    let mut resolved_tc = Value::Null;
    if let Some(tc_ref) = tc_ref {
        let test_cases = loads(&ticket.test_cases)?;
        let found = test_cases
            .iter()
            .find(|t| field(t, "code").as_str() == Some(tc_ref) || field(t, "id").as_str() == Some(tc_ref));
        let Some(found) = found else {
            return value_error(format!("Test case '{tc_ref}' does not exist on this ticket"));
        };
        let code = field(found, "code");
        resolved_tc = if truthy(code) { code.clone() } else { field(found, "id").clone() };
    }
    Ok((branch.map(str::to_string), resolved_tc))
}

fn validate_work_log_fields(
    author: Option<&str>,
    role: Option<&str>,
    note: Option<&str>,
    kind: Option<&str>,
) -> Result<(), Error> {
    if author.is_some_and(|author| pytext::strip(author).is_empty()) {
        return value_error("Author must not be empty");
    }
    if let Some(role) = role.filter(|role| !WORK_LOG_ROLES.contains(role)) {
        return value_error(format!("Invalid role '{role}'. Valid roles: {}", py_list(&WORK_LOG_ROLES)));
    }
    if let Some(note) = note {
        if pytext::strip(note).is_empty() {
            return value_error("Note must not be empty");
        }
        if note.chars().count() > MAX_WORK_LOG_NOTE {
            return value_error(format!("Note is longer than {MAX_WORK_LOG_NOTE} characters"));
        }
    }
    if let Some(kind) = kind.filter(|kind| !WORK_LOG_KINDS.contains(kind)) {
        return value_error(format!("Invalid kind '{kind}'. Valid kinds: {}", py_list(&WORK_LOG_KINDS)));
    }
    Ok(())
}

/// The arguments of `add_work_log` after the session and the ticket, with the Python defaults.
#[derive(Debug, Clone)]
pub struct NewWorkLog<'a> {
    /// Name of the author.
    pub author: &'a str,
    /// Author role: PM, Developer, BA, Tester, Designer or Other.
    pub role: &'a str,
    /// Markdown note.
    pub note: &'a str,
    /// Entry kind, e.g. "investigation".
    pub kind: &'a str,
    /// Pin the entry to the top.
    pub pinned: bool,
    /// Files, each `{name, url}` with a `/uploads/` url.
    pub attachments: Option<&'a [Value]>,
    /// Branch name the note relates to.
    pub linked_branch: Option<&'a str>,
    /// Test case (code or id) the note relates to.
    pub linked_test_case: Option<&'a str>,
}

impl<'a> NewWorkLog<'a> {
    /// An investigation note, not pinned, with no attachment and no link.
    pub fn new(author: &'a str, role: &'a str, note: &'a str) -> Self {
        Self {
            author,
            role,
            note,
            kind: "investigation",
            pinned: false,
            attachments: None,
            linked_branch: None,
            linked_test_case: None,
        }
    }
}

/// Append a work-log (debug note) entry.
///
/// Returns the updated ticket, or None if it does not exist.
pub async fn add_work_log(
    session: &Session,
    ticket_id: &str,
    new: NewWorkLog<'_>,
) -> Result<Option<ticket::Model>, Error> {
    let Some(stored) = for_edit(session, ticket_id).await? else {
        return Ok(None);
    };
    let mut ticket = stored.clone();
    validate_work_log_fields(Some(new.author), Some(new.role), Some(new.note), Some(new.kind))?;
    let (linked_branch, linked_test_case) = resolve_work_log_links(&ticket, new.linked_branch, new.linked_test_case)?;
    let attachments = clean_attachments(new.attachments)?;
    let mut logs = loads(&ticket.work_log)?;
    let now_iso = time::now_iso();
    logs.push(json!({
        "id": time::uuid4(),
        "author": new.author,
        "role": new.role,
        "note": pytext::strip(new.note),
        "at": now_iso,
        "kind": new.kind,
        "pinned": new.pinned,
        "attachments": attachments,
        "linked_branch": linked_branch,
        "linkedBranch": linked_branch,
        "linked_test_case": linked_test_case,
        "linkedTestCase": linked_test_case,
        "updated_at": now_iso,
    }));
    act::record(
        &mut ticket.activity_log,
        "work_log",
        Value::Null,
        json!(new.note),
        Some(new.role),
        act::author_actor(Some(new.author)),
    );
    ticket.work_log = dumps(&logs);
    ticket.updated_at = now_iso;
    Ok(Some(commit(session, &stored, ticket).await?))
}

/// The arguments of `update_work_log` after the entry's id: only the fields that are given are changed.
#[derive(Debug, Clone, Default)]
pub struct WorkLogChanges<'a> {
    /// New note.
    pub note: Option<&'a str>,
    /// New kind.
    pub kind: Option<&'a str>,
    /// New pinned state.
    pub pinned: Option<bool>,
    /// Replacement attachment list.
    pub attachments: Option<&'a [Value]>,
    /// Branch name the note relates to ("" clears).
    pub linked_branch: Option<&'a str>,
    /// Test case (code or id) the note relates to ("" clears).
    pub linked_test_case: Option<&'a str>,
    /// New author name.
    pub author: Option<&'a str>,
    /// New author role.
    pub role: Option<&'a str>,
}

/// Edit a work-log entry; only the fields you pass are changed.
///
/// Returns the updated ticket, or None if the ticket or entry does not exist.
pub async fn update_work_log(
    session: &Session,
    ticket_id: &str,
    log_id: &str,
    changes: WorkLogChanges<'_>,
) -> Result<Option<ticket::Model>, Error> {
    let Some(stored) = for_edit(session, ticket_id).await? else {
        return Ok(None);
    };
    let mut ticket = stored.clone();
    validate_work_log_fields(changes.author, changes.role, changes.note, changes.kind)?;
    let (mut resolved_branch, mut resolved_tc) = (None, Value::Null);
    if changes.linked_branch.is_some() || changes.linked_test_case.is_some() {
        (resolved_branch, resolved_tc) =
            resolve_work_log_links(&ticket, changes.linked_branch, changes.linked_test_case)?;
    }
    let attachments = match changes.attachments {
        Some(attachments) => Some(clean_attachments(Some(attachments))?),
        None => None,
    };
    let note = changes.note.map(pytext::strip);
    let mut logs = loads(&ticket.work_log)?;
    let mut found = false;
    for lg in &mut logs {
        if field(lg, "id").as_str() == Some(log_id) {
            found = true;
            if let Some(note) = note {
                if field(lg, "note").as_str() != Some(note) {
                    act::record(
                        &mut ticket.activity_log,
                        "work_log",
                        field(lg, "note").clone(),
                        json!(note),
                        field(lg, "role").as_str(),
                        None,
                    );
                }
                put(lg, "note", json!(note));
            }
            if let Some(kind) = changes.kind {
                put(lg, "kind", json!(kind));
            }
            if let Some(pinned) = changes.pinned {
                put(lg, "pinned", json!(pinned));
            }
            if let Some(attachments) = attachments {
                put(lg, "attachments", Value::Array(attachments));
            }
            if changes.linked_branch.is_some() {
                put(lg, "linked_branch", json!(resolved_branch));
                put(lg, "linkedBranch", json!(resolved_branch));
            }
            if changes.linked_test_case.is_some() {
                put(lg, "linked_test_case", resolved_tc.clone());
                put(lg, "linkedTestCase", resolved_tc.clone());
            }
            if let Some(author) = changes.author {
                put(lg, "author", json!(author));
            }
            if let Some(role) = changes.role {
                put(lg, "role", json!(role));
            }
            put(lg, "updated_at", json!(time::now_iso()));
            break;
        }
    }
    if !found {
        return Ok(None);
    }
    ticket.work_log = dumps(&logs);
    ticket.updated_at = time::now_iso();
    Ok(Some(commit(session, &stored, ticket).await?))
}

/// Remove a work-log entry.
///
/// Returns the updated ticket (also when no entry has this id), or None if the ticket does not exist.
pub async fn delete_work_log(session: &Session, ticket_id: &str, log_id: &str) -> Result<Option<ticket::Model>, Error> {
    let Some(stored) = for_edit(session, ticket_id).await? else {
        return Ok(None);
    };
    let mut ticket = stored.clone();
    let mut logs = loads(&ticket.work_log)?;
    if let Some(removed) = logs.iter().find(|lg| field(lg, "id").as_str() == Some(log_id)) {
        let note = field(removed, "note").clone();
        act::record(&mut ticket.activity_log, "work_log", note, Value::Null, field(removed, "role").as_str(), None);
    }
    logs.retain(|lg| field(lg, "id").as_str() != Some(log_id));
    ticket.work_log = dumps(&logs);
    ticket.updated_at = time::now_iso();
    Ok(Some(commit(session, &stored, ticket).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message<T: std::fmt::Debug>(result: Result<T, Error>) -> String {
        match result {
            Err(Error::Value(message)) => message,
            other => panic!("expected a ValueError, got {other:?}"),
        }
    }

    #[test]
    fn attachments_are_cleaned_as_python_cleans_them() {
        let raw = json!([
            {"name": "  trace.txt ", "url": "/uploads/t.txt", "size": 12, "type": "text/plain", "extra": 1},
            {"id": 7, "name": "n", "url": "/uploads/n", "size": 1.5, "type": ""},
            {"id": "", "name": 3, "url": "/uploads/x", "size": true},
        ]);
        let out = clean_attachments(raw.as_array().map(Vec::as_slice)).expect("clean");
        assert_eq!(out[0]["name"], "trace.txt");
        assert_eq!(out[0]["size"], 12);
        assert_eq!(out[0]["type"], "text/plain");
        assert!(out[0].get("extra").is_none());
        let keys: Vec<&String> = out[0].as_object().expect("item").keys().collect();
        assert_eq!(keys, ["id", "name", "url", "size", "type"]);
        assert_eq!(out[1], json!({"id": "7", "name": "n", "url": "/uploads/n"}));
        assert_eq!(out[2]["name"], "3");
        assert_eq!(out[2]["size"], true);
        assert_eq!(out[2]["id"].as_str().expect("id").len(), 36);
        assert!(clean_attachments(None).expect("none").is_empty());
        for bad in [
            json!([{"name": "a", "url": "https://x/uploads/a"}]),
            json!([{"name": "a", "url": "/uploads/../a"}]),
            json!([{"name": " ", "url": "/uploads/a"}]),
            json!([{"url": "/uploads/a"}]),
        ] {
            assert_eq!(
                message(clean_attachments(bad.as_array().map(Vec::as_slice))),
                "Attachments need a name and a /uploads/ url (upload the file first)"
            );
        }
        assert_eq!(message(clean_attachments(Some(&[json!("x")]))), "Each attachment must be an object");
    }

    #[test]
    fn the_fields_of_an_entry_are_checked_with_the_python_words() {
        assert_eq!(
            message(validate_work_log_fields(None, Some("Wizard"), None, None)),
            "Invalid role 'Wizard'. Valid roles: ['PM', 'Developer', 'BA', 'Tester', 'Designer', 'Other']"
        );
        assert_eq!(
            message(validate_work_log_fields(None, None, None, Some("weird"))),
            "Invalid kind 'weird'. Valid kinds: ['investigation', 'fix_attempt', 'root_cause', 'blocked', 'resolved']"
        );
        assert_eq!(message(validate_work_log_fields(Some(" "), None, None, None)), "Author must not be empty");
        assert_eq!(message(validate_work_log_fields(None, None, Some("\n "), None)), "Note must not be empty");
        assert_eq!(
            message(validate_work_log_fields(None, None, Some(&"x".repeat(20_001)), None)),
            "Note is longer than 20000 characters"
        );
        assert!(validate_work_log_fields(None, None, None, None).is_ok());
    }
}
