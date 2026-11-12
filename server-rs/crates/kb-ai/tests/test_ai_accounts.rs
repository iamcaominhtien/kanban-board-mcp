//! AI accounts, the part that is `services/ai/profiles.py`: what each CLI needs (`test_ai_accounts.py`, the tests before
//! "the account API"). The account API, the sign-in terminal, members that run as an account and who may do what wait
//! for `accounts`, `signin`, `cli` and `runs`. `test_a_cli_without_check_cannot_be_made` has no Rust form: a type that
//! does not implement `Profile::check` does not compile.

use std::collections::HashSet;
use std::os::unix::fs::PermissionsExt;

use kb_ai::profiles::{self, Env};
use serde_json::json;

fn path_text(p: &std::path::Path) -> String {
    p.to_string_lossy().into_owned()
}

fn get<'a>(env: &'a Env, key: &str) -> Option<&'a str> {
    env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

#[test]
fn test_each_cli_keeps_its_login_in_its_own_place() {
    let tmp = tempfile::tempdir().expect("temporary folder");
    let at = |name: &str| tmp.path().join(name);
    let claude = profiles::profile_for("claude", "w", Some(&at("w")), None).expect("profile");
    assert_eq!(claude.env(), [("CLAUDE_CONFIG_DIR".to_string(), path_text(&at("w")))]);
    let codex = profiles::profile_for("codex", "x", Some(&at("x")), None).expect("profile");
    assert_eq!(codex.env(), [("CODEX_HOME".to_string(), path_text(&at("x")))]);
    let opencode = profiles::profile_for("opencode", "o", Some(&at("o")), None).expect("profile");
    let keys: HashSet<String> = opencode.env().into_iter().map(|(k, _)| k).collect();
    assert_eq!(keys, ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"].map(String::from).into());
    let agy = profiles::profile_for("agy", "a", Some(&at("a")), None).expect("profile");
    assert_eq!(get(&agy.env(), "HOME"), Some(path_text(&at("a").join("home")).as_str()));
}

#[test]
fn test_overlay_drops_variables_that_hide_the_account_and_keeps_the_rest() {
    let tmp = tempfile::tempdir().expect("temporary folder");
    let claude = profiles::profile_for("claude", "w", Some(&tmp.path().join("w")), None).expect("profile");
    let base: Env = [("PATH", "/bin"), ("ANTHROPIC_API_KEY", "k"), ("CLAUDE_CODE_OAUTH_TOKEN", "t")]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    let out = claude.overlay(&base);
    assert_eq!(get(&out, "PATH"), Some("/bin"));
    assert_eq!(get(&out, "CLAUDE_CONFIG_DIR"), Some(path_text(&tmp.path().join("w")).as_str()));
    assert!(get(&out, "ANTHROPIC_API_KEY").is_none() && get(&out, "CLAUDE_CODE_OAUTH_TOKEN").is_none());
    // the caller's environment is not changed
    assert_eq!(get(&base, "ANTHROPIC_API_KEY"), Some("k"));
}

#[test]
fn test_codex_profile_keeps_the_login_in_a_file() {
    let tmp = tempfile::tempdir().expect("temporary folder");
    let codex = profiles::profile_for("codex", "x", Some(&tmp.path().join("x")), None).expect("profile");
    codex.create(&HashSet::new()).expect("create");
    let config = tmp.path().join("x").join("config.toml");
    let text = std::fs::read_to_string(&config).expect("config");
    assert!(text.starts_with("cli_auth_credentials_store = \"file\""));
    // idempotent
    codex.prepare().expect("prepare");
    assert_eq!(std::fs::read_to_string(&config).expect("config"), text);
}

/// Codex prints warnings before its answer when the profile is under a temporary folder; the first line is not it.
fn codex_check(answer: &str, signed_in: bool, method: Option<&str>) {
    let tmp = tempfile::tempdir().expect("temporary folder");
    let fake = tmp.path().join("codex");
    std::fs::write(
        &fake,
        format!("#!/bin/sh\necho 'WARNING: proceeding, even though we could not create PATH aliases' >&2\necho '{answer}' >&2\n"),
    )
    .expect("script");
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).expect("mode");
    let codex =
        profiles::profile_for("codex", "x", Some(&tmp.path().join("x")), Some(&path_text(&fake))).expect("profile");
    // starting a script just written can meet "text file busy" while another test forks: try again
    let mut status = None;
    for _ in 0..20 {
        match codex.check() {
            Ok(s) => {
                status = Some(s);
                break;
            }
            Err(profiles::Error::Io(e)) if e.kind() == std::io::ErrorKind::ExecutableFileBusy => {
                std::thread::sleep(std::time::Duration::from_millis(50))
            }
            Err(e) => panic!("{e}"),
        }
    }
    let status = status.expect("a status");
    assert_eq!(status.signed_in, signed_in);
    assert_eq!(status.detail, answer);
    assert_eq!(status.method.as_deref(), method);
}

#[test]
fn test_codex_check_reads_the_answer_even_after_a_warning_not_logged_in() {
    codex_check("Not logged in", false, None);
}

#[test]
fn test_codex_check_reads_the_answer_even_after_a_warning_logged_in() {
    codex_check("Logged in using ChatGPT", true, Some("ChatGPT"));
}

#[test]
fn test_bad_names_are_refused() {
    let tmp = tempfile::tempdir().expect("temporary folder");
    for bad in ["", "../x", ".hidden", "a/b", "-x"] {
        assert!(profiles::profile_for("claude", bad, Some(&tmp.path().join("x")), None).is_err(), "{bad:?}");
    }
    assert_eq!(
        profiles::profile_for("claude", "", None, None).err().map(|f| f.0),
        Some("missing profile name".to_string())
    );
    assert_eq!(
        profiles::profile_for("claude", "a/b", None, None).err().map(|f| f.0),
        Some("bad profile name: 'a/b'".to_string())
    );
    assert_eq!(json!(profiles::CLIS), json!(["agy", "claude", "codex", "opencode"]));
}
