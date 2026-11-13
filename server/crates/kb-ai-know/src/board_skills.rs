//! The board's own skills, loaded in every Claude Code run with `--plugin-dir`. Port of `services/ai/board_skills.py`.
//!
//! Claude Code keeps only the first 10,000 characters of an MCP server's instructions, so a long guide cannot ride
//! there: it reaches an AI as a skill instead, which Claude Code loads whole when the work calls for it (the person's
//! own design skills work the same way). Today: `canvas-design`, the design guide for canvas frames, with `craft.md`
//! and its exemplar boards in `examples/`: a skill can carry files, and a board to look at teaches the bar better than
//! a paragraph; `drawio-diagrams` and `sketches`, how to draw a diagram, what to do with a person's Sketch and which
//! tool fits (issue #267); `docs-pages`, how to work in Docs (issue #268); and the shared skills every role uses (issue
//! #277): working a ticket, evidence and handing over, the repository and the machine, asking and writing, working
//! together; and one skill per role (issue #273), which only a member of that role gets.
//!
//! A project switches each skill off for every member or for one (`ops.board_skills`); a run gets a folder holding
//! only the skills on for it.

use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use kb_base::pytext;
use kb_db::database;
use kb_skills::{role_skills, shared_skills};
use regex::Regex;
use serde_json::{Map, Value, json};
use sha1::{Digest, Sha1};

/// `NAME`: the plugin's name.
pub const NAME: &str = "kanban-board";

/// The skill every run opens first (launch.py says REQUIRED): it cannot be switched off.
pub const ALWAYS_ON: &str = "working-a-ticket";

/// A dict in insertion order: setting a name again keeps its place.
fn put<V>(list: &mut Vec<(String, V)>, name: String, value: V) {
    match list.iter_mut().find(|(have, _)| *have == name) {
        Some(slot) => slot.1 = value,
        None => list.push((name, value)),
    }
}

/// `_skills()`: every skill's SKILL.md text, by name, in the order the board lists them.
pub fn skills() -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    put(
        &mut out,
        "canvas-design".into(),
        format!("{}{}", kb_draw::canvas_design::SKILL_HEADER, kb_draw::canvas_design::GUIDE),
    );
    // draw.io diagrams and what an AI does with a Sketch, with which tool to choose (issue #267)
    put(
        &mut out,
        "drawio-diagrams".into(),
        format!("{}{}", kb_draw::visual_guides::DRAWIO_HEADER, kb_draw::visual_guides::DRAWIO),
    );
    put(
        &mut out,
        "sketches".into(),
        format!("{}{}", kb_draw::visual_guides::SKETCH_HEADER, kb_draw::visual_guides::SKETCH),
    );
    // how to work in Docs: pages vs comments, the Markdown kept, editing a part, files, comments, tickets (#268)
    put(
        &mut out,
        "docs-pages".into(),
        format!("{}{}", kb_doctext::docs_guide::SKILL_HEADER, kb_doctext::docs_guide::GUIDE),
    );
    // how any role works a ticket (issue #277)
    for (name, text) in shared_skills::skill_files() {
        put(&mut out, name, text);
    }
    // how each role does its own job (issue #273): only a member of that role gets its skill
    for (name, text) in role_skills::skill_files() {
        put(&mut out, name, text);
    }
    out
}

/// `_skills()` as a lookup.
pub fn skill_text(name: &str) -> Option<String> {
    skills().into_iter().find(|(n, _)| n == name).map(|(_, t)| t)
}

fn description_of(text: &str) -> String {
    use std::sync::LazyLock;
    static DESCRIPTION: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(r"(?m)^description:\s*(.+)$").ok());
    DESCRIPTION
        .as_ref()
        .and_then(|re| re.captures(text))
        .and_then(|c| c.get(1))
        .map(|m| pytext::strip(m.as_str()).to_string())
        .unwrap_or_default()
}

/// Shared skills that teach one craft, and the roles that do that work (AI v2). A team gets one when one of its roles
/// is listed; the other shared skills (the ticket, Docs, asking and writing, memory, handing over, the repo) are for
/// every team. Fewer skills keep the list the CLI shows the model short enough that it reads it.
pub const CRAFT_ROLES: [(&str, &[&str]); 8] = [
    ("canvas-design", &["designer", "pm", "ba"]),
    ("sketches", &["designer", "pm", "ba", "dev"]),
    ("drawio-diagrams", &["designer", "pm", "ba", "dev", "tech_writer", "devops", "data_analyst"]),
    ("slides", &["pm", "ba", "tech_writer", "data_analyst"]),
    ("office-files", &["pm", "ba", "tech_writer", "data_analyst"]),
    ("end-user-eyes", &["designer", "qa", "user_tester", "pm", "ba"]),
    ("brainstorming", &["pm", "ba", "designer"]),
    ("demo-video", &["pm", "ba", "designer", "dev", "qa", "user_tester", "tech_writer", "devops", "data_analyst"]),
];

fn craft_roles(name: &str) -> Option<&'static [&'static str]> {
    CRAFT_ROLES.iter().find(|(n, _)| *n == name).map(|(_, roles)| *roles)
}

/// The board's skills for the UI: `[{name, description, role, craft_roles, always_on}]`, from each SKILL.md's front
/// matter; `role` is the role a role skill is for (None: every role).
pub fn catalog() -> Vec<Value> {
    skills()
        .into_iter()
        .map(|(name, text)| {
            let crafts = craft_roles(&name).map(|roles| {
                let sorted: BTreeSet<&str> = roles.iter().copied().collect();
                json!(sorted)
            });
            json!({
                "name": name,
                "description": description_of(&text),
                "role": role_skills::role_of_skill(&name),
                // the roles that do this craft; None for a skill that is for every team
                "craft_roles": crafts.unwrap_or(Value::Null),
                "always_on": name == ALWAYS_ON,
            })
        })
        .collect()
}

/// The `role` argument of `enabled_for`: `str | set[str] | None`.
#[derive(Debug, Clone, Default)]
pub enum Roles {
    /// None: the v1 callers, no role filter.
    #[default]
    Unset,
    /// One key.
    One(String),
    /// A team's role keys.
    Many(HashSet<String>),
}

impl From<&str> for Roles {
    fn from(role: &str) -> Self {
        Roles::One(role.to_string())
    }
}

impl From<HashSet<String>> for Roles {
    fn from(roles: HashSet<String>) -> Self {
        Roles::Many(roles)
    }
}

impl From<&HashSet<String>> for Roles {
    fn from(roles: &HashSet<String>) -> Self {
        Roles::Many(roles.clone())
    }
}

impl From<Option<&str>> for Roles {
    fn from(role: Option<&str>) -> Self {
        role.map_or(Roles::Unset, Roles::from)
    }
}

impl Roles {
    fn set(&self) -> Option<HashSet<&str>> {
        match self {
            Roles::Unset => None,
            Roles::One(k) => Some(HashSet::from([k.as_str()])),
            Roles::Many(set) => Some(set.iter().map(String::as_str).collect()),
        }
    }
}

fn lists(value: Option<&Value>, member_id: &str) -> bool {
    match value {
        Some(Value::Array(items)) => items.iter().any(|v| v.as_str() == Some(member_id)),
        _ => false,
    }
}

/// The board's skills on for a team: the team's own switch, else the project's (on unless switched off).
///
/// `ops["board_skills"]` is a list (the UI camel-cases dict keys): `[{skill, on, members_on, members_off}]`; a skill
/// not listed is on for everyone. `role`: the team's role keys (AI v2; one key or None for the v1 callers). A role
/// skill is only for a team with that role; a craft skill (CRAFT_ROLES) only for a team with a role that does that
/// work, when roles are given.
pub fn enabled_for(ops: &Map<String, Value>, member_id: Option<&str>, role: impl Into<Roles>) -> Vec<String> {
    let role: Roles = role.into();
    let roles = role.set();
    let mut rows: Vec<(&str, &Map<String, Value>)> = Vec::new();
    if let Some(Value::Array(items)) = ops.get("board_skills").filter(|v| kb_base::pyjson::truthy(v)) {
        for r in items.iter().filter_map(Value::as_object) {
            if let Some(skill) = r.get("skill").and_then(Value::as_str) {
                // a dict comprehension: a later row for the same skill wins
                rows.retain(|(s, _)| *s != skill);
                rows.push((skill, r));
            }
        }
    }
    let member_id = member_id.filter(|m| !m.is_empty());
    let mut out = Vec::new();
    for (name, _text) in skills() {
        if let Some(for_role) = role_skills::role_of_skill(&name) {
            if !roles.as_ref().is_some_and(|set| set.contains(for_role)) {
                continue;
            }
        }
        if let (Some(set), Some(crafts)) = (roles.as_ref(), craft_roles(&name)) {
            if !crafts.iter().any(|c| set.contains(c)) {
                continue;
            }
        }
        let row = rows.iter().find(|(s, _)| *s == name).map(|(_, r)| *r);
        let Some(r) = row.filter(|_| name != ALWAYS_ON) else {
            out.push(name);
            continue;
        };
        let on = if member_id.is_some_and(|m| lists(r.get("members_on"), m)) {
            true
        } else if member_id.is_some_and(|m| lists(r.get("members_off"), m)) {
            false
        } else {
            // `r.get("on", True) is not False`
            r.get("on") != Some(&Value::Bool(false))
        };
        if on {
            out.push(name);
        }
    }
    out
}

/// The files a skill carries beside its SKILL.md: `{skill: {relative path: bytes}}`.
pub fn skill_files() -> Vec<(String, Vec<(String, Vec<u8>)>)> {
    let mut out: Vec<(String, Vec<(String, Vec<u8>)>)> = Vec::new();
    let mut canvas = vec![("craft.md".to_string(), kb_draw::canvas_design::CRAFT.as_bytes().to_vec())];
    for (name, bytes) in kb_draw::canvas_design::examples() {
        canvas.push((format!("examples/{name}"), bytes.to_vec()));
    }
    put(&mut out, "canvas-design".into(), canvas);
    // the slides skill's scripts, themes and examples (issue #277)
    for (name, files) in shared_skills::extra_files() {
        put(&mut out, name, files.into_iter().map(|(rel, data)| (rel, data.to_vec())).collect());
    }
    // the BA's document templates (issue #273)
    for (name, files) in role_skills::extra_files() {
        put(&mut out, name, files.into_iter().map(|(rel, data)| (rel, data.to_vec())).collect());
    }
    out
}

/// The plugin folder (beside the database), written again when a skill's text changed. `names`: only these skills
/// (the ones on for the run), in a folder of their own; None: all of them.
pub fn plugin_dir(names: Option<&[String]>) -> io::Result<String> {
    let all = skills();
    let every: Vec<&str> = all.iter().map(|(n, _)| n.as_str()).collect();
    let picked: Vec<&str> = match names {
        None => every.clone(),
        Some(wanted) => every.iter().copied().filter(|n| wanted.iter().any(|w| w == n)).collect(),
    };
    let db = database::get_db_path();
    let parent = db.parent().map(Path::to_path_buf).unwrap_or_default();
    let mut root = parent.join("board-skills");
    if picked != every {
        let digest = Sha1::digest(picked.join(",").as_bytes());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        root = parent.join(format!("board-skills-{}", &hex[..10]));
    }
    let manifest = root.join(".claude-plugin").join("plugin.json");
    write(
        &manifest,
        kb_base::pyjson::dumps(&json!({
            "name": NAME,
            "description": "The Kanban board's own skills.",
            "version": "1",
        }))
        .as_bytes(),
    )?;
    let mut keep: HashSet<PathBuf> = HashSet::new();
    for (name, text) in &all {
        if picked.contains(&name.as_str()) {
            let path = root.join("skills").join(name).join("SKILL.md");
            write(&path, text.as_bytes())?;
            keep.insert(path);
        }
    }
    for (name, files) in skill_files() {
        if !picked.contains(&name.as_str()) {
            continue;
        }
        for (rel, data) in files {
            let path = root.join("skills").join(&name).join(&rel);
            write(&path, &data)?;
            keep.insert(path);
        }
    }
    prune(&root.join("skills"), &keep)?;
    Ok(root.to_string_lossy().into_owned())
}

/// `sorted(folder.rglob("*"), key=len(parts), reverse=True)`: every entry below `folder`, a link to a folder listed
/// and not entered.
fn walk(folder: &Path, out: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(folder)? {
        let path = entry?.path();
        let is_real_dir = fs::symlink_metadata(&path).map(|m| m.is_dir()).unwrap_or(false);
        out.push(path.clone());
        if is_real_dir {
            walk(&path, out)?;
        }
    }
    Ok(())
}

/// Remove what an earlier version wrote and this one no longer ships (a renamed script, a dropped theme), so a run
/// never finds a stale file beside the current ones. Files a run left in the folder (its .look/ renders) go too: the
/// folder is the board's, not a place to work in.
fn prune(folder: &Path, keep: &HashSet<PathBuf>) -> io::Result<()> {
    if !folder.is_dir() {
        return Ok(());
    }
    let mut all = Vec::new();
    walk(folder, &mut all)?;
    all.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
    for p in all {
        if p.is_file() && !keep.contains(&p) {
            match fs::remove_file(&p) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        } else if p.is_dir() && fs::read_dir(&p)?.next().is_none() {
            fs::remove_dir(&p)?;
        }
    }
    Ok(())
}

/// Where one of the board's skills is on this machine, with the files it carries (for an agent outside Claude Code).
pub fn skill_dir(name: &str) -> io::Result<String> {
    Ok(Path::new(&plugin_dir(None)?).join("skills").join(name).to_string_lossy().into_owned())
}

/// Where the design guide's exemplar boards are on this machine (for an agent outside Claude Code).
pub fn examples_dir() -> io::Result<String> {
    Ok(Path::new(&plugin_dir(None)?)
        .join("skills")
        .join("canvas-design")
        .join("examples")
        .to_string_lossy()
        .into_owned())
}

fn write(path: &Path, data: &[u8]) -> io::Result<()> {
    if path.is_file() && fs::read(path).is_ok_and(|have| have == data) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, data)
}
