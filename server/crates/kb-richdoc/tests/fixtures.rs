//! The shared fixtures of `server/contract/richdoc/fixtures` (see its README): every Markdown input reads to its
//! JSON, every JSON writes its Markdown and its text, byte for byte as the UI does; the annotated fixtures read to
//! the same page and are written back the same.

use std::fs;
use std::path::{Path, PathBuf};

use kb_richdoc::{SeqIds, annotated_to_doc, doc_to_annotated, doc_to_markdown, doc_to_text, markdown_to_doc, validate};
use serde_json::Value;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contract/richdoc/fixtures")
}

/// The names of the inputs of a fixture folder (`<name><ext>`, not `<name>.out<ext>`).
fn names(dir: &str, ext: &str) -> Vec<String> {
    let mut out: Vec<String> = fs::read_dir(root().join(dir))
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|f| f.ends_with(ext) && !f.ends_with(&format!(".out{ext}")))
                .map(|f| f[..f.len() - ext.len()].to_string())
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// A file's text: the value and one final newline (nothing for an empty value).
fn file(s: &str) -> String {
    if s.is_empty() { String::new() } else { format!("{s}\n") }
}

/// The first differing line of two texts, for a readable failure.
fn diff(expected: &str, actual: &str) -> String {
    let e: Vec<&str> = expected.split('\n').collect();
    let a: Vec<&str> = actual.split('\n').collect();
    for i in 0..e.len().max(a.len()) {
        if e.get(i) != a.get(i) {
            return format!("line {}: expected {:?}, got {:?}", i + 1, e.get(i), a.get(i));
        }
    }
    "equal".into()
}

fn json_text(v: &Value) -> String {
    format!("{}\n", serde_json::to_string_pretty(v).unwrap_or_default())
}

#[test]
fn md_fixtures() {
    let mut failures = Vec::new();
    let names = names("md", ".md");
    assert!(names.len() >= 60, "md fixtures not found under {}", root().display());
    for name in &names {
        let base = root().join("md").join(name);
        let md = read(&base.with_extension("md"));
        let doc = markdown_to_doc(&md, &mut SeqIds(1));
        let expected: Value = serde_json::from_str(&read(&base.with_extension("json"))).unwrap();
        if doc != expected {
            failures.push(format!("{name}.json: {}", diff(&json_text(&expected), &json_text(&doc))));
        } else if json_text(&doc) != read(&base.with_extension("json")) {
            failures.push(format!("{name}.json: same value, different text (key order)"));
        }
        let out = doc_to_markdown(&expected);
        let want = read(&root().join("md").join(format!("{name}.out.md")));
        if file(&out) != want {
            failures.push(format!("{name}.out.md: {}", diff(&want, &file(&out))));
        }
        let txt = doc_to_text(&expected);
        let want = read(&base.with_extension("txt"));
        if file(&txt) != want {
            failures.push(format!("{name}.txt: {}", diff(&want, &file(&txt))));
        }
    }
    assert!(failures.is_empty(), "{} of {} md fixtures differ:\n{}", failures.len(), names.len(), failures.join("\n"));
}

#[test]
fn json_fixtures() {
    let mut failures = Vec::new();
    let names = names("json", ".json");
    assert!(names.len() >= 11, "json fixtures not found");
    for name in &names {
        let base = root().join("json").join(name);
        let doc: Value = serde_json::from_str(&read(&base.with_extension("json"))).unwrap();
        if let Err(e) = validate(&doc) {
            failures.push(format!("{name}.json invalid: {e}"));
        }
        let out = doc_to_markdown(&doc);
        let want = read(&root().join("json").join(format!("{name}.out.md")));
        if file(&out) != want {
            failures.push(format!("{name}.out.md: {}", diff(&want, &file(&out))));
        }
        let txt = doc_to_text(&doc);
        let want = read(&base.with_extension("txt"));
        if file(&txt) != want {
            failures.push(format!("{name}.txt: {}", diff(&want, &file(&txt))));
        }
    }
    assert!(failures.is_empty(), "{} json fixtures differ:\n{}", failures.len(), failures.join("\n"));
}

/// Every md fixture page is schema-valid.
#[test]
fn md_fixture_pages_validate() {
    let mut failures = Vec::new();
    for name in names("md", ".md") {
        let doc: Value = serde_json::from_str(&read(&root().join("md").join(format!("{name}.json")))).unwrap();
        if let Err(e) = validate(&doc) {
            failures.push(format!("{name}: {e}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The annotated fixtures: `<name>.md` is the annotated form of the page `md/<name>.json` or `json/<name>.json`;
/// reading it gives that page, and writing the page gives it.
#[test]
fn annotated_fixtures() {
    let mut failures = Vec::new();
    let names = names("annotated", ".md");
    assert!(names.len() >= 21, "annotated fixtures missing ({} found)", names.len());
    for name in &names {
        let page_path = ["json", "md"]
            .iter()
            .map(|d| root().join(d).join(format!("{name}.json")))
            .find(|p| p.exists())
            .unwrap_or_else(|| panic!("no page for annotated fixture {name}"));
        let page: Value = serde_json::from_str(&read(&page_path)).unwrap();
        let annotated = read(&root().join("annotated").join(format!("{name}.md")));
        let written = doc_to_annotated(&page);
        if file(&written) != annotated {
            failures.push(format!("{name}: written: {}", diff(&annotated, &file(&written))));
        }
        match annotated_to_doc(&annotated, Some(&page), &mut SeqIds(0xe00000)) {
            Ok(doc) if doc == page => {}
            Ok(doc) => failures.push(format!("{name}: read: {}", diff(&json_text(&page), &json_text(&doc)))),
            Err(e) => failures.push(format!("{name}: read: {e}")),
        }
    }
    assert!(failures.is_empty(), "{} annotated fixtures differ:\n{}", failures.len(), failures.join("\n"));
}

/// doc → annotated → doc gives the same page (ids and attributes included) for every fixture page.
#[test]
fn annotated_round_trip_every_fixture_page() {
    let mut failures = Vec::new();
    let mut count = 0;
    for dir in ["md", "json"] {
        for name in names(dir, ".json") {
            let page: Value = serde_json::from_str(&read(&root().join(dir).join(format!("{name}.json")))).unwrap();
            count += 1;
            let annotated = doc_to_annotated(&page);
            match annotated_to_doc(&annotated, Some(&page), &mut SeqIds(0xe00000)) {
                Ok(doc) if doc == page => {}
                Ok(doc) => failures.push(format!("{dir}/{name}: {}", diff(&json_text(&page), &json_text(&doc)))),
                Err(e) => failures.push(format!("{dir}/{name}: {e}")),
            }
            // and without the page it came from (only placeholders need it)
            if !annotated.contains("<!-- #b-") {
                failures.push(format!("{dir}/{name}: no markers"));
            }
        }
    }
    assert!(count >= 77);
    assert!(failures.is_empty(), "{} pages do not round-trip:\n{}", failures.len(), failures.join("\n"));
}
