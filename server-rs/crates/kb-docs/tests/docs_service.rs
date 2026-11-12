//! The parts of the Docs service that no REST route reaches or that the Python tests reach by monkeypatching, in one
//! process with its own database: FTS5 in the bundled SQLite (the spike of the plan), the scan path of the search,
//! the index writes while FTS5 is off, `backfill_sync` (what the database move calls), `slug_path` against the
//! whole-space `slug_paths`, and the hooks to what is above this crate (comments, canvases, the AI guard, tickets).

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use kb_base::ctx;
use kb_db::entities::{ai_run, ai_run_step, canvas, docs_page, member, project, ticket};
use kb_db::sea_orm::{ActiveModelTrait, ConnectionTrait, EntityTrait, IntoActiveModel, Set};
use kb_db::{Session, database};
use kb_docs::docs::{self, all_pages, slug_path, slug_paths};
use kb_docs::docs_search::{self, SearchParams};
use kb_docs::hooks::{self, AiGuardHook, AssignHook, CanvasesHook, CommentsHook, RunBrief, TicketBrief};
use kb_docs::{Error, docs_work};
use serde_json::{Value, json};

static CALLS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn call(text: String) {
    CALLS.lock().expect("calls").push(text);
}

fn calls() -> Vec<String> {
    std::mem::take(&mut *CALLS.lock().expect("calls"))
}

struct Comments;

#[async_trait]
impl CommentsHook for Comments {
    async fn delete_for_pages(&self, _session: &Session, ids: &[String]) -> Result<(), kb_db::sea_orm::DbErr> {
        let mut ids = ids.to_vec();
        ids.sort();
        call(format!("delete_for_pages {}", ids.len()));
        Ok(())
    }

    async fn rematch_page(
        &self,
        _session: &Session,
        page: &docs_page::Model,
        markdown: &str,
    ) -> Result<(), kb_db::sea_orm::DbErr> {
        call(format!("rematch_page {} v{} {markdown:?}", page.title, page.version));
        Ok(())
    }
}

struct Canvases;

#[async_trait]
impl CanvasesHook for Canvases {
    async fn board_names(&self, canvas_id: &str) -> Option<Vec<String>> {
        match canvas_id {
            "cv_00000001" => Some(vec!["Sign in".to_string(), "Two\nlines".to_string()]),
            _ => None,
        }
    }
}

struct Guard(bool);

impl AiGuardHook for Guard {
    fn in_run(&self) -> bool {
        self.0
    }
}

static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(1);

struct Assign;

#[async_trait]
impl AssignHook for Assign {
    async fn create_ticket(
        &self,
        session: &Session,
        project_id: &str,
        title: &str,
        description: &str,
        created_by: Option<&str>,
    ) -> Result<TicketBrief, String> {
        call(format!(
            "create_ticket {title} | {} | {created_by:?} | {}",
            description.lines().next().unwrap_or(""),
            !project_id.is_empty()
        ));
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let mut row = ticket::new();
        row.id = Set(format!("KAN-{n}"));
        row.project_id = Set(project_id.to_string());
        row.title = Set(title.to_string());
        row.description = Set(description.to_string());
        row.insert(session).await.map_err(|e| e.to_string())?;
        session.commit().await.map_err(|e| e.to_string())?;
        Ok(TicketBrief { id: format!("KAN-{n}"), title: title.into() })
    }

    async fn assign(&self, _session: &Session, ticket_id: &str, member_id: &str) -> Result<(), String> {
        call(format!("assign {ticket_id} {}", !member_id.is_empty()));
        Ok(())
    }

    async fn wake_new_assignee(
        &self,
        ticket_id: &str,
        _member_id: &str,
        by: Option<&str>,
        instruction: &str,
    ) -> Option<RunBrief> {
        call(format!("wake {ticket_id} {by:?} {instruction:?}"));
        if instruction == "start" { Some(RunBrief { id: "run-1".into(), state: "queued".into() }) } else { None }
    }
}

async fn titles(session: &Session, pid: &str, q: &str) -> Vec<String> {
    let found = docs_search::search(session, pid, q, &SearchParams::default()).await.expect("search");
    found["pages"].as_array().expect("pages").iter().map(|p| p["title"].as_str().expect("title").to_string()).collect()
}

async fn make(pid: &str, title: &str, parent: Option<&str>, markdown: &str, publish: bool) -> String {
    let session = database::session();
    let made = docs::create_page(&session, pid, title, parent, "blank", Some(markdown)).await.expect("create");
    let id = made["id"].as_str().expect("id").to_string();
    if publish {
        docs::publish_page(&database::session(), &id, 0, None, None, None).await.expect("publish");
    }
    id
}

#[tokio::test]
#[allow(unsafe_code)]
async fn the_service_behind_the_routes_and_its_hooks() {
    let dir = tempfile::tempdir().expect("temporary folder");
    // This test is the only one in its process; the folders are set before anything reads them.
    unsafe {
        std::env::set_var("KANBAN_CONFIG_DIR", dir.path().join("config"));
        std::env::set_var("KANBAN_DB_PATH", dir.path().join("data").join("kanban.db"));
        std::env::set_var("KANBAN_WORKSPACE_ROOT", dir.path().join("workspace"));
        std::env::remove_var("KANBAN_DATABASE_URL");
    }
    database::setup().await.expect("database setup");
    database::init_db().await.expect("schema");
    ctx::scope(scenario()).await;
}

async fn scenario() {
    let session = database::session();
    let mut row = project::new();
    row.name = Set("Kanban".into());
    row.prefix = Set("KAN".into());
    row.color = Set("#123456".into());
    let pid = row.insert(&session).await.expect("project").id;
    let mut ai = member::new();
    ai.project_id = Set(pid.clone());
    ai.name = Set("Writer".into());
    ai.color = Set("#3B82F6".into());
    ai.kind = Set("ai".into());
    let ai_id = ai.insert(&session).await.expect("ai member").id;
    let mut person = member::new();
    person.project_id = Set(pid.clone());
    person.name = Set("Ana".into());
    person.color = Set("#3B82F6".into());
    let person_id = person.insert(&session).await.expect("member").id;
    session.commit().await.expect("commit");

    // --- FTS5 is in the bundled SQLite: the table of the schema takes rows, MATCH and bm25 work, and the tokenizer
    // folds diacritics ---
    let session = database::session();
    session
        .execute_unprepared(
            "INSERT INTO docs_fts (page_id, project_id, title, headings, body) VALUES ('p1', 'j1', 'Café', '', 'Déjà vu menu')",
        )
        .await
        .expect("insert into docs_fts");
    let ranks = docs_search::fts_ranks(&session, "\"cafe\"* AND \"deja\"*", &["j1".to_string()]).await.expect("ranks");
    // the page does not exist in docs_page, so the JOIN drops it: the MATCH itself ran
    assert_eq!(ranks, Some(Vec::new()));
    let raw = session
        .query_one_raw(kb_db::sql::statement(
            session.get_database_backend(),
            "SELECT bm25(docs_fts, 0.0, 0.0, 10.0, 5.0, 1.0) FROM docs_fts WHERE docs_fts MATCH ?",
            [kb_db::sea_orm::Value::from("\"cafe\"* AND \"deja\"*")],
        ))
        .await
        .expect("match")
        .expect("a row");
    let rank: f64 = raw.try_get_by_index(0).expect("rank");
    assert!(rank < 0.0, "bm25 is negative for a match: {rank}");
    session.execute_unprepared("DELETE FROM docs_fts").await.expect("clean");
    // a syntax error of FTS5 is a failed MATCH, not an error: the search falls back to the scan
    assert_eq!(docs_search::fts_ranks(&session, "\"broken", std::slice::from_ref(&pid)).await.expect("ranks"), None);
    session.commit().await.expect("commit");

    // --- the corpus of the fallback tests ---
    let s = database::session();
    make(&pid, "Rate limiting", None, "## Intro\nunrelated words", true).await;
    make(&pid, "Guide", None, "## Rate limiting\nsome text here", true).await;
    make(&pid, "Notes", None, "## Misc\nwe apply rate limiting to every call", true).await;
    make(&pid, "Auth", None, "## Tokens\nbearer tokens expire hourly", true).await;
    assert_eq!(titles(&s, &pid, "rate limiting").await, ["Rate limiting", "Guide", "Notes"]);

    // test_fallback_without_fts5_gives_the_same_answers
    docs_search::set_fts_broken(true);
    let s = database::session();
    assert_eq!(titles(&s, &pid, "rate limiting").await, ["Rate limiting", "Guide", "Notes"]);
    assert_eq!(titles(&s, &pid, "bearer tokens").await, ["Auth"]);
    assert!(titles(&s, &pid, "rate tokens").await.is_empty());
    let mut phrase = titles(&s, &pid, "\"rate limiting\"").await;
    phrase.sort();
    assert_eq!(phrase, ["Guide", "Notes", "Rate limiting"]);
    let mut minus = titles(&s, &pid, "limiting -unrelated").await;
    minus.sort();
    assert_eq!(minus, ["Guide", "Notes"]);
    let headings = SearchParams { mode: Some("headings".into()), ..SearchParams::default() };
    let found = docs_search::search(&s, &pid, "#rate", &headings).await.expect("search");
    assert_eq!(found["pages"][0]["title"], "Guide");
    let found = docs_search::search(&s, &pid, "bearer", &SearchParams::default()).await.expect("search");
    assert!(found["pages"][0]["matches"][0]["snippet"].as_str().expect("snippet").contains("<mark>bearer</mark>"));
    for q in ["\"", "(", "'; --", "NEAR(", "*"] {
        docs_search::search(&s, &pid, q, &SearchParams::default()).await.expect(q);
    }

    // test_index_writes_are_noops_without_fts5_and_catch_up_afterwards: a page made while FTS5 is off is not indexed,
    // so the index misses it once FTS5 is back ... until it is rebuilt
    docs_search::set_fts_broken(false);
    assert!(titles(&database::session(), &pid, "capybara").await.is_empty());
    docs_search::set_fts_broken(true);
    make(&pid, "While off", None, "capybara", true).await;
    docs_search::set_fts_broken(false);
    assert!(titles(&database::session(), &pid, "capybara").await.is_empty());
    let s = database::session();
    docs_search::rebuild_index(&s).await.expect("rebuild");
    s.commit().await.expect("commit");
    assert_eq!(titles(&database::session(), &pid, "capybara").await, ["While off"]);

    // test_ensure_fts_creates_the_table_lazily_and_backfills
    let s = database::session();
    s.execute_unprepared("DROP TABLE docs_fts").await.expect("drop");
    s.commit().await.expect("commit");
    assert_eq!(titles(&database::session(), &pid, "capybara").await, ["While off"]);

    // backfill_sync: what the database move calls; a page never published is indexed through its draft
    make(&pid, "Only a draft", None, "platypus", false).await;
    let s = database::session();
    s.execute_unprepared("DELETE FROM docs_fts").await.expect("clean");
    assert!(titles(&s, &pid, "platypus").await.is_empty());
    docs_search::backfill_sync(&s).await.expect("backfill");
    s.commit().await.expect("commit");
    assert_eq!(titles(&database::session(), &pid, "platypus").await, ["Only a draft"]);
    assert_eq!(titles(&database::session(), &pid, "rate limiting").await.len(), 3);

    // --- slug_path walks only the ancestors and gives what the whole-space slug_paths gives (unique paths only) ---
    let a = make(&pid, "Guides", None, "", false).await;
    let a2 = make(&pid, "Guides", None, "", false).await;
    make(&pid, "Setup", Some(&a), "", false).await;
    make(&pid, "Setup", Some(&a2), "", false).await;
    let reference = make(&pid, "Reference", None, "", false).await;
    let api = make(&pid, "API", Some(&reference), "", false).await;
    make(&pid, "Errors", Some(&api), "", false).await;
    let gone = make(&pid, "Old", None, "", false).await;
    make(&pid, "Orphan", Some(&gone), "", false).await;
    make(&pid, "Orphan", None, "", false).await;
    let s = database::session();
    let old = docs_page::Entity::find_by_id(gone.as_str()).one(&s).await.expect("page").expect("gone");
    let mut old = old.into_active_model();
    old.deleted_at = Set(Some("2000-01-01T00:00:00+00:00".into()));
    old.update(&s).await.expect("update");
    s.commit().await.expect("commit");
    let s = database::session();
    let pages = all_pages(&s, &pid, false).await.expect("pages");
    let whole = slug_paths(&pages);
    let counts: HashMap<&str, usize> = whole.iter().fold(HashMap::new(), |mut m, (_, v)| {
        *m.entry(v.as_str()).or_default() += 1;
        m
    });
    let unique: HashMap<&str, &str> =
        whole.iter().filter(|(_, v)| counts[v.as_str()] == 1).map(|(k, v)| (k.as_str(), v.as_str())).collect();
    for p in &pages {
        let got = slug_path(&s, p).await.expect("slug_path");
        assert_eq!(got.as_deref(), unique.get(p.id.as_str()).copied(), "{}", p.title);
    }

    // --- hooks ---
    hooks::set_comments_hook(Box::new(Comments));
    hooks::set_canvases_hook(Box::new(Canvases));
    hooks::set_assign_hook(Box::new(Assign));
    calls();
    let hooked = make(&pid, "Hooked", None, "## One\nfirst", true).await;
    assert_eq!(calls(), ["rematch_page Hooked v1 \"## One\\nfirst\""]);
    let s = database::session();
    docs::delete_page(&s, &hooked).await.expect("delete");
    docs::purge_page(&database::session(), &hooked).await.expect("purge");
    assert_eq!(calls(), ["delete_for_pages 1"]);
    // an unset guard: not an AI run; the version carries the mark when the guard says so
    hooks::set_ai_guard_hook(Box::new(Guard(false)));
    let marked = make(&pid, "Plain", None, "x", true).await;
    let v = docs::list_versions(&database::session(), &marked).await.expect("versions");
    assert_eq!(v[0]["with_ai"], false);

    // a canvas page has its boards as sections, so [[Page#Section]] finds them
    let canvas_page = make(&pid, "Flow", None, "", false).await;
    let s = database::session();
    let page = docs_page::Entity::find_by_id(canvas_page.as_str()).one(&s).await.expect("page").expect("page");
    let mut page = page.into_active_model();
    page.kind = Set("canvas".into());
    page.update(&s).await.expect("kind");
    let mut c = canvas::new();
    c.id = Set("cv_00000001".into());
    c.project_id = Set(Some(pid.clone()));
    c.page_id = Set(Some(canvas_page.clone()));
    c.title = Set("Login redesign".into());
    c.insert(&s).await.expect("canvas");
    s.commit().await.expect("commit");
    let s = database::session();
    let pages = [docs_page::Entity::find_by_id(canvas_page.as_str()).one(&s).await.expect("page").expect("page")];
    let text = docs_search::contents(&s, &pages).await.expect("contents");
    assert_eq!(text[&canvas_page], "## Sign in\n\n## Two lines");

    // giving a page to an AI member: a ticket, linked, assigned, and the run that started (or the note when none)
    calls();
    let out = docs_work::assign_page(&database::session(), &marked, &ai_id, "write", Some("  start "), Some("Ana"))
        .await
        .expect("assign");
    assert_eq!(out["ticket"], json!({"id": "KAN-1", "title": "Write the page “Plain”"}));
    assert_eq!(out["run"], json!({"id": "run-1", "state": "queued"}));
    assert!(out.get("note").is_none());
    let calls = calls();
    assert_eq!(calls[0], "create_ticket Write the page “Plain” | Write [[Plain]]. | Some(\"Ana\") | true");
    assert_eq!(&calls[1..], ["assign KAN-1 true", "wake KAN-1 Some(\"Ana\") \"start\""]);
    let out =
        docs_work::assign_page(&database::session(), &marked, &ai_id, "review", None, None).await.expect("assign");
    assert_eq!(out["run"], Value::Null);
    assert_eq!(out["note"], "KAN-2 is assigned to Writer, but nothing started: the team is paused or at its limits.");
    for (member, kind, message) in [
        (person_id.as_str(), "write", "Pick an AI team of this project."),
        ("nope", "write", "Pick an AI team of this project."),
        (ai_id.as_str(), "edit", "kind: write or review."),
    ] {
        match docs_work::assign_page(&database::session(), &marked, member, kind, None, None).await {
            Err(Error::Value(m)) => assert_eq!(m, message),
            other => panic!("{other:?}"),
        }
    }
    // the work on the page lists the ticket (linked by hand to it), without a run
    let work = docs_work::work_on_page(&database::session(), &marked).await.expect("work");
    assert_eq!(work["active"], 0);
    // both tickets are linked to the page by hand; neither has a run in the table
    let rows: Vec<(&Value, &Value)> =
        work["tickets"].as_array().expect("tickets").iter().map(|t| (&t["id"], &t["run"])).collect();
    assert_eq!(rows, [(&json!("KAN-1"), &Value::Null), (&json!("KAN-2"), &Value::Null)]);
    // a live run on KAN-2 and an ended one on KAN-1: the live one counts, and the latest step that is not a hook is
    // what it is doing
    let s = database::session();
    for (ticket_id, state, queued) in
        [("KAN-1", "done", "2026-01-01T00:00:00+00:00"), ("KAN-2", "running", "2026-01-02T00:00:00+00:00")]
    {
        let mut run = ai_run::new();
        run.id = Set(format!("run_{ticket_id}"));
        run.project_id = Set(pid.clone());
        run.ticket_id = Set(Some(ticket_id.to_string()));
        run.member_id = Set(ai_id.clone());
        run.state = Set(state.to_string());
        run.queued_at = Set(queued.to_string());
        run.insert(&s).await.expect("run");
    }
    for (seq, kind, title) in [(1, "tool", "Read the ticket"), (2, "hook", "a hook"), (3, "tool", "")] {
        let mut step = ai_run_step::new();
        step.run_id = Set("run_KAN-2".to_string());
        step.seq = Set(seq);
        step.kind = Set(kind.to_string());
        step.title = Set(title.to_string());
        step.insert(&s).await.expect("step");
    }
    s.commit().await.expect("commit");
    let work = docs_work::work_on_page(&database::session(), &marked).await.expect("work");
    assert_eq!(work["active"], 1);
    // live work first
    assert_eq!(work["tickets"][0]["id"], "KAN-2");
    assert_eq!(work["tickets"][0]["assignee"], Value::Null);
    let run = &work["tickets"][0]["run"];
    assert_eq!(
        (&run["member"], &run["state"], &run["started_at"]),
        (&json!("Writer"), &json!("running"), &json!("2026-01-02T00:00:00+00:00"))
    );
    // the newest step has no title: `step.title if step is not None and step.title else None`
    assert_eq!(run["doing"], Value::Null);
    assert_eq!(work["tickets"][1]["run"]["state"], "done");
}
