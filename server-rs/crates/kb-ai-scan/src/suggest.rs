//! What the scan proposes (`repo_scan.py` lines 299-438: `_dir`, `_npm`, `_py`, `_pkg_cmd`, `_ROLE_NAMES`, `_wanted`,
//! `suggest`).
//!
//! 2. **Suggest**: test, lint and build commands, the prepare command for a worktree, a port, the team (the usual
//!    roles, plus a Designer and a User tester when there is a UI), the plugins of the catalogue for those roles, and
//!    the hand-over route. A person changes any of it before anything is created.

use std::sync::LazyLock;

use kb_ai_know::plugins::CATALOGUE;
use kb_ai_work::worktrees;
use kb_base::pyjson;
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::Error;
use crate::pyfs::type_name;

/// `_ROLE_NAMES`: the roles a team can have, in the order the team lists them.
pub const ROLE_NAMES: [(&str, &str); 12] = [
    ("triage", "Triage"),
    ("pm", "PM"),
    ("ba", "BA"),
    ("designer", "Designer"),
    ("dev", "Dev"),
    ("qa", "QA"),
    ("reviewer", "Reviewer"),
    ("user_tester", "User tester"),
    // the roles of issue #273: only when the repository calls for them (the light model picks them)
    ("tech_writer", "Technical writer"),
    ("devops", "DevOps"),
    ("security", "Security reviewer"),
    ("data_analyst", "Data analyst"),
];

/// `_ROLE_NAMES[key]`.
pub fn role_name(key: &str) -> Option<&'static str> {
    ROLE_NAMES.iter().find(|(k, _)| *k == key).map(|(_, name)| *name)
}

/// `KeyError`'s text for a missing key.
fn key_error(key: &str) -> Error {
    Error::Other(format!("'{key}'"))
}

fn text_of<'a>(pkg: &'a Value, key: &str) -> Result<&'a str, Error> {
    match pkg.get(key) {
        Some(Value::String(s)) => Ok(s),
        Some(other) => Err(Error::Other(format!("'{}' object has no attribute 'replace'", type_name(other)))),
        None => Err(key_error(key)),
    }
}

/// A package's folder for a command line (forward slashes, which npm and uv take on Windows too; quoted when it has a
/// space), or None for the repository root.
pub fn dir(pkg: &Value) -> Result<Option<String>, Error> {
    let path = text_of(pkg, "path")?.replace('\\', "/");
    if path.is_empty() || path == "." {
        return Ok(None);
    }
    Ok(Some(if path.contains(' ') { format!("\"{path}\"") } else { path }))
}

/// An npm command for a package's folder. `--prefix` instead of `cd folder &&`: the commands are joined with `&&` into
/// one shell line, where a `cd` would also move every command after it (`cd ui && npm ci && uv sync` ran `uv sync` in
/// ui/).
pub fn npm(pkg: &Value, args: &str) -> Result<String, Error> {
    Ok(match dir(pkg)? {
        None => format!("npm {args}"),
        Some(d) => format!("npm --prefix {d} {args}"),
    })
}

/// A uv or poetry command run in a package's folder (`--directory`, for the same reason as `npm`).
pub fn py(pkg: &Value, args: &str) -> Result<String, Error> {
    let tool = if pkg.get("manager").and_then(Value::as_str) == Some("uv") { "uv" } else { "poetry" };
    Ok(match dir(pkg)? {
        None => format!("{tool} {args}"),
        Some(d) => format!("{tool} --directory {d} {args}"),
    })
}

/// `needle in value` for what a `package.json` may hold in the place of a dict.
fn py_in(needle: &str, value: &Value) -> Result<bool, Error> {
    match value {
        Value::String(s) => Ok(s.contains(needle)),
        Value::Array(items) => Ok(items.iter().any(|v| v.as_str() == Some(needle))),
        Value::Object(map) => Ok(map.contains_key(needle)),
        other => Err(Error::Other(format!("argument of type '{}' is not iterable", type_name(other)))),
    }
}

/// `scripts[key]` for a `scripts` that is not a dict: the `TypeError` of indexing it with a string.
fn py_index<'a>(scripts: &'a Value, key: &str) -> Result<&'a Value, Error> {
    match scripts {
        Value::Object(map) => map.get(key).ok_or_else(|| key_error(key)),
        Value::String(_) => Err(Error::Other("string indices must be integers, not 'str'".into())),
        Value::Array(_) => Err(Error::Other("list indices must be integers or slices, not str".into())),
        other => Err(Error::Other(format!("'{}' object is not subscriptable", type_name(other)))),
    }
}

/// The npm command of a package script, run in the package's folder (a test run never watches).
pub fn pkg_cmd(pkg: &Value, script: &str) -> Result<Option<String>, Error> {
    let scripts = pkg.get("scripts").filter(|v| pyjson::truthy(v)).cloned().unwrap_or_else(|| json!({}));
    if !py_in(script, &scripts)? {
        return Ok(None);
    }
    if script == "test" {
        let test = py_index(&scripts, "test")?;
        let watches = py_in("vitest", test)? && {
            let words: Vec<&str> = match test {
                Value::String(s) => kb_base::pytext::split(s),
                other => {
                    return Err(Error::Other(format!("'{}' object has no attribute 'split'", type_name(other))));
                }
            };
            !words.contains(&"run")
        };
        return npm(pkg, &format!("test{}", if watches { " -- --run" } else { "" })).map(Some);
    }
    npm(pkg, &format!("run {script}")).map(Some)
}

/// A browser tool (`ui`) is only for a project with a UI.
pub fn wanted(entry: &Map<String, Value>, found: &Value) -> bool {
    found.get("ui").is_some_and(pyjson::truthy) || !entry.get("ui").is_some_and(pyjson::truthy)
}

/// `re.search(r"\b(test|pytest|vitest|jest)\b", low)`
fn is_test_command(low: &str) -> bool {
    static TEST: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\b(test|pytest|vitest|jest)\b").expect("a fixed pattern"));
    TEST.is_match(low)
}

/// `re.search(r"\b(lint|ruff|eslint)\b", low)`
fn is_lint_command(low: &str) -> bool {
    static LINT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\b(lint|ruff|eslint)\b").expect("a fixed pattern"));
    LINT.is_match(low)
}

fn dedupe(items: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in items {
        if !out.contains(&item) {
            out.push(item);
        }
    }
    out
}

fn first_two(items: &[String]) -> String {
    items.iter().take(2).cloned().collect::<Vec<_>>().join(" && ")
}

/// What the scan proposes; a person changes any of it before anything is created.
pub fn suggest(found: &Value) -> Result<Value, Error> {
    let (mut tests, mut lints, mut builds, mut prepares): (Vec<String>, Vec<String>, Vec<String>, Vec<String>) =
        (vec![], vec![], vec![], vec![]);
    let packages = found.get("packages").and_then(Value::as_array).ok_or_else(|| key_error("packages"))?;
    for pkg in packages {
        match pkg.get("kind").and_then(Value::as_str).ok_or_else(|| key_error("kind"))? {
            "node" => {
                for (name, bucket) in [("test", &mut tests), ("lint", &mut lints), ("build", &mut builds)] {
                    if let Some(cmd) = pkg_cmd(pkg, name)?.filter(|c| !c.is_empty()) {
                        bucket.push(cmd);
                    }
                }
                prepares.push(npm(pkg, "ci")?);
            }
            "python" => {
                let manager = pkg.get("manager").and_then(Value::as_str);
                let managed = matches!(manager, Some("uv" | "poetry"));
                let d = dir(pkg)?;
                if pkg.get("pytest").is_some_and(pyjson::truthy) {
                    tests.push(if managed {
                        py(pkg, "run pytest -q")?
                    } else {
                        match &d {
                            None => "pytest -q".to_string(),
                            Some(d) => format!("pytest -q {d}"),
                        }
                    });
                }
                if pkg.get("ruff").is_some_and(pyjson::truthy) {
                    lints.push(if managed {
                        py(pkg, "run ruff check .")?
                    } else {
                        format!("ruff check {}", d.as_deref().unwrap_or("."))
                    });
                }
                if managed {
                    prepares.push(py(pkg, if manager == Some("uv") { "sync" } else { "install" })?);
                }
                // plain pip has no environment of its own: `pip install -e .` would install into whatever Python is
                // on the PATH, the person's own, so nothing is proposed and a person writes the command they use
            }
            _ => {}
        }
    }
    let ci: Vec<&str> = found
        .get("ci_commands")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    for cmd in ci {
        let low = cmd.to_lowercase();
        if tests.is_empty() && is_test_command(&low) {
            tests.push(cmd.to_string());
        }
        if lints.is_empty() && is_lint_command(&low) {
            lints.push(cmd.to_string());
        }
    }
    let languages = found.get("languages").and_then(Value::as_array).ok_or_else(|| key_error("languages"))?;
    let has_language = |name: &str| languages.iter().any(|v| v.as_str() == Some(name));
    if has_language("go") && tests.is_empty() {
        tests.push("go test ./...".to_string());
    }
    if has_language("rust") && tests.is_empty() {
        tests.push("cargo test".to_string());
    }
    let ui = found.get("ui").ok_or_else(|| key_error("ui")).map(pyjson::truthy)?;
    let mut roles: Vec<&str> = vec!["triage", "pm", "ba", "dev", "qa", "reviewer"];
    if ui {
        roles.insert(3, "designer");
        roles.push("user_tester");
    }
    let team: Vec<Value> =
        roles.iter().map(|r| json!({"pack": r, "name": role_name(r).unwrap_or_default()})).collect();
    let suggested_plugins: Vec<Value> = CATALOGUE
        .iter()
        .filter(|c| {
            let wanted_roles = c.get("roles").and_then(Value::as_array);
            wanted_roles.is_some_and(|rs| rs.iter().any(|r| r.as_str().is_some_and(|r| roles.contains(&r))))
                && wanted(c, found)
        })
        .filter_map(|c| c.get("key").cloned())
        .collect();
    let remote = found.get("remote").and_then(Value::as_str).filter(|r| !r.is_empty());
    let handover = match remote {
        None => "local",
        Some(r) if worktrees::is_github(Some(r)) => "pr",
        Some(_) => "branch",
    };
    let why_handover = match handover {
        "local" => "No remote: merge on this machine.",
        "pr" => "A GitHub remote: open a pull request.",
        _ => "A remote that is not GitHub: push the branch.",
    };
    let team_why = format!(
        "The usual roles of a team{}",
        if ui { ", plus a Designer and a User tester because it has a UI." } else { "." }
    );
    Ok(json!({
        "commands": {
            "test": first_two(&tests),
            "lint": first_two(&lints),
            "build": first_two(&builds),
        },
        "prepare": dedupe(prepares).join(" && "),
        "base_port": 5180,
        "team": team,
        "plugins": suggested_plugins,
        "handover": handover,
        "worktrees": found.get("git").is_some_and(pyjson::truthy),
        "why": {
            "commands": "Taken from the CI workflow when there is one, else from the package scripts.",
            "team": team_why,
            "handover": why_handover,
        },
    }))
}
