//! `tests/test_models.py`: the tests build rows and read them back in process, on a database of their own (the
//! Python tests use an in-memory SQLite database each; here the tests of this file share one temporary file).

use std::future::Future;
use std::sync::LazyLock;

use kb_board::schemas::{TicketRead, parse_json_list};
use kb_db::database;
use kb_db::entities::{project, ticket};
use kb_db::sea_orm::ActiveModelTrait;
use kb_db::sea_orm::ActiveValue::Set;
use serde_json::json;
use tokio::runtime::Runtime;
use tokio::sync::OnceCell;

static RUNTIME: LazyLock<Runtime> = LazyLock::new(|| Runtime::new().expect("runtime"));
static DATABASE: OnceCell<tempfile::TempDir> = OnceCell::const_new();

/// Run a test on the shared runtime, with the database set up once.
#[allow(unsafe_code)]
fn run<F: Future>(test: F) -> F::Output {
    RUNTIME.block_on(async {
        DATABASE
            .get_or_init(|| async {
                let dir = tempfile::tempdir().expect("temporary folder");
                // Set once, before anything of this process reads them (the other tests wait on this cell).
                unsafe {
                    std::env::set_var("KANBAN_CONFIG_DIR", dir.path().join("config"));
                    std::env::set_var("KANBAN_DB_PATH", dir.path().join("data").join("kanban.db"));
                    std::env::remove_var("KANBAN_DATABASE_URL");
                }
                database::setup().await.expect("database setup");
                database::init_db().await.expect("schema");
                dir
            })
            .await;
        test.await
    })
}

async fn add_project(name: &str, prefix: &str, color: &str) -> project::Model {
    let session = database::session();
    let mut row = project::new();
    row.name = Set(name.to_string());
    row.prefix = Set(prefix.to_string());
    row.color = Set(color.to_string());
    let row = row.insert(&session).await.expect("insert");
    session.commit().await.expect("commit");
    row
}

#[test]
fn test_create_and_read_project() {
    run(async {
        let project = add_project("My Project", "IAM", "#FF5733").await;

        assert!(!project.id.is_empty());
        assert_eq!(project.name, "My Project");
        assert_eq!(project.prefix, "IAM");
        assert_eq!(project.color, "#FF5733");
        assert_eq!(project.ticket_counter, 0);
    });
}

#[test]
fn test_create_and_read_ticket() {
    run(async {
        let project = add_project("Test Project", "TST", "#123456").await;

        let session = database::session();
        let mut row = ticket::new();
        row.id = Set("TST-1".to_string());
        row.project_id = Set(project.id.clone());
        row.title = Set("First ticket".to_string());
        row.status = Set("todo".to_string());
        row.priority = Set("high".to_string());
        let ticket = row.insert(&session).await.expect("insert");
        session.commit().await.expect("commit");

        assert_eq!(ticket.id, "TST-1");
        assert_eq!(ticket.project_id, project.id);
        assert_eq!(ticket.title, "First ticket");
        assert_eq!(ticket.status, "todo");
        assert_eq!(ticket.priority, "high");
        assert_eq!(ticket.description, "");
        assert_eq!(ticket.tags, "[]");
        assert_eq!(ticket.r#type, "task");
    });
}

#[test]
fn test_ticket_read_parses_json_fields() {
    run(async {
        let project = add_project("JSON Project", "JSN", "#AABBCC").await;

        let session = database::session();
        let mut row = ticket::new();
        row.id = Set("JSN-1".to_string());
        row.project_id = Set(project.id.clone());
        row.title = Set("JSON ticket".to_string());
        row.tags = Set(r#"["alpha", "beta"]"#.to_string());
        row.comments = Set(r#"[{"author": "alice", "text": "hello"}]"#.to_string());
        let ticket = row.insert(&session).await.expect("insert");
        session.commit().await.expect("commit");

        let read = TicketRead::from_ticket(ticket).expect("read model");
        assert_eq!(read.tags, vec![json!("alpha"), json!("beta")]);
        assert_eq!(read.comments, vec![json!({"author": "alice", "text": "hello"})]);
        assert!(read.acceptance_criteria.is_empty());
        assert!(read.work_log.is_empty());
    });
}

// ---------------------------------------------------------------------------
// _parse_json_list edge cases
// ---------------------------------------------------------------------------

#[test]
fn test_parse_json_list_empty_string() {
    assert!(parse_json_list("").expect("parsed").is_empty());
}

#[test]
fn test_parse_json_list_null_string() {
    assert!(parse_json_list("null").expect("parsed").is_empty());
}

#[test]
fn test_parse_json_list_valid_array() {
    assert_eq!(parse_json_list(r#"["a", "b"]"#).expect("parsed"), vec![json!("a"), json!("b")]);
}
