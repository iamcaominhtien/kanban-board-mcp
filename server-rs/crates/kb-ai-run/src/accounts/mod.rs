//! AI accounts: separate logins of the same AI CLI that AI members can share (design/screens/ai-accounts.md)
//! (`services/ai/accounts.py`).
//!
//! An account is a folder of its own (`~/.kanban-board/ai-accounts/<name>`) plus a row that remembers its name, CLI
//! and last status. The login lives with the CLI, in that folder or (Claude Code on macOS) in the system keychain
//! under its own entry; the board starts the CLI and asks it who is signed in, and never reads, shows or sends the
//! login. The CLI-specific part (environment variables, status command) is in `kb_ai::profiles`.
//!
//! Finding the CLI is asynchronous here (`cli::find_cli` checks the path through `kb_ai::paths`), so `binary_of`,
//! `profile_of`, `env_for`, `cli_cards` and `to_dict`'s callers that need them are `async`. A function that changes a
//! row takes the row and gives back the stored one, where Python changes the object it was given.
//!
//! The functions from `_apply` to `sign_out` (the sign-in state of an account) are in `state`; every name of the
//! Python module is `accounts::<name>` here too.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Instant, SystemTime};

use kb_ai::profiles::{self, Env, Profile};
use kb_ai::providers;
use kb_ai::store::now_iso;
use kb_base::{events, pypath, pytext};
use kb_db::Session;
use kb_db::entities::{ai_account, ai_team, member};
use kb_db::save_model;
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, ModelTrait, QueryFilter, QueryOrder};
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::cli;

mod state;

use state::in_thread;
pub use state::{CHECKS_AT_ONCE, apply, check, check_all, follow, mark_signed_out, sign_out};

/// The variable that names the folder holding every account's folder.
pub const ROOT_ENV: &str = "KANBAN_AI_ACCOUNTS_HOME";

/// What an account CLI is called, which provider it serves and whether runs of that provider start today.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AccountCli {
    /// The name people see.
    pub label: &'static str,
    /// The AI member type it serves.
    pub provider: &'static str,
    /// The command.
    pub binary: &'static str,
    /// One line under the name.
    pub blurb: &'static str,
    /// Whether runs of that provider start today.
    pub runnable: bool,
}

/// account CLI -> what it is called, which provider it serves and whether runs of that provider start today
/// (AI v2: Claude Code is the only CLI)
pub const ACCOUNT_CLIS: [(&str, AccountCli); 1] = [(
    "claude",
    AccountCli {
        label: "Claude Code",
        provider: "claude-code",
        binary: "claude",
        blurb: "Anthropic · subscription (Pro, Max, Team)",
        runnable: true,
    },
)];
/// The states an account's row can hold.
pub const STATUSES: [&str; 3] = ["signed_in", "needs_sign_in", "cli_missing"];
/// The longest name of an account.
pub const NAME_MAX: usize = 60;

/// Something a person can fix; the message is shown as it is. `code` lets the UI pick the state to show.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct AccountError {
    /// The text for the person.
    pub message: String,
    /// A short machine code.
    pub code: String,
}

impl AccountError {
    /// The text for the person, and a short machine code.
    pub fn new(message: impl Into<String>, code: &str) -> Self {
        Self { message: message.into(), code: code.to_string() }
    }
}

/// What a function of this module fails with.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// `AccountError`: something a person can fix.
    #[error("{0}")]
    Account(#[from] AccountError),
    /// The database.
    #[error("{0}")]
    Db(#[from] DbErr),
    /// Anything Python lets through as a 500 (a row of a CLI the board no longer knows, a folder with a name no
    /// profile takes, the accounts folder that cannot be made).
    #[error("{0}")]
    Other(String),
}

fn refuse<T>(message: impl Into<String>, code: &str) -> Result<T, Error> {
    Err(Error::Account(AccountError::new(message, code)))
}

/// `ACCOUNT_CLIS[cli]`.
pub fn account_cli(cli_name: &str) -> Option<&'static AccountCli> {
    ACCOUNT_CLIS.iter().find(|(key, _)| *key == cli_name).map(|(_, spec)| spec)
}

fn spec_of(cli_name: &str) -> Result<&'static AccountCli, Error> {
    account_cli(cli_name).ok_or_else(|| Error::Other(format!("KeyError: {}", pytext::repr(cli_name))))
}

/// Folder that holds every account's folder. Outside the data folder, so it is not synced with it.
pub fn root() -> PathBuf {
    match std::env::var_os(ROOT_ENV).filter(|v| !v.is_empty()) {
        Some(root) => PathBuf::from(root),
        None => kb_base::config::home_dir().join(".kanban-board").join("ai-accounts"),
    }
}

/// `root()/leaf`, refused unless it stays directly inside the accounts folder (the name comes from a person).
pub fn inside_root(leaf: &str) -> Result<PathBuf, AccountError> {
    inside(&root().to_string_lossy(), leaf)
}

/// `_inside_root` for a root given.
pub fn inside(root: &str, leaf: &str) -> Result<PathBuf, AccountError> {
    let base = pypath::normpath(root);
    let full = pypath::normpath(&pypath::join(&base, leaf));
    let sep = std::path::MAIN_SEPARATOR;
    if pypath::dirname(&full) != base || !full.starts_with(&format!("{base}{sep}")) {
        return Err(AccountError::new("Choose another name for the account.", "name_invalid"));
    }
    Ok(PathBuf::from(full))
}

static NOT_SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new("[^a-z0-9]+").expect("the slug pattern compiles"));

/// `_slug(name)`: the folder name of an account.
pub fn slug(name: &str) -> String {
    let lower = name.to_lowercase();
    let text = NOT_SLUG.replace_all(&lower, "-");
    let text: String = text.trim_matches('-').chars().take(40).collect();
    if text.is_empty() { "account".to_string() } else { text }
}

/// Path of the CLI this account runs, or None when it is not installed.
pub async fn binary_of(account: &ai_account::Model) -> Result<Option<String>, Error> {
    let (path, _) = cli::find_cli(spec_of(&account.cli)?.binary, None).await;
    Ok(path)
}

/// `Path(folder).name`.
fn folder_name(folder: &str) -> String {
    Path::new(folder).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// The profile (folder, environment, status command) of an account.
pub async fn profile_of(account: &ai_account::Model) -> Result<Box<dyn Profile>, Error> {
    let binary = binary_of(account).await?;
    profiles::profile_for(
        &account.cli,
        &folder_name(&account.folder),
        Some(Path::new(&account.folder)),
        binary.as_deref(),
    )
    .map_err(|e| Error::Other(e.to_string()))
}

/// `base` (a CLI environment) with the account applied: its own config folder, no variable that would override
/// its login.
pub async fn env_for(account: &ai_account::Model, base: &Env) -> Result<Env, Error> {
    Ok(profile_of(account).await?.overlay(base))
}

/// The CLAUDE_CONFIG_DIR of the AI account a member uses (where its Claude Code sessions are kept), or None for a
/// member on the login already on this computer.
pub async fn config_dir_for_member(session: &Session, member_id: &str) -> Result<Option<String>, DbErr> {
    let Some(member) = ai_team::Entity::find_by_id(member_id).one(session).await? else { return Ok(None) };
    let Some(account_id) = member.account_id.filter(|id| !id.is_empty()) else { return Ok(None) };
    Ok(claude_config_dir(ai_account::Entity::find_by_id(account_id).one(session).await?.as_ref()))
}

/// The CLAUDE_CONFIG_DIR a Claude Code account uses, where its sessions are kept.
pub fn claude_config_dir(account: Option<&ai_account::Model>) -> Option<String> {
    account.filter(|a| a.cli == "claude").map(|a| a.folder.clone())
}

/// The account CLI that serves an AI member type, or None when that type has no accounts.
pub fn cli_for_provider(provider: &str) -> Option<&'static str> {
    ACCOUNT_CLIS.iter().find(|(_, spec)| spec.provider == provider).map(|(key, _)| *key)
}

/// Why an account of this CLI cannot be made on this computer, or None.
pub fn available(_cli_name: &str) -> Option<String> {
    None
}

// `<cli> --version` of each CLI found (ACC-5), by path and file time: read in the background, never while the page
// waits, so the card says "found" alone until it is known (or for good, when the CLI does not answer)
/// How long `--version` may take.
pub const VERSION_TIMEOUT_S: f64 = 5.0;
/// How long a CLI that gave no version is left alone before it is asked again.
pub const VERSION_RETRY_S: f64 = 600.0;
type VersionKey = (String, SystemTime);
static VERSIONS: LazyLock<Mutex<HashMap<VersionKey, Option<String>>>> = LazyLock::new(Mutex::default);
static VERSION_TRIED: LazyLock<Mutex<HashMap<VersionKey, Instant>>> = LazyLock::new(Mutex::default);
static VERSION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\bv?([0-9]+\.[0-9]+(?:\.[0-9]+)?(?:[-+.][\w.]+)?)").expect("the version pattern compiles")
});

/// "2.1.4 (Claude Code)" → "2.1.4"; None when the output names no version.
pub fn parse_version(out: &str) -> Option<String> {
    VERSION_RE.captures(out).map(|m| m[1].chars().take(40).collect())
}

fn version_key(path: &str) -> Option<VersionKey> {
    Some((path.to_string(), std::fs::metadata(path).ok()?.modified().ok()?))
}

async fn read_version(path: String, key: VersionKey) {
    // a version is a nicety: no answer leaves "found" alone
    let version = match cli::run_capture(&[path, "--version".into()], VERSION_TIMEOUT_S, None, None).await {
        Ok((0, out, err)) => parse_version(if out.is_empty() { &err } else { &out }),
        _ => None,
    };
    VERSIONS.lock().unwrap_or_else(|e| e.into_inner()).insert(key, version);
}

/// The cached version of the CLI at `path`, or None; starts one background read when none is known yet.
pub fn cli_version(path: Option<&str>) -> Option<String> {
    let path = path.filter(|p| !p.is_empty())?;
    let key = version_key(path)?;
    let known = VERSIONS.lock().unwrap_or_else(|e| e.into_inner()).get(&key).cloned();
    if let Some(Some(version)) = known {
        return Some(version);
    }
    let now = Instant::now();
    let mut tried = VERSION_TRIED.lock().unwrap_or_else(|e| e.into_inner());
    if tried.get(&key).is_some_and(|at| now.duration_since(*at).as_secs_f64() < VERSION_RETRY_S) {
        return known.flatten();
    }
    let Ok(runtime) = tokio::runtime::Handle::try_current() else { return None };
    tried.insert(key.clone(), now);
    runtime.spawn(read_version(path.to_string(), key));
    None
}

/// Forget every version read so far (tests).
pub fn forget_versions() {
    VERSIONS.lock().unwrap_or_else(|e| e.into_inner()).clear();
    VERSION_TRIED.lock().unwrap_or_else(|e| e.into_inner()).clear();
}

/// Step 1 of the Add account window: each CLI, whether it is installed and whether it can be used here.
pub async fn cli_cards() -> Vec<Value> {
    let mut cards = Vec::new();
    for (key, spec) in ACCOUNT_CLIS {
        let (path, _) = cli::find_cli(spec.binary, None).await;
        let path = path.filter(|p| !p.is_empty());
        cards.push(json!({
            "cli": key,
            "label": spec.label,
            "blurb": spec.blurb,
            "provider": spec.provider,
            "found": path.is_some(),
            // "2.1.4" once `--version` answered (ACC-5); None while unknown or when it does not answer
            "version": cli_version(path.as_deref()),
            "runnable": spec.runnable,
            "unavailable": available(key),
        }));
    }
    cards
}

/// `_clean_name(name)`: the name with its spaces squashed, or why it cannot be used.
pub fn clean_name(name: &str) -> Result<String, AccountError> {
    let name = pytext::squash(name);
    if name.is_empty() {
        return Err(AccountError::new("Give the account a name.", "name_required"));
    }
    if name.chars().count() > NAME_MAX {
        return Err(AccountError::new(format!("Use at most {NAME_MAX} characters."), "name_too_long"));
    }
    Ok(name)
}

async fn name_taken(session: &Session, name: &str, except_id: Option<&str>) -> Result<bool, DbErr> {
    let rows = ai_account::Entity::find().all(session).await?;
    let lower = name.to_lowercase();
    Ok(rows.iter().any(|r| r.name.to_lowercase() == lower && Some(r.id.as_str()) != except_id))
}

/// The account, or an AccountError (code `not_found`).
pub async fn get(session: &Session, account_id: &str) -> Result<ai_account::Model, Error> {
    match ai_account::Entity::find_by_id(account_id).one(session).await? {
        Some(account) => Ok(account),
        None => refuse("AI account not found.", "not_found"),
    }
}

/// Every account on this computer, oldest first.
pub async fn list_all(session: &Session) -> Result<Vec<ai_account::Model>, DbErr> {
    ai_account::Entity::find().order_by_asc(ai_account::Column::CreatedAt).all(session).await
}

/// `exc.strerror or exc` of an `OSError`.
fn strerror(e: &std::io::Error) -> String {
    let text = e.to_string();
    if e.raw_os_error().is_some() {
        if let Some(at) = text.rfind(" (os error ") {
            return text[..at].to_string();
        }
    }
    if e.kind() == std::io::ErrorKind::AlreadyExists && text.starts_with("[Errno 17]") {
        return "File exists".to_string();
    }
    text
}

/// Make the account's folder and its row. Signing in is a separate step (a person, in the terminal).
pub async fn create(session: &Session, name: &str, cli_name: &str, by: &str) -> Result<ai_account::Model, Error> {
    let name = clean_name(name)?;
    let Some(spec) = account_cli(cli_name) else {
        return refuse("Choose one of the supported CLIs.", "bad_cli");
    };
    if let Some(why) = available(cli_name).filter(|w| !w.is_empty()) {
        return refuse(why, "unavailable");
    }
    if name_taken(session, &name, None).await? {
        return refuse("An account with this name exists.", "name_taken");
    }
    let binary = spec.binary;
    let (path, _) = cli::find_cli(binary, None).await;
    let Some(path) = path.filter(|p| !p.is_empty()) else {
        return refuse(format!("“{binary}” was not found on this computer."), "cli_missing");
    };
    let base = slug(&name);
    let (mut folder, mut n) = (inside_root(&base)?, 1);
    while folder.exists() {
        n += 1;
        folder = inside_root(&format!("{base}-{n}"))?;
    }
    std::fs::create_dir_all(root()).map_err(|e| Error::Other(e.to_string()))?;
    let made = profiles::profile_for(cli_name, &folder_name(&folder.to_string_lossy()), Some(&folder), Some(&path))
        .map_err(profiles::Error::Fail)
        .and_then(|profile| profile.create(&std::collections::HashSet::new()));
    match made {
        Ok(()) => {}
        Err(profiles::Error::Fail(exc)) => return refuse(exc.to_string(), "unavailable"),
        Err(profiles::Error::Io(exc)) => {
            let _ = std::fs::remove_dir_all(&folder);
            return refuse(format!("Could not make the account's folder ({}).", strerror(&exc)), "folder");
        }
        Err(other) => return Err(Error::Other(other.to_string())),
    }
    let mut account = ai_account::new();
    account.name = Set(name);
    account.cli = Set(cli_name.to_string());
    account.folder = Set(folder.to_string_lossy().into_owned());
    account.status = Set("needs_sign_in".to_string());
    account.created_by = Set(Some(by.to_string()));
    let account = account.insert(session).await?;
    session.commit().await?;
    events::publish(events::INVALIDATE, &[]).await;
    Ok(account)
}

/// Change the name shown everywhere; the folder keeps its name.
pub async fn rename(session: &Session, account_id: &str, name: &str) -> Result<ai_account::Model, Error> {
    let read = get(session, account_id).await?;
    let mut account = read.clone();
    let name = clean_name(name)?;
    if name_taken(session, &name, Some(&account.id)).await? {
        return refuse("An account with this name exists.", "name_taken");
    }
    account.name = name;
    account.updated_at = now_iso();
    let account = save_model(session, &read, account).await?;
    session.commit().await?;
    events::publish(events::INVALIDATE, &[]).await;
    Ok(account)
}

/// The AI members (all projects) that run as this account.
pub async fn members_of(session: &Session, account_id: &str) -> Result<Vec<ai_team::Model>, DbErr> {
    ai_team::Entity::find().filter(ai_team::Column::AccountId.eq(account_id)).all(session).await
}

/// Delete the account, its folder and its saved login. `members` says what happens to the AI members that use
/// it: `login` (the login already on this computer), `other` (`other_id`) or `none` (they pause until a
/// person chooses). Returns how many members were moved.
pub async fn remove(
    session: &Session,
    account_id: &str,
    members: &str,
    other_id: Option<&str>,
) -> Result<usize, Error> {
    let account = get(session, account_id).await?;
    let using = members_of(session, &account.id).await?;
    let mut other = None;
    if !using.is_empty() {
        if members == "other" {
            let Some(other_id) = other_id.filter(|id| !id.is_empty() && *id != account.id) else {
                return refuse("Pick the other account.", "other_required");
            };
            let found = get(session, other_id).await?;
            if found.cli != account.cli {
                return refuse("Pick an account of the same CLI.", "other_cli");
            }
            other = Some(found);
        } else if members != "login" && members != "none" {
            return refuse("Choose what happens to the members.", "members");
        }
    }
    let moved = using.len();
    for read in using {
        let mut m = read.clone();
        m.updated_at = now_iso();
        if members == "other" {
            m.account_id = other.as_ref().map(|o| o.id.clone());
        } else {
            m.account_id = None;
            if members == "none" {
                m.paused = true;
                m.paused_at = Some(now_iso());
                m.paused_reason = Some(format!("Account {} was removed: choose an account", account.name));
            }
        }
        save_model(session, &read, m).await?;
    }
    let profile = profile_of(&account).await?;
    in_thread(profile, |p| p.remove()).await?;
    account.delete(session).await?;
    session.commit().await?;
    events::publish(events::INVALIDATE, &[]).await;
    Ok(moved)
}

/// Make an AI member run as an account (None: the login already on this computer).
pub async fn assign(session: &Session, member_id: &str, account_id: Option<&str>) -> Result<ai_team::Model, Error> {
    let Some(read) = ai_team::Entity::find_by_id(member_id).one(session).await? else {
        return refuse("AI member not found.", "member_not_found");
    };
    let mut profile = read.clone();
    match account_id {
        None => profile.account_id = None,
        Some(account_id) => {
            let account = get(session, account_id).await?;
            if profile.connection != "local" {
                return refuse("Only a member that runs on this computer can use an account.", "not_local");
            }
            let wanted = cli_for_provider(&profile.provider);
            if wanted != Some(account.cli.as_str()) {
                let label = providers::providers()
                    .get(&profile.provider)
                    .and_then(|p| p.get("label"))
                    .and_then(Value::as_str)
                    .map_or_else(|| profile.provider.clone(), str::to_string);
                return refuse(
                    format!("{} is an account of {}, not {label}.", account.name, spec_of(&account.cli)?.label),
                    "wrong_cli",
                );
            }
            profile.account_id = Some(account.id);
        }
    }
    profile.updated_at = now_iso();
    let profile = save_model(session, &read, profile).await?;
    session.commit().await?;
    events::publish(events::INVALIDATE, &[]).await;
    Ok(profile)
}

/// Per account: the members using it in this project and in others (with names, for the hover).
pub async fn counts(session: &Session, project_id: Option<&str>) -> Result<Map<String, Value>, DbErr> {
    let rows = ai_team::Entity::find().filter(ai_team::Column::AccountId.is_not_null()).all(session).await?;
    let names: HashMap<String, member::Model> = if rows.is_empty() {
        HashMap::new()
    } else {
        member::Entity::find()
            .filter(member::Column::Id.is_in(rows.iter().map(|r| r.id.clone())))
            .all(session)
            .await?
            .into_iter()
            .map(|m| (m.id.clone(), m))
            .collect()
    };
    let mut out = Map::new();
    for r in rows {
        let Some(account_id) = r.account_id.clone() else { continue };
        let slot = out.entry(account_id).or_insert_with(|| json!({"here": [], "elsewhere": []}));
        let item = json!({
            "id": r.id,
            "name": names.get(&r.id).map_or(&r.id, |m| &m.name),
            "project_id": r.project_id,
        });
        let side = if Some(r.project_id.as_str()) == project_id { "here" } else { "elsewhere" };
        if let Some(Value::Array(list)) = slot.get_mut(side) {
            list.push(item);
        }
    }
    Ok(out)
}

/// An account as the UI and the MCP tools see it. Never includes the folder's content or any login.
pub fn to_dict(
    account: &ai_account::Model,
    users: Option<&Value>,
    signing_in_by: Option<&str>,
) -> Result<Value, Error> {
    let spec = spec_of(&account.cli)?;
    let empty = json!([]);
    // `users or {...}`: an empty or missing entry has no members
    let users = users.filter(|u| kb_base::pyjson::truthy(u));
    let here = users.map_or(&empty, |u| &u["here"]);
    let elsewhere = users.map_or(&empty, |u| &u["elsewhere"]);
    let status = if signing_in_by.is_some_and(|by| !by.is_empty()) { "signing_in" } else { account.status.as_str() };
    let count = here.as_array().map_or(0, Vec::len) + elsewhere.as_array().map_or(0, Vec::len);
    Ok(json!({
        "id": account.id,
        "name": account.name,
        "cli": account.cli,
        "cli_label": spec.label,
        "provider": spec.provider,
        "status": status,
        "status_detail": account.status_detail,
        "email": account.email,
        "plan": account.plan,
        "method": account.method,
        "folder": account.folder,
        "runnable": spec.runnable,
        "unavailable": available(&account.cli),
        "checked_at": account.checked_at,
        "signed_out_at": account.signed_out_at,
        "signed_out_how": account.signed_out_how,
        "signing_in_by": signing_in_by,
        "created_at": account.created_at,
        "created_by": account.created_by,
        "members_here": here,
        "members_elsewhere": elsewhere,
        "member_count": count,
    }))
}
