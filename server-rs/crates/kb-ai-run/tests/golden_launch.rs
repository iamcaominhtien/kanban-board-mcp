//! `launch` against what the Python module gave (`contract/golden/ai_launch.json`, made by `gen_ai_launch.py`): the
//! pure functions and the constants, the files of the board's plugin, and `launch::prepare` over a matrix of
//! situations (work and ask runs, resumed runs, a run on a Docs page, every pack, plugins, pictures, permission modes,
//! models, accounts, MCP servers of the folder and of the team, knowledge), each built from the rows the Python models
//! dumped. Compared: the command line, the settings JSON, the MCP config, the prompt, the system prompts, the agents
//! JSON, the plugin folders and the environment of the child.

mod common;

use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use kb_ai::context::RunContext;
use kb_ai_know::roles::Role;
use kb_ai_run::launch::{self, ArgsFor, PrepareOpts};
use kb_ai_run::seams;
use kb_base::pyjson;
use kb_db::Session;
use kb_db::database;
use kb_db::entities::{ai_run, ai_team, member, ticket};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{DbErr, EntityTrait, TryIntoModel};
use serde_json::{Value, json};

/// What the board's own environment holds besides the folders (`BOARD_ENV` of the generator): variables a child must
/// not inherit, and credentials an account's login must not be outranked by.
const BOARD_ENV: [(&str, &str); 5] = [
    ("CLAUDECODE", "1"),
    ("CLAUDE_CODE_ENTRYPOINT", "cli"),
    ("CLAUDE_CODE_SESSION_ID", "board-session"),
    ("ANTHROPIC_API_KEY", "sk-ant-board-key"),
    ("CLAUDE_CODE_OAUTH_TOKEN", "board-oauth"),
];
const TOKEN: &str = "kbr_tttttttttttttttttttttttt";
const BOARD_URL: &str = "http://127.0.0.1:8123";

fn golden() -> Value {
    common::golden("ai_launch.json")
}

/// A text this process made, as the golden file writes it (the run's token included).
fn shown(text: &str) -> String {
    common::golden_text(text).replace(TOKEN, "<TOKEN>")
}

fn opt(value: &Value) -> Option<&str> {
    value.as_str()
}

fn texts(value: &Value) -> Vec<String> {
    value.as_array().expect("a list").iter().map(|a| a.as_str().expect("text").to_string()).collect()
}

fn ctx_of(c: &Value) -> RunContext {
    RunContext {
        run_id: c["run_id"].as_str().expect("run_id").into(),
        member_id: c["member_id"].as_str().expect("member_id").into(),
        member_name: c["member_name"].as_str().expect("member_name").into(),
        project_id: c["project_id"].as_str().expect("project_id").into(),
        ticket_id: c["ticket_id"].as_str().map(str::to_string),
        on_behalf_of: c["on_behalf_of"].as_str().expect("on_behalf_of").into(),
        mode: c["mode"].as_str().expect("mode").into(),
        ..Default::default()
    }
}

fn roles_of(set: &Value) -> Vec<Role> {
    set.as_array().expect("roles").iter().map(|r| r.as_object().expect("a role").clone()).collect()
}

#[tokio::test]
async fn the_constants_and_the_plugin_are_python_s() {
    let _guard = common::init_with(&BOARD_ENV).await;
    let g = golden();
    let (p, blobs) = (&g["pure"], &g["blobs"]);
    let c = &p["constants"];
    assert_eq!(json!(launch::BOARD_PLUGIN_VERSION), c["BOARD_PLUGIN_VERSION"]);
    assert_eq!(json!(launch::RUN_TOKEN_SHOWN), c["RUN_TOKEN_SHOWN"]);
    assert_eq!(json!(launch::DEFAULT_DENY), c["DEFAULT_DENY"]);
    common::same_text(&pyjson::dumps(&*launch::REPORT_SCHEMA), &c["REPORT_SCHEMA"], blobs, "REPORT_SCHEMA");
    let notes = c["RUN_NOTES"].as_array().expect("notes");
    assert_eq!(notes.len(), launch::RUN_NOTES.len());
    for (want, (key, text)) in notes.iter().zip(launch::RUN_NOTES) {
        assert_eq!(want[0], json!(key));
        common::same_text(text, &want[1], blobs, key);
        assert_eq!(launch::run_note(key), Some(text));
    }
    assert_eq!(launch::run_note("assign"), None);
    let mut code_roles = launch::CODE_ROLES.to_vec();
    code_roles.sort_unstable();
    assert_eq!(json!(code_roles), c["CODE_ROLES"]);
    common::same_text(&launch::hook_script_posix(), &c["hook_script_posix"], blobs, "post.sh");
    common::same_text(&launch::hook_script_windows(), &c["hook_script_windows"], blobs, "post.cmd");

    assert_eq!(json!(shown(&launch::data_root().expect("root").to_string_lossy())), p["data_root"]);
    let root = launch::board_plugin_dir().expect("plugin");
    assert_eq!(launch::board_plugin_dir().expect("plugin"), root); // written once per version
    assert_eq!(json!(shown(&root)), p["board_plugin"]["dir"]);
    let mut found = Vec::new();
    for sub in [".", ".claude-plugin", "hooks"] {
        for entry in std::fs::read_dir(Path::new(&root).join(sub)).expect("folder").flatten() {
            if entry.path().is_file() {
                let rel = entry.path().strip_prefix(&root).expect("inside").to_string_lossy().into_owned();
                found.push(rel);
            }
        }
    }
    found.sort();
    let want = p["board_plugin"]["files"].as_array().expect("files");
    assert_eq!(json!(found), json!(want.iter().map(|f| f[0].clone()).collect::<Vec<_>>()));
    for file in want {
        let rel = file[0].as_str().expect("name");
        let path = Path::new(&root).join(rel);
        common::same_text(&std::fs::read_to_string(&path).expect("file"), &file[1], blobs, rel);
        use std::os::unix::fs::PermissionsExt;
        let executable = std::fs::metadata(&path).expect("meta").permissions().mode() & 0o111 != 0;
        assert_eq!(json!(executable), file[2], "{rel}");
    }

    for case in p["run_dir"].as_array().expect("cases") {
        let run_id = case["run_id"].as_str().expect("id");
        match launch::run_dir(run_id, false) {
            Ok(path) => assert_eq!(json!(shown(&path.to_string_lossy())), case["out"], "{run_id:?}"),
            Err(launch::Error::Value(message)) => assert_eq!(json!(message), case["error"], "{run_id:?}"),
            Err(other) => panic!("{run_id:?}: {other}"),
        }
    }
    // nothing was made by asking, and a folder is made when asked for
    assert!(!launch::data_root().expect("root").join("runs").join("run_new").exists());
    assert!(launch::run_dir("run_made", true).expect("made").is_dir());
    launch::forget_run_dir("run_made");
    assert!(!launch::data_root().expect("root").join("runs").join("run_made").exists());
    assert_eq!(launch::debug_file_of("run_made"), None);
    assert!(launch::file_env().iter().all(|(k, _)| k.starts_with("KANBAN_")));
    assert!(launch::file_env().iter().any(|(k, _)| k == "KANBAN_DB_PATH"));
}

#[test]
fn the_rules_of_the_lead_and_of_the_roles() {
    let g = golden();
    let (p, blobs) = (&g["pure"], &g["blobs"]);
    let cases = p["board_rules"].as_array().expect("cases");
    assert!(cases.len() > 60);
    for case in cases {
        let roles = roles_of(&p["role_sets"][case["roles"].as_str().expect("set")]);
        let got = launch::board_rules(
            &ctx_of(&case["ctx"]),
            case["project"].as_str().expect("project"),
            &roles,
            case["live"].as_bool().expect("live"),
            opt(&case["workspace"]),
        );
        let what = format!("board_rules {} {} {}", case["ctx"], case["roles"], case["workspace"]);
        common::same_text(&got, &case["out"], blobs, &what);
    }
    for case in p["subagent_rules"].as_array().expect("cases") {
        let got = launch::subagent_rules(&ctx_of(&case["ctx"]), opt(&case["workspace"]));
        common::same_text(&got, &case["out"], blobs, &format!("subagent_rules {}", case["workspace"]));
    }
    let names: HashSet<String> = ["Dev An", "Reviewer Bot"].iter().map(|s| s.to_string()).collect();
    for case in p["recent_comments"].as_array().expect("cases") {
        let mut row = ticket::new();
        row.id = Set("KAN-9".into());
        row.project_id = Set("p1".into());
        row.title = Set("T".into());
        row.comments = Set(case["comments"].as_str().expect("comments").into());
        let row = row.try_into_model().expect("a ticket");
        let got = launch::recent_comments(&row, opt(&case["since"]), &names);
        common::same_text(&got, &case["out"], blobs, &format!("recent_comments since {}", case["since"]));
    }
}

fn args_of(kw: &Value) -> Vec<String> {
    let plugin_dirs = texts(&kw["plugin_dirs"]);
    let disallowed = texts(&kw["disallowed"]);
    let add_dirs = if kw["add_dirs"].is_null() { Vec::new() } else { texts(&kw["add_dirs"]) };
    let schema = match &kw["schema"] {
        Value::String(s) if s == "REPORT" => Some(launch::REPORT_SCHEMA.clone()),
        Value::Null => None,
        other => Some(other.clone()),
    };
    launch::args_for(&ArgsFor {
        path: kw["path"].as_str().expect("path"),
        prompt: kw["prompt"].as_str().expect("prompt"),
        live: kw["live"].as_bool().expect("live"),
        system_file: kw["system_file"].as_str().expect("system"),
        sub_system_file: kw["sub_system_file"].as_str().expect("sub"),
        agents_file: opt(&kw["agents_file"]),
        mcp: kw["mcp"].clone(),
        settings: kw["settings"].clone(),
        schema: schema.as_ref(),
        plugin_dirs: &plugin_dirs,
        permission_mode: kw["permission_mode"].as_str().expect("mode"),
        disallowed: &disallowed,
        session_id: kw["session_id"].as_str().expect("session"),
        resume: kw["resume"].as_bool().expect("resume"),
        name: opt(&kw["name"]),
        model: opt(&kw["model"]),
        effort: opt(&kw["effort"]),
        debug_file: opt(&kw["debug_file"]),
        add_dirs: &add_dirs,
    })
}

fn same_args(got: &[String], want: &Value, blobs: &Value, what: &str) {
    let want = want.as_array().expect("args");
    let flags = |args: &[String]| args.iter().filter(|a| a.starts_with("--") || *a == "-p").cloned().collect::<Vec<_>>();
    assert_eq!(got.len(), want.len(), "{what}: {:?}", flags(got));
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        common::same_text(&shown(g), w, blobs, &format!("{what}: argument {i}"));
    }
}

#[test]
fn the_command_line_the_settings_and_the_mcp_config() {
    let g = golden();
    let (p, blobs) = (&g["pure"], &g["blobs"]);
    for case in p["kv_dict"].as_array().expect("cases") {
        assert_eq!(Value::Object(launch::kv_dict(&case["value"])), case["out"], "{}", case["value"]);
    }
    for case in p["mcp_config"].as_array().expect("cases") {
        let config = case["config"].as_object().expect("config");
        let got = launch::mcp_config(
            config,
            case["token"].as_str().expect("token"),
            None,
            None,
            case["board_url"].as_str().expect("url"),
        );
        assert_eq!(got, case["out"], "{}", case["config"]);
        common::same_text(&pyjson::dumps(&got), &case["dumps"], blobs, "mcp_config");
    }
    for case in p["settings_json"].as_array().expect("cases") {
        let got = launch::settings_json(&texts(&case["deny"]));
        assert_eq!(got, case["out"]);
        assert_eq!(json!(pyjson::dumps(&got)), case["dumps"]);
    }
    for case in p["args_for"].as_array().expect("cases") {
        same_args(&args_of(&case["kwargs"]), &case["out"], blobs, &format!("args_for {}", case["kwargs"]["name"]));
    }
    for case in p["with_mcp"].as_array().expect("cases") {
        assert_eq!(json!(launch::with_mcp(&texts(&case["args"]), &case["mcp"])), case["out"]);
    }
}

/// `session_history.prompt_block` as the generator replaced it: the text of the case.
struct History(String);

#[async_trait::async_trait]
impl seams::SessionHistory for History {
    async fn prompt_block(&self, _session: &Session, _ticket_id: &str) -> Result<String, DbErr> {
        Ok(self.0.clone())
    }
}

/// The child's environment as its difference from this process's: what was set or changed, what was removed.
fn env_delta(env: &[(String, String)]) -> Value {
    let base: BTreeMap<String, String> = std::env::vars().collect();
    let child: BTreeMap<&str, &str> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let set: BTreeMap<&str, String> = child
        .iter()
        .filter(|(k, v)| base.get(**k).map(String::as_str) != Some(**v))
        .map(|(k, v)| (*k, shown(v)))
        .collect();
    let removed: Vec<&String> = base.keys().filter(|k| !child.contains_key(k.as_str())).collect();
    json!({"set": set, "removed": removed})
}

#[tokio::test]
async fn prepare_gives_what_python_gives() {
    let _guard = common::init_with(&BOARD_ENV).await;
    let g = golden();
    for (key, value) in g["board_env"].as_object().expect("env") {
        assert_eq!(std::env::var(key).ok().as_deref(), value.as_str(), "{key}: the generator's board environment");
    }
    let blobs = &g["blobs"];
    let cases = g["cases"].as_array().expect("cases");
    assert!(cases.len() >= 50);
    for case in cases {
        let name = case["name"].as_str().expect("name");
        for dir in case["dirs"].as_array().expect("dirs") {
            std::fs::create_dir_all(common::local_text(dir.as_str().expect("dir"))).expect("folder");
        }
        for file in case["files"].as_array().expect("files") {
            let path = common::local_text(file["path"].as_str().expect("path"));
            std::fs::create_dir_all(Path::new(&path).parent().expect("parent")).expect("folder");
            std::fs::write(&path, common::local_text(file["text"].as_str().expect("text"))).expect("file");
        }
        common::insert_all(&case["rows"]).await;
        seams::set_session_history(
            case["history"].as_str().map(|text| Arc::new(History(text.to_string())) as Arc<dyn seams::SessionHistory>),
        );
        let session = database::session();
        let team_id = format!("p-{name}-team");
        let run = ai_run::Entity::find_by_id(format!("run_{name}")).one(&session).await.expect("db").expect("run");
        let profile = ai_team::Entity::find_by_id(team_id.as_str()).one(&session).await.expect("db").expect("team");
        let member = member::Entity::find_by_id(team_id.as_str()).one(&session).await.expect("db").expect("member");
        let call = common::to_local(&case["call"]);
        let prepared = launch::prepare(
            &session,
            &run,
            &profile,
            &member,
            PrepareOpts {
                token: TOKEN,
                board_url: BOARD_URL,
                cwd: call["cwd"].as_str().expect("cwd"),
                session_id: call["session_id"].as_str().expect("session"),
                resume: call["resume"].as_bool().expect("resume"),
                note: opt(&call["note"]),
                workspace: opt(&call["workspace"]),
            },
        )
        .await;
        drop(session);
        let want = &case["out"];
        let l = match prepared {
            Ok(l) => {
                assert!(want["error"].is_null(), "{name}: Python raised {}", want["error"]);
                l
            }
            Err(err) => {
                let kind = want["error"][0].as_str().unwrap_or_else(|| panic!("{name}: {err}"));
                match (&err, kind) {
                    (launch::Error::Runtime(m), "RuntimeError") | (launch::Error::Value(m), "ValueError") => {
                        common::same_text(&shown(m), &want["error"][1], blobs, &format!("{name}: error"));
                    }
                    (launch::Error::Other(_), other) if !matches!(other, "RuntimeError" | "ValueError") => {}
                    _ => panic!("{name}: {err:?} where Python raised {kind}"),
                }
                continue;
            }
        };
        same_args(&l.args, &want["args"], blobs, &format!("{name}: args"));
        same_args(&l.record_args, &want["record_args"], blobs, &format!("{name}: record_args"));
        // the token is in the board's MCP header of the real arguments only
        assert!(l.args.join(" ").contains(TOKEN) && !l.record_args.join(" ").contains(TOKEN), "{name}");
        let flag = |args: &[String], flag: &str| -> String {
            let at = args.iter().position(|a| a == flag).unwrap_or_else(|| panic!("{name}: no {flag}"));
            args[at + 1].clone()
        };
        let recorded: Value = serde_json::from_str(&flag(&l.record_args, "--mcp-config")).expect("mcp");
        assert_eq!(common::to_golden(&recorded), want["mcp"], "{name}: mcp");
        assert_eq!(
            recorded["mcpServers"].as_object().expect("servers").keys().collect::<Vec<_>>(),
            want["mcp"]["mcpServers"].as_object().expect("servers").keys().collect::<Vec<_>>(),
            "{name}: the order of the MCP servers"
        );
        let settings: Value = serde_json::from_str(&flag(&l.args, "--settings")).expect("settings");
        assert_eq!(settings, want["settings"], "{name}: settings");
        assert_eq!(json!(shown(&l.cwd)), want["cwd"], "{name}: cwd");
        assert_eq!(env_delta(&l.env), want["env"], "{name}: env");
        common::same_text(&shown(&l.prompt), &want["prompt"], blobs, &format!("{name}: prompt"));
        common::same_text(&shown(&l.system), &want["system"], blobs, &format!("{name}: system"));
        assert_eq!(json!(l.live), want["live"], "{name}: live");
        assert_eq!(json!(l.resume), want["resume"], "{name}: resume");
        assert_eq!(json!(l.session_id), want["session_id"], "{name}: session");
        assert_eq!(json!(shown(&l.run_dir)), want["run_dir"], "{name}: run_dir");
        assert_eq!(json!(l.scratch), want["scratch"], "{name}: scratch");
        assert_eq!(json!(l.plugin_dirs.iter().map(|d| shown(d)).collect::<Vec<_>>()), want["plugin_dirs"], "{name}");
        assert_eq!(json!(l.agents.keys().collect::<Vec<_>>()), want["agent_keys"], "{name}: agents");
        let agents = pyjson::Dumps::new().indent(1).dump(&l.agents);
        common::same_text(&shown(&agents), &want["agents"], blobs, &format!("{name}: agents"));
        for (file, text) in want["files"].as_object().expect("files") {
            let got = std::fs::read_to_string(Path::new(&l.run_dir).join(file)).expect("a file of the run");
            common::same_text(&shown(&got), text, blobs, &format!("{name}: {file}"));
        }
        let skills = match l.plugin_dirs.get(1).filter(|d| d.contains("board-skills")) {
            Some(dir) => {
                let mut names: Vec<String> = std::fs::read_dir(Path::new(dir).join("skills"))
                    .expect("skills")
                    .flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect();
                names.sort();
                json!(names)
            }
            None => Value::Null,
        };
        assert_eq!(skills, want["skills"], "{name}: the board's skills in the plugin folder");
    }
    seams::set_session_history(None);
}
