//! `tests/test_dbkit_targets.py`: which database the board uses (design/screens/ai-databases.md B, F): connection
//! strings, the saved choice with its password encrypted, the environment winning, and the engines' settings. These
//! call `kb_db::targets` and `kb_db::database` directly, as the Python tests called the modules.
//!
//! `test_a_write_by_another_process_is_announced_on_postgres` needs the whole process pointed at a server database:
//! it is `test_dbkit_targets_postgres.rs`.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use kb_base::config as app_config;
use kb_db::database::{self, DatabaseError};
use kb_db::sea_orm::{ConnectionTrait, Statement};
use kb_db::targets::{self, Target};
use kb_db::{Session, sql};
use serde_json::{Value, json};

/// The value the environment variable carries.
const FROM_ENV: &str = "value-from-the-environment";

/// Tests that read or change the settings file or the environment run one at a time.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[allow(unsafe_code)]
fn set_env(name: &str, value: Option<&str>) {
    // Every test that reads these holds `SERIAL`.
    unsafe {
        match value {
            Some(value) => std::env::set_var(name, value),
            None => std::env::remove_var(name),
        }
    }
}

/// `config_dir` of the Python tests: a settings folder and a key file of the tests' own, and no database in the
/// environment.
fn config_dir() -> &'static Path {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    let dir = DIR.get_or_init(|| {
        let dir = tempfile::tempdir().expect("tmp").keep();
        set_env("KANBAN_CONFIG_DIR", Some(&dir.to_string_lossy()));
        set_env("KANBAN_AI_KEY_FILE", Some(&dir.join("key").to_string_lossy()));
        dir
    });
    set_env(targets::ENV_URL, None);
    set_env(targets::ENV_PASSWORD, None);
    app_config::set_section(targets::CONFIG_KEY, None).expect("settings");
    dir
}

fn form(value: Value) -> serde_json::Map<String, Value> {
    value.as_object().cloned().expect("an object")
}

#[test]
fn test_connection_strings() {
    let t = targets::from_url("postgres://kanban:s3cr%40t\u{40}db.internal/kanban?sslmode=verify-full").expect("url");
    assert_eq!(
        (
            t.engine.as_str(),
            t.host.as_str(),
            t.port,
            t.name.as_str(),
            t.user.as_str(),
            t.password.as_deref(),
            t.ssl.as_str()
        ),
        ("postgresql", "db.internal", Some(5432), "kanban", "kanban", Some("s3cr@t"), "verify-full")
    );
    assert!(
        !t.display().contains("s3cr") && !format!("{t:?}").contains("s3cr") && !t.public().contains_key("password")
    );
    assert!(t.url(false).starts_with("postgresql+asyncpg://"));
    let m = targets::from_url("mariadb+pymysql://app@mysql.internal:3307/kanban").expect("url");
    assert_eq!((m.engine.as_str(), m.port), ("mysql", Some(3307)));
    assert!(m.url(false).starts_with("mysql+aiomysql://"));
    assert!(m.url(false).ends_with("?charset=utf8mb4"));
    let s = targets::from_url("sqlite:///~/kanban-data/kanban.db").expect("url");
    assert!(s.is_sqlite() && s.path.ends_with("kanban-data/kanban.db") && !s.path.contains('~'));
    for bad in ["redis://localhost/0", "mongodb://x/y", "oracle://x/y", "postgresql:///nohost", ""] {
        assert!(targets::from_url(bad).is_err(), "{bad}");
    }
}

#[test]
fn test_redis_and_mongodb_say_why() {
    let err = targets::from_url("mongodb://localhost/kanban").expect_err("not relational");
    assert!(err.0.contains("relational"));
}

#[tokio::test]
async fn test_the_saved_choice_keeps_the_password_encrypted() {
    let _serial = SERIAL.lock().await;
    let config_dir = config_dir();
    let secret = "hunter\u{32}";
    let target = targets::from_fields(&form(json!({
        "engine": "postgresql", "host": "db", "name": "kanban", "user": "k", "password": secret, "ssl": "require",
    })))
    .expect("target");
    targets::save_choice(&target).expect("save");
    let raw = std::fs::read_to_string(config_dir.join("config.json")).expect("config");
    assert!(!raw.contains(secret));
    let saved = serde_json::from_str::<Value>(&raw).expect("json")["database"].clone();
    assert_eq!(saved["engine"], "postgresql");
    assert!(saved["password_enc"].as_str().is_some_and(|token| !token.is_empty()));
    let back = targets::saved_target().expect("saved");
    assert_eq!((back.password.as_deref(), back.ssl.as_str()), (Some(secret), "require"));
    let (resolved, source) = targets::resolve(&config_dir.join("kanban.db")).expect("resolve");
    assert_eq!((source, resolved.host.as_str()), ("settings", "db"));
    targets::save_choice(&Target::sqlite("x")).expect("save");
    let (resolved, source) = targets::resolve(&config_dir.join("kanban.db")).expect("resolve");
    assert_eq!((source, resolved.path), ("default", config_dir.join("kanban.db").to_string_lossy().into_owned()));
}

#[tokio::test]
async fn test_the_environment_wins_and_takes_the_password_variable() {
    let _serial = SERIAL.lock().await;
    let config_dir = config_dir();
    targets::save_choice(&targets::from_url("mysql://a:b\u{40}saved/x").expect("url")).expect("save");
    set_env(targets::ENV_URL, Some("postgresql://kanban@env-host/kanban"));
    set_env(targets::ENV_PASSWORD, Some(FROM_ENV));
    let (resolved, source) = targets::resolve(&config_dir.join("kanban.db")).expect("resolve");
    assert_eq!(
        (source, resolved.host.as_str(), resolved.password.as_deref()),
        ("environment", "env-host", Some(FROM_ENV))
    );
    set_env(targets::ENV_URL, None);
    set_env(targets::ENV_PASSWORD, None);
}

#[tokio::test]
async fn test_use_is_refused_while_the_environment_sets_the_database() {
    let _serial = SERIAL.lock().await;
    config_dir();
    set_env(targets::ENV_URL, Some("postgresql://kanban@env-host/kanban"));
    let err = database::use_target(&Target::sqlite("/tmp/x.db")).await.expect_err("locked");
    set_env(targets::ENV_URL, None);
    match err {
        DatabaseError::Schema(err) => assert_eq!(err.code, "locked"),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn test_sqlite_connections_wait_for_the_write_lock() {
    let tmp = tempfile::tempdir().expect("tmp");
    let engine = targets::make_engine(&Target::sqlite(tmp.path().join("a.db").to_string_lossy().into_owned()), None)
        .await
        .expect("engine");
    let pragma = |name: &'static str| {
        let engine = engine.clone();
        async move {
            let stmt = Statement::from_string(engine.get_database_backend(), format!("PRAGMA {name}"));
            engine
                .query_one_raw(stmt)
                .await
                .expect("pragma")
                .expect("a row")
                .try_get_by_index::<i64>(0)
                .expect("number")
        }
    };
    let timeout = pragma("busy_timeout").await;
    let sync = pragma("synchronous").await;
    let _ = engine.close().await;
    assert_eq!(timeout, targets::SQLITE_BUSY_TIMEOUT_S as i64 * 1000);
    assert_eq!(sync, 1); // NORMAL
}

/// The statement that makes `table` in a schema snapshot.
fn create_table<'a>(schema: &'a str, table: &str) -> &'a str {
    // a name that is a word of the engine's is quoted
    let start =
        [format!("CREATE TABLE {table} ("), format!("CREATE TABLE \"{table}\" ("), format!("CREATE TABLE `{table}` (")]
            .iter()
            .find_map(|head| schema.find(head.as_str()))
            .unwrap_or_else(|| panic!("no table {table}"));
    let end = schema[start..].find("\n\n").map(|n| start + n).unwrap_or(schema.len());
    &schema[start..end]
}

const SQLITE: &str = include_str!("../../kb-db/schema/sqlite.sql");
const POSTGRES: &str = include_str!("../../kb-db/schema/postgres.sql");
const MYSQL: &str = include_str!("../../kb-db/schema/mysql.sql");

#[test]
fn test_long_text_is_text_on_mysql_and_unchanged_elsewhere() {
    let my = create_table(MYSQL, "idea_ticket");
    assert!(my.contains("body LONGTEXT") && my.contains("id VARCHAR(255)"));
    assert!(create_table(SQLITE, "idea_ticket").contains("body VARCHAR"));
    assert!(create_table(POSTGRES, "idea_ticket").contains("body VARCHAR"));
    // and the metadata the copy code reads says the same
    let meta = kb_db::entities::table_meta("idea_ticket").expect("idea_ticket");
    assert!(meta.column("body").expect("body").long_text && !meta.column("id").expect("id").long_text);
}

#[test]
fn test_server_schema_keeps_tables_and_indexes_but_enforces_no_links() {
    for schema in [POSTGRES, MYSQL] {
        for table in kb_db::entities::TABLES {
            create_table(schema, table);
        }
        assert!(!schema.contains("FOREIGN KEY") && !schema.contains("REFERENCES"));
        for index in ["ix_member_project_id", "ix_ticket_project_status"] {
            assert!(schema.contains(&format!("INDEX {index} ON ")), "{index}");
        }
    }
    // SQLite keeps the links it always declared (and never enforced)
    assert!(SQLITE.contains("FOREIGN KEY"));
}

#[tokio::test]
async fn test_counter_bump_returns_the_new_value() {
    let tmp = tempfile::tempdir().expect("tmp");
    let engine = targets::make_engine(&Target::sqlite(tmp.path().join("c.db").to_string_lossy().into_owned()), None)
        .await
        .expect("engine");
    engine.execute_unprepared("CREATE TABLE c (id INTEGER PRIMARY KEY, n INTEGER, p TEXT)").await.expect("create");
    engine.execute_unprepared("INSERT INTO c VALUES (1, 4, 'KB')").await.expect("insert");
    let s = Session::new(engine.clone());
    let row = sql::bump_counter(&s, "c", "n", "id", 1.into(), &["p"]).await.expect("bump").expect("a row");
    assert_eq!(
        (row.try_get_by_index::<i64>(0).expect("n"), row.try_get_by_index::<String>(1).expect("p")),
        (5, "KB".into())
    );
    assert!(sql::bump_counter(&s, "c", "n", "id", 2.into(), &[]).await.expect("bump").is_none());
    drop(s);
    let _ = engine.close().await;
}
