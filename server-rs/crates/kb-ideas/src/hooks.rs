//! Idea promotion as the ticket code calls it (`kb_board::hooks::IdeaPromoteHook`): the Python ticket service imports
//! `services.idea_promote` late, inside `_sync_idea` (`services/tickets.py` lines 747-753, called after a status
//! change in `update_ticket` and in the reopen and resume functions) and in `_forget_idea` (lines 756-765, called by
//! `delete_ticket`).

use async_trait::async_trait;
use kb_db::Session;
use kb_db::entities::ticket;
use kb_db::sea_orm::DbErr;

use crate::error::Error;
use crate::idea_promote;

/// What the ticket code calls: neither function commits.
struct Promote;

/// A failure of the idea code as the trait reports it: the database error as it is, anything else as a custom one.
fn failed(err: Error) -> DbErr {
    match err {
        Error::Db(err) => err,
        other => DbErr::Custom(other.to_string()),
    }
}

#[async_trait]
impl kb_board::hooks::IdeaPromoteHook for Promote {
    async fn on_ticket_status_change(
        &self,
        session: &Session,
        ticket: &ticket::Model,
        previous_status: &str,
    ) -> Result<(), DbErr> {
        idea_promote::on_ticket_status_change(session, ticket, previous_status).await.map_err(failed)
    }

    async fn on_ticket_deleted(&self, session: &Session, ticket: &ticket::Model) -> Result<(), DbErr> {
        idea_promote::on_ticket_deleted(session, ticket).await.map_err(failed)
    }
}

/// Register idea promotion with the ticket code (once, at startup; the app calls this).
pub fn register() {
    kb_board::hooks::set_idea_promote_hook(Box::new(Promote));
}
