//! Ticket test cases.

use kb_board::proofs;
use kb_board::tickets::{self as svc_tickets, NewTestCase, TestCaseChanges};

use crate::common::{ToolError, ToolResult, attach_folder, edit_ticket, notify_on_success};

/// `_localized`: proof and notes with the pictures named by a path copied into the board (`kb_board::proofs`).
async fn localized(proof: Option<&str>, notes: Option<&str>) -> Result<(Option<String>, Option<String>), ToolError> {
    // `"](" not in (proof or "") + (notes or "")`
    let joined = format!("{}{}", proof.unwrap_or_default(), notes.unwrap_or_default());
    if !joined.contains("](") {
        return Ok((proof.map(str::to_string), notes.map(str::to_string)));
    }
    let folder = attach_folder().await?.unwrap_or_default();
    let keep = Default::default();
    let proof = proofs::localize(proof, &folder, false, &keep).await.map_err(|err| ToolError::Value(err.0))?;
    let notes = proofs::localize(notes, &folder, false, &keep).await.map_err(|err| ToolError::Value(err.0))?;
    Ok((proof, notes))
}

/// Add a test case to a ticket to track verification. It gets a code 'TC-<n>' (shown in the returned `test_cases`).
/// With the ticket's "Done requires: all test cases passed" guard on, the ticket cannot move to 'done' until every
/// test case has status 'pass'. Returns the updated ticket.
#[allow(clippy::too_many_arguments)]
pub async fn add_test_case(
    ticket_id: &str,
    title: &str,
    status: &str,
    description: Option<&str>,
    expected_result: Option<&str>,
    notes: Option<&str>,
    proof: Option<&str>,
    note: Option<&str>,
    assignee: Option<&str>,
) -> ToolResult {
    notify_on_success(async {
        let (proof, notes) = localized(proof, notes).await?;
        edit_ticket(ticket_id, None, |s, _| async move {
            let new = NewTestCase {
                status,
                proof: proof.as_deref(),
                note,
                description,
                expected_result,
                notes: notes.as_deref(),
                assignee,
                ..NewTestCase::new(title)
            };
            svc_tickets::add_test_case(&s, ticket_id, new).await.map_err(ToolError::from)
        })
        .await
    })
    .await
}

/// Update a test case, typically its `status` after running it (and `proof`). Omitted fields are unchanged.
/// Returns the updated ticket.
#[allow(clippy::too_many_arguments)]
pub async fn update_test_case(
    ticket_id: &str,
    test_case_id: &str,
    title: Option<&str>,
    status: Option<&str>,
    description: Option<&str>,
    expected_result: Option<&str>,
    notes: Option<&str>,
    proof: Option<&str>,
    note: Option<&str>,
    assignee: Option<&str>,
) -> ToolResult {
    notify_on_success(async {
        let (proof, notes) = localized(proof, notes).await?;
        edit_ticket(ticket_id, Some(("test_case", test_case_id)), |s, tid| async move {
            let changes = TestCaseChanges {
                status,
                proof: proof.as_deref(),
                note,
                title,
                description,
                expected_result,
                notes: notes.as_deref(),
                assignee,
                ..TestCaseChanges::default()
            };
            svc_tickets::update_test_case(&s, ticket_id, &tid.unwrap_or_default(), changes)
                .await
                .map_err(ToolError::from)
        })
        .await
    })
    .await
}

/// Delete a test case permanently (its work-log links are not changed). Returns the updated ticket.
pub async fn delete_test_case(ticket_id: &str, test_case_id: &str) -> ToolResult {
    notify_on_success(edit_ticket(ticket_id, Some(("test_case", test_case_id)), |s, tid| async move {
        svc_tickets::delete_test_case(&s, ticket_id, &tid.unwrap_or_default()).await.map_err(ToolError::from)
    }))
    .await
}
