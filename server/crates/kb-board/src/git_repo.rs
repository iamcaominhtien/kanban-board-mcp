//! The per-project git repository, through the `git` binary.
//!
//! The Python server used GitPython here (`services/git_repo.py`); this port runs the same `git` commands
//! GitPython ran (same working folder, `LANGUAGE=C` and `LC_ALL=C`, no stdin) and reads the same files GitPython
//! read itself (`HEAD`, `refs/heads`, `packed-refs`), so results and error messages are the same. Python ran these
//! functions in a thread; here they are async.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde_json::{Map, Value, json};
use tokio::process::Command;

use kb_base::{pypath, pytext};

/// What a function of this module fails with.
#[derive(Debug, Clone, PartialEq)]
pub enum GitError {
    /// `GitRepoError` (a `ValueError`): any user-facing git problem (bad path, bad name, missing ref). The text is
    /// the message.
    Repo(String),
    /// GitPython's `GitCommandError`: a git command of a function that does not catch it ended with an error.
    Command(GitCommandError),
    /// Any other exception the Python function let through (git is not installed, a folder cannot be made, output
    /// that cannot be parsed). No caller caught these: a 500.
    Other(String),
}

impl GitError {
    fn repo(message: impl Into<String>) -> Self {
        GitError::Repo(message.into())
    }

    /// The message of a `GitRepoError`, when this is one.
    pub fn repo_message(&self) -> Option<&str> {
        match self {
            GitError::Repo(message) => Some(message),
            _ => None,
        }
    }
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GitError::Repo(message) | GitError::Other(message) => f.write_str(message),
            GitError::Command(err) => err.fmt(f),
        }
    }
}

impl std::error::Error for GitError {}

/// GitPython's `GitCommandError`, with the attributes the Python code read.
#[derive(Debug, Clone, PartialEq)]
pub struct GitCommandError {
    /// The command line, `git` first.
    pub command: Vec<String>,
    /// The exit code (`None` when a signal ended the command).
    pub status: Option<i32>,
    /// As GitPython keeps it: `"\n  stderr: '<text>'"`, or empty when git wrote nothing. So `exc.stderr.strip()`
    /// is `err.stderr_stripped()`, which reads `stderr: 'fatal: ...'`.
    pub stderr: String,
    /// As GitPython keeps it: `"\n  stdout: '<text>'"`, or empty.
    pub stdout: String,
}

impl GitCommandError {
    /// `exc.stderr.strip()`.
    pub fn stderr_stripped(&self) -> &str {
        pytext::strip(&self.stderr)
    }
}

impl std::fmt::Display for GitCommandError {
    /// `str(exc)`.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let cause = match self.status {
            Some(status) if status != 0 => format!(" due to: exit code({status})"),
            _ => "!".to_string(),
        };
        write!(f, "Cmd('git') failed{cause}\n  cmdline: {}{}{}", self.command.join(" "), self.stdout, self.stderr)
    }
}

/// Branch name, head commit and ahead/behind counts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchInfo {
    pub name: String,
    pub commit_hash: String,
    pub ahead_count: i64,
    pub behind_count: i64,
}

/// An opened repository (GitPython's `Repo`): where its git folder is and where git commands run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repo {
    /// The folder git commands run in: the working tree, or the git folder of a bare repository.
    pub working_dir: PathBuf,
    /// The git folder (`<working tree>/.git`, the folder a `.git` file points at, or a bare repository).
    pub git_dir: PathBuf,
    /// Where refs and objects are: `git_dir`, or the main repository's git folder for a linked worktree.
    pub common_dir: PathBuf,
    /// `core.bare` of the repository's own config.
    pub bare: bool,
}

impl Repo {
    /// `repo.git.<command>(*args)`: run git in the working folder and return what it printed, without the final
    /// newline. An exit code other than 0 is a `GitCommandError`.
    pub async fn git(&self, args: &[&str]) -> Result<String, GitError> {
        let output = Command::new("git")
            .args(args)
            .current_dir(&self.working_dir)
            .env("LANGUAGE", "C")
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .output()
            .await
            .map_err(|err| GitError::Other(format!("Cmd('git') not found due to: {err}")))?;
        let stdout = strip_newline(String::from_utf8_lossy(&output.stdout).into_owned());
        if output.status.success() {
            return Ok(stdout);
        }
        let stderr = strip_newline(String::from_utf8_lossy(&output.stderr).into_owned());
        let mut command = vec!["git".to_string()];
        command.extend(args.iter().map(|a| a.to_string()));
        Err(GitError::Command(GitCommandError {
            command,
            status: output.status.code(),
            stderr: if stderr.is_empty() { String::new() } else { format!("\n  stderr: '{stderr}'") },
            stdout: if stdout.is_empty() { String::new() } else { format!("\n  stdout: '{stdout}'") },
        }))
    }

    /// `repo.heads`: the names of the local branches, sorted. GitPython reads them from `refs/heads` and
    /// `packed-refs` itself, so this never fails: a folder that cannot be read has no branches.
    pub async fn heads(&self) -> Vec<String> {
        let mut paths: HashSet<String> = HashSet::new();
        let root = self.common_dir.join("refs").join("heads");
        let mut todo = vec![(root, "refs/heads".to_string())];
        while let Some((dir, rela)) = todo.pop() {
            let Ok(mut entries) = tokio::fs::read_dir(&dir).await else { continue };
            while let Ok(Some(entry)) = entries.next_entry().await {
                let name = entry.file_name().to_string_lossy().into_owned();
                let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
                if is_dir {
                    todo.push((entry.path(), format!("{rela}/{name}")));
                    continue;
                }
                // os.walk lists a link to a folder among the folders and does not go into it
                let is_dir_link = tokio::fs::metadata(entry.path()).await.map(|m| m.is_dir()).unwrap_or(false);
                if !is_dir_link && name != "packed-refs" {
                    paths.insert(format!("{rela}/{name}"));
                }
            }
        }
        if let Ok(packed) = tokio::fs::read_to_string(self.common_dir.join("packed-refs")).await {
            for line in packed.split('\n') {
                let line = pytext::strip(line);
                if line.is_empty() || line.starts_with('#') || line.starts_with('^') {
                    continue;
                }
                if let Some((_sha, path)) = line.split_once(' ') {
                    if path.starts_with("refs/heads") {
                        paths.insert(path.to_string());
                    }
                }
            }
        }
        let mut paths: Vec<String> = paths.into_iter().filter(|p| p.starts_with("refs/heads/")).collect();
        paths.sort();
        paths.iter().map(|p| ref_name(p)).collect()
    }

    /// `repo.is_dirty(untracked_files=False)`: the index or the working tree differs from HEAD.
    async fn is_dirty(&self) -> Result<bool, GitError> {
        if self.bare {
            return Ok(false);
        }
        let default_args = ["--abbrev=40", "--full-index", "--raw"];
        let has_index = tokio::fs::metadata(self.git_dir.join("index")).await.map(|m| m.is_file()).unwrap_or(false);
        if has_index {
            let mut args = vec!["diff", "--cached"];
            args.extend(default_args);
            if !self.git(&args).await?.is_empty() {
                return Ok(true);
            }
        }
        let mut args = vec!["diff"];
        args.extend(default_args);
        Ok(!self.git(&args).await?.is_empty())
    }
}

/// GitPython drops one final newline of what a command printed.
fn strip_newline(mut text: String) -> String {
    if text.ends_with('\n') {
        text.pop();
    }
    text
}

/// `Reference.name`: the path without its first two parts (`refs/heads/feature/x` is `feature/x`).
fn ref_name(path: &str) -> String {
    let tokens: Vec<&str> = path.split('/').collect();
    if tokens.len() < 3 { path.to_string() } else { tokens[2..].join("/") }
}

/// Resolve `path` and verify it is the root of a git working tree.
pub async fn normalize_repo_path(path: &str) -> Result<String, GitError> {
    let resolved = pypath::realpath(&pypath::expanduser(pytext::strip(path))).await;
    open_repo(&resolved).await?;
    Ok(resolved)
}

async fn is_dir(path: &Path) -> bool {
    tokio::fs::metadata(path).await.map(|m| m.is_dir()).unwrap_or(false)
}

async fn is_file(path: &Path) -> bool {
    tokio::fs::metadata(path).await.map(|m| m.is_file()).unwrap_or(false)
}

/// What a text file holds, without the final line break.
async fn read_line(path: &Path) -> Option<String> {
    let bytes = tokio::fs::read(path).await.ok()?;
    Some(String::from_utf8_lossy(&bytes).trim_end_matches(['\r', '\n']).to_string())
}

/// GitPython's `is_git_dir`: a folder with a valid `HEAD`, objects and refs (its own, or those `commondir` names).
async fn is_git_dir(dir: &Path) -> bool {
    if !is_dir(dir).await {
        return false;
    }
    let headref = dir.join("HEAD");
    let is_link = tokio::fs::symlink_metadata(&headref).await.map(|m| m.file_type().is_symlink()).unwrap_or(false);
    let valid_head = if is_link {
        tokio::fs::read_link(&headref).await.map(|t| t.to_string_lossy().starts_with("refs/")).unwrap_or(false)
    } else {
        match tokio::fs::read(&headref).await {
            Ok(bytes) => {
                let head = &bytes[..bytes.len().min(256)];
                let is_ref =
                    head.strip_prefix(b"ref:").is_some_and(|rest| rest.trim_ascii_start().starts_with(b"refs/"));
                is_ref || (head.len() >= 40 && head[..40].iter().all(|b| b.is_ascii_hexdigit()))
            }
            Err(_) => false,
        }
    };
    let commondir_file = dir.join("commondir");
    let common_dir = match read_line(&commondir_file).await {
        Some(text) if text.is_empty() => return false,
        Some(text) => dir.join(text),
        None if tokio::fs::symlink_metadata(&commondir_file).await.is_ok() => return false,
        None => dir.to_path_buf(),
    };
    valid_head && is_dir(&common_dir.join("objects")).await && is_dir(&common_dir.join("refs")).await
}

/// GitPython's `find_worktree_git_dir`: where a `.git` file (`gitdir: <path>`) points.
async fn find_worktree_git_dir(dotgit: &Path) -> Option<String> {
    let meta = tokio::fs::metadata(dotgit).await.ok()?;
    if !meta.is_file() || meta.len() > (1 << 20) {
        return None;
    }
    let content = read_line(dotgit).await?;
    match content.strip_prefix("gitdir: ") {
        Some(target) if !target.is_empty() => Some(target.to_string()),
        _ => None,
    }
}

/// `core.bare` of a repository's config file (`[core]` / `bare = true`); false when it cannot be read.
async fn config_bare(config: &Path) -> bool {
    let Ok(text) = tokio::fs::read_to_string(config).await else { return false };
    let mut in_core = false;
    let mut bare = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_core = line.trim_end_matches(']').trim_start_matches('[').trim().eq_ignore_ascii_case("core");
        } else if in_core {
            if let Some((key, value)) = line.split_once('=') {
                if key.trim().eq_ignore_ascii_case("bare") {
                    let value = value.trim().trim_matches('"').to_ascii_lowercase();
                    bare = matches!(value.as_str(), "1" | "yes" | "true" | "on");
                }
            }
        }
    }
    bare
}

/// Open a git repository.
///
/// `path` is the root of a working tree (it has a `.git` folder, or the `.git` file of a linked worktree or a
/// submodule), a git folder or a bare repository; a folder inside a working tree is not one, as with GitPython's
/// `Repo(path)`. The `GIT_DIR`, `GIT_COMMON_DIR`, `GIT_WORK_TREE` and `GIT_OBJECT_DIRECTORY` variables and
/// `core.worktree`, which GitPython also looked at, are not.
///
/// Fails with `GitRepoError` if `path` is not a git repository.
pub async fn open_repo(path: &str) -> Result<Repo, GitError> {
    let not_a_repo = || GitError::repo(format!("Not a git repository: {path}"));
    let epath = pypath::expanduser(path);
    // an empty path is the current folder
    let epath = if epath.is_empty() { ".".to_string() } else { epath };
    if !pypath::exists(&epath).await {
        return Err(not_a_repo());
    }
    let curpath = PathBuf::from(&epath);
    let dotgit = curpath.join(".git");
    let mut found: Option<(PathBuf, PathBuf)> = None;
    if is_git_dir(&dotgit).await {
        found = Some((dotgit.clone(), curpath.clone()));
    } else if let Some(target) = find_worktree_git_dir(&dotgit).await {
        let target = if pypath::isabs(&target) { target } else { pypath::normpath(&pypath::join(&epath, &target)) };
        if is_git_dir(Path::new(&target)).await {
            found = Some((PathBuf::from(target), curpath.clone()));
        }
    }
    // a `.git` that is a file and points nowhere ends the search
    let dotgit_is_file = tokio::fs::metadata(&dotgit).await.map(|m| !m.is_dir()).unwrap_or(false);
    if found.is_none() && !dotgit_is_file && is_git_dir(&curpath).await {
        // `path` is a git folder itself; the git folder of a linked worktree names its working tree in `gitdir`
        let gitdir_file = curpath.join("gitdir");
        let working_tree = if is_file(&gitdir_file).await && is_file(&curpath.join("commondir")).await {
            let text = tokio::fs::read_to_string(&gitdir_file).await.unwrap_or_default();
            let text = pytext::strip(&text);
            let gitfile =
                if pypath::isabs(text) { text.to_string() } else { pypath::normpath(&pypath::join(&epath, text)) };
            PathBuf::from(pypath::dirname(&gitfile))
        } else {
            PathBuf::from(pypath::dirname(&epath))
        };
        found = Some((curpath.clone(), working_tree));
    }
    let Some((git_dir, working_tree)) = found else { return Err(not_a_repo()) };
    let linked = read_line(&git_dir.join("commondir")).await;
    let common_dir = match &linked {
        Some(relative) => git_dir.join(relative),
        None => git_dir.clone(),
    };
    // a linked worktree of a bare repository has a working tree of its own
    let bare = linked.is_none() && config_bare(&common_dir.join("config")).await;
    let working_dir = if bare { common_dir.clone() } else { working_tree };
    Ok(Repo { working_dir, git_dir, common_dir, bare })
}

/// Return a verified ref for `name`, falling back to `origin/<name>` (`_resolve_ref` in Python).
pub async fn resolve_ref(repo: &Repo, name: &str) -> Result<String, GitError> {
    for candidate in [name.to_string(), format!("origin/{name}")] {
        match repo.git(&["rev-parse", "--verify", "--quiet", &format!("{candidate}^{{commit}}")]).await {
            Ok(_) => return Ok(candidate),
            Err(GitError::Command(_)) => continue,
            Err(other) => return Err(other),
        }
    }
    Err(GitError::repo(format!("Branch '{name}' does not exist in the repository")))
}

/// Check a branch name with git's own rules.
///
/// Fails with `GitRepoError` if the name is not a valid branch name.
pub async fn validate_branch_name(repo: &Repo, name: &str) -> Result<(), GitError> {
    match repo.git(&["check-ref-format", "--branch", name]).await {
        Ok(_) => Ok(()),
        Err(GitError::Command(_)) => Err(GitError::repo(format!("Invalid branch name: {}", pytext::repr(name)))),
        Err(other) => Err(other),
    }
}

/// Return true if a local branch with this name exists.
pub async fn branch_exists(repo: &Repo, name: &str) -> bool {
    repo.heads().await.iter().any(|head| head == name)
}

/// Create a local branch at a base, without checking it out or touching the working tree.
///
/// `base` is the branch or revision to start from. Returns info about the new branch; fails with `GitRepoError`
/// if the branch already exists or git fails.
pub async fn create_branch(repo: &Repo, name: &str, base: &str) -> Result<BranchInfo, GitError> {
    validate_branch_name(repo, name).await?;
    if branch_exists(repo, name).await {
        return Err(GitError::repo(format!("Branch '{name}' already exists")));
    }
    let base_ref = resolve_ref(repo, base).await?;
    match repo.git(&["branch", name, &base_ref]).await {
        Ok(_) => {}
        Err(GitError::Command(exc)) => {
            return Err(GitError::repo(format!("Could not create branch '{name}': {}", exc.stderr_stripped())));
        }
        Err(other) => return Err(other),
    }
    branch_info(repo, name, base).await
}

/// Return a branch's tip commit and its ahead/behind counts relative to a base.
pub async fn branch_info(repo: &Repo, name: &str, base: &str) -> Result<BranchInfo, GitError> {
    let branch_ref = resolve_ref(repo, name).await?;
    let base_ref = resolve_ref(repo, base).await?;
    let commit = repo.git(&["rev-parse", &branch_ref]).await?;
    let counts = repo.git(&["rev-list", "--left-right", "--count", &format!("{base_ref}...{branch_ref}")]).await?;
    let counts = pytext::split(&counts);
    let parsed = match counts.as_slice() {
        [behind, ahead] => behind.parse::<i64>().ok().zip(ahead.parse::<i64>().ok()),
        _ => None,
    };
    let Some((behind, ahead)) = parsed else {
        return Err(GitError::Other(format!("git rev-list --left-right --count printed {counts:?}")));
    };
    Ok(BranchInfo { name: name.to_string(), commit_hash: commit, ahead_count: ahead, behind_count: behind })
}

/// Return local branch names, sorted.
pub async fn list_local_branches(repo: &Repo) -> Vec<String> {
    let mut names = repo.heads().await;
    names.sort();
    names
}

/// Fill in a worktree path template.
///
/// `template` is a path with `{project}`, `{ticket}`, `{ticket_id}`, `{branch}` and `{repo}` tokens; `repo_path`
/// is used for `{repo}` and for relative templates. Returns the resolved absolute path.
pub fn resolve_worktree_path(
    template: &str,
    repo_path: &str,
    project_prefix: &str,
    ticket_id: &str,
    branch_name: &str,
) -> String {
    let sanitized_branch = branch_name.replace('/', "-");
    let resolved = template
        .replace("{project}", project_prefix)
        .replace("{ticket_id}", ticket_id)
        .replace("{ticket}", ticket_id)
        .replace("{branch}", &sanitized_branch)
        .replace("{repo}", pypath::basename(repo_path));
    let mut expanded = pypath::expanduser(pytext::strip(&resolved));
    if !pypath::isabs(&expanded) {
        expanded = pypath::normpath(&pypath::join(repo_path, &expanded));
    }
    pypath::normpath(&expanded)
}

/// Create a git worktree for a branch.
///
/// `path` is where to create the worktree, `branch` an existing branch to check out in it. Returns the resolved
/// worktree path; fails with `GitRepoError` if the path exists or git fails.
pub async fn add_worktree(repo: &Repo, path: &str, branch: &str) -> Result<String, GitError> {
    let resolved = pypath::realpath(&pypath::expanduser(pytext::strip(path))).await;
    if pypath::exists(&resolved).await {
        return Err(GitError::repo(format!("Target worktree path already exists: {resolved}")));
    }
    let parent_dir = pypath::dirname(&resolved);
    if !parent_dir.is_empty() && !pypath::exists(parent_dir).await {
        tokio::fs::create_dir_all(parent_dir).await.map_err(|err| GitError::Other(format!("{parent_dir}: {err}")))?;
    }
    match repo.git(&["worktree", "add", &resolved, branch]).await {
        Ok(_) => Ok(resolved),
        Err(GitError::Command(exc)) => {
            Err(GitError::repo(format!("Could not create worktree at '{resolved}': {}", exc.stderr_stripped())))
        }
        Err(other) => Err(other),
    }
}

/// Remove the git worktree at `path`.
///
/// A worktree that is already gone from disk is not an error (we just prune
/// the stale registration); any other failure is raised so it is not hidden.
pub async fn remove_worktree(repo: &Repo, path: &str, force: bool) -> Result<(), GitError> {
    let resolved = pypath::realpath(&pypath::expanduser(pytext::strip(path))).await;
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&resolved);
    match repo.git(&args).await {
        Ok(_) => {}
        Err(GitError::Command(exc)) => {
            if pypath::exists(&resolved).await {
                return Err(GitError::repo(format!(
                    "Could not remove worktree '{resolved}': {}",
                    exc.stderr_stripped()
                )));
            }
        }
        Err(other) => return Err(other),
    }
    match repo.git(&["worktree", "prune"]).await {
        Ok(_) | Err(GitError::Command(_)) => Ok(()),
        Err(other) => Err(other),
    }
}

/// Delete a local branch.
///
/// `force` deletes it even if it is unmerged; otherwise git refuses. Fails with `GitRepoError` if git refuses or
/// fails.
pub async fn delete_branch(repo: &Repo, name: &str, force: bool) -> Result<(), GitError> {
    if !branch_exists(repo, name).await {
        return Ok(()); // already gone, nothing to delete
    }
    match repo.git(&["branch", if force { "-D" } else { "-d" }, name]).await {
        Ok(_) => Ok(()),
        Err(GitError::Command(exc)) => {
            Err(GitError::repo(format!("Could not delete git branch '{name}': {}", exc.stderr_stripped())))
        }
        Err(other) => Err(other),
    }
}

/// Return all active worktrees for `repo`: `{path, branch?, bare?}` each.
pub async fn list_worktrees(repo: &Repo) -> Result<Vec<Map<String, Value>>, GitError> {
    let output = match repo.git(&["worktree", "list", "--porcelain"]).await {
        Ok(output) => output,
        Err(GitError::Command(_)) => return Ok(Vec::new()),
        Err(other) => return Err(other),
    };
    let mut worktrees = Vec::new();
    let mut current: Map<String, Value> = Map::new();
    for line in pytext::splitlines(&output) {
        if let Some(path) = line.strip_prefix("worktree ") {
            if !current.is_empty() {
                worktrees.push(std::mem::take(&mut current));
            }
            current.insert("path".into(), json!(pytext::strip(path)));
        } else if let Some(branch) = line.strip_prefix("branch ") {
            let branch = pytext::strip(branch).replace("refs/heads/", "");
            current.insert("branch".into(), json!(branch));
        } else if line.starts_with("bare") {
            current.insert("bare".into(), json!(true));
        }
    }
    if !current.is_empty() {
        worktrees.push(current);
    }
    Ok(worktrees)
}

/// Return true if every commit of a branch is already reachable from a base.
///
/// `base` is the branch it should be merged into. Fails with `GitRepoError` if the comparison fails.
pub async fn is_merged(repo: &Repo, name: &str, base: &str) -> Result<bool, GitError> {
    let branch_ref = resolve_ref(repo, name).await?;
    let base_ref = resolve_ref(repo, base).await?;
    match repo.git(&["merge-base", "--is-ancestor", &branch_ref, &base_ref]).await {
        Ok(_) => Ok(true),
        Err(GitError::Command(exc)) => {
            if exc.status == Some(1) {
                return Ok(false);
            }
            Err(GitError::repo(format!("Could not compare '{name}' with '{base}': {}", exc.stderr_stripped())))
        }
        Err(other) => Err(other),
    }
}

/// Rename a local branch.
///
/// Fails with `GitRepoError` if the new name is invalid or taken, or git fails.
pub async fn rename_branch(repo: &Repo, old: &str, new: &str) -> Result<(), GitError> {
    validate_branch_name(repo, new).await?;
    if branch_exists(repo, new).await {
        return Err(GitError::repo(format!("Branch '{new}' already exists")));
    }
    match repo.git(&["branch", "-m", old, new]).await {
        Ok(_) => Ok(()),
        Err(GitError::Command(exc)) => {
            Err(GitError::repo(format!("Could not rename branch '{old}': {}", exc.stderr_stripped())))
        }
        Err(other) => Err(other),
    }
}

/// The branch new work starts from: main, else master, else the checked-out branch, else the first local one.
pub async fn default_base_branch(repo: &Repo) -> Option<String> {
    let heads = repo.heads().await;
    for name in ["main", "master"] {
        if heads.iter().any(|head| head == name) {
            return Some(name.to_string());
        }
    }
    match current_branch(repo).await {
        Some(current) if !current.is_empty() => Some(current),
        _ => heads.first().cloned(),
    }
}

/// `base` when the repository has it, else its default base: "main" asked of a repo whose default is master works.
///
/// `base` is the branch or ref asked for; empty means the default.
pub async fn resolve_base(repo: &Repo, base: Option<&str>) -> String {
    let base = base.filter(|b| !b.is_empty());
    if let Some(base) = base {
        if base != "main" || branch_exists(repo, base).await {
            return base.to_string();
        }
    }
    let default = default_base_branch(repo).await.filter(|b| !b.is_empty());
    default.or(base.map(str::to_string)).unwrap_or_else(|| "main".to_string())
}

/// Name of the checked-out branch in the main working tree (None if detached).
///
/// Read from the `HEAD` file, as GitPython's `repo.active_branch` does. A `HEAD` that cannot be read is also
/// `None` (GitPython raises a `ValueError` there, which no caller told apart).
pub async fn current_branch(repo: &Repo) -> Option<String> {
    let head = tokio::fs::read_to_string(repo.git_dir.join("HEAD")).await.ok()?;
    let tokens = pytext::split(&head);
    match tokens.as_slice() {
        ["ref:", path, ..] => Some(ref_name(path)),
        _ => None,
    }
}

/// Check out a local branch in the main working tree without losing local changes.
///
/// Fails with `GitRepoError` if the branch does not exist, the tree has uncommitted changes, or git fails.
pub async fn checkout_branch(repo: &Repo, name: &str) -> Result<(), GitError> {
    if !branch_exists(repo, name).await {
        return Err(GitError::repo(format!("Branch '{name}' does not exist in the repository")));
    }
    if current_branch(repo).await.as_deref() == Some(name) {
        return Ok(());
    }
    if repo.is_dirty().await? {
        return Err(GitError::repo(
            "The working tree has uncommitted changes; commit or stash them before switching branches",
        ));
    }
    match repo.git(&["checkout", name]).await {
        Ok(_) => Ok(()),
        Err(GitError::Command(exc)) => {
            Err(GitError::repo(format!("Could not check out '{name}': {}", exc.stderr_stripped())))
        }
        Err(other) => Err(other),
    }
}

/// Parse a `%D` decoration string into `[{name, type}]` (`_parse_refs` in Python).
fn parse_refs(decoration: &str) -> Vec<Value> {
    let mut refs = Vec::new();
    for raw in decoration.split(',').map(pytext::strip).filter(|part| !part.is_empty()) {
        if let Some(branch) = raw.strip_prefix("HEAD -> ") {
            refs.push(json!({"name": "HEAD", "type": "head"}));
            refs.push(json!({"name": branch, "type": "branch"}));
        } else if raw == "HEAD" {
            refs.push(json!({"name": "HEAD", "type": "head"}));
        } else if let Some(tag) = raw.strip_prefix("tag: ") {
            refs.push(json!({"name": tag, "type": "tag"}));
        } else if raw.split_once('/').is_some_and(|(first, _)| first == "origin") {
            refs.push(json!({"name": raw, "type": "remote"}));
        } else {
            refs.push(json!({"name": raw, "type": "branch"}));
        }
    }
    refs
}

pub const HARD_LIMIT: usize = 300;

/// `text[:7]`.
fn short(hash: &str) -> String {
    hash.chars().take(7).collect()
}

/// The words of a git output as owned strings (`out.split()`).
fn words(text: &str) -> Vec<String> {
    pytext::split(text).into_iter().map(str::to_string).collect()
}

/// Commit graph over `bases` (mainline) and the ticket's `branches`.
///
/// Returns commits newest-first (topological order) with a `lane` per commit:
/// lane 0 is the first base's first-parent chain, side branches/merged work get
/// lanes >= 1 using the classic `git log --graph` column algorithm.
/// `ticket_branches` lists which of the ticket's branches a commit is exclusive to.
///
/// The result is the dict the Python function returned: `{base, current, commits, lane_count, truncated}` (without
/// `current` when there is nothing to show). `bases` must not be empty when `branches` is not.
pub async fn commit_graph(
    repo: &Repo,
    bases: &[String],
    branches: &[String],
    limit: usize,
) -> Result<Map<String, Value>, GitError> {
    let mut base_refs = Vec::new();
    for base in bases {
        base_refs.push(resolve_ref(repo, base).await?);
    }
    let mut refs: Vec<String> = Vec::new();
    for base_ref in &base_refs {
        if !refs.contains(base_ref) {
            refs.push(base_ref.clone());
        }
    }
    for branch in branches {
        let branch_ref = resolve_ref(repo, branch).await?;
        if !refs.contains(&branch_ref) {
            refs.push(branch_ref);
        }
    }
    let mut out = Map::new();
    if refs.is_empty() {
        out.insert("base".into(), Value::Null);
        out.insert("commits".into(), json!([]));
        out.insert("lane_count".into(), json!(1));
        out.insert("truncated".into(), json!(false));
        return Ok(out);
    }
    let (Some(first_base), Some(first_base_ref)) = (bases.first(), base_refs.first()) else {
        // `base_refs[0]` in Python
        return Err(GitError::Other("list index out of range".to_string()));
    };

    let fmt = "%H%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%D%x1e";
    // Always reach back to where the ticket's branches forked off, even if that is
    // further than `limit` commits ago (bounded by HARD_LIMIT).
    let count = format!("-n{}", HARD_LIMIT + 1);
    let format = format!("--format={fmt}");
    let mut args = vec!["log", "--topo-order", count.as_str(), format.as_str(), "--decorate=short"];
    args.extend(refs.iter().map(String::as_str));
    args.push("--");
    let raw = repo.git(&args).await?;
    let all_records: Vec<&str> =
        raw.split('\x1e').filter(|r| !pytext::strip(r).is_empty()).map(|r| r.trim_matches('\n')).collect();
    let positions: HashMap<&str, usize> =
        all_records.iter().enumerate().map(|(i, rec)| (rec.split('\x1f').next().unwrap_or(""), i)).collect();
    let mut window = limit;
    for name in branches {
        let fork = match resolve_ref(repo, name).await {
            Ok(branch_ref) => repo.git(&["merge-base", &branch_ref, first_base_ref]).await,
            Err(err) => Err(err),
        };
        match fork {
            Ok(fork) => {
                if let Some(position) = positions.get(pytext::strip(&fork)) {
                    window = window.max(position + 1);
                }
            }
            Err(GitError::Repo(_) | GitError::Command(_)) => continue,
            Err(other) => return Err(other),
        }
    }
    let window = window.min(HARD_LIMIT);
    let truncated = all_records.len() > window;
    let records = &all_records[..window.min(all_records.len())];

    let mut commits: Vec<Map<String, Value>> = Vec::new();
    let mut parents_of: Vec<Vec<String>> = Vec::new();
    for rec in records {
        let fields: Vec<&str> = rec.split('\x1f').collect();
        let [h, parents, author, date, subject, decoration] = fields.as_slice() else {
            return Err(GitError::Other(format!("git log printed a record of {} fields", fields.len())));
        };
        let parents = words(parents);
        let mut commit = Map::new();
        commit.insert("hash".into(), json!(h));
        commit.insert("short".into(), json!(short(h)));
        commit.insert("parents".into(), json!(parents));
        commit.insert("author".into(), json!(author));
        commit.insert("date".into(), json!(date));
        commit.insert("subject".into(), json!(subject));
        commit.insert("refs".into(), Value::Array(parse_refs(decoration)));
        commits.push(commit);
        parents_of.push(parents);
    }

    let count = format!("-n{}", window + 1);
    let mainline: HashSet<String> =
        words(&repo.git(&["rev-list", "--first-parent", &count, first_base_ref, "--"]).await?).into_iter().collect();

    // Which commits belong to which ticket branch (commits not yet in the base)
    let mut exclusive: Vec<(&str, HashSet<String>)> = Vec::new();
    let not_base = format!("^{first_base_ref}");
    for name in branches {
        let listed = match resolve_ref(repo, name).await {
            Ok(branch_ref) => repo.git(&["rev-list", &count, &branch_ref, &not_base, "--"]).await,
            Err(err) => Err(err),
        };
        let members: HashSet<String> = match listed {
            Ok(listed) => words(&listed).into_iter().collect(),
            Err(GitError::Repo(_) | GitError::Command(_)) => continue,
            Err(other) => return Err(other),
        };
        match exclusive.iter_mut().find(|(n, _)| *n == name.as_str()) {
            Some(entry) => entry.1 = members,
            None => exclusive.push((name.as_str(), members)),
        }
    }

    // Lane assignment (git log --graph columns; column 0 pinned to the mainline)
    let free = |cols: &[Option<String>]| cols.iter().enumerate().position(|(i, e)| i > 0 && e.is_none());
    let mut cols: Vec<Option<String>> = vec![None];
    let mut lane_count = 1;
    for (commit, parents) in commits.iter_mut().zip(&parents_of) {
        let h = commit.get("hash").and_then(Value::as_str).unwrap_or("").to_string();
        let lane = if mainline.contains(&h) {
            0
        } else {
            let heading_here = cols.iter().enumerate().position(|(i, e)| i > 0 && e.as_deref() == Some(h.as_str()));
            match heading_here.or_else(|| free(&cols)) {
                Some(lane) => lane,
                None => {
                    cols.push(None);
                    cols.len() - 1
                }
            }
        };
        for col in cols.iter_mut() {
            if col.as_deref() == Some(h.as_str()) {
                *col = None;
            }
        }
        // Keep a column reserved until the parent row so a lane is never reused
        // while an older edge is still running through it.
        for (idx, p) in parents.iter().enumerate() {
            if idx == 0 && lane > 0 {
                cols[lane] = Some(p.clone());
            } else if idx > 0 && cols.iter().any(|e| e.as_deref() == Some(p.as_str())) {
                continue; // another line already heads to this parent
            } else if mainline.contains(p) && lane == 0 {
                continue; // mainline-to-mainline needs no column
            } else {
                match free(&cols) {
                    Some(free) => cols[free] = Some(p.clone()),
                    None => cols.push(Some(p.clone())),
                }
            }
        }
        let ticket_branches: Vec<&str> =
            exclusive.iter().filter(|(_, members)| members.contains(&h)).map(|(n, _)| *n).collect();
        commit.insert("lane".into(), json!(lane));
        commit.insert("ticket_branches".into(), json!(ticket_branches));
        lane_count = lane_count.max(lane + 1);
    }

    out.insert("base".into(), json!(first_base));
    out.insert("current".into(), json!(current_branch(repo).await));
    out.insert("commits".into(), json!(commits));
    out.insert("lane_count".into(), json!(lane_count));
    out.insert("truncated".into(), json!(truncated));
    Ok(out)
}

pub const MAX_DETAIL_FILES: usize = 200;

/// `_REV_RE.match(rev)`: 4 to 40 hex digits (Python's `$` also matches before one final newline).
fn is_rev(rev: &str) -> bool {
    let rev = rev.strip_suffix('\n').unwrap_or(rev);
    (4..=40).contains(&rev.len()) && rev.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A changed file of a commit, while it is being read.
struct ChangedFile {
    status: String,
    old_path: Option<String>,
    path: String,
    additions: i64,
    deletions: i64,
    binary: bool,
}

/// Full message, author and changed files of one commit (`max_files` is `MAX_DETAIL_FILES` unless a caller says
/// otherwise).
///
/// For merge commits the file list is the diff against the first parent
/// (what the merge brought into the target branch).
pub async fn commit_detail(repo: &Repo, rev: &str, max_files: usize) -> Result<Map<String, Value>, GitError> {
    if !is_rev(rev) {
        return Err(GitError::repo("Invalid commit id"));
    }
    let full = match repo.git(&["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")]).await {
        Ok(full) => pytext::strip(&full).to_string(),
        Err(GitError::Command(_)) => {
            return Err(GitError::repo(format!("Commit '{rev}' not found in the repository")));
        }
        Err(other) => return Err(other),
    };

    let fmt = "%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%cI%x1f%B";
    let head = repo.git(&["show", "-s", &format!("--format={fmt}"), &full, "--"]).await?;
    let fields: Vec<&str> = head.splitn(8, '\x1f').collect();
    let [h, parents, an, ae, adate, cn, cdate, message] = fields.as_slice() else {
        return Err(GitError::Other(format!("git show printed {} fields", fields.len())));
    };
    let message = message.trim_matches('\n');
    let (subject, body) = message.split_once('\n').unwrap_or((message, ""));

    let name_status =
        repo.git(&["show", "--first-parent", "-M", "--name-status", "-z", "--format=", &full, "--"]).await?;
    let numstat = repo.git(&["show", "--first-parent", "-M", "--numstat", "-z", "--format=", &full, "--"]).await?;

    let unfinished = |what: &str| GitError::Other(format!("git show {what} printed an unfinished entry"));
    let mut files: Vec<ChangedFile> = Vec::new();
    let tokens: Vec<&str> = name_status.split('\0').collect();
    let mut i = 0;
    while i < tokens.len() && !tokens[i].is_empty() {
        let kind: String = tokens[i].chars().take(1).collect();
        let token = |at: usize| tokens.get(at).map(|t| t.to_string()).ok_or_else(|| unfinished("--name-status"));
        let (old_path, path) = if kind == "R" || kind == "C" {
            i += 3;
            (Some(token(i - 2)?), token(i - 1)?)
        } else {
            i += 2;
            (None, token(i - 1)?)
        };
        files.push(ChangedFile { status: kind, old_path, path, additions: 0, deletions: 0, binary: false });
    }

    let stats: Vec<&str> = numstat.split('\0').collect();
    let mut j = 0;
    for f in files.iter_mut() {
        if j >= stats.len() || stats[j].is_empty() {
            break;
        }
        let parts: Vec<&str> = stats[j].split('\t').collect();
        let (Some(add), Some(dele)) = (parts.first(), parts.get(1)) else {
            return Err(unfinished("--numstat"));
        };
        // renames/copies carry empty path here and two extra tokens (old, new)
        j += if f.status == "R" || f.status == "C" { 3 } else { 1 };
        f.binary = *add == "-";
        if !f.binary {
            f.additions = add.parse().map_err(|_| unfinished("--numstat"))?;
            f.deletions = dele.parse().map_err(|_| unfinished("--numstat"))?;
        }
    }

    let total_add: i64 = files.iter().map(|f| f.additions).sum();
    let total_del: i64 = files.iter().map(|f| f.deletions).sum();
    let truncated = files.len() > max_files;
    let listed: Vec<Value> = files
        .iter()
        .take(max_files)
        .map(|f| {
            json!({
                "status": f.status,
                "old_path": f.old_path,
                "path": f.path,
                "additions": f.additions,
                "deletions": f.deletions,
                "binary": f.binary,
            })
        })
        .collect();
    let mut out = Map::new();
    out.insert("hash".into(), json!(h));
    out.insert("short".into(), json!(short(h)));
    out.insert("parents".into(), json!(words(parents)));
    out.insert("author".into(), json!(an));
    out.insert("author_email".into(), json!(ae));
    out.insert("date".into(), json!(adate));
    out.insert("committer".into(), json!(cn));
    out.insert("committer_date".into(), json!(cdate));
    out.insert("subject".into(), json!(subject));
    out.insert("body".into(), json!(body.trim_matches('\n')));
    out.insert("files".into(), Value::Array(listed));
    out.insert("file_count".into(), json!(files.len()));
    out.insert("additions".into(), json!(total_add));
    out.insert("deletions".into(), json!(total_del));
    out.insert("files_truncated".into(), json!(truncated));
    Ok(out)
}

#[cfg(test)]
mod tests;
