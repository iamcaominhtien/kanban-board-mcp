//! The calls of this crate that the Python tests replace with `monkeypatch`: the light model (`_ask_light`), the AI that
//! reads the repository (`_ask_ai`) and whether the AI can run at all (`ai_status`). Python looks those up as module
//! globals at each call; here each call goes through `asker()`, which is `Real` unless a test put its own in.
//!
//! Nothing here waits for another module: every module `repo_scan.py` imports (`accounts`, `cli`, `ops`, `packs`,
//! `paths`, `plugins`, `project_env`, `store`, `worktrees`, and the late `knowledge` and `teams`) is ported, so this
//! crate leaves no seam for a later task.

use std::sync::{Arc, RwLock};

use async_trait::async_trait;
use kb_db::Session;
use kb_db::entities::ai_account;
use serde_json::Value;

use crate::Error;
use crate::cancel::Cancel;

/// Why a call of the AI did not give an answer.
#[derive(Debug)]
pub enum AskError {
    /// The exception Python raises (`RuntimeError`...): its text.
    Failed(String),
    /// The job was told to stop while it waited.
    Cancelled,
}

/// What gets each thing the AI does (`on_line`).
pub type OnLine<'a> = dyn Fn(&str) + Send + Sync + 'a;

/// What the scan asks of the models.
#[async_trait]
pub trait Asker: Send + Sync {
    /// `_ask_light(prompt, account)`: one call of the light model on the project's Claude Code account.
    async fn ask_light(&self, prompt: &str, account: Option<&ai_account::Model>) -> Result<Option<String>, AskError>;

    /// `_ask_ai(prompt, cwd, account, on_line)`: one Claude Code run that may only read (Read, Glob, Grep) in `cwd`;
    /// returns its final text. `on_line` gets what it does ("Read .github/workflows/ci.yml").
    async fn ask_ai(
        &self,
        prompt: &str,
        cwd: &str,
        account: Option<&ai_account::Model>,
        on_line: &OnLine<'_>,
        cancel: &Cancel,
    ) -> Result<Option<String>, AskError>;

    /// `ai_status(session, force)`: `{"available": bool, "why": str | None}`.
    async fn ai_status(&self, session: &Session, force: bool) -> Result<Value, Error>;
}

/// The real calls (`crate::job::ask_ai`, `crate::refine::ask_light`, `crate::job::ai_status_real`). A test that
/// replaces one call can hand the others to this.
pub struct Real;

#[async_trait]
impl Asker for Real {
    async fn ask_light(&self, prompt: &str, account: Option<&ai_account::Model>) -> Result<Option<String>, AskError> {
        Ok(crate::refine::ask_light_real(prompt, account).await)
    }

    async fn ask_ai(
        &self,
        prompt: &str,
        cwd: &str,
        account: Option<&ai_account::Model>,
        on_line: &OnLine<'_>,
        cancel: &Cancel,
    ) -> Result<Option<String>, AskError> {
        crate::job::ask_ai_real(prompt, cwd, account, on_line, cancel).await
    }

    async fn ai_status(&self, session: &Session, force: bool) -> Result<Value, Error> {
        crate::job::ai_status_real(session, force).await
    }
}

static ASKER: RwLock<Option<Arc<dyn Asker>>> = RwLock::new(None);

/// Replace the calls (tests); `None` puts the real ones back.
pub fn set_asker(asker: Option<Arc<dyn Asker>>) {
    *ASKER.write().unwrap_or_else(|e| e.into_inner()) = asker;
}

/// The calls in use.
pub fn asker() -> Arc<dyn Asker> {
    ASKER.read().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_else(|| Arc::new(Real))
}
