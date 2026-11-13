//! What the migration differential tests share: the fixtures and expected results made by
//! `contract/migrations/gen_fixtures.py`, writing down what a database holds (the queries of
//! `contract/migrations/dump_queries.json`, the same ones the generator asked through Python), and comparing.

#![allow(dead_code)] // each test binary uses its part

use std::collections::BTreeMap;
use std::io::Read as _;
use std::path::{Path, PathBuf};

use kb_db::sea_orm::{ConnectionTrait, DatabaseConnection, Statement};
use serde_json::Value;

/// `server/contract/migrations`.
pub fn contract_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contract/migrations").canonicalize().unwrap()
}

/// The chain's revisions, oldest first.
pub fn revisions() -> Vec<&'static str> {
    kb_db::schema::CHAIN.iter().map(|r| r.id).collect()
}

/// A gzip file, unpacked.
pub fn read_gz(path: &Path) -> Vec<u8> {
    let raw = std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(raw.as_slice()).read_to_end(&mut out).unwrap();
    out
}

/// The expected result of one fixture, as the generator saved it.
pub fn expected(engine_folder: &str, name: &str) -> Value {
    let path = contract_dir().join("expected").join(engine_folder).join(format!("{name}.json.gz"));
    serde_json::from_slice(&read_gz(&path)).unwrap()
}

/// The names of the fixtures of one engine (file names without `.db.gz` / `.sql.gz`), sorted.
pub fn fixture_names(engine_folder: &str) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(contract_dir().join("fixtures").join(engine_folder))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter_map(|file| file.strip_suffix(".db.gz").or_else(|| file.strip_suffix(".sql.gz")).map(str::to_string))
        .collect();
    names.sort();
    names
}

async fn rows(conn: &DatabaseConnection, sql: &str) -> Vec<Vec<Option<String>>> {
    let found = conn
        .query_all_raw(Statement::from_string(conn.get_database_backend(), sql))
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
    found
        .iter()
        .map(|row| {
            (0..row.column_names().len())
                .map(|i| row.try_get_by_index::<Option<String>>(i).unwrap_or_else(|e| panic!("{sql} [{i}]: {e}")))
                .collect()
        })
        .collect()
}

fn as_json(rows: Vec<Vec<Option<String>>>) -> Value {
    Value::Array(
        rows.into_iter()
            .map(|row| {
                Value::Array(row.into_iter().map(|cell| cell.map(Value::String).unwrap_or(Value::Null)).collect())
            })
            .collect(),
    )
}

/// What the database holds, in the shape of the generator's `dump()`:
/// `{"schema": {query: rows}, "data": {table: {"columns": [...], "rows": [...]}}}`, every value text or null.
pub async fn dump(conn: &DatabaseConnection, dialect: &str) -> Value {
    let all: Value = serde_json::from_slice(&std::fs::read(contract_dir().join("dump_queries.json")).unwrap()).unwrap();
    let q = &all[dialect];
    let text = |key: &str| q[key].as_str().unwrap().to_string();
    let mut schema = serde_json::Map::new();
    for (name, sql) in q["schema"].as_object().unwrap() {
        schema.insert(name.clone(), as_json(rows(conn, sql.as_str().unwrap()).await));
    }
    let mut data = serde_json::Map::new();
    for table in rows(conn, &text("tables")).await {
        let table = table[0].clone().unwrap();
        let columns: Vec<String> = rows(conn, &text("columns").replace("{table}", &table))
            .await
            .into_iter()
            .map(|row| row[0].clone().unwrap())
            .collect();
        let cells: Vec<String> = columns.iter().map(|c| text("cell").replace("{column}", c)).collect();
        let sql = format!("SELECT {} FROM {}", cells.join(", "), text("from").replace("{table}", &table));
        data.insert(table, serde_json::json!({"columns": columns, "rows": as_json(rows(conn, &sql).await)}));
    }
    serde_json::json!({"schema": schema, "data": data})
}

fn sort_rows(rows: &mut Value) {
    if let Some(list) = rows.as_array_mut() {
        list.sort_by_key(|row| row.to_string());
    }
}

/// Put both sides in one order: the order a query without ORDER BY gives rows in is not part of the result.
pub fn sort(dump: &mut Value) {
    if let Some(schema) = dump["schema"].as_object_mut() {
        for rows in schema.values_mut() {
            sort_rows(rows);
        }
    }
    if let Some(data) = dump["data"].as_object_mut() {
        for table in data.values_mut() {
            sort_rows(&mut table["rows"]);
        }
    }
}

fn row_set(rows: &Value) -> BTreeMap<String, usize> {
    let mut out = BTreeMap::new();
    for row in rows.as_array().map(Vec::as_slice).unwrap_or(&[]) {
        *out.entry(row.to_string()).or_insert(0) += 1;
    }
    out
}

fn short(text: &str) -> String {
    let cut: String = text.chars().take(300).collect();
    if cut.len() < text.len() { format!("{cut}…") } else { cut }
}

fn describe_rows(what: &str, columns: Option<&Value>, expected: &Value, actual: &Value, out: &mut Vec<String>) {
    if expected == actual {
        return;
    }
    let before = out.len();
    let (want, got) = (row_set(expected), row_set(actual));
    let only = |a: &BTreeMap<String, usize>, b: &BTreeMap<String, usize>| -> Vec<Value> {
        a.iter()
            .filter(|(row, n)| b.get(*row).copied().unwrap_or(0) < **n)
            .map(|(row, _)| serde_json::from_str(row).unwrap())
            .collect()
    };
    let (mut python, mut rust) = (only(&want, &got), only(&got, &want));
    // rows with the same first value (the key, in most tables) are shown cell by cell
    let mut shown = 0;
    python.retain(|p| {
        let Some(at) =
            rust.iter().position(|r| r[0] == p[0] && r.as_array().map(Vec::len) == p.as_array().map(Vec::len))
        else {
            return true;
        };
        let r = rust.remove(at);
        if shown < 6 {
            for (i, (a, b)) in p.as_array().unwrap().iter().zip(r.as_array().unwrap()).enumerate() {
                if a != b {
                    let column =
                        columns.and_then(|c| c[i].as_str()).map(str::to_string).unwrap_or_else(|| format!("#{i}"));
                    out.push(format!(
                        "{what} [{}] {column}:\n        Python {}\n        Rust   {}",
                        short(&p[0].to_string()),
                        short(&a.to_string()),
                        short(&b.to_string())
                    ));
                }
            }
        }
        shown += 1;
        false
    });
    for row in python.iter().take(4) {
        out.push(format!("{what}: only Python has {}", short(&row.to_string())));
    }
    for row in rust.iter().take(4) {
        out.push(format!("{what}: only Rust has   {}", short(&row.to_string())));
    }
    let more = shown.max(6) - 6 + python.len().max(4) - 4 + rust.len().max(4) - 4;
    if more > 0 {
        out.push(format!("{what}: and {more} more rows"));
    }
    if out.len() == before {
        out.push(format!("{what}: differs"));
    }
}

/// The differences between the expected result (Python) and the actual one (Rust), in words; empty when equal.
/// Both must have been through `sort`.
pub fn differences(expected: &Value, actual: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if expected == actual {
        return out;
    }
    let empty = serde_json::Map::new();
    let (want, got) =
        (expected["schema"].as_object().unwrap_or(&empty), actual["schema"].as_object().unwrap_or(&empty));
    for name in want.keys().chain(got.keys().filter(|k| !want.contains_key(*k))) {
        describe_rows(
            &format!("schema/{name}"),
            None,
            &want.get(name).cloned().unwrap_or_default(),
            &got.get(name).cloned().unwrap_or_default(),
            &mut out,
        );
    }
    let (want, got) = (expected["data"].as_object().unwrap_or(&empty), actual["data"].as_object().unwrap_or(&empty));
    for table in want.keys().chain(got.keys().filter(|k| !want.contains_key(*k))) {
        match (want.get(table), got.get(table)) {
            (Some(_), None) => out.push(format!("table {table}: only Python has it")),
            (None, Some(_)) => out.push(format!("table {table}: only Rust has it")),
            (Some(w), Some(g)) => {
                if w["columns"] != g["columns"] {
                    out.push(format!("table {table}: columns {} / {}", w["columns"], g["columns"]));
                } else {
                    describe_rows(&format!("rows of {table}"), Some(&w["columns"]), &w["rows"], &g["rows"], &mut out);
                }
            }
            (None, None) => {}
        }
    }
    if out.is_empty() {
        out.push("the results differ".to_string());
    }
    out
}

// ---------------------------------------------------------------------------
// PostgreSQL and MySQL/MariaDB
// ---------------------------------------------------------------------------

/// The differential's own database on the test server, so `kanban_test` stays empty.
pub const SERVER_DATABASE: &str = "kanban_dbkit_migdiff";

async fn drop_tables(conn: &DatabaseConnection, mysql: bool) {
    for table in kb_db::schema::table_names(conn).await.unwrap() {
        let statement = if mysql { format!("DROP TABLE `{table}`") } else { format!("DROP TABLE \"{table}\" CASCADE") };
        conn.execute_unprepared(&statement).await.unwrap();
    }
}

/// The differential over the revisions a server database can be stamped with (`migrations::SERVER_BASE` and every
/// later one). The fixtures are SQL: a database made by the Python sources of the app version that had that head
/// (3.37.0 for `e8b0d2f4a6c9`, 3.37.1 for `f1c3e5a7b9d2`; the revisions between that and the head were only ever
/// reached by upgrading, so they are a 3.37.1 database the Python server upgraded that far), with sample rows.
/// Nothing is allowed to differ: none of these migrations reads the clock or makes an id.
#[allow(unsafe_code)]
pub async fn server_differential(url: &str, folder: &str, dialect: &str) {
    use kb_db::{database, migrations, schema, targets};

    let mysql = dialect == "mysql";
    let given = targets::from_url(url).unwrap();
    let admin = targets::make_engine(&given, None).await.unwrap();
    admin.execute_unprepared(&format!("DROP DATABASE IF EXISTS {SERVER_DATABASE}")).await.unwrap();
    admin.execute_unprepared(&format!("CREATE DATABASE {SERVER_DATABASE}")).await.unwrap();
    let mut own = given.clone();
    own.name = SERVER_DATABASE.to_string();

    let dir = tempfile::tempdir().unwrap();
    // This test is the only one in its process; the settings are in place before anything reads them.
    unsafe {
        std::env::set_var("KANBAN_CONFIG_DIR", dir.path().join("config"));
        std::env::set_var("KANBAN_DB_PATH", dir.path().join("data").join("kanban.db"));
        std::env::set_var("KANBAN_DATABASE_URL", own.url(false));
    }
    database::setup().await.unwrap();
    assert_eq!(database::dialect(), dialect);
    let conn = database::conn();

    let names = fixture_names(folder);
    let server_range: Vec<&str> = revisions()
        .into_iter()
        .filter(|id| *id == migrations::SERVER_BASE || migrations::runs_on_servers(id))
        .collect();
    assert_eq!(server_range.len(), 10);
    assert_eq!(names.len(), 10);
    let mut failures: Vec<String> = Vec::new();
    for revision in &server_range {
        assert!(names.iter().any(|n| n == revision), "no fixture for {revision}");
        drop_tables(&conn, mysql).await;
        let script = read_gz(&contract_dir().join("fixtures").join(folder).join(format!("{revision}.sql.gz")));
        conn.execute_unprepared(std::str::from_utf8(&script).unwrap())
            .await
            .unwrap_or_else(|e| panic!("{revision}: {e}"));
        assert_eq!(schema::current_revisions(&conn).await.unwrap(), [*revision]);

        if let Err(err) = database::init_db().await {
            failures.push(format!("{revision}: the upgrade failed: {err}"));
            continue;
        }
        assert_eq!(schema::current_revisions(&conn).await.unwrap(), [schema::head_revision()], "{revision}");
        let mut actual = dump(&conn, dialect).await;
        let mut wanted = expected(folder, revision);
        sort(&mut actual);
        sort(&mut wanted);
        let found = differences(&wanted, &actual);
        if !found.is_empty() {
            failures.push(format!("{revision}:\n    {}", found.join("\n    ")));
        }
        // a second start changes nothing
        database::init_db().await.unwrap();
    }
    let shown: Vec<&str> = failures.iter().take(6).map(String::as_str).collect();
    assert!(
        failures.is_empty(),
        "{} of {} fixtures differ; the first:\n{}",
        failures.len(),
        names.len(),
        shown.join("\n")
    );

    // A stamp older than the first app that could use a server database: refused with a clear error, nothing changed
    conn.execute_unprepared("UPDATE alembic_version SET version_num = 'c4e6a8b0d2f1'").await.unwrap();
    let mut before = dump(&conn, dialect).await;
    let refused = database::init_db().await.unwrap_err();
    match &refused {
        database::DatabaseError::Schema(err) => {
            assert_eq!(err.code, "older");
            assert!(err.message.contains("c4e6a8b0d2f1") && err.message.contains("PostgreSQL or MySQL"), "{err}");
        }
        other => panic!("{other:?}"),
    }
    let mut after = dump(&conn, dialect).await;
    sort(&mut before);
    sort(&mut after);
    assert_eq!(before, after);

    drop_tables(&conn, mysql).await;
    let _ = conn.close().await;
    admin.execute_unprepared(&format!("DROP DATABASE IF EXISTS {SERVER_DATABASE}")).await.ok();
    println!("{} {dialect} fixtures upgraded to the same database as under Python", names.len());
}
