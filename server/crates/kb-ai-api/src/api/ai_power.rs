//! `api/ai_power.py`: the computer's sleep: how many runs need the machine awake, and the check after it woke
//! (`services/ai/power.py`).

use axum::Json;
use kb_ai::power as svc_power;
use kb_base::{ApiResult, Routes};
use serde_json::{Map, Value, json};

/// The routes of this file.
pub fn routes() -> Routes {
    Routes::new().get("/ai/power", get_power).post("/ai/power/wake", post_wake)
}

/// How many AI runs are queued, starting or running (the desktop app keeps the computer awake while > 0).
async fn get_power() -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    Ok(Json(json!({"active": svc_power::active_runs(&session).await?})))
}

/// The computer woke up: look at every run the board thinks is running.
async fn post_wake() -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    Ok(Json(svc_power::after_wake(&session).await?))
}
