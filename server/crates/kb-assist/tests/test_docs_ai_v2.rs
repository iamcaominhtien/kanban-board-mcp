//! Docs AI on the assistant engine (AI v2 stage 7): jobs whose handlers run one assistant turn with a skill; what needs
//! no model (ignore, create tickets, undo) is plain code (`server/tests/test_docs_ai_v2.py`, with
//! `server/tests/docs_ai_helpers.py`).
//!
//! The Python tests go through the routes of `api/docs_ai/`, which a later task ports. Here a job is started as the
//! route starts it (`jobs::start` with the same fields) and the assertions are about what the service functions and
//! the job rows give, with the same names. What a test asserts about a route alone (a 202, a 422 for a blank question
//! or selection, a `scope` the route refuses) waits with the routes and is named in a comment where it was left out.
//! `test_a_note_to_a_page_reaches_the_page_assistant` waits whole: it calls `ai/messaging.py` (`deliver_to_page`).

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod common;

use std::time::{Duration, Instant};

use kb_assist::assistant::docs as adocs;
use kb_assist::docs_ai::errors::Error;
use kb_assist::docs_ai::jobs::{self, NewJob};
use kb_assist::docs_ai::settings as dsettings;
use kb_db::database;
use kb_db::entities::{docs_ai_job, docs_ai_settings, project};
use kb_db::sea_orm::{ActiveModelTrait, EntityTrait, Set};
use serde_json::{Map, Value, json};

const BY: &str = "An Nguyen";

/// `_space(env, monkeypatch, answers)`: a project with a team and Docs AI on, a page "API", and the answers of the
/// stand-in CLI per skill. Returns the project's id, the page's id and the team.
async fn space(answers: Value) -> (String, String, Map<String, Value>) {
    kb_assist::register();
    let (pid, _an) = common::project().await;
    let team = common::team_of(&pid, "Claude Code · Backend", json!({})).await;
    let s = database::session();
    let mut patch = Map::new();
    patch.insert("enabled".into(), json!(true));
    dsettings::update(&s, &pid, &patch, BY).await.expect("settings");
    let md = "# API\n\nThe API uses REST.\n\n- [ ] Add paging\n";
    let page = kb_docs::docs::create_page(&s, &pid, "API", None, "blank", Some(md)).await.expect("page");
    common::fake(&[("FAKE_CLAUDE_ASSISTANT_BY_SKILL", &answers.to_string())]);
    (pid, page["id"].as_str().expect("id").to_string(), team)
}

/// `_job(c, job)`: the job once it is no longer queued or running, as the API shows it.
async fn finished(job_id: &str) -> Map<String, Value> {
    let end = Instant::now() + Duration::from_secs(15);
    loop {
        let s = database::session();
        let j = docs_ai_job::Entity::find_by_id(job_id).one(&s).await.expect("query").expect("the job");
        drop(s);
        if !jobs::ACTIVE.contains(&j.state.as_str()) {
            return jobs::to_dict(&j);
        }
        assert!(Instant::now() < end, "the job never ended: {j:?}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// A job as `api/docs_ai/page.py::_page_job` starts it: the inputs are `result.input`.
async fn page_job(pid: &str, page_id: &str, kind: &str, instruction: &str, input: Value) -> String {
    let s = database::session();
    let job = jobs::start(
        &s,
        NewJob {
            project_id: pid.to_string(),
            kind: kind.to_string(),
            started_by: BY.to_string(),
            page_id: Some(page_id.to_string()),
            instruction: instruction.to_string(),
            result: Some(json!({"input": input})),
            ..Default::default()
        },
    )
    .await
    .expect("start");
    job.id
}

#[tokio::test]
async fn test_ask_the_docs_answers_with_citations() {
    let _guard = common::init().await;
    let (pid, _page, _team) = space(json!({"docs-ask": {
        "answer": "REST [1].", "verdict": "answered", "citations": [{"page_id": "PAGE", "title": "API"}], "pages_read": 2
    }}))
    .await;
    // `POST /projects/{id}/docs/ai/ask`: the route cuts the question's white space (`Which   API style?`)
    let s = database::session();
    dsettings::require_enabled(&s, &pid).await.expect("on");
    adocs::ready_or_raise(&pid).await.expect("ready");
    let question = "Which API style?";
    let started = jobs::start(
        &s,
        NewJob {
            project_id: pid.clone(),
            kind: "ask".into(),
            started_by: BY.into(),
            instruction: question.into(),
            result: Some(json!({"question": question, "scope": "space", "page_id": null})),
            ..Default::default()
        },
    )
    .await
    .expect("start");
    assert!(started.kind == "ask" && started.instruction == "Which API style?");
    let j = finished(&started.id).await;
    assert_eq!(j["state"], "finished", "{j:?}");
    let res = &j["result"];
    assert!(res["answer"] == "REST [1]." && res["verdict"] == "answered" && res["pages_read"] == 2);
    assert_eq!(res["citations"], json!([{"n": 1, "page_id": "PAGE", "title": "API", "section": null}]));
    assert!(j["cost"] == 0.02 && j["tokens_in"] == 200);
    let chat_id = adocs::open_as_chat(&s, &started.id, BY).await.expect("chat");
    assert!(!chat_id.is_empty());
    let fb = adocs::feedback(&s, &started.id, BY, "up", "").await.expect("feedback");
    assert_eq!(fb["result"]["feedback"]["rating"], "up");
    // a blank question and a scope of "moon" are refused by the route (422), which a later task ports
}

#[tokio::test]
async fn test_docs_ai_off_refuses() {
    let _guard = common::init().await;
    let (pid, _an) = common::project().await;
    // `services.projects.create_project` writes the row: Docs AI is off for a new project
    let s = database::session();
    let mut row = docs_ai_settings::new();
    row.project_id = Set(pid.clone());
    row.insert(&s).await.expect("row");
    s.commit().await.expect("commit");
    // `POST /projects/{id}/docs/ai/ask` asks `require_enabled` first
    let off = dsettings::require_enabled(&s, &pid).await.expect_err("off");
    assert_eq!(off.code(), Some("docs_ai_off"));
    assert_eq!(off.docs_ai().map(|e| e.status()), Some(409));
}

#[tokio::test]
async fn test_check_fix_and_ignore() {
    let _guard = common::init().await;
    let finding = json!({"kind": "unclear", "quote": "The API uses REST.", "message": "Say which version.", "suggestion": "The API uses REST v2."});
    let (pid, page, _team) = space(json!({
        "docs-check": {"findings": [finding, {"kind": "style", "quote": "Add paging", "message": "Write a full sentence."}]},
        "docs-fix": {"old": "The API uses REST.", "new": "The API uses REST v2."},
    }))
    .await;
    let j = finished(&page_job(&pid, &page, "check", "Check this page", json!({"markdown": null})).await).await;
    assert_eq!(j["state"], "finished", "{j:?}");
    let found = j["result"]["findings"].as_array().expect("findings").clone();
    let kinds: Vec<&Value> = found.iter().map(|f| &f["kind"]).collect();
    assert_eq!(kinds, [&json!("unclear"), &json!("style")]);
    assert!(found.iter().all(|f| f["id"].as_str().is_some_and(|id| id.chars().count() == 10)));
    // `POST .../check/{finding_id}/fix`: the route finds the finding and starts the job with it
    let s = database::session();
    let one = adocs::find_finding(&s, &pid, &page, found[0]["id"].as_str().expect("id"), None).await.expect("finding");
    let fix = page_job(&pid, &page, "check_fix", "Fix", json!({"finding": one, "markdown": null})).await;
    let fixed = finished(&fix).await;
    assert!(fixed["state"] == "finished" && fixed["result"]["new"] == "The API uses REST v2.");
    let gone = adocs::find_finding(&s, &pid, &page, "nope", None).await.expect_err("no such finding");
    assert_eq!(gone.docs_ai().map(|e| e.status()), Some(404));
    adocs::ignore(&s, &page, found[1]["id"].as_str().expect("id"), BY).await.expect("ignore");
    let again = finished(&page_job(&pid, &page, "check", "Check this page", json!({"markdown": null})).await).await;
    let kinds: Vec<&Value> =
        again["result"]["findings"].as_array().expect("findings").iter().map(|f| &f["kind"]).collect();
    assert_eq!(kinds, [&json!("unclear")]);
    assert_eq!(again["result"]["ignored"], 1);
}

#[tokio::test]
async fn test_page_views_summary_explain_translate() {
    let _guard = common::init().await;
    let (pid, page, _team) = space(json!({
        "docs-summarise": {"text": "REST API.", "title": "API"},
        "docs-explain": {"text": "REST is a style."},
        "docs-translate": {"markdown": "# API\n\nAPI dùng REST.", "language": "Vietnamese"},
    }))
    .await;
    let s = finished(&page_job(&pid, &page, "summary", "Summarise this page", json!({"markdown": null})).await).await;
    assert!(s["result"]["text"] == "REST API." && s["result"]["title"] == "API");
    let e = finished(&page_job(&pid, &page, "explain", "Explain", json!({"selection": "REST", "section": null})).await)
        .await;
    assert!(e["result"]["text"] == "REST is a style." && e["result"]["from"] == "API");
    let t = finished(
        &page_job(&pid, &page, "translate", "Translate", json!({"language": "Vietnamese", "section": null})).await,
    )
    .await;
    assert!(
        t["result"]["language"] == "Vietnamese" && t["result"]["markdown"].as_str().expect("md").contains("dùng REST")
    );
    // a blank selection of `explain` is refused by the route (422), which a later task ports
}

#[tokio::test]
async fn test_write_a_page_and_markers() {
    let _guard = common::init().await;
    let (pid, page, _team) =
        space(json!({"docs-write": {"page_id": "PAGE", "title": "Paging", "gaps": ["Who owns it?"]}})).await;
    let record = common::record_file();
    common::fake(&[
        (
            "FAKE_CLAUDE_ASSISTANT_BY_SKILL",
            &json!({"docs-write": {"page_id": "PAGE", "title": "Paging", "gaps": ["Who owns it?"]}}).to_string(),
        ),
        ("FAKE_CLAUDE_PROMPTS", &record),
    ]);
    let s = database::session();
    let params: Map<String, Value> =
        json!({"source": {"kind": "prompt", "text": "Paging design"}}).as_object().cloned().expect("map");
    let pre = adocs::write_preview(&s, &pid, &params).await.expect("preview");
    assert_eq!(pre["items"][0]["kind"], "prompt");
    let mut with_kind = params.clone();
    with_kind.insert("page_kind".into(), json!("spec"));
    let job = adocs::start_write(&s, &pid, &with_kind, BY).await.expect("write");
    let j = finished(&job.id).await;
    assert_eq!(j["state"], "finished", "{j:?}");
    assert!(
        j["result"]["page_id"] == "PAGE" && j["result"]["gaps"] == json!(["Who owns it?"]) && j["page_id"] == "PAGE"
    );
    let prompts = common::prompts(&record);
    let prompt = prompts.last().expect("a recorded turn")["prompt"].as_str().expect("prompt");
    assert!(
        prompt.contains("kanban-assistant:docs-write")
            && prompt.contains("Paging design")
            && prompt.contains("page_kind: spec")
    );
    let bad: Map<String, Value> = json!({"source": {"kind": "notes", "text": ""}}).as_object().cloned().expect("map");
    let refused = adocs::start_write(&s, &pid, &bad, BY).await.expect_err("notes are needed");
    assert_eq!(refused.docs_ai().map(|e| e.status()), Some(422));
    let m = adocs::markers_of(&s, &page).await.expect("markers");
    assert_eq!(Value::Object(m), json!({"markers": [], "count": 0}));
}

#[tokio::test]
async fn test_tickets_from_a_page_draft_create_undo() {
    let _guard = common::init().await;
    let (pid, page, _team) = space(json!({"docs-tickets": {
        "drafts": [{"title": "Add paging", "text": "From the API page.", "type": "task"}], "skipped": []
    }}))
    .await;
    let d = finished(
        &page_job(&pid, &page, "tickets_draft", "Draft tickets from this page", json!({"selection": null})).await,
    )
    .await;
    assert!(d["state"] == "finished" && d["result"]["drafts"][0]["title"] == "Add paging");
    let s = database::session();
    let drafts = d["result"]["drafts"].as_array().expect("drafts").clone();
    let out = adocs::create_tickets(&s, &page, BY, &drafts, true).await.expect("create");
    assert!(out["tickets"].as_array().expect("tickets").len() == 1 && out["linked"] == true);
    let token = out["undo_token"].as_str().expect("token").to_string();
    assert!(!token.is_empty());
    let tid = out["tickets"][0]["id"].as_str().expect("id").to_string();
    let ticket = kb_board::tickets::get_ticket(&s, &tid).await.expect("get").expect("the ticket");
    assert_eq!(ticket.title, "Add paging");
    let docs = kb_docs::docs::docs_for_ticket(&s, &tid).await.expect("docs");
    assert!(docs.iter().any(|p| p["page_id"] == page.as_str()));
    let undone = adocs::undo_tickets(&s, &token, BY).await.expect("undo");
    assert_eq!(undone["removed"], json!([tid]));
    assert!(kb_board::tickets::get_ticket(&s, &tid).await.expect("get").is_none());
    let again = adocs::undo_tickets(&s, &token, BY).await.expect_err("too old");
    assert_eq!(again.docs_ai().map(|e| e.status()), Some(404));
}

#[tokio::test]
async fn test_freshness_banner() {
    let _guard = common::init().await;
    let (pid, page_id, _team) = space(json!({"docs-freshness": {
        "state": "stale", "reasons": [{"quote": "REST", "source": "KAN-1", "why": "The API moved to gRPC."}]
    }}))
    .await;
    let s = database::session();
    let page = kb_docs::docs::get_page(&s, &page_id, false, false).await.expect("page");
    assert_eq!(adocs::freshness_of(&s, &page).await.expect("banner")["state"], "unchecked");
    let j = finished(&page_job(&pid, &page_id, "freshness", "Reported: it looks old", Value::Object(Map::new())).await)
        .await;
    assert!(j["state"] == "finished" && j["result"]["state"] == "stale");
    let banner = adocs::freshness_of(&s, &page).await.expect("banner");
    assert!(banner["stale"] == true && banner["reasons"][0]["text"] == "The API moved to gRPC.");
    let key = banner["reasons"][0]["key"].as_str().expect("key").to_string();
    let gone = adocs::freshness_mark(&s, &page, false, Some(&key)).await.expect("dismiss");
    assert!(gone["stale"] == false && gone["hidden"] == 1);
    let ok = adocs::freshness_mark(&s, &page, true, None).await.expect("still correct");
    assert_eq!(ok["state"], "ok");
}

#[tokio::test]
async fn test_thread_summary() {
    let _guard = common::init().await;
    let (_pid, page, _team) =
        space(json!({"docs-thread": {"reply": "- Paging is wanted.\n- Nobody owns it.", "posted": true}})).await;
    let s = database::session();
    let t =
        kb_docs::docs_comments::create_thread(&s, &page, "page", "Who owns paging?", None, None).await.expect("thread");
    let thread_id = t["id"].as_str().expect("id").to_string();
    let job = adocs::start_thread_job(&s, &thread_id, "thread_summary", BY, "").await.expect("job");
    let j = finished(&job.id).await;
    assert_eq!(j["state"], "finished", "{j:?}");
    assert_eq!(j["thread_id"], thread_id.as_str());
    assert_eq!(kb_docs::docs_comments::list_comments(&s, &page, "all", None).await.expect("comments")["docs_ai"], true);
}

#[tokio::test]
async fn test_an_ai_mention_in_a_thread_is_answered_by_the_assistant() {
    let _guard = common::init().await;
    let (_pid, page, team) = space(json!({"docs-thread": {"reply": "Nobody yet: assign it.", "posted": false}})).await;
    let s = database::session();
    let body = format!(
        "@[{}](member:{}) who owns paging?",
        team["name"].as_str().expect("name"),
        team["id"].as_str().expect("id")
    );
    let t = kb_docs::docs_comments::create_thread(&s, &page, "page", &body, None, None).await.expect("thread");
    // `ai_delivery` of the route's answer: what `deliver` gives
    let delivery = adocs::deliver(&s, &t, BY, "ask").await.expect("deliver");
    assert!(!delivery.is_empty() && delivery[0]["result"] == "job", "{delivery:?}");
    let j = finished(delivery[0]["job_id"].as_str().expect("job id")).await;
    assert!(j["state"] == "finished" && j["result"]["reply"] == "Nobody yet: assign it.", "{j:?}");
    let threads = kb_docs::docs_comments::list_comments(&s, &page, "all", None).await.expect("comments");
    let replies = threads["threads"][0]["comments"].as_array().expect("comments").clone();
    let last = replies.last().expect("a reply");
    assert!(replies.len() == 2 && last["body"] == "Nobody yet: assign it." && last["ai"]["member"] == "Docs AI");
    assert_eq!(last["id"], j["reply_comment_id"]);
}

// `test_a_note_to_a_page_reaches_the_page_assistant` waits for `ai/messaging.py` (`deliver_to_page`).

#[tokio::test]
async fn the_project_is_not_in_the_way_of_the_settings() {
    // `settings.require_enabled` of a project that is not there: `not_found`
    let _guard = common::init().await;
    let s = database::session();
    let err = dsettings::require_enabled(&s, "nope").await.expect_err("no project");
    assert!(matches!(err, Error::DocsAi(_)) && err.code() == Some("not_found"));
    let _ = project::Entity::find().all(&s).await.expect("projects");
}
