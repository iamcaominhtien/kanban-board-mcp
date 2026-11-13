//! `api/canvases.py`, the comments section: who the `@` picker offers, the threads, replies, resolve / reopen, and
//! editing and deleting a comment. A comment that mentions an AI team is delivered to it after it is saved
//! (`canvas_delivery`); the answer says what happened to each team.

use axum::Json;
use axum::extract::RawQuery;
use axum::http::{HeaderMap, StatusCode};
use kb_base::error::{Body, Path};
use kb_base::{ApiResult, Routes, activity};
use serde::Deserialize;
use serde_json::{Map, Value};

use super::{Reply, changed, json, list};
use crate::api::{docs_error, query_pairs};
use crate::canvases::rows::{get_row, member_role};
use crate::{canvas_comments as comments, canvas_delivery};

/// The routes of this section, in the order of the Python file.
pub fn routes() -> Routes {
    Routes::new()
        .get("/canvases/{canvas_id}/members", get_mentionable)
        .get("/canvases/{canvas_id}/threads", get_threads)
        .post("/canvases/{canvas_id}/threads", post_thread)
        .post("/canvases/threads/{thread_id}/replies", post_reply)
        .post("/canvases/threads/{thread_id}/resolve", post_resolve)
        .post("/canvases/threads/{thread_id}/reopen", post_reopen)
        .add("PATCH", "/canvases/comments/{comment_id}", axum::routing::patch(patch_comment))
        .add("DELETE", "/canvases/comments/{comment_id}", axum::routing::delete(del_comment))
}

/// Who the `@` picker of this canvas offers: the project's people, and its AI teams with whether each can be asked on
/// this canvas now.
async fn get_mentionable(headers: HeaderMap, Path(canvas_id): Path<String>) -> Reply {
    let session = kb_db::session();
    let canvas = get_row(&session, &canvas_id, false).await.map_err(|e| docs_error(&headers, e))?;
    member_role(&session, &canvas).await.map_err(|e| docs_error(&headers, e))?;
    Ok(list(canvas_delivery::mentionable(&session, &canvas).await.map_err(|e| docs_error(&headers, e))?))
}

/// Comment threads in pin order.
async fn get_threads(headers: HeaderMap, Path(canvas_id): Path<String>, RawQuery(query): RawQuery) -> Reply {
    let pairs = query_pairs(query.as_deref());
    let state = crate::api::query_str(&pairs, "state", "");
    let present = pairs.iter().any(|(n, _)| n == "state");
    let session = kb_db::session();
    Ok(list(
        comments::list_threads(&session, &canvas_id, present.then_some(state.as_str()))
            .await
            .map_err(|e| docs_error(&headers, e))?,
    ))
}

/// A new pin with its first comment.
#[derive(Debug, Deserialize)]
struct NewThread {
    body: String,
    #[serde(default)]
    board_id: Option<String>,
    #[serde(default = "half")]
    x: f64,
    #[serde(default = "half")]
    y: f64,
    #[serde(default)]
    page: Option<String>,
    #[serde(default)]
    anchor: Option<Map<String, Value>>,
}

fn half() -> f64 {
    0.5
}

/// Pin a comment to a frame (0..1 inside it) or to the plane.
async fn post_thread(
    headers: HeaderMap,
    Path(canvas_id): Path<String>,
    Body(body): Body<NewThread>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    let anchor = body.anchor.map(Value::Object);
    let mut out = comments::add_thread(
        &session,
        &canvas_id,
        comments::NewThread {
            body: &body.body,
            board_id: body.board_id.as_deref(),
            x: body.x,
            y: body.y,
            page: body.page.as_deref(),
            anchor: anchor.as_ref(),
            ai: None,
        },
    )
    .await
    .map_err(|e| docs_error(&headers, e))?;
    changed().await;
    let deliveries = deliver(&canvas_id, &out).await;
    out.insert("deliveries".into(), deliveries);
    Ok((StatusCode::CREATED, json(out)))
}

/// Give the comment just saved to the AI teams it mentions (see `canvas_delivery`). A failure of a team's delivery is
/// answered as "not delivered" inside `deliver`; any other failure here is logged and gives no line, never a failed
/// comment: the comment is already saved.
async fn deliver(canvas_id: &str, thread: &Map<String, Value>) -> Value {
    let session = kb_db::session();
    let result = async {
        let canvas = get_row(&session, canvas_id, false).await?;
        canvas_delivery::deliver(&session, &canvas, thread, &activity::current_actor()).await
    }
    .await;
    match result {
        Ok(lines) => Value::Array(lines.into_iter().map(Value::Object).collect()),
        Err(e) => {
            tracing::error!("Could not deliver a canvas comment to an AI team: {e}");
            Value::Array(Vec::new())
        }
    }
}

/// Comment text. `@[Name](member:id)` (what the picker writes) or a typed `@Name` mentions a person of the project: the
/// comment keeps their ids and each of them gets a Needs you notification that opens the canvas.
#[derive(Debug, Deserialize)]
struct CommentBody {
    body: String,
}

/// Reply in a thread.
async fn post_reply(
    headers: HeaderMap,
    Path(thread_id): Path<String>,
    Body(body): Body<CommentBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    let mut out = comments::reply(&session, &thread_id, &body.body, None).await.map_err(|e| docs_error(&headers, e))?;
    changed().await;
    let canvas_id = out.get("canvas_id").and_then(Value::as_str).unwrap_or_default().to_string();
    let deliveries = deliver(&canvas_id, &out).await;
    out.insert("deliveries".into(), deliveries);
    Ok((StatusCode::CREATED, json(out)))
}

/// Resolve a thread.
async fn post_resolve(headers: HeaderMap, Path(thread_id): Path<String>) -> Reply {
    let session = kb_db::session();
    let out = comments::set_status(&session, &thread_id, "resolved").await.map_err(|e| docs_error(&headers, e))?;
    changed().await;
    Ok(json(out))
}

/// Reopen a thread.
async fn post_reopen(headers: HeaderMap, Path(thread_id): Path<String>) -> Reply {
    let session = kb_db::session();
    let out = comments::set_status(&session, &thread_id, "open").await.map_err(|e| docs_error(&headers, e))?;
    changed().await;
    Ok(json(out))
}

/// Edit your own comment.
async fn patch_comment(headers: HeaderMap, Path(comment_id): Path<String>, Body(body): Body<CommentBody>) -> Reply {
    let session = kb_db::session();
    Ok(json(comments::edit_comment(&session, &comment_id, &body.body).await.map_err(|e| docs_error(&headers, e))?))
}

/// Delete your own comment.
async fn del_comment(headers: HeaderMap, Path(comment_id): Path<String>) -> Reply {
    let session = kb_db::session();
    let out = comments::delete_comment(&session, &comment_id).await.map_err(|e| docs_error(&headers, e))?;
    changed().await;
    Ok(json(out))
}
