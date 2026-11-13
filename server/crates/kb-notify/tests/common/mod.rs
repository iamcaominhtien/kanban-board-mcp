//! Helpers of the HTTP tests: rows written straight into the server's SQLite file, in the stored formats, for what
//! the routes of other areas (tickets, projects, AI runs) would create.

#![allow(dead_code)]

use std::str::FromStr;
use std::time::Duration;

use serde_json::{Value, json};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use testkit::Server;

/// A connection to the server's database (WAL, waits for the server's write lock).
pub async fn pool(server: &Server) -> SqlitePool {
    let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", server.db_path().display()))
        .expect("database url")
        .busy_timeout(Duration::from_secs(20))
        .foreign_keys(false)
        .create_if_missing(false);
    SqlitePoolOptions::new().max_connections(2).connect_with(options).await.expect("open the server's database")
}

/// `datetime.now(UTC).isoformat()` shifted by `seconds` (negative: in the past).
pub fn at(seconds: i64) -> String {
    let now = chrono::Utc::now() + chrono::Duration::seconds(seconds);
    kb_base::time::iso(&now)
}

/// A project row.
pub async fn project(pool: &SqlitePool, id: &str, name: &str) {
    sqlx::query(
        "INSERT INTO project (id, name, prefix, color, ticket_counter, repo_path, worktree_template, \
         worktree_by_default, docs_enabled, docs_edit_policy) VALUES (?, ?, ?, '#336699', 0, NULL, NULL, 0, 1, 'members')",
    )
    .bind(id)
    .bind(name)
    .bind(id.to_uppercase())
    .execute(pool)
    .await
    .expect("insert project");
}

/// A member row (`kind` human or ai, `role` viewer, member, admin or owner).
pub async fn member(pool: &SqlitePool, id: &str, project_id: &str, name: &str, kind: &str, role: &str) {
    sqlx::query(
        "INSERT INTO member (id, project_id, name, color, role, kind, created_at) VALUES (?, ?, ?, '#112233', ?, ?, ?)",
    )
    .bind(id)
    .bind(project_id)
    .bind(name)
    .bind(role)
    .bind(kind)
    .bind(at(-3600))
    .execute(pool)
    .await
    .expect("insert member");
}

/// A row of the event log; returns its id.
pub struct Event {
    pub project_id: Option<String>,
    pub kind: String,
    pub op: String,
    pub needs: bool,
    pub target_kind: Option<String>,
    pub target_id: Option<String>,
    pub ticket_id: Option<String>,
    pub actor: Option<String>,
    pub title: String,
    pub body: String,
    pub data: String,
    pub recipients: String,
    pub created_at: String,
}

impl Event {
    pub fn new(kind: &str, title: &str) -> Self {
        Event {
            project_id: None,
            kind: kind.into(),
            op: "new".into(),
            needs: false,
            target_kind: None,
            target_id: None,
            ticket_id: None,
            actor: None,
            title: title.into(),
            body: String::new(),
            data: "{}".into(),
            recipients: "[]".into(),
            created_at: at(-60),
        }
    }

    pub async fn insert(&self, pool: &SqlitePool) -> i64 {
        sqlx::query(
            "INSERT INTO notify_event (project_id, kind, op, needs, target_kind, target_id, ticket_id, page_id, member_id, \
             actor, title, body, data, recipients, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&self.project_id)
        .bind(&self.kind)
        .bind(&self.op)
        .bind(self.needs)
        .bind(&self.target_kind)
        .bind(&self.target_id)
        .bind(&self.ticket_id)
        .bind(&self.actor)
        .bind(&self.title)
        .bind(&self.body)
        .bind(&self.data)
        .bind(&self.recipients)
        .bind(&self.created_at)
        .execute(pool)
        .await
        .expect("insert event")
        .last_insert_rowid()
    }
}

/// A notification row, with the defaults of the Python model.
#[derive(Clone)]
pub struct Nrow {
    pub id: String,
    pub recipient: String,
    pub event_id: i64,
    pub last_event_id: i64,
    pub project_id: Option<String>,
    pub kind: String,
    pub needs: bool,
    pub group_key: String,
    pub count: i64,
    pub items: String,
    pub target_kind: Option<String>,
    pub target_id: Option<String>,
    pub ticket_id: Option<String>,
    pub page_id: Option<String>,
    pub member_id: Option<String>,
    pub actor: Option<String>,
    pub title: String,
    pub body: String,
    pub data: String,
    pub inapp: bool,
    pub desktop: bool,
    pub read_at: Option<String>,
    pub done_at: Option<String>,
    pub done_reason: Option<String>,
    pub done_by: Option<String>,
    pub snoozed_until: Option<String>,
    pub cleared_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Nrow {
    pub fn new(id: &str, kind: &str, needs: bool, title: &str) -> Self {
        Nrow {
            id: id.into(),
            recipient: "user".into(),
            event_id: 1,
            last_event_id: 1,
            project_id: None,
            kind: kind.into(),
            needs,
            group_key: format!("{kind}:-"),
            count: 1,
            items: "[]".into(),
            target_kind: None,
            target_id: None,
            ticket_id: None,
            page_id: None,
            member_id: None,
            actor: None,
            title: title.into(),
            body: String::new(),
            data: "{}".into(),
            inapp: true,
            desktop: false,
            read_at: None,
            done_at: None,
            done_reason: None,
            done_by: None,
            snoozed_until: None,
            cleared_at: None,
            created_at: at(-120),
            updated_at: at(-120),
        }
    }

    pub async fn insert(&self, pool: &SqlitePool) {
        sqlx::query(
            "INSERT INTO notification (id, recipient, event_id, last_event_id, project_id, kind, needs, group_key, count, \
             items, target_kind, target_id, ticket_id, page_id, member_id, actor, title, body, data, inapp, desktop, \
             read_at, done_at, done_reason, done_by, snoozed_until, cleared_at, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&self.id)
        .bind(&self.recipient)
        .bind(self.event_id)
        .bind(self.last_event_id)
        .bind(&self.project_id)
        .bind(&self.kind)
        .bind(self.needs)
        .bind(&self.group_key)
        .bind(self.count)
        .bind(&self.items)
        .bind(&self.target_kind)
        .bind(&self.target_id)
        .bind(&self.ticket_id)
        .bind(&self.page_id)
        .bind(&self.member_id)
        .bind(&self.actor)
        .bind(&self.title)
        .bind(&self.body)
        .bind(&self.data)
        .bind(self.inapp)
        .bind(self.desktop)
        .bind(&self.read_at)
        .bind(&self.done_at)
        .bind(&self.done_reason)
        .bind(&self.done_by)
        .bind(&self.snoozed_until)
        .bind(&self.cleared_at)
        .bind(&self.created_at)
        .bind(&self.updated_at)
        .execute(pool)
        .await
        .expect("insert notification");
    }
}

/// Every row of a table as objects (`select *`), in rowid order.
pub async fn table(pool: &SqlitePool, name: &str) -> Vec<Value> {
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!("SELECT * FROM {name} ORDER BY rowid")))
        .fetch_all(pool)
        .await
        .expect("select");
    rows.iter()
        .map(|row| {
            use sqlx::Column;
            let mut obj = serde_json::Map::new();
            for (i, col) in row.columns().iter().enumerate() {
                let v: Value = if let Ok(Some(n)) = row.try_get::<Option<i64>, _>(i) {
                    json!(n)
                } else if let Ok(Some(f)) = row.try_get::<Option<f64>, _>(i) {
                    json!(f)
                } else if let Ok(Some(s)) = row.try_get::<Option<String>, _>(i) {
                    json!(s)
                } else {
                    Value::Null
                };
                obj.insert(col.name().to_string(), v);
            }
            Value::Object(obj)
        })
        .collect()
}

/// Ids of the rows in a reply's `items`, in order.
pub fn ids(reply: &Value) -> Vec<String> {
    reply["items"].as_array().expect("items").iter().map(|i| i["id"].as_str().expect("id").to_string()).collect()
}

/// Insert a row into any table: the given columns, and for every other column that is NOT NULL with no default the
/// zero of its type (the Python models carry their defaults in Python, so the file has none).
pub async fn insert(pool: &SqlitePool, table: &str, values: &[(&str, Value)]) {
    let info = sqlx::query(sqlx::AssertSqlSafe(format!("PRAGMA table_info({table})")))
        .fetch_all(pool)
        .await
        .expect("table_info");
    let mut columns: Vec<String> = Vec::new();
    let mut binds: Vec<Value> = Vec::new();
    for col in &info {
        let name: String = col.get(1);
        let kind: String = col.get::<String, _>(2).to_uppercase();
        let notnull: i64 = col.get(3);
        let default: Option<String> = col.get(4);
        if let Some((_, v)) = values.iter().find(|(n, _)| *n == name) {
            columns.push(name);
            binds.push(v.clone());
        } else if notnull == 1 && default.is_none() {
            columns.push(name);
            binds.push(if kind.contains("INT") || kind.contains("BOOL") {
                json!(0)
            } else if kind.contains("FLOAT") || kind.contains("REAL") || kind.contains("NUMERIC") {
                json!(0.0)
            } else {
                json!("")
            });
        }
    }
    for (name, _) in values {
        assert!(info.iter().any(|c| c.get::<String, _>(1) == *name), "{table} has no column {name}");
    }
    let marks = vec!["?"; columns.len()].join(", ");
    let sql = format!("INSERT INTO {table} ({}) VALUES ({marks})", columns.join(", "));
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
    for v in binds {
        query = match v {
            Value::Null => query.bind(None::<String>),
            Value::Bool(b) => query.bind(b),
            Value::Number(n) if n.is_i64() => query.bind(n.as_i64()),
            Value::Number(n) => query.bind(n.as_f64()),
            Value::String(s) => query.bind(s),
            other => query.bind(other.to_string()),
        };
    }
    query.execute(pool).await.unwrap_or_else(|e| panic!("insert into {table}: {e}"));
}

/// UPDATE one table's row by `id` (or the key column named).
pub async fn update(pool: &SqlitePool, table: &str, key: &str, id: &str, set: &[(&str, Value)]) {
    let assigns = set.iter().map(|(c, _)| format!("{c} = ?")).collect::<Vec<_>>().join(", ");
    let sql = format!("UPDATE {table} SET {assigns} WHERE {key} = ?");
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
    for (_, v) in set {
        query = match v {
            Value::Null => query.bind(None::<String>),
            Value::Bool(b) => query.bind(*b),
            Value::Number(n) if n.is_i64() => query.bind(n.as_i64()),
            Value::Number(n) => query.bind(n.as_f64()),
            Value::String(s) => query.bind(s.clone()),
            other => query.bind(other.to_string()),
        };
    }
    query.bind(id).execute(pool).await.unwrap_or_else(|e| panic!("update {table}: {e}"));
}

/// An AI run that ended (or is in `state`), for the rows that point at runs.
pub async fn ai_run(
    pool: &SqlitePool,
    id: &str,
    project_id: &str,
    ticket_id: Option<&str>,
    state: &str,
    extra: &[(&str, Value)],
) {
    let mut values: Vec<(&str, Value)> = vec![
        ("id", json!(id)),
        ("project_id", json!(project_id)),
        ("ticket_id", json!(ticket_id)),
        ("member_id", json!("mem-ai")),
        ("number", json!(1)),
        ("mode", json!("work")),
        ("trigger", json!("manual")),
        ("state", json!(state)),
        ("started_by", json!("user")),
        ("queued_at", json!(at(-300))),
        ("report", json!("{}")),
        ("files", json!("[]")),
        ("restarts", json!("[]")),
        ("retries", json!("[]")),
        ("kind", json!("ticket")),
    ];
    for (k, v) in extra {
        values.retain(|(n, _)| n != k);
        values.push((k, v.clone()));
    }
    insert(pool, "ai_run", &values).await;
}

/// A ticket row (only what the notification code looks at).
pub async fn ticket(pool: &SqlitePool, id: &str, project_id: &str) {
    insert(pool, "ticket", &[("id", json!(id)), ("project_id", json!(project_id)), ("title", json!("A ticket"))]).await;
}
