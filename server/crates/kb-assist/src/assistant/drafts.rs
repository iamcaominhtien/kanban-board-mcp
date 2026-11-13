//! The transient results of the editors and the sketch chat (AI v2): text the assistant wrote that a person accepts
//! into their editor or discards (`services/assistant/drafts.py`, lines 1 to 83). They live in memory only (the
//! board's own drafts table is gone: the assistant acts directly, and a result nobody took is not worth keeping
//! across a restart).
//!
//! Python hands out the stored dict itself, and its callers change it in place (`draft["status"] = "open"`). Here
//! `new`, `get` and `close` give a copy of the draft as it is at that moment, and `edit` changes the stored one.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard};

use kb_ai::store::now_iso;
use kb_base::time;
use serde_json::{Map, Value, json};
use tokio::task::{AbortHandle, JoinHandle};

use super::errors::AssistError;

/// The most results held at once; when it is reached the oldest quarter is dropped.
pub const MAX: usize = 400;

/// `DRAFTS`: the held results by id, oldest first.
static DRAFTS: LazyLock<Mutex<Map<String, Value>>> = LazyLock::new(|| Mutex::new(Map::new()));
/// `TASKS`: the task writing each result (a serial number tells one task of a draft from the next).
static TASKS: LazyLock<Mutex<HashMap<String, (u64, AbortHandle)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static SERIAL: AtomicU64 = AtomicU64::new(0);

fn drafts() -> MutexGuard<'static, Map<String, Value>> {
    DRAFTS.lock().unwrap_or_else(|e| e.into_inner())
}

fn tasks() -> MutexGuard<'static, HashMap<String, (u64, AbortHandle)>> {
    TASKS.lock().unwrap_or_else(|e| e.into_inner())
}

/// The keyword arguments of `new`.
#[derive(Debug, Clone, Copy)]
pub struct NewDraft<'a> {
    /// The ticket the result is for.
    pub ticket_id: Option<&'a str>,
    /// The page the result is for.
    pub doc_id: Option<&'a str>,
    /// The chat answer the result belongs to.
    pub chat_message_id: Option<&'a str>,
    /// Who wrote it, as the UI names it.
    pub member_name: &'a str,
}

impl Default for NewDraft<'_> {
    fn default() -> Self {
        Self { ticket_id: None, doc_id: None, chat_message_id: None, member_name: "Board AI" }
    }
}

/// Hold a new result (pending until it is written).
pub fn new(project_id: &str, kind: &str, owner: &str, payload: Value, more: NewDraft<'_>) -> Map<String, Value> {
    let mut held = drafts();
    if held.len() >= MAX {
        let oldest: Vec<String> = held.keys().take(MAX / 4).cloned().collect();
        for key in oldest {
            held.shift_remove(&key);
        }
    }
    let id = time::uuid4();
    let mut draft = Map::new();
    draft.insert("id".into(), json!(id));
    draft.insert("project_id".into(), json!(project_id));
    draft.insert("kind".into(), json!(kind));
    draft.insert("owner".into(), json!(owner));
    draft.insert("member_id".into(), Value::Null);
    draft.insert("member_name".into(), json!(more.member_name));
    draft.insert("ticket_id".into(), json!(more.ticket_id));
    draft.insert("doc_id".into(), json!(more.doc_id));
    draft.insert("chat_message_id".into(), json!(more.chat_message_id));
    draft.insert("insight_id".into(), Value::Null);
    draft.insert("status".into(), json!("pending"));
    draft.insert("payload".into(), payload);
    draft.insert("result".into(), json!({}));
    draft.insert("raw".into(), json!(""));
    draft.insert("cost".into(), json!(0.0));
    draft.insert("tokens".into(), json!(0));
    draft.insert("created_at".into(), json!(now_iso()));
    draft.insert("expires_at".into(), Value::Null);
    draft.insert("applied_at".into(), Value::Null);
    draft.insert("applied_by".into(), Value::Null);
    held.insert(id, Value::Object(draft.clone()));
    draft
}

/// `DRAFTS.get(draft_id)`: a held result, or None.
pub fn find(draft_id: &str) -> Option<Map<String, Value>> {
    drafts().get(draft_id).and_then(Value::as_object).cloned()
}

/// `draft_id in DRAFTS`.
pub fn holds(draft_id: &str) -> bool {
    drafts().contains_key(draft_id)
}

/// `len(DRAFTS)`.
pub fn count() -> usize {
    drafts().len()
}

/// A held result, or `not_found` once it is gone.
pub fn get(draft_id: &str) -> Result<Map<String, Value>, AssistError> {
    find(draft_id).ok_or_else(|| AssistError::new("not_found", "That draft is gone. Ask again."))
}

/// Change a held result in place (Python: the caller writes into the dict it was given). `not_found` once it is
/// gone.
pub fn edit<R>(draft_id: &str, change: impl FnOnce(&mut Map<String, Value>) -> R) -> Result<R, AssistError> {
    match drafts().get_mut(draft_id).and_then(Value::as_object_mut) {
        Some(draft) => Ok(change(draft)),
        None => Err(AssistError::new("not_found", "That draft is gone. Ask again.")),
    }
}

/// Discard or cancel a draft (a draft being written is stopped).
pub fn close(draft_id: &str, status: &str, _by: Option<&str>) -> Result<Map<String, Value>, AssistError> {
    get(draft_id)?;
    if let Some((_, task)) = tasks().remove(draft_id) {
        if !task.is_finished() {
            task.abort();
        }
    }
    edit(draft_id, |draft| {
        if matches!(draft.get("status").and_then(Value::as_str), Some("pending" | "open" | "failed")) {
            draft.insert("status".into(), json!(status));
        }
        draft.clone()
    })
}

/// Remember the task writing a result, so it can be stopped; it is forgotten when it ends.
pub fn track(draft_id: &str, task: JoinHandle<()>) {
    let serial = SERIAL.fetch_add(1, Ordering::SeqCst);
    tasks().insert(draft_id.to_string(), (serial, task.abort_handle()));
    let draft_id = draft_id.to_string();
    tokio::spawn(async move {
        let _ = task.await;
        let mut tasks = tasks();
        if tasks.get(&draft_id).is_some_and(|(held, _)| *held == serial) {
            tasks.remove(&draft_id);
        }
    });
}

/// `draft_id in TASKS`: a task is writing this result.
pub fn tracked(draft_id: &str) -> bool {
    tasks().contains_key(draft_id)
}

/// Empty `DRAFTS` and `TASKS` (tests: Python's are fresh in each process, and one test can fill them).
pub fn clear() {
    drafts().clear();
    tasks().clear();
}
