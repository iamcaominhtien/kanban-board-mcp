//! The part of `test_ai_runs_v2.py` that needs only `steps` (and the guard's token): a subagent's task events land on the
//! row the stream made. The other tests of that file run a team's lead on the fake CLI through routes and wait for `runs`,
//! `launch`, `teams` and the hook route (`/ai/hooks`). Below the ported test, `steps` is covered on its own: batches,
//! the writer's timer, results attached to a step, reading, closing roles.

mod common;

use std::time::Duration;

use kb_ai::steps::{self, Extras, StepWriter};
use kb_base::events;
use kb_db::database;
use kb_db::entities::{ai_run, ai_run_agent, ai_run_step};
use kb_db::sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};

async fn running_run() -> ai_run::Model {
    let (pid, _) = common::project().await;
    let (team, _) = common::team(&pid, "Claude Code · Backend", common::TeamOpts::default()).await;
    let ticket = common::ticket(&pid, "Fix add()", "todo").await;
    common::run(&pid, &team.id, Some(&ticket.id), "running", |_| {}).await
}

async fn agents_of(run_id: &str) -> Vec<ai_run_agent::Model> {
    ai_run_agent::Entity::find()
        .filter(ai_run_agent::Column::RunId.eq(run_id))
        .all(&database::session())
        .await
        .expect("agents")
}

fn extras(agents: Vec<Value>) -> Extras {
    Extras { agents, ..Extras::default() }
}

/// The stream names a subagent by the lead's Agent call; its hooks carry Claude's own id. Both must end on one row.
#[tokio::test]
async fn test_a_subagents_task_events_land_on_the_row_the_stream_made() {
    let _lock = common::init().await;
    let run = running_run().await;
    steps::append(
        &run.id,
        vec![],
        extras(vec![
            json!({"id": "toolu_dev", "agent_type": "dev"}),
            json!({"id": "toolu_rev", "agent_type": "reviewer"}),
        ]),
    )
    .await
    .expect("append");
    // what the parser makes of the stream's `task_started` / `task_updated` of the reviewer's task: both name the role by
    // Claude's own task id (`task_started` also carries the lead's Agent call)
    steps::append(
        &run.id,
        vec![],
        extras(vec![
            json!({"id": "toolu_rev", "claude_id": "claude-rev-1", "reopen": true}),
            json!({"claude_id": "claude-rev-1", "ended": true}),
        ]),
    )
    .await
    .expect("append");
    let agents: std::collections::HashMap<String, ai_run_agent::Model> =
        agents_of(&run.id).await.into_iter().map(|a| (a.id.clone(), a)).collect();
    assert_eq!(
        agents.keys().cloned().collect::<std::collections::BTreeSet<_>>(),
        ["toolu_dev".to_string(), "toolu_rev".to_string()].into()
    );
    let rev = &agents["toolu_rev"];
    assert!(rev.claude_id.as_deref() == Some("claude-rev-1") && rev.ended_at.is_some());
    let dev = &agents["toolu_dev"];
    assert!(dev.claude_id.is_none() && dev.ended_at.is_none());
}

#[tokio::test]
async fn append_writes_steps_in_one_batch_and_announces_them() {
    let _lock = common::init().await;
    let run = running_run().await;
    let sub = events::subscribe();
    let rows = vec![
        json!({"kind": "tool", "title": "Read calc.py", "tool": "Read", "detail": {"path": "calc.py"}, "tool_id": "t1"}),
        json!({"kind": "command", "title": "x".repeat(500), "tool": "Bash", "output": "o".repeat(steps::OUTPUT_MAX + 10), "agent_id": "toolu_a"}),
        json!({"title": "no kind", "at": "2026-11-11T10:00:00+00:00"}),
    ];
    let mut fields = Map::new();
    fields.insert("summary".into(), json!("Working"));
    fields.insert("steps_count".into(), json!(99));
    let files = vec![json!({"path": "calc.py", "added": 2, "removed": 1, "new": false})];
    let written = steps::append(&run.id, rows, Extras { fields, files, ..Extras::default() }).await.expect("append");
    assert_eq!(written.iter().map(|s| s.seq).collect::<Vec<_>>(), [1, 2, 3]);
    assert_eq!(written[1].title.chars().count(), 400);
    assert_eq!(written[1].output.as_deref().map(|o| o.chars().count()), Some(steps::OUTPUT_MAX));
    assert_eq!((written[2].kind.as_str(), written[2].at.as_str()), ("tool", "2026-11-11T10:00:00+00:00"));
    assert_eq!(written[0].detail, "{\"path\": \"calc.py\"}");
    // the field `steps_count` was set after the count of the rows, as `setattr` does after the loop
    let stored =
        ai_run::Entity::find_by_id(run.id.as_str()).one(&database::session()).await.expect("run").expect("row");
    assert_eq!((stored.summary.as_deref(), stored.steps_count), (Some("Working"), 99));
    assert!(stored.last_output_at.is_some());
    assert_eq!(
        serde_json::from_str::<Value>(&stored.files).expect("json"),
        json!([{"path": "calc.py", "added": 2, "removed": 1, "new": false}])
    );
    // a second batch adds to the changed files and numbers on from the last step
    let second = steps::append(
        &run.id,
        vec![json!({"kind": "text", "title": "more"})],
        Extras {
            files: vec![
                json!({"path": "calc.py", "added": 3, "removed": 0}),
                json!({"path": "b.py", "added": 1, "removed": 1, "new": true}),
            ],
            ..Extras::default()
        },
    )
    .await
    .expect("append");
    assert_eq!(second[0].seq, 4);
    let stored =
        ai_run::Entity::find_by_id(run.id.as_str()).one(&database::session()).await.expect("run").expect("row");
    assert_eq!(
        serde_json::from_str::<Value>(&stored.files).expect("json"),
        json!([{"path": "calc.py", "added": 5, "removed": 1, "new": false}, {"path": "b.py", "added": 1, "removed": 1, "new": true}])
    );
    // a step of an agent the run did not know gets a row for it with the count
    let agents = agents_of(&run.id).await;
    assert_eq!(agents.len(), 1);
    assert_eq!((agents[0].id.as_str(), agents[0].steps_count, agents[0].agent_type.as_str()), ("toolu_a", 1, ""));
    // nothing to write, a run that is not there
    assert!(steps::append(&run.id, vec![], Extras::default()).await.expect("append").is_empty());
    assert!(
        steps::append("run_nope", vec![json!({"kind": "text"})], Extras::default()).await.expect("append").is_empty()
    );

    let mut seen = Vec::new();
    while let Some(event) = sub.try_recv() {
        seen.push(serde_json::from_str::<Value>(&event).expect("json"));
    }
    events::unsubscribe(&sub);
    let step_events: Vec<&Value> =
        seen.iter().filter(|e| e["type"] == json!("ai.step") && e["run_id"] == json!(run.id)).collect();
    assert_eq!(step_events.len(), 2);
    assert_eq!(step_events[0]["steps"].as_array().expect("steps").len(), 3);
    assert_eq!(step_events[0]["truncated"], json!(false));
    assert_eq!(step_events[0]["fields"], json!({"summary": "Working"}), "steps_count is not echoed");
    assert_eq!(step_events[0]["steps_count"], json!(99));
    assert!(step_events[0]["agents"].is_array(), "an agent that only got steps is announced");
}

#[tokio::test]
async fn a_long_batch_is_announced_cut_to_the_last_forty() {
    let _lock = common::init().await;
    let run = running_run().await;
    let sub = events::subscribe();
    let rows: Vec<Value> = (0..45).map(|i| json!({"kind": "text", "title": format!("s{i}")})).collect();
    steps::append(&run.id, rows, Extras::default()).await.expect("append");
    let mut last = None;
    while let Some(event) = sub.try_recv() {
        let v: Value = serde_json::from_str(&event).expect("json");
        if v["run_id"] == json!(run.id) {
            last = Some(v);
        }
    }
    events::unsubscribe(&sub);
    let event = last.expect("an event");
    assert_eq!(event["truncated"], json!(true));
    let shown = event["steps"].as_array().expect("steps");
    assert_eq!((shown.len(), shown[0]["title"].clone()), (40, json!("s5")));
    // a silent batch
    let quiet = events::subscribe();
    steps::append(
        &run.id,
        vec![json!({"kind": "text", "title": "quiet"})],
        Extras { announce: false, ..Extras::default() },
    )
    .await
    .expect("append");
    assert!(quiet.try_recv().is_none());
    events::unsubscribe(&quiet);
}

#[tokio::test]
async fn role_markers_spans_and_closing_roles() {
    let _lock = common::init().await;
    let run = running_run().await;
    steps::append(&run.id, vec![], extras(vec![json!({"id": "a1", "agent_type": "qa", "last_text": "t".repeat(500)})]))
        .await
        .expect("append");
    let stop = steps::append(
        &run.id,
        vec![],
        extras(vec![json!({"id": "a1", "ended": true, "at": "2026-11-11T10:05:00+00:00"})]),
    )
    .await
    .expect("append");
    assert_eq!(
        (stop[0].kind.as_str(), stop[0].title.as_str(), stop[0].at.as_str()),
        ("role", "qa finished", "2026-11-11T10:05:00+00:00")
    );
    // woken again: a start marker and an open span
    let start =
        steps::append(&run.id, vec![], extras(vec![json!({"id": "a1", "reopen": true})])).await.expect("append");
    assert_eq!(start[0].title, "qa works again");
    let session = database::session();
    let listed = steps::agents(&session, &run.id).await.expect("agents");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["last_text"].as_str().map(|t| t.chars().count()), Some(400));
    let spans = listed[0]["spans"].as_array().expect("spans");
    assert_eq!(spans.len(), 2);
    assert_eq!(spans[0]["end"], json!("2026-11-11T10:05:00+00:00"));
    assert_eq!(spans[1]["end"], Value::Null);
    // a role that never reported ends when the CLI is gone
    steps::close_roles(&run.id).await.expect("close");
    let closed = steps::agents(&database::session(), &run.id).await.expect("agents");
    assert!(closed[0]["ended_at"].is_string());
    // the span ends at the marker's own time, which is read a moment after the agent's end
    assert!(closed[0]["spans"].as_array().expect("spans")[1]["end"].is_string());
    // marker rows are not counted in the run's steps
    let stored =
        ai_run::Entity::find_by_id(run.id.as_str()).one(&database::session()).await.expect("run").expect("row");
    assert_eq!(stored.steps_count, 0);
}

#[tokio::test]
async fn read_output_attach_result_and_delete() {
    let _lock = common::init().await;
    let run = running_run().await;
    let rows: Vec<Value> = (1..=5)
        .map(|i| json!({"kind": "tool", "title": format!("step {i}"), "tool_id": format!("t{i}"), "agent_id": if i % 2 == 0 { json!("a1") } else { Value::Null }}))
        .collect();
    steps::append(&run.id, rows, Extras::default()).await.expect("append");
    let session = database::session();
    let titles = |v: Vec<Value>| v.iter().map(|s| s["title"].as_str().expect("title").to_string()).collect::<Vec<_>>();
    assert_eq!(
        titles(steps::read(&session, &run.id, 0, 200, None, false).await.expect("read")),
        ["step 1", "step 2", "step 3", "step 4", "step 5"]
    );
    assert_eq!(titles(steps::read(&session, &run.id, 2, 2, None, false).await.expect("read")), ["step 3", "step 4"]);
    assert_eq!(titles(steps::read(&session, &run.id, 0, 2, None, true).await.expect("read")), ["step 4", "step 5"]);
    assert_eq!(
        titles(steps::read(&session, &run.id, 0, 10, Some("lead"), false).await.expect("read")),
        ["step 1", "step 3", "step 5"]
    );
    assert_eq!(
        titles(steps::read(&session, &run.id, 0, 10, Some("a1"), false).await.expect("read")),
        ["step 2", "step 4"]
    );

    let mut detail = Map::new();
    detail.insert("exit_code".into(), json!(1));
    assert!(steps::attach_result(&run.id, "t2", Some("boom"), &detail).await.expect("attach"));
    assert!(!steps::attach_result(&run.id, "t_nope", Some("x"), &detail).await.expect("attach"));
    let step = steps::output(&database::session(), &run.id, 2).await.expect("output").expect("a step");
    assert_eq!(
        (step["output"].clone(), step["detail"].clone(), step["has_output"].clone()),
        (json!("boom"), json!({"exit_code": 1}), json!(true))
    );
    assert!(steps::output(&database::session(), &run.id, 99).await.expect("output").is_none());
    assert_eq!(steps::all_rows(&database::session(), &run.id).await.expect("rows").len(), 5);

    let session = database::session();
    steps::delete_for_run(&session, &run.id).await.expect("delete");
    session.commit().await.expect("commit");
    assert!(steps::all_rows(&database::session(), &run.id).await.expect("rows").is_empty());
    assert!(agents_of(&run.id).await.is_empty());
}

#[tokio::test]
async fn the_writer_flushes_after_a_quarter_second_or_on_demand() {
    let _lock = common::init().await;
    let run = running_run().await;
    let writer = StepWriter::new(&run.id);
    let count = || async {
        ai_run_step::Entity::find()
            .filter(ai_run_step::Column::RunId.eq(run.id.as_str()))
            .all(&database::session())
            .await
            .expect("steps")
            .len()
    };
    writer.add(vec![json!({"kind": "text", "title": "one"})], vec![], vec![], Map::new());
    writer.add(vec![json!({"kind": "text", "title": "two"})], vec![], vec![], Map::new());
    assert_eq!(count().await, 0, "nothing is written before the timer");
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert_eq!(count().await, 2, "both rows went in one flush");
    assert_eq!(writer.written(), 2);
    // close writes what is left at once and stops the timer
    writer.add(vec![json!({"kind": "text", "title": "three"})], vec![], vec![], Map::new());
    writer.close().await;
    assert_eq!(count().await, 3);
    // a flush with nothing queued writes nothing
    writer.flush().await;
    assert_eq!(count().await, 3);
    // a batch for a run that is gone is lost without stopping the writer
    let lost = StepWriter::new("run_nope");
    lost.add(vec![json!({"kind": "text"})], vec![], vec![], Map::new());
    lost.close().await;
    assert_eq!(lost.written(), 0);
}
