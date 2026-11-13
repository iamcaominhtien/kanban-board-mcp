//! The migration differential on PostgreSQL: the revisions a server database can be at, upgraded by the Rust server
//! and compared with what the Python server made of the same database (see `differential::server_differential` and
//! `migrations_differential.rs`). Skipped unless `KANBAN_TEST_POSTGRES_URL` names a test server
//! (`scripts/dev-databases.sh start` prints one); the test works in its own database, `kanban_dbkit_migdiff`.

mod differential;

#[tokio::test]
async fn every_server_revision_upgrades_to_what_the_python_server_made_of_it() {
    let Ok(url) = std::env::var("KANBAN_TEST_POSTGRES_URL") else {
        println!("SKIPPED: KANBAN_TEST_POSTGRES_URL is not set");
        return;
    };
    differential::server_differential(&url, "postgres", "postgresql").await;
}
