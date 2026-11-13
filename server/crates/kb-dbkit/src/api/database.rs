//! `api/database.py`: App settings › Storage & backup › Database (design/screens/ai-databases.md B to E): which
//! database the board uses, a test of another one, and the move to it (check, copy, verify, switch), with an AI's
//! help when a copy stops.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use kb_base::error::{Body, OptionalBody, Query};
use kb_base::{ApiError, ApiResult, Routes, time};
use kb_db::database::{self, DatabaseError};
use kb_db::schema;
use kb_db::targets::{self, Target};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::jobs::{self, Failure, Job, JobError};
use crate::move_db::raw::{self, Sea};
use crate::move_db::{self, clean_any};
use crate::probe;

/// A database to test or move to: the form's fields, or a connection string in `url`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ConnectionBody {
    #[serde(default)]
    pub engine: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<i64>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub ssl: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    /// Use the saved password of the database in use (Edit connection without typing it again).
    #[serde(default)]
    pub keep_password: bool,
}

fn target_of(body: &ConnectionBody) -> ApiResult<Target> {
    // `body.model_dump(exclude_none=True)`
    let mut data = Map::new();
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            data.insert(key.to_string(), value);
        }
    };
    put("engine", body.engine.clone().map(Value::from));
    put("host", body.host.clone().map(Value::from));
    put("port", body.port.map(Value::from));
    put("name", body.name.clone().map(Value::from));
    put("user", body.user.clone().map(Value::from));
    put("password", body.password.clone().map(Value::from));
    put("ssl", body.ssl.clone().map(Value::from));
    put("path", body.path.clone().map(Value::from));
    put("url", body.url.clone().map(Value::from));
    put("keep_password", Some(Value::Bool(body.keep_password)));
    if body.engine.as_deref() == Some("sqlite") && body.path.as_deref().is_none_or(str::is_empty) {
        // the file in the data folder
        data.insert("path".into(), json!(database::get_db_path().to_string_lossy()));
    }
    let mut target = targets::from_fields(&data).map_err(|exc| ApiError::unprocessable(exc.0))?;
    if body.keep_password && target.password.as_deref().is_none_or(str::is_empty) {
        let current = database::current_target();
        target = target.with_password(current.password);
    }
    Ok(target)
}

/// `_raise(exc)`: a step that cannot be taken now, as the API answers it.
fn raise(exc: JobError) -> ApiError {
    let mut detail = Map::new();
    detail.insert("code".into(), json!(exc.code));
    detail.insert("message".into(), json!(exc.message));
    for (key, value) in exc.info {
        detail.insert(key, value);
    }
    ApiError::code(exc.status, Value::Object(detail))
}

/// A failure of a step whose router only expects `JobError`: anything else is a 500.
fn raise_failure(exc: Failure) -> ApiError {
    match exc {
        Failure::Job(exc) => raise(exc),
        other => ApiError::internal(other),
    }
}

/// `SchemaError` is a 423 with its message; anything else is a 500.
fn locked(exc: DatabaseError) -> ApiError {
    match exc {
        DatabaseError::Schema(exc) => ApiError::code(423, exc.message),
        other => ApiError::internal(other),
    }
}

async fn counts() -> ApiResult<Map<String, Value>> {
    let conn = kb_db::conn();
    let mut out = Map::new();
    for (key, table) in [("tickets", "ticket"), ("projects", "project"), ("ai_members", "ai_team")] {
        out.insert(key.into(), json!(raw::count(&mut Sea(&conn), table).await?));
    }
    Ok(out)
}

/// The routes of this file.
pub fn routes() -> Routes {
    Routes::new()
        .get("/database", get_database)
        .get("/database/health", get_health)
        .post("/database/test", post_test)
        .post("/database/connection", post_connection)
        .post("/database/use-sqlite", post_use_sqlite)
        .get("/database/move", get_move)
        .post("/database/move/check", post_check)
        .post("/database/move/start", post_start)
        .post("/database/move/pause", post_pause)
        .post("/database/move/resume", post_resume)
        .post("/database/move/cancel", post_cancel)
        .post("/database/move/ask", post_ask)
        .post("/database/move/apply", post_apply)
        .post("/database/move/switch", post_switch)
        .delete("/database/move", delete_move)
        .get("/database/command", get_command)
}

/// The database in use: engine, where, how big, whether it answers, and what the card may offer.
async fn get_database() -> ApiResult<Json<Value>> {
    Ok(Json(Value::Object(database_info().await?)))
}

async fn database_info() -> ApiResult<Map<String, Value>> {
    let target = database::current_target();
    let sqlite_file = database::get_db_path();
    let stat = std::fs::metadata(&sqlite_file).ok();
    let modified = stat
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_secs_f64()));
    let mut info = Map::new();
    info.insert("engine".into(), json!(target.engine));
    info.insert("label".into(), json!(target.label()));
    info.insert("display".into(), json!(target.display()));
    info.insert("settings".into(), Value::Object(target.public()));
    info.insert("source".into(), json!(database::target_source()));
    info.insert("locked".into(), json!(database::target_source() == "environment"));
    info.insert("env_var".into(), json!(targets::ENV_URL));
    info.insert("password_store".into(), json!(targets::password_store()));
    info.insert("password_saved".into(), json!(target.password.as_deref().is_some_and(|p| !p.is_empty())));
    info.insert("data_folder".into(), json!(database::get_data_dir().to_string_lossy()));
    info.insert(
        "sqlite_file".into(),
        json!({
            "path": sqlite_file.to_string_lossy(),
            "exists": stat.is_some(),
            "size": stat.as_ref().map(std::fs::Metadata::len),
            "modified": modified,
        }),
    );
    info.insert("unreachable".into(), json!(database::unreachable()));
    if database::unreachable().is_none() {
        let reach = database::check_reachable(Duration::from_secs(5)).await;
        info.insert("reachable".into(), reach["ok"].clone());
        info.insert("latency_ms".into(), reach.get("latency_ms").cloned().unwrap_or(Value::Null));
        if reach["ok"] == json!(true) {
            info.extend(counts().await?);
            info.extend(revision().await);
            // the card still shows the rest
            let tables = table_names().await.ok().map(|names| {
                names
                    .iter()
                    .filter(|t| !matches!(t.as_str(), "alembic_version" | "kanban_change") && !t.contains("_fts"))
                    .count()
            });
            info.insert("tables".into(), json!(tables));
            if target.is_sqlite() {
                if let Some(stat) = &stat {
                    info.insert("size".into(), json!(stat.len() + wal_size(&sqlite_file)));
                }
            }
            if !target.is_sqlite() {
                let report = probe::test(&target).await?;
                info.insert("version".into(), json!(report.version));
                info.insert("secure".into(), json!(report.secure));
                info.insert("other_apps".into(), json!(report.other_apps));
            } else {
                info.insert("version".into(), json!(format!("SQLite {}", probe::sqlite_version().await)));
            }
        }
        info.insert("unreachable".into(), json!(database::unreachable()));
    } else {
        info.insert("reachable".into(), json!(false));
    }
    let job = jobs::current().await;
    info.insert("move".into(), job.map(|job| job.as_dict()).unwrap_or(Value::Null));
    Ok(info)
}

async fn revision() -> Map<String, Value> {
    let mut out = Map::new();
    // the card still shows the rest
    match schema::schema_state(&kb_db::conn()).await {
        Ok(state) => {
            out.insert("revision".into(), json!(state.revision));
            out.insert("at_head".into(), json!(state.revision.as_deref() == Some(schema::head_revision())));
        }
        Err(_) => {
            out.insert("revision".into(), Value::Null);
            out.insert("at_head".into(), Value::Null);
        }
    }
    out
}

fn wal_size(path: &Path) -> u64 {
    std::fs::metadata(format!("{}-wal", path.to_string_lossy())).map(|m| m.len()).unwrap_or(0)
}

async fn table_names() -> Result<Vec<String>, kb_db::sea_orm::DbErr> {
    raw::table_names(&mut Sea(&kb_db::conn())).await
}

/// Does the database answer now? (The reconnect screen asks every few seconds.)
async fn get_health() -> Json<Value> {
    let reach = database::check_reachable(Duration::from_secs(5)).await;
    if reach["ok"] == json!(true) && database::unreachable().is_none() {
        // it answered; init problems show elsewhere
        let _ = database::init_db().await;
    }
    let mut out = reach.as_object().cloned().unwrap_or_default();
    out.insert("unreachable".into(), json!(database::unreachable()));
    out.insert("retry_s".into(), json!(database::RETRY_S));
    Json(Value::Object(out))
}

/// Test a database: what the test found, line by line (nothing is changed).
async fn post_test(Body(body): Body<ConnectionBody>) -> ApiResult<Json<Value>> {
    let report = probe::test(&target_of(&body)?).await?;
    Ok(Json(Value::Object(report.as_dict())))
}

/// Edit connection: the same server database reached another way (a new password, host or SSL setting). It must
/// hold this board; the data is not copied.
async fn post_connection(Body(body): Body<ConnectionBody>) -> ApiResult<Json<Value>> {
    let target = target_of(&body)?;
    let report = probe::test(&target).await?;
    if !report.ok() || report.state != "board" {
        return Err(ApiError::unprocessable(json!({
            "code": "not_this_board",
            "message": "That database does not hold this board; use Move to another database to copy it.",
            "report": report.as_dict(),
        })));
    }
    database::use_target(&target).await.map_err(locked)?;
    get_database().await
}

/// Use the SQLite file in the data folder again, as it was when the board left it.
async fn post_use_sqlite() -> ApiResult<Json<Value>> {
    let path = database::get_db_path();
    if !path.exists() {
        return Err(ApiError::not_found("There is no SQLite file in the data folder."));
    }
    database::use_target(&Target::sqlite(path.to_string_lossy().into_owned())).await.map_err(locked)?;
    get_database().await
}

// ---------------------------------------------------------------------------
// The move
// ---------------------------------------------------------------------------

/// The move in progress (or one an interruption left).
async fn get_move() -> Json<Value> {
    Json(jobs::current().await.map(|job| job.as_dict()).unwrap_or(Value::Null))
}

/// Step 2: test the target again and read what will be copied. Nothing is written.
async fn post_check(Body(body): Body<ConnectionBody>) -> ApiResult<Json<Value>> {
    let target = target_of(&body)?;
    let job = jobs::new(target).await.map_err(raise)?;
    match job.check().await {
        Ok(found) => Ok(Json(found)),
        Err(Failure::Job(exc)) => Err(raise(exc)),
        // a MoveError or a database error, said plainly
        Err(Failure::Move(move_db::Error::Move(exc))) => {
            Err(ApiError::unprocessable(json!({"code": exc.code, "message": exc.message})))
        }
        Err(Failure::Move(exc)) => {
            let (message, _) = clean_any(&exc);
            Err(ApiError::unprocessable(json!({"code": "check", "message": message})))
        }
        Err(Failure::Assist(exc)) => Err(ApiError::unprocessable(json!({"code": "check", "message": exc.0}))),
    }
}

fn default_mode() -> String {
    "copy".into()
}

/// Copy my data, or start empty; `empty_first` deletes what the target holds (after typing its name).
#[derive(Debug, Clone, Deserialize)]
pub struct StartBody {
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default)]
    pub empty_first: bool,
    #[serde(default)]
    pub confirm: Option<String>,
}

/// Step 3: make the tables and copy (or leave the new database empty).
async fn post_start(Body(body): Body<StartBody>) -> ApiResult<Json<Value>> {
    let job = job().await?;
    if !matches!(body.mode.as_str(), "copy" | "empty") {
        return Err(ApiError::unprocessable("mode is copy or empty"));
    }
    if body.empty_first {
        let expected = if job.target.name.is_empty() {
            kb_files::pathlib::name(&job.target.path).to_string()
        } else {
            job.target.name.clone()
        };
        if kb_base::pytext::strip(body.confirm.as_deref().unwrap_or("")) != expected {
            return Err(ApiError::unprocessable(
                json!({"code": "confirm", "message": format!("Type {expected} to confirm.")}),
            ));
        }
    }
    job.start(&body.mode, body.empty_first).await.map_err(raise)?;
    Ok(Json(job.as_dict()))
}

async fn job() -> ApiResult<Arc<Job>> {
    match jobs::current().await {
        Some(job) => Ok(job),
        None => Err(ApiError::not_found(json!({"code": "none", "message": "No move is in progress."}))),
    }
}

/// Pause the copy at the next batch.
async fn post_pause() -> ApiResult<Json<Value>> {
    let job = job().await?;
    job.pause().await.map_err(raise)?;
    Ok(Json(job.as_dict()))
}

/// Resume from a table (default: the one it stopped in).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ResumeBody {
    #[serde(default)]
    pub start_at: Option<String>,
    #[serde(default)]
    pub restart: bool,
}

/// Resume the copy (re-reading the table it stopped in from its start), or start over.
async fn post_resume(OptionalBody(body): OptionalBody<ResumeBody>) -> ApiResult<Json<Value>> {
    let job = job().await?;
    let body = body.unwrap_or_default();
    if body.restart {
        let first = job.restart();
        job.resume(first).await.map_err(raise_failure)?;
    } else {
        job.resume(body.start_at).await.map_err(raise_failure)?;
    }
    Ok(Json(job.as_dict()))
}

/// Cancel and clear the new database; your data stays where it is.
async fn post_cancel() -> ApiResult<Json<Value>> {
    let job = job().await?;
    job.cancel().await;
    Ok(Json(job.as_dict()))
}

/// Ask the AI about the stop (a follow-up question is optional).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct AskBody {
    #[serde(default)]
    pub question: Option<String>,
}

/// Ask an AI member what stopped the copy and what to change (it answers in the background).
async fn post_ask(OptionalBody(body): OptionalBody<AskBody>) -> ApiResult<Json<Value>> {
    let job = job().await?;
    job.ask_ai(body.unwrap_or_default().question).await.map_err(raise)?;
    Ok(Json(job.as_dict()))
}

/// Statements to run on the new database (the AI's, or edited by the person).
#[derive(Debug, Clone, Deserialize)]
pub struct ApplyBody {
    pub statements: Vec<String>,
}

/// Apply the fix on the new database, resume the copy and check it again.
async fn post_apply(Body(body): Body<ApplyBody>) -> ApiResult<Json<Value>> {
    let job = job().await?;
    match job.apply(&body.statements).await {
        Ok(()) => Ok(Json(job.as_dict())),
        Err(Failure::Assist(exc)) => Err(ApiError::unprocessable(json!({"code": "refused", "message": exc.0}))),
        Err(other) => Err(raise_failure(other)),
    }
}

/// Switch the board to the new database now (no restart).
async fn post_switch() -> ApiResult<Json<Value>> {
    let job = job().await?;
    job.switch(false).await.map_err(raise)?;
    Ok(Json(json!({"move": job.as_dict(), "database": database_info().await?})))
}

/// Close a finished move (Keep SQLite, switch later).
async fn delete_move() -> ApiResult<Json<Value>> {
    jobs::forget().await.map_err(raise)?;
    Ok(Json(json!({"ok": true})))
}

/// The query of `GET /database/command`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct CommandQuery {
    #[serde(default)]
    pub target: Option<String>,
}

/// A word of a command line as a shell reads it back: as it is when it holds only safe characters, else quoted
/// (single quotes on Unix, as `shlex.quote` does; double quotes on Windows).
fn shell_word(word: &str) -> String {
    let safe = !word.is_empty()
        && word.chars().all(|c| c.is_ascii_alphanumeric() || "@%+=:,./-_".contains(c) || (cfg!(windows) && c == '\\'));
    if safe {
        word.to_string()
    } else if cfg!(windows) {
        format!("\"{word}\"")
    } else {
        format!("'{}'", word.replace('\'', "'\"'\"'"))
    }
}

/// The script that runs the same copy on a server (design D3), for the database in use as the source.
async fn get_command(Query(query): Query<CommandQuery>) -> Json<Value> {
    let src = database::current_target();
    let src_url = if src.is_sqlite() {
        format!("sqlite:///{}", src.path)
    } else {
        format!(
            "{}://{}@{}:{}/{}",
            src.engine,
            src.user,
            src.host,
            src.port.map(|p| p.to_string()).unwrap_or_else(|| "None".into()),
            src.name
        )
    };
    let to = query.target.filter(|t| !t.is_empty()).unwrap_or_else(|| "postgresql://USER@HOST:5432/DATABASE".into());
    // the program that is running, as a command: `kanban-server db ...` is the database command line
    let exe = format!("{} db", shell_word(&std::env::current_exe().unwrap_or_default().to_string_lossy()));
    Json(json!({
        "dry_run": format!("{exe} migrate --from {src_url} --to {to} --dry-run"),
        "run": format!("{exe} migrate --from {src_url} --to {to} --verify"),
        "password_env": targets::ENV_PASSWORD,
        "at": time::epoch(),
    }))
}
