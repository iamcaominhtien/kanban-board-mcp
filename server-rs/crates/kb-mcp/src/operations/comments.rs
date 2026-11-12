//! Ticket comments.

use kb_base::pytext;
use kb_board::tickets as svc_tickets;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::common::{
    self, ToolError, ToolResult, attach_folder, attach_from_run, edit_ticket, missing_ticket, notify_on_success,
};
use crate::hooks;

/// Post a comment on a ticket: progress reports, findings, questions for the humans. Returns the updated ticket
/// (the new comment is last in `comments`). In an AI run a picture or a document (an Excel sheet, a PDF) named by
/// its path in your working folder is attached: ![shot](qa/evidence/TC-1.png), [sample](ba_work/sample.xlsx).
pub async fn add_comment(ticket_id: &str, text: &str, author: &str, role: Option<&str>) -> ToolResult {
    notify_on_success(async {
        let text = attach_from_run(Some(text), None).await?.unwrap_or_default();
        // `{"role": role.strip()[:40]} if role and role.strip() else None`
        let meta: Option<Map<String, Value>> = role.map(pytext::strip).filter(|r| !r.is_empty()).map(|role| {
            let mut meta = Map::new();
            meta.insert("role".into(), Value::String(role.chars().take(40).collect()));
            meta
        });
        edit_ticket(ticket_id, None, |s, _| async move {
            svc_tickets::add_comment(&s, ticket_id, &text, author, meta.as_ref()).await.map_err(ToolError::from)
        })
        .await
    })
    .await
}

/// Size and sha256 of the board's copy of an attached file. The copy is made byte for byte, so the AI can compare
/// them with its own file (`shasum -a 256`) instead of searching the disk for the copy.
fn stored_fingerprint(url: &str) -> Map<String, Value> {
    let name = url.rsplit('/').next().unwrap_or_default();
    let mut out = Map::new();
    if let Ok(data) = std::fs::read(kb_files::uploads::get_uploads_dir(true).join(name)) {
        out.insert("size".into(), json!(data.len()));
        let digest = Sha256::digest(&data);
        out.insert("sha256".into(), json!(digest.iter().map(|b| format!("{b:02x}")).collect::<String>()));
    }
    out
}

/// `os.path.splitext(name)[1]`.
fn extension_of(name: &str) -> &str {
    let Some(dot) = name.rfind('.') else { return "" };
    // a name that only has dots before the last one (".bashrc") has no extension
    if name[..dot].chars().all(|c| c == '.') { "" } else { &name[dot..] }
}

/// Attach a file (a screenshot, a log, a report, a PDF, a spreadsheet) to a ticket: the board keeps a copy and posts
/// it in a comment, so it shows in the ticket's Attachments with the comment it came from. Returns the ticket with
/// `attached: {url, markdown, size, sha256, stored_in}` (`stored_in` is the folder the copy went to; a `warning`
/// there means the app does not serve that folder, so the file will not open in it; the copy is byte for byte:
/// compare `sha256` with `shasum -a 256` of your file, never search the disk for it); put `markdown` in a test
/// case's proof or the description to show it there too. With `post=false` no comment is posted: the file shows in
/// the Attachments once a comment (your report) holds `markdown`.
pub async fn attach_file(ticket_id: &str, path: &str, author: &str, text: Option<&str>, post: bool) -> ToolResult {
    notify_on_success(async {
        let path_stripped = pytext::strip(path);
        let base = kb_base::pypath::basename(path_stripped);
        let name = if base.is_empty() { "file" } else { base };
        let extension = extension_of(name).to_lowercase();
        if kb_files::uploads::mime_by_extension(&extension).is_none() {
            return Err(ToolError::Value(format!(
                "{path}: not a type the board stores (png, jpg, webp, gif, pdf, txt, log, json, csv, md, xlsx, docx, zip, \
                 mp4 …). Zip it, or export it as one of those."
            )));
        }
        let image = kb_files::uploads::is_supported_image(&extension);
        let reference = format!("{}[{name}]({path_stripped})", if image { "!" } else { "" });
        let folder = attach_folder().await?;
        // a link to a file is only copied when it is a document; a direct attach copies any type the board stores
        let stored = match folder.as_deref().filter(|folder| !folder.is_empty()) {
            Some(folder) => kb_board::proofs::localize(Some(&reference), folder, false, &Default::default())
                .await
                .map_err(|err| ToolError::Value(err.0))?,
            None => None,
        };
        let stored = match stored.filter(|stored| stored.contains("/uploads/")) {
            Some(stored) => stored,
            None => {
                return Err(ToolError::Value(format!(
                    "{path}: not attached. Name a file in your working folder (in an AI run) or by its absolute path."
                )));
            }
        };
        // `stored[stored.rindex("](") + 2 : -1]`
        let start = stored.rfind("](").map(|at| at + 2).unwrap_or(0);
        let url = stored.get(start..stored.len().saturating_sub(1)).unwrap_or_default().to_string();
        let mut attached = Map::new();
        attached.insert("url".into(), json!(url));
        attached.insert("markdown".into(), json!(stored));
        attached.extend(stored_fingerprint(&url));
        attached.extend(kb_files::uploads::storage_info());
        if !post {
            return Ok(json!({
                "ticket_id": ticket_id,
                "attached": Value::Object(attached),
                "note": "No comment was posted: put `markdown` in your closing report, it shows the file there.",
            }));
        }
        let body = match text.map(pytext::strip).filter(|t| !t.is_empty()) {
            Some(text) => format!("{text}\n\n{stored}"),
            None => stored.clone(),
        };
        let Value::Object(mut ticket) = edit_ticket(ticket_id, None, |s, _| async move {
            svc_tickets::add_comment(&s, ticket_id, &body, author, None).await.map_err(ToolError::from)
        })
        .await?
        else {
            return Err(ToolError::Other("a ticket is an object".to_string()));
        };
        ticket.insert("attached".into(), Value::Object(attached));
        Ok(Value::Object(ticket))
    })
    .await
}

/// Edit the text of an existing comment. Returns the updated ticket.
pub async fn update_comment(ticket_id: &str, comment_id: &str, text: &str) -> ToolResult {
    notify_on_success(async {
        let text = attach_from_run(Some(text), None).await?.unwrap_or_default();
        edit_ticket(ticket_id, Some(("comment", comment_id)), |s, cid| async move {
            svc_tickets::update_comment(&s, ticket_id, &cid.unwrap_or_default(), &text).await.map_err(ToolError::from)
        })
        .await
    })
    .await
}

/// Delete a comment (hidden everywhere; `restore_comment` brings it back). Returns the updated ticket.
pub async fn delete_comment(ticket_id: &str, comment_id: &str) -> ToolResult {
    notify_on_success(edit_ticket(ticket_id, Some(("comment", comment_id)), |s, cid| async move {
        svc_tickets::delete_comment(&s, ticket_id, &cid.unwrap_or_default()).await.map_err(ToolError::from)
    }))
    .await
}

/// Undo `delete_comment`: put a deleted comment back in the thread. Returns the updated ticket.
pub async fn restore_comment(ticket_id: &str, comment_id: &str) -> ToolResult {
    notify_on_success(edit_ticket(ticket_id, None, |s, _| async move {
        svc_tickets::restore_comment(&s, ticket_id, comment_id).await.map_err(ToolError::from)
    }))
    .await
}

/// `comment_view.pick`: only the comments with these ids and/or written after `since` (an ISO date or time).
pub fn pick(mut comments: Vec<Value>, ids: Option<&[String]>, since: Option<&str>) -> Vec<Value> {
    if let Some(ids) = ids.filter(|ids| !ids.is_empty()) {
        comments.retain(|c| c.get("id").and_then(Value::as_str).is_some_and(|id| ids.iter().any(|w| w == id)));
    }
    if let Some(since) = since.filter(|since| !since.is_empty()) {
        // `(c.get("at") or "") > since`
        comments.retain(|c| c.get("at").and_then(Value::as_str).unwrap_or_default() > since);
    }
    comments
}

/// Read a ticket's comment thread, oldest first: id, author, text (Markdown), time, `edited_at` and who was
/// notified. Cheaper than `get_ticket` when you only need the discussion; `comment_ids` / `since` narrow it. For an AI
/// reader, other AIs' and outsiders' texts come fenced as data.
pub async fn list_comments(ticket_id: &str, comment_ids: Option<&[String]>, since: Option<&str>) -> ToolResult {
    let session = common::async_session();
    let Some(ticket) = svc_tickets::get_ticket(&session, ticket_id).await? else {
        return Err(missing_ticket(ticket_id));
    };
    // `json.loads(ticket.comments or "[]")`
    let stored = if ticket.comments.is_empty() { "[]" } else { ticket.comments.as_str() };
    let parsed: Value = serde_json::from_str(stored)?;
    let Value::Array(all) = parsed else {
        return Err(ToolError::Other("the comments of a ticket are a list".to_string()));
    };
    let mut rows: Vec<Value> = all
        .into_iter()
        .filter(|c| c.is_object() && !c.get("deleted_at").is_some_and(kb_base::pyjson::truthy))
        .collect();
    let mut held_back = 0;
    if let Some(view) = hooks::ai_ticket_view() {
        let viewed = view
            .comments_for_caller(&ticket.project_id, rows.clone(), common::request_authorization().as_deref())
            .await
            .map_err(ToolError::Value)?;
        if let Some((comments, held)) = viewed {
            rows = comments;
            held_back = held;
        }
    }
    let comments: Vec<Value> = pick(rows, comment_ids, since)
        .iter()
        .map(|c| {
            let notified: Vec<Value> = match c.get("notified") {
                Some(Value::Array(items)) => items.iter().map(|n| n.get("name").cloned().unwrap_or(Value::Null)).collect(),
                _ => Vec::new(),
            };
            json!({
                "id": c.get("id").cloned().unwrap_or(Value::Null),
                "author": c.get("author").cloned().unwrap_or(Value::Null),
                "text": c.get("text").cloned().unwrap_or(Value::Null),
                "at": c.get("at").cloned().unwrap_or(Value::Null),
                "edited_at": c.get("edited_at").cloned().unwrap_or(Value::Null),
                "notified": notified,
            })
        })
        .collect();
    let mut out = Map::new();
    out.insert("ticket_id".into(), json!(ticket_id));
    out.insert("count".into(), json!(comments.len()));
    out.insert("comments".into(), Value::Array(comments));
    if held_back != 0 {
        out.insert(
            "held_back".into(),
            json!(format!(
                "{held_back} comment(s) from outside the project are not shown: this AI member does not read \
                 external sources."
            )),
        );
    }
    Ok(Value::Object(out))
}
