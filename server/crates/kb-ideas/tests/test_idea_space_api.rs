//! `tests/test_idea_space_api.py`: REST API of the Idea Space: stages, triage, merge, votes, assumptions, evidence,
//! log, activity, promote.

mod common;

use chrono::{Duration, Utc};
use common::{
    API, add_member, assumption, create_idea, create_project, exec, hook_is_registered, id, ready_idea,
    skipped_without_the_hook, stage, text,
};
use serde_json::{Value, json};
use testkit::{Server, skip_unless_available};

macro_rules! guard {
    ($name:literal) => {
        if !skip_unless_available($name) {
            return;
        }
    };
}

fn tomorrow() -> String {
    (Utc::now().date_naive() + Duration::days(1)).format("%Y-%m-%d").to_string()
}

fn ids(rows: &Value) -> Vec<String> {
    rows.as_array().expect("list").iter().map(id).collect()
}

fn code(response: &testkit::Resp) -> Value {
    response.json()["detail"]["code"].clone()
}

// ── listing and counts ─────────────────────────────────────────────────────

#[tokio::test]
async fn test_list_by_project_all_and_none_with_filters_and_counts() {
    guard!("test_list_by_project_all_and_none_with_filters_and_counts");
    let s = Server::start().await;
    let c = s.client();
    let p1 = create_project(&c).await;
    let p2 = create_project(&c).await;
    let a = create_idea(&c, &id(&p1), json!({"title": "Alpha cost badge", "tags": ["ai"]})).await;
    let b = create_idea(&c, &id(&p2), json!({"title": "Beta sync"})).await;
    let loose = c.post(API, json!({"title": "Loose note"})).await.json(); // no project
    stage(&c, &id(&a), "exploring", json!({})).await;

    let space = format!("{API}/space");
    let one = c.get_query(&space, &[("project_id", &id(&p1))]).await.json();
    let everything = c.get_query(&space, &[("scope", "all")]).await.json();
    let none = c.get_query(&space, &[("scope", "none")]).await.json();
    let exploring = c.get_query(&space, &[("scope", "all"), ("stage", "exploring")]).await.json();
    let tagged = c.get_query(&space, &[("scope", "all"), ("tag", "ai")]).await.json();
    let found = c.get_query(&space, &[("scope", "all"), ("q", "sync")]).await.json();
    let counts = c.get(&format!("{API}/counts")).await.json();
    let bad = c.get_query(&space, &[("scope", "project")]).await;

    assert_eq!(ids(&one), [id(&a)]);
    let mut all_ids = ids(&everything);
    all_ids.sort();
    let mut expected = vec![id(&a), id(&b), id(&loose)];
    expected.sort();
    assert_eq!(all_ids, expected);
    assert_eq!(ids(&none), [id(&loose)]);
    assert_eq!(ids(&exploring), [id(&a)]);
    assert_eq!(ids(&tagged), [id(&a)]);
    assert_eq!(ids(&found), [id(&b)]);
    assert!(counts["total_inbox"] == 2 && counts["all"]["active"] == 1);
    assert_eq!(counts["none"]["stages"]["inbox"], 1);
    let by_project = |pid: &str| {
        counts["projects"]
            .as_array()
            .expect("projects")
            .iter()
            .find(|x| x["project_id"] == pid)
            .expect("project")
            .clone()
    };
    assert_eq!(by_project(&id(&p1))["stages"]["exploring"], 1);
    assert_eq!(bad.status, 400);
}

#[tokio::test]
async fn test_the_list_puts_the_ideas_closest_to_ready_first() {
    guard!("test_the_list_puts_the_ideas_closest_to_ready_first");
    let s = Server::start().await;
    let c = s.client();
    let p = create_project(&c).await;
    let bare = create_idea(&c, &id(&p), json!({"title": "No assumptions"})).await;
    let (ready, _) = ready_idea(&c, &id(&p), "Validated").await;
    let half = create_idea(&c, &id(&p), json!({"title": "Half"})).await;
    assumption(&c, &id(&half), "one", "low").await;
    let rows = c.get_query(&format!("{API}/space"), &[("project_id", &id(&p))]).await.json();

    assert_eq!(ids(&rows), [id(&ready), id(&half), id(&bare)]);
    let states: Vec<&Value> = rows.as_array().expect("rows").iter().map(|r| &r["readiness"]["state"]).collect();
    assert_eq!(states, ["ready", "growing", "not_started"]);
}

// ── stages ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_keep_park_archive_restore_and_the_rules_around_them() {
    guard!("test_keep_park_archive_restore_and_the_rules_around_them");
    let s = Server::start().await;
    let c = s.client();
    let p = create_project(&c).await;
    let idea = create_idea(&c, &id(&p), json!({})).await;
    let i = id(&idea);
    assert_eq!(idea["stage"], "inbox");
    let tomorrow = tomorrow();

    let kept = stage(&c, &i, "exploring", json!({"via": "Keep", "tags": ["x"]})).await.json();
    let no_date = stage(&c, &i, "parked", json!({})).await;
    let past = stage(&c, &i, "parked", json!({"park_until": "2020-01-01"})).await;
    let parked = stage(&c, &i, "parked", json!({"park_until": tomorrow, "park_note": "later"})).await.json();
    let no_reason = stage(&c, &i, "archived", json!({})).await;
    let archived =
        stage(&c, &i, "archived", json!({"archive_reason": "not_now", "archive_note": "not yet"})).await.json();
    let restored = stage(&c, &i, "exploring", json!({})).await.json();
    let to_building = stage(&c, &i, "building", json!({})).await;
    let bad_reason = c.post(&format!("{API}/{i}/stage"), json!({"to": "archived", "archive_reason": "bored"})).await;

    assert!(kept["stage"] == "exploring" && kept["tags"] == json!(["x"]));
    assert!(no_date.status == 409 && code(&no_date) == "park_needs_date");
    assert_eq!(code(&past), "park_date_past");
    assert_eq!(
        (&parked["stage"], &parked["park_until"], &parked["park_note"]),
        (&json!("parked"), &json!(tomorrow), &json!("later"))
    );
    assert_eq!(code(&no_reason), "archive_needs_reason");
    assert_eq!(
        (&archived["stage"], &archived["archive_reason"], &archived["archive_note"]),
        (&json!("archived"), &json!("not_now"), &json!("not yet"))
    );
    assert!(restored["stage"] == "exploring" && restored["archive_reason"].is_null());
    assert_eq!(code(&to_building), "use_promote");
    assert_eq!(bad_reason.status, 422);
}

#[tokio::test]
async fn test_ready_needs_the_checks_or_force_and_undo_takes_a_move_back() {
    guard!("test_ready_needs_the_checks_or_force_and_undo_takes_a_move_back");
    let s = Server::start().await;
    let c = s.client();
    let p = create_project(&c).await;
    let idea = create_idea(&c, &id(&p), json!({})).await;
    let i = id(&idea);
    assumption(&c, &i, "They pay", "high").await;
    stage(&c, &i, "exploring", json!({})).await;
    let refused = stage(&c, &i, "ready", json!({})).await;
    let forced = stage(&c, &i, "ready", json!({"force": true})).await.json();
    let undone = c.post_empty(&format!("{API}/{i}/undo")).await.json();
    let again = c.post_empty(&format!("{API}/{i}/undo")).await;

    assert_eq!(refused.status, 409);
    assert_eq!(code(&refused), "not_ready");
    assert_eq!(refused.json()["detail"]["readiness"]["high_open"], 1);
    assert_eq!(forced["stage"], "ready");
    assert_eq!(undone["stage"], "exploring");
    assert_eq!(code(&again), "nothing_to_undo");
}

#[tokio::test]
async fn test_park_many_parks_each_with_the_same_date() {
    guard!("test_park_many_parks_each_with_the_same_date");
    let s = Server::start().await;
    let c = s.client();
    let p = create_project(&c).await;
    let mut idea_ids = Vec::new();
    for n in 0..3 {
        idea_ids.push(id(&create_idea(&c, &id(&p), json!({"title": format!("I{n}")})).await));
    }
    let tomorrow = tomorrow();
    let rows = c.post(&format!("{API}/park-many"), json!({"ids": idea_ids, "park_until": tomorrow})).await.json();

    let stages: Vec<&Value> = rows.as_array().expect("rows").iter().map(|r| &r["stage"]).collect();
    assert_eq!(stages, ["parked"; 3]);
    let dates: std::collections::BTreeSet<String> =
        rows.as_array().expect("rows").iter().map(|r| r["park_until"].as_str().expect("date").to_string()).collect();
    assert_eq!(dates, [tomorrow].into_iter().collect());
}

#[tokio::test]
async fn test_a_viewer_can_vote_and_comment_but_not_move_ideas() {
    guard!("test_a_viewer_can_vote_and_comment_but_not_move_ideas");
    let s = Server::start().await;
    let c = s.client();
    let p = create_project(&c).await;
    add_member(&c, &id(&p), "Vera", "viewer").await;
    add_member(&c, &id(&p), "Mia", "member").await;
    let idea = create_idea(&c, &id(&p), json!({})).await;
    let i = id(&idea);
    let viewer = c.clone().header("X-Actor", "Vera");
    let moved = viewer.post(&format!("{API}/{i}/stage"), json!({"to": "exploring"})).await;
    let voted = viewer.post(&format!("{API}/{i}/vote"), json!({})).await;
    let commented = viewer.post(&format!("{API}/{i}/comments"), json!({"body": "+1"})).await;
    let moved_by_member =
        c.clone().header("X-Actor", "Mia").post(&format!("{API}/{i}/stage"), json!({"to": "exploring"})).await;

    assert!(moved.status == 403 && code(&moved) == "read_only");
    assert!(voted.status == 200 && voted.json()["voters"] == json!(["Vera"]));
    assert!(commented.status == 201 && commented.json()["author"] == "Vera");
    assert_eq!(moved_by_member.status, 200);
}

// ── merge, votes ───────────────────────────────────────────────────────────

#[tokio::test]
async fn test_merge_adds_text_and_votes_and_can_be_undone() {
    guard!("test_merge_adds_text_and_votes_and_can_be_undone");
    let s = Server::start().await;
    let c = s.client();
    let p = create_project(&c).await;
    let target = create_idea(&c, &id(&p), json!({"title": "Cost on card", "description": "T"})).await;
    let source = create_idea(&c, &id(&p), json!({"title": "Cost in members", "description": "S text"})).await;
    c.post(&format!("{API}/{}/vote", id(&source)), json!({"voter": "Lan"})).await;
    c.post(&format!("{API}/{}/vote", id(&target)), json!({"voter": "Tuan"})).await;

    let merged = c.post(&format!("{API}/{}/merge", id(&source)), json!({"into_id": id(&target)})).await.json();
    let source_after = c.get(&format!("{API}/{}", id(&source))).await.json();
    let self_merge = c.post(&format!("{API}/{}/merge", id(&target)), json!({"into_id": id(&target)})).await;
    let undone = c.post_empty(&format!("{API}/{}/undo-merge", id(&target))).await.json();
    let source_back = c.get(&format!("{API}/{}", id(&source))).await.json();
    let nothing = c.post_empty(&format!("{API}/{}/undo-merge", id(&target))).await;

    let body = merged["body"].as_str().expect("body");
    assert!(body.contains(&format!("Merged from {}", id(&source))) && body.contains("S text"));
    let voters = |idea: &Value| -> std::collections::BTreeSet<String> {
        idea["voters"].as_array().expect("voters").iter().map(|v| v.as_str().expect("voter").to_string()).collect()
    };
    assert_eq!(voters(&merged), ["Tuan", "Lan", "user"].iter().map(|s| s.to_string()).collect());
    assert_eq!(source_after["stage"], "archived");
    assert_eq!(source_after["merged_into_id"], target["id"]);
    assert_eq!(source_after["archive_note"], format!("Merged into {}", id(&target)));
    assert_eq!(code(&self_merge), "merge_self");
    assert!(!undone["body"].as_str().expect("body").contains("S text"));
    assert_eq!(voters(&undone), ["Tuan"].iter().map(|s| s.to_string()).collect());
    assert!(source_back["stage"] == "inbox" && source_back["merged_into_id"].is_null());
    assert_eq!(code(&nothing), "nothing_to_undo");
}

#[tokio::test]
async fn test_a_merge_cannot_be_undone_after_ten_minutes() {
    guard!("test_a_merge_cannot_be_undone_after_ten_minutes");
    let s = Server::start().await;
    let c = s.client();
    let p = create_project(&c).await;
    let target = create_idea(&c, &id(&p), json!({"title": "A"})).await;
    let source = create_idea(&c, &id(&p), json!({"title": "B"})).await;
    c.post(&format!("{API}/{}/merge", id(&source)), json!({"into_id": id(&target)})).await;
    let old = kb_base::time::iso(&(Utc::now() - Duration::minutes(11)));
    let row = text(&s, "SELECT merge_undo FROM idea_ticket WHERE id = ?", &[json!(id(&target))]).await.expect("undo");
    let mut undo: Value = serde_json::from_str(&row).expect("json");
    undo["at"] = json!(old);
    exec(
        &s,
        "UPDATE idea_ticket SET merge_undo = ? WHERE id = ?",
        &[json!(kb_base::pyjson::dumps(&undo)), json!(id(&target))],
    )
    .await;
    let late = c.post_empty(&format!("{API}/{}/undo-merge", id(&target))).await;

    assert!(late.status == 409 && code(&late) == "undo_expired");
}

#[tokio::test]
async fn test_one_vote_per_person_and_it_can_be_taken_back() {
    guard!("test_one_vote_per_person_and_it_can_be_taken_back");
    let s = Server::start().await;
    let c = s.client();
    let p = create_project(&c).await;
    let i = id(&create_idea(&c, &id(&p), json!({})).await);
    c.post(&format!("{API}/{i}/vote"), json!({"voter": "Lan"})).await;
    let twice = c.post(&format!("{API}/{i}/vote"), json!({"voter": "Lan"})).await.json();
    let back = c.post(&format!("{API}/{i}/vote"), json!({"voter": "Lan", "on": false})).await.json();

    assert!(twice["votes"] == 1 && back["votes"] == 0);
}

// ── assumptions, tests, evidence ───────────────────────────────────────────

#[tokio::test]
async fn test_a_test_ticket_is_linked_both_ways_and_asks_when_it_is_closed() {
    guard!("test_a_test_ticket_is_linked_both_ways_and_asks_when_it_is_closed");
    let s = Server::start().await;
    let c = s.client();
    let p = create_project(&c).await;
    let idea = create_idea(&c, &id(&p), json!({})).await;
    let a = assumption(&c, &id(&idea), "They pay", "high").await;
    let url = format!("{API}/{}/assumption-records/{}", id(&idea), id(&a));
    let made = c.post(&format!("{url}/test-ticket"), json!({"title": "Ask 3 members"})).await;
    let again = c.post(&format!("{url}/test-ticket"), json!({})).await;
    let ticket = made.json()["ticket"].clone();
    let by_ticket = c.get(&format!("{API}/by-ticket/{}", id(&ticket))).await.json();
    c.patch(&format!("/tickets/{}", id(&ticket)), json!({"status": "done"})).await;
    let after = c.get(&format!("{API}/{}", id(&idea))).await.json();
    let resolved = c.post(&format!("{url}/resolve"), json!({"outcome": "disproved"})).await.json();
    let loose = c.post(API, json!({"title": "No project"})).await.json();
    let la = assumption(&c, &id(&loose), "x", "high").await;
    let needs = c.post(&format!("{API}/{}/assumption-records/{}/test-ticket", id(&loose), id(&la)), json!({})).await;

    assert_eq!(made.status, 201);
    assert_eq!(made.json()["idea"]["assumptions"][0]["state"], "testing");
    assert_eq!(made.json()["idea"]["assumptions"][0]["test_ticket_id"], ticket["id"]);
    assert_eq!(ticket["tests_assumption_id"], a["id"]);
    assert_eq!(code(&again), "already_has_test");
    assert_eq!(by_ticket["tests"]["assumption_id"], a["id"]);
    let asks = after["activity_trail"].as_array().expect("trail").iter().any(|e| e["meta"]["asks"] == true);
    if !asks && testkit::target() == testkit::Target::Rust && !hook_is_registered(&c).await {
        skipped_without_the_hook("test_a_test_ticket_is_linked_both_ways_and_asks_when_it_is_closed");
    } else {
        assert!(asks, "closing the test ticket asks what it showed");
    }
    assert_eq!(resolved["assumptions"][0]["state"], "disproved");
    assert_eq!(resolved["readiness"]["state"], "at_risk");
    assert_eq!(code(&needs), "needs_project");
}

#[tokio::test]
async fn test_evidence_can_support_several_assumptions_and_be_removed() {
    guard!("test_evidence_can_support_several_assumptions_and_be_removed");
    let s = Server::start().await;
    let c = s.client();
    let p = create_project(&c).await;
    let i = id(&create_idea(&c, &id(&p), json!({})).await);
    let a1 = assumption(&c, &i, "one", "high").await;
    let a2 = assumption(&c, &i, "two", "low").await;
    let added = c
        .post(
            &format!("{API}/{i}/evidence"),
            json!({
                "assumption_ids": [id(&a1), id(&a2)],
                "kind": "link",
                "ref": "https://example.com/x",
                "title": "Pricing page",
            }),
        )
        .await;
    let listed = c.get(&format!("{API}/{i}/evidence")).await.json();
    let first = listed[0]["ids"][0].as_str().expect("evidence id").to_string();
    let removed = c.delete(&format!("{API}/{i}/evidence/{first}")).await;
    let unknown =
        c.post(&format!("{API}/{i}/evidence"), json!({"assumption_ids": ["nope"], "kind": "link", "ref": "x"})).await;

    assert!(added.status == 201 && added.json()["evidence_count"] == 2);
    assert!(
        listed.as_array().expect("list").len() == 1 && listed[0]["assumptions"].as_array().expect("list").len() == 2
    );
    assert_eq!(removed.json()["evidence_count"], 1);
    assert_eq!(unknown.status, 404);
}

// ── comments, log, activity ────────────────────────────────────────────────

#[tokio::test]
async fn test_comments_and_the_research_log() {
    guard!("test_comments_and_the_research_log");
    let s = Server::start().await;
    let c = s.client();
    let p = create_project(&c).await;
    let i = id(&create_idea(&c, &id(&p), json!({})).await);
    let a = assumption(&c, &i, "They pay", "high").await;
    let comment = c.post(&format!("{API}/{i}/comments"), json!({"body": "hello"})).await.json();
    let edited = c.patch(&format!("{API}/{i}/comments/{}", id(&comment)), json!({"body": "hi"})).await.json();
    let entry = c
        .post(&format!("{API}/{i}/log"), json!({"kind": "finding", "body": "5 of 8 checked", "assumption_id": id(&a)}))
        .await
        .json();
    c.post(&format!("{API}/{i}/log"), json!({"kind": "note", "body": "later"})).await;
    let pinned = c.patch(&format!("{API}/{i}/log/{}", id(&entry)), json!({"pinned": true})).await.json();
    let log = c.get(&format!("{API}/{i}/log")).await.json();
    let evidence =
        c.post(&format!("{API}/{i}/log/{}/evidence", id(&entry)), json!({"assumption_id": id(&a)})).await.json();
    c.delete(&format!("{API}/{i}/comments/{}", id(&comment))).await;
    let gone = c.get(&format!("{API}/{i}/comments")).await.json();
    let bad = c.post(&format!("{API}/{i}/log"), json!({"kind": "gossip", "body": "x"})).await;
    stage(&c, &i, "archived", json!({"archive_reason": "other"})).await;
    let closed = c.post(&format!("{API}/{i}/log"), json!({"kind": "note", "body": "x"})).await;

    assert!(comment["author"] == "user" && edited["body"] == "hi");
    assert!(pinned["pinned"] == true && log[0]["id"] == entry["id"]);
    assert_eq!(evidence["assumptions"][0]["evidence"][0]["kind"], "note");
    assert_eq!(gone, json!([]));
    assert_eq!(bad.status, 422);
    assert!(closed.status == 409 && code(&closed) == "idea_closed");
}

#[tokio::test]
async fn test_activity_has_authors_kinds_and_filter_counts() {
    guard!("test_activity_has_authors_kinds_and_filter_counts");
    let s = Server::start().await;
    let c = s.client();
    let p = create_project(&c).await;
    let i = id(&create_idea(&c, &id(&p), json!({})).await);
    assumption(&c, &i, "They pay", "high").await;
    stage(&c, &i, "exploring", json!({"via": "Keep"})).await;
    c.patch(&format!("{API}/{i}/page"), json!({"body": "new text", "ai": true})).await;
    let activity = format!("{API}/{i}/activity");
    let everything = c.get(&activity).await.json();
    let staged = c.get_query(&activity, &[("filter", "stage")]).await.json();
    let ai = c.get_query(&activity, &[("filter", "ai")]).await.json();
    let bad = c.get_query(&activity, &[("filter", "nope")]).await;

    assert_eq!(everything["counts"]["all"], 4);
    assert!(everything["counts"]["assumptions"] == 1 && everything["counts"]["page"] == 1);
    let to: Vec<Value> = staged["items"].as_array().expect("items").iter().map(|e| e["meta"]["to"].clone()).collect();
    assert_eq!(to, [json!("exploring"), Value::Null]);
    let kinds: Vec<&Value> = staged["items"].as_array().expect("items").iter().map(|e| &e["kind"]).collect();
    assert_eq!(kinds, ["stage", "created"]);
    assert!(everything["items"].as_array().expect("items").iter().all(|e| e["author"] == "user"));
    assert!(ai["items"].as_array().expect("items").len() == 1 && ai["items"][0]["kind"] == "page");
    assert_eq!(bad.status, 422);
}

// ── promote and the ticket side ────────────────────────────────────────────

#[tokio::test]
async fn test_promote_preview_then_create_builds_the_ticket_from_the_idea() {
    guard!("test_promote_preview_then_create_builds_the_ticket_from_the_idea");
    let s = Server::start().await;
    let c = s.client();
    let p = create_project(&c).await;
    let idea =
        create_idea(&c, &id(&p), json!({"title": "Cost badge", "problem_statement": "People ask the cost"})).await;
    let i = id(&idea);
    let done = assumption(&c, &i, "Fits on the card", "low").await;
    let open = assumption(&c, &i, "Price table stays current", "high").await;
    c.patch(&format!("{API}/{i}/assumption-records/{}", id(&done)), json!({"status": "validated"})).await;
    c.post(&format!("{API}/{i}/vote"), json!({"voter": "Lan"})).await;
    c.post(&format!("{API}/{i}/vote"), json!({"voter": "Hoa"})).await;
    stage(&c, &i, "exploring", json!({})).await;

    let preview = c.get(&format!("{API}/{i}/promote/preview")).await.json();
    let no_ack = c.post(&format!("{API}/{i}/promote"), json!({})).await;
    let made = c.post(&format!("{API}/{i}/promote"), json!({"acknowledge_not_ready": true})).await;
    let again = c.post(&format!("{API}/{i}/promote"), json!({"acknowledge_not_ready": true})).await;
    let ticket = made.json()["ticket"].clone();
    let context = c.get(&format!("{API}/by-ticket/{}", id(&ticket))).await.json();
    let listed = c.get(&format!("/projects/{}/tickets", id(&p))).await.json();

    assert!(preview["can_promote"] == true && preview["not_ready"]["high_open"] == 1);
    let checklist: Vec<&Value> =
        preview["draft"]["checklist"].as_array().expect("list").iter().map(|x| &x["text"]).collect();
    assert_eq!(checklist, [&open["text"]]);
    assert_eq!(preview["draft"]["confirmed"], json!(["Fits on the card"]));
    assert_eq!(preview["draft"]["demand"], "2 people want this");
    assert!(preview["draft"]["description"].as_str().expect("text").contains("### Already confirmed"));
    assert!(no_ack.status == 409 && code(&no_ack) == "not_ready");
    assert_eq!(made.status, 201);
    assert_eq!(made.json()["idea"]["stage"], "building");
    assert_eq!(made.json()["idea"]["ticket"]["id"], ticket["id"]);
    assert_eq!(ticket["from_idea_id"], i.as_str());
    let sub_tasks: Vec<&Value> = ticket["sub_tasks"].as_array().expect("list").iter().map(|x| &x["text"]).collect();
    assert_eq!(sub_tasks, [&open["text"]]);
    assert_eq!(code(&again), "already_promoted");
    assert_eq!(context["from_idea"]["assumptions_checked"], 1);
    assert_eq!(context["from_idea"]["demand"], "2 people want this");
    assert!(listed.as_array().expect("list").iter().any(|t| t["from_idea_id"] == i.as_str()));
}

#[tokio::test]
async fn test_promote_can_split_into_sub_tickets_and_assigns_a_project() {
    guard!("test_promote_can_split_into_sub_tickets_and_assigns_a_project");
    let s = Server::start().await;
    let c = s.client();
    let p = create_project(&c).await;
    let idea = c.post(API, json!({"title": "Loose idea"})).await.json();
    let i = id(&idea);
    stage(&c, &i, "exploring", json!({})).await;
    let needs = c.post(&format!("{API}/{i}/promote"), json!({"acknowledge_not_ready": true})).await;
    let made = c
        .post(
            &format!("{API}/{i}/promote"),
            json!({
                "project_id": id(&p),
                "acknowledge_not_ready": true,
                "sub_tickets": ["Price table", "Estimate on the card"],
            }),
        )
        .await;

    assert_eq!(code(&needs), "needs_project");
    let body = made.json();
    assert_eq!(body["idea"]["project_id"], p["id"]);
    let titles: Vec<&Value> = body["sub_tickets"].as_array().expect("list").iter().map(|t| &t["title"]).collect();
    assert_eq!(titles, ["Price table", "Estimate on the card"]);
    let parents: std::collections::BTreeSet<String> = body["sub_tickets"]
        .as_array()
        .expect("list")
        .iter()
        .map(|t| t["parent_id"].as_str().expect("parent").to_string())
        .collect();
    assert_eq!(parents, [body["ticket"]["id"].as_str().expect("id").to_string()].into_iter().collect());
}

#[tokio::test]
async fn test_the_idea_follows_its_ticket_done_wont_do_reopen_and_delete() {
    guard!("test_the_idea_follows_its_ticket_done_wont_do_reopen_and_delete");
    let s = Server::start().await;
    let c = s.client();
    let p = create_project(&c).await;

    async fn promoted(c: &testkit::Client, p: &Value, title: &str) -> (String, String) {
        let idea = create_idea(c, &id(p), json!({"title": title})).await;
        let r = c.post(&format!("{API}/{}/promote", id(&idea)), json!({"acknowledge_not_ready": true})).await;
        (id(&idea), id(&r.json()["ticket"]))
    }
    let (shipped, t1) = promoted(&c, &p, "Ships").await;
    let (dropped, t2) = promoted(&c, &p, "Dropped").await;
    let (deleted, t3) = promoted(&c, &p, "Deleted").await;

    // the idea follows its ticket only where the hook of the ticket code is registered; the app does that
    // (`kb_ideas::register`), and until it does the Rust server leaves the ideas alone
    c.patch(&format!("/tickets/{t1}"), json!({"status": "in-progress"})).await;
    let building = c.get(&format!("{API}/{shipped}")).await.json()["stage"].clone();
    c.patch(&format!("/tickets/{t1}"), json!({"status": "done"})).await;
    let done = c.get(&format!("{API}/{shipped}")).await.json();
    if done["stage"] != "shipped" && testkit::target() == testkit::Target::Rust && !hook_is_registered(&c).await {
        skipped_without_the_hook("test_the_idea_follows_its_ticket_done_wont_do_reopen_and_delete");
        return;
    }
    let archive_while_done = stage(&c, &shipped, "exploring", json!({})).await; // reopen the idea by hand
    c.patch(&format!("/tickets/{t2}"), json!({"status": "wont_do", "wont_do_reason": "no"})).await;
    let wont = c.get(&format!("{API}/{dropped}")).await.json();
    let again = c.post(&format!("{API}/{dropped}/promote"), json!({"acknowledge_not_ready": true})).await;
    c.delete(&format!("/tickets/{t3}")).await;
    let gone = c.get(&format!("{API}/{deleted}")).await.json();

    assert_eq!(building, "building");
    assert!(done["stage"] == "shipped" && !done["shipped_at"].is_null());
    assert_eq!(archive_while_done.status, 200);
    assert!(wont["stage"] == "exploring" && wont["ticket"].is_null());
    assert_eq!(wont["former_ticket_id"], t2.as_str());
    assert_eq!(again.status, 201, "an idea whose ticket was dropped can be promoted again");
    assert!(gone["stage"] == "ready" && gone["former_ticket_id"] == t3.as_str());
}

#[tokio::test]
async fn test_a_building_idea_cannot_be_archived_or_dropped() {
    guard!("test_a_building_idea_cannot_be_archived_or_dropped");
    let s = Server::start().await;
    let c = s.client();
    let p = create_project(&c).await;
    let idea = create_idea(&c, &id(&p), json!({})).await;
    let i = id(&idea);
    c.post(&format!("{API}/{i}/promote"), json!({"acknowledge_not_ready": true})).await;
    let archived = stage(&c, &i, "archived", json!({"archive_reason": "other"})).await;
    let legacy = c.patch(&format!("{API}/{i}/status"), json!({"new_status": "dropped"})).await;

    assert_eq!(archived.status, 409);
    assert_eq!(code(&archived), "building_locked");
    assert_eq!(legacy.status, 400);
}

// ── similarity ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn test_similar_ideas_tickets_and_tags_are_found_without_a_model() {
    guard!("test_similar_ideas_tickets_and_tags_are_found_without_a_model");
    let s = Server::start().await;
    let c = s.client();
    let p = create_project(&c).await;
    let like = create_idea(
        &c,
        &id(&p),
        json!({
            "title": "Show cost on every AI run card",
            "description": "People ask what a run cost before they start it",
            "tags": ["ai", "cost"],
        }),
    )
    .await;
    create_idea(&c, &id(&p), json!({"title": "Dark mode for Docs"})).await;
    c.post(
        &format!("/projects/{}/tickets", id(&p)),
        json!({"title": "Cost estimate on the run card", "description": "show the AI run cost"}),
    )
    .await;
    let found = c
        .get_query(&format!("{API}/similar"), &[("text", "Show cost on the AI run card"), ("project_id", &id(&p))])
        .await
        .json();
    let tags = c.get_query(&format!("{API}/tag-suggestions"), &[("text", "AI run card cost estimate")]).await.json();
    let nothing = c.get_query(&format!("{API}/similar"), &[("text", "the and of")]).await.json();

    let found_list = found.as_array().expect("list");
    assert!(
        found_list.iter().take(2).any(|f| f["id"] == like["id"])
            && found_list[0]["score"].as_f64().expect("score") >= 0.5
    );
    let kinds: std::collections::BTreeSet<&str> =
        found_list.iter().map(|f| f["kind"].as_str().expect("kind")).collect();
    assert_eq!(kinds, ["idea", "ticket"].into_iter().collect());
    assert!(!found_list.iter().any(|f| f["title"] == "Dark mode for Docs"));
    let tags = tags.as_array().expect("tags");
    assert!(tags.contains(&json!("ai")) && tags.contains(&json!("cost")));
    assert_eq!(nothing, json!([]));
}

// ── MCP: AI members read and suggest only ──────────────────────────────────
//
// `test_an_ai_member_can_read_ideas_and_add_to_the_inbox_only` calls the MCP operations (`ops.create_idea_ticket`,
// `list_idea_tickets`, `list_idea_assumptions`, `get_idea_activity_trail`) and checks that `ops` has no
// `update_idea_status`, `promote_idea_to_ticket` or `delete_idea_ticket`: it waits for the MCP port (`kb-mcp`).

#[tokio::test]
async fn test_the_old_status_endpoint_keeps_working_for_the_current_board() {
    guard!("test_the_old_status_endpoint_keeps_working_for_the_current_board");
    let s = Server::start().await;
    let c = s.client();
    let p = create_project(&c).await;
    let i = id(&create_idea(&c, &id(&p), json!({})).await);
    let r = c.patch(&format!("{API}/{i}/status"), json!({"new_status": "in_review"})).await;
    let got = c.get(&format!("{API}/{i}")).await.json();

    assert_eq!(r.status, 200);
    assert!(got["stage"] == "exploring" && got["idea_status"] == "in_review");
}

// ── the idea's workspace folder ────────────────────────────────────────────

#[tokio::test]
async fn test_an_idea_has_a_workspace_folder_that_can_follow_its_ticket() {
    guard!("test_an_idea_has_a_workspace_folder_that_can_follow_its_ticket");
    let s = Server::start().await;
    let c = s.client();
    let dir = tempfile::tempdir().expect("temporary folder");
    c.patch("/workspace/settings", json!({"root_path": dir.path().to_string_lossy()})).await;
    let p = create_project(&c).await;
    let idea = create_idea(&c, &id(&p), json!({"title": "With a folder"})).await;
    let i = id(&idea);
    let info = c.get(&format!("/tickets/{i}/workspace")).await.json();
    c.post_empty(&format!("/tickets/{i}/workspace/init")).await;
    c.upload(
        &format!("/tickets/{i}/workspace/files"),
        "file",
        "notes.md",
        "text/markdown",
        b"# prior art".to_vec(),
        &[("directory", "")],
    )
    .await;
    let listed = c.get(&format!("/tickets/{i}/workspace")).await.json();
    let moved =
        c.post(&format!("{API}/{i}/promote"), json!({"acknowledge_not_ready": true, "workspace": "move"})).await.json();
    let ticket_id = id(&moved["ticket"]);
    let on_ticket = c.get(&format!("/tickets/{ticket_id}/workspace")).await.json();
    let on_idea = c.get(&format!("/tickets/{i}/workspace")).await.json();

    assert!(info["exists"] == false && info["path"].as_str().expect("path").ends_with(&format!("/{i}")));
    let names =
        |w: &Value| -> Vec<Value> { w["files"].as_array().expect("files").iter().map(|f| f["name"].clone()).collect() };
    assert_eq!(names(&listed), [json!("notes.md")]);
    assert_eq!(names(&on_ticket), [json!("notes.md")]);
    assert_eq!(on_idea["exists"], false, "the folder was moved, not copied");
}

#[tokio::test]
async fn test_a_closed_idea_workspace_expires_after_thirty_days_unless_kept() {
    guard!("test_a_closed_idea_workspace_expires_after_thirty_days_unless_kept");
    let s = Server::start().await;
    let c = s.client();
    let dir = tempfile::tempdir().expect("temporary folder");
    let root = dir.path().to_path_buf();
    c.patch("/workspace/settings", json!({"root_path": root.to_string_lossy()})).await;
    let p = create_project(&c).await;
    let closed = id(&create_idea(&c, &id(&p), json!({"title": "Closed"})).await);
    let open = id(&create_idea(&c, &id(&p), json!({"title": "Open"})).await);
    let kept = id(&create_idea(&c, &id(&p), json!({"title": "Kept"})).await);
    let old = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock").as_secs() - 40 * 86400;
    for i in [&closed, &open, &kept] {
        c.post_empty(&format!("/tickets/{i}/workspace/init")).await;
        std::fs::write(root.join(i).join("x.txt"), "x").expect("write");
        set_mtime(&root.join(i).join("x.txt"), old);
        set_mtime(&root.join(i), old);
    }
    stage(&c, &closed, "archived", json!({"archive_reason": "other"})).await;
    stage(&c, &kept, "archived", json!({"archive_reason": "other"})).await;
    c.patch(&format!("{API}/{kept}/page"), json!({"workspace_retention": "forever"})).await;
    let swept = c.post("/workspace/sweep", json!({"dry_run": false})).await.json();

    let removed: std::collections::BTreeSet<String> = swept["removed"]
        .as_array()
        .expect("removed")
        .iter()
        .map(|r| r["ticket_id"].as_str().expect("id").to_string())
        .collect();
    assert_eq!(removed, [closed.clone()].into_iter().collect());
    assert!(!root.join(&closed).exists());
    assert!(root.join(&open).exists() && root.join(&kept).exists());
}

/// `os.utime(path, (t, t))`.
fn set_mtime(path: &std::path::Path, secs: u64) {
    let when = std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs);
    std::fs::File::open(path).expect("open").set_modified(when).expect("set_modified");
}

#[tokio::test]
async fn test_attachments_and_the_viewer_flag_come_with_the_idea() {
    guard!("test_attachments_and_the_viewer_flag_come_with_the_idea");
    let s = Server::start().await;
    let c = s.client();
    let p = create_project(&c).await;
    add_member(&c, &id(&p), "Vera", "viewer").await;
    let idea = create_idea(&c, &id(&p), json!({"title": "With proof"})).await;
    let a = assumption(&c, &id(&idea), "They pay", "high").await;
    for (kind, reference, title) in [
        ("file", "/uploads/run-cost-sheet.png", "run-cost-sheet.png"),
        ("link", "https://example.com/price", "Price page"),
        ("sketch", "![Run card](sketch:abc)", "Run card with cost"),
    ] {
        c.post(
            &format!("{API}/{}/evidence", id(&idea)),
            json!({"assumption_ids": [id(&a)], "kind": kind, "ref": reference, "title": title}),
        )
        .await;
    }
    let preview = c.get(&format!("{API}/{}/promote/preview", id(&idea))).await.json();
    let as_member = c.get(&format!("{API}/{}", id(&idea))).await.json();
    let as_viewer = c.clone().header("X-Actor", "Vera").get(&format!("{API}/{}", id(&idea))).await.json();

    let text = preview["draft"]["description"].as_str().expect("description");
    assert!(text.contains("### Attachments from the idea"));
    assert!(text.contains("![run-cost-sheet.png](/uploads/run-cost-sheet.png)"));
    assert!(text.contains("[Price page](https://example.com/price)"));
    assert!(text.contains("![Run card](sketch:abc)"));
    assert!(as_member["can_edit"] == true && as_viewer["can_edit"] == false);
}
