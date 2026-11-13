//! `tests/test_wave5_fields.py`, the ideas' part: activity that says which assumption it is about (IP-8, IW-4) and
//! what the caller sorted this week (ICT-9). The lane counts (AL-1) are ported with the board
//! (`crates/kb-board/tests/test_wave5_fields.rs`).

mod common;

use chrono::{Duration, Utc};
use common::{API, add_member, assumption, create_idea, create_project, exec, id, stage, text};
use serde_json::{Value, json};
use testkit::{Server, skip_unless_available};

macro_rules! guard {
    ($name:literal) => {
        if !skip_unless_available($name) {
            return;
        }
    };
}

fn assumption_entries(idea: &Value) -> Vec<Value> {
    idea["activity_trail"].as_array().expect("trail").iter().filter(|e| e["kind"] == "assumption").cloned().collect()
}

/// `_set_trail(idea_id, change)`: rewrite the stored activity trail.
async fn set_trail(s: &Server, idea_id: &str, change: impl FnOnce(Vec<Value>) -> Vec<Value>) {
    let stored = text(s, "SELECT activity_trail FROM idea_ticket WHERE id = ?", &[json!(idea_id)]).await;
    let trail: Vec<Value> =
        serde_json::from_str(stored.as_deref().filter(|t| !t.is_empty()).unwrap_or("[]")).expect("trail");
    let updated = kb_base::pyjson::dumps(&change(trail));
    exec(s, "UPDATE idea_ticket SET activity_trail = ? WHERE id = ?", &[json!(updated), json!(idea_id)]).await;
}

// --- IP-8 / IW-4 -------------------------------------------------------------------------------------------------

#[tokio::test]
async fn test_assumption_entries_name_their_assumption_and_its_change() {
    guard!("test_assumption_entries_name_their_assumption_and_its_change");
    let s = Server::start().await;
    let c = s.client();
    let p = create_project(&c).await;
    let idea = create_idea(&c, &id(&p), json!({})).await;
    let a = assumption(&c, &id(&idea), "They pay for it", "high").await;
    let url = format!("{API}/{}/assumption-records/{}", id(&idea), id(&a));
    let r = c.patch(&url, json!({"status": "testing"})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let r = c.patch(&url, json!({"text": "They pay for it monthly"})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let r = c.delete(&format!("/api/idea-tickets/{}/assumptions/{}", id(&idea), id(&a))).await;
    assert!(r.status == 200 || r.status == 204, "{}", r.text());
    let full = c.get(&format!("{API}/{}", id(&idea))).await.json();

    let entries = assumption_entries(&full);
    let (added, marked) = (&entries[0], &entries[1]);
    assert_eq!(added["label"], "Assumption added");
    assert_eq!(added["meta"], json!({"assumption": id(&a), "assumption_text": "They pay for it"}));
    assert_eq!(marked["label"], "Assumption marked as testing");
    assert_eq!(marked["meta"]["assumption"], a["id"]);
    assert_eq!((&marked["meta"]["from"], &marked["meta"]["to"]), (&json!("untested"), &json!("testing")));
    let edited = entries.iter().find(|e| e["label"] == "Assumption edited").expect("edited");
    assert_eq!(edited["meta"]["assumption_text"], "They pay for it monthly");
    let deleted = entries.iter().find(|e| e["label"] == "Assumption deleted").expect("deleted");
    assert_eq!(deleted["meta"]["assumption"], a["id"]);
}

#[tokio::test]
async fn test_old_assumption_entries_stay_as_they_were() {
    guard!("test_old_assumption_entries_stay_as_they_were");
    let s = Server::start().await;
    let c = s.client();
    let p = create_project(&c).await;
    let idea = create_idea(&c, &id(&p), json!({})).await;
    let old = json!({
        "id": "e1",
        "label": "Assumption marked as validated",
        "at": "2026-01-01T00:00:00+00:00",
        "kind": "assumption",
    });
    set_trail(&s, &id(&idea), |_| vec![old.clone()]).await;
    let items = c.get(&format!("{API}/{}/activity", id(&idea))).await.json()["items"].clone();
    assert_eq!(items, json!([old]));
}

// --- ICT-9 -------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn test_sorted_this_week_counts_each_decision_of_the_caller() {
    guard!("test_sorted_this_week_counts_each_decision_of_the_caller");
    let s = Server::start().await;
    let c = s.client();
    let p = create_project(&c).await;
    let pid = id(&p);
    add_member(&c, &pid, "Mia", "member").await;
    let mia = c.clone().header("X-Actor", "Mia");
    let mut ideas = Vec::new();
    for n in 0..6 {
        ideas.push(create_idea(&c, &pid, json!({"title": format!("Idea {n}")})).await);
    }
    let target = create_idea(&c, &pid, json!({"title": "Target"})).await;
    stage(&c, &id(&target), "exploring", json!({})).await;

    let staged = |idea: &Value, body: Value| {
        let mia = mia.clone();
        let url = format!("{API}/{}/stage", id(idea));
        async move {
            let r = mia.post(&url, body).await;
            assert_eq!(r.status, 200, "{}", r.text());
        }
    };
    staged(&ideas[0], json!({"to": "exploring"})).await;
    staged(&ideas[1], json!({"to": "exploring"})).await;
    let park_until = (Utc::now() + Duration::days(30)).date_naive().format("%Y-%m-%d").to_string();
    staged(&ideas[2], json!({"to": "parked", "park_until": park_until})).await;
    staged(&ideas[3], json!({"to": "archived", "archive_reason": "already_exists"})).await;
    let r = mia.post(&format!("{API}/{}/merge", id(&ideas[4])), json!({"into_id": id(&target)})).await;
    assert_eq!(r.status, 200, "{}", r.text());
    // undone: not counted
    staged(&ideas[5], json!({"to": "exploring"})).await;
    assert_eq!(mia.post_empty(&format!("{API}/{}/undo", id(&ideas[5]))).await.status, 200);
    let week = format!("{API}/sorted-this-week");
    let mine = mia.get_query(&week, &[("project_id", &pid)]).await.json();
    let board_user = c.get_query(&week, &[("project_id", &pid)]).await.json();
    let everywhere = mia.get_query(&week, &[("scope", "all")]).await.json();

    assert_eq!(mine, json!({"total": 5, "kept": 2, "parked": 1, "merged": 1, "archived": 1, "days": 7}));
    // the board's own user moved only the target out of the Inbox: one kept
    assert!(board_user["total"] == 1 && board_user["kept"] == 1);
    assert_eq!(everywhere["total"], 5);
}

#[tokio::test]
async fn test_a_sort_older_than_a_week_is_not_counted() {
    guard!("test_a_sort_older_than_a_week_is_not_counted");
    let s = Server::start().await;
    let c = s.client();
    let p = create_project(&c).await;
    let idea = create_idea(&c, &id(&p), json!({})).await;
    stage(&c, &id(&idea), "exploring", json!({})).await;
    let old = kb_base::time::iso(&(Utc::now() - Duration::days(8)));
    set_trail(&s, &id(&idea), |trail| {
        trail
            .into_iter()
            .map(|mut e| {
                e["at"] = json!(old);
                e
            })
            .collect()
    })
    .await;
    let out = c.get_query(&format!("{API}/sorted-this-week"), &[("project_id", &id(&p))]).await.json();
    assert_eq!(out["total"], 0);
    assert_eq!(kb_ideas::idea_space::SORTED_DAYS, 7);
}
