//! What a person (or an AI) does to the files inside a ticket's workspace: make a folder, upload, preview, download,
//! delete, open in the file manager. Every path is resolved under the workspace folder first.

use std::io::Read;
use std::path::{MAIN_SEPARATOR_STR, Path, PathBuf};

use kb_base::pypath;
use kb_db::Session;
use kb_files::pathlib;
use serde_json::{Value, json};

use super::{Error, enabled_folder, mkdir_parents, resolve_inside, to_thread};

/// The largest file an upload may bring.
pub const MAX_UPLOAD_BYTES: usize = 50 * 1024 * 1024;
/// How much of a file the preview reads.
pub const MAX_PREVIEW_BYTES: usize = 512 * 1024;
const IMAGE_TYPES: [(&str, &str); 5] = [
    (".png", "image/png"),
    (".jpg", "image/jpeg"),
    (".jpeg", "image/jpeg"),
    (".gif", "image/gif"),
    (".webp", "image/webp"),
];

/// Create a sub-folder inside the ticket's workspace. `rel` is the folder path relative to the workspace; returns
/// the folder's path relative to the workspace.
pub async fn create_folder(session: &Session, ticket_id: &str, rel: &str) -> Result<String, Error> {
    let folder = enabled_folder(session, ticket_id).await?;
    let target = resolve_inside(&folder, rel).await?;
    mkdir_parents(&target).await?;
    Ok(relative_to_folder(&folder, &target).await)
}

/// `str(target.relative_to(os.path.realpath(folder)))`; `target` is inside the folder, which `resolve_inside` ensures.
async fn relative_to_folder(folder: &Path, target: &Path) -> String {
    let base = pypath::realpath(&folder.to_string_lossy()).await;
    let prefix = format!("{}{MAIN_SEPARATOR_STR}", base.trim_end_matches(MAIN_SEPARATOR_STR));
    let target = target.to_string_lossy();
    target.strip_prefix(&prefix).unwrap_or(&target).to_string()
}

fn safe_filename(name: &str) -> Result<String, Error> {
    let base = pypath::basename(&name.replace('\\', "/")).to_string();
    if base.is_empty() || base == "." || base == ".." || base.contains('\0') {
        return Err(Error::Workspace("Invalid file name".to_string()));
    }
    Ok(base)
}

/// Save an uploaded file into the ticket's workspace.
///
/// `directory` is the target folder relative to the workspace ("" for the top), `filename` the name to store the file
/// under, `data` its contents. Returns `{name, size}` of the stored entry; fails with `WorkspaceError` if the file is
/// too large or a folder has that name.
pub async fn save_upload(
    session: &Session,
    ticket_id: &str,
    directory: &str,
    filename: &str,
    data: Vec<u8>,
) -> Result<Value, Error> {
    save_upload_limited(session, ticket_id, directory, filename, data, MAX_UPLOAD_BYTES).await
}

/// `save_upload` with its size limit given (the Python test lowers `MAX_UPLOAD_BYTES`).
pub async fn save_upload_limited(
    session: &Session,
    ticket_id: &str,
    directory: &str,
    filename: &str,
    data: Vec<u8>,
    max_bytes: usize,
) -> Result<Value, Error> {
    if data.len() > max_bytes {
        return Err(Error::Workspace(format!("File is larger than {} MB", max_bytes / (1024 * 1024))));
    }
    let folder = enabled_folder(session, ticket_id).await?;
    let name = safe_filename(filename)?;
    let directory = directory.trim_matches('/');
    let rel = if directory.is_empty() { name } else { format!("{directory}/{name}") };
    let target = resolve_inside(&folder, &rel).await?;
    if target.is_dir() {
        return Err(Error::Workspace("A folder with that name already exists".to_string()));
    }
    let size = data.len();
    let path = target.clone();
    to_thread(move || {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, &data)
    })
    .await?;
    Ok(json!({"name": relative_to_folder(&folder, &target).await, "size": size}))
}

/// Delete a file or folder inside the ticket's workspace. `rel` is the path relative to the workspace; fails with
/// `LookupError` if the entry does not exist.
pub async fn delete_entry(session: &Session, ticket_id: &str, rel: &str) -> Result<(), Error> {
    let folder = enabled_folder(session, ticket_id).await?;
    let target = resolve_inside(&folder, rel).await?;
    if !target.exists() {
        return Err(Error::Lookup("Entry not found".to_string()));
    }
    if target.is_dir() {
        to_thread(move || std::fs::remove_dir_all(target)).await?;
    } else {
        to_thread(move || std::fs::remove_file(target)).await?;
    }
    Ok(())
}

/// Resolve a regular file inside the workspace. `rel` is the path relative to the workspace; returns `(absolute
/// path, media type)` (the media type is empty unless the file is an image); fails with `LookupError` if the file
/// does not exist.
pub async fn resolve_file(session: &Session, ticket_id: &str, rel: &str) -> Result<(PathBuf, &'static str), Error> {
    let folder = enabled_folder(session, ticket_id).await?;
    let target = resolve_inside(&folder, rel).await?;
    if !target.is_file() {
        return Err(Error::Lookup("File not found".to_string()));
    }
    let suffix = pathlib::suffix(&target.to_string_lossy()).to_lowercase();
    let media_type = IMAGE_TYPES.iter().find(|(ext, _)| *ext == suffix).map(|(_, media)| *media).unwrap_or("");
    Ok((target, media_type))
}

/// Read up to the preview limit of a file; flag binary or truncated content.
pub fn read_text_preview(path: &Path) -> std::io::Result<Value> {
    let size = std::fs::metadata(path)?.len();
    let mut raw = Vec::new();
    std::fs::File::open(path)?.take(MAX_PREVIEW_BYTES as u64).read_to_end(&mut raw)?;
    if raw.contains(&0) {
        return Ok(json!({"binary": true, "text": "", "truncated": false, "size": size}));
    }
    Ok(json!({
        "binary": false,
        "text": String::from_utf8_lossy(&raw),
        "truncated": size > MAX_PREVIEW_BYTES as u64,
        "size": size,
    }))
}

/// `shutil.which(name)`: an executable file of that name on `PATH`.
fn which(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| {
        let candidate = dir.join(name);
        let Ok(meta) = std::fs::metadata(&candidate) else {
            return false;
        };
        #[cfg(unix)]
        let executable = std::os::unix::fs::PermissionsExt::mode(&meta.permissions()) & 0o111 != 0;
        #[cfg(not(unix))]
        let executable = true;
        meta.is_file() && executable
    })
}

/// Open the ticket's workspace folder in the OS file manager; returns the folder path. Fails with `WorkspaceError` if
/// no file manager is available.
pub async fn open_in_file_manager(session: &Session, ticket_id: &str) -> Result<String, Error> {
    let folder = enabled_folder(session, ticket_id).await?;
    // The folder is passed as the working directory and "." as the only argument,
    // so no configurable path ever becomes part of the command line.
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    if !which(opener) {
        // checked before the folder is made: a failed Open folder must not leave an empty folder behind
        return Err(Error::Workspace("No file manager available on this machine; copy the path instead".to_string()));
    }
    mkdir_parents(&folder).await?;
    let mut command = tokio::process::Command::new(opener);
    command.arg(".").current_dir(&folder).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    // `start_new_session=True`: the file manager outlives the request and is not stopped with it
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn()?;
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
    Ok(folder.to_string_lossy().into_owned())
}

/// `read_text_preview` off the async threads.
pub async fn read_text_preview_async(path: PathBuf) -> Result<Value, Error> {
    Ok(to_thread(move || read_text_preview(&path)).await?)
}
