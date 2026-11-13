//! What `register()` installs for the crates below: the light model's calls into `cli` and `accounts`
//! (`kb_ai_know::seams::Cli`), asked from a plain function as `kb-ai-know` asks them, and the slots `teams` and
//! `launch` leave for modules a later task ports.

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod common;

use kb_ai_run::seams;

#[tokio::test]
async fn register_fills_the_cli_seam_of_the_knowledge_crate() {
    let _guard = common::init().await;
    kb_ai_run::register();
    let cli = kb_ai_know::seams::cli().expect("registered");
    // the CLI on PATH, a configured one, and none where the configured path is not a program
    assert_eq!(cli.find_cli("claude", None), Some(common::fake_cli()));
    assert_eq!(cli.find_cli("claude", Some(&common::real_cli())), Some(common::real_cli()));
    assert_eq!(cli.find_cli("claude", Some(&common::tmp_path("none").join("claude").to_string_lossy())), None);
    let env = cli.child_env();
    assert_eq!(env.get("MCP_TOOL_TIMEOUT").map(String::as_str), Some("900000"));
    assert!(env.contains_key("PATH") && !env.contains_key("CLAUDECODE"));
    // an account's own login: its folder, and no credential of the board's shell
    let account = common::account("Seam").await;
    let mut base = env.clone();
    base.insert("ANTHROPIC_API_KEY".into(), "sk-ant-board".into());
    let with_account = cli.env_for_account(&account, base);
    assert_eq!(with_account.get("CLAUDE_CONFIG_DIR"), Some(&account.folder));
    assert!(!with_account.contains_key("ANTHROPIC_API_KEY"));
    assert_eq!(with_account.get("PATH"), env.get("PATH"));
    // a process tree is stopped through `cli.kill_tree`
    let mut command = std::process::Command::new("sleep");
    command.arg("30");
    kb_ai_run::cli::popen_kwargs_std(&mut command);
    let mut child = command.spawn().expect("sleep");
    cli.kill_tree(child.id());
    let status = child.wait().expect("ended");
    assert!(!status.success());
    // and the power module's runtime is there
    assert!(kb_ai::seams::runs_runtime().is_some());
}

#[test]
fn the_slots_for_later_modules_start_empty() {
    assert!(seams::run_procs().is_none());
    // (`session_history` is called directly; its slot is for a test that replaces it)
    assert!(seams::session_history().is_none());
    // the assistant lives in a crate above: `kb-assist` fills the slot
    assert!(seams::assistant().is_none());
}
