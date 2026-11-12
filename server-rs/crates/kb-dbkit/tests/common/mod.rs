//! Shared by the database kit's tests: a board with rows in every table (made from the tables' metadata), dumps of
//! SQLite files and of server databases, and databases of the tests' own on the PostgreSQL and MariaDB test servers.
#![allow(dead_code)]

use std::path::Path;
use std::time::Duration;

use kb_db::entities::{ColumnMeta, META, TableMeta, table_meta};
use kb_db::sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use kb_db::targets::{self, Target};
use kb_dbkit::move_db::{Cell, Mover, model_default};
use serde_json::{Map, Value, json};
use sqlx::sqlite::{SqliteArguments, SqliteConnectOptions};
use sqlx::{Arguments, ConnectOptions, Connection, Row, SqliteConnection};
use testkit::Client;

/// Rows in every table.
pub const ROWS: usize = 4;
/// One table gets more rows than a batch holds.
pub const BULK_TABLE: &str = "notify_event";
pub const BULK_ROWS: usize = 1100;
pub const FTS_TABLES: [&str; 3] = ["docs_fts", "ai_run_fts", "kb_fts"];

// ---------------------------------------------------------------------------
// The test servers
// ---------------------------------------------------------------------------

/// `KANBAN_TEST_POSTGRES_URL` and `KANBAN_TEST_MYSQL_URL`, or `None` (after printing SKIPPED) when one is not set.
pub fn server_urls(test: &str) -> Option<(String, String)> {
    match (std::env::var("KANBAN_TEST_POSTGRES_URL"), std::env::var("KANBAN_TEST_MYSQL_URL")) {
        (Ok(pg), Ok(my)) if !pg.is_empty() && !my.is_empty() => Some((pg, my)),
        _ => {
            println!("SKIPPED {test}: KANBAN_TEST_POSTGRES_URL and KANBAN_TEST_MYSQL_URL are not set");
            None
        }
    }
}

/// The URL of a test server with another database name.
pub fn with_database(url: &str, name: &str) -> String {
    let (head, query) = match url.split_once('?') {
        Some((head, query)) => (head, format!("?{query}")),
        None => (url, String::new()),
    };
    let base = head.rsplit_once('/').map(|(base, _)| base).unwrap_or(head);
    format!("{base}/{name}{query}")
}

async fn admin(url: &str) -> DatabaseConnection {
    let target = targets::from_url(url).expect("a test database URL");
    targets::make_engine(&target, Some("test")).await.expect("engine")
}

/// A database of this test's own on the server of `url` (the database the URL names stays untouched), empty. The
/// name must start with `kanban_dbkit_`: the MariaDB test user may create such databases once an administrator ran
/// ``GRANT ALL ON `kanban\_dbkit\_%`.* TO 'kanban'@'127.0.0.1'``.
pub async fn own_database(url: &str, name: &str) -> String {
    assert!(name.starts_with("kanban_dbkit_"), "{name}");
    let conn = admin(url).await;
    let backend = conn.get_database_backend();
    if backend == DbBackend::Postgres {
        let found = conn
            .query_one_raw(Statement::from_string(backend, format!("SELECT 1 FROM pg_database WHERE datname = '{name}'")))
            .await
            .expect("pg_database");
        if found.is_none() {
            conn.execute_unprepared(&format!("CREATE DATABASE \"{name}\" ENCODING 'UTF8' TEMPLATE template0"))
                .await
                .expect("CREATE DATABASE");
        }
    } else {
        conn.execute_unprepared(&format!("CREATE DATABASE IF NOT EXISTS `{name}` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"))
            .await
            .unwrap_or_else(|e| {
                panic!(
                    "CREATE DATABASE {name}: {e}\nThe test user needs: \
                     GRANT ALL ON `kanban\\_dbkit\\_%`.* TO 'kanban'@'127.0.0.1';"
                )
            });
    }
    let _ = conn.close().await;
    let own = with_database(url, name);
    wipe(&own).await;
    own
}

/// Drop every table of a database (`_wipe` of the Python tests).
pub async fn wipe(url: &str) {
    let target = targets::from_url(url).expect("a test database URL");
    let nowhere = Target::sqlite("/nonexistent/x.db");
    let mut m = Mover::new(nowhere, target, None).await.expect("mover");
    m.empty_target().await.expect("empty the test database");
    m.close().await;
}

// ---------------------------------------------------------------------------
// A board with rows in every table
// ---------------------------------------------------------------------------

const VIETNAMESE: &str = "Tiếng Việt có dấu: Đặng Thị Hồng Nhung ở Hà Nội";
const MIXED: &str = "ünïcödé 移动应用 Ελληνικά 🎯🚀🛰️ ";

/// Text of more than 64 KB (70,000 characters, most of them longer than one byte).
pub fn long_text(seed: usize) -> String {
    let unit = format!("{VIETNAMESE} · {MIXED}· row {seed} · PostgreSQL MySQL SQLite\n");
    unit.chars().cycle().take(70_000).collect()
}

fn medium_text(column: &str, i: usize) -> String {
    let unit = format!("{column} {i}: {VIETNAMESE} {MIXED}");
    unit.chars().cycle().take(400).collect()
}

/// The primary key of row `i`.
fn key_value(table: &TableMeta, column: &ColumnMeta, i: usize) -> Value {
    match column.kind {
        "int" | "bigint" => json!(i as i64 + 1),
        _ => json!(format!("{}:{}:{i}", table.name, column.name)),
    }
}

/// The value of one column of row `i`: every kind, NULL where allowed (row 1), empty text (row 2), the largest and
/// the smallest numbers every engine holds (rows 0 and 1), Unicode, and one text of more than 64 KB per table.
fn column_value(table: &TableMeta, column: &ColumnMeta, i: usize, first_long: bool) -> Value {
    if column.primary_key {
        return key_value(table, column, i);
    }
    if column.nullable && i == 1 {
        return Value::Null;
    }
    if let Some((parent, parent_column)) = column.foreign_key {
        // rows 0 to 2 point at a row that is there; the others at one that is not
        if i < 3 {
            if let Some(parent_meta) = table_meta(parent) {
                if let Some(target) = parent_meta.column(parent_column) {
                    return key_value(parent_meta, target, i);
                }
            }
        }
        return match column.kind {
            "int" | "bigint" => json!(900_000 + i as i64),
            _ => json!(format!("gone:{}:{i}", column.name)),
        };
    }
    match column.kind {
        "bool" => json!(i % 2 == 0),
        "int" | "bigint" => match i {
            0 => json!(i32::MAX),
            1 => json!(i32::MIN),
            2 => json!(0),
            _ => json!(i as i64 * 7 - 3),
        },
        // what MySQL's FLOAT holds exactly enough to give back: six digits
        "float" => match i {
            0 => json!(3.40282e38),
            1 => json!(-3.40282e38),
            2 => json!(0.0),
            3 => json!(1.17550e-38),
            _ => json!(i as f64 * 1.5),
        },
        _ => {
            // a column that holds JSON gets JSON (the knowledge index reads `ai_knowledge_doc.keywords`)
            let holds = model_default(table.name, column.name).and_then(|d| match d {
                Cell::Text(text) if text == "[]" || text == "{}" => Some(text),
                _ => None,
            });
            match (holds.as_deref(), i) {
                (Some(empty), 2) => json!(empty),
                (Some("[]"), 0) if column.long_text && first_long => {
                    json!(kb_base::pyjson::dumps(&json!(["một", "hai 🎯", long_text(i)])))
                }
                (Some("[]"), _) => json!(kb_base::pyjson::dumps(&json!([format!("{} {i}", column.name), "hai 🎯"]))),
                (Some(_), _) => json!(kb_base::pyjson::dumps(&json!({"k": format!("{} {i} 🎯", column.name)}))),
                (None, 2) => json!(""),
                (None, 0) if column.long_text && first_long => json!(long_text(i)),
                (None, _) if column.long_text => json!(medium_text(column.name, i)),
                // a key or an indexed column: VARCHAR(255) on MySQL
                (None, 1) => json!(format!("{} {i} {VIETNAMESE} 🎯", column.name)),
                (None, _) => json!(format!("{} {i} plain", column.name)),
            }
        }
    }
}

/// Row `i` of a table, in column order.
pub fn row_values(table: &TableMeta, i: usize) -> Vec<Value> {
    let first_long = table.columns.iter().position(|c| c.long_text && !c.primary_key);
    table
        .columns
        .iter()
        .enumerate()
        .map(|(at, column)| {
            if i >= ROWS {
                // the many small rows of the bulk table
                if column.primary_key {
                    return key_value(table, column, i);
                }
                return match column.kind {
                    "bool" => json!(i % 3 == 0),
                    "int" | "bigint" => json!(i as i64),
                    "float" => json!(i as f64 * 0.5),
                    _ => json!(format!("{} {i}", column.name)),
                };
            }
            column_value(table, column, i, first_long == Some(at))
        })
        .collect()
}

fn arguments(params: &[Value]) -> SqliteArguments {
    let mut args = SqliteArguments::default();
    for p in params {
        match p {
            Value::Null => args.add(Option::<String>::None),
            Value::Bool(b) => args.add(*b),
            Value::Number(n) if n.is_i64() => args.add(n.as_i64()),
            Value::Number(n) => args.add(n.as_f64()),
            Value::String(s) => args.add(s.clone()),
            other => args.add(other.to_string()),
        }
        .expect("bind");
    }
    args
}

/// A connection to a SQLite file (WAL: a server that uses the file keeps serving).
pub async fn sqlite(path: &Path) -> SqliteConnection {
    SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        // as the app opens it: links between tables are not enforced
        .foreign_keys(false)
        .busy_timeout(Duration::from_secs(30))
        .disable_statement_logging()
        .connect()
        .await
        .unwrap_or_else(|e| panic!("open {}: {e}", path.display()))
}

/// Run one statement with `?` parameters on a SQLite file.
pub async fn sqlite_exec(path: &Path, sql: &str, params: &[Value]) {
    let mut c = sqlite(path).await;
    sqlx::query_with(sqlx::AssertSqlSafe(sql.to_string()), arguments(params))
        .execute(&mut c)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
    let _ = c.close().await;
}

/// The first value of the first row of a query on a SQLite file, as JSON.
pub async fn sqlite_scalar(path: &Path, sql: &str) -> Value {
    let mut c = sqlite(path).await;
    let row = sqlx::query(sqlx::AssertSqlSafe(format!("SELECT json_array(({sql}))")))
        .fetch_one(&mut c)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
    let text: String = row.get(0);
    let _ = c.close().await;
    serde_json::from_str::<Value>(&text).expect("json")[0].clone()
}

async fn insert(c: &mut SqliteConnection, table: &str, names: &[&str], values: &[Value]) {
    let columns: Vec<String> = names.iter().map(|n| format!("\"{n}\"")).collect();
    let sql =
        format!("INSERT INTO \"{table}\" ({}) VALUES ({})", columns.join(", "), vec!["?"; names.len()].join(", "));
    sqlx::query_with(sqlx::AssertSqlSafe(sql.clone()), arguments(values))
        .execute(&mut *c)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
}

/// Fill a SQLite board (at the newest migration, any rows it had are removed) with rows in every table and in the
/// three FTS tables.
pub async fn fill(path: &Path) {
    let mut c = sqlite(path).await;
    sqlx::query("BEGIN IMMEDIATE").execute(&mut c).await.expect("begin");
    for table in META {
        sqlx::query(sqlx::AssertSqlSafe(format!("DELETE FROM \"{}\"", table.name))).execute(&mut c).await.expect("delete");
        let names: Vec<&str> = table.columns.iter().map(|c| c.name).collect();
        let rows = if table.name == BULK_TABLE { ROWS + BULK_ROWS } else { ROWS };
        for i in 0..rows {
            insert(&mut c, table.name, &names, &row_values(table, i)).await;
        }
    }
    for fts in FTS_TABLES {
        sqlx::query(sqlx::AssertSqlSafe(format!("DELETE FROM {fts}"))).execute(&mut c).await.expect("delete");
    }
    // the knowledge index as the board (and a copy from a server database) builds it from `ai_knowledge_doc`
    let docs = table_meta("ai_knowledge_doc").expect("ai_knowledge_doc");
    for i in 0..ROWS {
        let row = row_values(docs, i);
        let get = |name: &str| {
            let at = docs.columns.iter().position(|c| c.name == name).expect("column");
            row[at].clone()
        };
        let text = |name: &str| get(name).as_str().unwrap_or("").to_string();
        let keywords = Some(text("keywords")).filter(|k| !k.is_empty()).unwrap_or_else(|| "[]".into());
        let keywords: Vec<String> = serde_json::from_str(&keywords).expect("keywords are a list of words");
        insert(
            &mut c,
            "kb_fts",
            &["doc_id", "project_id", "store", "title", "summary", "keywords", "body"],
            &[
                get("id"),
                json!(text("project_id")),
                get("store"),
                get("title"),
                json!(text("summary")),
                json!(keywords.join(" ")),
                json!(text("text")),
            ],
        )
        .await;
    }
    for i in 0..3 {
        insert(
            &mut c,
            "docs_fts",
            &["page_id", "project_id", "title", "headings", "body"],
            &[
                json!(format!("docs_page:id:{i}")),
                json!(format!("project:id:{i}")),
                json!(format!("Architecture {i} {VIETNAMESE}")),
                json!("Why Storage"),
                json!(format!("SQLite by default. PostgreSQL 14+. {MIXED}")),
            ],
        )
        .await;
    }
    for i in 0..2 {
        insert(
            &mut c,
            "ai_run_fts",
            &["run_id", "project_id", "body"],
            &[json!(format!("ai_run:id:{i}")), json!(format!("project:id:{i}")), json!(format!("transcript {i} 🎯 {VIETNAMESE}"))],
        )
        .await;
    }
    sqlx::query("COMMIT").execute(&mut c).await.expect("commit");
    let _ = c.close().await;
}

/// A new SQLite board at the newest migration, filled (`_board` of the Python tests).
pub async fn board(path: &Path) -> Target {
    let src = Target::sqlite(path.to_string_lossy().into_owned());
    let unused = Target::sqlite(path.with_extension("unused").to_string_lossy().into_owned());
    let mut m = Mover::new(unused, src.clone(), None).await.expect("mover");
    m.prepare_target(false, false).await.expect("a new board file"); // the tables, as the app makes a new file
    m.close().await;
    fill(path).await;
    src
}

// ---------------------------------------------------------------------------
// Dumps
// ---------------------------------------------------------------------------

/// Every table of a SQLite file -> rows as objects, rows sorted by all columns (as `testkit`'s `dump_db`, for any
/// file). Blobs are hex strings.
pub async fn dump_sqlite(path: &Path) -> Map<String, Value> {
    let mut c = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .disable_statement_logging()
        .connect()
        .await
        .unwrap_or_else(|e| panic!("open {}: {e}", path.display()));
    let tables: Vec<String> =
        sqlx::query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .fetch_all(&mut c)
            .await
            .expect("list tables")
            .iter()
            .map(|r| r.get::<String, _>(0))
            .collect();
    let mut out = Map::new();
    for t in tables {
        let cols: Vec<String> = sqlx::query(sqlx::AssertSqlSafe(format!("PRAGMA table_info(\"{t}\")")))
            .fetch_all(&mut c)
            .await
            .expect("table_info")
            .iter()
            .map(|r| r.get::<String, _>("name"))
            .collect();
        let pairs: Vec<String> = cols
            .iter()
            .map(|n| format!("'{}', CASE WHEN typeof(\"{n}\")='blob' THEN hex(\"{n}\") ELSE \"{n}\" END", n.replace('\'', "''")))
            .collect();
        let order: Vec<String> = cols.iter().map(|n| format!("\"{n}\"")).collect();
        let sql = format!(
            "SELECT json_object({}) FROM \"{t}\" ORDER BY {}",
            pairs.join(", "),
            if order.is_empty() { "1".to_string() } else { order.join(", ") }
        );
        let rows: Vec<Value> = sqlx::query(sqlx::AssertSqlSafe(sql))
            .fetch_all(&mut c)
            .await
            .unwrap_or_else(|e| panic!("dump {t}: {e}"))
            .iter()
            .map(|r| serde_json::from_str(&r.get::<String, _>(0)).expect("row json"))
            .collect();
        out.insert(t, Value::Array(rows));
    }
    let _ = c.close().await;
    out
}

/// The tables of a board in a dump: the app's own, the stamp, and the three search tables (not what SQLite keeps
/// inside an FTS index, which depends on how it was written).
pub fn board_tables(dump: &Map<String, Value>) -> Map<String, Value> {
    dump.iter()
        .filter(|(name, _)| !FTS_TABLES.iter().any(|f| name.starts_with(&format!("{f}_"))))
        .map(|(name, rows)| (name.clone(), rows.clone()))
        .collect()
}

/// Every table of a PostgreSQL or MySQL database -> its rows as JSON text the server itself wrote, in the order of
/// the primary key. The change log is left out (it is not data).
pub async fn dump_server(url: &str) -> Map<String, Value> {
    let conn = admin(url).await;
    let backend = conn.get_database_backend();
    let listing = if backend == DbBackend::Postgres {
        "SELECT table_name::text FROM information_schema.tables \
         WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name"
    } else {
        "SELECT table_name FROM information_schema.tables \
         WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name"
    };
    let mut names = Vec::new();
    for row in conn.query_all_raw(Statement::from_string(backend, listing)).await.expect("tables") {
        names.push(row.try_get_by_index::<String>(0).expect("table name"));
    }
    let mut out = Map::new();
    for name in names {
        if name == "kanban_change" {
            continue;
        }
        let (columns, order): (Vec<&str>, Vec<&str>) = match table_meta(&name) {
            Some(meta) => (
                meta.columns.iter().map(|c| c.name).collect(),
                meta.columns.iter().filter(|c| c.primary_key).map(|c| c.name).collect(),
            ),
            None => (vec!["version_num"], vec!["version_num"]),
        };
        let sql = if backend == DbBackend::Postgres {
            format!(
                "SELECT row_to_json(t)::text FROM (SELECT {} FROM \"{name}\") t ORDER BY {}",
                columns.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", "),
                order.iter().map(|c| format!("t.\"{c}\"")).collect::<Vec<_>>().join(", ")
            )
        } else {
            format!(
                "SELECT CAST(JSON_OBJECT({}) AS CHAR) FROM `{name}` ORDER BY {}",
                columns.iter().map(|c| format!("'{c}', `{c}`")).collect::<Vec<_>>().join(", "),
                order.iter().map(|c| format!("`{c}`")).collect::<Vec<_>>().join(", ")
            )
        };
        let rows: Vec<Value> = conn
            .query_all_raw(Statement::from_string(backend, sql.clone()))
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"))
            .iter()
            .map(|row| Value::String(row.try_get_by_index::<String>(0).expect("row text")))
            .collect();
        out.insert(name, Value::Array(rows));
    }
    let _ = conn.close().await;
    out
}

/// Assert two dumps hold the same tables with the same rows, naming the first table and row that differ (a whole
/// dump is too long to print).
pub fn assert_same_dump(what: &str, a: &Map<String, Value>, b: &Map<String, Value>) {
    let names = |d: &Map<String, Value>| d.keys().cloned().collect::<Vec<_>>();
    assert_eq!(names(a), names(b), "{what}: the tables differ");
    for (name, rows) in a {
        let (left, right) = (rows.as_array().expect("rows"), b[name].as_array().expect("rows"));
        assert_eq!(left.len(), right.len(), "{what}: {name} has {} and {} rows", left.len(), right.len());
        for (i, (x, y)) in left.iter().zip(right).enumerate() {
            if x != y {
                // where the two rows part, with a little around it
                let (x, y) = (x.to_string(), y.to_string());
                let at = x.chars().zip(y.chars()).position(|(p, q)| p != q).unwrap_or(0);
                let show = |text: &str| text.chars().skip(at.saturating_sub(120)).take(300).collect::<String>();
                panic!("{what}: row {i} of {name} differs at character {at}:\n  {}\n  {}", show(&x), show(&y));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The wizard's routes
// ---------------------------------------------------------------------------

/// `_wait(client, *states)`: poll the move until it is in one of `states`.
pub async fn wait(client: &Client, states: &[&str]) -> Value {
    let mut job = Value::Null;
    for _ in 0..1200 {
        job = client.get("/database/move").await.json();
        if states.contains(&job["state"].as_str().unwrap_or("")) && job["ai"]["state"] != "asking" {
            return job;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("still {}: {job}", job["state"]);
}

/// The options every server of these tests starts with: the key that encrypts a saved password is the test's own
/// file, never the person's.
pub fn options(key_dir: &Path) -> testkit::Options {
    testkit::Options {
        env: vec![("KANBAN_AI_KEY_FILE".into(), key_dir.join("ai-secret.key").to_string_lossy().into_owned())],
        ..testkit::Options::default()
    }
}
