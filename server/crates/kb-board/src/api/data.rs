//! `api/data.py`: backing up the board as a ZIP (the database and the uploads folder) and restoring from one.

use std::io::{self, Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use axum::Json;
use axum::body::Body as HttpBody;
use axum::extract::DefaultBodyLimit;
use axum::extract::multipart::{Multipart, MultipartRejection};
use axum::http::{HeaderValue, header};
use axum::response::Response;
use axum::routing::post;
use bytes::Bytes;
use kb_base::{ApiError, ApiResult, Routes, time};
use kb_db::database::{self as db, DatabaseError};
use kb_db::sea_orm::sqlx::sqlite::SqliteConnectOptions;
use kb_db::sea_orm::sqlx::{ConnectOptions, Connection, Error as SqlxError, Row};
use kb_db::sea_orm::{ConnectionTrait, TransactionTrait};
use kb_db::targets::{self, Target};
use kb_files::{pathlib, uploads};
use serde_json::{Value, json};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::hooks;
use crate::workspace::to_thread;

/// Delete the -wal/-shm files that belong to `db_path`.
///
/// They describe the *previous* database file. If they stay next to a replaced kanban.db, SQLite reads them as part
/// of the new file and fails with "database disk image is malformed".
pub fn remove_wal_files(db_path: &Path) {
    for suffix in ["-wal", "-shm"] {
        let mut name = db_path.as_os_str().to_os_string();
        name.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(name));
    }
}

/// `Path.with_suffix(".<suffix>")`.
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    path.with_extension(suffix)
}

/// What an import step fails with.
#[derive(Debug)]
enum Fail {
    /// An `HTTPException`: answered as it is.
    Http(ApiError),
    /// Any other exception: its text.
    Other(String),
}

impl From<io::Error> for Fail {
    fn from(err: io::Error) -> Self {
        Fail::Other(err.to_string())
    }
}

impl From<zip::result::ZipError> for Fail {
    fn from(err: zip::result::ZipError) -> Self {
        Fail::Other(err.to_string())
    }
}

fn too_large() -> Fail {
    Fail::Http(ApiError::bad_request("ZIP content too large (max 2 GB)"))
}

/// Copy kanban.db out of the ZIP into `dest`, refusing more than `max_bytes`.
fn extract_db_member(content: &Bytes, dest: &Path, max_bytes: u64) -> Result<(), Fail> {
    let mut archive = ZipArchive::new(Cursor::new(content.clone()))?;
    let mut src = archive.by_name("kanban.db")?;
    let mut dst = std::fs::File::create(dest)?;
    let mut copied: u64 = 0;
    let mut chunk = vec![0u8; 1024 * 1024];
    loop {
        let n = src.read(&mut chunk)?;
        if n == 0 {
            return Ok(());
        }
        copied += n as u64;
        if copied > max_bytes {
            return Err(too_large());
        }
        dst.write_all(&chunk[..n])?;
    }
}

/// What a failed SQLite call says (`str(sqlite3.DatabaseError)`).
fn sqlite_message(err: &SqlxError) -> String {
    match err {
        SqlxError::Database(err) => err.message().to_string(),
        other => other.to_string(),
    }
}

/// Return None if `path` is a healthy SQLite database, else a short reason.
pub async fn check_sqlite_file(path: &Path) -> Option<String> {
    let checked = async {
        let mut conn =
            SqliteConnectOptions::new().filename(path).read_only(true).disable_statement_logging().connect().await?;
        let row = sqlx_quick_check(&mut conn).await;
        let _ = conn.close().await;
        row
    }
    .await;
    match checked {
        Err(err) => Some(sqlite_message(&err)),
        Ok(Some(first)) if first == "ok" => None,
        Ok(Some(first)) => Some(first),
        Ok(None) => Some("empty result".to_string()),
    }
}

async fn sqlx_quick_check(conn: &mut kb_db::sea_orm::sqlx::SqliteConnection) -> Result<Option<String>, SqlxError> {
    let row = kb_db::sea_orm::sqlx::query("PRAGMA quick_check").fetch_optional(&mut *conn).await?;
    Ok(row.map(|row| row.try_get::<String, _>(0).unwrap_or_default()))
}

fn scratch_db(name: &str) -> io::Result<PathBuf> {
    let folder = db::get_data_dir().join(".db-tmp");
    std::fs::create_dir_all(&folder)?;
    Ok(folder.join(format!("{name}-{}.db", &time::uuid4_hex()[..8])))
}

fn remove_with_sidecars(path: &Path) {
    for suffix in ["", "-wal", "-shm"] {
        let mut name = path.as_os_str().to_os_string();
        name.push(suffix);
        let _ = std::fs::remove_file(PathBuf::from(name));
    }
}

/// A SQLite file with every table of the database in use (export from PostgreSQL or MySQL).
async fn portable_copy() -> Result<PathBuf, String> {
    let hook = hooks::db_move().ok_or_else(|| "the database kit is not available".to_string())?;
    let path = scratch_db("export").map_err(|err| err.to_string())?;
    hook.copy_current_to_sqlite(&path).await?;
    Ok(path)
}

/// Bring an imported SQLite file to the newest migration (an export from an older version).
async fn upgrade_file(path: &Path) -> Result<(), String> {
    let target = Target::sqlite(path.to_string_lossy().into_owned());
    let conn = targets::make_engine(&target, None).await.map_err(|err| err.to_string())?;
    let upgraded = async {
        let txn = conn.begin().await.map_err(|err| err.to_string())?;
        kb_db::migrations::upgrade(&txn).await.map_err(|err| err.to_string())?;
        txn.commit().await.map_err(|err| err.to_string())
    }
    .await;
    let _ = conn.close().await;
    upgraded
}

/// Replace the data of the PostgreSQL or MySQL database in use with the imported file. What was there is copied to a
/// SQLite file first and put back if anything fails.
async fn import_into_server(incoming: &Path) -> Result<(), String> {
    let hook = hooks::db_move().ok_or_else(|| "the database kit is not available".to_string())?;
    let current = db::current_target();
    upgrade_file(incoming).await?;
    let backup = scratch_db("before-import").map_err(|err| err.to_string())?;
    hook.copy_current_to_sqlite(&backup).await?;
    let _ = kb_db::conn().close_by_ref().await;
    let mut outcome = hook.copy_sqlite_into_current(incoming).await;
    if let Err(err) = &outcome {
        tracing::error!(
            target: "api.data",
            "Import into {} failed; putting the previous data back: {err}",
            current.label()
        );
        outcome = match hook.copy_sqlite_into_current(&backup).await {
            Ok(()) => outcome,
            Err(restore_error) => Err(restore_error),
        };
    }
    let reinit = db::reinit_db(None).await;
    for path in [&backup, incoming] {
        remove_with_sidecars(path);
    }
    reinit.map_err(|err| err.to_string())?;
    outcome
}

const MAX_UNCOMPRESSED: u64 = 2 * 1024 * 1024 * 1024; // 2 GB total uncompressed

/// Swap in the ZIP's uploads/ folder; returns how many files were written.
fn replace_uploads(
    content: &Bytes,
    names: &[String],
    uploads_dir: &Path,
    mut total_written: u64,
) -> Result<usize, Fail> {
    let mut import_count = 0;
    let upload_files: Vec<(usize, &String)> =
        names.iter().enumerate().filter(|(_, n)| n.starts_with("uploads/") && !n.ends_with('/')).collect();
    let resolved_uploads_dir = pathlib::resolve(uploads_dir);
    if upload_files.is_empty() {
        return Ok(import_count);
    }
    let mut archive = ZipArchive::new(Cursor::new(content.clone()))?;
    if uploads_dir.exists() {
        std::fs::remove_dir_all(uploads_dir)?;
    }
    std::fs::create_dir_all(uploads_dir)?;
    for (index, name) in upload_files {
        let rel = &name["uploads/".len()..];
        if rel.is_empty() {
            continue;
        }
        // Use basename only: strips any directory components from the user-supplied ZIP entry name, preventing
        // path traversal.
        let safe_name = pathlib::name(rel);
        if safe_name.is_empty() || safe_name == "." || safe_name == ".." {
            tracing::warn!(target: "api.data", "Skipped invalid ZIP entry: {name}");
            continue;
        }
        // ZIP Slip protection: resolve and assert containment
        let dest = pathlib::resolve(&uploads_dir.join(safe_name));
        if !dest.starts_with(&resolved_uploads_dir) {
            tracing::warn!(target: "api.data", "Skipped malicious ZIP entry: {name}");
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let src = archive.by_index(index)?;
        let mut data = Vec::new();
        src.take(MAX_UNCOMPRESSED.saturating_sub(total_written) + 1).read_to_end(&mut data)?;
        if total_written + data.len() as u64 > MAX_UNCOMPRESSED {
            return Err(too_large());
        }
        total_written += data.len() as u64;
        std::fs::write(&dest, &data)?;
        import_count += 1;
    }
    Ok(import_count)
}

/// The routes of this file.
pub fn routes() -> Routes {
    Routes::new().nest(
        "/data",
        Routes::new()
            .get("/export", export_data)
            // the ZIP is read up to 500 MB: the body limit of the extractors is lifted, the handler caps what it keeps
            .add("POST", "/import", post(import_data).layer(DefaultBodyLimit::disable())),
    )
}

/// Every file under `dir` (links to files included, links to folders not followed), with the name it gets in the ZIP.
fn upload_files(dir: &Path, prefix: &str, out: &mut Vec<(PathBuf, String)>) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = read.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let name = format!("{prefix}{}", entry.file_name().to_string_lossy());
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            upload_files(&path, &format!("{name}/"), out);
        } else if path.is_file() {
            out.push((path, name));
        }
    }
}

/// The ZIP of the database file and the uploads folder, in a file that goes away when it is closed.
fn build_zip(db_path: &Path, uploads_dir: &Path, portable: Option<&Path>) -> io::Result<std::fs::File> {
    let file = tempfile::tempfile()?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated).unix_permissions(0o644);
    let mut add = |source: &Path, arcname: &str| -> io::Result<()> {
        let size = std::fs::metadata(source)?.len();
        zip.start_file(arcname, options.large_file(size >= u32::MAX as u64)).map_err(io::Error::other)?;
        io::copy(&mut std::fs::File::open(source)?, &mut zip)?;
        Ok(())
    };
    if db_path.exists() {
        add(db_path, "kanban.db")?;
    }
    if uploads_dir.exists() {
        let mut files = Vec::new();
        upload_files(uploads_dir, "uploads/", &mut files);
        for (path, arcname) in files {
            add(&path, &arcname)?;
        }
    }
    let mut file = zip.finish().map_err(io::Error::other)?;
    if let Some(portable) = portable {
        remove_with_sidecars(portable);
    }
    file.seek(SeekFrom::Start(0))?;
    Ok(file)
}

/// Stream a ZIP file containing kanban.db and the uploads/ directory.
async fn export_data() -> ApiResult<Response> {
    let mut db_path = db::get_db_path();
    let uploads_dir = uploads::get_uploads_dir(false);
    let mut portable: Option<PathBuf> = None;

    if db::is_sqlite() {
        // Flush all WAL data into the main DB file before reading it.
        // In WAL mode recent commits live in kanban.db-wal, not in kanban.db itself.
        // Without this checkpoint the exported ZIP contains a stale snapshot.
        kb_db::conn().execute_unprepared("PRAGMA wal_checkpoint(TRUNCATE)").await?;
    } else {
        // PostgreSQL or MySQL: the ZIP holds the same portable file, a SQLite copy of every table made by the copy
        // code that moves between databases, so one export loads into any engine (and into older versions of the app)
        let path = portable_copy().await.map_err(ApiError::internal)?;
        portable = Some(path.clone());
        db_path = path;
    }

    let file = to_thread(move || build_zip(&db_path, &uploads_dir, portable.as_deref())).await?;
    let length = file.metadata()?.len();
    let stream = tokio_util::io::ReaderStream::new(tokio::fs::File::from_std(file));
    let mut response = Response::new(HttpBody::from_stream(stream));
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/zip"));
    headers.insert(header::CONTENT_DISPOSITION, HeaderValue::from_static("attachment; filename=kanban-export.zip"));
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    Ok(response)
}

fn parse_error() -> ApiError {
    ApiError::bad_request("There was an error parsing the body")
}

/// The `file` part of a form: its name and its first `limit` bytes (the rest is read and dropped).
async fn read_file_part(multipart: Result<Multipart, MultipartRejection>, limit: usize) -> ApiResult<(String, Bytes)> {
    let missing = || ApiError::validation(&["body", "file"], "Field required", "missing");
    let mut multipart = multipart.map_err(|_| missing())?;
    let mut found: Option<(String, Vec<u8>)> = None;
    while let Some(mut field) = multipart.next_field().await.map_err(|_| parse_error())? {
        if field.name() == Some("file") && field.file_name().is_some() {
            let filename = field.file_name().unwrap_or("").to_string();
            let mut data: Vec<u8> = Vec::new();
            while let Some(chunk) = field.chunk().await.map_err(|_| parse_error())? {
                let room = limit.saturating_sub(data.len());
                data.extend_from_slice(&chunk[..chunk.len().min(room)]);
            }
            found = Some((filename, data));
        }
    }
    let (filename, data) = found.ok_or_else(missing)?;
    Ok((filename, Bytes::from(data)))
}

/// Accept a ZIP file (from export), fully replace kanban.db and uploads/, then reinit the DB engine.
async fn import_data(multipart: Result<Multipart, MultipartRejection>) -> ApiResult<Json<Value>> {
    const MAX_UPLOAD_BYTES: usize = 500 * 1024 * 1024; // 500 MB raw cap
    const MAX_FILES: usize = 50_000;

    let (filename, content) = read_file_part(multipart, MAX_UPLOAD_BYTES + 1).await?;
    if filename.is_empty() || !filename.ends_with(".zip") {
        return Err(ApiError::bad_request("Only .zip files are accepted"));
    }
    if content.len() > MAX_UPLOAD_BYTES {
        return Err(ApiError::code(413, "File too large (max 500 MB)"));
    }
    if content.is_empty() {
        return Err(ApiError::bad_request("Empty file"));
    }

    let names: Vec<String> = {
        let content = content.clone();
        let listed = to_thread(move || {
            Ok(match ZipArchive::new(Cursor::new(content)) {
                Ok(archive) => {
                    let names: Vec<String> =
                        (0..archive.len()).map(|i| archive.name_for_index(i).unwrap_or_default().to_string()).collect();
                    Some(names)
                }
                Err(_) => None,
            })
        })
        .await?;
        listed.ok_or_else(|| ApiError::bad_request("Invalid ZIP file"))?
    };
    if names.len() > MAX_FILES {
        return Err(ApiError::bad_request("Too many files in ZIP"));
    }
    if !names.iter().any(|n| n == "kanban.db") {
        return Err(ApiError::bad_request("ZIP must contain kanban.db"));
    }

    let db_path = db::get_db_path();
    let uploads_dir = uploads::get_uploads_dir(true);

    // Read the uploaded database into a temp file first and check it, so a broken backup is rejected before anything
    // on disk is touched.
    let incoming_db = with_suffix(&db_path, "import");
    let extracted = {
        let (content, incoming) = (content.clone(), incoming_db.clone());
        to_thread(move || Ok(extract_db_member(&content, &incoming, MAX_UNCOMPRESSED))).await?
    };
    let problem = match extracted {
        Ok(()) => {
            let problem = check_sqlite_file(&incoming_db).await;
            // the check can leave -wal/-shm files behind
            remove_wal_files(&incoming_db);
            problem
        }
        Err(fail) => {
            let _ = std::fs::remove_file(&incoming_db);
            return Err(match fail {
                Fail::Http(err) => err,
                Fail::Other(message) => ApiError::internal(message),
            });
        }
    };
    if let Some(problem) = problem {
        let _ = std::fs::remove_file(&incoming_db);
        return Err(ApiError::bad_request(format!("kanban.db in the ZIP is not a valid database: {problem}")));
    }

    if !db::is_sqlite() {
        // PostgreSQL or MySQL: the file's tables replace the server's, with a copy of what was there to fall back on
        // (the copy code that moves between databases)
        let staged = scratch_db("import")?;
        std::fs::rename(&incoming_db, &staged)?;
        if let Err(exc) = import_into_server(&staged).await {
            return Err(ApiError::code(500, format!("Import failed: {exc}. Previous data restored.")));
        }
        let written = std::fs::metadata(&staged).map(|m| m.len()).unwrap_or(0);
        let count = replace_uploads_blocking(&content, &names, &uploads_dir, written).await.map_err(fail_to_api)?;
        return Ok(Json(json!({"status": "ok", "imported_uploads": count})));
    }

    // Backup DB before any destructive operation. Fold the WAL into the main file first, otherwise recent changes
    // would be missing from the backup.
    let backup_db = with_suffix(&db_path, "bak");
    if db_path.exists() {
        if let Err(err) = kb_db::conn().execute_unprepared("PRAGMA wal_checkpoint(TRUNCATE)").await {
            tracing::error!(target: "api.data", "WAL checkpoint before import failed; continuing: {err}");
        }
        std::fs::copy(&db_path, &backup_db)?;
    }

    let swapped = async {
        // Dispose current engine before replacing the DB file
        let _ = kb_db::conn().close_by_ref().await;

        // Swap in the checked database, together with removing the old WAL files
        let total_written = std::fs::metadata(&incoming_db)?.len();
        if total_written > MAX_UNCOMPRESSED {
            return Err(too_large());
        }
        remove_wal_files(&db_path);
        std::fs::rename(&incoming_db, &db_path)?;

        let import_count = replace_uploads_blocking(&content, &names, &uploads_dir, total_written).await?;

        // Reinit DB with same path
        db::reinit_db(Some(db_path.clone())).await.map_err(|err: DatabaseError| Fail::Other(err.to_string()))?;
        let _ = std::fs::remove_file(&backup_db);
        Ok(import_count)
    }
    .await;

    match swapped {
        Ok(import_count) => Ok(Json(json!({"status": "ok", "imported_uploads": import_count}))),
        Err(exc) => {
            // Restore DB from backup
            let _ = std::fs::remove_file(&incoming_db);
            if backup_db.exists() {
                remove_wal_files(&db_path);
                let restored = std::fs::copy(&backup_db, &db_path).and_then(|_| std::fs::remove_file(&backup_db));
                if let Err(err) = restored {
                    tracing::error!(target: "api.data", "Failed to restore DB backup after import error: {err}");
                }
            }
            if let Err(err) = db::reinit_db(Some(db_path.clone())).await {
                tracing::error!(target: "api.data", "Failed to reinit DB after import rollback: {err}");
            }
            match exc {
                Fail::Http(err) => Err(err),
                Fail::Other(message) => {
                    Err(ApiError::code(500, format!("Import failed: {message}. Previous data restored.")))
                }
            }
        }
    }
}

fn fail_to_api(fail: Fail) -> ApiError {
    match fail {
        Fail::Http(err) => err,
        Fail::Other(message) => ApiError::internal(message),
    }
}

/// `replace_uploads` off the async threads.
async fn replace_uploads_blocking(
    content: &Bytes,
    names: &[String],
    uploads_dir: &Path,
    total_written: u64,
) -> Result<usize, Fail> {
    let (content, names, uploads_dir) = (content.clone(), names.to_vec(), uploads_dir.to_path_buf());
    tokio::task::spawn_blocking(move || replace_uploads(&content, &names, &uploads_dir, total_written))
        .await
        .map_err(|err| Fail::Other(err.to_string()))?
}
