//! A stand-in for the `claude` command-line program, for tests (`server/tests/fixtures/fake_claude.py` ported as the
//! binary `fake-claude`, see `src/main.rs`): it behaves like `claude` according to `FAKE_CLAUDE_MODE` and the other
//! `FAKE_CLAUDE_*` variables and speaks stream-json. It never talks to the network and writes only where its
//! environment points it.
//!
//! A test of another crate starts it through this library: add `fake-claude` as a dev-dependency, then
//! `fake_claude::bin_path()` is the program (built on first use when the test run did not build it) and
//! `fake_claude::install(&folder, "claude")` puts it into a folder under the name the board looks for, so a `PATH`
//! that starts with that folder resolves `claude` to the fake.
//!
//! Modes (`FAKE_CLAUDE_MODE`, default `finish`): `finish`, `logged_out`, `no_conversation`, `run_logged_out`, `silent`,
//! `spawn`, `window`, `network`, `crash`, `too_long`, `dev_server`, `skill`, `sleep`, `ticks`, `rate_limit`, `fail`,
//! `wait_question`, `assistant`, `v2`, `v2_ask` (anything that starts with `v2`), `linger`. Subcommands: `--version`,
//! `auth status`, `auth logout`, `auth login`, and the one-shot `--output-format json`.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

pub mod pyjson;

/// The name of the program file.
pub const BIN_NAME: &str = if cfg!(windows) { "fake-claude.exe" } else { "fake-claude" };

static BIN: OnceLock<PathBuf> = OnceLock::new();

/// The `fake-claude` program: `FAKE_CLAUDE_BIN` when set, else the one in the build folder of the running test
/// (`<target>/<profile>/fake-claude`), built with `cargo build -p fake-claude` when it is not there yet.
///
/// # Panics
/// When the program is not there and cannot be built: a test cannot go on without it.
pub fn bin_path() -> PathBuf {
    BIN.get_or_init(|| {
        if let Some(path) = std::env::var_os("FAKE_CLAUDE_BIN").filter(|v| !v.is_empty()) {
            return PathBuf::from(path);
        }
        let profile_dir = profile_dir();
        let path = profile_dir.join(BIN_NAME);
        if !path.is_file() {
            build(&profile_dir);
        }
        assert!(path.is_file(), "fake-claude was not built at {}", path.display());
        path
    })
    .clone()
}

/// `<target>/<profile>`: a test program lives in its `deps` folder, a binary in the folder itself.
fn profile_dir() -> PathBuf {
    let exe = std::env::current_exe().expect("the path of the running test");
    let dir = exe.parent().expect("a test program is inside a folder");
    if dir.file_name().is_some_and(|n| n == "deps") { dir.parent().unwrap_or(dir).to_path_buf() } else { dir.to_path_buf() }
}

fn build(profile_dir: &Path) {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let mut command = Command::new(cargo);
    command.args(["build", "-p", "fake-claude", "--bin", "fake-claude"]);
    command.current_dir(env!("CARGO_MANIFEST_DIR"));
    if let Some(target_dir) = profile_dir.parent() {
        command.arg("--target-dir").arg(target_dir);
    }
    if profile_dir.file_name().is_some_and(|n| n == "release") {
        command.arg("--release");
    }
    let status = command.status().expect("cargo runs");
    assert!(status.success(), "cargo build -p fake-claude failed");
}

/// Put the fake into `folder` under `name` (`claude`): a link to the program, or a copy where links are not allowed.
/// Returns the path. The folder is created when missing.
///
/// # Panics
/// When the folder or the file cannot be written.
pub fn install(folder: &Path, name: &str) -> PathBuf {
    std::fs::create_dir_all(folder).expect("the folder of the fake CLI");
    let name = if cfg!(windows) && !name.ends_with(".exe") { format!("{name}.exe") } else { name.to_string() };
    let target = folder.join(name);
    let _ = std::fs::remove_file(&target);
    let source = bin_path();
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(&source, &target).is_ok();
    #[cfg(not(unix))]
    let linked = false;
    if !linked {
        std::fs::copy(&source, &target).expect("copy of the fake CLI");
    }
    target
}
