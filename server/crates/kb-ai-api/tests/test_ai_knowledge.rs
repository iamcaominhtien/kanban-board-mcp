//! `tests/test_ai_knowledge.py`: the routes of `api/ai_knowledge.py` for the instructions and the lessons. The tests
//! of the prompt block, the digest and the light model are unit tests of `kb-ai-know`. A lesson an AI proposed
//! (`knowledge.add_lesson(..., state="proposed")`) is a row added to the server's database.

mod common;

use common::{NOW, id, insert, project, start};
use serde_json::json;

#[tokio::test]
async fn test_lessons_are_kept_edited_dropped_and_never_duplicated() {
    let Some(f) = start("test_lessons_are_kept_edited_dropped_and_never_duplicated", true, &[]).await else { return };
    let c = &f.c;
    let (pid, _) = project(c).await;
    let proposal = "proposal-1";
    insert(
        &f.server,
        "ai_lesson",
        &json!({"id": proposal, "project_id": pid, "text": "Use uv run alembic revision --autogenerate.",
                "state": "proposed", "proposed_by": "model", "uses": 0, "created_at": NOW, "updated_at": NOW}),
    )
    .await;
    let edited = c
        .patch(
            &format!("/ai/lessons/{proposal}"),
            json!({"text": "Migrations: uv run alembic revision --autogenerate.", "state": "kept"}),
        )
        .await
        .json();
    assert_eq!(edited["state"], "kept");
    assert!(edited["text"].as_str().expect("text").starts_with("Migrations:"));
    let dup = c
        .post(
            &format!("/projects/{pid}/ai/lessons"),
            json!({"text": "Migrations: uv run alembic revision --autogenerate."}),
        )
        .await;
    assert_eq!(dup.status, 409);
    assert_eq!(c.delete(&format!("/ai/lessons/{proposal}")).await.status, 204);
    let page = c.get(&format!("/projects/{pid}/ai/knowledge")).await.json();
    assert_eq!(page["lessons"], json!([]));
    let empty = c.post(&format!("/projects/{pid}/ai/lessons"), json!({"text": "   "})).await;
    assert_eq!(empty.status, 422);
    // a lesson a person writes is kept at once
    let made = c.post(&format!("/projects/{pid}/ai/lessons"), json!({"text": "Run the tests first."})).await;
    assert_eq!(made.status, 201);
    assert_eq!(made.json()["state"], "kept");
    id(&made.json());
}

#[tokio::test]
async fn test_instructions_keep_their_history() {
    let Some(f) = start("test_instructions_keep_their_history", true, &[]).await else { return };
    let c = &f.c;
    let (pid, _) = project(c).await;
    c.put(&format!("/projects/{pid}/ai/knowledge/instructions"), json!({"instructions": "v1"})).await;
    let page = c.put(&format!("/projects/{pid}/ai/knowledge/instructions"), json!({"instructions": "v2"})).await.json();
    assert_eq!(page["instructions"], "v2");
    let history: Vec<&serde_json::Value> =
        page["history"].as_array().expect("history").iter().map(|h| &h["text"]).collect();
    assert_eq!(history, vec!["v1"]);
}
