//! `api/docs_ai/threads.py`: the assistant in Docs comment threads: the summary of a long thread. In AI v2 the
//! assistant edits when asked and the page's history undoes it.

use axum::Json;
use axum::http::{HeaderMap, StatusCode};
use kb_base::Routes;
use kb_base::error::Path;
use serde_json::Value;

use crate::api::{Res, by, docs_ai_failure};
use crate::assistant::docs as svc;
use crate::docs_ai::jobs;

/// The routes of this file.
pub fn routes() -> Routes {
    Routes::new().post("/docs/ai/threads/{thread_id}/summary", summarise)
}

/// Summarise a long thread (shown above the replies; it does not resolve the thread).
async fn summarise(headers: HeaderMap, Path(thread_id): Path<String>) -> Res<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    let job = svc::start_thread_job(&session, &thread_id, "thread_summary", &by(), "Summarise this thread")
        .await
        .map_err(|e| docs_ai_failure(&headers, e))?;
    Ok((StatusCode::ACCEPTED, Json(Value::Object(jobs::to_dict(&job)))))
}
