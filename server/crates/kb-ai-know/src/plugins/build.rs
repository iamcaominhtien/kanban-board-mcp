//! Making an installable plugin folder out of a checkout (`plugins.py`: `_manifest`, `source_name`, `_skill_name`,
//! `_skill_dirs`, `_check_link`, `_check_tree`, `_copy`, `build`). Blocking file work: callers run it on a blocking
//! thread (`asyncio.to_thread`).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use kb_base::{pyjson, pytext};
use kb_files::pathlib;
use regex::Regex;
use serde_json::{Map, Value, json};

use super::{Error, MAX_PLUGIN_BYTES, plugin_err};

/// Names a copy leaves out.
pub const IGNORED: [&str; 3] = [".git", "node_modules", "__pycache__"];

/// What `build` found: the plugin's facts, or the marketplace's entries when none was picked.
#[derive(Debug, Clone, PartialEq)]
pub enum Built {
    /// A built plugin.
    Plugin(PluginInfo),
    /// A marketplace with several plugins and none picked: `[{name, description}]`.
    Choices(Vec<Value>),
}

/// `{name, version, description, skills, hooks, mcp, size_bytes}`.
#[derive(Debug, Clone, PartialEq)]
pub struct PluginInfo {
    /// The plugin's name.
    pub name: String,
    /// Its version.
    pub version: Option<String>,
    /// What it says it is.
    pub description: Option<String>,
    /// The skills it carries, sorted.
    pub skills: Vec<String>,
    /// The hooks it declares.
    pub hooks: i32,
    /// The MCP servers it declares.
    pub mcp: i32,
    /// The bytes it takes.
    pub size_bytes: i64,
}

fn regex(pattern: &str) -> Option<Regex> {
    Regex::new(pattern).ok()
}

/// The text of a JSON value the way `or`-chains of the Python code keep it: None for a missing, null or falsy value.
fn text_opt(value: Option<&Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(v) => Some(pyjson::py_str(v)),
    }
}

fn truthy_text(value: Option<&Value>) -> Option<String> {
    value.filter(|v| pyjson::truthy(v)).and_then(|v| text_opt(Some(v)))
}

/// `(folder / ".claude-plugin" / name)` read as a JSON object, or empty.
pub fn manifest(folder: &Path, name: &str) -> Map<String, Value> {
    let text =
        fs::read(folder.join(".claude-plugin").join(name)).ok().map(|b| String::from_utf8_lossy(&b).into_owned());
    match text.and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// A plugin's name from where it came from, for a repository with no manifest: the repository's name, with its owner
/// when the name alone says nothing ("emilkowalski-skills").
pub fn source_name(source: &str) -> String {
    let parts: Vec<&str> = source.trim_end_matches('/').split(['/', ':']).filter(|p| !p.is_empty()).collect();
    let mut repo = match parts.last() {
        Some(last) => last.strip_suffix(".git").unwrap_or(last).to_string(),
        None => "plugin".to_string(),
    };
    let generic = ["skills", "plugin", "plugins", "claude-skills", "agent-skills"];
    if generic.contains(&repo.to_lowercase().as_str()) && parts.len() > 1 {
        repo = format!("{}-{}", parts[parts.len() - 2], repo);
    }
    repo
}

fn file_name(folder: &Path) -> String {
    folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// The `name` in a skill's SKILL.md front matter (safe as a folder name), else the folder's own name.
pub fn skill_name(folder: &Path) -> String {
    static NAME: LazyLock<Option<Regex>> = LazyLock::new(|| regex(r#"(?m)^name:\s*["']?([^"'\n]+)"#));
    static SLUG: LazyLock<Option<Regex>> = LazyLock::new(|| regex(r"[^a-z0-9-]+"));
    let Ok(bytes) = fs::read(folder.join("SKILL.md")) else { return file_name(folder) };
    let text = String::from_utf8_lossy(&bytes);
    let head: String = text.chars().take(2000).collect();
    let name = if head.starts_with("---") {
        NAME.as_ref()
            .and_then(|re| re.captures(&head))
            .and_then(|c| c.get(1))
            .and_then(|m| {
                let lowered = pytext::strip(m.as_str()).to_lowercase();
                SLUG.as_ref().map(|re| re.replace_all(&lowered, "-").trim_matches('-').to_string())
            })
            .unwrap_or_default()
    } else {
        String::new()
    };
    if name.is_empty() { file_name(folder) } else { name }
}

/// Every entry below `folder`, in no particular order, a link to a folder listed and not entered (`Path.rglob("*")` of
/// Python 3.12).
pub fn rglob_all(folder: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(folder) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let real_dir = fs::symlink_metadata(&path).map(|m| m.is_dir()).unwrap_or(false);
        out.push(path.clone());
        if real_dir {
            rglob_all(&path, out);
        }
    }
}

/// The folders that hold a SKILL.md below `folder`, without `.git` and `node_modules`, sorted.
pub fn skill_dirs(folder: &Path) -> Vec<PathBuf> {
    let mut all = Vec::new();
    rglob_all(folder, &mut all);
    let mut out: Vec<PathBuf> = all
        .into_iter()
        .filter(|p| p.file_name().is_some_and(|n| n == "SKILL.md"))
        .filter(|p| !p.components().any(|c| c.as_os_str() == ".git" || c.as_os_str() == "node_modules"))
        .filter_map(|p| p.parent().map(Path::to_path_buf))
        .collect();
    out.sort();
    out
}

/// Whether `path` (resolved) stays inside the checkout.
pub fn inside(checkout: &Path, path: &Path) -> bool {
    pathlib::resolve(path).starts_with(pathlib::resolve(checkout))
}

/// A link may stay: a repository that links one of its own files from another folder (ui-ux-pro-max does) is copied
/// with that file in place of the link. One that leaves the repository could point anywhere on this machine (a key, a
/// home folder) and is refused, and so is a folder link back into its own parents (the copy never ends).
fn check_link(checkout: &Path, link: &Path, shown: &str) -> Result<(), Error> {
    let target = pathlib::resolve(link);
    if !inside(checkout, &target) {
        return plugin_err(format!("{shown} is a link out of the repository; a plugin's files must be its own."));
    }
    let parent = link.parent().map(pathlib::resolve).unwrap_or_default();
    if target.is_dir() && parent.starts_with(&target) {
        return plugin_err(format!("{shown} is a link to a folder that holds it."));
    }
    Ok(())
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

fn walk_check(root: &Path, src: &Path, checkout: &Path, total: &mut u64) -> Result<(), Error> {
    // `os.walk(followlinks=True)`: a link to a folder is a folder
    let Ok(entries) = fs::read_dir(root) else { return Ok(()) };
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.path().is_dir() {
            if !IGNORED.contains(&name.as_str()) {
                dirs.push(name);
            }
        } else {
            files.push(name);
        }
    }
    for name in dirs.iter().chain(files.iter()) {
        let p = root.join(name);
        if is_symlink(&p) {
            let shown = p.strip_prefix(src).map(|r| r.to_string_lossy().into_owned()).unwrap_or_default();
            check_link(checkout, &p, &shown)?;
        }
    }
    for name in &files {
        *total += fs::metadata(root.join(name))?.len();
    }
    for name in &dirs {
        walk_check(&root.join(name), src, checkout, total)?;
    }
    Ok(())
}

/// The bytes a copy of `src` takes, with every link checked (`check_link`).
pub fn check_tree(src: &Path, checkout: &Path) -> Result<u64, Error> {
    let mut total = 0;
    if is_symlink(src) {
        check_link(checkout, src, &file_name(src))?;
    }
    walk_check(src, src, checkout, &mut total)?;
    Ok(total)
}

/// `shutil.copytree(src, dst, symlinks=False, dirs_exist_ok=True[, ignore=IGNORED])`: a link becomes the file or
/// folder it points to; files keep their permissions.
pub fn copy_tree(src: &Path, dst: &Path, ignore: bool) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        if ignore && IGNORED.contains(&name.to_string_lossy().as_ref()) {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&name);
        if from.is_dir() {
            copy_tree(&from, &to, ignore)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    if let Ok(meta) = fs::metadata(src) {
        let _ = fs::set_permissions(dst, meta.permissions());
    }
    Ok(())
}

fn points_outside<T>() -> Result<T, Error> {
    plugin_err("The marketplace points outside its own repository.")
}

/// `p.name` of each skill folder.
fn dir_name(p: &Path) -> String {
    file_name(p)
}

/// Make an installable plugin folder `into` from a checkout (see the layouts in the module doc of `plugins`).
pub fn build(
    checkout: &Path,
    plugin: Option<&str>,
    skills: Option<&[String]>,
    into: &Path,
    name_hint: Option<&str>,
) -> Result<Built, Error> {
    let plugin = plugin.filter(|p| !p.is_empty());
    let market = manifest(checkout, "marketplace.json");
    let entries: Vec<Value> = match market.get("plugins") {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    let root_manifest = manifest(checkout, "plugin.json");
    let mut source_dir: Option<PathBuf> = None;
    let mut picked_skills: Option<Vec<PathBuf>> = None;
    let mut meta: Map<String, Value> = Map::new();
    if let (Some(plugin), false) = (plugin, entries.is_empty()) {
        let entry =
            entries.iter().filter_map(Value::as_object).find(|e| e.get("name").and_then(Value::as_str) == Some(plugin));
        let Some(entry) = entry else {
            let names: Vec<String> = entries
                .iter()
                .map(|e| match e.get("name") {
                    Some(Value::String(s)) => s.clone(),
                    Some(other) => pyjson::py_str(other),
                    None => "?".to_string(),
                })
                .collect();
            let shown: String = names.join(", ").chars().take(200).collect();
            return plugin_err(format!("The marketplace has no plugin called {plugin}. It has: {shown}"));
        };
        for k in ["name", "version", "description"] {
            meta.insert(k.into(), entry.get(k).cloned().unwrap_or(Value::Null));
        }
        let src = entry.get("source");
        if let Some(Value::Object(src)) = src {
            let url = src.get("url").map(pyjson::py_str).unwrap_or_else(|| "None".into());
            return plugin_err(format!("{plugin} lives in another repository ({url}); install it from there."));
        }
        if let Some(v) = src {
            if !v.is_null() && !v.is_string() {
                return plugin_err(format!("{plugin} has a source the board cannot read."));
            }
        }
        let rel = src.and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("./");
        let base = pathlib::resolve(&checkout.join(rel));
        if !inside(checkout, &base) {
            return points_outside();
        }
        let listed = entry.get("skills").and_then(Value::as_array).filter(|l| !l.is_empty());
        if let Some(listed) = listed {
            let mut picked = Vec::new();
            for s in listed {
                let text = match s {
                    Value::String(s) => s.clone(),
                    other => pyjson::py_str(other),
                };
                let p = pathlib::resolve(&checkout.join(&text));
                if !s.is_string() || !inside(checkout, &p) {
                    return points_outside();
                }
                picked.push(p);
            }
            picked_skills = Some(picked);
        } else if base.join(".claude-plugin").join("plugin.json").is_file() || base.join("skills").is_dir() {
            source_dir = Some(base);
        } else {
            picked_skills = Some(skill_dirs(&base));
        }
    } else if !root_manifest.is_empty() {
        source_dir = Some(checkout.to_path_buf());
        for k in ["name", "version", "description"] {
            meta.insert(k.into(), root_manifest.get(k).cloned().unwrap_or(Value::Null));
        }
    } else if !entries.is_empty() && plugin.is_none() {
        let choices = entries
            .iter()
            .map(|e| json!({"name": e.get("name").cloned().unwrap_or(Value::Null), "description": e.get("description").cloned().unwrap_or(Value::Null)}))
            .collect();
        return Ok(Built::Choices(choices));
    } else if checkout.join("skills").is_dir() {
        picked_skills = Some(skill_dirs(&checkout.join("skills")));
    } else if checkout.join("SKILL.md").is_file() {
        picked_skills = Some(vec![checkout.to_path_buf()]);
        // a repository that is one skill: named by its SKILL.md, not by the folder it was cloned into
        meta.insert("name".into(), json!(skill_name(checkout)));
    } else {
        return plugin_err("No plugin, marketplace or skill was found there.");
    }
    if let Some(skills) = skills.filter(|s| !s.is_empty()) {
        let pool = match picked_skills.take() {
            Some(p) => p,
            None => skill_dirs(source_dir.as_deref().unwrap_or(checkout)),
        };
        let picked: Vec<PathBuf> = pool.into_iter().filter(|p| skills.contains(&dir_name(p))).collect();
        source_dir = None;
        if picked.is_empty() {
            return plugin_err(format!("None of {} was found there.", skills.join(", ")));
        }
        picked_skills = Some(picked);
        if skills.len() == 1 {
            meta.insert("name".into(), json!(skills[0]));
        }
    }
    let sources: Vec<PathBuf> = match &source_dir {
        Some(dir) => vec![dir.clone()],
        None => picked_skills.clone().unwrap_or_default(),
    };
    let mut total: u64 = 0;
    for src_dir in &sources {
        if !inside(checkout, src_dir) {
            return points_outside();
        }
        total += check_tree(src_dir, checkout)?;
        if total > MAX_PLUGIN_BYTES {
            return plugin_err(format!(
                "The plugin is larger than {} MB; the board does not copy it.",
                MAX_PLUGIN_BYTES / (1024 * 1024)
            ));
        }
    }
    fs::create_dir_all(into)?;
    match &source_dir {
        Some(dir) => copy_tree(dir, into, true)?,
        None => {
            for skill in picked_skills.as_deref().unwrap_or_default() {
                let folder = if skill == checkout { skill_name(skill) } else { dir_name(skill) };
                copy_tree(skill, &into.join("skills").join(folder), true)?;
            }
        }
    }
    static SLUG: LazyLock<Option<Regex>> = LazyLock::new(|| regex(r"[^a-z0-9-]+"));
    let chosen = truthy_text(meta.get("name"))
        .or_else(|| plugin.map(str::to_string))
        .or_else(|| name_hint.filter(|h| !h.is_empty()).map(str::to_string))
        .unwrap_or_else(|| file_name(into));
    let lowered = chosen.to_lowercase();
    let slug = SLUG.as_ref().map(|re| re.replace_all(&lowered, "-").trim_matches('-').to_string()).unwrap_or_default();
    let name = if slug.is_empty() { "plugin".to_string() } else { slug };
    let manifest_path = into.join(".claude-plugin").join("plugin.json");
    if !manifest_path.is_file() {
        if let Some(parent) = manifest_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let version = meta.get("version").filter(|v| pyjson::truthy(v)).cloned().unwrap_or_else(|| json!("0.0.0"));
        let description = meta.get("description").filter(|v| pyjson::truthy(v)).cloned().unwrap_or_else(|| json!(""));
        let text =
            pyjson::Dumps::new().indent(2).dump(&json!({"name": name, "version": version, "description": description}));
        fs::write(&manifest_path, text)?;
    }
    let final_manifest = manifest(into, "plugin.json");
    let hooks = fs::read(into.join("hooks").join("hooks.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .map(|data| match data.get("hooks") {
            Some(Value::Object(map)) => map.values().map(container_len).sum::<usize>(),
            _ => 0,
        })
        .unwrap_or(0);
    let mcp = fs::read(into.join(".mcp.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .map(|data| data.get("mcpServers").map(container_len).unwrap_or(0))
        .unwrap_or(0);
    let mut all = Vec::new();
    rglob_all(into, &mut all);
    let size: u64 = all.iter().filter(|p| p.is_file()).filter_map(|p| fs::metadata(p).ok()).map(|m| m.len()).sum();
    let mut names: Vec<String> = skill_dirs(into).iter().map(|d| dir_name(d)).collect();
    names.sort();
    names.dedup();
    Ok(Built::Plugin(PluginInfo {
        name: truthy_text(final_manifest.get("name")).unwrap_or(name),
        version: truthy_text(final_manifest.get("version")).or_else(|| text_opt(meta.get("version"))),
        description: truthy_text(final_manifest.get("description")).or_else(|| text_opt(meta.get("description"))),
        skills: names,
        hooks: hooks as i32,
        mcp: mcp as i32,
        size_bytes: size as i64,
    }))
}

/// `len(value)` of a JSON container (0 for anything else).
fn container_len(value: &Value) -> usize {
    match value {
        Value::Array(a) => a.len(),
        Value::Object(o) => o.len(),
        Value::String(s) => s.chars().count(),
        _ => 0,
    }
}
