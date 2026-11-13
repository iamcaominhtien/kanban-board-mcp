//! Scan, suggest and try (`repo_scan.py` lines 658-712: `run_scan`).

use kb_ai::{paths, store};
use kb_ai_work::project_env;
use kb_base::{pyjson, pytext};
use kb_db::Session;
use kb_db::entities::ai_repo_scan;
use kb_db::sea_orm::ActiveModelTrait;
use kb_db::sea_orm::ActiveValue::Set;
use serde_json::{Map, Value, json};

use crate::Error;
use crate::detect::scan;
use crate::refine::refine_suggestion;
use crate::suggest::suggest;
use crate::trial::{TryOptions, try_commands};

/// What `run_scan` takes beside the session, the project and the folder.
#[derive(Debug, Clone, Copy)]
pub struct ScanOptions<'a> {
    /// `trial`: try the commands (the default).
    pub trial: bool,
    /// `refine`: ask a light model to improve the role and plugin suggestions.
    pub refine: bool,
    /// `prepare`: the command as the person edited it (`Some("")` for none): tried instead of the suggestion's.
    pub prepare: Option<&'a str>,
    /// `test`: the same for the test command.
    pub test: Option<&'a str>,
}

impl Default for ScanOptions<'_> {
    fn default() -> Self {
        ScanOptions { trial: true, refine: false, prepare: None, test: None }
    }
}

/// Scan, suggest and (by default) try the commands; nothing is created. `refine` asks a light model to improve the role
/// and plugin suggestions (it fails soft back to the code's). `prepare` and `test` are the commands as the person
/// edited them: when given ("" for none), they are tried instead of the suggestion's.
///
/// Fails with `Error::Value` when there is no such folder, or one the AI members could not work in (outside the home
/// folder and `KANBAN_AI_ROOTS`): said at step 1, not after the whole wizard when Create skips every member.
pub async fn run_scan(
    session: &Session,
    project_id: &str,
    folder: &str,
    opts: ScanOptions<'_>,
) -> Result<ai_repo_scan::Model, Error> {
    // the real, absolute path, checked to sit inside the places people keep their work: everything below reads and
    // runs in this one, never in the text the request carried
    let folder = match paths::folder(folder).await {
        Ok(folder) => folder,
        Err(_) => {
            return Err(Error::Value(format!(
                "The AI team can only work in a folder inside your home folder, or one listed in {roots}. \
                 Move the repository there, or add its parent folder to {roots}: {}",
                pytext::strip(folder),
                roots = paths::ROOTS_ENV
            )));
        }
    };
    let found = scan(&folder).await?;
    let mut proposal = suggest(&found)?;
    if opts.refine {
        proposal = refine_suggestion(session, project_id, &found, &proposal, None).await;
    }
    let mut tried = Value::Object(Map::new());
    if opts.trial {
        let settings = store::get_settings(session, project_id).await?;
        let mut commands = Map::new();
        let prepare = match opts.prepare {
            None => proposal.get("prepare").cloned().unwrap_or(Value::Null),
            Some(p) => json!(pytext::strip(p)),
        };
        let test = match opts.test {
            None => proposal.get("commands").and_then(|c| c.get("test")).cloned().unwrap_or(Value::Null),
            Some(t) => json!(pytext::strip(t)),
        };
        commands.insert("prepare".into(), prepare);
        commands.insert("test".into(), test);
        let extra = project_env::extra(Some(&settings));
        let only = ["test".to_string()];
        let out = try_commands(
            found.get("folder").and_then(Value::as_str).unwrap_or(&folder),
            &commands,
            TryOptions { extra_path: Some(&extra), only: Some(&only), ..TryOptions::default() },
        )
        .await?;
        tried = json!({"prepare": out["prepare"], "test": out["test"]});
    }
    let mut row = ai_repo_scan::new();
    row.project_id = Set(project_id.to_string());
    row.folder = Set(found.get("folder").and_then(Value::as_str).unwrap_or(&folder).to_string());
    row.found = Set(pyjson::dumps(&found));
    row.suggested = Set(pyjson::dumps(&proposal));
    row.trial = Set(pyjson::dumps(&tried));
    let row = row.insert(session).await?;
    session.commit().await?;
    Ok(row)
}
