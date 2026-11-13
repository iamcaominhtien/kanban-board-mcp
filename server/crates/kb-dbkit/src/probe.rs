//! Test a database before anything is written to it: can the board reach it, sign in, create tables, store every
//! character, and is it empty? Each finding says what was found and, for a problem, how to fix it, with the statement
//! ready to copy (design C2, C3, E2).
//!
//! Levels: "ok" (green), "warn" (amber: you may go on), "error" (red: Next stays off), "info".
//! A test never changes the database: the table it creates to check the rights is dropped again (and on PostgreSQL it
//! is made inside a transaction that is rolled back).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use kb_base::{pytext, time};
use kb_db::schema;
use kb_db::sea_orm::sqlx::mysql::MySqlDatabaseError;
use kb_db::sea_orm::{DbBackend, DbErr, sqlx};
use kb_db::targets::{self, Target};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::move_db::raw::{self, Direct, Reader, version_tuple};
use crate::move_db::{Cell, commas};

pub const PG_MIN: i64 = 140000;
pub const MYSQL_MIN: [u64; 2] = [8, 0];
pub const MARIADB_MIN: [u64; 2] = [10, 6];
/// UPDATE … RETURNING
pub const SQLITE_MIN: [u64; 2] = [3, 35];
pub const LOCAL_HOSTS: [&str; 4] = ["localhost", "127.0.0.1", "::1", ""];

/// One line of "What the test found".
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Finding {
    pub key: String,
    /// ok | warn | error | info
    pub level: String,
    pub title: String,
    pub detail: String,
    /// A statement to copy.
    pub fix: String,
    pub fix_label: String,
}

/// What a test found, and a summary the next steps use.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Report {
    pub target: Map<String, Value>,
    pub findings: Vec<Finding>,
    pub reached: bool,
    pub version: String,
    pub latency_ms: Option<u64>,
    /// empty | board | foreign | newer | unknown
    pub state: String,
    pub tables: usize,
    pub revision: Option<String>,
    /// Tickets of a board already there.
    pub tickets: Option<i64>,
    pub secure: Option<bool>,
    pub other_apps: i64,
}

impl Report {
    fn new(target: &Target) -> Self {
        Self {
            target: target.public(),
            findings: Vec::new(),
            reached: false,
            version: String::new(),
            latency_ms: None,
            state: "unknown".into(),
            tables: 0,
            revision: None,
            tickets: None,
            secure: None,
            other_apps: 0,
        }
    }

    /// No red line: the person may go on.
    pub fn ok(&self) -> bool {
        self.reached && !self.findings.iter().any(|f| f.level == "error")
    }

    /// Add a finding.
    pub fn add(&mut self, key: &str, level: &str, title: impl Into<String>) -> &mut Finding {
        self.findings.push(Finding {
            key: key.into(),
            level: level.into(),
            title: title.into(),
            detail: String::new(),
            fix: String::new(),
            fix_label: String::new(),
        });
        let last = self.findings.len() - 1;
        &mut self.findings[last]
    }

    /// For the API.
    pub fn as_dict(&self) -> Map<String, Value> {
        let mut out = match serde_json::to_value(self) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        };
        out.insert("ok".into(), Value::Bool(self.ok()));
        out
    }
}

impl Finding {
    fn detail(&mut self, detail: impl Into<String>) -> &mut Finding {
        self.detail = detail.into();
        self
    }

    fn fix(&mut self, fix: impl Into<String>) -> &mut Finding {
        self.fix = fix.into();
        self.fix_label = if self.fix.is_empty() { String::new() } else { "Copy the statement".into() };
        self
    }
}

/// "host:port" of a target.
fn place(target: &Target) -> String {
    format!("{}:{}", target.host, target.port.map(|p| p.to_string()).unwrap_or_else(|| "None".into()))
}

/// `".".join(str(n) for n in nums)`.
fn dotted(nums: &[u64]) -> String {
    nums.iter().map(u64::to_string).collect::<Vec<_>>().join(".")
}

/// `text[:300]` of a stripped text.
fn first_300(text: &str) -> String {
    pytext::strip(text).chars().take(300).collect()
}

/// Whether a refused connection is worded as Python's own event loop worded it. The server ran on another event
/// loop than the `kanban-db` script, and the two say a refused connection differently; `cli` turns this on.
static ASYNCIO_WORDS: AtomicBool = AtomicBool::new(false);

/// Word a refused connection as the `kanban-db` script did (see `ASYNCIO_WORDS`).
pub(crate) fn use_asyncio_words() {
    ASYNCIO_WORDS.store(true, Ordering::Relaxed);
}

/// The address a connection was tried on, as Python prints a socket address.
fn address(addr: &std::net::SocketAddr) -> String {
    match addr {
        std::net::SocketAddr::V4(a) => format!("('{}', {})", a.ip(), a.port()),
        std::net::SocketAddr::V6(a) => format!("('{}', {}, 0, 0)", a.ip(), a.port()),
    }
}

/// What the Python driver said when a connection could not be made (`str(exc)`): the words go into the finding.
async fn raw_message(err: &DbErr, target: &Target) -> String {
    let Some(inner) = crate::move_db::raw_sqlx(err) else {
        return err.to_string();
    };
    match inner {
        sqlx::Error::Database(db) => match db.try_downcast_ref::<MySqlDatabaseError>() {
            Some(mysql) => format!("({}, {})", mysql.number(), pytext::repr(mysql.message())),
            None => db.message().to_string(),
        },
        sqlx::Error::Io(io) => {
            if target.engine == "mysql" {
                // the MySQL driver said every failure to connect this way
                return format!("(2003, \"Can't connect to MySQL server on {}\")", pytext::repr(&target.host));
            }
            if io.kind() == std::io::ErrorKind::TimedOut {
                return "timeout".into();
            }
            let text = io.to_string();
            if let Some(reason) = text.strip_prefix("failed to lookup address information: ") {
                let errno = match reason {
                    "Name or service not known" => -2,
                    "Temporary failure in name resolution" => -3,
                    "No address associated with hostname" => -5,
                    _ => return text,
                };
                return format!("[Errno {errno}] {reason}");
            }
            let Some(errno) = io.raw_os_error() else {
                return text;
            };
            if !ASYNCIO_WORDS.load(Ordering::Relaxed) {
                // `str(OSError)` as the server's event loop raised it: "[Errno 111] Connection refused"
                return format!("[Errno {errno}] {}", text.split(" (os error").next().unwrap_or(&text));
            }
            // and as the script's event loop raised it: "[Errno 111] Connect call failed ('127.0.0.1', 5432)"
            let port = target.port.unwrap_or_else(|| targets::default_port(&target.engine));
            let tried: Vec<String> = match tokio::net::lookup_host((target.host.as_str(), port)).await {
                Ok(found) => {
                    found.map(|addr| format!("[Errno {errno}] Connect call failed {}", address(&addr))).collect()
                }
                Err(_) => Vec::new(),
            };
            match tried.len() {
                0 => text,
                1 => tried[0].clone(),
                _ => format!("Multiple exceptions: {}", tried.join(", ")),
            }
        }
        other => other.to_string(),
    }
}

/// (key, title, detail, fix) for a connection that failed. The Python drivers were told apart by the words and the
/// class of their errors; here the server's own code decides first (SQLSTATE on PostgreSQL, the error number on
/// MySQL / MariaDB), then the words.
async fn classify(err: &DbErr, target: &Target) -> (&'static str, String, String, String) {
    let raw = raw_message(err, target).await;
    let msg = raw.to_lowercase();
    let place = place(target);
    let (state, number) = match crate::move_db::raw_sqlx(err) {
        Some(sqlx::Error::Database(db)) => (
            db.code().map(|c| c.into_owned()).unwrap_or_default(),
            db.try_downcast_ref::<MySqlDatabaseError>().map(MySqlDatabaseError::number).unwrap_or(0),
        ),
        _ => (String::new(), 0),
    };
    let timed_out = matches!(
        crate::move_db::raw_sqlx(err),
        Some(sqlx::Error::Io(io)) if io.kind() == std::io::ErrorKind::TimedOut
    ) || matches!(crate::move_db::raw_sqlx(err), Some(sqlx::Error::PoolTimedOut));
    if msg.contains("password authentication failed")
        || msg.contains("access denied")
        // InvalidPasswordError, InvalidAuthorizationSpecificationError
        || (number == 0 && (state == "28P01" || state == "28000"))
        || matches!(number, 1044 | 1045 | 1698)
    {
        return (
            "signin",
            format!("Cannot sign in · as {}", if target.user.is_empty() { "(no user)" } else { &target.user }),
            "The server refused the user name or the password. Check both; the password is case-sensitive.".into(),
            String::new(),
        );
    }
    if (msg.contains("does not exist") && msg.contains("database"))
        || msg.contains("unknown database")
        || (number == 0 && state == "3D000")
        || number == 1049
    {
        let fix = if target.engine == "postgresql" {
            format!("CREATE DATABASE \"{}\" OWNER \"{}\" ENCODING 'UTF8';", target.name, target.user)
        } else {
            format!(
                "CREATE DATABASE `{name}` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;\n\
                 GRANT ALL PRIVILEGES ON `{name}`.* TO '{user}'@'%';",
                name = target.name,
                user = target.user
            )
        };
        return (
            "database",
            format!("No database “{}” on {place}", target.name),
            "Create it on the server (as an administrator), then test again.".into(),
            fix,
        );
    }
    if msg.contains("ssl") || msg.contains("certificate") || msg.contains("tls") {
        return (
            "ssl",
            "The secure connection failed".into(),
            format!(
                "{} · Choose “Require” to encrypt without checking the certificate, or install the \
                 server’s certificate authority on this computer.",
                first_300(&raw)
            ),
            String::new(),
        );
    }
    if timed_out || msg.contains("timeout") {
        return (
            "reach",
            format!("No answer from {place}"),
            "Nothing answered within 10 seconds: check the host name, the port and any firewall between \
             this computer and the server."
                .into(),
            String::new(),
        );
    }
    (
        "reach",
        format!("Cannot reach the server · {place}"),
        format!(
            "{} · Check the host name and the port, and that the server is running and accepts \
             connections from this computer.",
            first_300(&raw)
        ),
        String::new(),
    )
}

async fn schema_of(conn: &mut Direct, report: &mut Report) -> Result<(), DbErr> {
    let state = raw::schema_state(conn).await?;
    report.state = state.state.to_string();
    report.tables = state.tables;
    report.revision = state.revision.clone();
    if state.state == "empty" {
        report.add("empty", "ok", "Database is empty · 0 tables, so a copy can go straight in");
        return Ok(());
    }
    if state.state == "foreign" {
        report.add("empty", "warn", format!("Not empty · {} tables that are not a Kanban board", state.tables)).detail(
            "The board will not write into a database that already holds something, because it cannot tell what \
                 is yours. Choose another database, or empty this one in the next step.",
        );
        return Ok(());
    }
    let rev = state.revision.clone().unwrap_or_default();
    if !rev.is_empty() && !schema::known_revision(&rev) {
        report.state = "newer".into();
        report
            .add(
                "newer",
                "error",
                format!(
                    "A newer database · made by a newer version of the app (migration {}…)",
                    rev.chars().take(8).collect::<String>()
                ),
            )
            .detail("Update the app first; the board will not touch it.");
        return Ok(());
    }
    // a partial board may not have the table yet
    let rows = conn.scalar("SELECT COUNT(*) FROM ticket", Vec::new()).await.ok().map(|n| n.as_i64().unwrap_or(0));
    report.tickets = rows;
    report
        .add(
            "empty",
            "warn",
            format!(
                "Already holds a Kanban board · {} tables{}",
                state.tables,
                rows.map(|n| format!(", {} tickets", commas(n))).unwrap_or_default()
            ),
        )
        .detail("Use it as it is (Use this database), or empty it in the next step to copy your data in.");
    Ok(())
}

/// The version of the SQLite this program is built with ("3.46.0").
pub async fn sqlite_version() -> String {
    static VERSION: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();
    VERSION
        .get_or_init(|| async {
            use sqlx::{ConnectOptions as _, Connection as _};
            let options = sqlx::sqlite::SqliteConnectOptions::new().in_memory(true).disable_statement_logging();
            let Ok(mut conn) = options.connect().await else {
                return String::new();
            };
            let version: String =
                sqlx::query_scalar("SELECT sqlite_version()").fetch_one(&mut conn).await.unwrap_or_default();
            let _ = conn.close().await;
            version
        })
        .await
        .clone()
}

/// `str(OSError)` as Python prints it: "[Errno 13] Permission denied: '/x'".
fn os_error(err: &std::io::Error, path: &Path) -> String {
    let text = err.to_string();
    let words = text.split(" (os error").next().unwrap_or(&text);
    match err.raw_os_error() {
        Some(errno) => format!("[Errno {errno}] {words}: {}", pytext::repr(&path.to_string_lossy())),
        None => text,
    }
}

/// `os.access(folder, os.W_OK)`.
fn writable(folder: &Path) -> bool {
    #[cfg(unix)]
    {
        rustix::fs::access(folder, rustix::fs::Access::WRITE_OK).is_ok()
    }
    #[cfg(not(unix))]
    {
        std::fs::metadata(folder).map(|m| !m.permissions().readonly()).unwrap_or(false)
    }
}

/// `Path.parent`: the folder of a file ("." for a bare name).
fn parent_of(path: &Path) -> PathBuf {
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
        Some(_) => PathBuf::from("."),
        None => path.to_path_buf(),
    }
}

async fn probe_sqlite(target: &Target, report: &mut Report) {
    let path = PathBuf::from(&target.path);
    report.target = target.public();
    let version = sqlite_version().await;
    report.version = format!("SQLite {version}");
    if version_tuple(&version).as_slice() < SQLITE_MIN.as_slice() {
        report.add("version", "error", format!("SQLite {version} is too old (needs 3.35 or newer)"));
    }
    let folder = parent_of(&path);
    if !folder.exists() {
        if let Err(err) = std::fs::create_dir_all(&folder) {
            // Python names the first folder it could not make
            let mut failed = folder.clone();
            while let Some(parent) = failed.parent() {
                if parent.as_os_str().is_empty() || parent.exists() {
                    break;
                }
                failed = parent.to_path_buf();
            }
            report
                .add("reach", "error", format!("Cannot create the folder {}", folder.display()))
                .detail(os_error(&err, &failed));
            return;
        }
    }
    if !writable(&folder) {
        report.add("reach", "error", format!("Cannot write to {}", folder.display()));
        return;
    }
    report.reached = true;
    report.latency_ms = Some(0);
    report.secure = Some(true);
    report.add("reach", "ok", format!("A file on this computer · {}", path.display()));
    if std::fs::metadata(&path).map(|m| m.len() == 0).unwrap_or(true) {
        report.state = "empty".into();
        report.add("empty", "ok", "No file yet · the board will create it");
        return;
    }
    let probe_target = Target::sqlite(path.to_string_lossy().into_owned());
    let checked = async {
        let mut conn = Direct::connect(&probe_target, "probe").await?;
        let outcome = async {
            let check = conn.scalar("PRAGMA quick_check", Vec::new()).await?;
            if check.as_str() != Some("ok") {
                report.add("integrity", "error", "The file is damaged").detail(check.py_str());
                return Ok(());
            }
            schema_of(&mut conn, report).await
        }
        .await;
        conn.close().await;
        outcome
    }
    .await;
    if let Err(err) = checked {
        // not a database file
        report.add("integrity", "error", "This file is not a SQLite database").detail(sqlite_error_text(&err));
    }
}

/// `str(exc)` of the error SQLAlchemy raised when a SQLite file could not be opened:
/// "(sqlite3.DatabaseError) file is not a database", then where to read about that kind of error.
fn sqlite_error_text(err: &DbErr) -> String {
    let (message, _) = crate::move_db::raw_error(err);
    let code = match crate::move_db::raw_sqlx(err) {
        Some(sqlx::Error::Database(db)) => db.code().and_then(|c| c.parse::<i32>().ok()).unwrap_or(1) & 0xff,
        _ => return message,
    };
    // how Python's sqlite3 names SQLite's result codes, and SQLAlchemy's page for each name
    let (class, page) = match code {
        11 | 26 => ("DatabaseError", "4xp6"),
        19 | 20 => ("IntegrityError", "gkpj"),
        2 | 12 => ("InternalError", "2j85"),
        18 => ("DataError", "9h9h"),
        _ => ("OperationalError", "e3q8"),
    };
    format!("(sqlite3.{class}) {message}\n(Background on this error at: https://sqlalche.me/e/20/{page})")
}

async fn can_create_pg(conn: &mut Direct, target: &Target, report: &mut Report) -> Result<(), DbErr> {
    let name = format!("kanban_probe_{}", &time::uuid4_hex()[..8]);
    // a savepoint in the transaction the SHOW queries began
    conn.execute("SAVEPOINT kanban_probe").await?;
    match conn.execute(&format!("CREATE TABLE {name} (id INTEGER PRIMARY KEY)")).await {
        Ok(()) => {
            report.add("create", "ok", "Can create tables · tried a table in a transaction and rolled it back");
        }
        // no rights
        Err(_) => {
            report
                .add(
                    "create",
                    "error",
                    format!("Cannot create tables · {} has no CREATE right on the schema", target.user),
                )
                .detail("Run this as the owner of the database, or use a user that owns it.")
                .fix(format!("GRANT CREATE ON SCHEMA public TO \"{}\";", target.user));
        }
    }
    conn.execute("ROLLBACK TO SAVEPOINT kanban_probe").await
}

async fn probe_pg(conn: &mut Direct, target: &Target, report: &mut Report) -> Result<(), DbErr> {
    conn.execute("BEGIN").await?;
    let num = conn.scalar("SHOW server_version_num", Vec::new()).await?.as_i64().unwrap_or(0);
    let ver = match conn.scalar("SHOW server_version", Vec::new()).await? {
        Cell::Null => String::new(),
        other => other.py_str(),
    };
    report.version = format!("PostgreSQL {}", ver.split(' ').next().unwrap_or(""));
    if num < PG_MIN {
        let title = format!("Server too old · {}. The board needs 14 or newer.", report.version);
        report.add("version", "error", title).detail("Nothing can be done from here; upgrade the server.");
    } else {
        let title = format!("Version · {} (needs 14 or newer)", report.version);
        report.add("version", "ok", title);
    }
    let enc = match conn.scalar("SHOW server_encoding", Vec::new()).await? {
        Cell::Null => String::new(),
        other => other.py_str(),
    };
    if !matches!(enc.to_uppercase().as_str(), "UTF8" | "UTF-8") {
        report
            .add("encoding", "error", format!("Encoding is {enc} · the board needs UTF8"))
            .detail("Create the database with UTF8; an existing database cannot change its encoding.")
            .fix(format!(
                "CREATE DATABASE \"{}_utf8\" OWNER \"{}\" ENCODING 'UTF8' TEMPLATE template0;",
                target.name, target.user
            ));
    } else {
        report.add("encoding", "ok", "Encoding · UTF8");
    }
    can_create_pg(conn, target, report).await?;
    // the view may be hidden
    report.secure = match conn.scalar("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()", Vec::new()).await {
        Ok(Cell::Bool(on)) => Some(on),
        _ => None,
    };
    // not allowed to read it
    let others = conn
        .scalar(
            "SELECT COUNT(DISTINCT application_name) FROM pg_stat_activity \
             WHERE datname = current_database() AND application_name LIKE ? \
             AND application_name NOT LIKE ?",
            vec![
                format!("{} app %", targets::APP_NAME_PREFIX).into(),
                format!("%{}", &targets::PROCESS_TOKEN[..8]).into(),
            ],
        )
        .await;
    report.other_apps = others.ok().and_then(|n| n.as_i64()).unwrap_or(0);
    Ok(())
}

async fn probe_mysql(conn: &mut Direct, target: &Target, report: &mut Report) -> Result<(), DbErr> {
    let ver = match conn.scalar("SELECT VERSION()", Vec::new()).await? {
        Cell::Null => String::new(),
        other => other.py_str(),
    };
    let maria = ver.to_lowercase().contains("mariadb");
    let nums = version_tuple(&ver);
    let label = if maria { "MariaDB" } else { "MySQL" };
    report.version = format!("{label} {}", dotted(&nums[..nums.len().min(3)]));
    let need = if maria { MARIADB_MIN } else { MYSQL_MIN };
    if &nums[..nums.len().min(2)] < need.as_slice() {
        let title = format!("Server too old · {}. The board needs {label} {} or newer.", report.version, dotted(&need));
        report.add("version", "error", title).detail("Nothing can be done from here; upgrade the server.");
    } else {
        let title = format!("Version · {} (needs {} or newer)", report.version, dotted(&need));
        report.add("version", "ok", title);
    }
    let row = conn
        .rows("SELECT @@character_set_database, @@collation_database", Vec::new())
        .await?
        .into_iter()
        .next()
        .unwrap_or_default();
    let charset = row.first().map(Cell::py_str).unwrap_or_default();
    let collation = row.get(1).map(Cell::py_str).unwrap_or_default();
    if charset.to_lowercase() != "utf8mb4" {
        report
            .add(
                "charset",
                "warn",
                format!(
                    "Character set is {charset} · the board needs utf8mb4, or emoji and non-Latin text will be damaged."
                ),
            )
            .detail(
                "The board makes its own tables in utf8mb4 either way; set it on the database so anything else made \
                 there is too.",
            )
            .fix(format!("ALTER DATABASE `{}` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;", target.name));
    } else {
        report.add("charset", "ok", format!("Character set · utf8mb4 ({collation})"));
    }
    let name = format!("kanban_probe_{}", &time::uuid4_hex()[..8]);
    let made = async {
        conn.execute(&format!("CREATE TABLE `{name}` (id INT PRIMARY KEY)")).await?;
        conn.execute(&format!("DROP TABLE `{name}`")).await
    }
    .await;
    match made {
        Ok(()) => {
            report.add("create", "ok", "Can create tables · created a test table and dropped it again");
        }
        // no rights
        Err(_) => {
            report
                .add(
                    "create",
                    "error",
                    format!("Cannot create tables · {} has no CREATE privilege on {}.", target.user, target.name),
                )
                .detail("Run this as an administrator, then test again.")
                .fix(format!(
                    "GRANT CREATE, ALTER, DROP, INDEX, SELECT, INSERT, UPDATE, DELETE, REFERENCES \
                     ON `{}`.* TO '{}'@'%';",
                    target.name, target.user
                ));
        }
    }
    report.secure = match conn.rows("SHOW SESSION STATUS LIKE 'Ssl_cipher'", Vec::new()).await {
        Ok(rows) => rows.first().and_then(|row| row.get(1)).map(|cipher| match cipher {
            Cell::Text(text) => !text.is_empty(),
            Cell::Bytes(bytes) => !bytes.is_empty(),
            Cell::Null => false,
            _ => true,
        }),
        Err(_) => None,
    };
    Ok(())
}

/// Test `target` and say what was found. Never fails for a database problem: the report says it.
pub async fn test(target: &Target) -> Result<Report, DbErr> {
    let mut report = Report::new(target);
    if target.is_sqlite() {
        probe_sqlite(target, &mut report).await;
        return Ok(report);
    }
    let started = Instant::now();
    // every way a connection fails
    let connected = tokio::time::timeout(std::time::Duration::from_secs(12), Direct::connect(target, "probe")).await;
    let mut conn = match connected {
        Ok(Ok(conn)) => conn,
        failed => {
            let err = match failed {
                Ok(Err(err)) => err,
                _ => DbErr::Conn(kb_db::sea_orm::RuntimeErr::SqlxError(std::sync::Arc::new(sqlx::Error::PoolTimedOut))),
            };
            let (key, title, detail, fix) = classify(&err, target).await;
            if key == "signin" || key == "database" {
                report.add("reach", "ok", format!("Reached the server · {}", place(target)));
            }
            report.add(key, "error", title).detail(detail).fix(fix);
            report.reached = false;
            return Ok(report);
        }
    };
    let latency = started.elapsed().as_millis() as u64;
    report.latency_ms = Some(latency);
    report.reached = true;
    let probed = async {
        report.add("reach", "ok", format!("Reached the server · {} · {latency} ms", place(target)));
        report.add("signin", "ok", format!("Signed in · as {}", target.user));
        if conn.backend() == DbBackend::Postgres {
            probe_pg(&mut conn, target, &mut report).await?;
        } else {
            probe_mysql(&mut conn, target, &mut report).await?;
        }
        if report.secure == Some(false) {
            let local = LOCAL_HOSTS.contains(&target.host.to_lowercase().as_str());
            report
                .add(
                    "ssl",
                    if local { "info" } else { "warn" },
                    "No secure connection · this connection is not encrypted",
                )
                .detail("Fine on the same computer, not across a network: choose Require or Verify the server.");
        } else if report.secure == Some(true) {
            report.add("ssl", "ok", "Secure connection · encrypted (TLS)");
        }
        schema_of(&mut conn, &mut report).await?;
        if report.other_apps != 0 {
            let title = format!("Another board is connected · {} other app(s) use this database", report.other_apps);
            report
                .add("others", "info", title)
                .detail("Several apps may share one database; live updates between them can take a moment.");
        }
        Ok::<(), DbErr>(())
    }
    .await;
    conn.close().await;
    probed?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_report_is_ok_when_reached_without_a_red_line() {
        let mut report = Report::new(&Target::sqlite("/tmp/x.db"));
        assert!(!report.ok());
        report.reached = true;
        report.add("a", "warn", "t").detail("d").fix("FIX;");
        assert!(report.ok());
        let dict = report.as_dict();
        assert_eq!(
            dict.keys().map(String::as_str).collect::<Vec<_>>(),
            [
                "target",
                "findings",
                "reached",
                "version",
                "latency_ms",
                "state",
                "tables",
                "revision",
                "tickets",
                "secure",
                "other_apps",
                "ok"
            ]
        );
        assert_eq!(dict["findings"][0]["fix_label"], "Copy the statement");
        report.add("b", "error", "t");
        assert!(!report.ok());
    }

    #[test]
    fn os_errors_read_as_python_prints_them() {
        let err = std::io::Error::from_raw_os_error(13);
        assert_eq!(os_error(&err, Path::new("/x/y")), "[Errno 13] Permission denied: '/x/y'");
    }
}
