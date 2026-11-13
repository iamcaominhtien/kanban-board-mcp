//! `mimetypes.guess_type` of Python on its built-in tables: what Starlette's `FileResponse` sends as the content type
//! when a route gives none (the built UI's files). The tables are exported from Python by
//! `contract/golden/gen_mimetypes.py`; the files of the machine (`/etc/mime.types`, the Windows registry) that Python
//! also reads are not used.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde_json::Value;

struct Tables {
    suffix_map: HashMap<String, String>,
    encodings_map: HashMap<String, String>,
    types_map: HashMap<String, String>,
}

fn table(data: &Value, key: &str) -> HashMap<String, String> {
    data.get(key)
        .and_then(Value::as_object)
        .map(|map| map.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect())
        .unwrap_or_default()
}

static TABLES: LazyLock<Tables> = LazyLock::new(|| {
    let data: Value = serde_json::from_str(include_str!("../../../contract/golden/mimetypes.json")).unwrap_or_default();
    Tables {
        suffix_map: table(&data, "suffix_map"),
        encodings_map: table(&data, "encodings_map"),
        types_map: table(&data, "types_map"),
    }
});

/// `posixpath.splitext`: the extension (with its dot) of the last part, leading dots of the name ignored.
fn splitext(path: &str) -> (&str, &str) {
    let sep = path.rfind('/');
    let Some(dot) = path.rfind('.') else { return (path, "") };
    if sep.is_some_and(|s| dot < s) {
        return (path, "");
    }
    let start = sep.map_or(0, |s| s + 1);
    if path[start..dot].chars().any(|c| c != '.') { (&path[..dot], &path[dot..]) } else { (path, "") }
}

/// `mimetypes.guess_type(path)[0]`: the type of a file name or path, `None` when the extension is unknown.
pub fn guess_type(path: &str) -> Option<&'static str> {
    let tables: &'static Tables = &TABLES;
    let (base, ext) = splitext(path);
    let (mut base, mut ext) = (base.to_string(), ext.to_string());
    // '.tgz' is '.tar.gz', and so on
    while let Some(replacement) = tables.suffix_map.get(&ext.to_lowercase()) {
        let joined = format!("{base}{replacement}");
        let (b, e) = splitext(&joined);
        (base, ext) = (b.to_string(), e.to_string());
    }
    // an encoding suffix ('.gz') is looked through to the type underneath
    if tables.encodings_map.contains_key(&ext) {
        let (_, e) = splitext(&base);
        ext = e.to_string();
    }
    tables.types_map.get(&ext.to_lowercase()).map(String::as_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guesses_what_python_guesses() {
        let data: Value = serde_json::from_str(include_str!("../../../contract/golden/mimetypes.json")).expect("json");
        for (name, expected) in data["samples"].as_object().expect("samples") {
            assert_eq!(guess_type(name), expected.as_str(), "{name}");
        }
        for (ext, kind) in data["types_map"].as_object().expect("types") {
            assert_eq!(guess_type(&format!("file{ext}")), kind.as_str(), "{ext}");
        }
    }
}
