//! The Docs AI's jobs and the hooks this crate backs, beyond what the golden vectors cover: a handler per kind (its
//! result merged, its error written as the job's error), stopping a job that is running, and the hooks of other
//! crates (`kb_draw::hooks::CanvasDelivery`, `kb_docs::hooks::AssignHook`) answering through `seams::Runs`.

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use kb_assist::docs_ai::errors::{DocsAiError, Error};
use kb_assist::docs_ai::jobs::{self, HandlerFuture, NewJob};
use kb_assist::seams;
use kb_db::database;
use kb_db::entities::{ai_run, docs_ai_job};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};

async fn job_row(id: &str) -> docs_ai_job::Model {
    let s = database::session();
    docs_ai_job::Entity::find_by_id(id).one(&s).await.expect("query").expect("the job")
}

async fn ended(id: &str) -> docs_ai_job::Model {
    let end = Instant::now() + Duration::from_secs(15);
    loop {
        let j = job_row(id).await;
        if !jobs::ACTIVE.contains(&j.state.as_str()) {
            return j;
        }
        assert!(Instant::now() < end, "the job never ended: {j:?}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn new_job(pid: &str, kind: &str) -> NewJob {
    NewJob {
        project_id: pid.to_string(),
        kind: kind.to_string(),
        started_by: "An Nguyen".to_string(),
        ..Default::default()
    }
}

fn echo(job: docs_ai_job::Model) -> HandlerFuture {
    Box::pin(async move {
        let mut out = Map::new();
        out.insert("kind".into(), json!(job.kind));
        out.insert("cost".into(), json!(0.5));
        Ok(Some(out))
    })
}

fn refuses(_job: docs_ai_job::Model) -> HandlerFuture {
    Box::pin(async move {
        let mut extra = Map::new();
        extra.insert("hint".into(), json!("try later"));
        Err(Error::DocsAi(DocsAiError::with_extra("rate_limited", "Slow down.", extra)))
    })
}

fn breaks(_job: docs_ai_job::Model) -> HandlerFuture {
    Box::pin(async move { Err(Error::Other("ValueError: not a number".to_string())) })
}

fn silent(_job: docs_ai_job::Model) -> HandlerFuture {
    Box::pin(async move { Ok(None) })
}

#[tokio::test]
async fn a_handler_gives_the_result_and_its_errors_are_written_on_the_job() {
    let _guard = common::init().await;
    let (pid, _an) = common::project().await;
    jobs::register("echo", echo);
    jobs::register("refuses", refuses);
    jobs::register("breaks", breaks);
    jobs::register("silent", silent);
    let s = database::session();
    let mut first = new_job(&pid, "echo");
    first.result = Some(json!({"input": {"a": 1}}));
    let started = jobs::start(&s, first).await.expect("start");
    let done = ended(&started.id).await;
    assert_eq!(done.state, "finished");
    let result: Value = serde_json::from_str(&done.result).expect("result");
    // what the handler gave merges into what the route stored
    assert_eq!(result, json!({"input": {"a": 1}, "kind": "echo", "cost": 0.5}));
    assert!(done.started_at.is_some() && done.ended_at.is_some());

    let failed = ended(&jobs::start(&s, new_job(&pid, "refuses")).await.expect("start").id).await;
    assert_eq!(failed.state, "failed");
    let error: Value = serde_json::from_str(&failed.error).expect("error");
    assert_eq!(error, json!({"code": "rate_limited", "message": "Slow down.", "hint": "try later"}));

    let broken = ended(&jobs::start(&s, new_job(&pid, "breaks")).await.expect("start").id).await;
    let error: Value = serde_json::from_str(&broken.error).expect("error");
    assert_eq!(error, json!({"code": "error", "message": "Couldn't finish (ValueError)."}));

    let quiet = ended(&jobs::start(&s, new_job(&pid, "silent")).await.expect("start").id).await;
    assert_eq!((quiet.state.as_str(), quiet.result.as_str()), ("finished", "{}"));
    common::until("the tasks of the jobs to end", 5.0, || {
        !jobs::is_running(&started.id) && !jobs::is_running(&quiet.id)
    })
    .await;
}

#[tokio::test]
async fn a_running_job_is_stopped_and_its_cli_is_gone() {
    let _guard = common::init().await;
    kb_assist::register();
    let (pid, _an) = common::project().await;
    common::team_of(&pid, "Claude Code · Backend", json!({})).await;
    common::fake(&[("FAKE_CLAUDE_ASSISTANT_WAIT", "30"), ("FAKE_CLAUDE_ASSISTANT_TEXT", "late")]);
    let s = database::session();
    let mut spec = new_job(&pid, "since_viewed");
    spec.instruction = "Changes since you last viewed".to_string();
    let started = jobs::start(&s, spec).await.expect("start");
    let end = Instant::now() + Duration::from_secs(15);
    let run = loop {
        let found = ai_run::Entity::find()
            .filter(ai_run::Column::ProjectId.eq(pid.as_str()))
            .filter(ai_run::Column::Kind.eq("assistant"))
            .one(&s)
            .await
            .expect("query")
            .filter(|r| r.pid.is_some());
        if let Some(run) = found {
            break run;
        }
        assert!(Instant::now() < end, "the turn never started its CLI");
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    let pid_of_cli = run.pid.expect("the CLI's pid");
    assert!(common::alive(pid_of_cli));
    let stopped = jobs::cancel(&s, &started.id, "An Nguyen").await.expect("cancel");
    assert_eq!(stopped.state, "cancelled");
    common::until("the task to end", 10.0, || !jobs::is_running(&started.id)).await;
    let row = job_row(&started.id).await;
    assert_eq!(row.state, "cancelled");
    let error: Value = serde_json::from_str(&row.error).expect("error");
    assert_eq!(error["code"], "cancelled");
    // the turn's CLI was stopped with it, and its run says so
    common::until("the turn's CLI to go", 10.0, || !common::alive(pid_of_cli)).await;
    let run = ai_run::Entity::find_by_id(run.id.as_str()).one(&s).await.expect("query").expect("the run");
    assert_eq!(run.state, "cancelled");
    common::fake(&[]);
}

#[tokio::test]
async fn the_hooks_of_other_crates_answer_through_the_runs_seam() {
    let _guard = common::init().await;
    kb_assist::register();
    // `register` fills the seams of `kb-ai-run` and of this crate, and the Docs AI hook of `kb-docs`; the canvas
    // delivery is `kb_ai_run::register()`'s (one slot), not this crate's
    assert!(kb_draw::hooks::canvas_delivery().is_none());
    assert!(kb_ai_run::seams::page_notes().is_some());
    assert!(kb_docs::hooks::docs_ai().is_some() && kb_docs::hooks::assign().is_some());
    assert_eq!(seams::board_url(), kb_ai_run::runs::url());
    // the seam a later call replaces: a test's fake answers in its place
    let deliveries = Arc::new(common::Deliveries::default());
    seams::set_runs(Some(deliveries.clone()));
    let runs = seams::runs().expect("the seam");
    runs.deliver_to_ticket_with("KAN-1", "a note", "An Nguyen", "docs_threads", 0).await.expect("delivered");
    assert_eq!(
        deliveries.sent.lock().expect("lock").clone(),
        vec![("KAN-1".to_string(), "a note".to_string(), "An Nguyen".to_string())]
    );
    // the default of `deliver_to_page` says the messaging is not connected
    assert!(matches!(runs.deliver_to_page("pg", "a note", "An Nguyen", 0).await, Err(seams::DeliverError::Other(_))));
    *deliveries.refuse.lock().expect("lock") = Some(seams::DeliverError::Run("The team waits for a person.".into()));
    assert!(matches!(
        runs.deliver_to_ticket_with("KAN-1", "a note", "An Nguyen", "docs_threads", 0).await,
        Err(seams::DeliverError::Run(m)) if m == "The team waits for a person."
    ));
    seams::set_runs(None);
    // Docs AI on: a project with its row switched on
    let (pid, _an) = common::project().await;
    let s = database::session();
    let notes = kb_ai_run::seams::page_notes().expect("the page seam");
    assert!(notes.docs_ai_on(&s, &pid).await.expect("on"));
    assert!(kb_docs::hooks::docs_ai().expect("hook").docs_ai_on(&s, &pid).await.expect("on"));
    // a note to a page that is not there is refused as `deliver_to_page` refuses it
    let refused = kb_ai_run::messaging::deliver_to_page("nope", "x", "An Nguyen", 1).await.expect_err("no such page");
    assert!(refused.to_string().starts_with("The note could not be left on the page: "), "{refused}");
}
