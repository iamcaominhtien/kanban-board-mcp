//! A database the board can use: which engine, where it is, and how to open it with the right settings.
//!
//! Three engines: SQLite (a file in the data folder, the default), PostgreSQL 14+ and MySQL 8 / MariaDB 10.6+. The
//! one in use comes from, in this order: the environment (`KANBAN_DATABASE_URL`, which locks the Settings card), the
//! choice saved in Settings (`~/.kanban-board/config.json`, the password encrypted), or SQLite in the data folder.
//!
//! The password is never in the settings file as text: it is encrypted with the app's own key, which the desktop app
//! keeps in the system keychain (`kb_base::secrets`); on a server it stays in the environment variable.

use std::path::Path;
use std::sync::{LazyLock, RwLock};
use std::time::Duration;

use sea_orm::sqlx::mysql::{MySqlConnectOptions, MySqlSslMode};
use sea_orm::sqlx::postgres::{PgConnectOptions, PgSslMode};
use sea_orm::sqlx::sqlite::{SqliteConnectOptions, SqliteSynchronous};
use sea_orm::{ConnectOptions, Database, DatabaseConnection, DbErr};
use serde_json::{Map, Value, json};

use kb_base::{config as app_config, secrets};

pub const ENGINES: [&str; 3] = ["sqlite", "postgresql", "mysql"];
pub const SSL_MODES: [&str; 4] = ["off", "prefer", "require", "verify-full"];
pub const ENV_URL: &str = "KANBAN_DATABASE_URL";
pub const ENV_PASSWORD: &str = "KANBAN_DB_PASSWORD";
pub const CONFIG_KEY: &str = "database";
pub const APP_NAME_PREFIX: &str = "kanban-board";

/// How long a writer waits for SQLite's write lock before it gives up. The board and the stdio MCP process (what
/// editors launch) write to the same file; with WAL, readers never wait, and a writer waits this long for the other.
pub const SQLITE_BUSY_TIMEOUT_S: u64 = 30;

/// Which process this is, in the connection's name on PostgreSQL ("kanban-board app 1a2b3c4d"): the board can then
/// tell another app on the same database from its own MCP process.
///
/// The AI runner gets its token from the API that starts it (`kb_ai::runner_link`, `KANBAN_PROCESS_TOKEN`), so the
/// API can tell the runner's rows of the change log from another app's. Python takes the variable out of the
/// environment so the runner's children don't share it; the environment is never changed here, so the runner leaves
/// `PROCESS_TOKEN_ENV` out of the environment of the commands it starts instead. Read once, at the first use (the
/// programs force it at startup).
pub static PROCESS_TOKEN: LazyLock<String> = LazyLock::new(|| {
    std::env::var(PROCESS_TOKEN_ENV).ok().filter(|v| !v.is_empty()).unwrap_or_else(kb_base::time::uuid4_hex)
});

/// The variable that hands a process its `PROCESS_TOKEN`.
pub const PROCESS_TOKEN_ENV: &str = "KANBAN_PROCESS_TOKEN";

static ROLE: RwLock<&'static str> = RwLock::new("app");

/// The server keeps "app"; the stdio MCP server sets "mcp".
pub fn set_role(role: &'static str) {
    *ROLE.write().unwrap_or_else(|e| e.into_inner()) = role;
}

/// This process's role ("app" or "mcp").
pub fn role() -> &'static str {
    *ROLE.read().unwrap_or_else(|e| e.into_inner())
}

/// The default port of a server engine.
pub fn default_port(engine: &str) -> u16 {
    if engine == "postgresql" { 5432 } else { 3306 }
}

/// The engine's name for people.
pub fn engine_label(engine: &str) -> &'static str {
    match engine {
        "sqlite" => "SQLite",
        "postgresql" => "PostgreSQL",
        _ => "MySQL / MariaDB",
    }
}

/// A connection setting that cannot be used; the message says what to change.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct TargetError(pub String);

fn err<T>(message: impl Into<String>) -> Result<T, TargetError> {
    Err(TargetError(message.into()))
}

/// Where a database is. `password` is never printed (`display`, `public` and `Debug` leave it out) and is not part
/// of equality.
#[derive(Clone)]
pub struct Target {
    pub engine: String,
    /// SQLite: the file.
    pub path: String,
    pub host: String,
    pub port: Option<u16>,
    pub name: String,
    pub user: String,
    pub password: Option<String>,
    pub ssl: String,
}

impl std::fmt::Debug for Target {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Target")
            .field("engine", &self.engine)
            .field("path", &self.path)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("name", &self.name)
            .field("user", &self.user)
            .field("ssl", &self.ssl)
            .finish()
    }
}

impl PartialEq for Target {
    fn eq(&self, other: &Self) -> bool {
        self.engine == other.engine
            && self.path == other.path
            && self.host == other.host
            && self.port == other.port
            && self.name == other.name
            && self.user == other.user
            && self.ssl == other.ssl
    }
}

impl Target {
    /// A SQLite file.
    pub fn sqlite(path: impl Into<String>) -> Self {
        Self {
            engine: "sqlite".into(),
            path: path.into(),
            host: String::new(),
            port: None,
            name: String::new(),
            user: String::new(),
            password: None,
            ssl: "prefer".into(),
        }
    }

    /// Whether this is a SQLite file.
    pub fn is_sqlite(&self) -> bool {
        self.engine == "sqlite"
    }

    /// The engine's name for people.
    pub fn label(&self) -> &'static str {
        engine_label(&self.engine)
    }

    fn port_or_default(&self) -> u16 {
        self.port.filter(|p| *p != 0).unwrap_or_else(|| default_port(&self.engine))
    }

    /// Where it is, without the password: the file, or user@host:port/database.
    pub fn display(&self) -> String {
        if self.is_sqlite() {
            return self.path.clone();
        }
        let user = if self.user.is_empty() { String::new() } else { format!("{}@", self.user) };
        format!("{user}{}:{}/{}", self.host, self.port_or_default(), self.name)
    }

    /// The connection URL as the Python server rendered it (`URL.render_as_string`), with the password or `***`.
    pub fn url(&self, hide_password: bool) -> String {
        if self.is_sqlite() {
            return format!("sqlite+aiosqlite:///{}", self.path);
        }
        let driver = if self.engine == "postgresql" { "postgresql+asyncpg" } else { "mysql+aiomysql" };
        let mut out = format!("{driver}://");
        if !self.user.is_empty() {
            out.push_str(&quote(&self.user));
            if let Some(password) = self.password.as_deref().filter(|p| !p.is_empty()) {
                out.push(':');
                out.push_str(&if hide_password { "***".to_string() } else { quote(password) });
            }
            out.push('@');
        }
        if !self.host.is_empty() {
            out.push_str(&self.host);
        }
        out.push_str(&format!(":{}", self.port_or_default()));
        if !self.name.is_empty() {
            out.push('/');
            out.push_str(&self.name);
        }
        if self.engine == "mysql" {
            out.push_str("?charset=utf8mb4");
        }
        out
    }

    /// The settings people may see and the settings file may hold (no password).
    pub fn public(&self) -> Map<String, Value> {
        let mut out = Map::new();
        if self.is_sqlite() {
            out.insert("engine".into(), json!("sqlite"));
            out.insert("path".into(), json!(self.path));
            return out;
        }
        out.insert("engine".into(), json!(self.engine));
        out.insert("host".into(), json!(self.host));
        out.insert("port".into(), json!(self.port_or_default()));
        out.insert("name".into(), json!(self.name));
        out.insert("user".into(), json!(self.user));
        out.insert("ssl".into(), json!(self.ssl));
        out
    }

    /// The same target with this password.
    pub fn with_password(&self, password: Option<String>) -> Target {
        Target { password, ..self.clone() }
    }
}

/// `urllib.parse.quote(text, safe="")` as SQLAlchemy quotes a user name or a password in a URL.
fn quote(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `urllib.parse.unquote(text)`.
fn unquote(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() && text.is_char_boundary(i + 1) && text.is_char_boundary(i + 3) {
            if let Ok(byte) = u8::from_str_radix(&text[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The parts of a connection string, read as SQLAlchemy's `make_url` reads them.
struct ParsedUrl {
    drivername: String,
    username: Option<String>,
    password: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    database: Option<String>,
    query: Vec<(String, String)>,
}

const NOT_A_URL: &str = "Could not parse SQLAlchemy URL from given URL string";

fn make_url(text: &str) -> Result<ParsedUrl, String> {
    let (name, rest) = text.split_once("://").ok_or(NOT_A_URL)?;
    if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '+') {
        return Err(NOT_A_URL.into());
    }
    let (rest, query) = match rest.split_once('?') {
        Some((rest, query)) => (rest, Some(query)),
        None => (rest, None),
    };
    // the authority ends at the first '/', but a user name and a password may hold anything except '@'
    let (credentials, location) = match rest.rfind('@') {
        Some(at) if !rest[..at].contains('/') || rest[..at].contains(':') => (Some(&rest[..at]), &rest[at + 1..]),
        _ => (None, rest),
    };
    let (username, password) = match credentials {
        None => (None, None),
        Some(credentials) => match credentials.split_once(':') {
            Some((user, password)) => (Some(unquote(user)), Some(unquote(password))),
            None => (Some(unquote(credentials)), None),
        },
    };
    let (authority, database) = match location.split_once('/') {
        Some((authority, database)) => (authority, Some(database.to_string())),
        None => (location, None),
    };
    let (host, port) = match authority.strip_prefix('[').and_then(|a| a.split_once(']')) {
        // an IPv6 host is written in brackets: [::1]:5432
        Some((host, after)) => (host, after.strip_prefix(':')),
        None => match authority.rsplit_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        },
    };
    let port = match port.filter(|p| !p.is_empty()) {
        None => None,
        Some(port) => {
            Some(port.parse::<u16>().map_err(|_| format!("invalid literal for int() with base 10: '{port}'"))?)
        }
    };
    let query = query
        .map(|q| {
            q.split('&')
                .filter(|pair| !pair.is_empty())
                .map(|pair| match pair.split_once('=') {
                    Some((k, v)) => (unquote(&k.replace('+', " ")), unquote(&v.replace('+', " "))),
                    None => (unquote(pair), String::new()),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(ParsedUrl {
        drivername: name.to_string(),
        username: username.filter(|u| !u.is_empty()),
        password,
        host: Some(host.to_string()).filter(|h| !h.is_empty()),
        port,
        database: database.filter(|d| !d.is_empty()),
        query,
    })
}

fn ssl_from_query(query: &[(String, String)]) -> Result<String, TargetError> {
    let find = |key: &str| query.iter().find(|(k, v)| k == key && !v.is_empty()).map(|(_, v)| v.clone());
    let raw =
        find("sslmode").or_else(|| find("ssl-mode")).or_else(|| find("ssl_mode")).unwrap_or_default().to_lowercase();
    if raw.is_empty() {
        return Ok("prefer".into());
    }
    let mode = match raw.as_str() {
        "disable" | "disabled" | "off" => "off",
        "allow" | "prefer" | "preferred" => "prefer",
        "require" | "required" => "require",
        "verify-ca" | "verify_ca" | "verify-full" | "verify_identity" => "verify-full",
        _ => {
            return err(format!("Unknown SSL mode “{raw}” in the connection string."));
        }
    };
    Ok(mode.into())
}

/// Read a connection string: `sqlite:///path`, `postgresql://user@host:5432/db?sslmode=require`,
/// `mysql://user@host/db` or `mariadb://…`. Driver suffixes (`+asyncpg`, `+pymysql`…) are accepted.
pub fn from_url(text: &str) -> Result<Target, TargetError> {
    let text = text.trim();
    if text.is_empty() {
        return err("The connection string is empty.");
    }
    let url = make_url(text).map_err(|exc| TargetError(format!("This is not a connection string: {exc}")))?;
    let scheme = url.drivername.split('+').next().unwrap_or("").to_lowercase();
    if scheme == "sqlite" {
        return match url.database.as_deref() {
            None | Some(":memory:") => err("A SQLite connection string needs a file path."),
            Some(database) => Ok(Target::sqlite(app_config::expanduser(database).to_string_lossy().into_owned())),
        };
    }
    let engine = match scheme.as_str() {
        "postgres" | "postgresql" => "postgresql",
        "mysql" | "mariadb" => "mysql",
        "redis" | "rediss" | "mongodb" | "mongodb+srv" => {
            return err(
                "Redis and MongoDB cannot hold the board: it is relational (tables that refer to each other). \
                 Use SQLite, PostgreSQL or MySQL/MariaDB.",
            );
        }
        _ => {
            return err(format!("“{scheme}” is not supported. Use SQLite, PostgreSQL or MySQL/MariaDB."));
        }
    };
    let Some(host) = url.host else {
        return err("The connection string has no host.");
    };
    let Some(name) = url.database else {
        return err("The connection string has no database name.");
    };
    Ok(Target {
        engine: engine.into(),
        path: String::new(),
        host,
        port: Some(url.port.filter(|p| *p != 0).unwrap_or_else(|| default_port(engine))),
        name,
        user: url.username.unwrap_or_default(),
        password: url.password,
        ssl: ssl_from_query(&url.query)?,
    })
}

/// `str(value or "")` for a settings field: text as it is, a number as its digits, anything false as "".
fn field_text(data: &Map<String, Value>, key: &str) -> String {
    match data.get(key) {
        Some(value) if kb_base::pyjson::truthy(value) => kb_base::pyjson::py_str(value),
        _ => String::new(),
    }
}

/// A target from the Settings form (engine, host, port, name, user, password, ssl, or a connection string).
pub fn from_fields(data: &Map<String, Value>) -> Result<Target, TargetError> {
    let password = Some(field_text(data, "password")).filter(|p| !p.is_empty());
    let url = field_text(data, "url");
    if !url.is_empty() {
        let mut target = from_url(&url)?;
        if password.is_some() && target.password.as_deref().is_none_or(str::is_empty) {
            target = target.with_password(password);
        }
        return Ok(target);
    }
    let mut engine = field_text(data, "engine").to_lowercase();
    if engine == "mariadb" {
        engine = "mysql".into();
    }
    if !ENGINES.contains(&engine.as_str()) {
        return err("Choose SQLite, PostgreSQL or MySQL/MariaDB.");
    }
    if engine == "sqlite" {
        let path = field_text(data, "path").trim().to_string();
        if path.is_empty() {
            return err("A SQLite database needs a file path.");
        }
        return Ok(Target::sqlite(app_config::expanduser(&path).to_string_lossy().into_owned()));
    }
    let host = field_text(data, "host").trim().to_string();
    let name = field_text(data, "name").trim().to_string();
    if host.is_empty() {
        return err("Enter the server’s host name.");
    }
    if name.is_empty() {
        return err("Enter the database name.");
    }
    let port = match data.get("port") {
        Some(value) if kb_base::pyjson::truthy(value) => match value {
            Value::Number(n) => n.as_u64().and_then(|n| u16::try_from(n).ok()),
            Value::String(s) => s.trim().parse::<u16>().ok(),
            Value::Bool(true) => Some(1),
            _ => None,
        }
        .ok_or_else(|| TargetError("The port must be a number.".into()))?,
        _ => default_port(&engine),
    };
    let ssl = Some(field_text(data, "ssl")).filter(|s| !s.is_empty()).unwrap_or_else(|| "prefer".into());
    if !SSL_MODES.contains(&ssl.as_str()) {
        return err("The secure connection setting must be one of ('off', 'prefer', 'require', 'verify-full').");
    }
    Ok(Target {
        engine,
        path: String::new(),
        host,
        port: Some(port),
        name,
        user: field_text(data, "user").trim().to_string(),
        password,
        ssl,
    })
}

// ---------------------------------------------------------------------------
// The database in use, and the saved choice
// ---------------------------------------------------------------------------

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_default()
}

/// The database set by `KANBAN_DATABASE_URL`, with `KANBAN_DB_PASSWORD` when the URL has no password.
pub fn env_target() -> Result<Option<Target>, TargetError> {
    let raw = env(ENV_URL).trim().to_string();
    if raw.is_empty() {
        return Ok(None);
    }
    let mut target = from_url(&raw)?;
    let env_password = env(ENV_PASSWORD);
    if !target.is_sqlite() && target.password.as_deref().is_none_or(str::is_empty) && !env_password.is_empty() {
        target = target.with_password(Some(env_password));
    }
    Ok(Some(target))
}

/// The server database chosen in Settings, with its password; `None` when Settings say SQLite.
pub fn saved_target() -> Option<Target> {
    let data = app_config::get_section(CONFIG_KEY);
    if data.is_empty()
        || matches!(data.get("engine"), None | Some(Value::Null))
        || data.get("engine") == Some(&json!("sqlite"))
    {
        return None;
    }
    let target = from_fields(&data).ok()?;
    let mut password = secrets::decrypt(data.get("password_enc").and_then(Value::as_str));
    let env_password = env(ENV_PASSWORD);
    if password.is_none() && !env_password.is_empty() {
        password = Some(env_password);
    }
    Some(target.with_password(password))
}

/// The database to use and where that came from: "environment", "settings" or "default" (SQLite).
pub fn resolve(sqlite_path: &Path) -> Result<(Target, &'static str), TargetError> {
    if let Some(target) = env_target()? {
        return Ok((target, "environment"));
    }
    if let Some(target) = saved_target() {
        return Ok((target, "settings"));
    }
    Ok((Target::sqlite(sqlite_path.to_string_lossy().into_owned()), "default"))
}

/// Remember the database in Settings. The password is stored encrypted, never as text; SQLite clears it.
pub fn save_choice(target: &Target) -> Result<(), kb_base::secrets::SecretStoreError> {
    let io = |e: std::io::Error| kb_base::secrets::SecretStoreError(e.to_string());
    if target.is_sqlite() {
        let mut data = Map::new();
        data.insert("engine".into(), json!("sqlite"));
        return app_config::set_section(CONFIG_KEY, Some(data)).map_err(io);
    }
    let mut data = target.public();
    if let Some(password) = target.password.as_deref().filter(|p| !p.is_empty()) {
        data.insert("password_enc".into(), json!(secrets::encrypt(password)?));
    }
    app_config::set_section(CONFIG_KEY, Some(data)).map_err(io)
}

/// Where a saved password is kept: "keychain" (desktop) or "file" (the app's key file, readable by you only).
pub fn password_store() -> &'static str {
    secrets::store_kind()
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

/// This process's name on a PostgreSQL server.
pub fn application_name(role_override: Option<&str>) -> String {
    format!("{APP_NAME_PREFIX} {} {}", role_override.unwrap_or_else(|| role()), &PROCESS_TOKEN[..8])
}

/// A connection pool for `target`, with the settings each engine needs to share the database well.
///
/// SQLite: one writer at a time across every process, so a writer waits for the lock (busy timeout) instead of
/// failing at once. PostgreSQL and MySQL: a pool that checks a connection before use (a server restart or an idle
/// timeout does not surface as an error in the board) and renews connections every 30 minutes.
///
/// The pool connects lazily, as SQLAlchemy's engine does: making it never fails because the server is away.
///
/// Every statement of the pool is reported to `changes::after_statement`, which tells the listeners of
/// `changes::on_write_commit` what this process wrote.
pub async fn make_engine(target: &Target, role_override: Option<&str>) -> Result<DatabaseConnection, DbErr> {
    let mut conn = connect_pool(target, role_override).await?;
    conn.set_metric_callback(|info| crate::changes::after_statement(&info.statement.sql, info.failed));
    Ok(conn)
}

async fn connect_pool(target: &Target, role_override: Option<&str>) -> Result<DatabaseConnection, DbErr> {
    if target.is_sqlite() {
        let path = target.path.clone();
        let mut options = ConnectOptions::new("sqlite::memory:");
        options
            .sqlx_logging(false)
            .max_connections(15)
            .min_connections(0)
            .acquire_timeout(Duration::from_secs(SQLITE_BUSY_TIMEOUT_S))
            .connect_lazy(true)
            .map_sqlx_sqlite_opts(move |_| {
                // WAL is a property of the file (set once by init_db); these are per connection.
                // NORMAL is safe with WAL (a crash can lose the last commit, never corrupt the file) and saves an
                // fsync on every commit, which is most of the cost of a small write.
                // (the options are built from scratch: the placeholder URL above is an in-memory database)
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true)
                    .foreign_keys(false)
                    .busy_timeout(Duration::from_secs(SQLITE_BUSY_TIMEOUT_S))
                    .synchronous(SqliteSynchronous::Normal)
                    .pragma("temp_store", "MEMORY")
                    .pragma("cache_size", "-16000") // 16 MB of pages per connection
            });
        return Database::connect(options).await;
    }
    let host = target.host.clone();
    let port = target.port_or_default();
    let name = target.name.clone();
    let user = target.user.clone();
    let password = target.password.clone().filter(|p| !p.is_empty());
    let ssl = target.ssl.clone();
    if target.engine == "postgresql" {
        let app_name = application_name(role_override);
        let mut options = ConnectOptions::new("postgres://localhost/placeholder");
        common_pool(&mut options);
        options.map_sqlx_postgres_opts(move |_| {
            let mut o = PgConnectOptions::new_without_pgpass()
                .host(&host)
                .port(port)
                .database(&name)
                .application_name(&app_name);
            if !user.is_empty() {
                o = o.username(&user);
            }
            if let Some(password) = &password {
                o = o.password(password);
            }
            o.ssl_mode(match ssl.as_str() {
                "off" => PgSslMode::Disable,
                "require" => PgSslMode::Require,
                "verify-full" => PgSslMode::VerifyFull,
                _ => PgSslMode::Prefer,
            })
        });
        return Database::connect(options).await;
    }
    let mut options = ConnectOptions::new("mysql://localhost/placeholder");
    common_pool(&mut options);
    options.map_sqlx_mysql_opts(move |_| {
        let mut o = MySqlConnectOptions::new().host(&host).port(port).database(&name).charset("utf8mb4");
        if !user.is_empty() {
            o = o.username(&user);
        }
        if let Some(password) = &password {
            o = o.password(password);
        }
        // the Python driver had no "prefer": a plain connection, and the connection test says so
        o.ssl_mode(match ssl.as_str() {
            "require" => MySqlSslMode::Required,
            "verify-full" => MySqlSslMode::VerifyIdentity,
            _ => MySqlSslMode::Disabled,
        })
    });
    // Each statement sees what was committed before it, as on PostgreSQL; MySQL's default (REPEATABLE READ) takes
    // gap locks that make two writers wait on each other for rows neither touches.
    // Set on every connection the pool opens (the pool's own hook: `ConnectOptions::after_connect` runs once, on
    // one connection).
    options.map_sqlx_mysql_pool_opts(|pool| {
        pool.after_connect(|conn, _meta| {
            Box::pin(async move {
                sea_orm::sqlx::Executor::execute(conn, "SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED")
                    .await?;
                Ok(())
            })
        })
    });
    Database::connect(options).await
}

/// The settings of one connection to `target`, outside any pool: what `make_engine` gives each connection of its
/// pool (the file and its pragmas, or the server, the user, the SSL mode, the character set and this process's name).
///
/// For code that needs a connection of its own (the connection test, the snapshot a copy reads from): opening one
/// fails at once when the server is away, where a pool waits and tries again.
#[derive(Debug, Clone)]
pub enum ConnectionOptions {
    Sqlite(SqliteConnectOptions),
    Postgres(PgConnectOptions),
    MySql(MySqlConnectOptions),
}

/// The connection settings of `target` (see `ConnectionOptions`). On MySQL the caller sets the isolation level it
/// wants (`make_engine` uses READ COMMITTED).
pub fn connection_options(target: &Target, role_override: Option<&str>) -> ConnectionOptions {
    if target.is_sqlite() {
        return ConnectionOptions::Sqlite(
            SqliteConnectOptions::new()
                .filename(&target.path)
                .create_if_missing(true)
                .foreign_keys(false)
                .busy_timeout(Duration::from_secs(SQLITE_BUSY_TIMEOUT_S))
                .synchronous(SqliteSynchronous::Normal)
                .pragma("temp_store", "MEMORY")
                .pragma("cache_size", "-16000"),
        );
    }
    let password = target.password.as_deref().filter(|p| !p.is_empty());
    if target.engine == "postgresql" {
        let mut o = PgConnectOptions::new_without_pgpass()
            .host(&target.host)
            .port(target.port_or_default())
            .database(&target.name)
            .application_name(&application_name(role_override));
        if !target.user.is_empty() {
            o = o.username(&target.user);
        }
        if let Some(password) = password {
            o = o.password(password);
        }
        return ConnectionOptions::Postgres(o.ssl_mode(match target.ssl.as_str() {
            "off" => PgSslMode::Disable,
            "require" => PgSslMode::Require,
            "verify-full" => PgSslMode::VerifyFull,
            _ => PgSslMode::Prefer,
        }));
    }
    let mut o = MySqlConnectOptions::new()
        .host(&target.host)
        .port(target.port_or_default())
        .database(&target.name)
        .charset("utf8mb4");
    if !target.user.is_empty() {
        o = o.username(&target.user);
    }
    if let Some(password) = password {
        o = o.password(password);
    }
    // the Python driver had no "prefer": a plain connection, and the connection test says so
    ConnectionOptions::MySql(o.ssl_mode(match target.ssl.as_str() {
        "require" => MySqlSslMode::Required,
        "verify-full" => MySqlSslMode::VerifyIdentity,
        _ => MySqlSslMode::Disabled,
    }))
}

fn common_pool(options: &mut ConnectOptions) {
    options
        .sqlx_logging(false)
        .max_connections(15) // pool_size 5 + max_overflow 10
        .min_connections(0)
        .connect_timeout(Duration::from_secs(10))
        .acquire_timeout(Duration::from_secs(30))
        .max_lifetime(Duration::from_secs(1800))
        .test_before_acquire(true)
        .connect_lazy(true);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_connection_strings() {
        let t = from_url("postgresql+asyncpg://bob:p%40ss@db.example.com/board?sslmode=require").unwrap();
        assert_eq!(
            (t.engine.as_str(), t.host.as_str(), t.port, t.name.as_str(), t.user.as_str()),
            ("postgresql", "db.example.com", Some(5432), "board", "bob")
        );
        assert_eq!(t.password.as_deref(), Some("p@ss"));
        assert_eq!(t.ssl, "require");
        assert_eq!(t.display(), "bob@db.example.com:5432/board");
        assert_eq!(t.url(true), "postgresql+asyncpg://bob:***@db.example.com:5432/board");
        assert_eq!(t.url(false), "postgresql+asyncpg://bob:p%40ss@db.example.com:5432/board");
        let m = from_url("mariadb://root@127.0.0.1:3307/kanban").unwrap();
        assert_eq!((m.engine.as_str(), m.port), ("mysql", Some(3307)));
        assert_eq!(m.url(true), "mysql+aiomysql://root@127.0.0.1:3307/kanban?charset=utf8mb4");
        assert_eq!(from_url("sqlite:////tmp/x/kanban.db").unwrap().path, "/tmp/x/kanban.db");
        assert_eq!(from_url("").unwrap_err().0, "The connection string is empty.");
        assert_eq!(from_url("sqlite://").unwrap_err().0, "A SQLite connection string needs a file path.");
        assert_eq!(
            from_url("oracle://h/db").unwrap_err().0,
            "“oracle” is not supported. Use SQLite, PostgreSQL or MySQL/MariaDB."
        );
        assert_eq!(from_url("postgresql:///db").unwrap_err().0, "The connection string has no host.");
        assert_eq!(from_url("postgresql://h").unwrap_err().0, "The connection string has no database name.");
        assert_eq!(
            from_url("nonsense").unwrap_err().0,
            "This is not a connection string: Could not parse SQLAlchemy URL from given URL string"
        );
        assert_eq!(
            from_url("mysql://h/db?sslmode=maybe").unwrap_err().0,
            "Unknown SSL mode “maybe” in the connection string."
        );
    }

    #[test]
    fn one_connection_gets_the_settings_of_the_pool() {
        use sea_orm::sqlx::ConnectOptions as _;
        let pg = from_url("postgresql://bob:pw@db.example.com:5433/board?sslmode=require").unwrap();
        match connection_options(&pg, Some("probe")) {
            ConnectionOptions::Postgres(o) => {
                assert_eq!((o.get_host(), o.get_port(), o.get_database()), ("db.example.com", 5433, Some("board")));
                assert_eq!(o.get_username(), "bob");
                assert!(matches!(o.get_ssl_mode(), PgSslMode::Require));
                assert_eq!(o.get_application_name(), Some(application_name(Some("probe")).as_str()));
            }
            other => panic!("{other:?}"),
        }
        let my = from_url("mysql://app:pw@mysql.internal/kanban").unwrap();
        match connection_options(&my, None) {
            ConnectionOptions::MySql(o) => {
                assert_eq!((o.get_host(), o.get_port(), o.get_database()), ("mysql.internal", 3306, Some("kanban")));
                assert_eq!((o.get_username(), o.get_charset()), ("app", "utf8mb4"));
                assert!(matches!(o.get_ssl_mode(), MySqlSslMode::Disabled));
            }
            other => panic!("{other:?}"),
        }
        match connection_options(&Target::sqlite("/tmp/x/kanban.db"), None) {
            ConnectionOptions::Sqlite(o) => {
                assert_eq!(o.get_filename(), std::path::Path::new("/tmp/x/kanban.db"));
                assert_eq!(o.to_url_lossy().scheme(), "sqlite");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn reads_the_settings_form() {
        let form = |v: Value| v.as_object().cloned().unwrap();
        let t = from_fields(&form(
            json!({"engine": "MariaDB", "host": " h ", "name": "n", "port": "3310", "user": "u", "password": "pw"}),
        ))
        .unwrap();
        assert_eq!(
            (t.engine.as_str(), t.host.as_str(), t.port, t.password.as_deref(), t.ssl.as_str()),
            ("mysql", "h", Some(3310), Some("pw"), "prefer")
        );
        assert_eq!(
            from_fields(&form(json!({"engine": "postgresql", "name": "n"}))).unwrap_err().0,
            "Enter the server’s host name."
        );
        assert_eq!(
            from_fields(&form(json!({"engine": "postgresql", "host": "h"}))).unwrap_err().0,
            "Enter the database name."
        );
        assert_eq!(
            from_fields(&form(json!({"engine": "postgresql", "host": "h", "name": "n", "port": "x"}))).unwrap_err().0,
            "The port must be a number."
        );
        assert_eq!(
            from_fields(&form(json!({"engine": "db2"}))).unwrap_err().0,
            "Choose SQLite, PostgreSQL or MySQL/MariaDB."
        );
        assert_eq!(
            from_fields(&form(json!({"engine": "sqlite"}))).unwrap_err().0,
            "A SQLite database needs a file path."
        );
        let public = from_fields(&form(json!({"engine": "postgresql", "host": "h", "name": "n"}))).unwrap().public();
        assert_eq!(
            kb_base::pyjson::dumps(&Value::Object(public)),
            r#"{"engine": "postgresql", "host": "h", "port": 5432, "name": "n", "user": "", "ssl": "prefer"}"#
        );
    }
}
