//! The board's own copy of every CLI run (`services/ai/transcripts.py`): what it sent, what the CLI printed, secrets
//! masked, compressed when the run ends, the skills and subagents counted, and the search document written at the end.
//! `test_a_full_v2_run_leaves_a_masked_compressed_transcript` runs a fake CLI through the REST routes and waits for
//! `runs`. `retention_pins_usage_and_the_search_index` covers `pin`, `prune`, `usage` and `search_ids`, which have no
//! Python test of their own.

mod common;

use std::io::Read;
use std::path::Path;

use kb_ai::transcripts::{self, Begin};
use kb_db::database;
use kb_db::entities::{ai_run, ai_run_transcript, ai_skill_use};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, IntoActiveModel, QueryFilter};
use kb_db::sql::statement;
use serde_json::{Value, json};

/// `_run_row(env, state, **extra)`: a team's run; `edit` sets the extra columns.
async fn run_row(edit: impl FnOnce(&mut ai_run::ActiveModel)) -> ai_run::Model {
    let (pid, _) = common::project().await;
    let (team, _) = common::team(&pid, "Claude Code · Backend", common::TeamOpts::default()).await;
    common::run(&pid, &team.id, None, "running", edit).await
}

async fn begin<'a>(run: &'a ai_run::Model, edit: impl FnOnce(&mut Begin<'a>)) {
    let mut b = Begin {
        project_id: &run.project_id,
        member_id: &run.member_id,
        system: Some("You are the lead."),
        prompt: Some("Fix add()"),
        ..Begin::default()
    };
    edit(&mut b);
    transcripts::begin(&run.id, b).await.expect("begin");
}

fn assistant(blocks: Value) -> String {
    json!({"type": "assistant", "message": {"content": blocks}}).to_string()
}

async fn row(run_id: &str) -> Option<ai_run_transcript::Model> {
    ai_run_transcript::Entity::find_by_id(run_id).one(&database::session()).await.expect("row")
}

fn gunzip(path: &str) -> String {
    let mut text = String::new();
    flate2::read::GzDecoder::new(std::fs::File::open(path).expect("file")).read_to_string(&mut text).expect("gzip");
    text
}

async fn fresh() -> tokio::sync::MutexGuard<'static, ()> {
    let lock = common::init().await;
    transcripts::set_root(Some(&common::folder().join("ai-runs")));
    transcripts::clear_open();
    lock
}

#[tokio::test]
async fn test_a_run_is_written_line_by_line_then_compressed_and_read_back() {
    let _lock = fresh().await;
    let run = run_row(|_| {}).await;
    begin(&run, |b| {
        b.session_id = Some("sess1");
        b.started_at = Some("2026-03-15T10:00:00+00:00");
    })
    .await;
    let r = row(&run.id).await.expect("row");
    assert!(r.path.ends_with(&format!("2026-03/{}.jsonl", run.id)) && r.ended_at.is_none());
    transcripts::feed(&run.id, &assistant(json!([{"type": "text", "text": "Working on it"}])));
    transcripts::feed(&run.id, "plain stderr-like line");
    transcripts::feed(&run.id, "   ");
    let mut data = serde_json::Map::new();
    data.insert("by".into(), json!("An Nguyen"));
    transcripts::note(&run.id, "message", "An Nguyen wrote: hurry", Some(&data));
    let live = transcripts::read(&run.id).await.expect("read").expect("records");
    let kinds = |recs: &[Value]| recs.iter().map(|r| r["k"].as_str().expect("kind").to_string()).collect::<Vec<_>>();
    assert_eq!(kinds(&live), ["sent", "event", "text", "note"]);
    assert!(live[0]["prompt"] == json!("Fix add()") && live[0]["session_id"] == json!("sess1"));
    assert!(live[3]["kind"] == json!("message") && live[3]["by"] == json!("An Nguyen"));

    transcripts::finish(&run.id).await;
    let r = row(&run.id).await.expect("row");
    assert!(r.path.ends_with(".jsonl.gz") && r.ended_at.is_some() && r.events == 4);
    let size = std::fs::metadata(&r.path).expect("file").len();
    assert!(i64::from(r.bytes) == size as i64 && size > 0);
    // the plain file is gone
    assert!(!Path::new(&r.path[..r.path.len() - 3]).exists());
    assert_eq!(gunzip(&r.path).lines().count(), 4);
    let again = transcripts::read(&run.id).await.expect("read").expect("records");
    assert_eq!(kinds(&again), ["sent", "event", "text", "note"]);
    assert!(!transcripts::is_open(&run.id));
}

#[tokio::test]
async fn test_secrets_are_masked_in_every_part_and_long_text_is_cut() {
    let _lock = fresh().await;
    let run = run_row(|_| {}).await;
    let planted_key = format!("sk-ant-{}", "abcdefgh12345678");
    let planted_run = format!("kbr_{}", "Zz9Yy8Xx7Ww6");
    let mcp = json!({"mcpServers": {"board": {
        "url": "http://x",
        "headers": {"Authorization": format!("Bearer {planted_run}")},
        "env": {"DB": "postgres://u:pw@h/db"},
    }}})
    .to_string();
    let note = format!("note with {planted_key}");
    let system = format!("key {planted_key}");
    let args: Vec<String> = [
        "-p".to_string(),
        "the whole prompt".into(),
        "--model".into(),
        "haiku".into(),
        "--mcp-config".into(),
        mcp,
        "--append-system-prompt".into(),
        format!("x {planted_key}"),
    ]
    .to_vec();
    begin(&run, |b| {
        b.system = Some(&system);
        b.prompt = Some("do it");
        b.note = Some(&note);
        b.args = &args;
    })
    .await;
    transcripts::feed(&run.id, &assistant(json!([{"type": "text", "text": format!("I saw {planted_key}")}])));
    transcripts::feed(&run.id, &format!("raw {planted_run}"));
    transcripts::note(&run.id, "diagnosis", &format!("saw {planted_key}"), None);
    transcripts::feed(&run.id, &assistant(json!([{"type": "text", "text": "y".repeat(transcripts::MAX_TEXT + 500)}])));
    transcripts::finish(&run.id).await;
    let raw = gunzip(&row(&run.id).await.expect("row").path);
    assert!(!raw.contains(&planted_key) && !raw.contains(&planted_run) && !raw.contains("postgres://u:pw"));
    let sent: Value = serde_json::from_str(raw.lines().next().expect("a line")).expect("json");
    let args: Vec<&str> = sent["args"].as_array().expect("args").iter().map(|a| a.as_str().expect("text")).collect();
    let after = |flag: &str| args[args.iter().position(|a| *a == flag).expect("flag") + 1];
    assert_eq!(after("-p"), "<recorded above>");
    assert_eq!(after("--append-system-prompt"), "<recorded above>");
    assert_eq!(after("--model"), "haiku");
    let cfg: Value = serde_json::from_str(after("--mcp-config")).expect("json");
    assert_eq!(cfg["mcpServers"]["board"]["env"], json!({"DB": "••••••••"}));
    assert_eq!(cfg["mcpServers"]["board"]["headers"], json!({"Authorization": "••••••••"}));
    assert!(raw.contains("500 more characters not kept"));
}

#[tokio::test]
async fn test_begin_after_a_restart_appends_and_after_the_end_does_nothing() {
    let _lock = fresh().await;
    let run = run_row(|_| {}).await;
    begin(&run, |b| b.prompt = Some("first")).await;
    transcripts::feed(&run.id, &assistant(json!([{"type": "text", "text": "one"}])));
    // a restart inside the run: the open file keeps growing and says it resumed
    begin(&run, |b| {
        b.prompt = Some("second");
        b.resume = true;
    })
    .await;
    let recs = transcripts::read(&run.id).await.expect("read").expect("records");
    assert_eq!(recs.iter().map(|r| r["k"].as_str().expect("kind")).collect::<Vec<_>>(), ["sent", "event", "sent"]);
    assert!(recs[2]["resume"] == json!(true) && recs[2]["prompt"] == json!("second"));
    transcripts::finish(&run.id).await;
    let before = row(&run.id).await.expect("row").events;
    // a late start for a run that ended must not reopen the compressed transcript
    begin(&run, |b| b.prompt = Some("late")).await;
    assert!(!transcripts::is_open(&run.id));
    assert_eq!(row(&run.id).await.expect("row").events, before);
    assert_eq!(before, 3);
    assert_eq!(transcripts::read(&run.id).await.expect("read").expect("records").len(), 3);
}

#[tokio::test]
async fn test_feed_and_note_for_a_run_that_was_never_opened_are_ignored() {
    let _lock = fresh().await;
    transcripts::feed("run_nope", "{}");
    transcripts::note("run_nope", "x", "y", None);
    assert!(transcripts::read("run_nope").await.expect("read").is_none());
    // nothing to settle: no error
    transcripts::finish("run_nope").await;
}

#[tokio::test]
async fn test_skills_and_subagents_used_are_recorded_when_the_run_ends() {
    let _lock = fresh().await;
    let run = run_row(|_| {}).await;
    begin(&run, |_| {}).await;
    let tool = |name: &str, input: Value| assistant(json!([{"type": "tool_use", "name": name, "input": input}]));
    transcripts::feed(&run.id, &tool("Skill", json!({"skill": "tdd:red-green"})));
    transcripts::feed(&run.id, &tool("Task", json!({"subagent_type": "reviewer"})));
    transcripts::feed(&run.id, &tool("Agent", json!({})));
    transcripts::feed(&run.id, &tool("Bash", json!({"command": "ls"})));
    transcripts::feed(&run.id, &json!({"type": "assistant", "message": "plain text, not a dict"}).to_string());
    transcripts::finish(&run.id).await;
    let uses = ai_skill_use::Entity::find()
        .filter(ai_skill_use::Column::RunId.eq(run.id.as_str()))
        .all(&database::session())
        .await
        .expect("uses");
    let mut got: Vec<(String, String, Option<String>)> =
        uses.iter().map(|u| (u.kind.clone(), u.name.clone(), u.plugin.clone())).collect();
    got.sort();
    assert_eq!(
        got,
        [
            ("skill".to_string(), "tdd:red-green".to_string(), Some("tdd".to_string())),
            ("subagent".to_string(), "general-purpose".to_string(), None),
            ("subagent".to_string(), "reviewer".to_string(), None),
        ]
    );
    assert!(uses.iter().all(|u| u.member_id.as_deref() == Some(run.member_id.as_str())));
}

async fn fts_body(run_id: &str) -> Option<String> {
    let session = database::session();
    let found = session
        .query_one_raw(statement(
            session.get_database_backend(),
            "SELECT body FROM ai_run_fts WHERE run_id = ?",
            [run_id.into()],
        ))
        .await
        .expect("query")?;
    Some(found.try_get_by_index::<String>(0).expect("text"))
}

#[tokio::test]
async fn test_the_search_document_holds_what_the_run_said_and_ran() {
    let _lock = fresh().await;
    let run = run_row(|r| {
        r.summary = Set(Some("Fixed the adder".into()));
        r.question = Set(Some(json!({"text": "Which rounding mode?"}).to_string()));
        r.files = Set(json!([{"path": "calc.py"}]).to_string());
    })
    .await;
    begin(&run, |_| {}).await;
    transcripts::feed(
        &run.id,
        &assistant(json!([
            {"type": "text", "text": "Investigating the subtraction bug"},
            {"type": "tool_use", "name": "Bash", "input": {"command": "pytest -q"}},
        ])),
    );
    transcripts::feed(
        &run.id,
        &json!({"type": "user", "message": {"content": [{"type": "tool_result", "is_error": true, "content": [{"type": "text", "text": "AssertionError boom"}]}]}})
            .to_string(),
    );
    transcripts::note(&run.id, "restart", "restarted after crash", None);
    transcripts::finish(&run.id).await;
    let body = fts_body(&run.id).await.expect("an indexed run");
    for piece in [
        "Fixed the adder",
        "Which rounding mode?",
        "calc.py",
        "subtraction bug",
        "pytest -q",
        "AssertionError boom",
        "restarted after crash",
    ] {
        assert!(body.contains(piece), "{piece}");
    }
}

#[test]
fn test_content_of_and_blocks_of_skip_events_without_content() {
    let ev = json!({"message": {"content": [{"type": "text", "text": "a"}, "stray", 3]}});
    assert_eq!(transcripts::content_of(&ev), Some(&ev["message"]["content"]));
    assert_eq!(
        transcripts::blocks_of(&ev).into_iter().map(|b| Value::Object(b.clone())).collect::<Vec<_>>(),
        [json!({"type": "text", "text": "a"})]
    );
    let text = json!({"message": {"content": "just text"}});
    assert_eq!(transcripts::content_of(&text), Some(&json!("just text")));
    assert!(transcripts::blocks_of(&text).is_empty());
    for odd in [Value::Null, json!("x"), json!({}), json!({"message": "x"}), json!({"message": {"content": 5}})] {
        assert!(transcripts::content_of(&odd).is_none() && transcripts::blocks_of(&odd).is_empty(), "{odd}");
    }
}

#[tokio::test]
async fn test_a_deleted_transcript_reads_as_none() {
    let _lock = fresh().await;
    let run = run_row(|_| {}).await;
    begin(&run, |_| {}).await;
    transcripts::finish(&run.id).await;
    let session = database::session();
    let mut r = row(&run.id).await.expect("row").into_active_model();
    r.deleted_at = Set(Some("2026-01-01T00:00:00+00:00".into()));
    r.update(&session).await.expect("update");
    session.commit().await.expect("commit");
    assert!(transcripts::read(&run.id).await.expect("read").is_none());
}

#[tokio::test]
async fn retention_pins_usage_and_the_search_index() {
    let _lock = fresh().await;
    common::clear::<ai_run_transcript::Entity>().await;
    let old = run_row(|r| r.summary = Set(Some("Rotated the signing keys".into()))).await;
    let pinned = run_row(|r| r.summary = Set(Some("Rotated the signing keys too".into()))).await;
    let recent = run_row(|r| r.summary = Set(Some("Unrelated".into()))).await;
    for run in [&old, &pinned, &recent] {
        begin(run, |_| {}).await;
        transcripts::feed(&run.id, &assistant(json!([{"type": "text", "text": "Đăng nhập works"}])));
        transcripts::finish(&run.id).await;
    }
    let usage = transcripts::usage().await.expect("usage");
    assert_eq!((usage["runs"].as_i64(), usage["pinned"].as_i64()), (Some(3), Some(0)));
    assert!(usage["bytes"].as_i64().expect("bytes") > 0);

    let session = database::session();
    let found =
        transcripts::search_ids(&session, "signing  KEYS", 500, None).await.expect("search").expect("the index works");
    assert_eq!(found.len(), 2);
    assert!(found.contains(&old.id) && found.contains(&pinned.id));
    let one =
        transcripts::search_ids(&session, "signing", 500, Some(&old.project_id)).await.expect("search").expect("index");
    assert_eq!(one, std::slice::from_ref(&old.id), "only the project's runs count, inside the query");
    assert_eq!(transcripts::search_ids(&session, "---", 500, None).await.expect("search"), Some(vec![]));
    assert_eq!(
        transcripts::search_ids(&session, "dang\u{323} nhap", 500, None).await.expect("search").map(|v| v.len()),
        Some(0)
    );
    // `remove_diacritics 2` folds the marks (ă, ậ) but not the stroke of Đ
    let diacritics = transcripts::search_ids(&session, "Đang nhap", 500, None).await.expect("search").expect("index");
    assert_eq!(diacritics.len(), 3);
    transcripts::set_fts_broken(true);
    assert_eq!(
        transcripts::search_ids(&session, "signing", 500, None).await.expect("search"),
        None,
        "the caller scans"
    );
    transcripts::set_fts_broken(false);

    let pin = transcripts::pin(&pinned.id, true, "An Nguyen").await.expect("pin").expect("row");
    assert!(pin.pinned && pin.pinned_by.as_deref() == Some("An Nguyen"));
    assert!(transcripts::pin("run_nope", true, "x").await.expect("pin").is_none());
    assert_eq!(transcripts::usage().await.expect("usage")["pinned"], json!(1));
    // everything ended a moment ago: a retention of 90 days keeps all, 0 days removes all but the pinned one
    assert_eq!(transcripts::prune(90, None).await.expect("prune"), 0);
    let later = chrono::Utc::now() + chrono::Duration::days(1);
    assert_eq!(transcripts::prune(0, Some(later)).await.expect("prune"), 2);
    let gone = row(&old.id).await.expect("row");
    assert!(gone.deleted_at.is_some() && gone.bytes == 0 && !Path::new(&gone.path).exists());
    assert!(transcripts::read(&old.id).await.expect("read").is_none());
    assert!(transcripts::read(&pinned.id).await.expect("read").is_some());
    assert_eq!(transcripts::usage().await.expect("usage")["runs"], json!(1));
}
