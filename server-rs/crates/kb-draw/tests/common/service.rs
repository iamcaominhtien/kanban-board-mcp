//! An in-process database for the tests that call the service functions of the crate: one temporary folder and one
//! database for the whole test binary, on a runtime that outlives every test (the connection pool lives in it).

use std::future::Future;
use std::sync::{Once, OnceLock};

use kb_db::entities::project;
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::ActiveModelTrait;

static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
static INIT: Once = Once::new();

fn runtime() -> &'static tokio::runtime::Runtime {
    RUNTIME.get_or_init(|| tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("runtime"))
}

/// Make the folders and the database (once) and run `fut` in a request-like context.
#[allow(unsafe_code)]
pub fn run<F: Future>(fut: F) -> F::Output {
    INIT.call_once(|| {
        let dir = tempfile::tempdir().expect("temporary folder").keep();
        // the first thing this process does: nothing else reads the environment yet
        unsafe {
            std::env::set_var("KANBAN_CONFIG_DIR", dir.join("config"));
            std::env::set_var("KANBAN_DB_PATH", dir.join("data").join("kanban.db"));
            std::env::set_var("KANBAN_LOG_DIR", dir.join("logs"));
            std::env::set_var("KANBAN_UPLOADS_DIR", dir.join("uploads"));
            std::env::set_var("KANBAN_DRAWIO_DIR", dir.join("none"));
            std::env::remove_var("KANBAN_DATABASE_URL");
            std::env::remove_var("KANBAN_DIAGRAM_EXPORT");
            std::env::remove_var("KANBAN_EXPORT_CMD");
        }
        runtime().block_on(async {
            kb_db::database::setup().await.expect("database setup");
            kb_db::database::init_db().await.expect("database schema");
        });
    });
    runtime().block_on(kb_base::ctx::scope(fut))
}

/// A project row, returning its id.
pub async fn project(name: &str, prefix: &str) -> String {
    let session = kb_db::session();
    let mut row = project::new();
    row.name = Set(name.into());
    row.prefix = Set(prefix.into());
    row.color = Set("#0a0".into());
    let saved = row.insert(&session).await.expect("insert project");
    session.commit().await.expect("commit");
    saved.id
}
