//! `api/tickets.py`, lines 883-991: the test cases of a ticket.

use axum::Json;
use kb_base::error::{Body, Path};
use kb_base::{ApiResult, Routes};
use serde::Deserialize;
use serde_json::{Map, Value};

use super::{bad_request, changed, uncaught};
use crate::schemas::TicketRead;
use crate::tickets::schemas::literal;
use crate::tickets::{NewTestCase, TestCaseChanges, add_test_case, delete_test_case, update_test_case};

/// The routes of this part.
pub(super) fn routes() -> Routes {
    Routes::new()
        .post("/tickets/{ticket_id}/test-cases", post_test_case)
        .patch("/tickets/{ticket_id}/test-cases/{tc_id}", patch_test_case)
        .delete("/tickets/{ticket_id}/test-cases/{tc_id}", del_test_case)
}

literal! {
    /// `Literal["pending", "running", "pass", "fail"]`.
    TestCaseStatus { Pending => "pending", Running => "running", Pass => "pass", Fail => "fail" }
}

fn default_status() -> TestCaseStatus {
    TestCaseStatus::Pending
}

/// `list[dict[str, Any]]` as the list of values the service takes.
fn objects(items: Vec<Map<String, Value>>) -> Vec<Value> {
    items.into_iter().map(Value::Object).collect()
}

/// Request body to add a test case.
#[derive(Debug, Deserialize)]
struct TestCaseCreateBody {
    title: String,
    #[serde(default = "default_status")]
    status: TestCaseStatus,
    #[serde(default)]
    proof: Option<String>,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    expected_result: Option<String>,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    assignee: Option<String>,
    #[serde(default)]
    test_data_files: Vec<Map<String, Value>>,
    #[serde(default)]
    expected_files: Vec<Map<String, Value>>,
    #[serde(default)]
    notes_files: Vec<Map<String, Value>>,
    #[serde(default)]
    criterion_id: Option<String>,
}

/// Request body to update a test case.
#[derive(Debug, Deserialize)]
struct TestCaseUpdateBody {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    status: Option<TestCaseStatus>,
    #[serde(default)]
    proof: Option<String>,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    expected_result: Option<String>,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    assignee: Option<String>,
    #[serde(default)]
    test_data_files: Option<Vec<Map<String, Value>>>,
    /// files beside the Expected result and the Notes, as the Test data has (TestCases design; issue #269)
    #[serde(default)]
    expected_files: Option<Vec<Map<String, Value>>>,
    #[serde(default)]
    notes_files: Option<Vec<Map<String, Value>>>,
    /// "" unlinks
    #[serde(default)]
    criterion_id: Option<String>,
}

/// Add a test case.
async fn post_test_case(
    Path(ticket_id): Path<String>,
    Body(body): Body<TestCaseCreateBody>,
) -> ApiResult<Json<TicketRead>> {
    let session = kb_db::session();
    let test_data_files = objects(body.test_data_files);
    let expected_files = objects(body.expected_files);
    let notes_files = objects(body.notes_files);
    let new = NewTestCase {
        title: &body.title,
        status: body.status.as_str(),
        proof: body.proof.as_deref(),
        note: body.note.as_deref(),
        description: body.description.as_deref(),
        expected_result: body.expected_result.as_deref(),
        notes: body.notes.as_deref(),
        assignee: body.assignee.as_deref(),
        test_data_files: Some(&test_data_files),
        expected_files: Some(&expected_files),
        notes_files: Some(&notes_files),
        criterion_id: body.criterion_id.as_deref(),
        suggested_by: None,
    };
    let ticket = add_test_case(&session, &ticket_id, new).await.map_err(bad_request)?;
    changed(ticket).await
}

/// Update a test case.
async fn patch_test_case(
    Path((ticket_id, tc_id)): Path<(String, String)>,
    Body(body): Body<TestCaseUpdateBody>,
) -> ApiResult<Json<TicketRead>> {
    let session = kb_db::session();
    let test_data_files = body.test_data_files.map(objects);
    let expected_files = body.expected_files.map(objects);
    let notes_files = body.notes_files.map(objects);
    let changes = TestCaseChanges {
        title: body.title.as_deref(),
        status: body.status.map(TestCaseStatus::as_str),
        proof: body.proof.as_deref(),
        note: body.note.as_deref(),
        description: body.description.as_deref(),
        expected_result: body.expected_result.as_deref(),
        notes: body.notes.as_deref(),
        assignee: body.assignee.as_deref(),
        test_data_files: test_data_files.as_deref(),
        expected_files: expected_files.as_deref(),
        notes_files: notes_files.as_deref(),
        criterion_id: body.criterion_id.as_deref(),
    };
    let ticket = update_test_case(&session, &ticket_id, &tc_id, changes).await.map_err(bad_request)?;
    changed(ticket).await
}

/// Delete a test case.
async fn del_test_case(Path((ticket_id, tc_id)): Path<(String, String)>) -> ApiResult<Json<TicketRead>> {
    let session = kb_db::session();
    let ticket = delete_test_case(&session, &ticket_id, &tc_id).await.map_err(uncaught)?;
    changed(ticket).await
}
