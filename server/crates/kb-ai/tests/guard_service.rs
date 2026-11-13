//! `guard` (run tokens, chat tokens, the run a task acts for, duplicate-write suppression after a resume), `comment_view`,
//! `store` and the hooks other crates declare, in one process with its own database. Python's tests reach these through
//! the routes and the MCP tools (`test_ai_runs_v2.py`, `test_ai_docs_resolve.py`); the cases that need only this crate are here.

mod common;

use kb_ai::context::RunContext;
use kb_ai::{comment_view, guard, hooks, store};
use kb_base::{activity, ctx};
use kb_db::database;
use kb_db::entities::{ai_team, member};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, EntityTrait, IntoActiveModel};
use serde_json::{Map, Value, json};

type ToolError = String;

fn args(v: Value) -> Map<String, Value> {
    v.as_object().expect("object").clone()
}

#[tokio::test]
async fn tokens_find_a_live_run_and_a_dead_one_is_refused() {
    let _lock = common::init().await;
    let token = guard::new_token();
    assert!(token.starts_with("kbr_") && token.len() == 36);
    let (pid, _) = common::project().await;
    let (m, _t) = common::team(&pid, "Dev team", common::TeamOpts::default()).await;
    let tk = common::ticket(&pid, "Fix", "todo").await;
    let run = common::run(&pid, &m.id, Some(&tk.id), "running", |r| {
        r.started_by = Set("An Nguyen".into());
        r.token_hash = Set(Some(guard::token_hash(&token)));
        r.depth = Set(2);
        r.trigger = Set("message".into());
    })
    .await;
    let c = guard::context_for_token(&token).await.expect("a live run");
    assert_eq!(
        c,
        RunContext {
            run_id: run.id.clone(),
            member_id: m.id.clone(),
            member_name: "Dev team".into(),
            project_id: pid.clone(),
            ticket_id: Some(tk.id.clone()),
            on_behalf_of: "An Nguyen".into(),
            mode: "work".into(),
            trigger: "message".into(),
            depth: 2,
            acts_by_tier: false,
        }
    );
    // the team's row notes the last use of its token
    let team = ai_team::Entity::find_by_id(m.id.as_str()).one(&database::session()).await.expect("team").expect("row");
    assert!(team.mcp_last_used_at.is_some());
    // a member that is gone reads as "AI"
    let s = database::session();
    member::Entity::delete_by_id(m.id.as_str()).exec(&s).await.expect("delete");
    s.commit().await.expect("commit");
    assert_eq!(guard::context_for_token(&token).await.expect("context").member_name, "AI");
    // the run ends: its token is dead
    let mut ended = ai_run_model(&run.id).await.into_active_model();
    ended.state = Set("finished".into());
    let s = database::session();
    ended.update(&s).await.expect("update");
    s.commit().await.expect("commit");
    let refused = guard::context_for_token(&token).await.expect_err("a dead token");
    assert_eq!(
        refused.to_string(),
        "This AI run has ended (finished, cancelled or stopped by a person); the board no longer accepts its calls. Stop now."
    );
    assert!(matches!(refused, guard::Error::Action(_)));
    assert!(guard::context_for_token("kbr_never_issued").await.is_err());
}

async fn ai_run_model(id: &str) -> kb_db::entities::ai_run::Model {
    kb_db::entities::ai_run::Entity::find_by_id(id).one(&database::session()).await.expect("run").expect("row")
}

#[tokio::test]
async fn chat_tokens_stand_for_the_asking_context_until_revoked() {
    let _lock = common::init().await;
    let asking = RunContext {
        member_name: "Board AI".into(),
        project_id: "p".into(),
        mode: "ask".into(),
        acts_by_tier: true,
        ..RunContext::default()
    };
    let token = guard::issue_chat_token(asking.clone());
    assert!(token.starts_with("kbr_chat_"));
    assert_eq!(guard::context_for_token(&token).await.expect("context"), asking);
    guard::revoke_chat_token(&token);
    assert!(guard::context_for_token(&token).await.is_err());
}

#[tokio::test]
async fn enter_and_leave_attribute_activity_to_the_ai_and_suspend_acts_as_nobody() {
    let _lock = common::init().await;
    let context = RunContext {
        run_id: "run_1".into(),
        member_id: "m1".into(),
        member_name: "Dev team".into(),
        on_behalf_of: "An Nguyen".into(),
        ..RunContext::default()
    };
    ctx::scope(async {
        assert!(guard::current().is_none() && activity::current_ai().is_none());
        let tokens = guard::enter(&context);
        assert_eq!(guard::current(), Some(context.clone()));
        assert_eq!(activity::current_actor(), "Dev team");
        assert_eq!(
            activity::current_ai(),
            Some(json!({"member_id": "m1", "on_behalf_of": "An Nguyen", "run_id": "run_1", "member_name": "Dev team"}))
        );
        assert!(hooks::in_run());
        let paused = guard::suspend();
        assert!(guard::current().is_none() && activity::current_ai().is_none() && !hooks::in_run());
        guard::leave(paused);
        assert!(guard::current().is_some());
        guard::leave(tokens);
        assert!(guard::current().is_none() && activity::current_ai().is_none());
        assert_eq!(activity::current_actor(), "user");
        assert_eq!(guard::resolve().await.expect("resolve"), None);
    })
    .await;
}

#[tokio::test]
async fn resolve_reads_the_bearer_token_of_the_request_and_ignores_other_clients() {
    let _lock = common::init().await;
    let token = guard::new_token();
    let (pid, _) = common::project().await;
    let (m, _t) = common::team(&pid, "Dev team", common::TeamOpts::default()).await;
    common::run(&pid, &m.id, None, "running", |r| r.token_hash = Set(Some(guard::token_hash(&token)))).await;
    assert_eq!(guard::request_token_of(&format!("Bearer {token}")), Some(token.clone()));
    assert_eq!(guard::request_token_of(&format!("bearer {token} ")), Some(token.clone()));
    assert_eq!(guard::request_token_of("Bearer sk-other"), None);
    assert_eq!(guard::request_token_of("Basic kbr_x"), None);
    ctx::scope(async {
        let header = format!("Bearer {token}");
        let t = guard::set_request_authorization(Some(&header));
        let context = guard::resolve().await.expect("resolve").expect("a run");
        assert_eq!(context.member_name, "Dev team");
        // already entered: no lookup
        let tokens = guard::enter(&context);
        assert_eq!(guard::resolve().await.expect("resolve"), Some(context.clone()));
        guard::leave(tokens);
        ctx::reset(t);
        let other = guard::set_request_authorization(Some("Bearer someone-elses"));
        assert_eq!(guard::resolve().await.expect("resolve"), None);
        ctx::reset(other);
        let dead = guard::set_request_authorization(Some("Bearer kbr_gone"));
        assert!(guard::resolve().await.is_err());
        ctx::reset(dead);
    })
    .await;
    // the MCP layer that holds the header itself
    assert_eq!(
        guard::resolve_for(Some(&format!("Bearer {token}"))).await.expect("resolve").map(|c| c.member_id),
        Some(m.id.clone())
    );
    assert_eq!(guard::resolve_for(None).await.expect("resolve"), None);
}

#[tokio::test]
async fn guarded_runs_the_call_as_the_run_and_skips_a_write_repeated_after_a_resume() {
    let _lock = common::init().await;
    let context = RunContext {
        run_id: "run_dup".into(),
        member_id: "m1".into(),
        member_name: "Dev team".into(),
        ..RunContext::default()
    };
    guard::forget_run("run_dup");
    ctx::scope(async {
        // outside a run: the call as it is
        let out =
            guard::guarded("manage_ticket", "update", args(json!({"id": "K-1", "x": null})), |given| async move {
                Ok::<_, ToolError>(Value::Object(given))
            })
            .await;
        assert_eq!(out.expect("a result"), json!({"id": "K-1", "x": null}));

        let tokens = guard::enter(&context);
        // omitted optional arguments never count; a comment is written by the member; the call acts as the run
        let seen = guard::guarded(
            "ticket_items",
            "comment.add",
            args(json!({"id": "K-1", "text": "hi", "x": null})),
            |given| async move { Ok::<_, ToolError>(json!({"given": given, "actor": activity::current_actor()})) },
        )
        .await
        .expect("a result");
        assert_eq!(seen["given"], json!({"id": "K-1", "text": "hi", "author": "Dev team"}));
        assert_eq!(seen["actor"], json!("Dev team"));

        let calls = std::sync::atomic::AtomicUsize::new(0);
        let write = |n: i64| {
            guard::guarded("manage_ticket", "update", args(json!({"id": "K-2", "n": n})), |_| {
                let k = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                async move { Ok::<_, ToolError>(json!({"done": k})) }
            })
        };
        assert_eq!(write(1).await.expect("a result"), json!({"done": 0}));
        // not resumed: a repeat is a new write
        assert_eq!(write(1).await.expect("a result"), json!({"done": 1}));
        guard::mark_resumed("run_dup");
        let again = write(1).await.expect("a result");
        assert_eq!(again, json!({"done": 1, "already_done": guard::ALREADY_DONE}));
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2, "the call did not run again");
        // another write, or a tool that is not a write, runs
        assert_eq!(write(2).await.expect("a result"), json!({"done": 2}));
        let read = guard::guarded("get_ticket", "get", args(json!({"id": "K-2"})), |_| async {
            Ok::<_, ToolError>(json!({"read": true}))
        })
        .await
        .expect("a result");
        assert_eq!(read, json!({"read": true}));
        // a result that is not a dict is answered as a note alone
        guard::remember_write_at("run_dup", "fp-list", json!([1, 2]), 10.0);
        guard::mark_resumed_at("run_dup", 20.0);
        assert_eq!(guard::repeat_of_at("run_dup", "fp-list", 30.0), Some(json!([1, 2])));
        // the window is 180 seconds
        assert_eq!(guard::repeat_of_at("run_dup", "fp-list", 10.0 + guard::DUPLICATE_WINDOW_S + 1.0), None);
        guard::forget_run("run_dup");
        assert_eq!(write(1).await.expect("a result"), json!({"done": 3}));
        guard::leave(tokens);
    })
    .await;
    // a failing call is not remembered
    ctx::scope(async {
        let tokens = guard::enter(&context);
        guard::forget_run("run_dup");
        let failing = guard::guarded("docs_write", "page.create", args(json!({"t": 1})), |_| async {
            Err::<Value, ToolError>("nope".into())
        })
        .await;
        assert!(matches!(failing, Err(guard::GuardedError::Call(ref e)) if e == "nope"));
        guard::mark_resumed("run_dup");
        let retried = guard::guarded("docs_write", "page.create", args(json!({"t": 1})), |_| async {
            Ok::<_, ToolError>(json!({"ok": 1}))
        })
        .await
        .expect("a result");
        assert_eq!(retried, json!({"ok": 1}));
        guard::leave(tokens);
    })
    .await;
    guard::forget_run("run_dup");
}

#[tokio::test]
async fn comments_are_shown_to_an_ai_caller_as_its_prompt_shows_them() {
    let _lock = common::init().await;
    let (pid, _an) = common::project().await;
    let (m, _t) = common::team(&pid, "Dev team", common::TeamOpts::default()).await;
    common::team(&pid, "Reviewer", common::TeamOpts::default()).await;
    let session = database::session();
    let raw: Vec<Value> = vec![
        json!({"id": "c1", "author": "An Nguyen", "text": "ghp_abcdefghijkl123 is the key", "at": "2026-11-11T10:00:00+00:00"}),
        json!({"id": "c2", "author": "Reviewer", "text": "looks fine", "at": "2026-11-11T11:00:00+00:00"}),
        json!({"id": "c3", "author": "stranger", "text": "hello", "at": "2026-11-11T12:00:00+00:00"}),
        json!({"id": "c4", "author": "stranger", "text": "gone", "deleted_at": "x"}),
    ];
    // not an AI call: nothing special
    ctx::scope(async {
        assert_eq!(comment_view::for_caller(&session, &pid, &raw).await.expect("view"), None);
        let context = RunContext {
            run_id: "r".into(),
            member_id: m.id.clone(),
            member_name: "Dev team".into(),
            project_id: pid.clone(),
            ..RunContext::default()
        };
        let tokens = guard::enter(&context);
        let view = comment_view::for_caller(&session, &pid, &raw).await.expect("view").expect("an AI caller");
        assert_eq!(view["held_back"], json!(1));
        let comments = view["comments"].as_array().expect("comments");
        assert_eq!(comments.iter().map(|c| c["id"].as_str().expect("id")).collect::<Vec<_>>(), ["c1", "c2"]);
        assert_eq!(comments[0]["text"], json!("gh_•••• is the key"));
        assert!(
            comments[1]["text"]
                .as_str()
                .expect("text")
                .starts_with("<untrusted source=\"comment · AI member Reviewer\">")
        );
        guard::leave(tokens);
    })
    .await;

    let all: Vec<Value> = raw.clone();
    let picked = |ids: Option<&[String]>, since: Option<&str>| {
        comment_view::pick(all.clone(), ids, since)
            .iter()
            .map(|c| c["id"].as_str().unwrap_or("").to_string())
            .collect::<Vec<_>>()
    };
    assert_eq!(picked(None, None), ["c1", "c2", "c3", "c4"]);
    assert_eq!(picked(Some(&["c2".to_string(), "c3".to_string()]), None), ["c2", "c3"]);
    assert_eq!(picked(None, Some("2026-11-11T10:30:00+00:00")), ["c2", "c3"]);
    assert_eq!(picked(Some(&["c1".to_string(), "c3".to_string()]), Some("2026-11-11T10:30:00+00:00")), ["c3"]);
    assert_eq!(comment_view::loads_list(&json!("[1, 2]")), [json!(1), json!(2)]);
    assert!(comment_view::loads_list(&json!("{}")).is_empty() && comment_view::loads_list(&json!("bad")).is_empty());
}

#[tokio::test]
async fn the_hooks_other_crates_declare_see_the_run_the_guard_holds() {
    let _lock = common::init().await;
    hooks::register();
    assert!(!kb_docs::hooks::ai_acting());
    assert!(kb_board::hooks::ai_runs().is_some_and(|h| !h.in_run()));
    ctx::scope(async {
        let tokens =
            guard::enter(&RunContext { run_id: "r".into(), member_name: "Dev team".into(), ..RunContext::default() });
        assert!(kb_docs::hooks::ai_acting());
        assert!(kb_board::hooks::ai_runs().is_some_and(|h| h.in_run()));
        // the calls that wait for `runs` do nothing until it fills the seam
        let runs = kb_board::hooks::ai_runs().expect("registered");
        assert!(
            runs.before_ticket_change("K-1", Some("done"), kb_board::hooks::NewAssignee::Unset, false, "An")
                .await
                .is_ok()
        );
        assert!(runs.note_person_edit("K-1", "An", "title", true).await.is_ok());
        assert!(runs.wake_new_assignee("K-1", "m", "An").await.is_ok());
        runs.on_status("K-1", "review", "todo", false);
        guard::leave(tokens);
    })
    .await;
    assert!(kb_board::hooks::ai_teams().is_none(), "check_name waits for `teams`");
}

#[tokio::test]
async fn store_loads_the_profile_the_settings_and_the_active_runs() {
    let _lock = common::init().await;
    let (pid, an) = common::project().await;
    let (m, _t) = common::team(&pid, "Dev team", common::TeamOpts::default()).await;
    let session = database::session();
    let (member, profile) = store::get_profile(&session, &m.id).await.expect("profile");
    assert!(member.is_some_and(|x| x.name == "Dev team") && profile.is_some());
    let (human, none) = store::get_profile(&session, &an).await.expect("profile");
    assert!(human.is_some() && none.is_none());
    assert_eq!(store::get_profile(&session, "nope").await.expect("profile"), (None, None));

    // the settings are created with defaults on first use and read back the same after
    let s1 = store::get_settings(&session, &pid).await.expect("settings");
    assert!(!s1.paused_all && s1.board_max_parallel == 4 && s1.audit_retention_days == Some(90));
    assert_eq!(store::get_settings(&database::session(), &pid).await.expect("settings"), s1);

    // the names of the AI members, current and removed
    let mut gone = member::new();
    gone.project_id = Set(pid.clone());
    gone.name = Set("Old bot".into());
    gone.color = Set("#000000".into());
    gone.kind = Set("ai_removed".into());
    gone.insert(&session).await.expect("member");
    session.commit().await.expect("commit");
    let names = store::ai_names(&database::session(), &pid).await.expect("names");
    assert_eq!(names, ["Dev team".to_string(), "Old bot".to_string()].into());

    // runs that are queued, starting, running or waiting for input
    let tk = common::ticket(&pid, "Fix", "todo").await;
    for state in ["queued", "starting", "running", "needs_input", "finished", "failed"] {
        common::run(&pid, &m.id, Some(&tk.id), state, |_| {}).await;
    }
    common::run(&pid, "other-member", Some("OTHER-1"), "running", |_| {}).await;
    let s = database::session();
    assert_eq!(store::active_runs(&s, Some(&m.id), None).await.expect("runs").len(), 4);
    assert_eq!(store::active_runs(&s, None, Some(&tk.id)).await.expect("runs").len(), 4);
    assert_eq!(store::active_runs(&s, Some(&m.id), Some("OTHER-1")).await.expect("runs").len(), 0);
    assert!(store::active_runs(&s, None, None).await.expect("runs").len() >= 5);
    assert_eq!(store::now_iso().len(), 32);
    assert_eq!(store::loads(Some("[1]"), json!(null)), json!([1]));
}
