//! The modules that read the machine's folders and files against the vectors the Python modules gave
//! (`contract/golden/ai_env.json`, made by `gen_ai_env.py`): `paths` (symlinks, `..`, Windows-style text), `mcp_sources`
//! (the servers a folder asks for) and `profiles` (environments, sign-in commands, status read from a fake CLI, what
//! `create` and `prepare` write). Paths in the file are written with `{T}` for the temporary folder of the run.

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod common;

use std::collections::HashSet;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};

use kb_ai::profiles::{self, Error, Profile};
use kb_ai::{mcp_sources, paths};
use kb_base::{ctx, pyjson};
use serde_json::{Map, Value, json};

/// The temporary folder, with the environment the Python run had (the home folder, the Claude config folder, the agy
/// profiles folder) set before anything reads it.
#[allow(unsafe_code)]
fn t() -> &'static Path {
    static FOLDER: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    FOLDER.get_or_init(|| {
        let dir = tempfile::tempdir().expect("temporary folder").keep().canonicalize().expect("real path");
        // This test file is one process and sets its environment once, before anything reads it.
        unsafe {
            std::env::set_var("HOME", dir.join("home"));
            std::env::set_var("CLAUDE_CONFIG_DIR", dir.join("claude"));
            std::env::set_var("AGY_PROFILES_HOME", dir.join("agy-profiles"));
            std::env::remove_var("CLAUDE_PROFILES_HOME");
            std::env::remove_var("CODEX_BIN");
        }
        dir
    })
}

fn fill(text: &str) -> String {
    text.replace("{T}", &t().to_string_lossy())
}

fn sub(text: &str) -> String {
    text.replace(&*t().to_string_lossy(), "{T}")
}

fn deep_sub(value: &Value) -> Value {
    match value {
        Value::String(s) => Value::String(sub(s)),
        Value::Array(items) => Value::Array(items.iter().map(deep_sub).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), deep_sub(v))).collect()),
        other => other.clone(),
    }
}

fn golden() -> Value {
    common::golden("ai_env.json")
}

fn write(rel: &str, content: &str, mode: Option<u32>) {
    let path = t().join(rel);
    std::fs::create_dir_all(path.parent().expect("a parent")).expect("folder");
    std::fs::write(&path, content).expect("file");
    if let Some(mode) = mode {
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).expect("mode");
    }
}

#[tokio::test]
async fn paths_allow_work_folders_and_install_folders_only() {
    let g = golden();
    let p = &g["paths"];
    for d in ["home/proj", "work/repo", "work/sub/deeper", "other/x", "outside", "home/bin", "work/space dir"] {
        std::fs::create_dir_all(t().join(d)).expect("folder");
    }
    write("home/bin/claude", "#!/bin/sh\n", Some(0o755));
    write("work/file.txt", "x", None);
    let link = |target: &str, name: &str| symlink(fill(target), t().join(name)).expect("link");
    link("/etc", "work/etc_link");
    link("{T}/outside", "work/out_link");
    link("{T}/work/repo", "home/repo_link");
    link("../repo", "work/sub/rel_link");
    link("{T}/work/missing", "work/broken_link");
    link("loop_b", "work/loop_a");
    link("loop_a", "work/loop_b");

    let home = fill(p["home"].as_str().expect("home"));
    let env_roots = fill(p["roots_env"].as_str().expect("roots"));
    assert_eq!(p["pathsep"], json!(":"));
    let work = paths::work_roots_with(&home, &env_roots);
    assert_eq!(json!(work.iter().map(|r| sub(r)).collect::<Vec<_>>()), p["work_roots"]);
    let program = paths::program_roots_with(work.clone());
    assert_eq!(json!(program.iter().map(|r| sub(r)).collect::<Vec<_>>()), p["program_roots"]);
    assert_eq!(json!(sub(&paths::folder_refused(&fill("  {T}/x  ")))), p["refused_text"]);
    for case in p["cases"].as_array().expect("cases") {
        let raw = fill(case["raw"].as_str().expect("raw"));
        for (name, roots) in [("folder", &work), ("program", &program)] {
            let got = if name == "folder" {
                paths::folder_in(&raw, roots).await
            } else {
                paths::program_in(&raw, roots).await
            };
            let want = &case[name];
            match got {
                Ok(path) => assert_eq!(json!({"ok": sub(&path)}), *want, "{name}({:?})", case["raw"]),
                Err(err) => assert_eq!(json!({"refused": sub(&err.to_string())}), *want, "{name}({:?})", case["raw"]),
            }
        }
    }
}

#[tokio::test]
async fn mcp_sources_read_the_folders_own_files_and_the_plugins_it_enables() {
    let g = golden();
    let m = &g["mcp_sources"];
    for (rel, content) in m["files"].as_object().expect("files") {
        write(rel, &fill(content.as_str().expect("text")), None);
    }
    std::fs::create_dir_all(t().join("empty")).expect("folder");
    std::fs::create_dir_all(t().join("plugins/missing-dir").parent().expect("parent")).expect("folder");
    let big = pyjson::dumps(
        &json!({"mcpServers": {"big": {"command": "x".repeat(m["big_server_len"].as_u64().expect("len") as usize)}}}),
    );
    write("big/.mcp.json", &big, None);
    for case in m["cases"].as_array().expect("cases") {
        let account = case["account_dir"].as_str().map(fill);
        let folder = case["folder"].as_str().map(fill);
        let (servers, plugins, enabled) = ctx::scope(async {
            let token = mcp_sources::set_account_dir(account.as_deref());
            let servers = Value::Object(mcp_sources::folder_servers(folder.as_deref()));
            let plugins = Value::Object(folder.as_deref().map_or_else(Map::new, mcp_sources::plugin_servers));
            let enabled = json!(folder.as_deref().map_or_else(Vec::new, mcp_sources::enabled_plugins));
            ctx::reset(token);
            (servers, plugins, enabled)
        })
        .await;
        let what = format!("account {} folder {}", case["account_dir"], case["folder"]);
        let (servers, plugins) = (deep_sub(&servers), deep_sub(&plugins));
        assert_eq!(servers, case["servers"], "servers: {what}");
        assert_eq!(pyjson::dumps(&servers), pyjson::dumps(&case["servers"]), "servers order: {what}");
        assert_eq!(plugins, case["plugins"], "plugins: {what}");
        assert_eq!(pyjson::dumps(&plugins), pyjson::dumps(&case["plugins"]), "plugins order: {what}");
        assert_eq!(deep_sub(&enabled), case["enabled"], "enabled: {what}");
    }
    for case in m["same_path"].as_array().expect("cases") {
        let (a, b) = (case["a"].as_str().expect("a"), case["b"].as_str().expect("b"));
        assert_eq!(json!(mcp_sources::same_path(a, b)), case["out"], "{a} / {b}");
    }
    for case in m["clean"].as_array().expect("cases") {
        assert_eq!(json!(mcp_sources::clean(case["in"].as_str().expect("text"))), case["out"], "{}", case["in"]);
    }
}

fn status_json(s: &profiles::Status) -> Value {
    json!({"signed_in": s.signed_in, "detail": s.detail, "email": s.email, "plan": s.plan, "method": s.method})
}

/// A call that starts a script just written may meet "text file busy" while another thread forks: try again.
fn retrying<T>(mut call: impl FnMut() -> Result<T, Error>) -> Result<T, Error> {
    for _ in 0..20 {
        match call() {
            Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::ExecutableFileBusy => {
                std::thread::sleep(std::time::Duration::from_millis(50))
            }
            other => return other,
        }
    }
    call()
}

fn tree(root: &Path) -> Value {
    if !root.exists() {
        return Value::Null;
    }
    fn walk(dir: &Path, root: &Path, out: &mut Vec<(String, Value)>) {
        let mut entries: Vec<_> = std::fs::read_dir(dir).expect("read dir").map(|e| e.expect("entry").path()).collect();
        entries.sort();
        for p in entries {
            let rel = p.strip_prefix(root).expect("inside").to_string_lossy().into_owned();
            let meta = std::fs::symlink_metadata(&p).expect("meta");
            if meta.file_type().is_symlink() {
                out.push((rel, json!({"link": sub(&std::fs::read_link(&p).expect("link").to_string_lossy())})));
            } else if meta.is_dir() {
                out.push((rel, json!({"dir": true})));
                walk(&p, root, out);
            } else {
                out.push((rel, json!({"file": std::fs::read_to_string(&p).expect("text")})));
            }
        }
    }
    let mut items = Vec::new();
    walk(root, root, &mut items);
    // `Path.rglob` then `sorted`: by path text
    items.sort_by(|a, b| a.0.cmp(&b.0));
    Value::Object(items.into_iter().collect())
}

fn profile(cli: &str, name: &str, folder: &Path, binary: &str) -> Box<dyn Profile> {
    profiles::profile_for(cli, name, Some(folder), Some(binary)).expect("a profile")
}

#[test]
fn profiles_names_environments_commands_and_status() {
    let g = golden();
    let _ = t();
    for case in g["profile_names"].as_array().expect("cases") {
        let (cli, name) = (case["cli"].as_str().expect("cli"), case["name"].as_str().expect("name"));
        match profiles::profile_for(cli, name, None, None) {
            Ok(p) => assert_eq!(json!(sub(&p.dir().to_string_lossy())), case["dir"], "{cli} {name:?}"),
            Err(fail) => assert_eq!(json!(fail.0), case["fail"], "{cli} {name:?}"),
        }
    }
    assert_eq!(json!(profiles::profile_for("nope", "x", None, None).err().map(|f| f.0)), g["unknown_cli"]);

    let base_env: Vec<(String, String)> = [
        ("PATH", "/usr/bin"),
        ("HOME", "/home/x"),
        ("CLAUDE_CODE_OAUTH_TOKEN", "t"),
        ("ANTHROPIC_AUTH_TOKEN", "a"),
        ("ANTHROPIC_API_KEY", "k"),
        ("DBUS_SESSION_BUS_ADDRESS", "unix:x"),
        ("XDG_DATA_HOME", "/x"),
        ("CODEX_HOME", "/old"),
        ("CLAUDE_CONFIG_DIR", "/old-claude"),
        ("OTHER", "1"),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    let env_json =
        |env: &[(String, String)]| Value::Object(env.iter().map(|(k, v)| (k.clone(), json!(sub(v)))).collect());
    for case in g["profiles"].as_array().expect("cases") {
        let cli = case["cli"].as_str().expect("cli");
        let folder = fill(case["folder"].as_str().expect("folder"));
        let p = profile(
            cli,
            case["name"].as_str().expect("name"),
            Path::new(&folder),
            &format!("{}/bin/{cli}", t().display()),
        );
        assert_eq!(p.name(), case["name"].as_str().expect("name"));
        assert_eq!(env_json(&p.env()), case["env"], "{cli} env");
        assert_eq!(json!(p.dropped_env()), case["dropped"], "{cli} dropped");
        let overlay = p.overlay(&base_env);
        assert_eq!(env_json(&overlay), case["overlay"], "{cli} overlay");
        assert_eq!(
            json!(overlay.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>()),
            case["overlay_keys"],
            "{cli} overlay order"
        );
        let sub_all = |v: Vec<String>| json!(v.iter().map(|x| sub(x)).collect::<Vec<_>>());
        assert_eq!(sub_all(p.login_argv(&[]).expect("argv")), case["login_argv"], "{cli} login_argv");
        let extra = vec!["--x".to_string(), "y".to_string()];
        assert_eq!(sub_all(p.login_argv(&extra).expect("argv")), case["login_argv_extra"], "{cli} login_argv extra");
        assert_eq!(json!(p.login_cwd().map(|c| sub(&c.to_string_lossy()))), case["login_cwd"], "{cli} login_cwd");
        assert_eq!(json!(p.login_hint()), case["login_hint"], "{cli} login_hint");
        assert_eq!(json!(p.next_step("ai_profile.py")), case["next_step"], "{cli} next_step");
        assert_eq!(json!(p.next_step("script.py")), case["next_step_custom"], "{cli} next_step custom");
        assert_eq!(
            sub_all(p.credential_files().iter().map(|f| f.to_string_lossy().into_owned()).collect()),
            case["credential_files"],
            "{cli} credential files"
        );
        assert_eq!(json!(p.exists()), case["exists_before"], "{cli} exists");
    }

    let agy = profiles::Agy(
        profiles::ProfileBase::new("agy", "kc", Some(&t().join("profiles/agy-kc")), Some("x")).expect("base"),
    );
    std::fs::create_dir_all(agy.keychain().parent().expect("parent")).expect("folder");
    std::fs::write(agy.keychain(), "x").expect("file");
    assert_eq!(json!(agy.dropped_env()), g["agy_with_keychain_dropped"]);
    assert_eq!(json!(sub(&agy.keychain().to_string_lossy())), g["agy_keychain_path"]);
    assert_eq!(json!(sub(&agy.mcp_config().to_string_lossy())), g["agy_mcp_config_path"]);
    for (cli, want) in g["default_dirs"].as_object().expect("dirs") {
        let p = profiles::profile_for(cli, "n", None, None).expect("profile");
        assert_eq!(json!(sub(&p.dir().to_string_lossy())), *want, "default dir of {cli}");
    }

    for case in g["status"].as_array().expect("cases") {
        let cli = case["cli"].as_str().expect("cli");
        let binary = t().join("bin").join(format!("fake-{cli}"));
        write(&format!("bin/fake-{cli}"), case["script"].as_str().expect("script"), Some(0o755));
        let p = profile(cli, "st", &t().join("profiles").join(format!("st-{cli}")), &binary.to_string_lossy());
        let st = retrying(|| p.check()).expect("a status");
        assert_eq!(status_json(&st), case["status"], "{cli}: {}", case["script"]);
        let (ok, line) = retrying(|| p.status()).expect("a line");
        assert_eq!(json!([ok, line]), case["line"], "{cli} status line");
    }

    for case in g["life"].as_array().expect("cases") {
        let cli = case["cli"].as_str().expect("cli");
        let folder = t().join("life").join(cli);
        let p = profile(cli, "life", &folder, &t().join("bin").join(format!("fake-{cli}")).to_string_lossy());
        let made = match p.create(&HashSet::new()) {
            Ok(()) => json!(true),
            Err(e) => json!(sub(&e.to_string())),
        };
        assert_eq!(made, case["created"], "{cli} created");
        assert_eq!(tree(&folder), case["tree"], "{cli} tree");
        let again = match p.create(&HashSet::new()) {
            Ok(()) => "ok",
            Err(Error::Io(_)) => "FileExistsError",
            Err(_) => "Fail",
        };
        assert_eq!(json!(again), case["again"], "{cli} again");
        let secret = match cli {
            "agy" => Some("home/.gemini/antigravity-cli/antigravity-oauth-token"),
            "codex" => Some("auth.json"),
            "opencode" => Some("data/opencode/auth.json"),
            _ => None,
        };
        if let Some(rel) = secret {
            write(&format!("life/{cli}/{rel}"), "secret", None);
        }
        retrying(|| {
            p.sign_out();
            Ok(())
        })
        .expect("sign out");
        assert_eq!(tree(&folder), case["after_sign_out"], "{cli} after sign out");
        p.remove();
        assert_eq!(json!(folder.exists()), case["after_remove"], "{cli} after remove");
    }

    for (i, case) in g["codex_prepare"].as_array().expect("cases").iter().enumerate() {
        let folder = t().join("codex-prep").join(i.to_string());
        std::fs::create_dir_all(&folder).expect("folder");
        if let Some(text) = case["before"].as_str() {
            std::fs::write(folder.join("config.toml"), text).expect("config");
        }
        let p = profile("codex", "prep", &folder, "x");
        p.prepare().expect("prepare");
        p.prepare().expect("prepare again");
        assert_eq!(
            json!(std::fs::read_to_string(folder.join("config.toml")).expect("config")),
            case["after"],
            "before {}",
            case["before"]
        );
    }

    for (i, case) in g["agy_ensure_mcp"].as_array().expect("cases").iter().enumerate() {
        let folder = t().join("agy-mcp").join(i.to_string());
        let agy = profiles::Agy(profiles::ProfileBase::new("agy", "m", Some(&folder), Some("x")).expect("base"));
        if let Some(text) = case["existing"].as_str() {
            std::fs::create_dir_all(agy.mcp_config().parent().expect("parent")).expect("folder");
            std::fs::write(agy.mcp_config(), text).expect("config");
        }
        let name = case["name"].as_str().expect("name");
        let changed = agy.ensure_mcp(name, &case["entry"]).expect("ensure");
        let again = agy.ensure_mcp(name, &case["entry"]).expect("ensure again");
        assert_eq!(json!(changed), case["changed"], "{case}");
        assert_eq!(json!(again), case["again"], "{case}");
        assert_eq!(json!(std::fs::read_to_string(agy.mcp_config()).expect("config")), case["file"], "{case}");
    }
}
