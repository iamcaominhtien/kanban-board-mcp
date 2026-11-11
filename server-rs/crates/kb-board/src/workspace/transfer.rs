//! Moving or copying a ticket's workspace folder to another ticket of the same project (a split ticket, an idea that
//! became a ticket).

use std::io;
use std::path::Path;

use kb_base::{activity, pytext};
use kb_db::Session;
use kb_db::entities::ticket;
use kb_db::sea_orm::ActiveValue::Set;
use kb_db::sea_orm::{ActiveModelTrait, EntityTrait, IntoActiveModel};
use serde_json::{Value, json};

use super::{Error, enabled_folder, folder_for, get_workspace_settings, to_thread};

/// Move (or copy) a ticket's Workspace to another ticket of the same project: a split ticket, work that turned out to
/// belong elsewhere. Files already in the target are kept; one of the same name is replaced.
///
/// Returns `{result: moved|copied, path, to}` (the target's folder). Fails with `LookupError` when either ticket is
/// missing, and with `WorkspaceError` when Workspace is off, the tickets are the same or in different projects, or
/// there is nothing to move.
pub async fn move_to_ticket(
    session: &Session,
    ticket_id: &str,
    to_ticket_id: &str,
    mode: &str,
) -> Result<Value, Error> {
    let source = ticket::Entity::find_by_id(ticket_id).one(session).await?;
    let target = ticket::Entity::find_by_id(pytext::strip(to_ticket_id).to_uppercase()).one(session).await?;
    let (Some(source), Some(target)) = (source, target) else {
        return Err(Error::Lookup("Ticket not found".to_string()));
    };
    if target.id == source.id {
        return Err(Error::Workspace("Pick another ticket".to_string()));
    }
    if target.project_id != source.project_id {
        return Err(Error::Workspace("Workspaces move only between tickets of the same project".to_string()));
    }
    let folder = enabled_folder(session, &source.id).await?;
    if !folder.is_dir() {
        return Err(Error::Workspace("This ticket has no workspace folder to move".to_string()));
    }
    let done = transfer_workspace(session, &source.id, &target.id, mode).await?;
    let settings = get_workspace_settings(session).await?;
    let dest = folder_for(&settings.root_path, &target.id).await?;

    let mut source_log = source.activity_log.clone();
    activity::record(&mut source_log, "workspace", Value::Null, json!(format!("{done} to {}", target.id)), None, None);
    let mut target_log = target.activity_log.clone();
    activity::record(
        &mut target_log,
        "workspace",
        Value::Null,
        json!(format!("{done} from {}", source.id)),
        None,
        None,
    );
    let target_id = target.id.clone();
    let mut source = source.into_active_model();
    source.activity_log = Set(source_log);
    source.update(session).await?;
    let mut target = target.into_active_model();
    target.activity_log = Set(target_log);
    target.update(session).await?;
    session.commit().await?;
    Ok(json!({"result": done, "path": dest.to_string_lossy(), "to": target_id}))
}

/// Move or copy one workspace folder to another owner (an idea's folder follows it to its ticket).
///
/// `from_id` is the owner whose folder is moved or copied (e.g. "IDEA-14"), `to_id` the new owner (e.g. "KAN-251"),
/// `mode` is "move" (the folder is renamed, files are not copied twice), "copy" (the source keeps its own) or "leave"
/// (nothing happens). Returns what happened: "moved", "copied", "left" or "none" (the source folder does not exist).
pub async fn transfer_workspace(session: &Session, from_id: &str, to_id: &str, mode: &str) -> Result<String, Error> {
    if mode == "leave" {
        return Ok("left".to_string());
    }
    if mode != "move" && mode != "copy" {
        return Err(Error::Workspace("mode must be move, copy or leave".to_string()));
    }
    let settings = get_workspace_settings(session).await?;
    if !settings.enabled {
        return Ok("none".to_string());
    }
    let src = folder_for(&settings.root_path, from_id).await?;
    let dst = folder_for(&settings.root_path, to_id).await?;
    if !src.is_dir() {
        return Ok("none".to_string());
    }
    let moving = mode == "move";
    let done = to_thread(move || {
        if dst.exists() && std::fs::read_dir(&dst)?.next().is_some() {
            copytree(&src, &dst)?;
            if moving {
                std::fs::remove_dir_all(&src)?;
                return Ok("moved");
            }
            return Ok("copied");
        }
        if dst.exists() {
            std::fs::remove_dir(&dst)?;
        }
        if moving {
            // `shutil.move`: a rename, or a copy and a delete when the folders are on different disks
            if std::fs::rename(&src, &dst).is_err() {
                copytree(&src, &dst)?;
                std::fs::remove_dir_all(&src)?;
            }
            return Ok("moved");
        }
        copytree(&src, &dst)?;
        Ok("copied")
    })
    .await?;
    Ok(done.to_string())
}

/// `shutil.copytree(src, dst, symlinks=True, dirs_exist_ok=True)`: links stay links, files keep their times, a file
/// that is already there is replaced.
fn copytree(src: &Path, dst: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            let link = std::fs::read_link(&from)?;
            if std::fs::symlink_metadata(&to).is_ok() {
                std::fs::remove_file(&to)?;
            }
            #[cfg(unix)]
            std::os::unix::fs::symlink(link, &to)?;
            #[cfg(not(unix))]
            let _ = link;
        } else if kind.is_dir() {
            copytree(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
            copystat_times(&from, &to);
        }
    }
    copystat_times(src, dst);
    Ok(())
}

/// The modification time of `from` on `to` (`shutil.copystat`); the retention clock reads it.
fn copystat_times(from: &Path, to: &Path) {
    if let Ok(modified) = std::fs::metadata(from).and_then(|m| m.modified()) {
        if let Ok(file) = std::fs::File::open(to) {
            let _ = file.set_modified(modified);
        }
    }
}
