//! `tests/test_idea_tickets.py`: the basic idea routes (create, get, list, update, delete, the legacy status,
//! assumptions and microthoughts, the activity entries).

mod common;

use common::{API, create_idea, create_project, id, trail_text};
use serde_json::{Value, json};
use testkit::{Server, skip_unless_available};

macro_rules! guard {
    ($name:literal) => {
        if !skip_unless_available($name) {
            return;
        }
    };
}

#[tokio::test]
async fn test_create_idea_ticket_required_fields_only() {
    guard!("test_create_idea_ticket_required_fields_only");
    let s = Server::start().await;
    let c = s.client();
    let project = create_project(&c).await;
    let created = create_idea(&c, &id(&project), json!({})).await;

    assert!(created["id"].as_str().expect("id").starts_with("IDEA-"));
    assert_eq!(created["project_id"], project["id"]);
    assert_eq!(created["title"], "[TEST] Idea ticket");
    assert_eq!(created["idea_status"], "draft");
    assert_eq!(created["idea_color"], "yellow");
    assert_eq!(created["idea_emoji"], "💡");
    assert_eq!(created["ice_impact"], 3);
    assert_eq!(created["ice_effort"], 3);
    assert_eq!(created["ice_confidence"], 3);
    assert_eq!(created["microthoughts"], json!([]));
    assert_eq!(created["assumptions"], json!([]));
}

#[tokio::test]
async fn test_create_idea_ticket_all_fields() {
    guard!("test_create_idea_ticket_all_fields");
    let s = Server::start().await;
    let c = s.client();
    let project = create_project(&c).await;
    let created = create_idea(
        &c,
        &id(&project),
        json!({
            "title": "[TEST] Complete idea",
            "description": "Detailed idea",
            "idea_color": "blue",
            "idea_emoji": "🚀",
            "idea_energy": "hot",
            "tags": ["growth", "beta"],
            "problem_statement": "Users cannot find their next best idea.",
        }),
    )
    .await;

    assert_eq!(created["title"], "[TEST] Complete idea");
    assert_eq!(created["description"], "Detailed idea");
    assert_eq!(created["idea_color"], "blue");
    assert_eq!(created["idea_emoji"], "🚀");
    assert_eq!(created["idea_energy"], "hot");
    assert_eq!(created["tags"], json!(["growth", "beta"]));
    assert_eq!(created["problem_statement"], "Users cannot find their next best idea.");
}

#[tokio::test]
async fn test_get_idea_ticket_by_id() {
    guard!("test_get_idea_ticket_by_id");
    let s = Server::start().await;
    let c = s.client();
    let project = create_project(&c).await;
    let created = create_idea(&c, &id(&project), json!({"title": "[TEST] Fetch me"})).await;
    let response = c.get(&format!("{API}/{}", id(&created))).await;

    assert_eq!(response.status, 200);
    assert_eq!(response.json()["id"], created["id"]);
    assert_eq!(response.json()["title"], "[TEST] Fetch me");
}

#[tokio::test]
async fn test_list_idea_tickets_by_project_id() {
    guard!("test_list_idea_tickets_by_project_id");
    let s = Server::start().await;
    let c = s.client();
    let project_a = create_project(&c).await;
    let project_b = create_project(&c).await;
    let idea_a = create_idea(&c, &id(&project_a), json!({"title": "[TEST] Alpha"})).await;
    create_idea(&c, &id(&project_b), json!({"title": "[TEST] Beta"})).await;
    let response = c.get_query(API, &[("project_id", &id(&project_a))]).await;

    assert_eq!(response.status, 200);
    let results = response.json();
    let ids: Vec<&Value> = results.as_array().expect("list").iter().map(|t| &t["id"]).collect();
    assert_eq!(ids, [&idea_a["id"]]);
}

#[tokio::test]
async fn test_update_idea_ticket_fields() {
    guard!("test_update_idea_ticket_fields");
    let s = Server::start().await;
    let c = s.client();
    let project = create_project(&c).await;
    let created = create_idea(&c, &id(&project), json!({})).await;
    let response = c
        .patch(
            &format!("{API}/{}", id(&created)),
            json!({
                "title": "[TEST] Updated idea",
                "description": "Updated description",
                "idea_energy": "concept",
                "tags": ["updated"],
                "ice_impact": 5,
                "ice_effort": 2,
                "ice_confidence": 4,
                "revisit_date": "2026-05-01",
            }),
        )
        .await;

    assert_eq!(response.status, 200);
    let updated = response.json();
    assert_eq!(updated["title"], "[TEST] Updated idea");
    assert_eq!(updated["description"], "Updated description");
    assert_eq!(updated["idea_energy"], "concept");
    assert_eq!(updated["tags"], json!(["updated"]));
    assert_eq!(updated["ice_impact"], 5);
    assert_eq!(updated["ice_effort"], 2);
    assert_eq!(updated["ice_confidence"], 4);
    assert_eq!(updated["revisit_date"], "2026-05-01");
}

#[tokio::test]
async fn test_delete_idea_ticket() {
    guard!("test_delete_idea_ticket");
    let s = Server::start().await;
    let c = s.client();
    let project = create_project(&c).await;
    let created = create_idea(&c, &id(&project), json!({})).await;
    let delete_response = c.delete(&format!("{API}/{}", id(&created))).await;
    let get_response = c.get(&format!("{API}/{}", id(&created))).await;

    assert_eq!(delete_response.status, 204);
    assert_eq!(get_response.status, 404);
}

async fn patch_status(c: &testkit::Client, idea_id: &str, new_status: &str) -> testkit::Resp {
    c.patch(&format!("{API}/{idea_id}/status"), json!({"new_status": new_status})).await
}

#[tokio::test]
async fn test_valid_status_transition_draft_to_in_review() {
    guard!("test_valid_status_transition_draft_to_in_review");
    let s = Server::start().await;
    let c = s.client();
    let project = create_project(&c).await;
    let created = create_idea(&c, &id(&project), json!({})).await;
    let response = patch_status(&c, &id(&created), "in_review").await;

    assert_eq!(response.status, 200);
    assert_eq!(response.json()["idea_status"], "in_review");
}

#[tokio::test]
async fn test_valid_status_transition_in_review_to_approved() {
    guard!("test_valid_status_transition_in_review_to_approved");
    let s = Server::start().await;
    let c = s.client();
    let project = create_project(&c).await;
    let created = create_idea(&c, &id(&project), json!({})).await;
    let first = patch_status(&c, &id(&created), "in_review").await;
    assert_eq!(first.status, 200);
    let response = patch_status(&c, &id(&created), "approved").await;

    assert_eq!(response.status, 200);
    assert_eq!(response.json()["idea_status"], "approved");
}

#[tokio::test]
async fn test_invalid_status_transition_approved_to_draft_fails() {
    guard!("test_invalid_status_transition_approved_to_draft_fails");
    let s = Server::start().await;
    let c = s.client();
    let project = create_project(&c).await;
    let created = create_idea(&c, &id(&project), json!({})).await;
    patch_status(&c, &id(&created), "in_review").await;
    patch_status(&c, &id(&created), "approved").await;
    let response = patch_status(&c, &id(&created), "draft").await;

    assert_eq!(response.status, 400);
    assert!(response.json()["detail"].as_str().expect("detail").to_lowercase().contains("cannot transition"));
}

#[tokio::test]
async fn test_invalid_status_transition_draft_to_approved_fails() {
    guard!("test_invalid_status_transition_draft_to_approved_fails");
    let s = Server::start().await;
    let c = s.client();
    let project = create_project(&c).await;
    let created = create_idea(&c, &id(&project), json!({})).await;
    let response = patch_status(&c, &id(&created), "approved").await;

    assert_eq!(response.status, 400);
    assert!(response.json()["detail"].as_str().expect("detail").to_lowercase().contains("cannot transition"));
}

#[tokio::test]
async fn test_add_microthought_returns_id_text_at() {
    guard!("test_add_microthought_returns_id_text_at");
    let s = Server::start().await;
    let c = s.client();
    let project = create_project(&c).await;
    let created = create_idea(&c, &id(&project), json!({})).await;
    let response =
        c.post(&format!("{API}/{}/microthoughts", id(&created)), json!({"text": "[TEST] Quick thought"})).await;

    assert_eq!(response.status, 200);
    let microthought = response.json()["microthoughts"][0].clone();
    assert!(!microthought["id"].as_str().expect("id").is_empty());
    assert_eq!(microthought["text"], "[TEST] Quick thought");
    assert!(!microthought["at"].as_str().expect("at").is_empty());
}

#[tokio::test]
async fn test_delete_microthought() {
    guard!("test_delete_microthought");
    let s = Server::start().await;
    let c = s.client();
    let project = create_project(&c).await;
    let created = create_idea(&c, &id(&project), json!({})).await;
    let added = c.post(&format!("{API}/{}/microthoughts", id(&created)), json!({"text": "[TEST] Remove me"})).await;
    let microthought_id = added.json()["microthoughts"][0]["id"].as_str().expect("id").to_string();
    let response = c.delete(&format!("{API}/{}/microthoughts/{microthought_id}", id(&created))).await;

    assert_eq!(response.status, 200);
    assert_eq!(response.json()["microthoughts"], json!([]));
}

#[tokio::test]
async fn test_add_update_delete_assumption() {
    guard!("test_add_update_delete_assumption");
    let s = Server::start().await;
    let c = s.client();
    let project = create_project(&c).await;
    let created = create_idea(&c, &id(&project), json!({})).await;
    let added =
        c.post(&format!("{API}/{}/assumptions", id(&created)), json!({"text": "[TEST] Users want reminders"})).await;
    assert_eq!(added.status, 200);
    let assumption = added.json()["assumptions"][0].clone();
    assert_eq!(assumption["status"], "untested");

    let updated = c
        .patch(&format!("{API}/{}/assumptions/{}", id(&created), id(&assumption)), json!({"status": "validated"}))
        .await;
    assert_eq!(updated.status, 200);
    let updated_assumption = updated.json()["assumptions"][0].clone();
    assert_eq!(updated_assumption["status"], "validated");

    let deleted = c.delete(&format!("{API}/{}/assumptions/{}", id(&created), id(&assumption))).await;

    assert_eq!(deleted.status, 200);
    assert_eq!(deleted.json()["assumptions"], json!([]));
}

#[tokio::test]
async fn test_invalid_assumption_status_rejected() {
    guard!("test_invalid_assumption_status_rejected");
    let s = Server::start().await;
    let c = s.client();
    let project = create_project(&c).await;
    let created = create_idea(&c, &id(&project), json!({})).await;
    let added =
        c.post(&format!("{API}/{}/assumptions", id(&created)), json!({"text": "[TEST] Risky assumption"})).await;
    let assumption_id = added.json()["assumptions"][0]["id"].as_str().expect("id").to_string();
    let response =
        c.patch(&format!("{API}/{}/assumptions/{assumption_id}", id(&created)), json!({"status": "maybe"})).await;

    assert_eq!(response.status, 422);
}

#[tokio::test]
async fn test_create_idea_ticket_adds_activity_entry() {
    guard!("test_create_idea_ticket_adds_activity_entry");
    let s = Server::start().await;
    let c = s.client();
    let project = create_project(&c).await;
    let created = create_idea(&c, &id(&project), json!({})).await;

    let trail = created["activity_trail"].as_array().expect("trail");
    assert!(!trail.is_empty());
    assert!(trail_text(trail.last().expect("entry")).contains("idea created"));
}

#[tokio::test]
async fn test_status_change_adds_activity_entry() {
    guard!("test_status_change_adds_activity_entry");
    let s = Server::start().await;
    let c = s.client();
    let project = create_project(&c).await;
    let created = create_idea(&c, &id(&project), json!({})).await;
    let response = patch_status(&c, &id(&created), "in_review").await;

    assert_eq!(response.status, 200);
    let trail = response.json()["activity_trail"].clone();
    assert!(trail.as_array().expect("trail").iter().any(|entry| {
        let text = trail_text(entry);
        text.contains("status changed") && text.contains("draft")
    }));
}

#[tokio::test]
async fn test_get_idea_activity_trail_returns_entries_in_reverse_order() {
    // The Python test reads the trail through the MCP operation `get_idea_activity_trail`, which lists the stored
    // trail newest first: that part waits for the MCP port. The HTTP part is run here, and the trail is read newest
    // first from the idea (the same list `GET /{id}/activity` gives).
    guard!("test_get_idea_activity_trail_returns_entries_in_reverse_order");
    let s = Server::start().await;
    let c = s.client();
    let project = create_project(&c).await;
    let created = create_idea(&c, &id(&project), json!({})).await;
    let status_response = patch_status(&c, &id(&created), "in_review").await;
    assert_eq!(status_response.status, 200);
    let microthought_response =
        c.post(&format!("{API}/{}/microthoughts", id(&created)), json!({"text": "[TEST] Latest event"})).await;
    assert_eq!(microthought_response.status, 200);

    let trail = c.get(&format!("{API}/{}/activity", id(&created))).await.json()["items"].clone();
    let trail = trail.as_array().expect("list");
    assert!(trail.len() >= 3);
    assert!(trail_text(&trail[0]).contains("microthought"));
    assert!(trail_text(trail.last().expect("entry")).contains("idea created"));
}
