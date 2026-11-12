//! `api/ai_accounts.py`: REST and terminal API of AI accounts (design/screens/ai-accounts.md).
//!
//! Reading the list is open to every member. Everything that changes an account, and the sign-in terminal, needs the
//! request to come from this computer (the desktop app): the web build cannot start a CLI on the person's machine. No
//! AI member has a route here; the MCP tools only read and assign.
//!
//! Left out (needs `services/ai/teams`, not ported yet): `PUT /ai/teams/{member_id}/account` (`put_member_account`:
//! `teams.get_profile` and `teams.describe`).
//!
//! Where the request comes from: Python's `request.client.host` is uvicorn's, and uvicorn trusts the
//! `X-Forwarded-For` header of a peer at `127.0.0.1` (its `ProxyHeadersMiddleware`, `forwarded_allow_ips`). The server
//! only listens on `127.0.0.1`, so the peer is always that address and `client_host` is what the middleware makes of
//! the header (`kb-app` keeps no peer address: its connect info is the server's own).

use std::net::{IpAddr, Ipv4Addr};

use axum::Json;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use futures::{SinkExt, StreamExt};
use kb_ai::audit;
use kb_ai_run::accounts::{self as svc_accounts, AccountError};
use kb_ai_run::{cli, signin};
use kb_base::error::{Body, Path, Query};
use kb_base::{ApiError, ApiResult, Routes, activity, pyjson, pytext};
use kb_db::Session;
use kb_db::entities::{ai_account, ai_team};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::schemas::AccountBody;

/// What `signin::write` takes of one message: the first 20000 characters.
const MAX_INPUT_CHARS: usize = 20_000;
/// The action `touches.record_signin` writes (`SIGNIN_ACTION`).
const SIGNIN_ACTION: &str = "account_signin";

/// The routes of this file.
pub fn routes() -> Routes {
    Routes::new()
        .get("/ai/accounts", get_accounts)
        .post("/ai/accounts", post_account)
        .get("/ai/accounts/name-check", check_account_name)
        .get("/ai/accounts/{account_id}", get_account)
        .patch("/ai/accounts/{account_id}", patch_account)
        .post("/ai/accounts/{account_id}/check", post_check)
        .post("/ai/accounts/{account_id}/sign-out", post_sign_out)
        .delete("/ai/accounts/{account_id}", delete_account)
        // PUT /ai/teams/{member_id}/account waits for `teams`
        .get("/ai/accounts-on-this-computer", logins_on_this_computer)
        .post("/ai/accounts/{account_id}/signin", post_signin)
        .delete("/ai/accounts/{account_id}/signin", delete_signin)
        .post("/ai/accounts/{account_id}/signin/done", post_signin_done)
        // a WebSocket route is not in the OpenAPI schema
        .hidden("GET", "/ai/accounts/{account_id}/terminal", axum::routing::get(terminal))
}

/// The person making the request (X-Actor, or the board's own user).
fn by() -> String {
    let actor = activity::current_actor();
    if actor.is_empty() { "user".to_string() } else { actor }
}

/// `header` as text: Starlette reads a header as latin-1, one byte to a character.
fn latin1(value: &HeaderValue) -> String {
    value.as_bytes().iter().map(|&b| char::from(b)).collect()
}

/// uvicorn's `_TrustedHosts.__contains__` for its default `forwarded_allow_ips` (`127.0.0.1`).
fn trusted_proxy(host: &str) -> bool {
    if host.is_empty() {
        return false;
    }
    match host.parse::<IpAddr>() {
        Ok(ip) => ip == IpAddr::V4(Ipv4Addr::LOCALHOST),
        Err(_) => host == "127.0.0.1",
    }
}

/// `request.client.host` / `ws.client.host`: the peer (always `127.0.0.1`) unless uvicorn's proxy-headers middleware
/// takes the client from `X-Forwarded-For`: the last address that is not a trusted proxy, or the first one when all
/// are. An empty answer leaves the peer.
pub fn client_host(headers: &HeaderMap) -> String {
    // `dict(scope["headers"])`: when the header is repeated the last one wins
    if let Some(forwarded) = headers.get_all("x-forwarded-for").iter().next_back() {
        let hosts: Vec<String> = latin1(forwarded).split(',').map(|h| pytext::strip(h).to_string()).collect();
        let host = hosts.iter().rev().find(|h| !trusted_proxy(h)).or_else(|| hosts.first());
        if let Some(host) = host.filter(|h| !h.is_empty()) {
            return host.clone();
        }
    }
    "127.0.0.1".to_string()
}

/// The loopback addresses.
const LOOPBACK: [&str; 3] = ["127.0.0.1", "::1", "localhost"];

/// `_is_local(host)`.
pub fn is_local(host: &str) -> bool {
    LOOPBACK.contains(&host) || host.starts_with("::ffff:127.")
}

/// Changing an account runs a CLI on this computer: only a request from this computer may do it.
fn desktop_only(headers: &HeaderMap) -> ApiResult<()> {
    if !is_local(&client_host(headers)) {
        return Err(ApiError::forbidden(
            "AI accounts need the desktop app: signing in runs a terminal on your computer.",
        ));
    }
    Ok(())
}

/// What `_fail` makes of an `AccountError`: the status of its code and `{"message", "code"}` as the detail.
fn fail(exc: &AccountError) -> ApiError {
    let status = match exc.code.as_str() {
        "not_found" | "member_not_found" => 404,
        "name_taken" => 409,
        _ => 422,
    };
    ApiError::code(status, json!({"message": exc.message, "code": exc.code}))
}

/// A service failure: an `AccountError` goes through `_fail`, anything else is a 500.
fn account_failure(err: svc_accounts::Error) -> ApiError {
    match err {
        svc_accounts::Error::Account(exc) => fail(&exc),
        svc_accounts::Error::Db(err) => err.into(),
        svc_accounts::Error::Other(message) => ApiError::internal(message),
    }
}

/// `svc_accounts.to_dict(account, users.get(account.id), signing_in_by=...)` for an account that may be signing in.
fn account_view(account: &ai_account::Model, users: &Map<String, Value>) -> ApiResult<Value> {
    let by = signin::signing_in_by(&account.id);
    svc_accounts::to_dict(account, users.get(&account.id), by.as_deref()).map_err(account_failure)
}

async fn view(session: &Session, project_id: Option<&str>) -> ApiResult<Vec<Value>> {
    let rows = svc_accounts::list_all(session).await?;
    let users = svc_accounts::counts(session, project_id).await?;
    rows.iter().map(|a| account_view(a, &users)).collect()
}

/// `sys.platform`.
fn platform() -> &'static str {
    if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "win32"
    } else {
        std::env::consts::OS
    }
}

#[derive(Debug, Deserialize)]
struct AccountsQuery {
    #[serde(default)]
    project_id: Option<String>,
}

/// Every AI account on this computer with its status and the members using it, and the CLIs an account can be made
/// for. `project_id` splits the members into "here" and "elsewhere".
async fn get_accounts(Query(query): Query<AccountsQuery>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let out = view(&session, query.project_id.as_deref()).await?;
    Ok(Json(json!({
        "accounts": out,
        "clis": svc_accounts::cli_cards().await,
        "platform": platform(),
        "terminal": signin::pty_available(),
        "console": signin::console_available(),
    })))
}

/// Make an account: its folder and its row. Signing in is the next step.
async fn post_account(headers: HeaderMap, Body(body): Body<AccountBody>) -> ApiResult<(StatusCode, Json<Value>)> {
    desktop_only(&headers)?;
    let session = kb_db::session();
    let cli_name = body.cli.as_deref().unwrap_or("");
    let account = svc_accounts::create(&session, &body.name, cli_name, &by()).await.map_err(account_failure)?;
    let account = svc_accounts::to_dict(&account, None, None).map_err(account_failure)?;
    Ok((StatusCode::CREATED, Json(account)))
}

#[derive(Debug, Deserialize)]
struct NameQuery {
    #[serde(default)]
    name: String,
}

/// Whether a name is free, for the name step (names are unique per computer).
async fn check_account_name(Query(query): Query<NameQuery>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let clean = pytext::squash(&query.name);
    if clean.is_empty() {
        return Ok(Json(json!({"ok": false, "message": "Give the account a name."})));
    }
    let lower = clean.to_lowercase();
    let taken = svc_accounts::list_all(&session).await?.iter().any(|a| a.name.to_lowercase() == lower);
    Ok(Json(json!({
        "ok": !taken,
        "message": if taken { json!("An account with this name exists.") } else { Value::Null },
    })))
}

/// One account.
async fn get_account(Path(account_id): Path<String>) -> ApiResult<Json<Value>> {
    let session = kb_db::session();
    let account = svc_accounts::get(&session, &account_id).await.map_err(account_failure)?;
    let users = svc_accounts::counts(&session, None).await?;
    Ok(Json(account_view(&account, &users)?))
}

/// Rename an account.
async fn patch_account(
    Path(account_id): Path<String>,
    headers: HeaderMap,
    Body(body): Body<AccountBody>,
) -> ApiResult<Json<Value>> {
    desktop_only(&headers)?;
    let session = kb_db::session();
    let account = svc_accounts::rename(&session, &account_id, &body.name).await.map_err(account_failure)?;
    Ok(Json(svc_accounts::to_dict(&account, None, None).map_err(account_failure)?))
}

/// Ask the CLI now whether the account is signed in ("Check now").
async fn post_check(Path(account_id): Path<String>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    desktop_only(&headers)?;
    let session = kb_db::session();
    let account = svc_accounts::get(&session, &account_id).await.map_err(account_failure)?;
    let account = svc_accounts::check(&session, account, "check").await.map_err(account_failure)?;
    let users = svc_accounts::counts(&session, None).await?;
    Ok(Json(account_view(&account, &users)?))
}

/// The CLI forgets this account's login. The account stays in the list.
async fn post_sign_out(Path(account_id): Path<String>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    desktop_only(&headers)?;
    let session = kb_db::session();
    if signin::active(&account_id).is_some() {
        return Err(ApiError::conflict("A sign-in is open for this account."));
    }
    let account = svc_accounts::sign_out(&session, &account_id).await.map_err(account_failure)?;
    Ok(Json(svc_accounts::to_dict(&account, None, None).map_err(account_failure)?))
}

#[derive(Debug, Deserialize)]
struct RemoveQuery {
    #[serde(default)]
    members: Option<String>,
    #[serde(default)]
    other_id: Option<String>,
}

/// Remove the account, its folder and its saved login. `members` says what happens to the AI members using it.
async fn delete_account(
    Path(account_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<RemoveQuery>,
) -> ApiResult<Json<Value>> {
    // `members: Literal["login", "other", "none"] = "login"`
    let members = query.members.as_deref().unwrap_or("login");
    if !["login", "other", "none"].contains(&members) {
        return Err(ApiError::validation(
            &["query", "members"],
            "Input should be 'login', 'other' or 'none'",
            "literal_error",
        ));
    }
    desktop_only(&headers)?;
    let session = kb_db::session();
    if signin::active(&account_id).is_some() {
        return Err(ApiError::conflict("A sign-in is open for this account."));
    }
    let moved = svc_accounts::remove(&session, &account_id, members, query.other_id.as_deref())
        .await
        .map_err(account_failure)?;
    Ok(Json(json!({"removed": true, "members_moved": moved})))
}

/// The logins the CLIs already have on this computer (what members use with no account chosen). Only Claude Code
/// says who; the others are not listed.
async fn logins_on_this_computer() -> ApiResult<Json<Vec<Value>>> {
    let mut out = Vec::new();
    let (path, _) = cli::find_cli("claude", None).await;
    if let Some(path) = path.filter(|p| !p.is_empty()) {
        let info = cli::detect("claude-code", "claude", Some(&path), None).await?;
        if info.get("logged_in").is_some_and(pyjson::truthy) {
            out.push(json!({
                "cli": "claude",
                "label": "Claude Code",
                "signed_in_with": info.get("account").cloned().unwrap_or(Value::Null),
            }));
        }
    }
    Ok(Json(out))
}

// --- the sign-in terminal -------------------------------------------------------------------------------------------

/// `{"command": signin.fallback_command(account)}`.
async fn fallback(account: &ai_account::Model) -> ApiResult<Value> {
    let command = signin::fallback_command(account).await.map_err(ApiError::internal)?;
    Ok(json!(command))
}

/// `touches.record_signin` (`services/ai/touches.py`, not ported yet; replace this with it): a person opened the
/// sign-in of an AI account: one audit entry per project whose teams run as this account. A failure is logged, never
/// raised: a note about the sign-in must never fail the sign-in.
async fn record_signin(session: &Session, account: &ai_account::Model, by: &str) -> usize {
    let written = async {
        let teams =
            ai_team::Entity::find().filter(ai_team::Column::AccountId.eq(account.id.as_str())).all(session).await?;
        let mut by_project: Vec<(String, Vec<String>)> = Vec::new();
        for team in teams {
            match by_project.iter_mut().find(|(project_id, _)| *project_id == team.project_id) {
                Some((_, ids)) => ids.push(team.id),
                None => by_project.push((team.project_id, vec![team.id])),
            }
        }
        for (project_id, ids) in &by_project {
            let mut detail = Map::new();
            detail.insert("account".into(), json!(account.name));
            detail.insert("account_id".into(), json!(account.id));
            detail.insert("team_ids".into(), json!(ids));
            let entry = audit::Entry { on_behalf_of: Some(by.to_string()), detail, ..audit::Entry::default() };
            audit::record(project_id, SIGNIN_ACTION, "info", entry).await?;
        }
        Ok::<usize, kb_db::sea_orm::DbErr>(by_project.len())
    }
    .await;
    match written {
        Ok(count) => count,
        Err(err) => {
            tracing::error!("Could not record the sign-in of {} as a touch: {err}", account.id);
            0
        }
    }
}

#[derive(Debug, Deserialize)]
struct SizeQuery {
    #[serde(default = "default_cols")]
    cols: i64,
    #[serde(default = "default_rows")]
    rows: i64,
}

fn default_cols() -> i64 {
    80
}

fn default_rows() -> i64 {
    24
}

/// Open the sign-in terminal for an account. If this computer cannot open one, answer with the command to run in the
/// person's own terminal instead (the window then polls the account until it is signed in).
async fn post_signin(
    Path(account_id): Path<String>,
    headers: HeaderMap,
    Query(size): Query<SizeQuery>,
) -> ApiResult<Json<Value>> {
    desktop_only(&headers)?;
    let session = kb_db::session();
    let account = svc_accounts::get(&session, &account_id).await.map_err(account_failure)?;
    let (cols, rows) = match (u16::try_from(size.cols), u16::try_from(size.rows)) {
        (Ok(cols), Ok(rows)) => (cols, rows),
        _ => return Err(ApiError::internal("the terminal size does not fit")),
    };
    let who = by();
    let opened = match signin::start(&account, &who, cols, rows).await {
        Ok(opened) => {
            record_signin(&session, &account, &who).await;
            opened
        }
        Err(signin::Error::Busy(exc)) => {
            return Err(ApiError::conflict(json!({"message": exc.to_string(), "code": "signing_in", "by": exc.by})));
        }
        Err(signin::Error::Pty(exc)) => {
            tracing::warn!("sign-in terminal unavailable: {exc}");
            record_signin(&session, &account, &who).await;
            let mut out = Map::new();
            out.insert("mode".into(), json!("fallback"));
            out.insert("reason".into(), json!("The terminal could not start on this computer."));
            out.insert("command".into(), fallback(&account).await?);
            return Ok(Json(Value::Object(out)));
        }
        Err(signin::Error::Account(exc)) => return Err(fail(&exc)),
        Err(signin::Error::Other(message)) => return Err(ApiError::internal(message)),
    };
    if opened.console {
        // Windows: the login opened in a console window of its own; the command is there should none appear
        return Ok(Json(json!({"mode": "console", "command": fallback(&account).await?})));
    }
    Ok(Json(json!({"mode": "terminal"})))
}

/// Stop signing in: the terminal closes and the CLI is stopped. Nothing is marked signed in.
async fn delete_signin(Path(account_id): Path<String>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    desktop_only(&headers)?;
    let open = signin::active(&account_id);
    if let Some(open) = &open {
        signin::stop(open, "cancelled").await;
    }
    Ok(Json(json!({"stopped": open.is_some()})))
}

/// The person is finished: stop the CLI (it may still be asking a question) and ask it once more who is signed in.
async fn post_signin_done(Path(account_id): Path<String>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    desktop_only(&headers)?;
    let open = signin::active(&account_id).or_else(|| signin::session(&account_id));
    if let Some(open) = &open {
        signin::stop(open, "done").await;
    }
    Ok(Json(json!({"done": open.is_some()})))
}

/// `urlparse(origin).hostname or ""`: the host of an origin, lower case, as Python's `urllib.parse` reads it. `None`
/// where `urlparse` raises (a bracket with no partner, or a bracketed host that is not an address).
fn origin_hostname(origin: &str) -> Option<String> {
    // `urlsplit` drops leading control characters and spaces, and tabs and line breaks anywhere
    let url: String =
        origin.trim_start_matches(|c: char| c <= ' ').chars().filter(|c| !matches!(c, '\t' | '\r' | '\n')).collect();
    let mut rest = url.as_str();
    if let Some(colon) = rest.find(':') {
        let scheme = &rest[..colon];
        let valid = scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
            && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c));
        if colon > 0 && valid {
            rest = &rest[colon + 1..];
        }
    }
    let Some(after) = rest.strip_prefix("//") else { return Some(String::new()) };
    let end = after.find(['/', '?', '#']).unwrap_or(after.len());
    let netloc = &after[..end];
    if netloc.contains('[') != netloc.contains(']') {
        return None;
    }
    let hostinfo = netloc.rsplit_once('@').map_or(netloc, |(_, host)| host);
    let hostname = match hostinfo.split_once('[') {
        Some((_, bracketed)) => {
            let host = bracketed.split_once(']').map_or(bracketed, |(host, _)| host);
            if host.parse::<std::net::Ipv6Addr>().is_err() {
                return None;
            }
            host
        }
        None => hostinfo.split_once(':').map_or(hostinfo, |(host, _)| host),
    };
    Some(hostname.to_lowercase())
}

/// A page on another website must not be able to type into the terminal: accept only this computer's own pages (the
/// desktop app loads the UI from a file, so its origin is `null`).
pub fn origin_ok(host: &str, origin: Option<&str>) -> bool {
    if !is_local(host) {
        return false;
    }
    let Some(origin) = origin else { return true };
    if origin == "null" || origin == "file://" {
        return true;
    }
    origin_hostname(origin).is_some_and(|name| ["127.0.0.1", "localhost", "::1"].contains(&name.as_str()))
}

/// `int(x)` of a JSON value where the error is a `TypeError` or `ValueError` (`None`).
fn py_int(value: &Value) -> Option<i64> {
    match value {
        Value::Bool(b) => Some(i64::from(*b)),
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().filter(|f| f.is_finite()).map(|f| f.trunc() as i64)),
        Value::String(text) => {
            let text = pytext::strip(text);
            let digits = text.strip_prefix(['+', '-']).unwrap_or(text);
            let plain = !digits.is_empty()
                && !digits.starts_with('_')
                && !digits.ends_with('_')
                && !digits.contains("__")
                && digits.chars().all(|c| c.is_ascii_digit() || c == '_');
            if plain { text.replace('_', "").parse::<i64>().ok() } else { None }
        }
        _ => None,
    }
}

/// The terminal of an open sign-in. The server sends `{"type":"out","data"}` (terminal output) and `{"type":"state",...}`
/// (what the status bar shows); the window sends `{"type":"input","data"}`, `{"type":"resize","cols","rows"}` and
/// `{"type":"paste","data"}`.
async fn terminal(
    axum::extract::Path(account_id): axum::extract::Path<String>,
    headers: HeaderMap,
    upgrade: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
) -> Response {
    let Ok(upgrade) = upgrade else {
        // Starlette matches a WebSocket route for a WebSocket only: a plain request finds nothing here
        return ApiError::not_found("Not Found").into_response();
    };
    // `ws.close()` before `accept()` is an HTTP 403 answer to the handshake, whichever code it carries (4403, 4404)
    let origin = headers.get("origin").map(latin1);
    if !origin_ok(&client_host(&headers), origin.as_deref()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(open) = signin::active(&account_id) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    upgrade.on_upgrade(move |socket| serve_terminal(socket, open))
}

async fn serve_terminal(socket: WebSocket, open: std::sync::Arc<signin::SignIn>) {
    let queue = signin::attach(&open);
    let (mut sender, mut receiver) = socket.split();
    let pump_queue = queue.clone();
    let pump = tokio::spawn(async move {
        loop {
            let message = pump_queue.get().await;
            if sender.send(Message::Text(pyjson::dumps(&message).into())).await.is_err() {
                return;
            }
        }
    });
    while let Some(Ok(frame)) = receiver.next().await {
        let Message::Text(text) = frame else {
            match frame {
                Message::Close(_) => break,
                Message::Binary(_) => break,
                _ => continue,
            }
        };
        // `json.loads`: a message that is not JSON is skipped
        let Ok(message) = serde_json::from_str::<Value>(text.as_str()) else { continue };
        // anything else than an object raises in Python (`.get` of a list): the handler ends
        let Some(message) = message.as_object() else { break };
        let kind = message.get("type").and_then(Value::as_str);
        match kind {
            Some("input" | "paste") if message.get("data").is_some_and(Value::is_string) => {
                let data: String = message["data"].as_str().unwrap_or_default().chars().take(MAX_INPUT_CHARS).collect();
                signin::write(&open, &data);
            }
            Some("resize") => {
                // `message["cols"]` raises KeyError when it is missing (the handler ends); `int()` of the wrong
                // kind of value is suppressed
                let (Some(cols), Some(rows)) = (message.get("cols"), message.get("rows")) else { break };
                if let (Some(cols), Some(rows)) = (py_int(cols), py_int(rows)) {
                    signin::resize(&open, cols, rows);
                }
            }
            _ => {}
        }
    }
    pump.abort();
    signin::detach(&open, &queue);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `test_the_terminal_only_talks_to_pages_of_this_computer` (the Python test calls `_origin_ok` itself).
    #[test]
    fn the_terminal_only_talks_to_pages_of_this_computer() {
        assert!(origin_ok("127.0.0.1", None));
        // the desktop app loads its UI from a file
        assert!(origin_ok("127.0.0.1", Some("null")));
        assert!(origin_ok("127.0.0.1", Some("file://")));
        assert!(origin_ok("127.0.0.1", Some("http://localhost:5173")));
        assert!(origin_ok("127.0.0.1", Some("http://LOCALHOST:5173")));
        assert!(origin_ok("127.0.0.1", Some("http://[::1]:5173")));
        assert!(origin_ok("::ffff:127.0.0.1", None));
        assert!(!origin_ok("127.0.0.1", Some("https://evil.example")));
        assert!(!origin_ok("127.0.0.1", Some("http://localhost.evil.example")));
        assert!(!origin_ok("127.0.0.1", Some("")));
        assert!(!origin_ok("127.0.0.1", Some("localhost:5173")));
        assert!(!origin_ok("10.0.0.5", None));
        assert!(!origin_ok("10.0.0.5", Some("null")));
    }

    #[test]
    fn urlparse_hostname() {
        assert_eq!(origin_hostname("http://user:pw@Example.COM:80/x?y#z").as_deref(), Some("example.com"));
        assert_eq!(origin_hostname("http://localhost@evil.example").as_deref(), Some("evil.example"));
        assert_eq!(origin_hostname("//host").as_deref(), Some("host"));
        assert_eq!(origin_hostname("host:80").as_deref(), Some(""));
        assert_eq!(origin_hostname("http://[::1]:8080").as_deref(), Some("::1"));
        assert_eq!(origin_hostname("http://[::1").as_deref(), None);
    }

    #[test]
    fn the_client_is_taken_from_forwarded_for_as_uvicorn_does() {
        let host = |value: Option<&str>| {
            let mut headers = HeaderMap::new();
            if let Some(value) = value {
                headers.insert("x-forwarded-for", HeaderValue::from_str(value).expect("header"));
            }
            client_host(&headers)
        };
        assert_eq!(host(None), "127.0.0.1");
        assert_eq!(host(Some("203.0.113.9")), "203.0.113.9");
        assert_eq!(host(Some("127.0.0.1, 203.0.113.9")), "203.0.113.9");
        assert_eq!(host(Some("203.0.113.9, 127.0.0.1")), "203.0.113.9");
        assert_eq!(host(Some("10.0.0.1, 203.0.113.9")), "203.0.113.9");
        assert_eq!(host(Some("127.0.0.1, 127.0.0.1")), "127.0.0.1");
        assert_eq!(host(Some("::1")), "::1");
        assert_eq!(host(Some("  ")), "127.0.0.1");
        assert!(is_local(&host(Some("::ffff:127.0.0.1"))));
        assert!(!is_local(&host(Some("203.0.113.9"))));
    }

    #[test]
    fn a_resize_is_read_as_int_does() {
        assert_eq!(py_int(&json!(80)), Some(80));
        assert_eq!(py_int(&json!(80.9)), Some(80));
        assert_eq!(py_int(&json!(" 1_0 ")), Some(10));
        assert_eq!(py_int(&json!("+7")), Some(7));
        assert_eq!(py_int(&json!("x")), None);
        assert_eq!(py_int(&json!("1.5")), None);
        assert_eq!(py_int(&json!(null)), None);
        assert_eq!(py_int(&json!([1])), None);
        assert_eq!(py_int(&json!(true)), Some(1));
    }
}
