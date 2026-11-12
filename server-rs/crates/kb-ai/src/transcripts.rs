//! The board's own copy of every CLI run (design/screens/ai-operations.md, F and G).
//!
//! Claude Code deletes its session files after about 30 days, so "why did it do that" would have no answer for last
//! month's tickets. While a run's CLI works, every line it prints is appended to `<data>/ai-runs/<yyyy-mm>/<run>.jsonl`
//! next to what the board sent it (the system prompt, the prompt, a note it was given) and the board's own notes
//! (restarts, diagnoses, messages a person sent). When the run ends the file is compressed and indexed for search.
//!
//! - Secrets are masked before anything is written (`secrets::redact`), the run's MCP token included.
//! - One string is kept up to `MAX_TEXT` characters; a long tool output is cut and says so.
//! - The summary of a run (`AiRun`) is kept forever; the transcript for the notification retention (90 days by default,
//!   one setting), unless the run is pinned.
//! - The search index `ai_run_fts` holds the summary, the question and answer, what the AI said, tool names, commands,
//!   file paths and errors. `search_ids` answers `None` where the index cannot be used (PostgreSQL, MySQL, FTS5 missing
//!   or a MATCH that fails): the caller scans the runs itself, as `kb_docs::docs_search` does for pages.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard, RwLock};

use chrono::{DateTime, Duration, Utc};
use kb_base::secrets::redact;
use kb_base::{pyjson, time};
use kb_db::database;
use kb_db::entities::{ai_run, ai_run_transcript, ai_skill_use};
use kb_db::sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, IntoActiveModel, QueryFilter, Value as SqlValue,
};
use kb_db::sql::statement;
use kb_db::Session;
use serde_json::{Map, Value, json};

/// Characters of one string inside one event.
pub const MAX_TEXT: usize = 64_000;
/// Characters of a run's search document.
pub const MAX_INDEX: usize = 200_000;
pub const SUBAGENT_TOOLS: [&str; 2] = ["Task", "Agent"];

pub const CREATE_FTS: &str = "CREATE VIRTUAL TABLE IF NOT EXISTS ai_run_fts USING fts5(\
run_id UNINDEXED, project_id UNINDEXED, body, tokenize = 'unicode61 remove_diacritics 2')";

/// `_fts_broken`: FTS5 is missing in this SQLite.
static FTS_BROKEN: AtomicBool = AtomicBool::new(false);

/// Switch the index off (`true`) or on again (the Python tests patch `_fts_broken`).
pub fn set_fts_broken(broken: bool) {
    FTS_BROKEN.store(broken, Ordering::SeqCst);
}

/// `KANBAN_AI_RUNS_DIR` as set in this process (`None` goes back to the environment).
static ROOT_OVERRIDE: RwLock<Option<PathBuf>> = RwLock::new(None);

/// Set where transcripts live for this process, as `monkeypatch.setenv("KANBAN_AI_RUNS_DIR", ...)` does in Python.
pub fn set_root(path: Option<&Path>) {
    *ROOT_OVERRIDE.write().unwrap_or_else(|e| e.into_inner()) = path.map(Path::to_path_buf);
}

/// Where transcripts live: `KANBAN_AI_RUNS_DIR`, else `ai-runs` beside the database.
pub fn root() -> std::io::Result<PathBuf> {
    let set = ROOT_OVERRIDE.read().unwrap_or_else(|e| e.into_inner()).clone();
    let configured = set.or_else(|| std::env::var("KANBAN_AI_RUNS_DIR").ok().filter(|v| !v.is_empty()).map(PathBuf::from));
    let base = match configured {
        Some(base) => base,
        None => database::get_db_path().parent().map(Path::to_path_buf).unwrap_or_default().join("ai-runs"),
    };
    std::fs::create_dir_all(&base)?;
    Ok(base)
}

fn now() -> String {
    time::now_iso()
}

/// The `message.content` of a stream event, or None. A CLI may print an event whose `message` is plain text (or none at
/// all): every reader goes through here, so such an event is skipped, never a crash.
pub fn content_of(event: &Value) -> Option<&Value> {
    let content = event.as_object()?.get("message")?.as_object()?.get("content")?;
    matches!(content, Value::Array(_) | Value::String(_)).then_some(content)
}

/// The content blocks of a stream event (dicts only), [] when it has none.
pub fn blocks_of(event: &Value) -> Vec<&Map<String, Value>> {
    match content_of(event) {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_object).collect(),
        _ => Vec::new(),
    }
}

/// `f"{n:,}"`.
fn thousands(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// Redact every string of a JSON value and cut very long ones.
pub fn mask(value: &Value) -> Value {
    match value {
        Value::String(s) => {
            let out = redact(s);
            let len = out.chars().count();
            if len > MAX_TEXT {
                let kept: String = out.chars().take(MAX_TEXT).collect();
                Value::String(format!("{kept}\n… [{} more characters not kept]", thousands(len - MAX_TEXT)))
            } else {
                Value::String(out)
            }
        }
        Value::Array(items) => Value::Array(items.iter().map(mask).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), mask(v))).collect()),
        other => other.clone(),
    }
}

/// A transcript being written: the file stays open for the run's lifetime (restarts append to it).
struct Open {
    file: std::fs::File,
    events: usize,
    /// (kind, name)
    skills: Vec<(String, String)>,
}

impl Open {
    fn new(path: &Path) -> std::io::Result<Self> {
        Ok(Self { file: std::fs::OpenOptions::new().append(true).create(true).open(path)?, events: 0, skills: Vec::new() })
    }

    fn write(&mut self, record: &Value) -> std::io::Result<()> {
        let line = pyjson::Dumps::new().ensure_ascii(false).dump(record) + "\n";
        self.file.write_all(line.as_bytes())?;
        self.file.flush()?;
        self.events += 1;
        Ok(())
    }
}

static OPEN: LazyLock<Mutex<HashMap<String, Open>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn open_map() -> MutexGuard<'static, HashMap<String, Open>> {
    OPEN.lock().unwrap_or_else(|e| e.into_inner())
}

fn path_for(run_id: &str, started: Option<&str>) -> std::io::Result<PathBuf> {
    let started = started.filter(|s| !s.is_empty()).map_or_else(now, str::to_string);
    let month: String = started.chars().take(7).collect();
    let folder = root()?.join(month);
    std::fs::create_dir_all(&folder)?;
    Ok(folder.join(format!("{run_id}.jsonl")))
}

/// The command line without the prompt texts (recorded on their own) and with the MCP config's headers and env values
/// masked.
pub fn safe_args(args: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let skip = ["-p", "--append-system-prompt", "--system-prompt"];
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if skip.contains(&a.as_str()) && i + 1 < args.len() {
            out.push(a.clone());
            out.push("<recorded above>".to_string());
            i += 2;
            continue;
        }
        if a == "--mcp-config" && i + 1 < args.len() {
            match serde_json::from_str::<Value>(&args[i + 1]) {
                Ok(Value::Object(mut cfg)) => {
                    if let Some(Value::Object(servers)) = cfg.get_mut("mcpServers").filter(|s| pyjson::truthy(s)) {
                        for server in servers.values_mut() {
                            let Some(server) = server.as_object_mut() else { continue };
                            // headers carry tokens, and an env carries whatever the server needs (an API key, a DATABASE_URL
                            // with its password): the names are kept, never a value
                            for part in ["headers", "env"] {
                                if let Some(Value::Object(inner)) = server.get_mut(part).filter(|p| pyjson::truthy(p)) {
                                    for v in inner.values_mut() {
                                        *v = json!("••••••••");
                                    }
                                }
                            }
                        }
                    }
                    out.push(a.clone());
                    out.push(pyjson::dumps(&Value::Object(cfg)));
                }
                _ => {
                    out.push(a.clone());
                    out.push("<mcp config>".to_string());
                }
            }
            i += 2;
            continue;
        }
        out.push(a.clone());
        i += 1;
    }
    out.iter().map(|x| redact(x)).collect()
}

/// What `begin` records (the keyword arguments of the Python function).
#[derive(Default)]
pub struct Begin<'a> {
    pub project_id: &'a str,
    pub member_id: &'a str,
    pub system: Option<&'a str>,
    pub prompt: Option<&'a str>,
    pub args: &'a [String],
    pub resume: bool,
    pub session_id: Option<&'a str>,
    pub note: Option<&'a str>,
    pub started_at: Option<&'a str>,
}

/// Open (or reopen, after a restart inside the run) a run's transcript and record what the board sent the CLI. A
/// transcript that was finished stays as it is.
pub async fn begin(run_id: &str, b: Begin<'_>) -> Result<(), DbErr> {
    let have = open_map().contains_key(run_id);
    if !have {
        let session = database::session();
        let row = match ai_run_transcript::Entity::find_by_id(run_id).one(&session).await? {
            Some(row) => row,
            None => {
                let path = match path_for(run_id, b.started_at) {
                    Ok(path) => path,
                    Err(err) => {
                        tracing::error!("Could not open the transcript of run {run_id}: {err}");
                        return Ok(());
                    }
                };
                let mut row = ai_run_transcript::new();
                row.run_id = kb_db::sea_orm::ActiveValue::Set(run_id.to_string());
                row.project_id = kb_db::sea_orm::ActiveValue::Set(b.project_id.to_string());
                row.member_id = kb_db::sea_orm::ActiveValue::Set(Some(b.member_id.to_string()));
                row.path = kb_db::sea_orm::ActiveValue::Set(path.to_string_lossy().into_owned());
                row.started_at = kb_db::sea_orm::ActiveValue::Set(b.started_at.filter(|s| !s.is_empty()).map_or_else(now, str::to_string));
                let row = row.insert(&session).await?;
                session.commit().await?;
                row
            }
        };
        if row.ended_at.as_ref().is_some_and(|e| !e.is_empty()) || existing(Path::new(&row.path)).extension().is_some_and(|e| e == "gz") {
            // an ended run is never reopened (a retry is a new run): a late start for it, after a cancel, must not
            // reopen the finished, compressed and indexed transcript
            return Ok(());
        }
        match Open::new(Path::new(&row.path)) {
            Ok(opened) => {
                open_map().insert(run_id.to_string(), opened);
            }
            Err(err) => {
                tracing::error!("Could not open the transcript of run {run_id}: {err}");
                return Ok(());
            }
        }
    }
    let record = json!({
        "t": now(),
        "k": "sent",
        "system": mask(&json!(b.system.unwrap_or(""))),
        "prompt": mask(&json!(b.prompt.unwrap_or(""))),
        "note": b.note.filter(|n| !n.is_empty()).map(|n| mask(&json!(n))),
        "resume": b.resume,
        "session_id": b.session_id,
        "args": safe_args(b.args),
    });
    if let Some(opened) = open_map().get_mut(run_id) {
        if let Err(err) = opened.write(&record) {
            tracing::error!("Could not open the transcript of run {run_id}: {err}");
        }
    }
    Ok(())
}

/// One stdout line of the CLI. Non-JSON lines are kept as text.
pub fn feed(run_id: &str, line: &str) {
    let mut map = open_map();
    let Some(opened) = map.get_mut(run_id) else { return };
    let line = kb_base::pytext::strip(line);
    if line.is_empty() {
        return;
    }
    let event: Option<Value> = if line.starts_with('{') { serde_json::from_str(line).ok() } else { None };
    let Some(event) = event else {
        if let Err(err) = opened.write(&json!({"t": now(), "k": "text", "text": mask(&json!(line))})) {
            tracing::error!("Could not write the transcript of run {run_id}: {err}");
        }
        return;
    };
    if let Err(err) = opened.write(&json!({"t": now(), "k": "event", "e": mask(&event)})) {
        tracing::error!("Could not write the transcript of run {run_id}: {err}");
        return;
    }
    if event.get("type") == Some(&json!("assistant")) {
        for block in blocks_of(&event) {
            if block.get("type") != Some(&json!("tool_use")) {
                continue;
            }
            let empty = Map::new();
            let inp = block.get("input").and_then(Value::as_object).unwrap_or(&empty);
            let name = block.get("name").and_then(Value::as_str);
            let shown = |v: &Value| -> String { pyjson::py_str(v).chars().take(120).collect() };
            if name == Some("Skill") && inp.get("skill").is_some_and(pyjson::truthy) {
                opened.skills.push(("skill".to_string(), shown(&inp["skill"])));
            } else if name.is_some_and(|n| SUBAGENT_TOOLS.contains(&n)) {
                let named = ["subagent_type", "agent"].iter().find_map(|k| inp.get(*k).filter(|v| pyjson::truthy(v)));
                let who = named.map_or_else(|| "general-purpose".to_string(), shown);
                opened.skills.push(("subagent".to_string(), who));
            }
        }
    }
}

/// A line the board adds itself: a restart, a diagnosis, a message a person sent, a rule that fired.
pub fn note(run_id: &str, kind: &str, text: &str, data: Option<&Map<String, Value>>) {
    let mut map = open_map();
    let Some(opened) = map.get_mut(run_id) else { return };
    let mut record = Map::new();
    record.insert("t".into(), json!(now()));
    record.insert("k".into(), json!("note"));
    record.insert("kind".into(), json!(kind));
    record.insert("text".into(), mask(&json!(text)));
    if let Some(Value::Object(extra)) = data.map(|d| mask(&Value::Object(d.clone()))) {
        for (k, v) in extra {
            record.insert(k, v);
        }
    }
    if let Err(err) = opened.write(&Value::Object(record)) {
        tracing::error!("Could not write the transcript of run {run_id}: {err}");
    }
}

fn gzip_copy(src: &Path, dst: &Path) -> std::io::Result<()> {
    let mut raw = Vec::new();
    std::fs::File::open(src)?.read_to_end(&mut raw)?;
    let mut packed = flate2::write::GzEncoder::new(std::fs::File::create(dst)?, flate2::Compression::best());
    packed.write_all(&raw)?;
    packed.finish()?;
    Ok(())
}

fn packed(path: &Path) -> PathBuf {
    let mut text = path.as_os_str().to_os_string();
    text.push(".gz");
    PathBuf::from(text)
}

/// The file a recorded path stands for: the path itself, else its compressed sibling (a finish that compressed it but
/// could not record the new name).
pub fn existing(path: &Path) -> PathBuf {
    if path.extension().is_none_or(|e| e != "gz") && !path.exists() && packed(path).exists() {
        return packed(path);
    }
    path.to_path_buf()
}

/// Every record of a transcript file (a line that is not JSON is skipped), [] when it cannot be read.
pub fn read_lines(path: &Path) -> Vec<Value> {
    let path = existing(path);
    let text = if path.extension().is_some_and(|e| e == "gz") {
        let mut text = String::new();
        let ok = std::fs::File::open(&path).and_then(|f| flate2::read::MultiGzDecoder::new(f).read_to_string(&mut text)).is_ok();
        if !ok {
            return Vec::new();
        }
        text
    } else {
        match std::fs::read(&path) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(_) => return Vec::new(),
        }
    };
    text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).collect()
}

/// Every record of a run's transcript, or None when the board has none (an old run, or it was deleted).
pub async fn read(run_id: &str) -> Result<Option<Vec<Value>>, DbErr> {
    let session = database::session();
    let row = ai_run_transcript::Entity::find_by_id(run_id).one(&session).await?;
    Ok(match row {
        Some(row) if !row.deleted_at.as_ref().is_some_and(|d| !d.is_empty()) => Some(read_lines(Path::new(&row.path))),
        _ => None,
    })
}

fn rec_text(value: Option<&Value>) -> String {
    match value {
        Some(v) if pyjson::truthy(v) => pyjson::py_str(v),
        _ => String::new(),
    }
}

/// What a search finds a run by.
pub fn index_text(records: &[Value], run: Option<&ai_run::Model>) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(run) = run {
        parts.push(run.summary.clone().unwrap_or_default());
        parts.push(run.instruction.clone());
        parts.push(run.ended_reason.clone().unwrap_or_default());
        for raw in [&run.question, &run.answer] {
            let q: Value = match raw.as_deref().filter(|r| !r.is_empty()) {
                Some(raw) => serde_json::from_str(raw).unwrap_or_else(|_| json!(raw)),
                None => Value::Null,
            };
            match &q {
                Value::Object(map) => parts.push(rec_text(map.get("text"))),
                v if pyjson::truthy(v) => parts.push(pyjson::py_str(v)),
                _ => {}
            }
        }
        if let Ok(Value::Array(files)) = serde_json::from_str::<Value>(if run.files.is_empty() { "[]" } else { &run.files }) {
            for f in files {
                if let Some(path) = f.as_object() {
                    parts.push(path.get("path").map(pyjson::py_str).unwrap_or_default());
                }
            }
        }
    }
    for rec in records {
        let Some(rec) = rec.as_object() else { continue };
        let kind = rec.get("k").and_then(Value::as_str);
        if kind == Some("note") {
            parts.push(rec_text(rec.get("text")));
            continue;
        }
        let Some(ev) = rec.get("e").filter(|_| kind == Some("event")).filter(|e| e.is_object()) else { continue };
        let Some(Value::Array(content)) = content_of(ev) else { continue };
        for block in content {
            let Some(block) = block.as_object() else { continue };
            match block.get("type").and_then(Value::as_str) {
                Some("text") => parts.push(rec_text(block.get("text"))),
                Some("tool_use") => {
                    let empty = Map::new();
                    let inp = block.get("input").and_then(Value::as_object).unwrap_or(&empty);
                    parts.push(rec_text(block.get("name")));
                    for key in ["command", "file_path", "pattern", "skill", "subagent_type", "description"] {
                        if let Some(v) = inp.get(key).filter(|v| pyjson::truthy(v)) {
                            parts.push(pyjson::py_str(v));
                        }
                    }
                }
                Some("tool_result") if block.get("is_error").is_some_and(pyjson::truthy) => {
                    let body = match block.get("content") {
                        Some(Value::Array(items)) => Value::String(
                            items
                                .iter()
                                .filter_map(Value::as_object)
                                .map(|c| c.get("text").map_or(String::new(), pyjson::py_str))
                                .collect::<Vec<_>>()
                                .join(" "),
                        ),
                        Some(other) => other.clone(),
                        None => Value::Null,
                    };
                    let text = if pyjson::truthy(&body) { pyjson::py_str(&body) } else { String::new() };
                    parts.push(text.chars().take(2000).collect());
                }
                _ => {}
            }
        }
    }
    let doc = parts.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n");
    doc.chars().take(MAX_INDEX).collect()
}

async fn fts_ready(session: &Session) -> bool {
    if FTS_BROKEN.load(Ordering::SeqCst) {
        return false;
    }
    if session.dialect() != "sqlite" {
        return false;
    }
    if session.execute_unprepared(CREATE_FTS).await.is_err() {
        FTS_BROKEN.store(true, Ordering::SeqCst);
        return false;
    }
    true
}

/// (Re)write a run's row in the search index.
pub async fn index(session: &Session, run: &ai_run::Model, records: &[Value]) -> Result<(), DbErr> {
    if !fts_ready(session).await {
        return Ok(());
    }
    let backend = session.get_database_backend();
    session
        .execute_raw(statement(backend, "DELETE FROM ai_run_fts WHERE run_id = ?", [SqlValue::from(run.id.as_str())]))
        .await?;
    session
        .execute_raw(statement(
            backend,
            "INSERT INTO ai_run_fts (run_id, project_id, body) VALUES (?, ?, ?)",
            [SqlValue::from(run.id.as_str()), SqlValue::from(run.project_id.as_str()), SqlValue::from(index_text(records, Some(run)))],
        ))
        .await?;
    Ok(())
}

/// The run ended: close and compress its transcript, record the skills it used, index it for search. The file and its
/// row are settled first and on their own: a search index that fails never leaves the row naming a file that is gone.
pub async fn finish(run_id: &str) {
    let opened = open_map().remove(run_id);
    let skills = opened.map(|o| o.skills).unwrap_or_default();
    if let Err(err) = finish_inner(run_id, skills).await {
        tracing::error!("Could not finish the transcript of run {run_id}: {err}");
    }
}

async fn finish_inner(run_id: &str, skills: Vec<(String, String)>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let session = database::session();
    let row = ai_run_transcript::Entity::find_by_id(run_id).one(&session).await?;
    let run = ai_run::Entity::find_by_id(run_id).one(&session).await?;
    let (Some(row), Some(run)) = (row, run) else { return Ok(()) };
    let mut path = existing(Path::new(&row.path));
    let records = read_lines(&path);
    let mut plain: Option<PathBuf> = None;
    if path.extension().is_none_or(|e| e != "gz") && path.exists() {
        let target = packed(&path);
        let (src, dst) = (path.clone(), target.clone());
        tokio::task::spawn_blocking(move || gzip_copy(&src, &dst)).await??;
        plain = Some(path);
        path = target;
    }
    let size = std::fs::metadata(&path).map_or(0, |m| m.len());
    let mut active = row.into_active_model();
    active.path = kb_db::sea_orm::ActiveValue::Set(path.to_string_lossy().into_owned());
    active.bytes = kb_db::sea_orm::ActiveValue::Set(i32::try_from(size).unwrap_or(i32::MAX));
    active.events = kb_db::sea_orm::ActiveValue::Set(i32::try_from(records.len()).unwrap_or(i32::MAX));
    active.ended_at = kb_db::sea_orm::ActiveValue::Set(Some(now()));
    active.update(&session).await?;
    for (kind, name) in skills {
        let plugin = name.split_once(':').map(|(p, _)| p.to_string());
        let mut use_row = ai_skill_use::new();
        use_row.run_id = kb_db::sea_orm::ActiveValue::Set(run_id.to_string());
        use_row.project_id = kb_db::sea_orm::ActiveValue::Set(run.project_id.clone());
        use_row.member_id = kb_db::sea_orm::ActiveValue::Set(Some(run.member_id.clone()));
        use_row.kind = kb_db::sea_orm::ActiveValue::Set(kind);
        use_row.name = kb_db::sea_orm::ActiveValue::Set(name);
        use_row.plugin = kb_db::sea_orm::ActiveValue::Set(plugin);
        use_row.insert(&session).await?;
    }
    // the run is searchable the moment it is recorded as ended; an index that fails loses only itself (a failed
    // statement of SQLite leaves the transaction usable)
    if let Err(err) = index(&session, &run, &records).await {
        tracing::error!("Could not index the transcript of run {run_id}: {err}");
    }
    session.commit().await?;
    if let Some(plain) = plain {
        // only once the row names the compressed file
        let _ = std::fs::remove_file(plain);
    }
    Ok(())
}

/// A pinned run's transcript is kept whatever the retention.
pub async fn pin(run_id: &str, on: bool, by: &str) -> Result<Option<ai_run_transcript::Model>, DbErr> {
    let session = database::session();
    let Some(row) = ai_run_transcript::Entity::find_by_id(run_id).one(&session).await? else { return Ok(None) };
    let mut active = row.into_active_model();
    active.pinned = kb_db::sea_orm::ActiveValue::Set(on);
    active.pinned_by = kb_db::sea_orm::ActiveValue::Set(on.then(|| by.to_string()));
    let row = active.update(&session).await?;
    session.commit().await?;
    Ok(Some(row))
}

/// Delete the transcripts of runs that ended more than `retention_days` ago and are not pinned. The run itself (its
/// summary, steps, files and cost) stays.
pub async fn prune(retention_days: i64, now_at: Option<DateTime<Utc>>) -> Result<u64, DbErr> {
    let cutoff = time::iso(&(now_at.unwrap_or_else(Utc::now) - Duration::days(retention_days)));
    let session = database::session();
    let rows = ai_run_transcript::Entity::find()
        .filter(ai_run_transcript::Column::EndedAt.is_not_null())
        .filter(ai_run_transcript::Column::EndedAt.lt(cutoff))
        .filter(ai_run_transcript::Column::Pinned.eq(false))
        .filter(ai_run_transcript::Column::DeletedAt.is_null())
        .all(&session)
        .await?;
    let mut removed = 0;
    for row in rows {
        let _ = std::fs::remove_file(existing(Path::new(&row.path)));
        let mut active = row.into_active_model();
        active.deleted_at = kb_db::sea_orm::ActiveValue::Set(Some(now()));
        active.bytes = kb_db::sea_orm::ActiveValue::Set(0);
        active.update(&session).await?;
        removed += 1;
    }
    session.commit().await?;
    Ok(removed)
}

/// How much space transcripts take: `{bytes, runs, pinned}`.
pub async fn usage() -> Result<Map<String, Value>, DbErr> {
    let session = database::session();
    let rows = ai_run_transcript::Entity::find().filter(ai_run_transcript::Column::DeletedAt.is_null()).all(&session).await?;
    let mut out = Map::new();
    out.insert("bytes".into(), json!(rows.iter().map(|r| i64::from(r.bytes)).sum::<i64>()));
    out.insert("runs".into(), json!(rows.len()));
    out.insert("pinned".into(), json!(rows.iter().filter(|r| r.pinned).count()));
    Ok(out)
}

/// Python's `\w` (letters, digits and the underscore) or one of `-./`: the characters of a word of `_WORD`.
fn is_word_char(c: char) -> bool {
    c == '_' || c.is_alphanumeric() || matches!(c, '-' | '.' | '/')
}

/// `_WORD.findall(text)`: runs of word characters.
fn words_of(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for c in text.chars() {
        if is_word_char(c) {
            cur.push(c);
        } else if !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// User words to an FTS5 query where every word must appear (each one quoted, so nothing can break the syntax).
pub fn fts_query(q: &str) -> Option<String> {
    let words: Vec<String> =
        words_of(q).into_iter().filter(|w| !w.trim_matches(['-', '.', '/']).is_empty()).take(12).collect();
    if words.is_empty() {
        return None;
    }
    Some(words.iter().map(|w| format!("\"{}\"", w.replace('"', ""))).collect::<Vec<_>>().join(" "))
}

/// Run ids that match `q`, best first; None when the index cannot be used (the caller falls back). With `project_id` only
/// that project's runs count, inside the query (the cap would otherwise go to other projects).
pub async fn search_ids(session: &Session, q: &str, limit: i64, project_id: Option<&str>) -> Result<Option<Vec<String>>, DbErr> {
    let Some(query) = fts_query(q) else { return Ok(Some(Vec::new())) };
    if !fts_ready(session).await {
        return Ok(None);
    }
    let project_id = project_id.filter(|p| !p.is_empty());
    let mut sql = String::from("SELECT run_id FROM ai_run_fts WHERE ai_run_fts MATCH ? ");
    let mut values: Vec<SqlValue> = vec![query.into()];
    if let Some(p) = project_id {
        sql.push_str("AND project_id = ? ");
        values.push(p.into());
    }
    sql.push_str("ORDER BY rank LIMIT ?");
    values.push(limit.into());
    let Ok(rows) = session.query_all_raw(statement(session.get_database_backend(), &sql, values)).await else {
        return Ok(None);
    };
    let mut out = Vec::new();
    for row in rows {
        out.push(row.try_get_by_index::<String>(0)?);
    }
    Ok(Some(out))
}

/// A short piece of the transcript around the first word of `q`, to show under a search result.
pub fn snippet(records: &[Value], q: &str, width: usize) -> Option<String> {
    let words: Vec<String> = words_of(q).iter().map(|w| w.to_lowercase()).collect();
    let first: Vec<char> = words.first()?.chars().collect();
    for rec in records {
        if rec.get("k") != Some(&json!("event")) {
            continue;
        }
        let Some(Value::Array(content)) = rec.get("e").and_then(content_of) else { continue };
        for block in content {
            let Some(block) = block.as_object() else { continue };
            let body = match block.get("text") {
                Some(Value::String(s)) if !s.is_empty() => s.clone(),
                _ => {
                    let input = block.get("input").filter(|v| pyjson::truthy(v)).cloned().unwrap_or_else(|| json!(""));
                    pyjson::Dumps::new().ensure_ascii(false).dump(&input)
                }
            };
            let low: Vec<char> = body.to_lowercase().chars().collect();
            let Some(hit) = find_chars(&low, &first) else { continue };
            let chars: Vec<char> = body.chars().collect();
            let start = hit.saturating_sub(width / 2);
            let piece: String = chars.iter().skip(start).take(width).collect::<String>().replace('\n', " ");
            return Some(format!("{}{piece}…", if start > 0 { "…" } else { "" }));
        }
    }
    None
}

/// `low.find(word)` on characters.
fn find_chars(hay: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    (0..hay.len().checked_sub(needle.len())? + 1).find(|&i| hay[i..i + needle.len()] == *needle)
}
