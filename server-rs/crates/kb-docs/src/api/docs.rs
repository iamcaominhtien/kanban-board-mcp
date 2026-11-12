//! `api/docs.py`: the Docs routes whose service functions are in `services/docs.py`, `docs_search.py` and
//! `docs_work.py`, in the order the Python router registers them.
//!
//! `GET|POST /docs/pages/{page_id}/send-to-ai`, `GET /tickets/{ticket_id}/docs/comments` and `POST
//! /tickets/{ticket_id}/docs/comments/send` call `services/docs_ai/handoff.py`, the Docs AI above this crate: they go
//! through `hooks::DocsAiHook` (and answer 500 while none is registered). A `DocsAiError` or `AssistError` of that
//! call has a handler of its own in the app: its answer is `{detail, code, ...}` without the `detail` wrapper, so
//! these handlers return [`Failure`].
//!
//! Registration order and path parameters: no path of this file has a parameter that could swallow a literal
//! segment registered later (`by-path`, `by-slug/{slug}`, `similar`, `search`, `recycle-bin`, `resolve`, `import`,
//! `follow`, `followers`, `comment-events`, `access` are literals under `/projects/{project_id}/docs/`, and the one
//! parameter there, `by-slug/{slug}`, has a segment of its own). The page routes all start `/docs/pages/{page_id}`,
//! the comment routes `/docs/comments/`, and `/docs/templates` is the only other path under `/docs/`. `DELETE
//! /tickets/{ticket_id}/docs/comments` is answered by the `{page_id}` route registered before the Docs AI routes, as
//! Python does (the app's router picks the first match, as Starlette does): it unlinks a page called "comments".

use std::sync::LazyLock;

use axum::Json;
use axum::extract::DefaultBodyLimit;
use axum::extract::RawQuery;
use axum::extract::multipart::{Multipart, MultipartRejection};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use kb_base::error::{Body, Path};
use kb_base::{ApiError, ApiResult, Routes, events, pyjson};
use kb_db::entities::project as project_table;
use kb_db::sea_orm::EntityTrait;
use kb_doctext::docs_access;
use regex::Regex;
use serde_json::{Map, Value, json};

use super::{docs_error, query_int, query_opt, query_opt_bool, query_pairs, query_required, query_str};
use crate::docs_search::{self, SearchParams};
use crate::schemas::{
    AccessRequestBody, AnchorBody, AnchorPreviewBody, AssignPageBody, CommentBody, DraftSave, FollowBody,
    ImportResolveBody, PageCreate, PageDuplicate, PageMove, PageRename, PublishBody, ResolveBody, RestoreBody,
    SeenBody, SendCommentsBody, SendToAiBody, ThreadCreate, TicketDocBody,
};
use crate::{docs, docs_comments, docs_import, docs_work};

static NEEDS_INPUT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[Needs input[^\]]*\]").expect("the needs-input pattern is valid"));

/// The routes of this file.
pub fn routes() -> Routes {
    Routes::new()
        .get("/docs/templates", get_templates)
        .get("/projects/{project_id}/docs/tree", get_tree)
        .post("/projects/{project_id}/docs/pages", post_page)
        .get("/projects/{project_id}/docs/by-path", get_by_path)
        .get("/projects/{project_id}/docs/by-slug/{slug}", get_by_slug)
        .get("/projects/{project_id}/docs/similar", get_similar)
        .get("/projects/{project_id}/docs/search", get_search)
        .get("/projects/{project_id}/docs/recycle-bin", get_recycle_bin)
        .delete("/projects/{project_id}/docs/recycle-bin", empty_recycle_bin)
        .post("/projects/{project_id}/docs/resolve", post_resolve)
        // the files are read up to 2 MB each (and one byte more): the body limit of the extractors is lifted
        .add("POST", "/projects/{project_id}/docs/import", post(post_import).layer(DefaultBodyLimit::disable()))
        .post("/projects/{project_id}/docs/import/resolve", post_import_resolve)
        .get("/docs/pages/{page_id}", get_page)
        .get("/docs/pages/{page_id}/rename-preview", get_rename_preview)
        .get("/docs/pages/{page_id}/delete-preview", get_delete_preview)
        .patch("/docs/pages/{page_id}", patch_page)
        .delete("/docs/pages/{page_id}", del_page)
        .post("/docs/pages/{page_id}/move", post_move)
        .post("/docs/pages/{page_id}/duplicate", post_duplicate)
        .post("/docs/pages/{page_id}/restore", post_restore)
        .delete("/docs/pages/{page_id}/purge", purge)
        .put("/docs/pages/{page_id}/draft", put_draft)
        .get("/projects/{project_id}/docs/followers", get_followers)
        .put("/projects/{project_id}/docs/follow", put_follow)
        .get("/docs/pages/{page_id}/seen", get_seen)
        .put("/docs/pages/{page_id}/seen", put_seen)
        .delete("/docs/pages/{page_id}/draft", del_draft)
        .post("/docs/pages/{page_id}/publish", post_publish)
        .get("/docs/pages/{page_id}/versions", get_versions)
        .get("/docs/pages/{page_id}/versions/{version}", get_version)
        .get("/docs/pages/{page_id}/versions/{version}/diff/{b}", get_diff)
        .post("/docs/pages/{page_id}/versions/{version}/restore", post_restore_version)
        .get("/docs/pages/{page_id}/backlinks", get_backlinks)
        .get("/docs/pages/{page_id}/work", get_page_work)
        .post("/docs/pages/{page_id}/assign", post_page_assign)
        .get("/tickets/{ticket_id}/docs", get_ticket_docs)
        .post("/tickets/{ticket_id}/docs", post_ticket_doc)
        .delete("/tickets/{ticket_id}/docs/{page_id}", delete_ticket_doc)
        .get("/docs/pages/{page_id}/comments", get_comments)
        .post("/docs/pages/{page_id}/comments", post_thread)
        .post("/docs/pages/{page_id}/comments/anchor-preview", post_anchor_preview)
        .post("/docs/comments/threads/{thread_id}/replies", post_reply)
        .get("/docs/pages/{page_id}/send-to-ai", get_send_to_ai)
        .post("/docs/pages/{page_id}/send-to-ai", post_send_to_ai)
        .get("/tickets/{ticket_id}/docs/comments", get_ticket_doc_comments)
        .post("/tickets/{ticket_id}/docs/comments/send", post_ticket_doc_comments_send)
        .post("/docs/comments/threads/{thread_id}/resolve", post_resolve_thread)
        .post("/docs/comments/threads/{thread_id}/reopen", post_reopen)
        .post("/docs/comments/threads/{thread_id}/reattach", post_reattach)
        .post("/docs/comments/threads/{thread_id}/read", post_read)
        .patch("/docs/comments/{comment_id}", patch_comment)
        .delete("/docs/comments/{comment_id}", del_comment)
        .get("/projects/{project_id}/docs/comment-events", get_comment_events)
        .get("/projects/{project_id}/docs/access", get_docs_access)
        .post("/projects/{project_id}/docs/access-requests", post_access_request)
}

fn obj(map: Map<String, Value>) -> Json<Value> {
    Json(Value::Object(map))
}

/// A service result as the router answers it: a `DocsError` through the handler of `main.py`.
fn done<T>(headers: &HeaderMap, result: crate::Result<T>) -> ApiResult<T> {
    result.map_err(|e| docs_error(headers, e))
}

/// `_mutate`: the service call, then the "invalidate" event.
async fn mutate<T>(headers: &HeaderMap, result: crate::Result<T>) -> ApiResult<T> {
    let value = done(headers, result)?;
    events::publish("invalidate", &[]).await;
    Ok(value)
}

/// Tell watchers a page was published (SSE `data:` is this JSON string), and write it to the notification log for
/// the people who follow the space or the page (only when the author chose to notify).
async fn announce(page: &Map<String, Value>, note: Option<&str>) {
    kb_notify::on_page_published(&Value::Object(page.clone()), note).await;
    let note = kb_base::pytext::strip(note.unwrap_or(""));
    let event = json!({
        "type": "docs_published",
        "project_id": page["project_id"],
        "page_id": page["id"],
        "title": page["title"],
        "version": page["version"],
        "author": page["updated_by"],
        "note": if note.is_empty() { Value::Null } else { json!(note) },
    });
    events::publish(&pyjson::dumps(&event), &[]).await;
}

/// List the page templates.
async fn get_templates() -> Json<Value> {
    let rows: Vec<Value> = docs::templates()
        .into_iter()
        .map(|(id, t)| json!({"id": id, "name": t.name, "description": t.description, "markdown": t.markdown}))
        .collect();
    Json(Value::Array(rows))
}

/// Get the project's page tree.
async fn get_tree(headers: HeaderMap, Path(project_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    Ok(Json(Value::Array(done(&headers, docs::list_tree(&session, &project_id).await)?)))
}

/// Create a page.
async fn post_page(
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Body(body): Body<PageCreate>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    let page = done(
        &headers,
        docs::create_page(
            &session,
            &project_id,
            &body.title,
            body.parent_id.as_deref(),
            &body.template,
            body.markdown.as_deref(),
        )
        .await,
    )?;
    events::publish("invalidate", &[]).await;
    Ok((StatusCode::CREATED, obj(page)))
}

/// Get a page by its slug path (`architecture/api`, a share link); a path from before a rename still works.
async fn get_by_path(
    headers: HeaderMap,
    Path(project_id): Path<String>,
    RawQuery(query): RawQuery,
) -> ApiResult<Json<Value>> {
    let path = query_required(&query_pairs(query.as_deref()), "path")?;
    let session = kb_db::session();
    Ok(obj(done(&headers, docs::page_by_path(&session, &project_id, &path).await)?))
}

/// Get a page by slug.
async fn get_by_slug(headers: HeaderMap, Path((project_id, slug)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    Ok(obj(done(&headers, docs::page_by_slug(&session, &project_id, &slug).await)?))
}

/// Suggest pages whose slug or title resembles `slug`.
async fn get_similar(
    headers: HeaderMap,
    Path(project_id): Path<String>,
    RawQuery(query): RawQuery,
) -> ApiResult<Json<Value>> {
    let slug = query_str(&query_pairs(query.as_deref()), "slug", "");
    let session = kb_db::session();
    done(&headers, docs::project(&session, &project_id, false).await)?;
    Ok(Json(Value::Array(done(&headers, docs_search::similar(&session, &project_id, &slug).await)?)))
}

/// Search pages and tickets.
async fn get_search(
    headers: HeaderMap,
    Path(project_id): Path<String>,
    RawQuery(query): RawQuery,
) -> ApiResult<Json<Value>> {
    let pairs = query_pairs(query.as_deref());
    let params = SearchParams {
        scope: query_str(&pairs, "scope", "space"),
        limit: query_int(&pairs, "limit", 20)?,
        offset: query_int(&pairs, "offset", 0)?,
        page_id: query_opt(&pairs, "page_id"),
        mode: query_opt(&pairs, "mode"),
        author: query_opt(&pairs, "author"),
        edited_since: query_opt(&pairs, "edited_since"),
        under_page: query_opt(&pairs, "under_page"),
        has_tickets: query_opt_bool(&pairs, "has_tickets")?,
        status: query_opt(&pairs, "status"),
        sort: query_str(&pairs, "sort", "relevance"),
    };
    let q = query_str(&pairs, "q", "");
    let session = kb_db::session();
    done(&headers, docs::project(&session, &project_id, false).await)?;
    Ok(obj(done(&headers, docs_search::search(&session, &project_id, &q, &params).await)?))
}

/// List pages in the Recycle Bin.
async fn get_recycle_bin(headers: HeaderMap, Path(project_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    Ok(Json(Value::Array(done(&headers, docs::list_deleted(&session, &project_id).await)?)))
}

/// Permanently delete everything in the Recycle Bin.
async fn empty_recycle_bin(headers: HeaderMap, Path(project_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    Ok(obj(mutate(&headers, docs::empty_recycle_bin(&session, &project_id).await).await?))
}

/// Resolve `[[references]]` to pages, sections and tickets.
async fn post_resolve(
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Body(body): Body<ResolveBody>,
) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let refs: Vec<Value> = body.refs.into_iter().map(Value::Object).collect();
    Ok(Json(Value::Array(done(&headers, docs::resolve_refs(&session, &project_id, &refs, body.from_ticket).await)?)))
}

/// A form field as text. Starlette's form keeps the last value of a repeated field.
fn form_bool(value: Option<&str>, name: &str) -> ApiResult<bool> {
    let Some(value) = value else { return Ok(false) };
    match value.to_lowercase().as_str() {
        "1" | "true" | "t" | "yes" | "y" | "on" => Ok(true),
        "0" | "false" | "f" | "no" | "n" | "off" => Ok(false),
        _ => Err(ApiError::validation(
            &["body", name],
            "Input should be a valid boolean, unable to interpret input",
            "bool_parsing",
        )),
    }
}

/// The parts of the import form (`files`, `paths` and the text fields of `post_import`).
struct ImportForm {
    files: Vec<(String, Vec<u8>)>,
    paths: Vec<String>,
    fields: Vec<(String, String)>,
}

impl ImportForm {
    fn field(&self, name: &str) -> Option<&str> {
        self.fields.iter().rev().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
    }
}

/// Read the multipart body: each file up to `MAX_FILE_BYTES + 1` bytes (so an oversized file is reported, not
/// loaded whole), the text fields whole.
async fn read_import_form(multipart: Result<Multipart, MultipartRejection>) -> ApiResult<ImportForm> {
    let missing = || ApiError::validation(&["body", "files"], "Field required", "missing");
    let parse_error = || ApiError::bad_request("There was an error parsing the body");
    let mut multipart = multipart.map_err(|_| missing())?;
    let mut form = ImportForm { files: Vec::new(), paths: Vec::new(), fields: Vec::new() };
    while let Some(mut field) = multipart.next_field().await.map_err(|_| parse_error())? {
        let name = field.name().unwrap_or("").to_string();
        if let Some(filename) = field.file_name().map(str::to_string) {
            let mut data: Vec<u8> = Vec::new();
            let limit = docs_import::MAX_FILE_BYTES + 1;
            while let Some(chunk) = field.chunk().await.map_err(|_| parse_error())? {
                let room = limit.saturating_sub(data.len());
                data.extend_from_slice(&chunk[..chunk.len().min(room)]);
            }
            if name == "files" {
                form.files.push((filename, data));
            }
        } else {
            let text = field.text().await.map_err(|_| parse_error())?;
            if name == "paths" {
                form.paths.push(text);
            } else {
                form.fields.push((name, text));
            }
        }
    }
    if form.files.is_empty() {
        return Err(missing());
    }
    Ok(form)
}

/// Import Markdown files as draft pages (dry_run only reports the plan).
async fn post_import(
    headers: HeaderMap,
    Path(project_id): Path<String>,
    multipart: Result<Multipart, MultipartRejection>,
) -> ApiResult<Json<Value>> {
    let form = read_import_form(multipart).await?;
    let dry_run = form_bool(form.field("dry_run"), "dry_run")?;
    let publish = form_bool(form.field("publish"), "publish")?;
    let notify = form_bool(form.field("notify"), "notify")?;
    let uploads: Vec<(String, Vec<u8>)> = form
        .files
        .iter()
        .enumerate()
        .map(|(i, (filename, data))| {
            let name = form.paths.get(i).filter(|p| !p.is_empty()).cloned().unwrap_or_else(|| filename.clone());
            (name, data.clone())
        })
        .collect();
    let parent = form.field("parent_id").filter(|p| !p.is_empty());
    let on_conflict = form.field("on_conflict").unwrap_or("copy");
    let session = kb_db::session();
    if dry_run {
        return Ok(obj(done(
            &headers,
            docs_import::dry_run(&session, &project_id, &uploads, parent, on_conflict).await,
        )?));
    }
    let result =
        done(&headers, docs_import::run_import(&session, &project_id, &uploads, parent, on_conflict, publish).await)?;
    events::publish("invalidate", &[]).await;
    if publish && notify {
        let created = result.get("created").and_then(Value::as_array).cloned().unwrap_or_default();
        for item in created.iter().take(50) {
            let page_id = item["page_id"].as_str().unwrap_or("");
            let page = done(&headers, docs::page_detail(&session, page_id).await)?;
            announce(&page, Some("Imported")).await;
        }
    }
    Ok(obj(result))
}

/// Re-index links of imported pages and re-point pending links.
async fn post_import_resolve(
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Body(body): Body<ImportResolveBody>,
) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let result = done(&headers, docs_import::resolve_pages(&session, &project_id, &body.page_ids).await)?;
    events::publish("invalidate", &[]).await;
    Ok(obj(result))
}

/// Get a page with its content, draft and stats.
async fn get_page(headers: HeaderMap, Path(page_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    Ok(obj(done(&headers, docs::page_detail(&session, &page_id).await)?))
}

/// Preview the link rewrites a rename would make.
async fn get_rename_preview(
    headers: HeaderMap,
    Path(page_id): Path<String>,
    RawQuery(query): RawQuery,
) -> ApiResult<Json<Value>> {
    let title = query_str(&query_pairs(query.as_deref()), "title", "");
    let session = kb_db::session();
    Ok(obj(done(&headers, docs::rename_preview(&session, &page_id, &title).await)?))
}

/// Preview what deleting a page would affect.
async fn get_delete_preview(headers: HeaderMap, Path(page_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    Ok(obj(done(&headers, docs::delete_preview(&session, &page_id).await)?))
}

/// Rename a page.
async fn patch_page(
    headers: HeaderMap,
    Path(page_id): Path<String>,
    Body(body): Body<PageRename>,
) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    Ok(obj(mutate(&headers, docs::rename_page(&session, &page_id, &body.title, body.rewrite_links).await).await?))
}

/// Move a page and its sub-pages to the Recycle Bin.
async fn del_page(headers: HeaderMap, Path(page_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    Ok(obj(mutate(&headers, docs::delete_page(&session, &page_id).await).await?))
}

/// Move a page.
async fn post_move(
    headers: HeaderMap,
    Path(page_id): Path<String>,
    Body(body): Body<PageMove>,
) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let moved = docs::move_page(
        &session,
        &page_id,
        body.parent_id.as_deref(),
        body.before_id.as_deref(),
        body.after_id.as_deref(),
    )
    .await;
    Ok(obj(mutate(&headers, moved).await?))
}

/// Duplicate a page and its sub-pages.
async fn post_duplicate(
    headers: HeaderMap,
    Path(page_id): Path<String>,
    Body(body): Body<PageDuplicate>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    let parent_given = body.parent_id.is_some();
    let parent_id = body.parent_id.flatten();
    let copy = docs::duplicate_page(
        &session,
        &page_id,
        body.title.as_deref(),
        parent_id.as_deref(),
        body.include_children,
        parent_given,
    )
    .await;
    Ok((StatusCode::CREATED, obj(mutate(&headers, copy).await?)))
}

/// Restore a page from the Recycle Bin.
async fn post_restore(headers: HeaderMap, Path(page_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    Ok(obj(mutate(&headers, docs::restore_page(&session, &page_id).await).await?))
}

/// Permanently delete a page from the Recycle Bin.
async fn purge(headers: HeaderMap, Path(page_id): Path<String>) -> ApiResult<StatusCode> {
    let session = kb_db::session();
    mutate(&headers, docs::purge_page(&session, &page_id).await).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Save your draft of a page.
async fn put_draft(
    headers: HeaderMap,
    Path(page_id): Path<String>,
    Body(body): Body<DraftSave>,
) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let saved = docs::save_draft(&session, &page_id, &body.markdown, body.title.as_deref(), body.base_version).await;
    Ok(obj(done(&headers, saved)?))
}

/// Return who follows the project's Docs space (not counting you).
async fn get_followers(headers: HeaderMap, Path(project_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    Ok(obj(done(&headers, docs::followers(&session, &project_id).await)?))
}

/// Follow or unfollow the project's Docs space as you.
async fn put_follow(
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Body(body): Body<FollowBody>,
) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    Ok(obj(done(&headers, docs::set_following(&session, &project_id, body.on).await)?))
}

/// Return the version of a page you last viewed.
async fn get_seen(headers: HeaderMap, Path(page_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    Ok(obj(done(&headers, docs::get_seen(&session, &page_id).await)?))
}

/// Record the version of a page you have viewed.
async fn put_seen(
    headers: HeaderMap,
    Path(page_id): Path<String>,
    Body(body): Body<SeenBody>,
) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    Ok(obj(done(&headers, docs::mark_seen(&session, &page_id, body.version).await)?))
}

/// Discard your draft of a page.
async fn del_draft(headers: HeaderMap, Path(page_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    Ok(obj(mutate(&headers, docs::discard_draft(&session, &page_id).await).await?))
}

/// Publish the draft as a new version.
async fn post_publish(
    headers: HeaderMap,
    Path(page_id): Path<String>,
    Body(body): Body<PublishBody>,
) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let published = docs::publish_page(
        &session,
        &page_id,
        body.base_version,
        body.note.as_deref(),
        body.markdown.as_deref(),
        body.title.as_deref(),
    )
    .await;
    let mut page = mutate(&headers, published).await?;
    // Needs input markers that went out with the text (the publish dialog warned about them first)
    let markers = NEEDS_INPUT.find_iter(page["markdown"].as_str().unwrap_or("")).count();
    page.insert("needs_input_markers".into(), json!(markers));
    if body.notify {
        announce(&page, body.note.as_deref()).await;
    }
    Ok(obj(page))
}

/// List a page's versions.
async fn get_versions(headers: HeaderMap, Path(page_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    Ok(Json(Value::Array(done(&headers, docs::list_versions(&session, &page_id).await)?)))
}

/// A path value that must be an integer: FastAPI's 422 names the parameter (`["path", name]`).
fn int_path(name: &str, text: &str) -> ApiResult<i64> {
    text.trim().parse::<i64>().map_err(|_| {
        ApiError::validation(
            &["path", name],
            "Input should be a valid integer, unable to parse string as an integer",
            "int_parsing",
        )
    })
}

/// Get one version of a page.
async fn get_version(headers: HeaderMap, Path((page_id, version)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let version = int_path("version", &version)?;
    let session = kb_db::session();
    Ok(obj(done(&headers, docs::get_version(&session, &page_id, version).await)?))
}

/// Diff two versions of a page.
async fn get_diff(headers: HeaderMap, Path((page_id, a, b)): Path<(String, String, String)>) -> ApiResult<Json<Value>> {
    // `/versions/{a}/diff/{b}` in Python; axum wants one name per position, so the first is `{version}` in the path
    let (a, b) = (int_path("a", &a)?, int_path("b", &b)?);
    let session = kb_db::session();
    Ok(obj(done(&headers, docs::diff_versions(&session, &page_id, a, b).await)?))
}

/// Restore an old version as a new one.
async fn post_restore_version(
    headers: HeaderMap,
    Path((page_id, version)): Path<(String, String)>,
    Body(body): Body<RestoreBody>,
) -> ApiResult<Json<Value>> {
    let version = int_path("version", &version)?;
    let session = kb_db::session();
    let restored = docs::restore_version(&session, &page_id, version, body.note.as_deref()).await;
    let page = mutate(&headers, restored).await?;
    if body.notify {
        let note = body.note.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| format!("Restored from v{version}"));
        announce(&page, Some(&note)).await;
    }
    Ok(obj(page))
}

/// List the pages and tickets that reference a page.
async fn get_backlinks(headers: HeaderMap, Path(page_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    Ok(obj(done(&headers, docs::backlinks(&session, &page_id).await)?))
}

/// The tickets tied to a page and what the AI on each is doing now (#268).
async fn get_page_work(headers: HeaderMap, Path(page_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    done(&headers, docs::get_page(&session, &page_id, false, false).await)?;
    Ok(obj(done(&headers, docs_work::work_on_page(&session, &page_id).await)?))
}

/// Give a page to an AI member to write or review: a linked ticket assigned to it, and its run (#268).
async fn post_page_assign(
    headers: HeaderMap,
    Path(page_id): Path<String>,
    Body(body): Body<AssignPageBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    let assigned =
        docs_work::assign_page(&session, &page_id, &body.member_id, &body.kind, body.instruction.as_deref(), None)
            .await;
    let out = match assigned {
        // `except ValueError as exc: raise HTTPException(status_code=422, detail=str(exc))`
        Err(crate::Error::Value(message)) => return Err(ApiError::unprocessable(message)),
        other => done(&headers, other)?,
    };
    events::publish("invalidate", &[]).await;
    Ok((StatusCode::CREATED, obj(out)))
}

/// List the pages a ticket references or is linked to.
async fn get_ticket_docs(headers: HeaderMap, Path(ticket_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let rows = done(&headers, docs::docs_for_ticket(&session, &ticket_id).await)?;
    Ok(Json(Value::Array(rows.into_iter().map(Value::Object).collect())))
}

/// Link a ticket to a page.
async fn post_ticket_doc(
    headers: HeaderMap,
    Path(ticket_id): Path<String>,
    Body(body): Body<TicketDocBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    let result = done(&headers, docs::link_ticket_doc(&session, &ticket_id, &body.page_id).await)?;
    events::publish("invalidate", &[]).await;
    Ok((StatusCode::CREATED, obj(result)))
}

/// Unlink a ticket from a page.
async fn delete_ticket_doc(
    headers: HeaderMap,
    Path((ticket_id, page_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let result = done(&headers, docs::unlink_ticket_doc(&session, &ticket_id, &page_id).await)?;
    events::publish("invalidate", &[]).await;
    Ok(obj(result))
}

// --- comments -------------------------------------------------------------------

/// `_deliver_ai`: deliver the AI members mentioned in the comment just saved (Docs AI); the thread comes back with
/// `ai_delivery` and any note an AI member posted.
async fn deliver_ai(
    session: &kb_db::Session,
    out: Map<String, Value>,
    intent: Option<&str>,
) -> crate::Result<Map<String, Value>> {
    if !out.get("comments").is_some_and(pyjson::truthy) {
        return Ok(out);
    }
    let intent = match intent {
        Some("work") | Some("suggest") | Some("") | None => "ask",
        Some(other) => other,
    };
    let delivered = docs_comments::docs_ai::deliver(session, &out, &kb_base::activity::current_actor(), intent).await?;
    let mut out = out;
    if delivered.iter().any(|d| d["result"] == "job") {
        let id = out.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        out = docs_comments::get_thread(session, &id).await?;
    }
    out.insert("ai_delivery".into(), Value::Array(delivered));
    Ok(out)
}

/// List a page's comment threads (inline and page), with counts and your role.
async fn get_comments(
    headers: HeaderMap,
    Path(page_id): Path<String>,
    RawQuery(query): RawQuery,
) -> ApiResult<Json<Value>> {
    let pairs = query_pairs(query.as_deref());
    let state = query_str(&pairs, "state", "all");
    let kind = query_opt(&pairs, "kind");
    let session = kb_db::session();
    Ok(obj(done(&headers, docs_comments::list_comments(&session, &page_id, &state, kind.as_deref()).await)?))
}

/// Start a thread: an inline comment on selected text or a page comment.
async fn post_thread(
    headers: HeaderMap,
    Path(page_id): Path<String>,
    Body(body): Body<ThreadCreate>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    let out = done(
        &headers,
        docs_comments::create_thread(&session, &page_id, &body.kind, &body.body, body.anchor.as_ref(), None).await,
    )?;
    events::publish("invalidate", &[]).await;
    let out = done(&headers, deliver_ai(&session, out, body.ai_intent.as_deref()).await)?;
    Ok((StatusCode::CREATED, obj(out)))
}

/// Say which open inline comments would be orphaned by publishing this Markdown.
async fn post_anchor_preview(
    headers: HeaderMap,
    Path(page_id): Path<String>,
    Body(body): Body<AnchorPreviewBody>,
) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    Ok(obj(done(&headers, docs_comments::anchor_preview(&session, &page_id, &body.markdown).await)?))
}

/// Reply in a thread.
async fn post_reply(
    headers: HeaderMap,
    Path(thread_id): Path<String>,
    Body(body): Body<CommentBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    let out = done(&headers, docs_comments::add_reply(&session, &thread_id, &body.body, None).await)?;
    events::publish("invalidate", &[]).await;
    let out = done(&headers, deliver_ai(&session, out, body.ai_intent.as_deref()).await)?;
    Ok((StatusCode::CREATED, obj(out)))
}

/// Resolve a thread.
async fn post_resolve_thread(headers: HeaderMap, Path(thread_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let out = done(&headers, docs_comments::set_status(&session, &thread_id, "resolved").await)?;
    events::publish("invalidate", &[]).await;
    Ok(obj(out))
}

/// Reopen a resolved thread.
async fn post_reopen(headers: HeaderMap, Path(thread_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let out = done(&headers, docs_comments::set_status(&session, &thread_id, "open").await)?;
    events::publish("invalidate", &[]).await;
    Ok(obj(out))
}

/// Attach a thread (typically an orphaned one) to a new selection.
async fn post_reattach(
    headers: HeaderMap,
    Path(thread_id): Path<String>,
    Body(body): Body<AnchorBody>,
) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let out = done(&headers, docs_comments::reattach(&session, &thread_id, &body).await)?;
    events::publish("invalidate", &[]).await;
    Ok(obj(out))
}

/// Mark a thread as read by you.
async fn post_read(headers: HeaderMap, Path(thread_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    Ok(obj(done(&headers, docs_comments::mark_read(&session, &thread_id).await)?))
}

/// Edit your own comment.
async fn patch_comment(
    headers: HeaderMap,
    Path(comment_id): Path<String>,
    Body(body): Body<CommentBody>,
) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let out = done(&headers, docs_comments::edit_comment(&session, &comment_id, &body.body).await)?;
    events::publish("invalidate", &[]).await;
    Ok(obj(out))
}

/// Delete a comment (the first comment of a thread removes the whole thread).
async fn del_comment(headers: HeaderMap, Path(comment_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let out = done(&headers, docs_comments::delete_comment(&session, &comment_id).await)?;
    events::publish("invalidate", &[]).await;
    Ok(obj(out))
}

/// Comment Activity for a project; `recipient` keeps only the events that notify that person.
async fn get_comment_events(
    headers: HeaderMap,
    Path(project_id): Path<String>,
    RawQuery(query): RawQuery,
) -> ApiResult<Json<Value>> {
    let pairs = query_pairs(query.as_deref());
    let recipient = query_opt(&pairs, "recipient");
    let limit = query_int(&pairs, "limit", 50)?;
    let session = kb_db::session();
    Ok(Json(Value::Array(done(
        &headers,
        docs_comments::list_events(&session, &project_id, recipient.as_deref(), limit).await,
    )?)))
}

/// What the caller may do in the Docs space: access, role, can_edit, policy, admins.
async fn get_docs_access(headers: HeaderMap, Path(project_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let Some(project) = project_table::Entity::find_by_id(project_id.as_str()).one(&session).await? else {
        return Err(docs_error(
            &headers,
            kb_doctext::docs_text::DocsError::new(404, "project_not_found", "Project not found").into(),
        ));
    };
    if !project.docs_enabled {
        return Err(docs_error(
            &headers,
            kb_doctext::docs_text::DocsError::new(403, "docs_disabled", "Docs are turned off for this project").into(),
        ));
    }
    Ok(obj(docs_access::access_of(&session, &project).await?))
}

/// Ask the project's admins for access to Docs (notifies them).
async fn post_access_request(
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Body(body): Body<AccessRequestBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    let Some(project) = project_table::Entity::find_by_id(project_id.as_str()).one(&session).await? else {
        return Err(docs_error(
            &headers,
            kb_doctext::docs_text::DocsError::new(404, "project_not_found", "Project not found").into(),
        ));
    };
    let result = docs_access::request_access(&session, &project, &body.note).await?;
    if result.get("sent").and_then(Value::as_bool) == Some(true) {
        events::publish("invalidate", &[]).await;
    }
    Ok((StatusCode::CREATED, obj(result)))
}

// --- send to AI (the Docs AI's hand-off) --------------------------------------------

/// What the routes that call the Docs AI answer when it fails: an `ApiError`, or the answer of an exception with a
/// handler of its own in the app (`DocsAiError`, `AssistError`: `{detail, code, ...}`).
pub enum Failure {
    /// `HTTPException`, `DocsError` and the like.
    Api(ApiError),
    /// A status and the whole body.
    Json(u16, Value),
}

impl From<ApiError> for Failure {
    fn from(err: ApiError) -> Self {
        Failure::Api(err)
    }
}

impl axum::response::IntoResponse for Failure {
    fn into_response(self) -> axum::response::Response {
        match self {
            Failure::Api(err) => err.into_response(),
            Failure::Json(status, body) => {
                (StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), Json(body)).into_response()
            }
        }
    }
}

/// A result of the Docs AI hook as the route answers it.
fn hooked<T>(headers: &HeaderMap, result: crate::Result<T>) -> Result<T, Failure> {
    result.map_err(|err| match err {
        crate::Error::Json { status, body } => Failure::Json(status, body),
        other => Failure::Api(docs_error(headers, other)),
    })
}

/// The Docs AI, or the failure of a server that has none.
fn docs_ai_hook() -> Result<&'static dyn crate::hooks::DocsAiHook, Failure> {
    crate::hooks::docs_ai().ok_or_else(|| Failure::Api(ApiError::internal("the Docs AI is not registered")))
}

/// Who can receive the page's open threads: tickets by how they relate to the page and to each thread, every other
/// ticket, the project's AI teams, and whether the Board AI and the page's assistant can answer.
async fn get_send_to_ai(headers: HeaderMap, Path(page_id): Path<String>) -> Result<Json<Value>, Failure> {
    let hook = docs_ai_hook()?;
    let session = kb_db::session();
    Ok(obj(hooked(&headers, hook.send_to_ai_targets(&session, &page_id).await)?))
}

/// Send open threads to the team of a ticket, to the Board AI (it routes) or to the page's assistant.
async fn post_send_to_ai(
    headers: HeaderMap,
    Path(page_id): Path<String>,
    Body(body): Body<SendToAiBody>,
) -> Result<(StatusCode, Json<Value>), Failure> {
    let hook = docs_ai_hook()?;
    let session = kb_db::session();
    let out = hooked(
        &headers,
        hook.send_to_ai(
            &session,
            &page_id,
            &body.thread_ids,
            &body.to,
            body.ticket_id.as_deref(),
            body.give_team_id.as_deref(),
        )
        .await,
    )?;
    events::publish("invalidate", &[]).await;
    Ok((StatusCode::ACCEPTED, obj(out)))
}

/// The open comment threads of the pages linked to a ticket: what "Ask the team to apply the comments" sends.
async fn get_ticket_doc_comments(headers: HeaderMap, Path(ticket_id): Path<String>) -> Result<Json<Value>, Failure> {
    let hook = docs_ai_hook()?;
    let session = kb_db::session();
    Ok(obj(hooked(&headers, hook.ticket_doc_comments(&session, &ticket_id).await)?))
}

/// Send the open threads of the ticket's linked pages to the ticket's own team.
async fn post_ticket_doc_comments_send(
    headers: HeaderMap,
    Path(ticket_id): Path<String>,
    Body(body): Body<SendCommentsBody>,
) -> Result<(StatusCode, Json<Value>), Failure> {
    let hook = docs_ai_hook()?;
    let session = kb_db::session();
    let out = hooked(&headers, hook.send_ticket_doc_comments(&session, &ticket_id, body.give_team_id.as_deref()).await)?;
    events::publish("invalidate", &[]).await;
    Ok((StatusCode::ACCEPTED, obj(out)))
}
