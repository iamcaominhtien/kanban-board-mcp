//! `api/tickets.py`, lines 1-440: the two upload routes, and the routes that list, count, create, read, update,
//! delete and move a ticket.

use axum::Json;
use axum::extract::DefaultBodyLimit;
use axum::extract::multipart::{Multipart, MultipartRejection};
use axum::http::StatusCode;
use axum::routing::post;
use kb_base::error::{Body, Path, Query};
use kb_base::{ApiError, ApiResult, Routes, activity, events};
use kb_db::entities::ticket;
use kb_files::{pathlib, uploads};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::{QueryBool, bad_request, given, not_found, read};
use crate::hooks::{self, NewAssignee};
use crate::schemas::TicketRead;
use crate::tickets::schemas::{
    AttachmentUploadResponse, DescriptionImageUploadResponse, StatusBody, TicketCreateBody, TicketUpdate,
};
use crate::tickets::{NewTicket, create_ticket, delete_ticket, get_ticket, lane_counts, list_tickets, update_ticket};

/// The routes of this part.
pub(super) fn routes() -> Routes {
    Routes::new()
        // the forms carry a file: the body limit of the extractors is lifted, the handlers cap what they keep
        .add("POST", "/uploads/images", post(upload_description_image).layer(DefaultBodyLimit::disable()))
        .add("POST", "/uploads/files", post(upload_attachment).layer(DefaultBodyLimit::disable()))
        .get("/projects/{project_id}/tickets", get_tickets)
        .get("/projects/{project_id}/tickets/counts", get_ticket_counts)
        .post("/projects/{project_id}/tickets", post_ticket)
        .get("/tickets/{ticket_id}", get_one_ticket)
        .patch("/tickets/{ticket_id}", patch_ticket)
        .delete("/tickets/{ticket_id}", del_ticket)
        .patch("/tickets/{ticket_id}/status", patch_status)
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

/// The `file` part of an upload form (`file: UploadFile = File(...)`).
struct Upload {
    /// `file.filename or ""`.
    filename: String,
    /// `file.content_type`.
    content_type: Option<String>,
    /// What was kept: at most `limit + 1` bytes.
    data: Vec<u8>,
    /// How many bytes the part held.
    total: usize,
}

/// Read the form and keep the `file` part, up to `limit + 1` bytes of it (Starlette reads the whole form before the
/// handler runs, so the rest is read and dropped here too). A form without a file is FastAPI's 422.
async fn read_upload(multipart: Result<Multipart, MultipartRejection>, limit: usize) -> ApiResult<Upload> {
    let parse_error = || ApiError::bad_request("There was an error parsing the body");
    let missing = || ApiError::validation(&["body", "file"], "Field required", "missing");
    let mut multipart = multipart.map_err(|_| missing())?;
    let mut upload: Option<Upload> = None;
    while let Some(mut field) = multipart.next_field().await.map_err(|_| parse_error())? {
        if field.name() != Some("file") || field.file_name().is_none() {
            continue;
        }
        let mut found = Upload {
            filename: field.file_name().unwrap_or("").to_string(),
            content_type: field.content_type().map(str::to_string),
            data: Vec::new(),
            total: 0,
        };
        while let Some(chunk) = field.chunk().await.map_err(|_| parse_error())? {
            found.total += chunk.len();
            let room = (limit + 1).saturating_sub(found.data.len());
            found.data.extend_from_slice(&chunk[..chunk.len().min(room)]);
        }
        upload = Some(found);
    }
    upload.ok_or_else(missing)
}

/// `await asyncio.to_thread(destination.write_bytes, payload)` in the uploads folder: `tokio::fs` writes on the
/// blocking pool, so a big picture does not hold the other requests while it is written.
async fn store(stored_filename: &str, payload: Vec<u8>) -> ApiResult<()> {
    let destination = uploads::get_uploads_dir(true).join(stored_filename);
    tokio::fs::write(destination, payload).await?;
    Ok(())
}

fn validate_upload(file: &Upload) -> ApiResult<(String, String)> {
    let unsupported = || ApiError::bad_request("Unsupported image type. Use png, jpg, jpeg, gif, or webp.");
    let filename = file.filename.clone();
    let extension = pathlib::suffix(&filename).to_lowercase();
    let content_type = file.content_type.clone().unwrap_or_default().to_lowercase();

    if !uploads::is_supported_image(&extension) {
        return Err(unsupported());
    }

    let expected_content_type = uploads::mime_by_extension(&extension);
    if !uploads::supported_image_mime_types().contains(&content_type.as_str())
        || Some(content_type.as_str()) != expected_content_type
    {
        return Err(unsupported());
    }

    Ok((filename, content_type))
}

/// Upload an image for use in Markdown text.
async fn upload_description_image(
    multipart: Result<Multipart, MultipartRejection>,
) -> ApiResult<(StatusCode, Json<DescriptionImageUploadResponse>)> {
    let limit = uploads::MAX_DESCRIPTION_IMAGE_BYTES as usize;
    let file = read_upload(multipart, limit).await?;
    let (filename, content_type) = validate_upload(&file)?;
    if file.total > limit {
        return Err(ApiError::code(413, "Image exceeds the 5MB upload limit."));
    }
    let payload = file.data;
    let size = payload.len();

    let stored_filename = uploads::build_upload_filename(&filename);
    store(&stored_filename, payload).await?;

    let url = format!("/uploads/{stored_filename}");
    let alt_text = uploads::build_markdown_alt_text(&filename);

    Ok((
        StatusCode::CREATED,
        Json(DescriptionImageUploadResponse {
            markdown: format!("![{alt_text}]({url})"),
            url,
            filename: stored_filename,
            content_type,
            size,
        }),
    ))
}

/// Store any file (log, trace, fixture, excel, word, ppt, json...) and return its url & markdown snippet.
async fn upload_attachment(
    multipart: Result<Multipart, MultipartRejection>,
) -> ApiResult<(StatusCode, Json<AttachmentUploadResponse>)> {
    let limit = uploads::MAX_ATTACHMENT_BYTES as usize;
    let file = read_upload(multipart, limit).await?;
    let original = file.filename.as_str();
    if pathlib::name(original).is_empty() {
        return Err(ApiError::bad_request("File name is required."));
    }
    if file.total > limit {
        return Err(ApiError::code(413, format!("File exceeds the {}MB upload limit.", limit / (1024 * 1024))));
    }
    let total = file.total;

    let stored = uploads::build_upload_filename(original);
    store(&stored, file.data).await?;

    let url = format!("/uploads/{stored}");
    let clean_name: String = pathlib::name(original).chars().take(200).collect();
    let ext = pathlib::suffix(original).to_lowercase();
    let is_img = uploads::is_supported_image(&ext);
    let md = if is_img { format!("![{clean_name}]({url})") } else { format!("[{clean_name}]({url})") };

    // `Path(stored).stem[-12:]`
    let stem: Vec<char> = pathlib::stem(&stored).chars().collect();
    let id: String = stem[stem.len().saturating_sub(12)..].iter().collect();
    let content_type = file.content_type.filter(|t| !t.is_empty()).unwrap_or_else(|| "application/octet-stream".into());
    Ok((
        StatusCode::CREATED,
        Json(AttachmentUploadResponse {
            id,
            url,
            name: clean_name,
            size: total,
            r#type: content_type.chars().take(100).collect(),
            markdown: md,
        }),
    ))
}

// ---------------------------------------------------------------------------
// Core CRUD
// ---------------------------------------------------------------------------

/// The query of `GET /projects/{project_id}/tickets`.
#[derive(Debug, Deserialize)]
struct ListQuery {
    #[serde(default, deserialize_with = "given")]
    status: Option<String>,
    #[serde(default, deserialize_with = "given")]
    priority: Option<String>,
    #[serde(default, deserialize_with = "given")]
    q: Option<String>,
    #[serde(default, deserialize_with = "given")]
    include_wont_do: Option<QueryBool>,
    #[serde(default, deserialize_with = "given")]
    pending: Option<QueryBool>,
    #[serde(default, deserialize_with = "given")]
    reopened: Option<QueryBool>,
}

/// List a project's tickets with optional filters.
async fn get_tickets(
    Path(project_id): Path<String>,
    Query(query): Query<ListQuery>,
) -> ApiResult<Json<Vec<TicketRead>>> {
    let session = kb_db::session();
    let tickets = list_tickets(
        &session,
        &project_id,
        query.status.as_deref(),
        query.priority.as_deref(),
        query.q.as_deref(),
        query.include_wont_do.is_some_and(|flag| flag.0),
        query.pending.map(|flag| flag.0),
        query.reopened.map(|flag| flag.0),
    )
    .await
    .map_err(bad_request)?;
    let mut out = Vec::with_capacity(tickets.len());
    for t in tickets {
        out.push(TicketRead::from_ticket(t)?);
    }
    Ok(Json(out))
}

/// The lane counts (tickets by status, without pending and Won't do ones), cheap enough to show while the
/// tickets load (AL-1).
async fn get_ticket_counts(Path(project_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let mut counts = lane_counts(&session, &project_id).await?;
    counts.sort();
    // a list, not a map: the status is a value ("in-progress"), never a key the UI would rename
    let lanes: Vec<Value> = counts.into_iter().map(|(k, n)| json!({"status": k, "count": n})).collect();
    Ok(Json(json!({"lanes": lanes})))
}

/// Create a ticket in a project.
async fn post_ticket(
    Path(project_id): Path<String>,
    Body(body): Body<TicketCreateBody>,
) -> ApiResult<(StatusCode, Json<TicketRead>)> {
    let session = kb_db::session();
    let new = NewTicket {
        r#type: body.r#type.as_str(),
        priority: body.priority.as_str(),
        status: body.status.as_str(),
        description: &body.description,
        parent_id: body.parent_id.as_deref(),
        estimate: body.estimate,
        due_date: body.due_date.as_deref(),
        start_date: body.start_date.as_deref(),
        tags: Some(&body.tags),
        assignee: body.assignee.as_deref(),
        ..NewTicket::new(&body.title)
    };
    let ticket = create_ticket(&session, &project_id, new).await.map_err(bad_request)?;
    events::publish("invalidate", &[]).await;
    Ok((StatusCode::CREATED, read(ticket)?))
}

/// Get a ticket by id.
async fn get_one_ticket(Path(ticket_id): Path<String>) -> ApiResult<Json<TicketRead>> {
    let session = kb_db::session();
    let Some(ticket) = get_ticket(&session, &ticket_id).await? else {
        return Err(not_found());
    };
    read(ticket)
}

/// Fields besides the title and description whose change by a person, while a run works on the ticket, is a touch
pub const TOUCH_FIELDS: [&str; 4] = ["status", "priority", "type", "tags"];

/// A ticket field as the PATCH body sends it (tags are stored as a JSON string, the body carries the list).
fn touch_value(ticket: &ticket::Model, key: &str) -> Value {
    match key {
        "status" => json!(ticket.status),
        "priority" => json!(ticket.priority),
        "type" => json!(ticket.r#type),
        "tags" => {
            let text = if ticket.tags.is_empty() { "[]" } else { ticket.tags.as_str() };
            serde_json::from_str(text).unwrap_or_else(|_| json!([]))
        }
        _ => Value::Null,
    }
}

/// The query of `PATCH /tickets/{ticket_id}`.
#[derive(Debug, Deserialize)]
struct PatchQuery {
    #[serde(default, deserialize_with = "given")]
    start: Option<QueryBool>,
}

/// Update a ticket (archiving or reassigning it ends an AI run holding it). Giving it to an AI team starts the
/// team's lead, unless `start=false` (assign only: the team starts when someone runs it).
async fn patch_ticket(
    Path(ticket_id): Path<String>,
    Query(query): Query<PatchQuery>,
    Body(data): Body<TicketUpdate>,
) -> ApiResult<Json<TicketRead>> {
    let start = query.start.is_none_or(|flag| flag.0);
    let ai_runs = hooks::ai_runs();
    let session = kb_db::session();

    let fields = &data.fields;
    if let Some(ai_runs) = ai_runs {
        let assignee = match fields.get("assignee") {
            Some(assignee) => NewAssignee::To(assignee.as_str()),
            None => NewAssignee::Unset,
        };
        let status = fields.get("status").and_then(Value::as_str);
        ai_runs.before_ticket_change(&ticket_id, status, assignee, false, &activity::current_actor()).await?;
    }
    let before = get_ticket(&session, &ticket_id).await?;
    let mut was: Map<String, Value> = Map::new();
    if let Some(before) = &before {
        was.insert("title".into(), json!(before.title));
        was.insert("description".into(), json!(before.description));
        was.insert("assignee".into(), json!(before.assignee));
        for k in TOUCH_FIELDS {
            was.insert(k.into(), touch_value(before, k));
        }
    }
    let Some(ticket) = update_ticket(&session, &ticket_id, &data).await.map_err(bad_request)? else {
        return Err(not_found());
    };
    let differs = |key: &str| fields.get(key).is_some_and(|sent| Some(sent) != was.get(key));
    // A person edits what an AI is working on: its run records it and refreshes its context (design H2)
    let edited: Vec<&str> = [("title", "the title"), ("description", "the description")]
        .into_iter()
        .filter(|(key, _)| differs(key))
        .map(|(_, label)| label)
        .collect();
    // the other fields a person changes while a run works are touches too, but the lead is not told of each
    let changed: Vec<String> = TOUCH_FIELDS.into_iter().filter(|k| differs(k)).map(|k| k.replace('_', " ")).collect();
    if let Some(ai_runs) = ai_runs {
        let by = activity::current_actor();
        if !changed.is_empty() && edited.is_empty() {
            let what = format!("the {}", changed.join(" and the "));
            ai_runs.note_person_edit(&ticket_id, &by, &what, false).await?;
        }
        if !edited.is_empty() {
            ai_runs.note_person_edit(&ticket_id, &by, &edited.join(" and "), true).await?;
        }
        if let Some(assignee) = fields.get("assignee").and_then(Value::as_str).filter(|a| !a.is_empty()) {
            if start && was.get("assignee").and_then(Value::as_str) != Some(assignee) {
                // given to a team: its lead starts (AI v2)
                let by = if by.is_empty() { "user" } else { by.as_str() };
                ai_runs.wake_new_assignee(&ticket_id, assignee, by).await?;
            }
        }
    }
    events::publish("invalidate", &[]).await;
    read(ticket)
}

/// Delete a ticket (any AI run on it is cancelled; its run history is kept).
async fn del_ticket(Path(ticket_id): Path<String>) -> ApiResult<StatusCode> {
    if let Some(ai_runs) = hooks::ai_runs() {
        ai_runs.before_ticket_change(&ticket_id, None, NewAssignee::Unset, true, &activity::current_actor()).await?;
    }
    let session = kb_db::session();
    let found = delete_ticket(&session, &ticket_id).await.map_err(bad_request)?;
    if !found {
        return Err(not_found());
    }
    events::publish("invalidate", &[]).await;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Quick status update
// ---------------------------------------------------------------------------

/// Move a ticket to another status (Won't Do cancels an AI run holding it).
async fn patch_status(Path(ticket_id): Path<String>, Body(body): Body<StatusBody>) -> ApiResult<Json<TicketRead>> {
    let ai_runs = hooks::ai_runs();
    let status = body.status.as_str();
    if status == "wont_do" {
        if let Some(ai_runs) = ai_runs {
            ai_runs
                .before_ticket_change(
                    &ticket_id,
                    Some("wont_do"),
                    NewAssignee::Unset,
                    false,
                    &activity::current_actor(),
                )
                .await?;
        }
    }
    let session = kb_db::session();
    let before = get_ticket(&session, &ticket_id).await?;
    let was = before.map(|ticket| ticket.status);
    let updated = update_ticket(&session, &ticket_id, &TicketUpdate::status(status)).await.map_err(bad_request)?;
    let Some(ticket) = updated else {
        return Err(not_found());
    };
    if was.is_some_and(|was| was != ticket.status) {
        // dragging a card or using the status menu while a run works on it is a touch (the lead is not told of it)
        if let Some(ai_runs) = ai_runs {
            ai_runs.note_person_edit(&ticket_id, &activity::current_actor(), "the status", false).await?;
        }
    }
    events::publish("invalidate", &[]).await;
    read(ticket)
}
