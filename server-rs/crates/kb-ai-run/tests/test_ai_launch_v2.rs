//! `server/tests/test_ai_launch_v2.py`: what a run's Claude Code CLI is started with (`launch`) and how its
//! stream-json output becomes step rows (`stream`).
//!
//! The tests of the stream are pure functions (no run, no CLI). The tests of the launcher come after them, in the
//! order of the Python file; those that call `launch::prepare` build their rows with `common`. Elsewhere:
//! `test_board_skills_follow_the_teams_roles` (`crates/kb-ai-know/tests/test_shared_skills_277.rs`) and the `roles`
//! half of `test_each_role_is_told_to_open_its_guide_and_the_lead_gets_the_skill_table`
//! (`crates/kb-ai-know/tests/test_ai_launch_v2.rs`). `test_the_docs_skill_says_a_written_result_is_a_page_not_a_repository_file`
//! tests `docs_guide` (`kb-doctext`), not `launch`. Python replaces `launch.data_root` with a temporary folder; here
//! the whole process has its own data folder, so the real one is used.

mod common;

use std::collections::HashSet;
use std::path::Path;

use kb_ai::context::RunContext;
use kb_ai_run::launch::{self, ArgsFor};
use kb_ai_run::stream::Parser;
use kb_base::pyjson;
use serde_json::{Value, json};

fn line(obj: Value) -> String {
    pyjson::dumps(&obj)
}

fn tool(name: &str, inp: Value, tid: &str, parent: Option<&str>) -> String {
    line(json!({
        "type": "assistant",
        "parent_tool_use_id": parent,
        "message": {"content": [{"type": "tool_use", "id": tid, "name": name, "input": inp}]},
    }))
}

fn parse(p: &mut Parser, text: &str) -> Value {
    p.parse(text).expect("the parser takes the line").to_value()
}

#[test]
fn test_init_gives_the_session_the_model_and_what_was_loaded() {
    let out = parse(
        &mut Parser::new("/w", None),
        &line(json!({
            "type": "system",
            "subtype": "init",
            "session_id": "s1",
            "model": "claude-haiku",
            "agents": ["dev", "reviewer"],
            "plugins": [{"name": "kanban-board"}, "bad"],
            "tools": ["Bash"],
        })),
    );
    assert!(out["ready"] == true && out["session_id"] == "s1" && out["model"] == "claude-haiku");
    assert_eq!(out["init"], json!({"agents": ["dev", "reviewer"], "plugins": ["kanban-board"], "tools": ["Bash"]}));
}

#[test]
fn test_a_subagents_steps_are_credited_to_the_agent_call_that_started_it() {
    let mut p = Parser::new("/w", None);
    let started = parse(
        &mut p,
        &tool("Agent", json!({"subagent_type": "reviewer", "description": "Review the diff"}), "call1", None),
    );
    assert_eq!(started["agents"], json!([{"id": "call1", "agent_type": "reviewer"}]));
    assert!(started["rows"][0]["kind"] == "subagent" && started["rows"][0]["agent_id"].is_null());
    assert!(started["rows"][0]["title"].as_str().expect("title").starts_with("Asked reviewer: Review the diff"));
    let inner = parse(&mut p, &tool("Bash", json!({"command": "pytest -q"}), "t2", Some("call1")));
    assert!(inner["rows"][0]["agent_id"] == "call1" && inner["rows"][0]["detail"]["command"] == "pytest -q");
    let said = parse(
        &mut p,
        &line(json!({
            "type": "assistant",
            "parent_tool_use_id": "call1",
            "message": {"content": [{"type": "text", "text": "Two findings."}]},
        })),
    );
    assert_eq!(said["agents"], json!([{"id": "call1", "last_text": "Two findings."}]));
    // the lead's own text is not an agent's
    let lead =
        parse(&mut p, &line(json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "Done."}]}})));
    assert!(lead["agents"] == json!([]) && lead["rows"][0]["agent_id"].is_null());
    assert_eq!(p.agent_types.get("call1").map(String::as_str), Some("reviewer"));
}

#[test]
fn test_plans_messages_and_the_report_are_their_own_kinds_and_tool_search_is_skipped() {
    let mut p = Parser::new("/w", None);
    assert_eq!(parse(&mut p, &tool("ToolSearch", json!({"query": "x"}), "t0", None))["rows"], json!([]));
    let plan =
        parse(&mut p, &tool("TaskCreate", json!({"subject": "Write the migration"}), "t1", None))["rows"][0].clone();
    assert!(plan["kind"] == "plan" && plan["title"] == "Write the migration");
    let sent = parse(&mut p, &tool("SendMessage", json!({"to": "IAM-7", "message": "API is ready"}), "t2", None));
    assert_eq!(sent["messages_out"], json!([{"peer": "IAM-7", "text": "API is ready", "agent_id": null}]));
    assert!(sent["rows"][0]["kind"] == "message");
    assert_eq!(sent["rows"][0]["detail"], json!({"direction": "out", "peer": "IAM-7"}));
    assert_eq!(
        parse(&mut p, &tool("StructuredOutput", json!({"status": "done"}), "t3", None))["rows"][0]["kind"],
        "report"
    );
}

#[test]
fn test_a_message_from_another_session_is_a_step_and_a_replayed_message_is_not() {
    let mut p = Parser::new("/w", None);
    let text = "<cross-session-message from=\"docs-assistant\">Page updated</cross-session-message>";
    let got = parse(&mut p, &line(json!({"type": "user", "message": {"content": text}})));
    assert_eq!(got["messages_in"], json!([{"peer": "docs-assistant", "text": "Page updated", "agent_id": null}]));
    assert_eq!(got["rows"][0]["title"], "From docs-assistant: Page updated");
    let replay = parse(&mut p, &line(json!({"type": "user", "isReplay": true, "message": {"content": text}})));
    assert!(replay["rows"] == json!([]) && replay["messages_in"] == json!([]));
}

#[test]
fn test_a_failed_tool_result_is_an_error_step_and_carries_its_exit_code() {
    let got = parse(
        &mut Parser::new("/w", None),
        &line(json!({
            "type": "user",
            "message": {"content": [
                {"type": "tool_result", "tool_use_id": "t9", "is_error": true, "content": "Exit code 2\nboom"}
            ]},
        })),
    );
    assert!(got["results"][0]["exit_code"] == 2 && got["results"][0]["tool_id"] == "t9");
    assert!(got["rows"][0]["kind"] == "error" && got["rows"][0]["parent_tool_id"] == "t9");
}

#[test]
fn test_the_result_carries_the_structured_report_or_reads_it_from_json_text() {
    let mut p = Parser::new("/w", None);
    let out = parse(
        &mut p,
        &line(json!({
            "type": "result",
            "subtype": "success",
            "session_id": "s1",
            "result": "",
            "structured_output": {"status": "done", "summary": "ok"},
            "usage": {"input_tokens": 10, "cache_read_input_tokens": 90, "output_tokens": 5},
            "total_cost_usd": 0.01,
            "modelUsage": {"m": {"contextWindow": 200000}},
        })),
    );
    let r = &out["result"];
    assert!(r["structured"] == json!({"status": "done", "summary": "ok"}) && r["is_error"] == false);
    assert_eq!((&r["tokens_in"], &r["tokens_cached"], &r["tokens_out"]), (&json!(100), &json!(90), &json!(5)));
    assert!(out["context_window"] == 200000 && out["session_id"] == "s1");
    let text = parse(
        &mut p,
        &line(
            json!({"type": "result", "subtype": "success", "result": "{\"status\": \"partial\", \"summary\": \"half\"}"}),
        ),
    );
    assert_eq!(text["result"]["structured"]["status"], "partial");
    let failed = parse(&mut p, &line(json!({"type": "result", "subtype": "error_max_turns", "result": "stopped"})));
    assert!(failed["result"]["is_error"] == true && failed["result"]["structured"].is_null());
}

#[test]
fn test_secrets_in_commands_are_redacted_and_lines_that_are_not_json_are_ignored() {
    let mut p = Parser::new("/w", None);
    // a made-up value, built here so no scanner reads it as a real token
    let fake = format!("{}{}", "z".repeat(6), "9".repeat(6));
    let header = format!("Authorization: {}{} {fake}", "Bear", "er");
    let row = parse(&mut p, &tool("Bash", json!({"command": format!("curl -H '{header}' x")}), "t1", None))["rows"][0]
        .clone();
    let (command, title) = (row["detail"]["command"].as_str().expect("command"), row["title"].as_str().expect("title"));
    assert!(!command.contains(&fake) && !title.contains(&fake));
    assert!(parse(&mut p, "not json")["rows"] == json!([]) && parse(&mut p, "{broken")["rows"] == json!([]));
}

/// Not in the Python file: a value of the wrong type ends the reading where Python raises.
#[test]
fn a_value_of_the_wrong_type_is_an_error_where_python_raises() {
    let mut p = Parser::new("/w", None);
    assert!(p.parse(&line(json!({"type": "assistant", "message": {"content": 5}}))).is_err());
    assert!(p.parse(&tool("Bash", json!({"command": 5}), "t1", None)).is_err());
    // and the parser goes on with the next line
    assert_eq!(parse(&mut p, &tool("Bash", json!({"command": "ls"}), "t2", None))["rows"][0]["kind"], "command");
}

// --------------------------------------------------------------------------- the flag set

/// `_args(**over)`: the arguments of a new run, with what a test changes.
fn args(edit: impl FnOnce(&mut ArgsFor<'static>)) -> Vec<String> {
    static PLUGINS: std::sync::LazyLock<Vec<String>> =
        std::sync::LazyLock::new(|| vec!["/p/board".to_string(), "/p/skills".to_string()]);
    let mut a = ArgsFor {
        path: "/bin/claude",
        prompt: "Do the ticket",
        live: false,
        system_file: "/r/system.md",
        sub_system_file: "/r/sub.md",
        agents_file: Some("/r/agents.json"),
        mcp: json!({"mcpServers": {}}),
        settings: launch::settings_json(&["Bash(rm -rf /*)".to_string()]),
        schema: Some(&*launch::REPORT_SCHEMA),
        plugin_dirs: &PLUGINS,
        permission_mode: "bypass",
        disallowed: &[],
        session_id: "11111111-2222-3333-4444-555555555555",
        resume: false,
        name: Some("IAM-12 · Dev An"),
        model: Some("haiku"),
        effort: None,
        debug_file: Some("/r/debug.log"),
        add_dirs: &[],
    };
    edit(&mut a);
    launch::args_for(&a)
}

fn has(args: &[String], flag: &str) -> bool {
    args.iter().any(|a| a == flag)
}

#[test]
fn test_a_new_run_gets_the_whole_flag_set() {
    let a = args(|_| {});
    assert_eq!(a[..3], ["/bin/claude", "-p", "Do the ticket"]);
    for flag in ["--verbose", "--forward-subagent-text", "--include-hook-events", "--strict-mcp-config"] {
        assert!(has(&a, flag), "{flag}");
    }
    assert_eq!(common::flag(&a, "--output-format"), "stream-json");
    assert_eq!(common::flag(&a, "--permission-mode"), "bypassPermissions");
    assert_eq!(common::flag(&a, "--append-system-prompt-file"), "/r/system.md");
    assert_eq!(common::flag(&a, "--append-subagent-system-prompt-file"), "/r/sub.md");
    assert_eq!(common::flag(&a, "--system-prompt-snapshot"), "off");
    assert_eq!(common::flag(&a, "--setting-sources"), ""); // no settings file is read
    assert_eq!(common::flag(&a, "--agents"), "/r/agents.json");
    let schema: Value = serde_json::from_str(&common::flag(&a, "--json-schema")).expect("schema");
    assert_eq!(schema["required"], json!(["status", "summary"]));
    let settings: Value = serde_json::from_str(&common::flag(&a, "--settings")).expect("settings");
    assert_eq!(settings, json!({"permissions": {"deny": ["Bash(rm -rf /*)"]}}));
    let plugin_dirs: Vec<&String> =
        a.iter().enumerate().filter(|(_, x)| *x == "--plugin-dir").map(|(i, _)| &a[i + 1]).collect();
    assert_eq!(plugin_dirs, ["/p/board", "/p/skills"]);
    assert!(common::flag(&a, "--session-id").starts_with("1111") && !has(&a, "--resume"));
    assert_eq!(common::flag(&a, "--name"), "IAM-12 · Dev An");
    assert!(common::flag(&a, "--model") == "haiku" && !has(&a, "--effort"));
    assert_eq!(common::flag(&a, "--debug-file"), "/r/debug.log");
    assert!(!has(&a, "--disallowedTools") && !has(&a, "--add-dir"));
}

#[test]
fn test_a_live_run_reads_its_prompt_from_stdin() {
    let a = args(|a| a.live = true);
    assert!(!has(&a, "Do the ticket"));
    assert!(common::flag(&a, "--input-format") == "stream-json" && has(&a, "--replay-user-messages"));
}

#[test]
fn test_a_resumed_run_continues_its_session_without_renaming_it() {
    let a = args(|a| a.resume = true);
    assert!(common::flag(&a, "--resume").starts_with("1111"));
    assert!(!has(&a, "--session-id") && !has(&a, "--name"));
}

#[test]
fn test_permission_mode_is_bypass_unless_auto() {
    for (mode, flag) in [("auto", "auto"), ("bypass", "bypassPermissions"), ("", "bypassPermissions")] {
        assert_eq!(common::flag(&args(|a| a.permission_mode = mode), "--permission-mode"), flag, "{mode:?}");
    }
}

#[test]
fn test_optional_flags_appear_only_when_set() {
    static DISALLOWED: std::sync::LazyLock<Vec<String>> =
        std::sync::LazyLock::new(|| vec!["WebFetch".to_string(), "WebSearch".to_string()]);
    static ADD: std::sync::LazyLock<Vec<String>> = std::sync::LazyLock::new(|| vec!["/ws".to_string()]);
    let a = args(|a| {
        a.agents_file = None;
        a.schema = None;
        a.plugin_dirs = &[];
        a.disallowed = &DISALLOWED;
        a.effort = Some("high");
        a.add_dirs = &ADD;
    });
    assert!(!has(&a, "--agents") && !has(&a, "--json-schema") && !has(&a, "--plugin-dir"));
    assert_eq!(common::flag(&a, "--disallowedTools"), "WebFetch,WebSearch");
    assert!(common::flag(&a, "--effort") == "high" && common::flag(&a, "--add-dir") == "/ws");
}

#[test]
fn test_the_deny_list_keeps_its_order_and_drops_repeats() {
    let mut rules: Vec<String> = launch::DEFAULT_DENY.iter().map(|r| r.to_string()).collect();
    rules.extend(["Bash(git push --force*)".to_string(), "Bash(npm publish*)".to_string()]);
    let settings = launch::settings_json(&rules);
    let deny = settings["permissions"]["deny"].as_array().expect("deny");
    assert_eq!(json!(deny[..launch::DEFAULT_DENY.len()]), json!(launch::DEFAULT_DENY));
    assert_eq!(deny.iter().filter(|r| **r == "Bash(git push --force*)").count(), 1);
    assert_eq!(deny.last(), Some(&json!("Bash(npm publish*)")));
}

// --------------------------------------------------------------------------- MCP servers

#[tokio::test]
async fn test_the_board_server_comes_first_with_the_runs_token_and_cannot_be_replaced() {
    let _guard = common::init().await;
    let config = json!({
        "mcp_servers": [
            {"name": "kanban", "type": "http", "url": "http://evil/mcp"},
            {
                "name": "github",
                "type": "stdio",
                "command": "gh-mcp",
                "args": ["serve"],
                "env": [{"key": "T", "value": "x"}],
            },
            {"name": "off", "type": "stdio", "command": "x", "enabled": false},
            {"type": "stdio", "command": "nameless"},
        ]
    });
    let folder = common::tmp_path("mcp");
    let mcp = launch::mcp_config(
        config.as_object().expect("config"),
        "kbr_token",
        Some(&folder.to_string_lossy()),
        None,
        "http://127.0.0.1:8000",
    );
    let servers = mcp["mcpServers"].as_object().expect("servers");
    assert_eq!(servers.keys().collect::<Vec<_>>(), ["kanban", "github"]);
    assert_eq!(
        servers["kanban"],
        json!({
            "type": "http",
            "url": "http://127.0.0.1:8000/mcp/",
            "headers": {"Authorization": "Bearer kbr_token"},
        })
    );
    assert_eq!(servers["github"], json!({"type": "stdio", "command": "gh-mcp", "args": ["serve"], "env": {"T": "x"}}));
}

// --------------------------------------------------------------------------- the board's plugin

#[tokio::test]
async fn test_the_board_plugin_reports_hook_events_and_only_the_guard_refuses() {
    let _guard = common::init().await;
    let root = launch::board_plugin_dir().expect("plugin");
    assert_eq!(launch::board_plugin_dir().expect("plugin"), root); // written once per version
    let read = |rel: &str| std::fs::read_to_string(Path::new(&root).join(rel)).expect(rel);
    let manifest: Value = serde_json::from_str(&read(".claude-plugin/plugin.json")).expect("manifest");
    assert!(manifest["name"] == "kanban-board" && manifest["version"] == launch::BOARD_PLUGIN_VERSION);
    let hooks: Value = serde_json::from_str(&read("hooks/hooks.json")).expect("hooks");
    let hooks = hooks["hooks"].as_object().expect("hooks");
    assert_eq!(
        hooks.keys().map(String::as_str).collect::<HashSet<_>>(),
        HashSet::from(["PreToolUse", "PostToolUse", "Stop"])
    );
    let matcher = hooks["PostToolUse"][0]["matcher"].as_str().expect("matcher");
    assert!(matcher.contains("Edit") && matcher.contains("TaskCreate"));
    let (sh, cmd) = (read("hooks/post.sh"), read("hooks/post.cmd"));
    for script in [&sh, &cmd] {
        assert!(script.contains("/ai/hooks") && script.contains("KANBAN_RUN_TOKEN") && script.contains("-m 5"));
    }
    assert!(sh.trim_end().ends_with("exit 0") && cmd.trim_end().ends_with("exit /b 0"));
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(Path::new(&root).join("hooks/post.sh")).expect("post.sh").permissions().mode();
    assert!(mode & 0o111 != 0);
}

// --------------------------------------------------------------------------- pictures and folders

/// Hotfix 3.37.2 in v2: a pasted picture is a web path; the run gets a copy in a folder it may read (--add-dir).
/// (Python points `pictures.folder_for` and the uploads folder at a temporary folder; here the uploads folder is the
/// process's own and the copies go where `pictures::folder_for` says.)
#[tokio::test]
async fn test_pictures_a_prompt_names_are_copied_where_the_cli_may_read_them() {
    let _guard = common::init().await;
    let uploads = common::folder().join("uploads");
    std::fs::create_dir_all(uploads.join("comments")).expect("comments");
    std::fs::create_dir_all(uploads.join("_private")).expect("private");
    std::fs::write(uploads.join("comments").join("shot.png"), b"\x89PNG").expect("shot");
    std::fs::write(uploads.join("_private").join("secret.png"), b"\x89PNG").expect("secret");
    let key = format!("run_x{}", &kb_base::time::uuid4_hex()[..8]);
    let staged = kb_ai::pictures::folder_for(&key);
    let text = "See ![s](/uploads/comments/shot.png) and ![p](/uploads/_private/secret.png)";
    let (out, folder) = kb_ai::pictures::stage(text, &key).expect("stage");
    let folder = folder.expect("a folder of copies");
    assert_eq!(folder, staged.to_string_lossy());
    assert_eq!(std::fs::read(staged.join("shot.png")).expect("copy"), b"\x89PNG");
    assert!(!staged.join("secret.png").exists());
    assert!(out.starts_with(text) && out.contains("open each with Read"));
    assert!(out.split(text).nth(1).expect("the note").contains("shot.png"));
    assert_eq!(kb_ai::pictures::stage("no pictures here", "run_y").expect("stage"), ("no pictures here".to_string(), None));
    // and the CLI is allowed to read that folder
    let add: &'static [String] = Vec::leak(vec![folder.clone()]);
    let a = args(|a| a.add_dirs = add);
    assert_eq!(common::flag(&a, "--add-dir"), folder);
    let _ = std::fs::remove_dir_all(staged);
}

#[tokio::test]
async fn test_a_run_folder_never_leads_out_of_the_runs_folder() {
    let _guard = common::init().await;
    let runs = launch::data_root().expect("root").join("runs");
    assert_eq!(launch::run_dir("run_abc123", true).expect("folder"), runs.join("run_abc123"));
    assert!(!runs.join("run_new").exists());
    launch::run_dir("run_new", false).expect("folder");
    assert!(!runs.join("run_new").exists());
    for bad in ["../x", "a/b", "..", "/etc"] {
        assert!(matches!(launch::run_dir(bad, true), Err(launch::Error::Value(_))), "{bad}");
    }
}

// --------------------------------------------------------------------------- prepare

/// The CLI gets the run's token in the board's MCP header; what the transcript records says <run token>.
#[tokio::test]
async fn test_the_args_a_transcript_keeps_never_hold_the_runs_token() {
    let _guard = common::init().await;
    let (pid, _an) = common::project().await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({})).await;
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    let token = format!("kbr_{}", "q".repeat(20));
    let prepared = common::launch_of(team["id"].as_str().expect("id"), Some(&tid), &token, "s-1").await;
    let headers = |args: &[String]| -> Value {
        let mcp: Value = serde_json::from_str(&common::flag(args, "--mcp-config")).expect("mcp");
        mcp["mcpServers"]["kanban"]["headers"].clone()
    };
    assert_eq!(headers(&prepared.args), json!({"Authorization": format!("Bearer {token}")}));
    assert_eq!(headers(&prepared.record_args), json!({"Authorization": format!("Bearer {}", launch::RUN_TOKEN_SHOWN)}));
    assert!(!prepared.record_args.join(" ").contains(&"q".repeat(20)));
    assert_eq!(prepared.args[0], prepared.record_args[0]);
    // the CLI is the team's own, and the run's folder holds what the arguments name
    assert_eq!(prepared.args[0], common::real_cli());
    for flag in ["--append-system-prompt-file", "--append-subagent-system-prompt-file", "--agents"] {
        assert!(Path::new(&common::flag(&prepared.args, flag)).is_file(), "{flag}");
    }
    let env = |key: &str| prepared.env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
    assert_eq!(env("KANBAN_RUN_TOKEN"), Some(token.as_str()));
    assert_eq!(env("KANBAN_URL"), Some("http://127.0.0.1:9"));
    assert_eq!(env("KANBAN_WORKTREE"), Some(prepared.cwd.as_str()));
}

/// AI v2: a team has several roles (its subagents). A plugin meant for `dev` loads for a team with a dev role; one
/// meant only for `designer` does not; a team's own switch and the project default still win. The run's prompt names
/// the installed skills by the name the Skill tool takes.
#[tokio::test]
async fn test_a_project_plugin_reaches_a_team_that_has_one_of_its_roles() {
    let _guard = common::init().await;
    let (pid, _an) = common::project().await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({})).await; // the standard pack: dev, reviewer, qa
    let team_id = team["id"].as_str().expect("id");
    let tid = common::ticket(&pid, "Fix add()", "todo").await.id;
    let tmp = common::tmp_path("plugins");
    common::plugin_row(&pid, &tmp.join("flow"), "flow", &["pm", "dev"], |_| {}).await;
    common::plugin_row(&pid, &tmp.join("tufte"), "tufte", &["designer"], |_| {}).await;
    common::plugin_row(&pid, &tmp.join("everyone"), "everyone", &[], |r| r.default_on = Set(true)).await;
    common::plugin_row(&pid, &tmp.join("off-here"), "off-here", &["dev"], |r| {
        r.members = Set(json!({ team_id: false }).to_string());
    })
    .await;
    let prepared = common::launch_of(team_id, Some(&tid), &format!("kbr_{}", "w".repeat(20)), "s-2").await;
    let loaded: HashSet<&str> = prepared.plugin_dirs.iter().map(|d| d.rsplit('/').next().unwrap_or_default()).collect();
    assert!(loaded.contains("flow") && loaded.contains("everyone"), "{loaded:?}");
    assert!(!loaded.contains("tufte") && !loaded.contains("off-here"), "{loaded:?}");
    assert!(prepared.system.contains("`flow:flow-skill`") && prepared.system.contains("`everyone:everyone-skill`"));
    assert!(!prepared.system.contains("tufte-skill"));
}

fn ctx() -> RunContext {
    RunContext {
        run_id: "r".into(),
        member_id: "m".into(),
        member_name: "Team".into(),
        project_id: "p".into(),
        ticket_id: Some("KAN-1".into()),
        on_behalf_of: "An".into(),
        mode: "work".into(),
        ..Default::default()
    }
}

fn roles(keys: &[&str]) -> Vec<kb_ai_know::roles::Role> {
    keys.iter().map(|k| json!({"key": k}).as_object().expect("role").clone()).collect()
}

#[test]
fn test_each_role_is_told_to_open_its_guide_and_the_lead_gets_the_skill_table() {
    let rules = launch::board_rules(&ctx(), "P", &[], true, None);
    assert!(rules.contains("`kanban-board:docs-pages`") && rules.contains("read it back"));
    assert!(launch::REPORT_SCHEMA["properties"].get("skills").is_some());
}

#[test]
fn test_written_results_go_to_docs_and_only_a_code_team_gets_the_branch_rules() {
    let research = launch::board_rules(&ctx(), "P", &roles(&["ba", "data_analyst"]), false, None);
    assert!(research.contains("is a Docs page linked to the ticket, never a Markdown file"));
    assert!(research.contains("Files: your team does not write code"));
    assert!(!research.contains("run the project's tests"));
    let code = launch::board_rules(&ctx(), "P", &roles(&["dev", "reviewer"]), false, None);
    assert!(code.contains("is a Docs page linked to the ticket"));
    assert!(code.contains("Code: you work in the ticket's own git worktree"));
    assert!(code.contains("run the project's tests"));
    let alone = launch::board_rules(&ctx(), "P", &[], false, None); // a lead with no roles may code
    assert!(alone.contains("Code: you work in the ticket's own git worktree"));
}
