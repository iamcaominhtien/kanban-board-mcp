//! Connects the areas to each other.
//!
//! Where the Python code imported an upper area late, inside a function, the Rust crate declares a hook and calls
//! through it. The app is the one crate that sees every area, so it registers each implementation here, once, at
//! startup.

use std::path::Path;

use async_trait::async_trait;

use kb_db::entities::docs_comment_event;

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

struct McpTools;

#[async_trait]
impl kb_skills::hooks::McpToolsHook for McpTools {
    async fn tool_count(&self) -> usize {
        kb_mcp::registry::registered(kb_mcp::ideas_enabled()).len()
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
    kb_docs::hooks::register();
    kb_ideas::register();
    kb_dbkit::hooks::set_docs_search_hook(Box::new(DocsSearch));
    kb_board::hooks::set_db_move_hook(Box::new(DbMove));
    kb_doctext::docs_access::set_notifications_hook(Box::new(Notifications));
}
