//! The API's side of the runner process (`services/ai/runner_link.py`), the part of `test_runner.py` that does not start a
//! real runner with a fake CLI (those wait for `runs` and the runner's `main`): commands through `ai_run_command`, the
//! mode switches and the start of the process. The runner started here is this test binary run with `--runner`, which the
//! test harness refuses at once: that is enough to see the process started, logged and noticed.

mod common;

use std::time::{Duration, Instant};

use kb_ai::runner_link;
use kb_db::database;
use kb_db::entities::ai_run_command;
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, EntityTrait, IntoActiveModel};
use serde_json::{Map, Value, json};

async fn fresh() -> tokio::sync::MutexGuard<'static, ()> {
    let lock = common::init().await;
    common::clear::<ai_run_command::Entity>().await;
    runner_link::set_mode(None);
    runner_link::set_in_runner(None);
    runner_link::set_command_wait(8.0);
    runner_link::reset();
    lock
}

#[tokio::test]
async fn the_mode_follows_the_environment_unless_set() {
    let _lock = fresh().await;
    assert_eq!(runner_link::mode(), "inprocess");
    assert!(!runner_link::in_runner());
    runner_link::set_mode(Some("Process"));
    assert_eq!(runner_link::mode(), "process");
    runner_link::set_mode(Some("threads"));
    assert_eq!(runner_link::mode(), "inprocess");
    runner_link::set_in_runner(Some(true));
    assert!(runner_link::in_runner());
    // the runner itself, or the in-process mode, never starts one
    runner_link::set_mode(Some("process"));
    assert!(!runner_link::ensure_started(Some("http://127.0.0.1:1")));
    runner_link::set_in_runner(Some(false));
    runner_link::set_mode(Some("inprocess"));
    assert!(!runner_link::ensure_started(Some("http://127.0.0.1:1")));
    // process mode without a board URL cannot start one either
    runner_link::set_mode(Some("process"));
    assert!(!runner_link::ensure_started(None));
    let status = runner_link::status();
    assert_eq!(
        (status["mode"].clone(), status["alive"].clone(), status["pid"].clone(), status["starts"].clone()),
        (json!("process"), json!(false), Value::Null, json!(0))
    );
    runner_link::set_mode(None);
    runner_link::set_in_runner(None);
}

#[tokio::test]
async fn a_command_without_wait_is_a_row_and_one_with_wait_ends_when_the_runner_took_it() {
    let _lock = fresh().await;
    let mut payload = Map::new();
    payload.insert("by".into(), json!("An"));
    let row = runner_link::command("run_1", "cancel", Some(&payload), false).await.expect("command");
    assert_eq!(
        (row.run_id.as_str(), row.command.as_str(), row.payload.as_str()),
        ("run_1", "cancel", "{\"by\": \"An\"}")
    );
    assert!(row.taken_at.is_none());
    let none = runner_link::command("run_2", "wake", None, false).await.expect("command");
    assert_eq!(none.payload, "{}");

    // the runner takes the command while the API waits for it
    let waiting = tokio::spawn(async { runner_link::command("run_3", "message", None, true).await.expect("command") });
    let started = Instant::now();
    loop {
        let rows = ai_run_command::Entity::find().all(&database::session()).await.expect("commands");
        if let Some(mine) = rows.into_iter().find(|r| r.run_id == "run_3") {
            let s = database::session();
            let mut taken = mine.into_active_model();
            taken.taken_at = Set(Some(kb_base::time::now_iso()));
            taken.update(&s).await.expect("update");
            s.commit().await.expect("commit");
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(5), "the command row never appeared");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let done = waiting.await.expect("task");
    assert!(done.taken_at.is_some());
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn the_api_defers_a_command_to_the_runner_and_gives_up_waiting() {
    let _lock = fresh().await;
    // COMMAND_WAIT_S = 0.3: nothing runs the command here, so it comes back untaken
    runner_link::set_command_wait(0.3);
    let started = Instant::now();
    let row = runner_link::command("run_x", "cancel", None, true).await.expect("command");
    assert!(row.taken_at.is_none());
    assert!(started.elapsed() >= Duration::from_millis(300) && started.elapsed() < Duration::from_secs(3));
    runner_link::set_command_wait(8.0);
}

#[tokio::test]
async fn the_runner_is_this_executable_started_with_the_runner_flag_and_logged() {
    let _lock = fresh().await;
    runner_link::set_mode(Some("process"));
    assert!(runner_link::ensure_started(Some("http://127.0.0.1:1")));
    let log = database::get_data_dir().join("ai-v2").join("runner.log");
    let started = Instant::now();
    while runner_link::alive() && started.elapsed() < Duration::from_secs(10) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // the harness refused `--runner` and the process ended; its words are in the log
    assert!(!runner_link::alive());
    let text = std::fs::read_to_string(&log).expect("the log of the runner");
    assert!(text.contains("runner"), "{text}");
    assert_eq!(runner_link::status()["starts"], json!(1));
    runner_link::stop().await;
    assert_eq!(runner_link::status()["pid"], Value::Null);
    runner_link::set_mode(None);
}

#[test]
fn tokens_are_urlsafe_text_of_the_asked_size() {
    let a = runner_link::token_urlsafe(24);
    let b = runner_link::token_urlsafe(24);
    assert!(a.len() == 32 && a != b);
    assert!(a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    assert!(runner_link::TOKEN.len() == 32);
}
