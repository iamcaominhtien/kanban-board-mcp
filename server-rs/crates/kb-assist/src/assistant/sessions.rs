//! One Claude Code conversation per thing an assistant talks about (AI v2): `docs:<page>`, `board:<project>`,
//! `chat:<chat id>`, `idea:<idea>`, `sketch:<sketch>` (`services/assistant/sessions.py`, lines 1 to 104). The id is
//! kept in the `docs_ai_session` table (scope = the name, member_id = "assistant"); it is resumed only while the CLI
//! still has it on disk, and one turn at a time uses it.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use kb_ai::store::now_iso;
use kb_ai_run::cli::session_exists;
use kb_db::database;
use kb_db::entities::docs_ai_session;
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, IntoActiveModel, ModelTrait, QueryFilter};
use tokio::sync::OwnedMutexGuard;

/// The `member_id` of a conversation's row: it belongs to the assistant, not to a team.
pub const MEMBER: &str = "assistant";

/// `_LOCKS`: one lock per conversation, made on first use and kept.
static LOCKS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The conversation of a Docs page.
pub fn page_name(page_id: &str) -> String {
    format!("docs:{page_id}")
}

/// The conversation of a project's board.
pub fn board_name(project_id: &str) -> String {
    format!("board:{project_id}")
}

/// The conversation of a Board AI chat.
pub fn chat_name(chat_id: &str) -> String {
    format!("chat:{chat_id}")
}

/// The conversation of an idea.
pub fn idea_name(idea_id: &str) -> String {
    format!("idea:{idea_id}")
}

/// The conversation of a sketch.
pub fn sketch_name(sketch_id: &str) -> String {
    format!("sketch:{sketch_id}")
}

/// Whether a turn is using the conversation now.
pub fn is_busy(name: &str) -> bool {
    let lock = LOCKS.lock().unwrap_or_else(|e| e.into_inner()).get(name).cloned();
    lock.is_some_and(|lock| lock.try_lock().is_err())
}

/// Hold the conversation while a turn uses it (a CLI session cannot be resumed twice at once): it is held until the
/// guard is dropped (Python: `async with sessions.exclusive(name):`).
pub async fn exclusive(name: &str) -> OwnedMutexGuard<()> {
    let lock = LOCKS.lock().unwrap_or_else(|e| e.into_inner()).entry(name.to_string()).or_default().clone();
    lock.lock_owned().await
}

/// The session to resume, or None when there is none or the CLI no longer has it.
pub async fn lookup(name: &str, config_dir: Option<&str>) -> Result<Option<String>, DbErr> {
    let session = database::session();
    let Some(row) = docs_ai_session::Entity::find_by_id((name.to_string(), MEMBER.to_string())).one(&session).await?
    else {
        return Ok(None);
    };
    if session_exists(&row.session_id, config_dir, Some("claude-code")) {
        return Ok(Some(row.session_id));
    }
    row.delete(&session).await?;
    session.commit().await?;
    Ok(None)
}

/// Keep the conversation's session id for the next turn.
pub async fn remember(name: &str, project_id: &str, session_id: &str) -> Result<(), DbErr> {
    let session = database::session();
    let row = docs_ai_session::Entity::find_by_id((name.to_string(), MEMBER.to_string())).one(&session).await?;
    match row {
        None => {
            let mut row = docs_ai_session::new();
            row.scope = Set(name.to_string());
            row.member_id = Set(MEMBER.to_string());
            row.project_id = Set(project_id.to_string());
            row.session_id = Set(session_id.to_string());
            row.calls = Set(1);
            row.updated_at = Set(now_iso());
            row.insert(&session).await?;
        }
        Some(row) => {
            let calls = row.calls + 1;
            let mut row = row.into_active_model();
            row.session_id = Set(session_id.to_string());
            row.calls = Set(calls);
            row.updated_at = Set(now_iso());
            row.update(&session).await?;
        }
    }
    session.commit().await
}

/// Drop the conversation: the next turn starts a new one.
pub async fn forget(name: &str) -> Result<(), DbErr> {
    let session = database::session();
    let rows = docs_ai_session::Entity::find().filter(docs_ai_session::Column::Scope.eq(name)).all(&session).await?;
    for row in rows {
        row.delete(&session).await?;
    }
    session.commit().await
}

/// A shared conversation's prompt starts with who is asking.
pub fn asked_by(person: Option<&str>, prompt: &str) -> String {
    match person.filter(|p| !p.is_empty() && !matches!(*p, "system" | "user")) {
        None => prompt.to_string(),
        Some(person) => format!("{person} is asking.\n\n{prompt}"),
    }
}
