//! Folders and programs a person names for an AI member (its working folder, the CLI to run), checked before the
//! board touches them. The path is made absolute and real (symlinks resolved) and must sit inside a place people keep
//! their work: the home folder, another drive or volume, or a folder listed in KANBAN_AI_ROOTS. System folders such as
//! /etc or C:\Windows are refused. Programs may also live in the usual install folders (/usr, /opt, Program Files).

use kb_base::{pypath, pytext};

pub const ROOTS_ENV: &str = "KANBAN_AI_ROOTS";

/// A path outside the places the board may use; the message says why.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct PathRefused(pub String);

#[cfg(windows)]
const SEP: &str = "\\";
#[cfg(not(windows))]
const SEP: &str = "/";

async fn prefix(path: &str) -> String {
    let real = pypath::realpath(path).await;
    format!("{}{SEP}", real.trim_end_matches(['\\', '/']))
}

/// `os.pathsep`.
const PATHSEP: char = if cfg!(windows) { ';' } else { ':' };

/// The places people keep their work, for a home folder and the text of KANBAN_AI_ROOTS given (the environment's
/// values are read by `work_roots`).
pub fn work_roots_with(home: &str, env_roots: &str) -> Vec<String> {
    let mut roots = vec![home.to_string()];
    roots.extend(env_roots.split(PATHSEP).filter(|p| !pytext::strip(p).is_empty()).map(str::to_string));
    if cfg!(windows) {
        let system = std::env::var("SystemDrive").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "C:".to_string());
        let system = system.to_uppercase();
        for d in 'A'..='Z' {
            if format!("{d}:") != system && std::path::Path::new(&format!("{d}:\\")).is_dir() {
                roots.push(format!("{d}:\\"));
            }
        }
    } else {
        roots.extend(["/Volumes", "/mnt", "/media", "/srv"].map(str::to_string));
    }
    roots
}

fn work_roots() -> Vec<String> {
    work_roots_with(&pypath::expanduser("~"), &std::env::var(ROOTS_ENV).unwrap_or_default())
}

/// `_program_roots` for the given work roots.
pub fn program_roots_with(mut roots: Vec<String>) -> Vec<String> {
    if cfg!(windows) {
        for key in ["ProgramFiles", "ProgramFiles(x86)", "ProgramData"] {
            if let Ok(v) = std::env::var(key) {
                if !v.is_empty() {
                    roots.push(v);
                }
            }
        }
    } else {
        roots.extend(["/usr", "/opt", "/snap", "/nix", "/Applications", "/bin"].map(str::to_string));
    }
    roots
}

fn program_roots() -> Vec<String> {
    program_roots_with(work_roots())
}

/// What to tell a person whose working folder is refused.
pub fn folder_refused(raw: &str) -> String {
    format!(
        "Choose a project folder inside your home folder (or add its parent to {ROOTS_ENV}): {}",
        pytext::strip(raw)
    )
}

async fn inside(path: &str, roots: &[String]) -> bool {
    for root in roots {
        if path.starts_with(&prefix(root).await) {
            return true;
        }
    }
    false
}

/// `folder` against explicit roots.
pub async fn folder_in(raw: &str, roots: &[String]) -> Result<String, PathRefused> {
    let path = pypath::realpath(&pypath::expanduser(pytext::strip(raw))).await;
    if !inside(&path, roots).await {
        return Err(PathRefused(folder_refused(raw)));
    }
    Ok(path)
}

/// `program` against explicit roots (work roots plus install folders).
pub async fn program_in(raw: &str, roots: &[String]) -> Result<String, PathRefused> {
    let path = pypath::realpath(&pypath::expanduser(pytext::strip(raw))).await;
    if !inside(&path, roots).await {
        return Err(PathRefused(format!(
            "The CLI must be installed in your home folder or a usual install folder: {}",
            pytext::strip(raw)
        )));
    }
    Ok(path)
}

/// The real absolute path of a working folder; refuses the home folder itself and anything outside the roots.
pub async fn folder(raw: &str) -> Result<String, PathRefused> {
    folder_in(raw, &work_roots()).await
}

/// The real absolute path of a program to run (a CLI); refuses anything outside the roots and install folders.
pub async fn program(raw: &str) -> Result<String, PathRefused> {
    program_in(raw, &program_roots()).await
}
