//! The embedded skill folders: what `Path.rglob`, `sorted` and `read_text` give on the Python side.

use kb_files::pathlib;

use crate::asset_index::FILES;

/// Every embedded file under `folder` (a name below `assets/`), as (path below `folder`, bytes), in the order
/// Python's `sorted(root.rglob("*"))` lists files: paths compare component by component, not as text, so
/// `a/b.txt` comes before `a.txt`.
pub fn folder_files(folder: &str) -> Vec<(&'static str, &'static [u8])> {
    let prefix = format!("{folder}/");
    let mut found: Vec<(&'static str, &'static [u8])> =
        FILES.iter().filter_map(|(path, bytes)| path.strip_prefix(prefix.as_str()).map(|rel| (rel, *bytes))).collect();
    found.sort_by(|a, b| a.0.split('/').cmp(b.0.split('/')));
    found
}

/// One embedded file by its path below `folder`.
pub fn file(folder: &str, rel: &str) -> Option<&'static [u8]> {
    let path = format!("{folder}/{rel}");
    FILES.iter().find(|(name, _)| *name == path).map(|(_, bytes)| *bytes)
}

/// `Path.read_text(encoding="utf-8")`: UTF-8, and `\r\n` or `\r` read as `\n` (text mode translates them).
pub fn decode_text(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    if text.contains('\r') { text.replace("\r\n", "\n").replace('\r', "\n") } else { text.into_owned() }
}

/// `read_text` of an embedded file; `None` where Python raises `FileNotFoundError`.
pub fn read_text(folder: &str, rel: &str) -> Option<String> {
    file(folder, rel).map(decode_text)
}

/// `Path.suffix` of a file path.
pub(crate) fn suffix(rel: &str) -> &str {
    pathlib::suffix_of_name(pathlib::name(rel))
}

/// `services/design_examples/`: the exemplar design boards (two HTML files with their screenshots) that the design
/// guide and the `canvas-design` skill carry. `kb-draw` holds a copy of the same files for its own use.
pub mod design_examples {
    /// Every file, by name, in listing order.
    pub fn files() -> Vec<(&'static str, &'static [u8])> {
        super::folder_files("design_examples")
    }
}

/// `services/office_examples/`: a python-pptx sample deck builder that a run copies and adapts (the office-files
/// skill points at it).
pub mod office_examples {
    /// `deck_example.py`.
    pub fn deck_example() -> &'static [u8] {
        super::file("office_examples", "deck_example.py").unwrap_or_default()
    }
}
