//! Step 1, **scan by code, no quota**: what the repository is, read from its files (`repo_scan.py` lines 37-296:
//! `TRIAL_TIMEOUT_S`, `_FP_NAMES`, `_CI_HINT`, `_ci_commands`, `fingerprint`, `_committed`, `_in_worktree`, `_hidden`,
//! `scan`): `package.json` scripts and frameworks, `pyproject.toml`/`uv.lock`, `go.mod`, `Cargo.toml`, `Makefile`, a
//! `Dockerfile`, the CI workflows (the commands CI really runs win over the README), `CLAUDE.md`/`AGENTS.md`, an
//! existing `.claude/`, a monorepo, test folders, a web UI, the git remote.
//!
//! The result is shown to people and fed to the AI: every key, label and its order is the Python one.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use kb_ai_work::proc::{self, Spec};
use kb_base::{pypath, pytext};
use regex::Regex;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::Error;
use crate::pyfs;

/// `TRIAL_TIMEOUT_S`: how long a command of the trial may run (seconds).
pub const TRIAL_TIMEOUT_S: u64 = 10 * 60;

/// `_FP_NAMES`: the manifests and lockfiles the fingerprint hashes.
pub const FP_NAMES: [&str; 16] = [
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "pyproject.toml",
    "uv.lock",
    "poetry.lock",
    "go.mod",
    "Cargo.toml",
    "Gemfile",
    "pom.xml",
    "build.gradle",
    "Makefile",
    "Dockerfile",
    "CLAUDE.md",
    "AGENTS.md",
];

/// Folders neither the fingerprint nor the file count look into.
const SKIPPED_DIRS: [&str; 6] = [".git", "node_modules", ".venv", "dist", "build", "__pycache__"];

static CI_HINT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(test|pytest|vitest|jest|lint|ruff|eslint|tsc|build|typecheck|mypy|go test|cargo test)\b")
        .expect("a fixed pattern")
});

/// `fnmatch("*.y*ml")` (case-sensitive, as `pathlib` matches on Linux and macOS' default).
static WORKFLOW_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)^.*\.y.*ml$").expect("a fixed pattern"));

static MAKE_TARGET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^([a-zA-Z][\w-]*):").expect("a fixed pattern"));

static URL_USER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"//[^@/]+@").expect("a fixed pattern"));

/// `sorted((root / ".github" / "workflows").glob("*.y*ml"))`: what is there (a folder named so too), by name.
fn workflow_files(root: &Path) -> Vec<PathBuf> {
    let dir = root.join(".github").join("workflows");
    if !dir.is_dir() {
        return Vec::new();
    }
    let mut names: Vec<String> = pyfs::entry_names(&dir).into_iter().filter(|n| WORKFLOW_NAME.is_match(n)).collect();
    names.sort();
    names.into_iter().map(|n| dir.join(n)).collect()
}

/// The `run:` lines of the CI workflows that look like a check (what CI really runs).
pub fn ci_commands(root: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for wf in workflow_files(root) {
        let text = pyfs::read_default(&wf);
        let all_lines = pytext::splitlines(&text);
        for (idx, line) in all_lines.iter().enumerate() {
            let mut step = pytext::strip(line);
            if step.starts_with('-') {
                step = pytext::strip(&step[1..]);
            }
            let Some(rest) = step.strip_prefix("run:") else { continue };
            let first = pytext::strip(rest);
            let lines: Vec<&str> = if first.starts_with('|') {
                // a block: take the next indented lines
                let tail = all_lines.iter().skip(idx + 1).take(7);
                tail.filter(|t| t.starts_with(' ') && !pytext::strip(t).is_empty()).map(|t| pytext::strip(t)).collect()
            } else {
                vec![first]
            };
            out.extend(lines.into_iter().filter(|ln| !ln.is_empty() && CI_HINT.is_match(ln)).map(str::to_string));
        }
    }
    // `list(dict.fromkeys(out))[:20]`
    let mut seen: HashSet<String> = HashSet::new();
    out.retain(|c| seen.insert(c.clone()));
    out.truncate(20);
    out
}

/// A hash of the files the scan reads (CI workflows, manifests, lockfiles): it changes when the repo's tooling does.
pub fn fingerprint(root: &Path) -> String {
    let mut hasher = Sha256::new();
    let mut files: Vec<PathBuf> = workflow_files(root);
    pyfs::os_walk(root, &mut |dirpath, dirs, names| {
        dirs.retain(|d| !SKIPPED_DIRS.contains(&d.as_str()));
        dirs.sort();
        let mut wanted: Vec<&String> = names.iter().filter(|n| FP_NAMES.contains(&n.as_str())).collect();
        wanted.sort();
        files.extend(wanted.into_iter().map(|n| dirpath.join(n)));
        files.len() <= 200
    });
    for file in files.iter().take(200) {
        let Ok(data) = std::fs::read(file) else { continue };
        let rel = file.strip_prefix(root).unwrap_or(file);
        hasher.update(rel.to_string_lossy().as_bytes());
        hasher.update(b"\0");
        hasher.update(Sha256::digest(&data));
    }
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// The files of the repository's HEAD commit (posix paths from the root), which is all a worktree made from HEAD
/// has, or None when the folder is not the root of a git repository with a commit (then nothing is filtered).
pub async fn committed(root: &Path) -> Option<HashSet<String>> {
    if !root.join(".git").exists() {
        return None;
    }
    let cwd = root.to_string_lossy().into_owned();
    let argv: Vec<String> = ["git", "ls-tree", "-r", "-z", "--name-only", "HEAD"].map(str::to_string).to_vec();
    let spec = Spec { cwd: Some(&cwd), ..Spec::default() };
    let res = proc::run(&argv, &spec, 30.0).await.ok()?;
    if res.returncode != 0 {
        return None;
    }
    Some(res.stdout.split('\0').filter(|p| !p.is_empty()).map(str::to_string).collect())
}

/// Whether a manifest is in a ticket's worktree: a git-ignored or untracked checkout inside the repository (a vendored
/// tool, a nested clone) is on this disk but not in a worktree, so a command that goes there fails. `rel` is the
/// manifest's path from the root.
pub fn in_worktree(rel: &str, committed: &Option<HashSet<String>>) -> bool {
    committed.as_ref().is_none_or(|set| set.contains(rel))
}

/// A manifest under a hidden folder (`.github/skills/…/scripts`, `.claude/worktrees/…`, `.venv`) is tooling, not the
/// application: its install step does not belong in the project's prepare command. `rel` is its path from the root.
pub fn hidden(rel: &str) -> bool {
    let parts: Vec<&str> = rel.split('/').collect();
    parts[..parts.len().saturating_sub(1)].iter().any(|p| p.starts_with('.'))
}

/// The manifests named `name` below the root, in `rglob`'s order, with their paths from the root.
fn manifests(root: &Path, name: &str, prune_node_modules: bool, committed: &Option<HashSet<String>>) -> Vec<String> {
    let prune = move |dir: &str| dir.starts_with('.') || (prune_node_modules && dir == "node_modules");
    pyfs::walk_dirs(root, &prune)
        .into_iter()
        .filter(|(dir, _)| pyfs::exists(&dir.join(name)))
        .map(|(_, rel)| pyfs::join_rel(&rel, name))
        .filter(|rel| !hidden(rel) && in_worktree(rel, committed))
        .collect()
}

/// The folder of a manifest as `pkg.parent.relative_to(root).as_posix()` gives it.
fn folder_of(rel_manifest: &str) -> String {
    match rel_manifest.rsplit_once('/') {
        Some((dir, _)) => dir.to_string(),
        None => ".".to_string(),
    }
}

fn push_unique(list: &mut Value, item: &str) {
    if let Value::Array(items) = list {
        if !items.iter().any(|v| v.as_str() == Some(item)) {
            items.push(json!(item));
        }
    }
}

fn contains(list: &Value, item: &str) -> bool {
    list.as_array().is_some_and(|items| items.iter().any(|v| v.as_str() == Some(item)))
}

/// Everything `scan` reads from files, up to `ui` (the keys in the order `found` has them).
fn read_repository(root: &Path, shown: &str, committed: &Option<HashSet<String>>) -> Result<Map<String, Value>, Error> {
    let mut found: Map<String, Value> = Map::new();
    found.insert("folder".into(), json!(shown));
    found.insert("languages".into(), json!([]));
    found.insert("frameworks".into(), json!([]));
    found.insert("packages".into(), json!([]));
    found.insert("scripts".into(), json!({}));
    let root_parts = pyfs::parts(shown);
    let in_node_modules = root_parts.iter().any(|p| p == "node_modules");

    let node: Vec<String> = if in_node_modules {
        Vec::new()
    } else {
        manifests(root, "package.json", true, committed).into_iter().take(12).collect()
    };
    for rel_manifest in node {
        let data = pyfs::json(&root.join(&rel_manifest));
        let dependencies = pyfs::get(&data, "dependencies")?.filter(|v| kb_base::pyjson::truthy(v));
        let mut deps = match dependencies {
            Some(v) => pyfs::mapping(v)?,
            None => Map::new(),
        };
        let dev = pyfs::get(&data, "devDependencies")?.filter(|v| kb_base::pyjson::truthy(v));
        if let Some(v) = dev {
            for (k, v) in pyfs::mapping(v)? {
                deps.insert(k, v);
            }
        }
        let scripts = pyfs::get(&data, "scripts")?.filter(|v| kb_base::pyjson::truthy(v)).cloned();
        let name = pyfs::get(&data, "name")?.cloned().unwrap_or(Value::Null);
        let package = json!({
            "path": folder_of(&rel_manifest),
            "kind": "node",
            "name": name,
            "scripts": scripts.unwrap_or_else(|| json!({})),
        });
        if let Some(Value::Array(packages)) = found.get_mut("packages") {
            packages.push(package);
        }
        for (fw, dep) in [
            ("react", "react"),
            ("vite", "vite"),
            ("next", "next"),
            ("vue", "vue"),
            ("svelte", "svelte"),
            ("electron", "electron"),
            ("vitest", "vitest"),
            ("jest", "jest"),
            ("playwright", "@playwright/test"),
            ("eslint", "eslint"),
            ("tailwind", "tailwindcss"),
        ] {
            if deps.contains_key(dep) {
                if let Some(list) = found.get_mut("frameworks") {
                    push_unique(list, fw);
                }
            }
        }
        if let Some(list) = found.get_mut("languages") {
            push_unique(list, "node");
        }
    }

    let python: Vec<String> = manifests(root, "pyproject.toml", false, committed).into_iter().take(8).collect();
    for rel_manifest in python {
        let text = pyfs::read_default(&root.join(&rel_manifest));
        let rel = folder_of(&rel_manifest);
        let parent = match rel_manifest.rsplit_once('/') {
            Some((dir, _)) => root.join(dir),
            None => root.to_path_buf(),
        };
        let manager = if parent.join("uv.lock").exists() {
            "uv"
        } else if text.contains("[tool.poetry]") {
            "poetry"
        } else {
            "pip"
        };
        let package = json!({
            "path": rel,
            "kind": "python",
            "manager": manager,
            "pytest": text.contains("pytest"),
            "ruff": text.contains("ruff"),
        });
        if let Some(Value::Array(packages)) = found.get_mut("packages") {
            packages.push(package);
        }
        let lower = text.to_lowercase();
        for fw in ["fastapi", "django", "flask", "pytest", "ruff", "sqlalchemy"] {
            if lower.contains(fw) {
                if let Some(list) = found.get_mut("frameworks") {
                    push_unique(list, fw);
                }
            }
        }
        if let Some(list) = found.get_mut("languages") {
            push_unique(list, "python");
        }
    }
    for (name, lang) in
        [("go.mod", "go"), ("Cargo.toml", "rust"), ("Gemfile", "ruby"), ("pom.xml", "java"), ("build.gradle", "java")]
    {
        if root.join(name).exists() {
            if let Some(list) = found.get_mut("languages") {
                push_unique(list, lang);
            }
        }
    }
    let targets: Vec<Value> = if root.join("Makefile").exists() {
        MAKE_TARGET.captures_iter(&pyfs::read_default(&root.join("Makefile"))).take(20).map(|c| json!(&c[1])).collect()
    } else {
        Vec::new()
    };
    found.insert("makefile_targets".into(), Value::Array(targets));
    let docker = root.join("Dockerfile").exists()
        || root.join("docker-compose.yml").exists()
        || root.join("compose.yaml").exists();
    found.insert("docker".into(), json!(docker));
    found.insert("ci_commands".into(), json!(ci_commands(root)));
    let agent_files: Vec<&str> =
        ["CLAUDE.md", "AGENTS.md", ".claude", ".mcp.json"].into_iter().filter(|n| root.join(n).exists()).collect();
    found.insert("agent_files".into(), json!(agent_files));
    found.insert("readme_lines".into(), json!(pytext::splitlines(&pyfs::read_default(&root.join("README.md"))).len()));
    let packages = found.get("packages").and_then(Value::as_array).map_or(0, Vec::len);
    found.insert("monorepo".into(), json!(packages > 1));
    found.insert("tests".into(), json!(test_folders(root, &root_parts)));
    let ui = ["react", "vue", "svelte", "next", "vite", "electron"]
        .iter()
        .any(|f| found.get("frameworks").is_some_and(|l| contains(l, f)));
    found.insert("ui".into(), json!(ui));
    Ok(found)
}

/// The folders named `test*` (not under `.git`, `node_modules` or `.venv`), from the root, sorted, the first ten.
fn test_folders(root: &Path, root_parts: &[String]) -> Vec<String> {
    if root_parts.iter().any(|p| matches!(p.as_str(), ".git" | "node_modules" | ".venv")) {
        return Vec::new();
    }
    let prune = |dir: &str| matches!(dir, ".git" | "node_modules" | ".venv");
    let mut found: Vec<String> = Vec::new();
    for (dir, rel) in pyfs::walk_dirs(root, &prune) {
        for name in pyfs::entry_names(&dir) {
            if name.starts_with("test") && dir.join(&name).is_dir() {
                found.push(pyfs::join_rel(&rel, &name));
            }
        }
    }
    found.sort();
    found.dedup();
    found.truncate(10);
    found
}

/// The number of files below the root, not counting the folders `SKIPPED_DIRS` names.
fn count_files(root: &Path) -> usize {
    let mut files = 0;
    pyfs::os_walk(root, &mut |_, dirs, names| {
        dirs.retain(|d| !SKIPPED_DIRS.contains(&d.as_str()));
        files += names.len();
        true
    });
    files
}

/// What the repository is, read by code (nothing runs, nothing is sent anywhere).
///
/// Raises `Error::Value("No such folder: ...")`. A `package.json` that holds something other than an object stops the
/// scan with the `AttributeError` Python gives (`Error::Other`).
pub async fn scan(folder: &str) -> Result<Value, Error> {
    let expanded = pypath::expanduser(folder);
    let root_text = if expanded.is_empty() { ".".to_string() } else { expanded };
    let root = PathBuf::from(&root_text);
    if !root.is_dir() {
        return Err(Error::Value(format!("No such folder: {folder}")));
    }
    let shown = pyfs::path_str(&root_text);
    let committed = committed(&root).await;
    let (r, s) = (root.clone(), shown.clone());
    let mut found = tokio::task::spawn_blocking(move || read_repository(&r, &s, &committed))
        .await
        .map_err(|e| Error::Other(e.to_string()))??;
    let cwd = root.to_string_lossy().into_owned();
    let argv: Vec<String> = ["git", "remote", "get-url", "origin"].map(str::to_string).to_vec();
    let remote = match proc::run(&argv, &Spec { cwd: Some(&cwd), ..Spec::default() }, 10.0).await {
        Ok(out) => pytext::strip(&out.stdout).to_string(),
        Err(_) => String::new(),
    };
    let r = root.clone();
    let (files, fp) = tokio::task::spawn_blocking(move || (count_files(&r), fingerprint(&r)))
        .await
        .map_err(|e| Error::Other(e.to_string()))?;
    found.insert("git".into(), json!(root.join(".git").exists()));
    let remote = URL_USER.replace_all(&remote, "//").into_owned();
    found.insert("remote".into(), if remote.is_empty() { Value::Null } else { json!(remote) });
    found.insert("files".into(), json!(files));
    found.insert("fingerprint".into(), json!(fp));
    Ok(Value::Object(found))
}
