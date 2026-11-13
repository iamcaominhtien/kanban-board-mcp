//! `tests/test_idea_space_model.py`, the part that calls the service functions: the Idea Space data model (stages,
//! assumption records, ideas without a project, votes), in one process with its own temporary database
//! (`KANBAN_CONFIG_DIR`, `KANBAN_DB_PATH`), as `crates/kb-board/tests/tickets_service.rs` does.
//!
//! The nine tests of the file that build a database at the old Alembic revision `b3e5f7a9c1d2` and upgrade it to
//! `f4a6b8c0d2e4` (`test_ideas_are_placed_in_the_stage_the_design_gives_them`,
//! `test_archived_parked_and_unlinked_details`, `test_tickets_of_building_and_shipped_ideas_point_back_to_them`,
//! `test_page_body_and_details_are_built_from_the_old_fields`, `test_assumptions_become_records_with_medium_impact`,
//! `test_conversion_is_recorded_in_the_activity_and_nothing_is_lost`, `test_a_backup_is_made_before_converting`,
//! `test_no_backup_when_there_are_no_ideas`, `test_downgrade_writes_assumptions_back_and_upgrade_again_works`) wait
//! for the migration port (P6): the Rust server refuses a database that is not at head.

use std::future::Future;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU32, Ordering};

use kb_board::projects::create_project;
use kb_board::schemas::ProjectCreate;
use kb_db::entities::{idea_assumption, idea_comment, idea_ticket, idea_vote, ticket};
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, SqlErr};
use kb_db::{Session, database};
use kb_ideas::Error;
use kb_ideas::idea_promote::{Promote, promote};
use kb_ideas::idea_tickets::{
    NewIdea, TestTicket, add_assumption, create_idea_ticket, delete_assumption, delete_idea_ticket, get_idea_ticket,
    list_idea_tickets, update_assumption, update_assumption_status, update_idea_status, wake_parked_ideas,
};
use kb_ideas::model::Idea;
use serde_json::Value;
use tokio::sync::Mutex;

const PAST: &str = "2020-01-01";
const FUTURE: &str = "2999-01-01";

static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
static ONE_AT_A_TIME: Mutex<()> = Mutex::const_new(());
static READY: tokio::sync::OnceCell<tempfile::TempDir> = tokio::sync::OnceCell::const_new();
static PROJECTS: AtomicU32 = AtomicU32::new(0);

/// Run a test on the runtime of this process (the database pool lives on it), one test at a time, in a context of
/// its own.
fn run<F: Future<Output = ()>>(test: F) {
    let runtime =
        RUNTIME.get_or_init(|| tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("runtime"));
    runtime.block_on(async {
        let _one = ONE_AT_A_TIME.lock().await;
        READY.get_or_init(prepare).await;
        kb_base::ctx::scope(test).await;
    });
}

#[allow(unsafe_code)]
async fn prepare() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("temporary folder");
    // The folders are set once, before anything reads them: every test of this file shares them.
    unsafe {
        std::env::set_var("KANBAN_CONFIG_DIR", dir.path().join("config"));
        std::env::set_var("KANBAN_DB_PATH", dir.path().join("data").join("kanban.db"));
        std::env::set_var("KANBAN_WORKSPACE_ROOT", dir.path().join("workspace"));
        std::env::remove_var("KANBAN_DATABASE_URL");
    }
    database::setup().await.expect("database setup");
    database::init_db().await.expect("schema");
    dir
}

/// The `session` fixture: a project of its own (`p1` of the Python test), and a session.
async fn fixture() -> (Session, String) {
    let n = PROJECTS.fetch_add(1, Ordering::SeqCst);
    let prefix: String =
        ['P', char::from(b'A' + (n / 26 % 26) as u8), char::from(b'A' + (n % 26) as u8)].iter().collect();
    let project = {
        let session = database::session();
        create_project(&session, &ProjectCreate { name: "P".into(), prefix, color: "#000".into() })
            .await
            .expect("project")
    };
    (database::session(), project.id)
}

fn message<T: std::fmt::Debug>(result: Result<T, Error>) -> String {
    match result {
        Err(Error::Value(message)) => message,
        other => panic!("expected a ValueError, got {other:?}"),
    }
}

fn trail(idea: &Idea) -> Vec<Value> {
    serde_json::from_str(&idea.row.activity_trail).expect("trail")
}

#[test]
fn test_a_new_idea_starts_in_the_inbox_with_its_page_and_author() {
    run(async {
        let (session, p1) = fixture().await;
        let new =
            NewIdea { description: "D", problem_statement: Some("Why"), author: Some("Tuan"), ..NewIdea::new("T") };
        let idea = create_idea_ticket(&session, Some(&p1), new).await.expect("idea");
        assert_eq!(
            (idea.stage.as_str(), idea.source.as_str(), idea.park_until.clone(), idea.archive_reason.clone()),
            ("inbox", "manual", None, None)
        );
        assert_eq!(idea.body, "## Problem\n\nWhy\n\nD");
        assert_eq!(trail(&idea)[0]["author"], "Tuan");
    });
}

#[test]
fn test_an_idea_can_belong_to_no_project() {
    run(async {
        let (session, _) = fixture().await;
        let idea = create_idea_ticket(&session, None, NewIdea::new("Loose")).await.expect("idea");
        assert_eq!(idea.project_id, None);
        assert!(message(create_idea_ticket(&session, Some("missing"), NewIdea::new("x")).await).contains("not found"));
        let new = NewIdea { source: "telepathy", ..NewIdea::new("x") };
        assert!(message(create_idea_ticket(&session, None, new).await).contains("source"));
    });
}

#[test]
fn test_old_status_moves_keep_the_stage_in_step() {
    run(async {
        let (session, p1) = fixture().await;
        let idea = create_idea_ticket(&session, Some(&p1), NewIdea::new("T")).await.expect("idea");
        let idea = update_idea_status(&session, &idea.id, "in_review", None, Some("user")).await.expect("moved");
        assert_eq!(idea.stage, "exploring");
        let idea = update_idea_status(&session, &idea.id, "approved", None, Some("user")).await.expect("moved");
        assert_eq!(idea.stage, "ready");
        let idea = update_idea_status(&session, &idea.id, "dropped", Some("no"), Some("user")).await.expect("moved");
        assert_eq!((idea.stage.as_str(), idea.archive_reason.as_deref()), ("archived", Some("no")));
        let idea = update_idea_status(&session, &idea.id, "draft", None, Some("user")).await.expect("moved");
        assert_eq!((idea.stage.as_str(), idea.archive_reason.clone()), ("exploring", None));
    });
}

#[test]
fn test_promoting_makes_the_idea_building_and_building_cannot_be_dropped() {
    run(async {
        let (session, p1) = fixture().await;
        let new = NewIdea { problem_statement: Some("P"), ..NewIdea::new("T") };
        let idea = create_idea_ticket(&session, Some(&p1), new).await.expect("idea");
        update_idea_status(&session, &idea.id, "in_review", None, Some("user")).await.expect("moved");
        update_idea_status(&session, &idea.id, "approved", None, Some("user")).await.expect("moved");
        let args = Promote { project_id: Some(&p1), acknowledge_not_ready: true, ..Default::default() };
        promote(&session, &idea.id, &args).await.expect("promoted");
        let idea = get_idea_ticket(&session, &idea.id).await.expect("read").expect("found");
        assert_eq!(idea.stage, "building");
        let failure = update_idea_status(&session, &idea.id, "dropped", None, Some("user")).await;
        assert!(message(failure).contains("Not allowed while the ticket is open"));
    });
}

#[test]
fn test_a_parked_idea_returns_to_the_inbox_once_its_date_has_come() {
    run(async {
        let (session, p1) = fixture().await;
        let due = create_idea_ticket(&session, Some(&p1), NewIdea::new("Due")).await.expect("idea");
        let waiting = create_idea_ticket(&session, Some(&p1), NewIdea::new("Waiting")).await.expect("idea");
        for (idea, date) in [(&due, PAST), (&waiting, FUTURE)] {
            let mut row = idea_ticket::Entity::find_by_id(idea.id.as_str())
                .one(&session)
                .await
                .expect("query")
                .expect("row")
                .into_active_model_for_test();
            row.stage = Set("parked".to_string());
            row.park_until = Set(Some(date.to_string()));
            row.update(&session).await.expect("update");
        }
        session.commit().await.expect("commit");

        let listed = list_idea_tickets(&session, &p1, None, None).await.expect("list");
        let by_id = |id: &str| listed.iter().find(|i| i.row.id == id).expect("listed");
        assert_eq!((by_id(&due.id).stage.as_str(), by_id(&due.id).park_until.clone()), ("inbox", None));
        assert_eq!(
            (by_id(&waiting.id).stage.as_str(), by_id(&waiting.id).park_until.as_deref()),
            ("parked", Some(FUTURE))
        );
        let entry = trail(by_id(&due.id)).pop().expect("entry");
        assert!(entry["author"] == "system" && entry["label"].as_str().expect("label").contains("Back in the Inbox"));
        // woken once: asking again changes nothing
        assert_eq!(wake_parked_ideas(&session, None).await.expect("wake"), 0);
    });
}

/// `ActiveModelTrait::into_active_model` of a row, named for what the tests do with it.
trait IntoActive {
    fn into_active_model_for_test(self) -> idea_ticket::ActiveModel;
}

impl IntoActive for idea_ticket::Model {
    fn into_active_model_for_test(self) -> idea_ticket::ActiveModel {
        kb_db::sea_orm::IntoActiveModel::into_active_model(self)
    }
}

#[test]
fn test_assumption_records_carry_impact_status_and_test_ticket() {
    run(async {
        let (session, p1) = fixture().await;
        let idea = create_idea_ticket(&session, Some(&p1), NewIdea::new("T")).await.expect("idea");
        let ticket_id = format!("{p1}-T1");
        let mut row = ticket::new();
        row.id = Set(ticket_id.clone());
        row.project_id = Set(p1.clone());
        row.title = Set("Test it".to_string());
        row.created_at = Set("x".to_string());
        row.updated_at = Set("x".to_string());
        row.insert(&session).await.expect("ticket");
        session.commit().await.expect("commit");

        let idea = add_assumption(&session, &idea.id, "People pay", "high", Some("user"), false).await.expect("added");
        let a = idea.assumption_records[0].row.clone();
        assert_eq!((a.impact.as_str(), a.status.as_str(), a.test_ticket_id.clone()), ("high", "untested", None));

        let idea = update_assumption_status(&session, &idea.id, &a.id, "invalidated", Some("user")).await.expect("set");
        assert_eq!(idea.assumption_records[0].row.status, "disproved");
        let idea = update_assumption_status(&session, &idea.id, &a.id, "testing", Some("user")).await.expect("set");
        let idea = update_assumption(
            &session,
            &idea.id,
            &a.id,
            Some("They pay monthly"),
            Some("low"),
            TestTicket::Set(Some(&ticket_id)),
            Some("user"),
        )
        .await
        .expect("edited");
        let a = idea.assumption_records[0].row.clone();
        assert_eq!(
            (a.text.as_str(), a.impact.as_str(), a.status.as_str(), a.test_ticket_id.as_deref()),
            ("They pay monthly", "low", "testing", Some(ticket_id.as_str()))
        );
        let failure =
            update_assumption(&session, &idea.id, &a.id, None, None, TestTicket::Set(Some("PP-404")), Some("user"))
                .await;
        assert!(message(failure).contains("not found"));
        let failure = add_assumption(&session, &idea.id, "x", "huge", Some("user"), false).await;
        assert!(message(failure).contains("impact"));

        let idea = update_assumption(&session, &idea.id, &a.id, None, None, TestTicket::Set(None), Some("user"))
            .await
            .expect("edited");
        assert_eq!(idea.assumption_records[0].row.test_ticket_id, None);
    });
}

#[test]
fn test_deleting_an_assumption_renumbers_the_rest() {
    run(async {
        let (session, p1) = fixture().await;
        let mut idea = create_idea_ticket(&session, Some(&p1), NewIdea::new("T")).await.expect("idea");
        for t in ["one", "two", "three"] {
            idea = add_assumption(&session, &idea.id, t, "medium", Some("user"), false).await.expect("added");
        }
        let first = idea.assumption_records[0].row.id.clone();
        let idea = delete_assumption(&session, &idea.id, &first, Some("user")).await.expect("deleted");
        let shown: Vec<(&str, i32)> =
            idea.assumption_records.iter().map(|a| (a.row.text.as_str(), a.row.position)).collect();
        assert_eq!(shown, [("two", 0), ("three", 1)]);
    });
}

#[test]
fn test_deleting_an_idea_removes_its_assumptions_and_votes() {
    run(async {
        let (session, p1) = fixture().await;
        let idea = create_idea_ticket(&session, Some(&p1), NewIdea::new("T")).await.expect("idea");
        add_assumption(&session, &idea.id, "x", "medium", Some("user"), false).await.expect("added");
        let mut vote = idea_vote::new();
        vote.idea_id = Set(idea.id.clone());
        vote.voter = Set("Tuan".to_string());
        vote.insert(&session).await.expect("vote");
        let mut comment = idea_comment::new();
        comment.idea_id = Set(idea.id.clone());
        comment.insert(&session).await.expect("comment");
        session.commit().await.expect("commit");
        let before = (
            idea_assumption::Entity::find()
                .filter(idea_assumption::Column::IdeaId.eq(idea.id.as_str()))
                .count(&session)
                .await
                .expect("n"),
            idea_vote::Entity::find()
                .filter(idea_vote::Column::IdeaId.eq(idea.id.as_str()))
                .count(&session)
                .await
                .expect("n"),
        );
        assert_eq!(before, (1, 1));
        assert!(delete_idea_ticket(&session, &idea.id).await.expect("deleted"));
        for (table, n) in [
            (
                "idea_assumption",
                idea_assumption::Entity::find()
                    .filter(idea_assumption::Column::IdeaId.eq(idea.id.as_str()))
                    .count(&session)
                    .await
                    .expect("n"),
            ),
            (
                "idea_vote",
                idea_vote::Entity::find()
                    .filter(idea_vote::Column::IdeaId.eq(idea.id.as_str()))
                    .count(&session)
                    .await
                    .expect("n"),
            ),
            (
                "idea_comment",
                idea_comment::Entity::find()
                    .filter(idea_comment::Column::IdeaId.eq(idea.id.as_str()))
                    .count(&session)
                    .await
                    .expect("n"),
            ),
        ] {
            assert_eq!(n, 0, "{table}");
        }
        assert!(!delete_idea_ticket(&session, &idea.id).await.expect("deleted twice"));
    });
}

#[test]
fn test_a_person_votes_once_per_idea() {
    run(async {
        let (session, p1) = fixture().await;
        let idea_id = create_idea_ticket(&session, Some(&p1), NewIdea::new("T")).await.expect("idea").id.clone();
        let add = |voter: &str| {
            let mut vote = idea_vote::new();
            vote.idea_id = Set(idea_id.clone());
            vote.voter = Set(voter.to_string());
            vote
        };
        add("Tuan").insert(&session).await.expect("first vote");
        session.commit().await.expect("commit");
        let second = add("Tuan").insert(&session).await;
        assert!(matches!(second.expect_err("a second vote").sql_err(), Some(SqlErr::UniqueConstraintViolation(_))));
        session.rollback().await.expect("rollback");
        add("Lan").insert(&session).await.expect("another voter");
        session.commit().await.expect("commit");
        let idea = kb_ideas::idea_tickets::reload(&session, &idea_id).await.expect("reload");
        assert_eq!(idea.vote_records.len(), 2);
    });
}
