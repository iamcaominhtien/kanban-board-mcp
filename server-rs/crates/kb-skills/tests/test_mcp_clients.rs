//! `tests/test_mcp_clients.py`: Settings -> MCP integrations: install the kanban MCP server into Claude Code /
//! Antigravity.
//!
//! The same assertions run against the Python server (`PARITY_TARGET=python`: a real server with a home folder and a
//! `PATH` of its own) and, by default, against this crate's router in the test process (`kb-app` does not merge the
//! Settings routes yet, so the Rust server cannot serve them). The fake `claude` is `fake-claude-cli` and the fake MCP
//! server `fake-mcp-server` (both built from `tests/support/`): no Python is needed.

mod common;

use common::{Fixture, is_python, read_json, skip, write_json};
use kb_skills::mcp_clients::{self, Env};
use serde_json::{Value, json};

fn claude_json(fx: &Fixture) -> std::path::PathBuf {
    fx.home.join(".claude.json")
}

fn antigravity_config(fx: &Fixture) -> std::path::PathBuf {
    fx.home.join(".gemini").join("config").join("mcp_config.json")
}

/// The folders `find_claude` looks in after `PATH` must hold no real `claude` (the Python test replaced the function
/// with a lookup in `PATH` alone).
fn system_claude() -> bool {
    ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"].iter().any(|p| std::path::Path::new(p).exists())
}

// ---- Claude Code

#[tokio::test]
async fn test_claude_not_detected_without_cli() {
    if is_python() && system_claude() {
        return skip("test_claude_not_detected_without_cli", "a claude sits in a folder the server also looks in");
    }
    let fx = Fixture::without_claude().await;
    let r = fx.status("claude-code", &[]).await;
    let s = r.json();
    assert_eq!(r.status, 200);
    assert_eq!(s["detected"], json!(false));
    assert_eq!(s["installed"], json!(false));
    assert!(s["command"].as_str().unwrap().starts_with("claude mcp add kanban --transport stdio --scope user"));
    assert_eq!(s["stored_in"], json!("~/.claude.json"));
    assert!(s["tool_count"].as_u64().unwrap() > 0);
    assert_eq!(s["id"], json!("claude-code"));
    assert_eq!(s["scope"], json!("user"));
    assert_eq!(s["needs_folder"], json!(false));
    assert_eq!(s["error"], Value::Null);
}

#[tokio::test]
async fn test_claude_install_without_cli_reports_error_and_changes_nothing() {
    if is_python() && system_claude() {
        return skip(
            "test_claude_install_without_cli_reports_error_and_changes_nothing",
            "a claude sits in a folder the server also looks in",
        );
    }
    let fx = Fixture::without_claude().await;
    let r = fx.action("claude-code", "install", json!({"scope": "user"})).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["error"]["code"], json!("claude_not_found"));
    assert_eq!(
        r.json()["error"]["message"],
        json!("Couldn't find the claude command. Install Claude Code first, or copy the command and run it yourself.")
    );
    assert!(!claude_json(&fx).exists());
}

#[tokio::test]
async fn test_claude_install_reinstall_remove() {
    let fx = Fixture::with_claude().await;
    let r = fx.action("claude-code", "install", json!({"scope": "user"})).await;
    let s = r.json();
    assert_eq!(s["error"], Value::Null);
    assert_eq!(s["installed"], json!(true));
    assert_eq!(s["update_available"], json!(false), "{s}");
    assert_eq!(s["detected"], json!(true));
    let entry = read_json(&claude_json(&fx))["mcpServers"]["kanban"].clone();
    assert!(!entry["command"].as_str().unwrap().is_empty());
    assert_eq!(entry["type"], json!("stdio"));

    // replaces, no duplicate
    let again = fx.action("claude-code", "install", json!({"scope": "user"})).await;
    assert_eq!(again.json()["error"], Value::Null);
    assert_eq!(again.json()["installed"], json!(true));

    let gone = fx.action("claude-code", "remove", json!({"scope": "user"})).await;
    assert_eq!(gone.json()["installed"], json!(false));
    assert!(read_json(&claude_json(&fx))["mcpServers"].get("kanban").is_none());
}

#[tokio::test]
async fn test_claude_stale_entry_is_update_available() {
    let fx = Fixture::with_claude().await;
    write_json(
        &claude_json(&fx),
        &json!({"mcpServers": {"kanban": {"type": "stdio", "command": "/old/path", "args": []}}}),
    );
    let s = fx.status("claude-code", &[("scope", "user")]).await;
    let s = s.json();
    assert_eq!(s["installed"], json!(true));
    assert_eq!(s["update_available"], json!(true));
    assert_eq!(s["installed_command"], json!("/old/path"));
}

#[tokio::test]
async fn test_claude_cli_failure_is_reported() {
    let fx = Fixture::with_claude().await;
    fx.claude_fails(true);
    let s = fx.action("claude-code", "install", json!({"scope": "user"})).await;
    let s = s.json();
    assert_eq!(s["error"]["code"], json!("command_failed"));
    assert!(s["error"]["message"].as_str().unwrap().contains("boom"));
    assert_eq!(s["error"]["message"], json!("claude mcp add failed: boom"));
}

#[tokio::test]
async fn test_claude_project_scope_needs_a_folder() {
    let fx = Fixture::with_claude().await;
    let s = fx.status("claude-code", &[("scope", "project")]).await;
    assert_eq!(s.json()["needs_folder"], json!(true));
    assert_eq!(s.json()["stored_in"], Value::Null);
    let r = fx.action("claude-code", "install", json!({"scope": "project"})).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.json(), &json!({"detail": "Choose a project folder first."}));
}

#[tokio::test]
async fn test_claude_project_scope_reads_mcp_json() {
    let fx = Fixture::with_claude().await;
    let proj = fx.folder("proj");
    write_json(&proj.join(".mcp.json"), &json!({"mcpServers": {"kanban": {"command": "x", "args": []}}}));
    let s = fx.status("claude-code", &[("scope", "project"), ("folder", proj.to_str().unwrap())]).await;
    let s = s.json();
    assert_eq!(s["installed"], json!(true));
    assert!(s["stored_in"].as_str().unwrap().ends_with(".mcp.json"));
}

#[tokio::test]
async fn test_claude_local_scope_reads_the_project_entry_of_claude_json() {
    let fx = Fixture::with_claude().await;
    let proj = fx.folder("proj");
    let key = proj.display().to_string();
    write_json(
        &claude_json(&fx),
        &json!({"projects": {key: {"mcpServers": {"kanban": {"type": "stdio", "command": "uv", "args": ["a", "b c"]}}}}}),
    );
    let s = fx.status("claude-code", &[("scope", "local"), ("folder", proj.to_str().unwrap())]).await;
    let s = s.json();
    assert_eq!(s["installed"], json!(true));
    assert_eq!(s["installed_command"], json!("uv a 'b c'"));
    assert_eq!(s["stored_in"], json!("~/.claude.json"));
    let other = fx.folder("other");
    let s = fx.status("claude-code", &[("scope", "local"), ("folder", other.to_str().unwrap())]).await;
    assert_eq!(s.json()["installed"], json!(false));
}

// ---- Antigravity

#[tokio::test]
async fn test_antigravity_install_global_merges_and_keeps_others() {
    let fx = Fixture::without_claude().await;
    let cfg = antigravity_config(&fx);
    write_json(&cfg, &json!({"theme": "x", "mcpServers": {"other": {"command": "x"}}}));
    let s = fx.action("antigravity", "install", json!({"scope": "global"})).await;
    let s = s.json();
    assert_eq!(s["error"], Value::Null);
    assert_eq!(s["installed"], json!(true));
    assert_eq!(s["detected"], json!(true));
    let data = read_json(&cfg);
    assert_eq!(data["theme"], json!("x"));
    assert_eq!(data["mcpServers"]["other"], json!({"command": "x"}));
    assert!(data["mcpServers"]["kanban"].get("type").is_none());
    assert!(!data["mcpServers"]["kanban"]["command"].as_str().unwrap().is_empty());
    // the other keys keep their order, and the file is what `json.dumps(data, indent=2)` writes (no final newline)
    let text = std::fs::read_to_string(&cfg).unwrap();
    assert!(text.starts_with("{\n  \"theme\": \"x\",\n  \"mcpServers\": {\n    \"other\": {\n      \"command\": \"x\"\n    },\n    \"kanban\": {"));
    assert!(text.ends_with("}\n  }\n}"), "{text}");
    assert_eq!(s["stored_in"], json!("~/.gemini/config/mcp_config.json"));
    let shown: Value = serde_json::from_str(s["entry_json"].as_str().unwrap()).unwrap();
    assert_eq!(shown["mcpServers"]["kanban"], data["mcpServers"]["kanban"]);
}

#[tokio::test]
async fn test_antigravity_workspace_scope() {
    let fx = Fixture::without_claude().await;
    let proj = fx.folder("proj");
    let s = fx.action("antigravity", "install", json!({"scope": "workspace", "folder": proj.to_str().unwrap()})).await;
    assert_eq!(s.json()["installed"], json!(true));
    let data = read_json(&proj.join(".agents").join("mcp_config.json"));
    assert!(data["mcpServers"].get("kanban").is_some());
}

#[tokio::test]
async fn test_antigravity_remove_only_ours() {
    let fx = Fixture::without_claude().await;
    fx.action("antigravity", "install", json!({"scope": "global"})).await;
    let cfg = antigravity_config(&fx);
    let mut data = read_json(&cfg);
    data["mcpServers"]["other"] = json!({"command": "x"});
    write_json(&cfg, &data);
    let s = fx.action("antigravity", "remove", json!({"scope": "global"})).await;
    assert_eq!(s.json()["installed"], json!(false));
    let left: Vec<String> = read_json(&cfg)["mcpServers"].as_object().unwrap().keys().cloned().collect();
    assert_eq!(left, vec!["other".to_string()]);
}

#[tokio::test]
async fn test_antigravity_corrupt_file_never_overwritten() {
    let fx = Fixture::without_claude().await;
    let cfg = antigravity_config(&fx);
    std::fs::create_dir_all(cfg.parent().unwrap()).unwrap();
    std::fs::write(&cfg, "{not json").unwrap();
    let s = fx.action("antigravity", "install", json!({"scope": "global"})).await;
    assert_eq!(s.json()["error"]["code"], json!("invalid_json"));
    assert_eq!(
        s.json()["error"]["message"],
        json!(format!(
            "{} is not valid JSON, so it was left untouched. Fix or remove it and try again.",
            cfg.display()
        ))
    );
    assert_eq!(std::fs::read_to_string(&cfg).unwrap(), "{not json");
}

#[tokio::test]
async fn test_antigravity_write_failure_names_the_file() {
    // The Python test made `os.replace` raise `PermissionError`; a test here cannot (it runs as root, which no file
    // mode stops). Folders under /proc cannot be made, which fails the same step (making the folder of the config)
    // with the same report.
    if !std::path::Path::new("/proc/self").is_dir() {
        return skip("test_antigravity_write_failure_names_the_file", "no /proc");
    }
    let fx = Fixture::without_claude().await;
    let s = fx.action("antigravity", "install", json!({"scope": "workspace", "folder": "/proc"})).await;
    assert_eq!(s.status, 200, "{}", s.json());
    let s = s.json();
    assert_eq!(s["error"]["code"], json!("write_failed"));
    let message = s["error"]["message"].as_str().unwrap();
    assert!(message.contains("No such file or directory"), "{message}");
    assert_eq!(
        message,
        "Couldn't write /proc/.agents/mcp_config.json: No such file or directory. Nothing was changed. Copy the JSON and add it to the file yourself."
    );
    // the manual fallback stays available
    assert!(!s["entry_json"].as_str().unwrap().is_empty());
}

/// Python removes the temporary file after a failed write with `unlink(missing_ok=True)`, which only ignores "not
/// found": with a file where the config's folder should be, that raises "Not a directory" and the request is a 500
/// instead of a `write_failed` report. Kept as it is.
#[tokio::test]
async fn test_antigravity_a_file_in_place_of_the_config_folder_is_a_500() {
    let fx = Fixture::without_claude().await;
    let gemini = fx.home.join(".gemini");
    std::fs::create_dir_all(&gemini).unwrap();
    std::fs::write(gemini.join("config"), "not a folder").unwrap();
    let s = fx.action("antigravity", "install", json!({"scope": "global"})).await;
    assert_eq!(s.status, 500);
    assert_eq!(std::fs::read_to_string(gemini.join("config")).unwrap(), "not a folder");
}

#[tokio::test]
async fn test_antigravity_a_servers_entry_that_is_not_an_object_is_left_alone() {
    let fx = Fixture::without_claude().await;
    let cfg = antigravity_config(&fx);
    write_json(&cfg, &json!({"mcpServers": ["x"]}));
    let before = std::fs::read_to_string(&cfg).unwrap();
    let s = fx.action("antigravity", "install", json!({"scope": "global"})).await;
    assert_eq!(s.json()["error"]["code"], json!("invalid_json"));
    assert_eq!(
        s.json()["error"]["message"],
        json!(format!("'mcpServers' in {} is not an object; it was left untouched.", cfg.display()))
    );
    assert_eq!(std::fs::read_to_string(&cfg).unwrap(), before);
}

#[tokio::test]
async fn test_unknown_client_and_scope_are_400() {
    let fx = Fixture::without_claude().await;
    let r = fx.status("nope", &[]).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.json(), &json!({"detail": "Unknown MCP client 'nope'"}));
    let r = fx.status("antigravity", &[("scope", "user")]).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.json(), &json!({"detail": "Unknown scope 'user' for antigravity."}));
    // the routes that name the client first answer 404 for an unknown one
    let r = fx.action("nope", "test", json!({})).await;
    assert_eq!((r.status, r.json().clone()), (404, json!({"detail": "Unknown MCP client 'nope'"})));
    let r = fx.action("nope", "open-file", json!({})).await;
    assert_eq!(r.status, 404);
    let proj = fx.home.join("not-a-folder");
    let r = fx.status("antigravity", &[("scope", "workspace"), ("folder", proj.to_str().unwrap())]).await;
    assert_eq!(r.status, 400);
    assert_eq!(r.json()["detail"], json!(format!("{} is not a folder.", proj.display())));
}

#[tokio::test]
async fn test_a_request_without_a_body_is_422() {
    let fx = Fixture::without_claude().await;
    let r = fx.post("/settings/mcp-clients/antigravity/install", Value::Null).await;
    assert_eq!(r.status, 422);
}

#[tokio::test]
async fn test_test_connection_requires_install() {
    let fx = Fixture::without_claude().await;
    let r = fx.action("antigravity", "test", json!({"scope": "global"})).await;
    assert_eq!(r.json()["ok"], json!(false));
    assert_eq!(r.json(), &json!({"ok": false, "tool_count": 0, "message": "kanban isn't installed here yet."}));
}

#[tokio::test]
async fn test_test_connection_starts_the_real_server() {
    // Python: the entry that `install` writes starts the real server (`uv run mcp_stdio.py`) with a database of its
    // own. Here the server that `install` writes is the program beside the running one, as in a packaged app; that
    // is the fake MCP server (tests/support/fake_mcp_server.rs), which speaks the same JSON-RPC over stdio.
    let fx = Fixture::without_claude().await;
    if is_python() {
        if std::process::Command::new("uv").arg("--version").output().is_err() {
            return skip("test_test_connection_starts_the_real_server", "uv is not installed");
        }
        fx.action("antigravity", "install", json!({"scope": "global"})).await;
        let r = fx.action("antigravity", "test", json!({"scope": "global"})).await;
        assert_eq!(r.json()["ok"], json!(true), "{}", r.json());
        assert!(r.json()["tool_count"].as_u64().unwrap() > 0);
        return;
    }
    let packaged = fx.tmp.path().join("kanban-mcp-stdio");
    std::fs::create_dir_all(&packaged).unwrap();
    std::fs::copy(env!("CARGO_BIN_EXE_fake-mcp-server"), packaged.join("kanban-mcp-stdio")).unwrap();
    std::fs::write(packaged.join("kanban-server"), "").unwrap();
    let mut env = Env::from_process();
    env.home = fx.home.clone();
    env.exe = packaged.join("kanban-server");
    env.system_candidates = Vec::new();
    mcp_clients::set_env_override(Some(env));
    let s = fx.action("antigravity", "install", json!({"scope": "global"})).await;
    assert_eq!(s.json()["installed"], json!(true));
    let r = fx.action("antigravity", "test", json!({"scope": "global"})).await;
    assert_eq!(r.json(), &json!({"ok": true, "tool_count": 2, "message": "Connected - 2 tools available"}));
}

/// What the probe reports when the entry cannot be run or does not answer as an MCP server. The texts are what the
/// Python server answers (checked with `PARITY_TARGET=python`): a program that cannot be started gives the OS error as
/// uvloop words it (no file name), and anything after the start is reported as the SDK's task group.
#[tokio::test]
async fn test_test_connection_reports_what_the_python_probe_reports() {
    let fx = Fixture::without_claude().await;
    let cfg = antigravity_config(&fx);
    let group = "Couldn't start the server: unhandled errors in a TaskGroup (1 sub-exception)";
    let cases: Vec<(Value, String)> = vec![
        (
            json!({"command": "/nonexistent/x", "args": []}),
            "Couldn't start the server: [Errno 2] No such file or directory".into(),
        ),
        (json!({"command": "/tmp", "args": []}), "Couldn't start the server: [Errno 13] Permission denied".into()),
        (json!({"command": "true", "args": []}), group.into()),
        (json!({"command": "sh", "args": ["-c", "echo hello; sleep 1"]}), group.into()),
        (json!({"command": "sh", "args": ["-c", "echo boom >&2; exit 3"]}), group.into()),
        (
            json!({"command": "sh", "args": ["-c", "read l; echo '{\"jsonrpc\":\"2.0\",\"id\":0,\"error\":{\"code\":-32601,\"message\":\"nope\"}}'; sleep 1"]}),
            group.into(),
        ),
        (
            json!({"command": "sh", "args": ["-c", "read l; echo '{\"jsonrpc\":\"2.0\",\"id\":0,\"result\":{\"protocolVersion\":\"1999-01-01\",\"capabilities\":{},\"serverInfo\":{\"name\":\"x\",\"version\":\"1\"}}}'; sleep 1"]}),
            group.into(),
        ),
    ];
    for (entry, message) in cases {
        write_json(&cfg, &json!({"mcpServers": {"kanban": entry}}));
        let r = fx.action("antigravity", "test", json!({"scope": "global"})).await;
        assert_eq!(r.json(), &json!({"ok": false, "tool_count": 0, "message": message}), "{entry}");
    }
}

#[tokio::test]
async fn test_test_connection_counts_the_first_page_and_passes_the_entry_env() {
    let fx = Fixture::without_claude().await;
    let cfg = antigravity_config(&fx);
    // a server that answers like a real one, with a next page it never serves, and that fails unless its env arrives
    let script = r#"read a; echo "{\"jsonrpc\":\"2.0\",\"id\":0,\"result\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"serverInfo\":{\"name\":\"x\",\"version\":\"1\"}}}"; read b; read c; test "$FROM_ENTRY" = "7" || exit 1; echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[{\"name\":\"a\",\"inputSchema\":{\"type\":\"object\"}},{\"name\":\"b\",\"inputSchema\":{\"type\":\"object\"}}],\"nextCursor\":\"zzz\"}}"; sleep 1"#;
    write_json(
        &cfg,
        &json!({"mcpServers": {"kanban": {"command": "sh", "args": ["-c", script], "env": {"FROM_ENTRY": 7}}}}),
    );
    let r = fx.action("antigravity", "test", json!({"scope": "global"})).await;
    assert_eq!(r.json(), &json!({"ok": true, "tool_count": 2, "message": "Connected - 2 tools available"}));
}

#[tokio::test]
async fn test_open_file_needs_the_file() {
    let fx = Fixture::without_claude().await;
    let r = fx.action("antigravity", "open-file", json!({"scope": "global"})).await;
    assert_eq!(r.status, 400);
    assert_eq!(
        r.json()["detail"],
        json!(format!(
            "{} doesn't exist yet. Install first, or create it yourself.",
            antigravity_config(&fx).display()
        ))
    );
}

#[tokio::test]
async fn test_stdio_command_frozen_is_the_sibling_in_the_shared_folder() {
    // Resources/kanban-mcp-stdio/ holds both programs and their shared folder
    if is_python() {
        return skip("test_stdio_command_frozen_is_the_sibling_in_the_shared_folder", "a unit test of the Rust module");
    }
    let tmp = tempfile::tempdir().unwrap();
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let bundle = std::fs::canonicalize(tmp.path()).unwrap().join("kanban-mcp-stdio");
    std::fs::create_dir_all(&bundle).unwrap();
    let server_bin = bundle.join(format!("kanban-server{ext}"));
    std::fs::write(&server_bin, "").unwrap();
    std::fs::write(bundle.join(format!("kanban-mcp-stdio{ext}")), "").unwrap();
    let mut env = Env::from_process();
    env.exe = server_bin;
    let _guard = common::env_lock().await;
    mcp_clients::set_env_override(Some(env));
    let (command, args) = mcp_clients::stdio_command();
    mcp_clients::set_env_override(None);
    assert_eq!(command, bundle.join(format!("kanban-mcp-stdio{ext}")).display().to_string());
    assert!(args.is_empty());
}

#[tokio::test]
async fn test_stdio_command_in_development_is_the_python_command() {
    if is_python() {
        return skip("test_stdio_command_in_development_is_the_python_command", "a unit test of the Rust module");
    }
    let _guard = common::env_lock().await;
    let mut env = Env::from_process();
    env.exe = std::path::PathBuf::from("/nonexistent/folder/kanban-server");
    env.path = Some("/nonexistent".into());
    env.server_dir = std::path::PathBuf::from("/repo/server");
    mcp_clients::set_env_override(Some(env));
    let (command, args) = mcp_clients::stdio_command();
    mcp_clients::set_env_override(None);
    assert_eq!(command, "uv");
    assert_eq!(args, vec!["--directory", "/repo/server", "run", "mcp_stdio.py"]);
}
