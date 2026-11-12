//! The audit trail (`services/ai/audit.py`: `record`, the only part v2 calls) and the project's settings column
//! (`services/ai/ops.py`), in one process with its own database. The two Python tests that go through HTTP routes and a
//! team's run (`test_creating_a_team_and_running_it_leave_audit_entries`, `test_the_settings_route_saves_ops_and_reads_them_back`)
//! wait for `teams`, `runs` and the REST routes. The rest of `audit` (chain check, filters, trace, retention) has no
//! Python test of its own; `audit_chain_filters_trace_and_retention` covers it here.

mod common;

use kb_ai::audit::{self, Entry, Filters};
use kb_ai::ops;
use kb_base::{activity, ctx};
use kb_db::database;
use kb_db::entities::{ai_audit, ai_project_settings};
use kb_db::sea_orm::{ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde_json::{Value, json};

async fn entries(project_id: &str) -> Vec<ai_audit::Model> {
    let session = database::session();
    ai_audit::Entity::find()
        .filter(ai_audit::Column::ProjectId.eq(project_id))
        .order_by_asc(ai_audit::Column::Seq)
        .all(&session)
        .await
        .expect("entries")
}

async fn record(project_id: &str, action: &str) -> ai_audit::Model {
    audit::record(project_id, action, "info", Entry::default()).await.expect("record")
}

#[tokio::test]
async fn test_entries_are_chained_by_hash_and_numbered() {
    let _lock = common::init().await;
    common::clear::<ai_audit::Entity>().await;
    let (pid, _) = common::project().await;
    let a = audit::record(
        &pid,
        "x_one",
        "info",
        Entry { member_name: "Team".into(), target: Some("KAN-1".into()), ..Entry::default() },
    )
    .await
    .expect("record");
    let b = audit::record(&pid, "x_two", "info", Entry { on_behalf_of: Some("An Nguyen".into()), ..Entry::default() })
        .await
        .expect("record");
    assert_eq!((a.seq, b.seq), (1, 2));
    assert!(a.prev_hash.is_empty() && !a.hash.is_empty());
    assert_eq!(b.prev_hash, a.hash);
    assert_ne!(b.hash, a.hash);
    let rows = entries(&pid).await;
    assert_eq!(rows.iter().map(|r| r.action.as_str()).collect::<Vec<_>>(), ["x_one", "x_two"]);
    assert_eq!(rows[1].on_behalf_of.as_deref(), Some("An Nguyen"));
    assert_eq!(rows[0].target.as_deref(), Some("KAN-1"));
}

#[tokio::test]
async fn test_concurrent_records_keep_one_unbroken_chain() {
    let _lock = common::init().await;
    common::clear::<ai_audit::Entity>().await;
    let (pid, _) = common::project().await;
    let futs: Vec<_> = (0..8)
        .map(|i| {
            let pid = pid.clone();
            async move { record(&pid, &format!("a{i}")).await }
        })
        .collect();
    let results = futures_join(futs).await;
    assert_eq!(results.len(), 8);
    let rows = entries(&pid).await;
    assert_eq!(rows.iter().map(|r| r.seq).collect::<Vec<_>>(), (1..=8).collect::<Vec<i32>>());
    for pair in rows.windows(2) {
        assert_eq!(pair[1].prev_hash, pair[0].hash);
    }
}

/// `asyncio.gather` of futures started together.
async fn futures_join<T: Send + 'static>(futs: Vec<impl std::future::Future<Output = T> + Send + 'static>) -> Vec<T> {
    let handles: Vec<_> = futs.into_iter().map(tokio::spawn).collect();
    let mut out = Vec::new();
    for h in handles {
        out.push(h.await.expect("task"));
    }
    out
}

#[tokio::test]
async fn test_secrets_in_the_detail_are_masked_before_saving() {
    let _lock = common::init().await;
    let (pid, _) = common::project().await;
    let token = format!("ghp_{}", "a1B2c3D4e5F6g7H8");
    let mut detail = serde_json::Map::new();
    detail.insert("note".into(), json!(format!("used {token} here")));
    detail.insert("api_key".into(), json!("plain-value"));
    detail.insert("n".into(), json!(3));
    let entry = audit::record(&pid, "x_secret", "info", Entry { detail, ..Entry::default() }).await.expect("record");
    assert!(!entry.detail.contains(&token) && !entry.detail.contains("plain-value"));
    let stored: Value = serde_json::from_str(&entry.detail).expect("json");
    assert!(stored["note"].as_str().expect("text").contains("gh_") && stored["n"] == json!(3));
    assert!(stored["api_key"].as_str().expect("text").contains("••••"));
}

#[tokio::test]
async fn test_an_mcp_origin_is_noted_in_the_detail() {
    let _lock = common::init().await;
    let (pid, _) = common::project().await;
    let (entry, own) = ctx::scope(async {
        let token = activity::set_origin(Some("mcp"));
        let mut a = serde_json::Map::new();
        a.insert("a".into(), json!(1));
        let entry =
            audit::record(&pid, "x_mcp", "info", Entry { detail: a, ..Entry::default() }).await.expect("record");
        let mut v = serde_json::Map::new();
        v.insert("via".into(), json!("kept"));
        let own = audit::record(&pid, "x_own", "info", Entry { detail: v, ..Entry::default() }).await.expect("record");
        ctx::reset(token);
        (entry, own)
    })
    .await;
    assert_eq!(serde_json::from_str::<Value>(&entry.detail).expect("json"), json!({"a": 1, "via": "mcp"}));
    assert_eq!(serde_json::from_str::<Value>(&own.detail).expect("json")["via"], json!("kept"));
}

#[test]
fn test_get_reads_the_defaults_for_a_project_that_never_set_any() {
    let mut out = ops::get(None);
    assert_eq!(out["worktrees"]["on"], json!(false));
    assert_eq!(out["live_messages"], json!(true));
    assert_eq!(ops::get(Some(&common::settings_model("p", Some("not json")))), out);
    assert_eq!(ops::get(Some(&common::settings_model("p", Some("[1, 2]")))), out);
    // a copy: the defaults are not touched
    out["worktrees"]["on"] = json!(true);
    assert_eq!(ops::defaults()["worktrees"]["on"], json!(false));
}

#[test]
fn test_update_merges_nested_keys_and_ignores_unknown_ones() {
    let mut s = common::settings_model("p", None);
    let patch = |v: Value| v.as_object().expect("object").clone();
    ops::update(&mut s, &patch(json!({"worktrees": {"on": true, "prepare": "uv sync"}, "bogus": 1})));
    let full = ops::update(&mut s, &patch(json!({"worktrees": {"base_port": 6000}, "live_messages": false})));
    assert_eq!(full["worktrees"]["on"], json!(true));
    assert_eq!(full["worktrees"]["prepare"], json!("uv sync"));
    assert_eq!(full["worktrees"]["base_port"], json!(6000));
    assert_eq!(full["live_messages"], json!(false));
    // a default under the stored keys
    assert_eq!(full["worktrees"]["handover"], json!("auto"));
    let stored: Value = serde_json::from_str(&s.ops).expect("json");
    assert!(stored.get("bogus").is_none() && stored["worktrees"]["base_port"] == json!(6000));
    // only what was set is stored
    assert!(stored["worktrees"].get("handover").is_none());
}

#[test]
fn test_update_recovers_from_a_corrupt_column() {
    let mut s = common::settings_model("p", Some("{broken"));
    let patch = json!({"env_path": ["/opt/bin"]}).as_object().expect("object").clone();
    assert_eq!(ops::update(&mut s, &patch)["env_path"], json!(["/opt/bin"]));
    assert_eq!(serde_json::from_str::<Value>(&s.ops).expect("json"), json!({"env_path": ["/opt/bin"]}));
}

#[tokio::test]
async fn ops_are_saved_in_the_settings_row_and_read_back() {
    let _lock = common::init().await;
    let (pid, _) = common::project().await;
    let session = database::session();
    let settings = kb_ai::store::get_settings(&session, &pid).await.expect("settings");
    assert_eq!(settings.ops, "{}");
    let mut settings = settings;
    let patch = json!({"commands": {"test": "pytest -q"}, "nope": true}).as_object().expect("object").clone();
    ops::update(&mut settings, &patch);
    let mut row: ai_project_settings::ActiveModel = settings.clone().into();
    row.ops = Set(settings.ops.clone());
    row.update(&session).await.expect("update");
    session.commit().await.expect("commit");
    let again = kb_ai::store::get_settings(&database::session(), &pid).await.expect("settings");
    assert_eq!(ops::get(Some(&again))["commands"], json!({"test": "pytest -q", "lint": "", "build": ""}));
    assert_eq!(serde_json::from_str::<Value>(&again.ops).expect("json"), json!({"commands": {"test": "pytest -q"}}));
}

#[tokio::test]
async fn audit_chain_filters_trace_and_retention() {
    let _lock = common::init().await;
    common::clear::<ai_audit::Entity>().await;
    let (pid, _) = common::project().await;
    let (m, _t) = common::team(&pid, "Dev team", common::TeamOpts::default()).await;
    let tk = common::ticket(&pid, "Fix", "todo").await;
    let run = common::run(&pid, &m.id, Some(&tk.id), "running", |r| {
        r.number = Set(4);
        r.trigger = Set("assign".into());
        r.started_by = Set("An Nguyen".into());
        r.metered = Set(true);
        r.cost_usd = Set(0.123_456_5);
    })
    .await;
    let mut detail = serde_json::Map::new();
    detail.insert("tool".into(), json!("manage_ticket"));
    detail.insert("op".into(), json!("update"));
    detail.insert("source".into(), json!({"comment_id": "c1", "author": "stranger"}));
    detail.insert("key".into(), json!("sk-ant-abcdefgh12345"));
    let one = audit::record(
        &pid,
        "tool_call",
        "allowed",
        Entry {
            member_id: Some(m.id.clone()),
            run_id: Some(run.id.clone()),
            target: Some("KAN-9".into()),
            detail,
            ..Entry::default()
        },
    )
    .await
    .expect("record");
    let two = audit::record(
        &pid,
        "injection_detected",
        "blocked",
        Entry { on_behalf_of: Some("An Nguyen".into()), ..Entry::default() },
    )
    .await
    .expect("record");
    let three = audit::record(&pid, "x_other", "approved", Entry::default()).await.expect("record");

    let session = database::session();
    assert_eq!(
        audit::verify_chain(&session).await.expect("chain"),
        json!({"ok": true, "broken_at": null, "checked": 3}).as_object().expect("object").clone()
    );

    let all = audit::list_entries(&session, &pid, &Filters::default(), 100, None).await.expect("list");
    assert_eq!(all.iter().map(|e| e.seq).collect::<Vec<_>>(), [3, 2, 1], "newest first");
    let by = |f: Filters| {
        let (session, pid) = (&session, &pid);
        async move {
            audit::list_entries(session, pid, &f, 100, None)
                .await
                .expect("list")
                .iter()
                .map(|e| e.seq)
                .collect::<Vec<_>>()
        }
    };
    assert_eq!(by(Filters { member_id: Some(m.id.clone()), ..Filters::default() }).await, [1]);
    assert_eq!(by(Filters { result: Some("blocked".into()), ..Filters::default() }).await, [2]);
    assert_eq!(by(Filters { run_id: Some(run.id.clone()), ..Filters::default() }).await, [1]);
    assert_eq!(by(Filters { q: Some(" kan-9 ".into()), ..Filters::default() }).await, [1]);
    assert_eq!(by(Filters { actions: vec!["x_other".into(), "tool_call".into()], ..Filters::default() }).await, [3, 1]);
    assert_eq!(by(Filters { on_behalf_of: Some("An Nguyen".into()), ..Filters::default() }).await, [2]);
    assert_eq!(by(Filters { since: Some(two.created_at.clone()), ..Filters::default() }).await.first(), Some(&3));
    assert_eq!(by(Filters { until: Some(two.created_at.clone()), ..Filters::default() }).await, [1]);
    assert_eq!(audit::list_entries(&session, &pid, &Filters::default(), 100, Some(3)).await.expect("list").len(), 2);
    assert_eq!(
        audit::list_entries(&session, &pid, &Filters::default(), 0, None).await.expect("list").len(),
        1,
        "a limit is at least 1"
    );
    let counts =
        audit::count_results(&session, &pid, &Filters { result: Some("blocked".into()), ..Filters::default() })
            .await
            .expect("counts");
    assert_eq!(
        Value::Object(counts),
        json!({"allowed": 1, "approved": 1, "blocked": 1}),
        "the result filter is not applied to the counters"
    );

    let rich = audit::enrich(&session, std::slice::from_ref(&one)).await.expect("enrich");
    assert_eq!(rich[0]["run_number"], json!(4));
    assert_eq!(rich[0]["run_cost"], json!(0.1235));
    // the detail is stored as `json.dumps` writes it, with `\u2022` for the bullets, so the count of literal bullets is 0
    // (what the Python function gives too)
    assert!(one.detail.contains("sk-\\u2022\\u2022\\u2022\\u2022"));
    assert_eq!(rich[0]["redactions"], json!(0));
    assert_eq!(audit::redaction_count(&one), 0);
    let trace = audit::trace(&session, &one).await.expect("trace");
    let texts: Vec<&str> = trace.iter().map(|s| s["text"].as_str().expect("text")).collect();
    assert_eq!(texts[0], format!("An Nguyen assigned {}", tk.id));
    assert_eq!(texts[1], format!("Run #4 read the {} description", tk.id));
    assert_eq!(texts[2], "It also read a flagged comment (stranger)");
    assert_eq!(texts[3], "Called manage_ticket.update");
    assert_eq!(trace[3]["chip"], json!("Allowed"));
    assert_eq!(audit::trace(&session, &two).await.expect("trace")[0]["chip"], json!("Blocked"));
    assert_eq!(
        audit::trace(&session, &three).await.expect("trace")[0],
        json!({"text": "x_other", "trust": null, "chip": "Approval"})
    );

    // a row edited behind the board's back breaks the chain at that row
    let mut forged: ai_audit::ActiveModel = two.clone().into();
    forged.result = Set("allowed".into());
    forged.update(&session).await.expect("update");
    session.commit().await.expect("commit");
    let broken = audit::verify_chain(&database::session()).await.expect("chain");
    assert_eq!(broken["ok"], json!(false));
    assert_eq!(broken["broken_at"], json!(two.id));

    // retention: nothing is removed while no project has a retention; then entries older than it go from the start of the
    // chain, blocked ones stay a year at least
    assert_eq!(audit::prune().await.expect("prune"), 0, "the project settings were never created");
    let settings = kb_ai::store::get_settings(&session, &pid).await.expect("settings");
    assert_eq!(settings.audit_retention_days, Some(90));
    let later = chrono::Utc::now() + chrono::Duration::days(100);
    assert_eq!(audit::prune_at(later).await.expect("prune"), 1, "the first entry is old enough, the blocked one stays");
    assert_eq!(entries(&pid).await.iter().map(|e| e.seq).collect::<Vec<_>>(), [2, 3]);
    let much_later = chrono::Utc::now() + chrono::Duration::days(400);
    assert_eq!(audit::prune_at(much_later).await.expect("prune"), 2);
}
