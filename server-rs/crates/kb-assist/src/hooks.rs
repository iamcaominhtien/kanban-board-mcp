//! The hooks other crates declared for the modules of this crate, backed here (`register` in `lib.rs` fills them):
//!
//! - `kb_draw::hooks::CanvasDelivery` (a canvas of a page sends its comments to an AI): `docs_ai_on` is
//!   `assistant.docs.docs_ai_on`; `deliver_to_ticket` and `deliver_to_page` stand for `services/ai/messaging.py`,
//!   which the runs task fills: they go through `seams::Runs` (`deliver_to_ticket_with`, `deliver_to_page`). The
//!   slot holds one registration (`OnceLock`), so this crate implements the whole trait; the crate that ports
//!   `messaging` fills the seam instead of registering the trait.
//! - `kb_docs::hooks::AssignHook` (`docs_work.assign_page`): `create_ticket` and `assign` are `kb_board::tickets`
//!   calls, `wake_new_assignee` goes through `seams::Runs::wake_new_assignee`.

use async_trait::async_trait;
use kb_board::tickets::{self, NewTicket, TicketUpdate};
use kb_db::Session;
use kb_docs::hooks::{AssignHook, RunBrief, TicketBrief};
use kb_draw::hooks::{CanvasDelivery, DeliverError};
use serde_json::{Value, json};

use crate::assistant::docs;
use crate::docs_ai::errors::Error;
use crate::seams::{self, DeliverError as SeamError};

/// The error a canvas caller reads (a Docs error stays one, the rest is a failure of the call).
fn for_draw(err: Error) -> kb_draw::Error {
    match err {
        Error::Docs(kb_docs::Error::Docs(e)) => kb_draw::Error::Docs(e),
        Error::Docs(kb_docs::Error::Db(e)) | Error::Db(e) => kb_draw::Error::Db(e),
        other => kb_draw::Error::Value(other.to_string()),
    }
}

/// `DeliverError` of a canvas caller from the one of the runs seam.
fn for_delivery(err: SeamError) -> DeliverError {
    match err {
        SeamError::Run(message) => DeliverError::Run(message),
        SeamError::Other(message) => DeliverError::Other(message),
    }
}

/// The `kb_draw::hooks::CanvasDelivery` this crate registers.
pub struct Delivery;

#[async_trait]
impl CanvasDelivery for Delivery {
    async fn docs_ai_on(&self, session: &Session, project_id: &str) -> kb_draw::Result<bool> {
        docs::docs_ai_on(session, project_id).await.map_err(for_draw)
    }

    async fn deliver_to_ticket(
        &self,
        ticket_id: &str,
        note: &str,
        by: &str,
        trigger: &str,
        depth: i32,
    ) -> Result<(), DeliverError> {
        let Some(runs) = seams::runs() else {
            return Err(DeliverError::Other("the runs are not connected".to_string()));
        };
        runs.deliver_to_ticket_with(ticket_id, note, by, trigger, i64::from(depth))
            .await
            .map(|_| ())
            .map_err(for_delivery)
    }

    async fn deliver_to_page(
        &self,
        page_id: &str,
        note: &str,
        by: &str,
        depth: i32,
    ) -> Result<Option<String>, DeliverError> {
        let Some(runs) = seams::runs() else {
            return Err(DeliverError::Other("the runs are not connected".to_string()));
        };
        let out = runs.deliver_to_page(page_id, note, by, i64::from(depth)).await.map_err(for_delivery)?;
        Ok(out.get("delivered").and_then(Value::as_str).map(str::to_string))
    }
}

/// The `kb_docs::hooks::AssignHook` this crate registers.
pub struct Assign;

#[async_trait]
impl AssignHook for Assign {
    async fn create_ticket(
        &self,
        session: &Session,
        project_id: &str,
        title: &str,
        description: &str,
        created_by: Option<&str>,
    ) -> Result<TicketBrief, String> {
        let mut new = NewTicket::new(title);
        new.status = "todo";
        new.description = description;
        new.created_by = created_by;
        match tickets::create_ticket(session, project_id, new).await {
            Ok(t) => Ok(TicketBrief { id: t.id, title: t.title }),
            Err(err) => Err(ticket_message(err)),
        }
    }

    async fn assign(&self, session: &Session, ticket_id: &str, member_id: &str) -> Result<(), String> {
        tickets::update_ticket(session, ticket_id, &TicketUpdate::of("assignee", json!(member_id)))
            .await
            .map(|_| ())
            .map_err(ticket_message)
    }

    async fn wake_new_assignee(
        &self,
        ticket_id: &str,
        member_id: &str,
        by: Option<&str>,
        instruction: &str,
    ) -> Option<RunBrief> {
        let runs = seams::runs()?;
        runs.wake_new_assignee(ticket_id, member_id, by, instruction).await.map(|(id, state)| RunBrief { id, state })
    }
}

/// The text of a failed ticket call (`str(exc)`).
fn ticket_message(err: tickets::Error) -> String {
    match err {
        tickets::Error::Value(message) | tickets::Error::NoResult(message) | tickets::Error::Other(message) => message,
        tickets::Error::Db(err) => err.to_string(),
    }
}
