//! The stored scans: reading them back and scanning again when the repository changed (`repo_scan.py` lines
//! 1468-1567: `latest`, `to_api`, `rescan_if_changed`, `sweep`, `_job_view`, `to_dict`).

use std::path::PathBuf;

use kb_ai::store;
use kb_base::{pyjson, pypath, time};
use kb_db::Session;
use kb_db::entities::ai_repo_scan;
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Map, Value, json};

use crate::Error;
use crate::detect::fingerprint;
use crate::job::{ai_status, loads_object, running};
use crate::run::{ScanOptions, run_scan};

/// The newest scan of the project that was not applied, from the last day (the wizard picks it up again).
pub async fn latest(session: &Session, project_id: &str) -> Result<Option<ai_repo_scan::Model>, Error> {
    let since = time::iso(&(chrono::Utc::now() - chrono::Duration::days(1)));
    Ok(ai_repo_scan::Entity::find()
        .filter(ai_repo_scan::Column::ProjectId.eq(project_id))
        .filter(ai_repo_scan::Column::AppliedAt.is_null())
        .filter(ai_repo_scan::Column::CreatedAt.gte(since))
        .order_by_desc(ai_repo_scan::Column::CreatedAt)
        .one(session)
        .await?)
}

/// A scan for the API, with whether the AI can run and a job a restart left behind marked as stopped.
pub async fn to_api(session: &Session, row: &ai_repo_scan::Model) -> Result<Value, Error> {
    let mut out = to_dict(row);
    if let Some(Value::Object(job)) = out.get_mut("job") {
        if job.get("state").and_then(Value::as_str) == Some("running") && !running(&row.id) {
            job.insert("state".into(), json!("failed"));
            job.insert("error".into(), json!("The app restarted while it ran. Run it again."));
        }
    }
    let status = ai_status(session, false).await?;
    if let Value::Object(map) = &mut out {
        map.insert("ai_available".into(), status.get("available").cloned().unwrap_or(Value::Null));
        map.insert("ai_unavailable_why".into(), status.get("why").cloned().unwrap_or(Value::Null));
    }
    Ok(out)
}

/// Scan again when the files the last scan read have changed. Never applies anything: the new scan waits for a
/// person. Returns whether it scanned.
pub async fn rescan_if_changed(session: &Session, project_id: &str) -> Result<bool, Error> {
    let last = ai_repo_scan::Entity::find()
        .filter(ai_repo_scan::Column::ProjectId.eq(project_id))
        .order_by_desc(ai_repo_scan::Column::CreatedAt)
        .one(session)
        .await?;
    let Some(last) = last else { return Ok(false) };
    let root = PathBuf::from(pypath::expanduser(&last.folder));
    if !root.is_dir() {
        return Ok(false);
    }
    let before = loads_object(&last.found).get("fingerprint").cloned();
    let now = tokio::task::spawn_blocking(move || fingerprint(&root)).await.map_err(|e| Error::Other(e.to_string()))?;
    if before == Some(Value::String(now)) {
        return Ok(false);
    }
    run_scan(session, project_id, &last.folder, ScanOptions { trial: false, ..ScanOptions::default() }).await?;
    Ok(true)
}

/// One pass over every project that has a scan: scan again where the repository changed. The caller runs it now and
/// then (`main.py`'s `_rescan_loop`, every 30 minutes): `sweep(kb_db::database::session).await`. Returns the projects it
/// scanned again; one project that fails never stops the others.
pub async fn sweep<F>(session_factory: F) -> Result<Vec<String>, Error>
where
    F: Fn() -> Session,
{
    let ids: Vec<String> = {
        let session = session_factory();
        ai_repo_scan::Entity::find()
            .select_only()
            .column(ai_repo_scan::Column::ProjectId)
            .distinct()
            .into_tuple::<String>()
            .all(&session)
            .await?
    };
    let mut done: Vec<String> = Vec::new();
    for pid in ids {
        let session = session_factory();
        match rescan_if_changed(&session, &pid).await {
            Ok(true) => done.push(pid),
            Ok(false) => {}
            Err(e) => tracing::warn!("repo scan: rescan of {pid} failed: {e}"),
        }
    }
    Ok(done)
}

/// `_job_view`: the job column with the seconds it has run (or ran).
pub fn job_view(raw: &str) -> Value {
    let mut job = match loads_object(raw) {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    if job.get("started_at").is_some_and(pyjson::truthy) {
        let at = |key: &str| job.get(key).and_then(Value::as_str).and_then(|t| store::parse_iso(Some(t)));
        let start = at("started_at");
        let end = if job.get("ended_at").is_some_and(pyjson::truthy) {
            at("ended_at")
        } else {
            Some(chrono::Utc::now().fixed_offset())
        };
        let elapsed = match (start, end) {
            (Some(start), Some(end)) => (end - start).num_seconds(),
            _ => 0,
        };
        job.insert("elapsed_s".into(), json!(elapsed));
    }
    Value::Object(job)
}

/// A scan for the API.
pub fn to_dict(row: &ai_repo_scan::Model) -> Value {
    json!({
        "id": row.id,
        "project_id": row.project_id,
        "folder": row.folder,
        "found": loads_object(&row.found),
        "suggested": loads_object(&row.suggested),
        "trial": loads_object(&row.trial),
        "job": job_view(&row.job),
        "proposal": loads_object(&row.proposal),
        "base_path": std::env::var("PATH").unwrap_or_default(),
        "applied_at": row.applied_at,
        "created_at": row.created_at,
    })
}
