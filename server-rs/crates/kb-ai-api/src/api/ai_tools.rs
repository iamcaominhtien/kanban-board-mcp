//! `api/ai_tools.py`: REST API of the AI team's tools (design/screens/ai-team-process.md B, C, D): skills and plugins
//! installed from a source, the "Suggested for a role" catalogue, role packs, and the repository scan that gives a
//! project a team.
//!
//! `put_member_switch` of the Python file carries no route decorator (the switch is set through the project's
//! plugin routes), so it has no route here either.

use axum::Json;
use axum::http::StatusCode;
use kb_ai::store::save;
use kb_ai_know::plugins::{self as svc_plugins, InstallOpts};
use kb_ai_know::{board_skills, packs as svc_packs};
use kb_ai_scan::run::ScanOptions;
use kb_ai_scan::{self as svc_scan, job::StartOptions};
use kb_base::error::{Body, Path};
use kb_base::{ApiError, ApiResult, Routes, activity, pyjson};
use kb_db::Session;
use kb_db::entities::{ai_plugin, ai_repo_scan, project};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde::Deserialize;
use serde_json::{Map, Value, json};

/// The routes of this file, in the order of the Python file.
pub fn routes() -> Routes {
    Routes::new()
        .get("/ai/catalogue", get_catalogue)
        .get("/ai/board-skills", get_board_skills)
        .get("/projects/{project_id}/ai/plugins", get_plugins)
        .post("/projects/{project_id}/ai/plugins/preview", post_preview)
        .post("/projects/{project_id}/ai/plugins", post_install)
        .patch("/ai/plugins/{plugin_id}", patch_plugin)
        .get("/ai/plugins/{plugin_id}/update", get_update)
        .get("/ai/plugins/{plugin_id}/changes", get_changes)
        .post("/ai/plugins/{plugin_id}/{action}", post_plugin_action)
        .delete("/ai/plugins/{plugin_id}", delete_plugin)
        .get("/projects/{project_id}/ai/packs", get_packs)
        .get("/projects/{project_id}/ai/packs/{key}", get_pack)
        .put("/projects/{project_id}/ai/packs/{key}", put_pack)
        .delete("/projects/{project_id}/ai/packs/{key}", delete_pack)
        .get("/projects/{project_id}/ai/packs/{key}/export", get_pack_export)
        .post("/projects/{project_id}/ai/packs/import", post_pack_import)
        .post("/projects/{project_id}/ai/scan", post_scan)
        .get("/ai/scans/{scan_id}", get_scan)
        .get("/projects/{project_id}/ai/scans/latest", get_latest_scan)
        .post("/ai/scans/{scan_id}/ai", post_scan_ai)
        .post("/ai/scans/{scan_id}/try", post_scan_try)
        .post("/ai/scans/{scan_id}/cancel", post_scan_cancel)
        .post("/ai/scans/{scan_id}/apply", post_apply)
}

/// `svc_activity.current_actor() or "user"`.
fn by() -> String {
    let actor = activity::current_actor();
    if actor.is_empty() { "user".to_string() } else { actor }
}

/// `_project`: the 404 of a project that is not there.
async fn project_exists(session: &Session, project_id: &str) -> ApiResult<()> {
    if project::Entity::find_by_id(project_id).one(session).await?.is_none() {
        return Err(ApiError::not_found("Project not found"));
    }
    Ok(())
}

/// `_plugin`: the plugin, or the 404.
async fn plugin_row(session: &Session, plugin_id: &str) -> ApiResult<ai_plugin::Model> {
    match ai_plugin::Entity::find_by_id(plugin_id).one(session).await? {
        Some(row) => Ok(row),
        None => Err(ApiError::not_found("Plugin not found")),
    }
}

/// `except PluginError as exc: _fail(exc)`: a `PluginError` is the 422 of these routes; an `OSError` is a 500.
fn plugin_422(err: svc_plugins::Error) -> ApiError {
    match err {
        svc_plugins::Error::Plugin(message) => ApiError::unprocessable(message),
        other => plugin_uncaught(other),
    }
}

/// A plugin failure nothing catches: a 500.
fn plugin_uncaught(err: svc_plugins::Error) -> ApiError {
    match err {
        svc_plugins::Error::Db(err) => err.into(),
        other => ApiError::internal(other),
    }
}

/// `except ValueError as exc: _fail(exc)` of a pack: a refusal is the 422; anything else is a 500.
fn pack_422(err: svc_packs::Error) -> ApiError {
    match err {
        svc_packs::Error::Value(message) => ApiError::unprocessable(message),
        svc_packs::Error::Db(err) => err.into(),
        svc_packs::Error::Plugin(err) => plugin_uncaught(err),
    }
}

// --------------------------------------------------------------------------- the catalogue

/// What each role is suggested to install (D2, D16).
async fn get_catalogue() -> Json<Vec<Map<String, Value>>> {
    Json(svc_plugins::CATALOGUE.clone())
}

// --------------------------------------------------------------------------- plugins

/// The board's own skills (the canvas design guide, permissions, the shared skills of issue #277): [{name,
/// description}]. Whether each is on for a project or a member is in the project's ops (`board_skills`).
async fn get_board_skills() -> Json<Vec<Value>> {
    Json(board_skills::catalog())
}

/// The project's installed plugins, with their real use counted from the runs.
async fn get_plugins(Path(project_id): Path<String>) -> ApiResult<Json<Vec<Value>>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    let used = svc_plugins::usage(&session, &project_id).await?;
    let rows = ai_plugin::Entity::find()
        .filter(ai_plugin::Column::ProjectId.eq(project_id.as_str()))
        .order_by_asc(ai_plugin::Column::InstalledAt)
        .order_by_asc(ai_plugin::Column::Id)
        .all(&session)
        .await?;
    Ok(Json(rows.iter().map(|r| svc_plugins::to_dict(r, used.get(&r.name))).collect()))
}

/// `Literal["git", "marketplace", "folder"]`.
#[derive(Debug, Default, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum SourceKind {
    #[default]
    Git,
    Marketplace,
    Folder,
}

impl SourceKind {
    fn as_str(self) -> &'static str {
        match self {
            SourceKind::Git => "git",
            SourceKind::Marketplace => "marketplace",
            SourceKind::Folder => "folder",
        }
    }
}

/// Where a plugin comes from.
#[derive(Debug, Deserialize)]
struct SourceBody {
    #[serde(default)]
    source_kind: SourceKind,
    source: String,
    #[serde(default, rename = "ref")]
    ref_: Option<String>,
    #[serde(default)]
    plugin: Option<String>,
    #[serde(default)]
    skills: Option<Vec<String>>,
}

/// What will be installed: skills, hooks, MCP servers, size, commit; a marketplace lists its plugins.
async fn post_preview(
    Path(project_id): Path<String>,
    Body(body): Body<SourceBody>,
) -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    let out = svc_plugins::preview(
        body.source_kind.as_str(),
        &body.source,
        body.ref_.as_deref(),
        body.plugin.as_deref(),
        body.skills.as_deref(),
    )
    .await
    .map_err(plugin_422)?;
    Ok(Json(out))
}

/// Install a plugin, and who gets it.
#[derive(Debug, Deserialize)]
struct InstallBody {
    #[serde(default)]
    source_kind: SourceKind,
    source: String,
    #[serde(default, rename = "ref")]
    ref_: Option<String>,
    #[serde(default)]
    plugin: Option<String>,
    #[serde(default)]
    skills: Option<Vec<String>>,
    #[serde(default)]
    roles: Vec<String>,
    #[serde(default)]
    default_on: bool,
}

/// Install (no review step, D1): the source and the commit are recorded.
async fn post_install(
    Path(project_id): Path<String>,
    Body(body): Body<InstallBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    let who = by();
    let row = svc_plugins::install(
        &session,
        &project_id,
        InstallOpts {
            source_kind: body.source_kind.as_str(),
            source: &body.source,
            ref_: body.ref_.as_deref(),
            plugin: body.plugin.as_deref(),
            skills: body.skills.clone(),
            roles: Some(body.roles.clone()),
            default_on: body.default_on,
            by: &who,
        },
    )
    .await
    .map_err(plugin_422)?;
    Ok((StatusCode::CREATED, Json(svc_plugins::to_dict(&row, None))))
}

/// The project default and the roles that get it.
#[derive(Debug, Deserialize)]
struct PluginPatch {
    #[serde(default)]
    default_on: Option<bool>,
    #[serde(default)]
    roles: Option<Vec<String>>,
}

/// Change the project default or the roles; takes effect from the next run.
async fn patch_plugin(Path(plugin_id): Path<String>, Body(body): Body<PluginPatch>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let mut row = plugin_row(&session, &plugin_id).await?;
    if let Some(default_on) = body.default_on {
        row.default_on = default_on;
    }
    if let Some(roles) = &body.roles {
        row.roles = pyjson::dumps(&json!(roles));
    }
    let row = save::<_, ai_plugin::Model, ai_plugin::ActiveModel>(&session, row).await?;
    session.commit().await?;
    Ok(Json(svc_plugins::to_dict(&row, None)))
}

/// Whether a newer version is out (nothing updates on its own).
async fn get_update(Path(plugin_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let row = plugin_row(&session, &plugin_id).await?;
    Ok(Json(svc_plugins::check_update(&row).await.map_err(plugin_uncaught)?))
}

/// See what changed: files added, removed and changed by the update.
async fn get_changes(Path(plugin_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let row = plugin_row(&session, &plugin_id).await?;
    Ok(Json(svc_plugins::changes(&row).await.map_err(plugin_422)?))
}

/// Update (keeps the previous version), Rollback, Reload (re-read the source), Reset (back to the catalogue version),
/// Pin, Unpin. All take effect from the next run.
async fn post_plugin_action(Path((plugin_id, action)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    if !matches!(action.as_str(), "update" | "rollback" | "reload" | "reset" | "pin" | "unpin") {
        return Err(ApiError::validation(
            &["path", "action"],
            "Input should be 'update', 'rollback', 'reload', 'reset', 'pin' or 'unpin'",
            "literal_error",
        ));
    }
    let session = kb_db::session();
    let row = plugin_row(&session, &plugin_id).await?;
    let row = match action.as_str() {
        "update" => svc_plugins::update(&session, row).await,
        "rollback" => svc_plugins::rollback(&session, row).await,
        "reload" => svc_plugins::reload(&session, row).await,
        "reset" => svc_plugins::reset(&session, row).await,
        _ => svc_plugins::pin(&session, row, action == "pin").await,
    }
    .map_err(plugin_422)?;
    Ok(Json(svc_plugins::to_dict(&row, None)))
}

/// Remove: uninstall it and every cached copy.
async fn delete_plugin(Path(plugin_id): Path<String>) -> ApiResult<StatusCode> {
    let session = kb_db::session();
    let row = plugin_row(&session, &plugin_id).await?;
    svc_plugins::remove(&session, row).await.map_err(plugin_uncaught)?;
    Ok(StatusCode::NO_CONTENT)
}

// --------------------------------------------------------------------------- packs

/// The ready-made packs and the project's own.
async fn get_packs(Path(project_id): Path<String>) -> ApiResult<Json<Vec<Map<String, Value>>>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    Ok(Json(svc_packs::list_packs(&session, &project_id).await?))
}

/// One pack.
async fn get_pack(Path((project_id, key)): Path<(String, String)>) -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    match svc_packs::get_pack(&session, &project_id, &key).await? {
        Some(pack) => Ok(Json(pack)),
        None => Err(ApiError::not_found("Pack not found")),
    }
}

/// Create or edit a pack (a new version each time; editing a ready-made one makes the project's copy).
async fn put_pack(
    Path((project_id, key)): Path<(String, String)>,
    Body(body): Body<Map<String, Value>>,
) -> ApiResult<Json<Map<String, Value>>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    Ok(Json(svc_packs::save_pack(&session, &project_id, &key, &body, &by()).await.map_err(pack_422)?))
}

/// Remove the project's own pack (a ready-made one comes back).
async fn delete_pack(Path((project_id, key)): Path<(String, String)>) -> ApiResult<StatusCode> {
    let session = kb_db::session();
    if !svc_packs::delete_pack(&session, &project_id, &key).await? {
        return Err(ApiError::not_found("Only a pack of this project can be removed."));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// The pack as one file.
async fn get_pack_export(Path((project_id, key)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    match svc_packs::get_pack(&session, &project_id, &key).await? {
        Some(pack) => Ok(Json(svc_packs::export(&pack))),
        None => Err(ApiError::not_found("Pack not found")),
    }
}

/// Import a pack file; says what it could not find on this project.
async fn post_pack_import(
    Path(project_id): Path<String>,
    Body(body): Body<Map<String, Value>>,
) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    Ok(Json(
        svc_packs::import_pack(&session, &project_id, &Value::Object(body), &by()).await.map_err(pack_422)?,
    ))
}

// --------------------------------------------------------------------------- the repository scan

/// A scan service's failure where the route has no `except` for it: a 500.
fn scan_uncaught(err: svc_scan::Error) -> ApiError {
    match err {
        svc_scan::Error::Db(err) => err.into(),
        other => ApiError::internal(other),
    }
}

/// Scan a repository for a new project's team.
#[derive(Debug, Deserialize)]
struct ScanBody {
    folder: String,
    #[serde(default = "yes")]
    trial: bool,
    // D19 step 2: a light model refines the code's suggestion (soft: without a Claude Code account it is skipped)
    #[serde(default = "yes")]
    refine: bool,
    // The commands as the person edited them ("Try again" in the wizard): tried instead of the suggestion's
    #[serde(default)]
    prepare: Option<String>,
    #[serde(default)]
    test: Option<String>,
}

fn yes() -> bool {
    true
}

/// Scan by code, suggest, and try the commands once in a scratch worktree. Nothing is created.
async fn post_scan(
    Path(project_id): Path<String>,
    Body(body): Body<ScanBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    let opts = ScanOptions {
        trial: body.trial,
        refine: body.refine,
        prepare: body.prepare.as_deref(),
        test: body.test.as_deref(),
    };
    let row = svc_scan::run_scan(&session, &project_id, &body.folder, opts).await.map_err(|err| match err {
        svc_scan::Error::Value(message) => ApiError::unprocessable(message),
        other => scan_uncaught(other),
    })?;
    Ok((StatusCode::CREATED, Json(svc_scan::to_api(&session, &row).await.map_err(scan_uncaught)?)))
}

/// A scan (the wizard polls it while the AI or the board tries the commands).
async fn get_scan(Path(scan_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let row = scan_row(&session, &scan_id).await?;
    Ok(Json(svc_scan::to_api(&session, &row).await.map_err(scan_uncaught)?))
}

/// The scan, or the 404.
async fn scan_row(session: &Session, scan_id: &str) -> ApiResult<ai_repo_scan::Model> {
    match ai_repo_scan::Entity::find_by_id(scan_id).one(session).await? {
        Some(row) => Ok(row),
        None => Err(ApiError::not_found("Scan not found")),
    }
}

/// The newest scan not applied yet (last 24 h), so the wizard picks up a setup that kept running.
async fn get_latest_scan(Path(project_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    project_exists(&session, &project_id).await?;
    match svc_scan::latest(&session, &project_id).await.map_err(scan_uncaught)? {
        Some(row) => Ok(Json(svc_scan::to_api(&session, &row).await.map_err(scan_uncaught)?)),
        None => Ok(Json(Value::Null)),
    }
}

/// `dict[str, str | None]`: the 422 of a value that is neither.
fn string_map(field: &str, value: Option<Map<String, Value>>) -> ApiResult<Option<Map<String, Value>>> {
    let Some(map) = value else { return Ok(None) };
    for (key, v) in &map {
        if !(v.is_null() || v.is_string()) {
            return Err(ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                json!([{"type": "string_type", "loc": ["body", field, key], "msg": "Input should be a valid string"}]),
            ));
        }
    }
    Ok(Some(map))
}

/// Let the AI set up the commands (design/screens/ai-repo-commands.md, C).
#[derive(Debug, Deserialize)]
struct AiJobBody {
    #[serde(default)]
    hint: String,
    // the rows as they are on screen, and those the AI must leave alone (they work, or the person typed them)
    #[serde(default)]
    commands: Option<Map<String, Value>>,
    #[serde(default)]
    keep: Vec<String>,
    #[serde(default)]
    env_path: Option<Vec<String>>,
}

/// The board runs the commands as the person has them, the way a ticket will.
#[derive(Debug, Deserialize)]
struct TryBody {
    commands: Map<String, Value>,
    #[serde(default)]
    env_path: Vec<String>,
    // which of test, lint, build (prepare runs first when it is set)
    #[serde(default)]
    only: Option<Vec<String>>,
}

/// `_scan_job`: start a job, then the scan as the wizard polls it.
async fn scan_job(session: &Session, scan_id: &str, opts: StartOptions) -> ApiResult<Json<Value>> {
    let row = svc_scan::start_job(session, scan_id, opts).await.map_err(|err| match err {
        svc_scan::Error::Lookup(message) => ApiError::not_found(message),
        svc_scan::Error::JobRunning(message) => ApiError::conflict(message),
        svc_scan::Error::Value(message) => ApiError::unprocessable(message),
        other => scan_uncaught(other),
    })?;
    Ok(Json(svc_scan::to_api(session, &row).await.map_err(scan_uncaught)?))
}

/// Start the AI: it reads the repository and proposes; the board then runs each command itself.
async fn post_scan_ai(Path(scan_id): Path<String>, Body(body): Body<AiJobBody>) -> ApiResult<Json<Value>> {
    let commands = string_map("commands", body.commands)?;
    let session = kb_db::session();
    let opts = StartOptions {
        mode: "ai".to_string(),
        hint: body.hint,
        commands,
        keep: Some(body.keep),
        env_path: body.env_path,
        only: None,
    };
    scan_job(&session, &scan_id, opts).await
}

/// Run the commands once in a scratch worktree, as a ticket runs them. Returns at once; poll the scan.
async fn post_scan_try(Path(scan_id): Path<String>, Body(body): Body<TryBody>) -> ApiResult<Json<Value>> {
    let commands = string_map("commands", Some(body.commands))?;
    let session = kb_db::session();
    let opts = StartOptions {
        mode: "try".to_string(),
        hint: String::new(),
        commands,
        keep: None,
        env_path: Some(body.env_path),
        only: body.only,
    };
    scan_job(&session, &scan_id, opts).await
}

/// Stop the AI or the trial.
async fn post_scan_cancel(Path(scan_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let row = svc_scan::cancel_job(&session, &scan_id).await.map_err(|err| match err {
        svc_scan::Error::Lookup(message) => ApiError::not_found(message),
        other => scan_uncaught(other),
    })?;
    Ok(Json(svc_scan::to_api(&session, &row).await.map_err(scan_uncaught)?))
}

/// Create what the person confirmed: the team, the settings and the plugins.
async fn post_apply(Path(scan_id): Path<String>, Body(body): Body<Map<String, Value>>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    scan_row(&session, &scan_id).await?;
    let out = svc_scan::apply(&session, &scan_id, &Value::Object(body), &by()).await.map_err(|err| match err {
        svc_scan::Error::Lookup(message) => ApiError::not_found(message),
        other => scan_uncaught(other),
    })?;
    Ok(Json(out))
}
