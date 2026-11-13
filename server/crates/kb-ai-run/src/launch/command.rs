//! The command line of a run (`services/ai/launch.py`, lines 550 to 845): the MCP config, the settings, the flag set,
//! and `prepare`, which puts everything together and writes the run's folder.

use std::collections::HashSet;
use std::future::Future;
use std::pin::pin;
use std::task::{Context, Poll, Waker};

use kb_ai::profiles::Env;
use kb_ai::providers::merged_config;
use kb_ai::store::{get_settings, loads};
use kb_ai::{mcp_sources, ops, pictures};
use kb_ai_know::{board_skills, plugins, roles};
use kb_base::{ctx, pyjson, pytext};
use kb_db::Session;
use kb_db::entities::{ai_account, ai_run, ai_team, member};
use kb_db::sea_orm::EntityTrait;
use serde_json::{Map, Value, json};

use super::{
    DEFAULT_DENY, Error, Launch, PromptOpts, REPORT_SCHEMA, RUN_TOKEN_SHOWN, board_plugin_dir, build_prompt, data_root,
    path_text, run_dir,
};
use crate::{accounts, cli};

/// `str(value)`.
fn text_of(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => pyjson::py_str(other),
    }
}

/// `_kv_dict`: a dict of texts from a dict, or from a list of `{key, value}` rows (what the settings form saves).
pub fn kv_dict(value: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                out.insert(k.clone(), json!(text_of(v)));
            }
        }
        Value::Array(items) => {
            for item in items {
                let Some(item) = item.as_object() else { continue };
                if let Some(key) = item.get("key").filter(|k| pyjson::truthy(k)) {
                    let value = item.get("value").filter(|v| pyjson::truthy(v)).map(text_of).unwrap_or_default();
                    out.insert(text_of(key), json!(value));
                }
            }
        }
        _ => {}
    }
    out
}

/// The value of a future that never waits (it only gives a piece of code a context of its own).
fn ready<F: Future>(fut: F) -> Option<F::Output> {
    let mut fut = pin!(fut);
    match fut.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(value) => Some(value),
        Poll::Pending => None,
    }
}

/// `mcp_sources.folder_servers(folder)` with `mcp_sources.ACCOUNT_DIR` set to `config_dir` for the call. The value is
/// set in a context of its own, so it is there whether or not the caller runs inside one, and gone afterwards.
fn folder_servers(folder: &str, config_dir: Option<&str>) -> Map<String, Value> {
    ready(ctx::scope(async {
        let reset = mcp_sources::set_account_dir(config_dir);
        let found = mcp_sources::folder_servers(Some(folder));
        ctx::reset(reset);
        found
    }))
    .unwrap_or_default()
}

/// The run's MCP servers: the board (with the run's token), the team's servers, then the folder's `.mcp.json`.
pub fn mcp_config(
    config: &Map<String, Value>,
    token: &str,
    folder: Option<&str>,
    config_dir: Option<&str>,
    board_url: &str,
) -> Value {
    let mut servers = Map::new();
    servers.insert(
        "kanban".into(),
        json!({
            "type": "http",
            "url": format!("{board_url}/mcp/"),
            "headers": {"Authorization": format!("Bearer {token}")},
        }),
    );
    let listed = match config.get("mcp_servers").filter(|v| pyjson::truthy(v)) {
        Some(Value::Array(items)) => items.as_slice(),
        _ => &[],
    };
    for server in listed {
        let Some(server) = server.as_object() else { continue };
        let name = server.get("name").filter(|n| pyjson::truthy(n)).map(text_of).unwrap_or_default();
        let name = pytext::strip(&name);
        if !name.is_empty() && name != "kanban" && server.get("enabled").is_none_or(pyjson::truthy) {
            let mut spec: Map<String, Value> = server
                .iter()
                .filter(|(k, _)| matches!(k.as_str(), "type" | "command" | "args" | "url"))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            for k in ["env", "headers"] {
                if let Some(value) = server.get(k).filter(|v| pyjson::truthy(v)) {
                    spec.insert(k.to_string(), Value::Object(kv_dict(value)));
                }
            }
            servers.insert(name.to_string(), Value::Object(spec));
        }
    }
    // a broken .mcp.json in the folder is not the run's fault: it reads as no servers
    let found = match folder.filter(|f| !f.is_empty()) {
        Some(folder) => folder_servers(folder, config_dir),
        None => Map::new(),
    };
    for (name, spec) in found {
        if !servers.contains_key(&name) {
            servers.insert(name, spec);
        }
    }
    json!({"mcpServers": servers})
}

/// The `--settings` of a run: the deny list, without repeats.
pub fn settings_json(deny: &[String]) -> Value {
    let mut seen: HashSet<&str> = HashSet::new();
    let kept: Vec<&str> = deny.iter().map(String::as_str).filter(|rule| seen.insert(rule)).collect();
    json!({"permissions": {"deny": kept}})
}

/// The keyword arguments of `args_for`.
#[derive(Debug, Clone, Default)]
pub struct ArgsFor<'a> {
    /// The CLI to start.
    pub path: &'a str,
    /// The first user message (an argument unless the run is live).
    pub prompt: &'a str,
    /// Whether the CLI takes its messages on stdin.
    pub live: bool,
    /// The file with the lead's system prompt.
    pub system_file: &'a str,
    /// The file with the roles' system prompt.
    pub sub_system_file: &'a str,
    /// The file with the team's agents, if it has roles.
    pub agents_file: Option<&'a str>,
    /// The MCP config (`--mcp-config`).
    pub mcp: Value,
    /// The settings (`--settings`).
    pub settings: Value,
    /// The schema of the final report, for a team's run.
    pub schema: Option<&'a Value>,
    /// The plugin folders.
    pub plugin_dirs: &'a [String],
    /// bypass | auto
    pub permission_mode: &'a str,
    /// Tools the team may not use.
    pub disallowed: &'a [String],
    /// The CLI session.
    pub session_id: &'a str,
    /// Whether the run continues that session.
    pub resume: bool,
    /// The session's name (a new session only).
    pub name: Option<&'a str>,
    /// The model.
    pub model: Option<&'a str>,
    /// The effort.
    pub effort: Option<&'a str>,
    /// Where the CLI writes its debug log.
    pub debug_file: Option<&'a str>,
    /// More folders the CLI may read and write.
    pub add_dirs: &'a [String],
}

/// The flag set of docs/specs/ai-v2.md, section 5.
pub fn args_for(a: &ArgsFor<'_>) -> Vec<String> {
    let mut args: Vec<String> = vec![a.path.to_string(), "-p".to_string()];
    let mut add = |more: &[&str]| args.extend(more.iter().map(|x| x.to_string()));
    if a.live {
        add(&["--input-format", "stream-json", "--replay-user-messages"]);
    } else {
        add(&[a.prompt]);
    }
    add(&[
        "--output-format",
        "stream-json",
        "--verbose",
        "--forward-subagent-text",
        "--include-hook-events",
        "--permission-mode",
        if a.permission_mode == "auto" { "auto" } else { "bypassPermissions" },
        "--settings",
        &pyjson::dumps(&a.settings),
        "--mcp-config",
        &pyjson::dumps(&a.mcp),
        "--strict-mcp-config",
        "--append-system-prompt-file",
        a.system_file,
        "--append-subagent-system-prompt-file",
        a.sub_system_file,
        "--system-prompt-snapshot",
        "off",
        // no settings file is read (the person's, the repository's, the local one): nothing of them leaks into a run,
        // and the configuration goes by flags (--settings, --plugin-dir, --mcp-config). Measured with CLI 2.1.316
        // (haiku): an empty value still loads the repository's CLAUDE.md and the --plugin-dir skills, while the
        // repository's hooks and "env" no longer apply. Sign-in does not come from settings.
        "--setting-sources",
        "",
    ]);
    if let Some(agents_file) = a.agents_file.filter(|f| !f.is_empty()) {
        add(&["--agents", agents_file]);
    }
    if let Some(schema) = a.schema.filter(|s| pyjson::truthy(s)) {
        add(&["--json-schema", &pyjson::dumps(schema)]);
    }
    for folder in a.plugin_dirs {
        add(&["--plugin-dir", folder]);
    }
    if !a.disallowed.is_empty() {
        add(&["--disallowedTools", &a.disallowed.join(",")]);
    }
    add(&[if a.resume { "--resume" } else { "--session-id" }, a.session_id]);
    if let Some(name) = a.name.filter(|n| !n.is_empty() && !a.resume) {
        add(&["--name", name]);
    }
    if let Some(model) = a.model.filter(|m| !m.is_empty()) {
        add(&["--model", model]);
    }
    if let Some(effort) = a.effort.filter(|e| !e.is_empty()) {
        add(&["--effort", effort]);
    }
    if let Some(debug_file) = a.debug_file.filter(|f| !f.is_empty()) {
        add(&["--debug-file", debug_file]);
    }
    for folder in a.add_dirs {
        add(&["--add-dir", folder]);
    }
    args
}

/// `_ticket_workspace`: the ticket's Workspace folder, made when the project has Workspace on (None otherwise): a
/// person looks for the reports, screenshots and logs of the AI there, and the CLI may write to it (`--add-dir`).
async fn ticket_workspace(session: &Session, run: &ai_run::Model) -> Option<String> {
    let ticket_id = run.ticket_id.as_deref().filter(|id| !id.is_empty())?;
    let info = match kb_board::workspace::get_workspace_path(session, ticket_id, true).await {
        Ok(info) => info?,
        // the Workspace is a convenience, never a reason for a run to fail
        Err(err) => {
            tracing::warn!(target: "kanban.ai.launch", "Workspace of {ticket_id} not available: {err:?}");
            return None;
        }
    };
    if !info.get("enabled").is_some_and(pyjson::truthy) {
        return None;
    }
    info.get("path").and_then(Value::as_str).map(str::to_string)
}

/// `env.update({key: value})`.
fn set_env(env: &mut Env, key: &str, value: &str) {
    match env.iter_mut().find(|(name, _)| name == key) {
        Some(slot) => slot.1 = value.to_string(),
        None => env.push((key.to_string(), value.to_string())),
    }
}

/// The keyword arguments of `prepare`.
#[derive(Debug, Clone, Copy, Default)]
pub struct PrepareOpts<'a> {
    /// The run's token for the board's MCP server and the hook scripts.
    pub token: &'a str,
    /// Where the board listens (`http://127.0.0.1:<port>`).
    pub board_url: &'a str,
    /// The folder the CLI works in (the ticket's worktree, or the team's working folder).
    pub cwd: &'a str,
    /// The CLI session.
    pub session_id: &'a str,
    /// Whether the run continues that session.
    pub resume: bool,
    /// What started the run, as text put before the request.
    pub note: Option<&'a str>,
    /// The ticket's Workspace folder when the caller already has it; None: looked up here.
    pub workspace: Option<&'a str>,
}

/// Everything the CLI of this run is started with. Writes the run's folder (agents, prompts, log).
pub async fn prepare(
    session: &Session,
    run: &ai_run::Model,
    profile: &ai_team::Model,
    member: &member::Model,
    opts: PrepareOpts<'_>,
) -> Result<Launch, Error> {
    let settings = get_settings(session, &run.project_id).await?;
    let cfg_ops = ops::get(Some(&settings));
    let stored = loads(Some(&profile.config), json!({}));
    let config = merged_config(stored.as_object());
    let team_roles = roles::roles_for(Some(session), &run.project_id, profile.pack_key.as_deref(), &config).await?;
    let live = cfg_ops.get("live_messages").is_none_or(pyjson::truthy);
    let workspace = match opts.workspace.filter(|w| !w.is_empty()) {
        Some(workspace) => Some(workspace.to_string()),
        None => ticket_workspace(session, run).await,
    };
    let (mut system, sub_system, prompt) = build_prompt(
        session,
        run,
        profile,
        member,
        PromptOpts {
            resume: opts.resume,
            note: opts.note,
            team_roles: &team_roles,
            live,
            workspace: workspace.as_deref(),
        },
    )
    .await?;
    // pictures the prompt names (/uploads/…), copied where the CLI may read them (hotfix 3.37.2)
    let (prompt, pictures_dir) = pictures::stage(&prompt, &run.id)?;
    let role_keys: HashSet<String> =
        team_roles.iter().map(|r| r.get("key").map(text_of).unwrap_or_else(|| "None".to_string())).collect();
    // the project's plugins are a convenience: a failure reads as none
    let (project_plugin_dirs, installed) = match (
        plugins::dirs_for(session, profile, Some(&role_keys)).await,
        plugins::skills_block(session, profile, Some(&role_keys)).await,
    ) {
        (Ok(dirs), Ok(block)) => (dirs, block),
        (Err(err), _) | (_, Err(err)) => {
            tracing::debug!(target: "kanban.ai.launch", "project plugins not resolved: {err}");
            (Vec::new(), String::new())
        }
    };
    if !installed.is_empty() {
        // a run that is only handed plugin folders seldom opens one: name what is installed for this team
        system = format!("{system}\n\n{installed}");
    }
    let folder = run_dir(&run.id, true)?;
    let system_file = folder.join("system.md");
    let sub_file = folder.join("subagent-system.md");
    std::fs::write(&system_file, &system)?;
    std::fs::write(&sub_file, &sub_system)?;
    let agents = roles::agents_json(&team_roles, "");
    let agents_file = folder.join("agents.json");
    std::fs::write(&agents_file, pyjson::Dumps::new().indent(1).dump(&agents))?;
    // plugins: the board's hooks, the board's skills, the plugins installed on the project for this team
    let mut plugin_dirs = vec![board_plugin_dir()?];
    let skills = board_skills::enabled_for(&cfg_ops, Some(&profile.id), &role_keys);
    if !skills.is_empty() {
        // the skills plugin is a convenience
        if let Ok(dir) = board_skills::plugin_dir(Some(&skills)) {
            plugin_dirs.push(dir);
        }
    }
    plugin_dirs.extend(project_plugin_dirs);
    let account_id =
        [run.account_id.as_deref(), profile.account_id.as_deref()].into_iter().flatten().find(|id| !id.is_empty());
    let account = match account_id {
        Some(id) => ai_account::Entity::find_by_id(id).one(session).await?,
        None => None,
    };
    let config_dir = accounts::claude_config_dir(account.as_ref());
    let base_env = cli::child_env(ops::auto_compact_pct(&cfg_ops));
    let mut env = match &account {
        Some(account) => accounts::env_for(account, &base_env).await.map_err(|err| Error::Other(err.to_string()))?,
        None => base_env,
    };
    set_env(&mut env, "KANBAN_URL", opts.board_url);
    set_env(&mut env, "KANBAN_RUN_TOKEN", opts.token);
    set_env(&mut env, "KANBAN_RUN_ID", &run.id);
    set_env(&mut env, "KANBAN_WORKTREE", opts.cwd); // the PreToolUse hook keeps `rm -r` inside it
    let mut deny: Vec<String> = DEFAULT_DENY.iter().map(|rule| rule.to_string()).collect();
    if let Value::Array(rules) = loads(Some(&settings.deny_list), json!([])) {
        deny.extend(rules.iter().filter(|r| pyjson::truthy(r)).map(text_of));
    }
    let mode = [profile.permission_mode.as_str(), settings.permission_mode.as_str(), "bypass"]
        .into_iter()
        .find(|m| !m.is_empty())
        .unwrap_or("bypass");
    let (path, _checked) = cli::find_cli("claude", profile.cli_path.as_deref()).await;
    let Some(path) = path.filter(|p| !p.is_empty()) else {
        return Err(Error::Runtime(cli::missing("claude", profile.cli_path.as_deref()).await));
    };
    let debug_file = path_text(&folder.join("debug.log"));
    let mcp_shown = mcp_config(&config, RUN_TOKEN_SHOWN, Some(opts.cwd), config_dir.as_deref(), opts.board_url);
    let mut mcp_real = mcp_shown.clone();
    mcp_real["mcpServers"]["kanban"]["headers"]["Authorization"] = json!(format!("Bearer {}", opts.token));
    let disallowed: Vec<String> = match config.get("disallowed_tools").filter(|v| pyjson::truthy(v)) {
        Some(Value::Array(tools)) => tools.iter().map(text_of).collect(),
        _ => Vec::new(),
    };
    let effort = [run.effort.clone(), profile.effort.clone()]
        .into_iter()
        .flatten()
        .find(|e| !e.is_empty())
        .or_else(|| config.get("effort").filter(|v| pyjson::truthy(v)).map(text_of));
    let model = [run.model.as_deref(), profile.model.as_deref()].into_iter().flatten().find(|m| !m.is_empty());
    let add_dirs: Vec<String> = [workspace, pictures_dir].into_iter().flatten().filter(|d| !d.is_empty()).collect();
    let (system_file, sub_file, agents_file) = (path_text(&system_file), path_text(&sub_file), path_text(&agents_file));
    let args = args_for(&ArgsFor {
        path: &path,
        prompt: &prompt,
        live,
        system_file: &system_file,
        sub_system_file: &sub_file,
        agents_file: (!agents.is_empty()).then_some(agents_file.as_str()),
        mcp: mcp_real,
        settings: settings_json(&deny),
        schema: (run.kind == "team").then_some(&*REPORT_SCHEMA),
        plugin_dirs: &plugin_dirs,
        permission_mode: mode,
        disallowed: &disallowed,
        session_id: opts.session_id,
        resume: opts.resume,
        name: run.session_name.as_deref(),
        model,
        effort: effort.as_deref(),
        debug_file: Some(&debug_file),
        add_dirs: &add_dirs,
    });
    let record_args = with_mcp(&args, &mcp_shown);
    Ok(Launch {
        args,
        cwd: opts.cwd.to_string(),
        env,
        prompt,
        system,
        live,
        resume: opts.resume,
        session_id: opts.session_id.to_string(),
        run_dir: path_text(&folder),
        scratch: Vec::new(),
        plugin_dirs,
        agents,
        record_args,
    })
}

/// `_with_mcp`: `args` with another `--mcp-config` value.
pub fn with_mcp(args: &[String], mcp: &Value) -> Vec<String> {
    let mut out = args.to_vec();
    if let Some(at) = out.iter().position(|a| a == "--mcp-config") {
        if let Some(slot) = out.get_mut(at + 1) {
            *slot = pyjson::dumps(mcp);
        }
    }
    out
}

/// The CLI's debug log of a run, if it wrote one.
pub fn debug_file_of(run_id: &str) -> Option<String> {
    let p = data_root().ok()?.join("runs").join(run_id).join("debug.log");
    p.exists().then(|| path_text(&p))
}

/// For tests: the environment a hook script needs.
pub fn file_env() -> Env {
    cli::os_environ().into_iter().filter(|(k, _)| k.starts_with("KANBAN_")).collect()
}
