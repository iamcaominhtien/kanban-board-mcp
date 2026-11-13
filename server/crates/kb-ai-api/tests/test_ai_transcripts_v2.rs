//! The test of `server/tests/test_ai_transcripts_v2.py` that runs a CLI through the routes: a whole v2 run leaves the
//! board's own copy of what it sent and what the CLI printed, secrets masked, compressed at the end. The tests of
//! the file that call `services.ai.transcripts` directly are in `crates/kb-ai/tests/test_ai_transcripts_v2.rs`.
//!
//! The Python file reads the transcript with `transcripts.read` and the file with `gzip`; here the folder of the
//! runs (`KANBAN_AI_RUNS_DIR`) is the test's own, and `kb_ai::transcripts::read_lines` reads the file the server wrote.

// Unix only: it starts shell scripts, makes files executable or links them (Windows CI only compiles the tests).
#![cfg(unix)]

mod common;

use std::path::Path;
use std::time::Duration;

use common::{project, runner, scalar, sign_in, start, ticket, wait_run};
use serde_json::{Value, json};

#[tokio::test]
async fn test_a_full_v2_run_leaves_a_masked_compressed_transcript() {
    let runs = tempfile::Builder::new().prefix("kb-ai-runs-dir-").tempdir().expect("temporary folder");
    let dir = runs.path().join("ai-runs");
    let extra = [("FAKE_CLAUDE_MODE", "v2"), ("KANBAN_AI_RUNS_DIR", dir.to_str().expect("a path"))];
    let Some(f) = start("test_a_full_v2_run_leaves_a_masked_compressed_transcript", true, &extra).await else {
        return;
    };
    sign_in(&f);
    let c = &f.c;
    let (pid, _) = project(c).await;
    let team = runner(&f, &pid, "Claude Code · Backend", json!({})).await;
    let tid = ticket(c, &pid, "Fix add()", "todo").await;
    c.patch(&format!("/tickets/{tid}"), json!({"assignee": team["id"]})).await.assert_status(200);
    let run = wait_run(c, &tid, &["finished"]).await;
    let run_id = run["id"].as_str().expect("run id").to_string();
    let end = tokio::time::Instant::now() + Duration::from_secs(5);
    let row = loop {
        let row = scalar(
            &f.server,
            "SELECT json_object('path', path, 'ended_at', ended_at, 'events', events) \
             FROM ai_run_transcript WHERE run_id = ?",
            &[json!(run_id)],
        )
        .await;
        if row.is_object() && !row["ended_at"].is_null() {
            break row;
        }
        assert!(tokio::time::Instant::now() < end, "the transcript never ended: {row}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let path = row["path"].as_str().expect("path");
    assert!(path.ends_with(".jsonl.gz"), "{path}");
    let recs = kb_ai::transcripts::read_lines(Path::new(path));
    assert!(recs[0]["k"] == "sent" && recs[0]["prompt"].is_string() && recs[0]["system"].is_string());
    assert!(recs.iter().any(|r| r["k"] == "event" && r["e"]["type"] == "result"));
    let events = row["events"].as_i64().expect("events");
    assert!(recs.len() as i64 == events && events >= 5, "{} {events}", recs.len());
    let raw = recs.iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
    assert!(!raw.replace("kbr_••••", "").contains("kbr_"));
}
