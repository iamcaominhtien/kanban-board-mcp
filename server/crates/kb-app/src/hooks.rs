//! Connects the areas to each other.
//!
//! Where the Python code imported an upper area late, inside a function, the Rust crate declares a hook and calls
//! through it. The app is the one crate that sees every area, so it registers each implementation here, once, at
//! startup.

use std::path::Path;

use async_trait::async_trait;
use serde_json::{Map, Value};

use kb_db::entities::docs_comment_event;
use kb_mcp::common::{ToolError, ToolResult};

struct DbMove;

#[async_trait]
impl kb_board::hooks::DbMoveHook for DbMove {
    async fn copy_current_to_sqlite(&self, path: &Path) -> Result<(), String> {
        kb_dbkit::data::copy_current_to_sqlite(path).await
    }

    async fn copy_sqlite_into_current(&self, source: &Path) -> Result<(), String> {
        kb_dbkit::data::copy_sqlite_into_current(source).await
    }
}

struct Notifications;

impl kb_doctext::docs_access::NotificationsHook for Notifications {
    fn comment_event(&self, event: &docs_comment_event::Model) {
        kb_notify::comment_event(event);
    }
}

struct DocsSearch;

#[async_trait]
impl kb_dbkit::hooks::DocsSearchHook for DocsSearch {
    async fn backfill(&self, txn: &kb_db::sea_orm::DatabaseTransaction) -> Result<(), kb_db::sea_orm::DbErr> {
        kb_docs::docs_search::backfill_sync(txn).await
    }
}

/// The AI team's side of a workspace switch: no run may be working, and the runner is stopped afterwards (it started
/// on the old board; the next run starts it again on the new one).
struct Workspaces;

#[async_trait]
impl kb_dbkit::hooks::WorkspaceHook for Workspaces {
    async fn busy(&self) -> Option<String> {
        let session = kb_db::database::session();
        let runs = kb_ai::store::active_runs(&session, None, None).await.ok()?;
        (!runs.is_empty()).then(|| {
            format!(
                "{} AI run(s) are working on this board. Wait for them to finish or stop them, then switch.",
                runs.len()
            )
        })
    }

    async fn switched(&self) {
        kb_ai::runner_link::stop().await;
    }
}

struct McpTools;

#[async_trait]
impl kb_skills::hooks::McpToolsHook for McpTools {
    async fn tool_count(&self) -> usize {
        kb_mcp::registry::registered(kb_mcp::ideas_enabled()).len()
    }
}

/// `kb_mcp::hooks::AiGuardHook` as `services/ai/guard.py` backs it.
struct AiGuard;

fn run_context(context: kb_ai::context::RunContext) -> kb_mcp::hooks::RunContext {
    kb_mcp::hooks::RunContext {
        run_id: context.run_id,
        member_id: context.member_id,
        member_name: context.member_name,
        project_id: context.project_id,
        ticket_id: context.ticket_id,
        on_behalf_of: context.on_behalf_of,
        mode: context.mode,
        trigger: context.trigger,
        depth: context.depth,
        acts_by_tier: context.acts_by_tier,
    }
}

#[async_trait]
impl kb_mcp::hooks::AiGuardHook for AiGuard {
    async fn resolve(&self, authorization: Option<&str>) -> Result<Option<kb_mcp::hooks::RunContext>, String> {
        match kb_ai::guard::resolve_for(authorization).await {
            Ok(context) => Ok(context.map(run_context)),
            Err(err) => Err(err.to_string()),
        }
    }

    async fn guarded(
        &self,
        tool: &str,
        action: &str,
        given: Map<String, Value>,
        authorization: Option<&str>,
        call: kb_mcp::hooks::GuardedCall,
    ) -> ToolResult {
        use kb_ai::guard::{Error, GuardedError};
        match kb_ai::guard::guarded_for(authorization, tool, action, given, call).await {
            Ok(value) => Ok(value),
            // `AiActionError` is a `ValueError`: a call refused on purpose
            Err(GuardedError::Guard(Error::Action(refused))) => Err(ToolError::Value(refused.0)),
            Err(GuardedError::Guard(err)) => Err(ToolError::Other(err.to_string())),
            Err(GuardedError::Call(err)) => Err(err),
        }
    }
}

/// `kb_mcp::hooks::AiTicketViewHook`: `comment_view.for_caller` and `worktrees.brief`.
struct AiTicketView;

#[async_trait]
impl kb_mcp::hooks::AiTicketViewHook for AiTicketView {
    async fn comments_for_caller(
        &self,
        project_id: &str,
        raw: Vec<Value>,
        authorization: Option<&str>,
    ) -> Result<Option<(Vec<Value>, i64)>, String> {
        // `for_caller` asks the guard, which reads the header of the request being handled
        let token = kb_ai::guard::set_request_authorization(authorization);
        let session = kb_db::database::session();
        let viewed = kb_ai::comment_view::for_caller(&session, project_id, &raw).await;
        kb_base::ctx::reset(token);
        let Some(mut viewed) = viewed.map_err(|err| err.to_string())? else { return Ok(None) };
        let comments = match viewed.remove("comments") {
            Some(Value::Array(comments)) => comments,
            _ => Vec::new(),
        };
        let held_back = viewed.get("held_back").and_then(Value::as_i64).unwrap_or(0);
        Ok(Some((comments, held_back)))
    }

    async fn worktree_brief(&self, ticket_id: &str) -> Result<Option<Value>, String> {
        kb_ai_work::worktrees::worktree_brief(ticket_id).await
    }
}

/// `kb_mcp::hooks::BoardSkillsHook`: the plugin folder of `services/ai/board_skills.py`, written as it is asked for.
struct BoardSkills;

/// The plugin folder, or the place it would be when it could not be written (Python raises there; the guide that
/// prints the path is still worth reading).
fn plugin_dir() -> String {
    kb_ai_know::board_skills::plugin_dir(None).unwrap_or_else(|err| {
        tracing::error!(target: "kanban.http", "Could not write the board's skills folder: {err}");
        let db = kb_db::database::get_db_path();
        db.parent().map(Path::to_path_buf).unwrap_or_default().join("board-skills").to_string_lossy().into_owned()
    })
}

impl kb_mcp::hooks::BoardSkillsHook for BoardSkills {
    fn skill_dir(&self, name: &str) -> String {
        Path::new(&plugin_dir()).join("skills").join(name).to_string_lossy().into_owned()
    }

    fn examples_dir(&self) -> String {
        Path::new(&plugin_dir()).join("skills").join("canvas-design").join("examples").to_string_lossy().into_owned()
    }
}

/// Register every hook (a second call changes nothing).
pub fn install() {
    kb_ai::hooks::register();
    // (it keeps what was registered before it for the calls it does not back itself)
    kb_ai_work::register();
    kb_ai_run::register();
    kb_assist::register();
    kb_skills::hooks::set_mcp_tools_hook(Box::new(McpTools));
    kb_mcp::hooks::set_ai_guard_hook(Box::new(AiGuard));
    kb_mcp::hooks::set_ai_ticket_view_hook(Box::new(AiTicketView));
    kb_mcp::hooks::set_board_skills_hook(Box::new(BoardSkills));
    kb_docs::hooks::register();
    kb_ideas::register();
    kb_dbkit::hooks::set_docs_search_hook(Box::new(DocsSearch));
    kb_dbkit::hooks::set_workspace_hook(Box::new(Workspaces));
    kb_board::hooks::set_db_move_hook(Box::new(DbMove));
    kb_doctext::docs_access::set_notifications_hook(Box::new(Notifications));
    // `kanban_mcp/common.py` registers its listener when it is imported: an MCP tool names what it wrote
    kb_mcp::common::install_write_listener();
    // the database watcher waits longer for an announcement while the AI runner runs (`events._grace_for`)
    kb_base::events::set_runner_alive_hook(kb_ai::runner_link::alive);
}
