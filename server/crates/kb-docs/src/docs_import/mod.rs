//! Import Markdown files (or a folder tree) into the Docs space as draft pages (`services/docs_import.py`).
//!
//! Rules: folders become parent pages (an `index.md` / `README.md` inside a folder is that folder page's body); a
//! page title comes from the front matter `title:`, else the first `# ` heading, else the file name; `[[links]]` are
//! kept as written. A dry run reports the plan without writing anything.
//!
//! Layout (python lines): this file 1-123 (one file: path, front matter, title), `plan` 126-387 (the plan: which
//! pages, under which parents, with which titles), `run` 390-533 (the dry run, the import, the post-import pass),
//! `local` 536-584 (reading the server's own disk, for MCP), `yaml` (`yaml.safe_load`).

use std::sync::LazyLock;

use kb_base::pytext;
use kb_doctext::docs_text::{heading_match, is_fence};
use regex::Regex;

use crate::docs::{MAX_MARKDOWN, MAX_TITLE};
use crate::{Error, Result};

mod local;
mod plan;
mod run;
pub mod yaml;

pub use local::collect_local;
pub use plan::{Node, Plan, build_plan, dry_run, file_report};
pub use run::{resolve_pages, run_import};

use yaml::{Failure, Yaml};

/// Most files in one import.
pub const MAX_FILES: usize = 200;
/// Largest file, in bytes.
pub const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
/// The extensions that are imported (lower case).
pub const EXTENSIONS: [&str; 2] = [".md", ".markdown"];
const INDEX_NAMES: [&str; 2] = ["index", "readme"];
const SKIP_DIRS: [&str; 2] = ["node_modules", "__pycache__"];

// ---------------------------------------------------------------------------
// One file: path, front matter, title
// ---------------------------------------------------------------------------

static DRIVE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z]:").expect("the drive pattern is valid"));

/// Path segments of a relative upload path, or None when it is unsafe (absolute, `..`, empty).
pub fn clean_path(raw: &str) -> Option<Vec<String>> {
    let replaced = raw.replace('\\', "/");
    let path = pytext::strip(&replaced);
    if path.is_empty() || path.contains('\0') || path.starts_with('/') || DRIVE.is_match(path) {
        return None;
    }
    let parts: Vec<String> = path.split('/').filter(|p| !p.is_empty() && *p != ".").map(str::to_string).collect();
    if parts.is_empty() || parts.iter().any(|p| p == "..") {
        return None;
    }
    Some(parts)
}

/// What `split_front_matter` found.
#[derive(Debug, Clone, PartialEq)]
pub struct FrontMatter {
    /// The metadata (a mapping; empty without front matter).
    pub meta: Yaml,
    /// The text after the front matter.
    pub body: String,
    /// The 1-based line of a YAML problem.
    pub error_line: Option<usize>,
}

/// `(metadata, body, error_line)`: `error_line` is the 1-based line of a YAML problem. A YAML failure that Python
/// does not catch (`ValueError`) is an `Err`: a 500.
pub fn split_front_matter(text: &str) -> Result<FrontMatter> {
    let none = || Yaml::Map(Vec::new());
    let lines: Vec<&str> = text.split('\n').collect();
    let rstrip = |s: &str| s.trim_end_matches(pytext::is_space).to_string();
    if rstrip(lines[0]) != "---" {
        return Ok(FrontMatter { meta: none(), body: text.to_string(), error_line: None });
    }
    let Some(end) = (1..lines.len()).find(|&i| matches!(rstrip(lines[i]).as_str(), "---" | "...")) else {
        return Ok(FrontMatter { meta: none(), body: text.to_string(), error_line: None });
    };
    let meta = match yaml::safe_load(&lines[1..end].join("\n")) {
        Ok(meta) => meta,
        Err(Failure::Yaml(line, ..)) => {
            // `mark.line + 2`: 0-based in the block, which starts on the second line of the file
            let error_line = line.map_or(1, |l| l + 1);
            return Ok(FrontMatter { meta: none(), body: text.to_string(), error_line: Some(error_line) });
        }
        Err(Failure::Crash(message)) => return Err(Error::Other(message)),
    };
    let meta = match meta {
        None => none(),
        Some(m @ Yaml::Map(_)) => m,
        Some(_) => return Ok(FrontMatter { meta: none(), body: text.to_string(), error_line: Some(1) }),
    };
    let body = lines[end + 1..].join("\n").trim_start_matches('\n').to_string();
    Ok(FrontMatter { meta, body, error_line: None })
}

/// `_first_h1`: the text of the first `# ` heading outside a code fence and the body without that line (and the
/// blank lines that followed it).
pub fn first_h1(body: &str) -> (Option<String>, String) {
    let lines: Vec<&str> = body.split('\n').collect();
    let mut in_fence = false;
    for (i, line) in lines.iter().enumerate() {
        if is_fence(line) {
            in_fence = !in_fence;
            continue;
        }
        if !in_fence {
            if let Some(m) = heading_match(line) {
                if m.hashes == "#" {
                    let mut rest: Vec<&str> = lines[..i].iter().chain(lines[i + 1..].iter()).copied().collect();
                    while i < rest.len() && pytext::strip(rest[i]).is_empty() {
                        rest.remove(i); // the blank lines that followed the title
                    }
                    return (Some(pytext::strip(&m.text).to_string()), rest.join("\n"));
                }
            }
        }
    }
    (None, body.to_string())
}

/// One uploaded file in an import: path, parsed title, size and any error.
#[derive(Debug, Clone, Default)]
pub struct Entry {
    /// Position in the upload, used to report results.
    pub index: usize,
    /// The path as uploaded.
    pub path: String,
    /// Its clean segments.
    pub segments: Vec<String>,
    /// The page title.
    pub title: Option<String>,
    /// The title came from the front matter or a heading.
    pub explicit_title: bool,
    /// The page text.
    pub body: String,
    /// Size of the file in bytes.
    pub size: usize,
    /// Why the file cannot be imported.
    pub error: Option<String>,
    /// Warnings (a title that was taken, links not found).
    pub messages: Vec<String>,
    /// Left out because a page with that title exists.
    pub skipped: bool,
    /// Titles from the top to this page.
    pub page_path: Option<Vec<String>>,
    /// Links to pages that exist or are made by this import.
    pub resolved: usize,
    /// Titles of links that are not found.
    pub unresolved: Vec<String>,
    /// An `index.md` / `README.md` inside a folder.
    pub is_index: bool,
    /// The folder.
    pub parent_key: Vec<String>,
}

/// Decode and parse one uploaded Markdown file (front matter and title).
///
/// `index` is the position in the upload; `path` the path as uploaded (`folder/page.md`); `data` the raw bytes.
/// `error` of the entry is set when the file cannot be imported.
pub fn parse_file(index: usize, path: &str, data: &[u8]) -> Result<Entry> {
    let mut e = Entry { index, path: path.to_string(), size: data.len(), ..Entry::default() };
    let Some(segs) = clean_path(path) else {
        e.error = Some("Unsafe path (absolute paths and '..' are not allowed)".into());
        return Ok(e);
    };
    e.segments = segs.clone();
    let name = segs.last().map(String::as_str).unwrap_or("");
    let lower = name.to_lowercase();
    if !EXTENSIONS.iter().any(|x| lower.ends_with(x)) {
        e.error = Some("Only .md and .markdown files can be imported".into());
        return Ok(e);
    }
    if data.len() > MAX_FILE_BYTES {
        e.error = Some("File is larger than 2 MB".into());
        return Ok(e);
    }
    // `data.decode("utf-8-sig")`
    let data = data.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(data);
    let Ok(text) = std::str::from_utf8(data) else {
        e.error = Some("File is not valid UTF-8 text".into());
        return Ok(e);
    };
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let fm = split_front_matter(&text)?;
    if let Some(line) = fm.error_line {
        e.error = Some(format!("Front matter could not be read (line {line})"));
        return Ok(e);
    }
    let (meta, mut body) = (fm.meta, fm.body);
    let stem = file_stem(name);
    let mut title = match meta.get("title") {
        Some(Yaml::Str(s)) => pytext::strip(s).to_string(),
        // `isinstance(title, (str, int, float))`: a bool is an int
        Some(Yaml::Bool(b)) => if *b { "True" } else { "False" }.to_string(),
        Some(Yaml::Int(d)) => d.clone(),
        Some(Yaml::Float(f)) => float_str(*f),
        _ => String::new(),
    };
    if !title.is_empty() {
        e.explicit_title = true;
        let (h1, rest) = first_h1(&body);
        if h1.is_some_and(|h| crate::util::casefold(&h) == crate::util::casefold(&title)) {
            body = rest; // the heading just repeats the title
        }
    } else {
        let (h1, rest) = first_h1(&body);
        if let Some(h1) = h1.filter(|h| !h.is_empty()) {
            title = h1;
            body = rest;
            e.explicit_title = true;
        }
    }
    let chosen = if !title.is_empty() {
        title
    } else if !stem.is_empty() {
        stem.clone()
    } else {
        "Untitled".to_string()
    };
    e.title = Some(chosen.chars().take(MAX_TITLE).collect());
    e.body = body.clone();
    if body.chars().count() > MAX_MARKDOWN {
        e.error = Some("File is too large for a page".into());
        return Ok(e);
    }
    e.is_index = segs.len() > 1 && INDEX_NAMES.contains(&stem.to_lowercase().as_str());
    Ok(e)
}

/// `re.sub(r"\.(md|markdown)$", "", name, flags=re.IGNORECASE)`.
fn file_stem(name: &str) -> String {
    let lower = name.to_lowercase();
    for ext in [".markdown", ".md"] {
        if lower.ends_with(ext) {
            let keep = name.chars().count() - ext.chars().count();
            return name.chars().take(keep).collect();
        }
    }
    name.to_string()
}

/// `str(float)`: `repr`, with `inf` and `nan` in lower case.
fn float_str(f: f64) -> String {
    if f.is_nan() {
        "nan".to_string()
    } else if f.is_infinite() {
        if f > 0.0 { "inf" } else { "-inf" }.to_string()
    } else {
        kb_base::pyjson::float_repr(f)
    }
}
