//! `api/ai_board.py`: REST API of wave 3 (design/screens/ai-board-wave3.md): the Board AI's tiers, the AI signals,
//! standing orders and their firings, pull requests the board opened, the knowledge base, and the eval suites.

use axum::Json;
use axum::extract::DefaultBodyLimit;
use axum::extract::multipart::Multipart;
use axum::extract::{FromRequest, Request};
use axum::http::StatusCode;
use axum::routing::post;
use kb_ai::store::save;
use kb_ai_know::kb::{self as svc_kb, AddOpts};
use kb_ai_work::github as svc_github;
use kb_base::error::{Body, Path, Query};
use kb_base::{ApiError, ApiResult, Routes, activity, pytext};
use kb_db::Session;
use kb_db::entities::{ai_knowledge_doc, ai_watched_pr, project};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde::Deserialize;
use serde_json::{Map, Value, json};

/// The routes of this file, in the order of the Python file.
pub fn routes() -> Routes {
    Routes::new()
        .get("/projects/{project_id}/ai/pulls", get_pulls)
        .post("/projects/{project_id}/ai/pulls/poll", post_poll)
        .get("/projects/{project_id}/ai/kb", get_kb)
        .get("/projects/{project_id}/ai/kb/search", get_kb_search)
        .add("POST", "/projects/{project_id}/ai/kb", post(post_kb).layer(DefaultBodyLimit::disable()))
        .get("/ai/kb/{doc_id}", get_kb_doc)
        .patch("/ai/kb/{doc_id}", patch_kb_doc)
        .delete("/ai/kb/{doc_id}", delete_kb_doc)
}

/// `svc_activity.current_actor() or "user"`.
fn by() -> String {
    let actor = activity::current_actor();
    if actor.is_empty() { "user".to_string() } else { actor }
}

/// `_fail(exc)`: a refusal of a knowledge-base call is the 422 of these routes.
fn fail(err: svc_kb::Error) -> ApiError {
    match err {
        svc_kb::Error::Value(message) | svc_kb::Error::Lookup(message) => ApiError::unprocessable(message),
        svc_kb::Error::Db(err) => err.into(),
    }
}

/// A GitHub watcher's failure: not caught by these routes, so a 500.
fn github_failure(err: svc_github::Error) -> ApiError {
    match err {
        svc_github::Error::Db(err) => err.into(),
        svc_github::Error::Other(message) => ApiError::internal(message),
    }
}

/// `_project`: the 404 of a project that is not there.
async fn project_exists(session: &Session, project_id: &str) -> ApiResult<()> {
    if project::Entity::find_by_id(project_id).one(session).await?.is_none() {
        return Err(ApiError::not_found("Project not found"));
    }
    Ok(())
}

/// The pull requests the board opened and watches.
async fn get_pulls(Path(project_id): Path<String>) -> ApiResult<Json<Vec<Value>>> {
    let session = kb_db::session();
    svc_github::watch_new(&session).await.map_err(github_failure)?;
    let rows = ai_watched_pr::Entity::find()
        .filter(ai_watched_pr::Column::ProjectId.eq(project_id.as_str()))
        .order_by_asc(ai_watched_pr::Column::Number)
        .all(&session)
        .await?;
    Ok(Json(rows.iter().map(svc_github::to_dict).collect()))
}

/// Ask gh about every open pull request now.
async fn post_poll(Path(project_id): Path<String>) -> ApiResult<Json<Value>> {
    let changes = svc_github::tick_project(&project_id).await.map_err(github_failure)?;
    Ok(Json(json!({"changes": changes})))
}

// --------------------------------------------------------------------------- knowledge base

/// The table of contents of what the project's AIs can search, and which stores it uses.
async fn get_kb(Path(project_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    let person = by();
    Ok(Json(json!({
        "stores": svc_kb::stores_for(&session, &project_id).await?,
        "documents": svc_kb::table_of_contents(&session, &project_id, Some(&person)).await?,
        // the shared store as a list of its own, searched or not (the Shared tab, WV-7)
        "shared_documents": svc_kb::shared_store(&session, Some(&person)).await?,
    })))
}

#[derive(Debug, Deserialize)]
struct SearchQuery {
    q: String,
}

/// Keyword search (BM25), as the AIs run it.
async fn get_kb_search(
    Path(project_id): Path<String>,
    Query(query): Query<SearchQuery>,
) -> ApiResult<Json<Vec<Value>>> {
    let session = kb_db::session();
    Ok(Json(svc_kb::search(&session, &project_id, &query.q, Some(&by()), 8).await?))
}

/// The 422 of a form field.
fn form_error(field: &str, kind: &str, msg: &str) -> ApiError {
    ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, json!([{"type": kind, "loc": ["body", field], "msg": msg}]))
}

/// A form field read as a `bool` (Pydantic's text forms).
fn form_bool(field: &str, text: &str) -> ApiResult<bool> {
    match text.to_lowercase().as_str() {
        "1" | "true" | "t" | "yes" | "y" | "on" => Ok(true),
        "0" | "false" | "f" | "no" | "n" | "off" => Ok(false),
        _ => Err(form_error(field, "bool_parsing", "Input should be a valid boolean, unable to interpret input")),
    }
}

/// The fields of the form of `post_kb`.
struct KbForm {
    file: Option<(String, Vec<u8>)>,
    title: String,
    text: String,
    store: String,
    private: bool,
}

/// The form of a request: multipart (what the app sends) or URL-encoded (a form with no file), as FastAPI reads both.
async fn read_form(request: Request) -> ApiResult<KbForm> {
    let parse_error = || ApiError::bad_request("There was an error parsing the body");
    let mut form =
        KbForm { file: None, title: String::new(), text: String::new(), store: "project".to_string(), private: false };
    let urlencoded = request
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_lowercase().starts_with("application/x-www-form-urlencoded"));
    let mut fields: Vec<(String, String)> = Vec::new();
    if urlencoded {
        let bytes = axum::body::to_bytes(request.into_body(), usize::MAX).await.map_err(|_| parse_error())?;
        fields = serde_urlencoded::from_bytes(&bytes).map_err(|_| parse_error())?;
    } else {
        let mut multipart = Multipart::from_request(request, &()).await.map_err(|_| {
            ApiError::unprocessable(json!([{"type": "missing", "loc": ["body"], "msg": "Field required"}]))
        })?;
        while let Some(mut field) = multipart.next_field().await.map_err(|_| parse_error())? {
            let name = field.name().unwrap_or_default().to_string();
            if name == "file" && field.file_name().is_some() {
                let filename = field.file_name().unwrap_or("").to_string();
                let mut data: Vec<u8> = Vec::new();
                while let Some(chunk) = field.chunk().await.map_err(|_| parse_error())? {
                    data.extend_from_slice(&chunk);
                }
                form.file = Some((filename, data));
            } else {
                fields.push((name, field.text().await.map_err(|_| parse_error())?));
            }
        }
    }
    for (name, value) in fields {
        match name.as_str() {
            "title" => form.title = value,
            "text" => form.text = value,
            "store" => {
                if value != "project" && value != "shared" {
                    return Err(form_error("store", "literal_error", "Input should be 'project' or 'shared'"));
                }
                form.store = value;
            }
            "private" => form.private = form_bool("private", &value)?,
            _ => {}
        }
    }
    Ok(form)
}

/// Add a document: a file (PDF, image, text, code) or pasted text. Everything becomes text on the way in.
async fn post_kb(
    Path(project_id): Path<String>,
    request: Request,
) -> ApiResult<(StatusCode, Json<Map<String, Value>>)> {
    let KbForm { file, title, text, store, private } = read_form(request).await?;
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    if store == "shared" && !svc_kb::stores_for(&session, &project_id).await?.contains(&"shared") {
        return Err(ApiError::conflict(
            "This project does not use the shared store; turn it on in the project's AI settings first.",
        ));
    }
    // `(file.filename if file else None) or title or "Untitled"`
    let name = match file.as_ref().map(|(filename, _)| filename.as_str()).filter(|f| !f.is_empty()) {
        Some(filename) => filename.to_string(),
        None if !title.is_empty() => title.clone(),
        None => "Untitled".to_string(),
    };
    let (kind, body): (String, String) = match file {
        Some((_, data)) => {
            if data.len() > 50 * 1024 * 1024 {
                return Err(ApiError::code(413, "Files are limited to 50 MB."));
            }
            let tmp = tempfile::Builder::new().prefix("kanban-kb-").tempdir().map_err(ApiError::internal)?;
            // the upload's own name never makes the path: a fixed name with a known suffix (the name is kept apart)
            let path = tmp.path().join(format!("upload{}", svc_kb::known_suffix(&name)));
            std::fs::write(&path, &data).map_err(ApiError::internal)?;
            let (kind, body) = svc_kb::to_text(&path.to_string_lossy(), &name, &project_id).await?;
            (kind.to_string(), body)
        }
        None => ("text".to_string(), text),
    };
    if pytext::strip(&body).is_empty() {
        return Err(ApiError::unprocessable("Nothing readable was found in it."));
    }
    let who = by();
    let doc = svc_kb::add(
        &session,
        AddOpts {
            project_id: Some(&project_id),
            store: &store,
            title: if title.is_empty() { &name } else { &title },
            kind: &kind,
            body: &body,
            by: &who,
            source_name: Some(&name),
            upload_url: None,
            private,
        },
    )
    .await
    .map_err(fail)?;
    Ok((StatusCode::CREATED, Json(svc_kb::to_dict(&doc))))
}

/// `doc is None or doc.deleted_at or not visible(doc, person)`: the 404 of these routes.
async fn visible_doc(session: &Session, doc_id: &str, person: &str) -> ApiResult<ai_knowledge_doc::Model> {
    let doc = ai_knowledge_doc::Entity::find_by_id(doc_id).one(session).await?;
    match doc {
        Some(doc) if doc.deleted_at.as_deref().is_none_or(str::is_empty) && svc_kb::visible(&doc, Some(person)) => {
            Ok(doc)
        }
        _ => Err(ApiError::not_found("Document not found")),
    }
}

/// One document's details (not its full text).
async fn get_kb_doc(Path(doc_id): Path<String>) -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    let doc = visible_doc(&session, &doc_id, &by()).await?;
    let mut out = svc_kb::to_dict(&doc);
    out.insert("text_preview".into(), json!(doc.text.chars().take(2000).collect::<String>()));
    Ok(Json(out))
}

/// `Literal["project", "shared"]`.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Store {
    Project,
    Shared,
}

/// Move a document to the shared store (a deliberate move), or change who sees it.
#[derive(Debug, Deserialize)]
struct KbPatch {
    #[serde(default)]
    store: Option<Store>,
    #[serde(default)]
    private: Option<bool>,
}

/// Putting a document into the shared store says who will be able to read it. Only who added a document changes who
/// sees it; the shared store takes a document only from a project that opted in to it.
async fn patch_kb_doc(Path(doc_id): Path<String>, Body(body): Body<KbPatch>) -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    let person = by();
    let mut doc = visible_doc(&session, &doc_id, &person).await?;
    if let Some(owner) = doc.created_by.as_deref().filter(|c| !c.is_empty() && *c != person) {
        return Err(ApiError::forbidden(format!("Only {owner}, who added it, can change who sees it.")));
    }
    if matches!(body.store, Some(Store::Shared)) && doc.store != "shared" {
        let opted_in = match doc.project_id.as_deref().filter(|p| !p.is_empty()) {
            Some(project_id) => svc_kb::stores_for(&session, project_id).await?.contains(&"shared"),
            None => false,
        };
        if !opted_in {
            return Err(ApiError::conflict(
                "This project does not use the shared store; turn it on in the project's AI settings first.",
            ));
        }
    }
    if matches!(body.store, Some(Store::Project))
        && doc.store != "project"
        && doc.project_id.as_deref().is_none_or(str::is_empty)
    {
        return Err(ApiError::conflict("This document came from no project."));
    }
    if let Some(store) = body.store {
        doc.store = match store {
            Store::Project => "project",
            Store::Shared => "shared",
        }
        .to_string();
    }
    if let Some(private) = body.private {
        doc.private = private;
    }
    let doc = save::<_, ai_knowledge_doc::Model, ai_knowledge_doc::ActiveModel>(&session, doc).await?;
    session.commit().await?;
    svc_kb::reindex(&session, &doc).await?;
    session.commit().await?;
    Ok(Json(svc_kb::to_dict(&doc)))
}

/// Delete a document from the knowledge base.
async fn delete_kb_doc(Path(doc_id): Path<String>) -> ApiResult<StatusCode> {
    let session = kb_db::session();
    let doc = visible_doc(&session, &doc_id, &by()).await?;
    svc_kb::remove(&session, &doc).await?;
    Ok(StatusCode::NO_CONTENT)
}
