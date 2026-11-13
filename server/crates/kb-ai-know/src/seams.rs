//! Places where this crate's modules call AI-team modules that a later task ports (`cli`, `accounts`). Python imports
//! those late, inside a function; here each call goes through a slot the later task fills when it ports that module.
//! A slot that is not filled behaves as the Python call would on a computer with no Claude Code CLI: the light model
//! is not asked (its callers fall back to code).
//!
//! | seam | stands for | filled by |
//! |---|---|---|
//! | `Cli::find_cli` | `cli.find_cli("claude", profile.cli_path)[0]` (`kb._ask_light`, `knowledge._ask_light_model`) | `cli` |
//! | `Cli::child_env` | `cli.child_env(None)` | `cli` |
//! | `Cli::kill_tree` | `cli.kill_tree(pid)` (`knowledge._ask_light_model`, after a timeout) | `cli` |
//! | `Cli::env_for_account` | `accounts.env_for(account, env)` | `accounts` |

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use kb_db::entities::ai_account;

/// What the light-model calls ask of `cli` and `accounts`.
pub trait Cli: Send + Sync {
    /// `cli.find_cli(kind, cli_path)[0]`: the path of the CLI, or None when there is none.
    fn find_cli(&self, kind: &str, cli_path: Option<&str>) -> Option<String>;
    /// `cli.child_env(None)`: the environment a CLI child gets.
    fn child_env(&self) -> HashMap<String, String>;
    /// `accounts.env_for(account, env)`: `env` with the account's folder and sign-in.
    fn env_for_account(&self, account: &ai_account::Model, env: HashMap<String, String>) -> HashMap<String, String>;
    /// `cli.kill_tree(pid)`: the process and everything it started.
    fn kill_tree(&self, pid: u32);
}

static CLI: RwLock<Option<Arc<dyn Cli>>> = RwLock::new(None);

/// Fill the `cli` / `accounts` seam (a later call replaces the earlier one, which tests use).
pub fn set_cli(cli: Option<Arc<dyn Cli>>) {
    *CLI.write().unwrap_or_else(|e| e.into_inner()) = cli;
}

/// The `cli` / `accounts` seam, when those modules have been ported and registered.
pub fn cli() -> Option<Arc<dyn Cli>> {
    CLI.read().unwrap_or_else(|e| e.into_inner()).clone()
}
