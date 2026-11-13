//! `api/ai_knowledge.py`: REST API of project knowledge (design/screens/ai-operations.md, H): the project's
//! instructions for every AI and the lessons its AIs learned, and the notes an AI keeps (issue #274).

use axum::Json;
use axum::http::StatusCode;
use kb_ai_know::knowledge::{self as svc_knowledge, LessonOpts};
use kb_ai_know::memory::{self as svc_memory, WriteOpts};
use kb_base::error::{Body, Path};
use kb_base::{ApiError, ApiResult, Routes, activity};
use kb_db::Session;
use kb_db::entities::{ai_memory_note, project};
use kb_db::sea_orm::EntityTrait;
use serde_json::Value;

use crate::schemas::{InstructionsBody, LessonBody, LessonPatch, NoteBody};

/// The routes of this file.
pub fn routes() -> Routes {
    Routes::new()
        .get("/projects/{project_id}/ai/knowledge", get_knowledge)
        .put("/projects/{project_id}/ai/knowledge/instructions", put_instructions)
        .post("/projects/{project_id}/ai/lessons", post_lesson)
        .patch("/ai/lessons/{lesson_id}", patch_lesson)
        .delete("/ai/lessons/{lesson_id}", delete_lesson)
        .post("/projects/{project_id}/ai/notes", post_note)
        .patch("/ai/notes/{note_id}", patch_note)
        .delete("/ai/notes/{note_id}", delete_note)
}

/// `svc_activity.current_actor() or "user"`.
fn by() -> String {
    let actor = activity::current_actor();
    if actor.is_empty() { "user".to_string() } else { actor }
}

/// A 404 for a project that is not there.
async fn project_exists(session: &Session, project_id: &str) -> ApiResult<()> {
    if project::Entity::find_by_id(project_id).one(session).await?.is_none() {
        return Err(ApiError::not_found("Project not found"));
    }
    Ok(())
}

/// A `LookupError` is the 404 of the route that catches it, a `ValueError` the 422; the route that catches neither
/// lets it through as a 500.
fn lookup_404_value_422(err: svc_knowledge::Error) -> ApiError {
    match err {
        svc_knowledge::Error::Lookup(message) => ApiError::not_found(message),
        svc_knowledge::Error::Value(message) => ApiError::unprocessable(message),
        svc_knowledge::Error::Db(err) => err.into(),
    }
}

/// An exception the route does not catch: a 500.
fn uncaught(err: impl std::fmt::Display) -> ApiError {
    ApiError::internal(err)
}

/// Instructions, lessons, and what they add to every prompt (tokens).
async fn get_knowledge(Path(project_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    Ok(Json(svc_knowledge::summary(&session, &project_id).await?))
}

/// Replace the instructions (the previous text is kept in the history). Takes effect on the next run.
async fn put_instructions(
    Path(project_id): Path<String>,
    Body(body): Body<InstructionsBody>,
) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    if body.instructions.chars().count() > 40_000 {
        return Err(ApiError::unprocessable("Instructions are limited to 40,000 characters."));
    }
    svc_knowledge::set_instructions(&session, &project_id, &body.instructions, &by()).await?;
    Ok(Json(svc_knowledge::summary(&session, &project_id).await?))
}

/// Add a lesson yourself.
async fn post_lesson(
    Path(project_id): Path<String>,
    Body(body): Body<LessonBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    let row = match svc_knowledge::add_lesson(&session, &project_id, &body.text, &by(), LessonOpts::default()).await {
        Ok(row) => row,
        Err(svc_knowledge::Error::Value(message)) => return Err(ApiError::unprocessable(message)),
        Err(svc_knowledge::Error::Db(err)) => return Err(err.into()),
        Err(other) => return Err(uncaught(other)),
    };
    let Some(row) = row else {
        return Err(ApiError::conflict("This lesson is already there."));
    };
    Ok((StatusCode::CREATED, Json(svc_knowledge::lesson_dict(&row))))
}

/// Keep it, edit and keep it, or say no (dropped).
async fn patch_lesson(Path(lesson_id): Path<String>, Body(body): Body<LessonPatch>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let state = body.state.map(|s| s.as_str());
    let row = svc_knowledge::update_lesson(&session, &lesson_id, &by(), body.text.as_deref(), state)
        .await
        .map_err(lookup_404_value_422)?;
    Ok(Json(svc_knowledge::lesson_dict(&row)))
}

/// Delete a lesson (it stays dropped, so the same proposal is not made again).
async fn delete_lesson(Path(lesson_id): Path<String>) -> ApiResult<StatusCode> {
    let session = kb_db::session();
    match svc_knowledge::update_lesson(&session, &lesson_id, &by(), None, Some("dropped")).await {
        Ok(_) => Ok(StatusCode::NO_CONTENT),
        Err(svc_knowledge::Error::Lookup(message)) => Err(ApiError::not_found(message)),
        Err(svc_knowledge::Error::Db(err)) => Err(err.into()),
        Err(other) => Err(uncaught(other)),
    }
}

// --------------------------------------------------------------------------- notes an AI keeps (issue #274)

/// What `memory.write` raises: a `ValueError` is the 422, a `LookupError` (not caught by the route) a 500.
fn memory_value_422(err: svc_memory::Error) -> ApiError {
    match err {
        svc_memory::Error::Value(message) => ApiError::unprocessable(message),
        svc_memory::Error::Lookup(message) => uncaught(message),
        svc_memory::Error::Db(err) => err.into(),
    }
}

/// Write a note into a role's, a member's or a ticket's memory (a person's correction, say).
async fn post_note(Path(project_id): Path<String>, Body(body): Body<NoteBody>) -> ApiResult<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    // `if not body.scope or not body.scope_key`
    let (Some(scope), Some(scope_key)) = (body.scope, body.scope_key.as_deref().filter(|k| !k.is_empty())) else {
        return Err(ApiError::unprocessable("Say whose memory it goes in."));
    };
    let kind = body.kind.map_or("feedback", |k| k.as_str());
    let opts = WriteOpts { kind: Some(kind), ..WriteOpts::default() };
    let (row, _what) = svc_memory::write(&session, &project_id, scope.as_str(), scope_key, &body.text, &by(), opts)
        .await
        .map_err(memory_value_422)?;
    Ok((StatusCode::CREATED, Json(svc_memory::note_dict(&row))))
}

/// The note, or the 404 of `_note`.
async fn note(session: &Session, note_id: &str) -> ApiResult<ai_memory_note::Model> {
    match ai_memory_note::Entity::find_by_id(note_id).one(session).await? {
        Some(row) => Ok(row),
        None => Err(ApiError::not_found("Note not found.")),
    }
}

/// Edit a note an AI wrote.
async fn patch_note(Path(note_id): Path<String>, Body(body): Body<NoteBody>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let row = note(&session, &note_id).await?;
    // `kind=body.kind or row.kind`
    let kind = body.kind.map_or(row.kind.as_str(), |k| k.as_str());
    let opts = WriteOpts { kind: Some(kind), note_id: Some(&note_id), ..WriteOpts::default() };
    let (row, _what) =
        svc_memory::write(&session, &row.project_id, &row.scope, &row.scope_key, &body.text, &by(), opts)
            .await
            .map_err(memory_value_422)?;
    Ok(Json(svc_memory::note_dict(&row)))
}

/// Remove a note.
async fn delete_note(Path(note_id): Path<String>) -> ApiResult<StatusCode> {
    let session = kb_db::session();
    let row = note(&session, &note_id).await?;
    match svc_memory::forget(&session, &row.project_id, &note_id).await {
        Ok(_) => Ok(StatusCode::NO_CONTENT),
        Err(err) => Err(memory_value_422(err)),
    }
}
