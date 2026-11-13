//! Proof of a test case result: Markdown, so it can hold text, links, code blocks, pictures and files. Port of
//! `services/proofs.py`.
//!
//! The `proof` of a test case is written like its expected result: `![login](qa/evidence/TC-1.png)` for a
//! screenshot, a fenced block for a command and its output, a link for a CI run. An AI names a picture or file by its
//! path in the run's working folder; the board copies it into its uploads folder and rewrites the reference to
//! `/uploads/…`, so the picture shows on the ticket and survives a cleaned folder.
//!
//! A result that cannot be shown is written as "Not provable: <why>" (no iPhone, needs a real account, a matter of
//! taste). That is an honest answer, not a gap; it is shown apart from a proof.
//!
//! A folder argument (`str | list[str] | None` in Python) is a slice here: one folder, several, or none.

use std::collections::{BTreeSet, HashSet};
use std::sync::LazyLock;

use kb_base::{pyjson, pypath, pytext};
use kb_doctext::pystr;
use kb_files::{pathlib, uploads};
use regex::Regex;
use serde_json::Value;

pub const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;
// Never copied out of a working folder, whatever the AI asks for: any folder or file whose name starts with a dot
// (.git, .ssh, .claude, .config, .npmrc ...), build folders, and files named for what they hold
const DENIED_PARTS: [&str; 2] = ["node_modules", "__pycache__"];
const DENIED_SUFFIXES: [&str; 6] = [".pem", ".key", ".p12", ".pfx", ".keystore", ".env"];
/// `re.I` of a Python `str` pattern also reads a dotless or dotted capital i as an `i`.
static SECRET_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(credent[iıİ]al|secret|password|passwd|token|pr[iıİ]vate[-_]?key|[iıİ]d_rsa|[iıİ]d_ed25519)")
        .expect("static regex")
});
// [text](target) and ![alt](target), the target without spaces, an optional "title" (`\s` as Python reads it: the
// four ASCII separators are white space too)
static REF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(!?\[[^\]\n]*\]\()([^)\s\x{1c}-\x{1f}]+)((?:[\s\x{1c}-\x{1f}]+"[^"\n]*")?\))"#).expect("static regex")
});
// code is shown as written
static FENCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)(```.*?```|~~~.*?~~~|`[^`\n]+`)").expect("static regex"));
/// `_UNPROVABLE` is `^\s*(not provable|không chứng minh được)\b`, ignoring case; matched by hand (`\b` and `\s` of a
/// Python `str` pattern are not those of the `regex` crate).
const UNPROVABLE: [&str; 2] = ["not provable", "không chứng minh được"];

/// An agent outside a board run (Claude Code, Cursor... with only the MCP server) has no working folder: it names a
/// file by its absolute path on this computer, as for docs_write(import) and diagram_create. Files that are never
/// copied (keys, `.env`, anything under a dot folder such as ~/.ssh) stay refused.
pub const OUTSIDE_RUN: &str = "<outside-run>";

/// A proof was refused; the message tells the AI or the person what to fix. (A `ValueError` in Python.)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProofError(pub String);

impl std::fmt::Display for ProofError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ProofError {}

/// `str(tc.get("proof") or "")`.
fn proof_text(tc: &Value) -> String {
    match tc.get("proof") {
        Some(proof) if pyjson::truthy(proof) => pyjson::py_str(proof),
        _ => String::new(),
    }
}

/// `str(tc.get("code") or tc.get("title") or "")`.
fn code_of(tc: &Value) -> String {
    for key in ["code", "title"] {
        if let Some(value) = tc.get(key).filter(|v| pyjson::truthy(v)) {
            return pyjson::py_str(value);
        }
    }
    String::new()
}

/// One character as `re.IGNORECASE` compares it.
fn fold(c: char) -> char {
    match c {
        'ı' | 'İ' => 'i',
        'ſ' => 's',
        _ => {
            let mut lower = c.to_lowercase();
            match (lower.next(), lower.next()) {
                (Some(one), None) => one,
                _ => c,
            }
        }
    }
}

/// True when a test case has anything written as its proof (a reason it cannot be shown counts too).
pub fn has_proof(tc: &Value) -> bool {
    !pytext::strip(&proof_text(tc)).is_empty()
}

/// True when the proof says the result cannot be shown, and why.
pub fn is_unprovable(tc: &Value) -> bool {
    let proof = proof_text(tc);
    let chars: Vec<char> = proof.chars().skip_while(|c| pytext::is_space(*c)).collect();
    UNPROVABLE.iter().any(|phrase| {
        let phrase: Vec<char> = phrase.chars().collect();
        chars.len() >= phrase.len()
            && chars.iter().zip(&phrase).all(|(c, p)| fold(*c) == *p)
            && !chars.get(phrase.len()).is_some_and(|next| pystr::is_word(*next))
    })
}

fn decided(tc: &Value) -> bool {
    matches!(tc.get("status").and_then(Value::as_str), Some("pass" | "fail"))
}

/// Codes of the test cases marked pass or fail with nothing written as proof.
pub fn gaps(test_cases: &[Value]) -> Vec<String> {
    test_cases.iter().filter(|tc| decided(tc) && !has_proof(tc)).map(code_of).collect()
}

/// Codes of the test cases marked pass or fail whose proof says it cannot be shown.
pub fn unprovable(test_cases: &[Value]) -> Vec<String> {
    test_cases.iter().filter(|tc| decided(tc) && is_unprovable(tc)).map(code_of).collect()
}

/// True for a file the board never copies out of a working folder, by its path below that folder: anything in or
/// named by a dot (.git, .ssh, .env ...), build folders, key files and files named for what they hold (pictures are
/// exempt from the name rule).
pub fn never_copied(rel: &str) -> bool {
    let parts = pathlib::parts(rel);
    let name = pathlib::name(rel);
    let suffix = pathlib::suffix_of_name(name).to_lowercase();
    parts.iter().any(|part| DENIED_PARTS.contains(part))
        || parts.iter().any(|part| part.starts_with('.'))
        || DENIED_SUFFIXES.contains(&suffix.as_str())
        || (!uploads::is_supported_image(&suffix) && SECRET_NAME.is_match(name))
}

/// `str(Path(text))` on POSIX: doubled separators, `.` parts and a trailing separator are dropped.
fn path_text(text: &str) -> String {
    let joined = pathlib::parts(text).join("/");
    if pathlib::is_absolute(text) {
        format!("/{joined}")
    } else if joined.is_empty() {
        ".".to_string()
    } else {
        joined
    }
}

/// `path.relative_to(base)` for two resolved paths: the part of `path` below `base`, or None when it is outside.
fn relative_to(path: &str, base: &str) -> Option<String> {
    if path == base {
        return Some(String::new());
    }
    let prefix = if base.ends_with('/') { base.to_string() } else { format!("{base}/") };
    path.strip_prefix(&prefix).map(str::to_string)
}

async fn is_file(path: &str) -> bool {
    tokio::fs::metadata(path).await.map(|m| m.is_file()).unwrap_or(false)
}

/// The run's folders, first first (its worktree, then the member's main checkout), each once.
async fn folders(folder: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for f in folder {
        let f = if f == OUTSIDE_RUN { "/" } else { f.as_str() };
        if !f.is_empty() {
            let p = path_text(&pypath::realpath(&pypath::expanduser(f)).await);
            if !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out
}

/// Copy a file from `folder` into the uploads folder and return its `/uploads/…` url. `folder` may be several
/// folders (a run's worktree and the member's main checkout): a relative path is looked up in each, in order, and
/// an absolute one may be inside any of them.
///
/// Fails with `ProofError` when the file is outside the folder, missing, too big, of a type the board does not store
/// or one that must never be copied (keys, `.env`, `.git`).
pub async fn ingest_file(raw: &str, folder: &[String]) -> Result<String, ProofError> {
    let bases = folders(folder).await;
    let given = path_text(&pypath::expanduser(pytext::strip(raw)));
    let absolute = pathlib::is_absolute(&given);
    if outside(folder) {
        if !absolute {
            return Err(ProofError(format!(
                "{raw}: outside a board run a file is named by its absolute path on this computer \
                 (e.g. /Users/me/project/shots/login.png)."
            )));
        }
        if !is_file(&given).await {
            return Err(ProofError(format!("{raw}: no such file. Save it first, then attach it.")));
        }
    }
    let where_ = if bases.is_empty() { "(none)".to_string() } else { bases.join(" or ") };
    let mut found: Option<(String, String)> = None;
    let mut inside = false;
    for base in &bases {
        let joined = if absolute { given.clone() } else { pypath::join(base, &given) };
        let path = path_text(&pypath::realpath(&joined).await);
        let Some(rel) = relative_to(&path, base) else { continue };
        inside = true;
        if is_file(&path).await {
            found = Some((path, rel));
            break;
        }
    }
    if !inside {
        return Err(ProofError(format!(
            "{raw}: the file is outside the working folder ({where_}), so it was not attached. \
             Save it inside that folder (e.g. qa/evidence/) and name it by its path from there."
        )));
    }
    let Some((path, rel)) = found else {
        return Err(ProofError(format!(
            "{raw}: no such file in the working folder ({where_}). Write the path from the folder root, \
             e.g. qa/evidence/TC-1.png. Take the screenshot first, then write the proof."
        )));
    };
    let suffix = pathlib::suffix(&path).to_lowercase();
    if never_copied(&rel) {
        return Err(ProofError(format!("{raw}: this kind of file is never attached.")));
    }
    if uploads::mime_by_extension(&suffix).is_none() {
        let shown = if suffix.is_empty() { "a file without an extension" } else { suffix.as_str() };
        return Err(ProofError(format!(
            "{raw}: {shown} is not a type the board stores \
             (png, jpg, webp, gif, pdf, txt, log, json, csv, md, mp4 …)."
        )));
    }
    // a file that cannot be read is an `OSError` in Python (a 500 there); here it is refused with the reason
    let unreadable = |err: std::io::Error| ProofError(format!("{raw}: {err}"));
    let size = tokio::fs::metadata(&path).await.map_err(unreadable)?.len();
    if size > MAX_FILE_BYTES {
        return Err(ProofError(format!("{raw}: larger than {} MB.", MAX_FILE_BYTES / (1024 * 1024))));
    }
    let stored = uploads::build_upload_filename(pathlib::name(&path));
    let bytes = tokio::fs::read(&path).await.map_err(unreadable)?;
    tokio::fs::write(uploads::get_uploads_dir(true).join(&stored), bytes).await.map_err(unreadable)?;
    Ok(format!("/uploads/{stored}"))
}

/// The caller is an agent outside a board run (it names files by their absolute path).
fn outside(folder: &[String]) -> bool {
    folder.len() == 1 && folder[0] == OUTSIDE_RUN
}

/// A reference to a file on this computer: not a web or uploads address, and a file type the board stores.
pub(crate) fn is_local(target: &str) -> bool {
    !["/uploads/", "#", "data:", "mailto:"].iter().any(|prefix| target.starts_with(prefix))
        && !target.contains("://")
        && uploads::mime_by_extension(&pathlib::suffix(target).to_lowercase()).is_some()
}

// Files a person reads rather than code: a link to one of these on a Docs page, a comment or a work log is attached
// when the file is in the run's working folder (a link to code or to another page stays a link)
const DOCUMENTS: [&str; 21] = [
    ".pdf", ".xlsx", ".xls", ".csv", ".tsv", ".docx", ".doc", ".pptx", ".ppt", ".zip", ".tar", ".gz", ".rar", ".7z",
    ".log", ".txt", ".mp3", ".wav", ".ogg", ".mp4", ".webm",
];

/// The target names a file inside one of the run's folders that exists (outside or missing: False).
async fn present(target: &str, folder: &[String]) -> bool {
    let given = path_text(&pypath::expanduser(pytext::strip(target)));
    for base in folders(folder).await {
        let joined = if pathlib::is_absolute(&given) { given.clone() } else { pypath::join(&base, &given) };
        let path = path_text(&pypath::realpath(&joined).await);
        if relative_to(&path, &base).is_some() && is_file(&path).await {
            return true;
        }
    }
    false
}

/// The references of a text outside code, each as (the text before it, head, target, tail); the last entry is the
/// text after the last reference, with an empty head.
fn references(part: &str) -> Vec<(String, String, String, String)> {
    let mut refs = Vec::new();
    let mut last = 0;
    for m in REF.captures_iter(part) {
        let whole = m.get(0).expect("group 0 always matches");
        refs.push((part[last..whole.start()].to_string(), m[1].to_string(), m[2].to_string(), m[3].to_string()));
        last = whole.end();
    }
    refs.push((part[last..].to_string(), String::new(), String::new(), String::new()));
    refs
}

/// Every link and picture target the Markdown names.
pub fn targets(markdown: Option<&str>) -> BTreeSet<String> {
    REF.captures_iter(markdown.unwrap_or("")).map(|m| m[2].to_string()).collect()
}

/// Markdown with each picture or file named by a local path replaced by its copy in the uploads folder.
///
/// Fenced code is left alone. Without a folder (a person, not an AI run) a local path is refused: the person
/// attaches the file in the editor instead. `pictures_only` copies pictures, and of the links only those to a
/// document (an Excel sheet, a PDF, a log, a zip) that is in the folder; other links stay as written (on a Docs page
/// a link may name another page). A target in `keep` that cannot be copied stays as written instead of being
/// refused (what a page already held before this edit, such as an imported page's `images/…`).
pub async fn localize(
    markdown: Option<&str>,
    folder: &[String],
    pictures_only: bool,
    keep: &HashSet<String>,
) -> Result<Option<String>, ProofError> {
    let Some(markdown) = markdown else { return Ok(None) };
    if markdown.is_empty() || !markdown.contains("](") {
        return Ok(Some(markdown.to_string()));
    }
    // `not folder`: no folder at all, or only an empty name
    let no_folder = folder.iter().all(String::is_empty);

    let mut out = String::with_capacity(markdown.len());
    let mut at = 0;
    let mut parts: Vec<(bool, &str)> = Vec::new();
    for fence in FENCE.find_iter(markdown) {
        parts.push((false, &markdown[at..fence.start()]));
        parts.push((true, fence.as_str()));
        at = fence.end();
    }
    parts.push((false, &markdown[at..]));

    for (is_code, part) in parts {
        if is_code {
            out.push_str(part);
            continue;
        }
        for (before, head, target, tail) in references(part) {
            out.push_str(&before);
            if head.is_empty() {
                continue; // the text after the last reference
            }
            let whole = format!("{head}{target}{tail}");
            if !is_local(&target) {
                out.push_str(&whole);
                continue;
            }
            if outside(folder) && pictures_only && !pathlib::is_absolute(&pypath::expanduser(&target)) {
                // `images/x.png` on an imported page: not a file of this computer's
                out.push_str(&whole);
                continue;
            }
            if pictures_only && !head.starts_with('!') {
                // a link: an Excel sheet or a PDF the run made is attached; anything else stays as written
                let document = DOCUMENTS.contains(&pathlib::suffix(&target).to_lowercase().as_str());
                if !(!no_folder && document && present(&target, folder).await) {
                    out.push_str(&whole);
                    continue;
                }
            }
            if no_folder {
                return Err(ProofError(format!(
                    "{target}: a file is attached by path only from inside an AI run; \
                     upload it in the editor instead."
                )));
            }
            match ingest_file(&target, folder).await {
                Ok(url) => out.push_str(&format!("{head}{url}{tail}")),
                Err(_) if keep.contains(&target) => out.push_str(&whole),
                Err(err) => return Err(err),
            }
        }
    }
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn golden() -> Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../contract/golden/ticket_rules.json");
        let text = std::fs::read_to_string(path).expect("golden file ticket_rules.json exists");
        serde_json::from_str(&text).expect("golden file parses")
    }

    fn cases<'a>(golden: &'a Value, name: &str) -> &'a Vec<Value> {
        let cases = golden[name].as_array().unwrap_or_else(|| panic!("{name} cases"));
        assert!(cases.len() > 1, "{name}");
        cases
    }

    #[tokio::test]
    async fn the_pure_rules_answer_as_python_does() {
        let golden = golden();
        for case in cases(&golden, "never_copied") {
            assert_eq!(json!(never_copied(case["in"].as_str().expect("path"))), case["out"], "{}", case["in"]);
        }
        for case in cases(&golden, "has_proof") {
            assert_eq!(json!(has_proof(&case["in"])), case["out"], "has_proof {}", case["in"]);
        }
        for case in cases(&golden, "is_unprovable") {
            assert_eq!(json!(is_unprovable(&case["in"])), case["out"], "is_unprovable {}", case["in"]);
        }
        for case in cases(&golden, "gaps") {
            assert_eq!(json!(gaps(case["in"].as_array().expect("list"))), case["out"]);
        }
        for case in cases(&golden, "unprovable") {
            assert_eq!(json!(unprovable(case["in"].as_array().expect("list"))), case["out"]);
        }
        for case in cases(&golden, "targets") {
            let got: Vec<String> = targets(case["in"].as_str()).into_iter().collect();
            assert_eq!(json!(got), case["out"], "targets {}", case["in"]);
        }
        for case in cases(&golden, "is_local") {
            assert_eq!(json!(is_local(case["in"].as_str().expect("target"))), case["out"], "{}", case["in"]);
        }
        for case in cases(&golden, "localize_no_folder") {
            let got = localize(case["in"][0].as_str(), &[], false, &HashSet::new()).await;
            match got {
                Ok(text) => assert_eq!(json!(text), case["out"], "{}", case["in"]),
                Err(err) => assert_eq!(json!(err.0), case["error"], "{}", case["in"]),
            }
        }
    }

    #[tokio::test]
    #[allow(unsafe_code)]
    async fn files_of_a_working_folder_are_copied_and_the_rest_refused() {
        // not a dot folder: outside a run, a file under one is never copied
        let dir = tempfile::Builder::new().prefix("proofs-").tempdir().expect("temporary folder");
        let root = std::fs::canonicalize(dir.path()).expect("resolved");
        let uploads_dir = root.join("uploads");
        // The only test of this crate's unit tests that reads the uploads folder; set before anything reads it.
        unsafe { std::env::set_var("KANBAN_UPLOADS_DIR", &uploads_dir) };
        let work = root.join("work");
        std::fs::create_dir_all(work.join("qa/evidence")).expect("mkdir");
        std::fs::create_dir_all(work.join(".git")).expect("mkdir");
        std::fs::write(work.join("qa/evidence/TC 1.png"), b"png").expect("write");
        std::fs::write(work.join("qa/run.log"), b"log").expect("write");
        std::fs::write(work.join("qa/main.rs"), b"code").expect("write");
        std::fs::write(work.join(".git/config.txt"), b"x").expect("write");
        std::fs::write(root.join("outside.png"), b"png").expect("write");
        let folder = vec![work.to_string_lossy().into_owned()];
        let shown = folder[0].clone();
        let none = HashSet::new();

        let url = ingest_file(" qa/evidence/TC 1.png ", &folder).await.expect("copied");
        assert!(url.starts_with("/uploads/TC-1-") && url.ends_with(".png"), "{url}");
        assert_eq!(std::fs::read(uploads_dir.join(url.trim_start_matches("/uploads/"))).expect("stored"), b"png");
        let refused = |raw: &'static str| {
            let folder = folder.clone();
            async move { ingest_file(raw, &folder).await.expect_err(raw).0 }
        };
        assert_eq!(
            refused("../outside.png").await,
            format!(
                "../outside.png: the file is outside the working folder ({shown}), so it was not attached. \
                 Save it inside that folder (e.g. qa/evidence/) and name it by its path from there."
            )
        );
        assert_eq!(
            refused("qa/missing.png").await,
            format!(
                "qa/missing.png: no such file in the working folder ({shown}). Write the path from the folder root, \
                 e.g. qa/evidence/TC-1.png. Take the screenshot first, then write the proof."
            )
        );
        assert_eq!(refused(".git/config.txt").await, ".git/config.txt: this kind of file is never attached.");
        assert_eq!(
            refused("qa/main.rs").await,
            "qa/main.rs: .rs is not a type the board stores (png, jpg, webp, gif, pdf, txt, log, json, csv, md, mp4 …)."
        );
        // outside a run: an absolute path only
        let outside_run = vec![OUTSIDE_RUN.to_string()];
        assert_eq!(
            ingest_file("qa/run.log", &outside_run).await.expect_err("relative").0,
            "qa/run.log: outside a board run a file is named by its absolute path on this computer \
             (e.g. /Users/me/project/shots/login.png)."
        );
        let absolute = root.join("outside.png").to_string_lossy().into_owned();
        assert!(ingest_file(&absolute, &outside_run).await.expect("copied").starts_with("/uploads/outside-"));
        assert_eq!(
            ingest_file("/nope/x.png", &outside_run).await.expect_err("missing").0,
            "/nope/x.png: no such file. Save it first, then attach it."
        );

        // localize: code stays, a picture is copied, with `pictures_only` a link is copied only to a document there
        let markdown = "`![a](qa/run.log)` ![shot](qa/run.log \"t\") [code](qa/main.rs) [log](qa/run.log) [web](https://x.y/a.png)";
        let got = localize(Some(markdown), &folder, true, &none).await.expect("localized").expect("text");
        let urls: Vec<&str> = got.split("/uploads/run-").collect();
        assert_eq!(urls.len(), 3, "{got}");
        assert!(got.starts_with("`![a](qa/run.log)` ![shot](/uploads/run-"), "{got}");
        assert!(got.contains(".log \"t\") [code](qa/main.rs) [log](/uploads/run-"), "{got}");
        assert!(got.ends_with(".log) [web](https://x.y/a.png)"), "{got}");
        // a target the page already held stays when it cannot be copied; otherwise the edit is refused
        let keep: HashSet<String> = ["images/old.png".to_string()].into();
        let kept = localize(Some("![old](images/old.png)"), &folder, false, &keep).await.expect("kept");
        assert_eq!(kept.as_deref(), Some("![old](images/old.png)"));
        assert!(localize(Some("![old](images/old.png)"), &folder, false, &none).await.is_err());
        assert_eq!(
            localize(Some("![p](images/x.png)"), &outside_run, true, &none).await.expect("left"),
            Some("![p](images/x.png)".to_string())
        );
    }
}
