//! The recorded answers of a route test: each answer is noted under a label as status and JSON with ids, times and
//! folders normalized, and compared with `contract/golden/<dir>/<test>.json` (recorded from the Python server with
//! `AI_ROUTES_RECORD=1 PARITY_TARGET=python`).
#![allow(dead_code)]

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::{Captures, Regex};
use serde_json::{Map, Value, json};
use testkit::{Resp, normalize, target};

/// The recorded answers of one test, and what this run answers.
pub struct Rec {
    path: PathBuf,
    golden: Map<String, Value>,
    got: BTreeMap<String, Value>,
    record: bool,
    roots: Vec<String>,
    ignored: Vec<String>,
}

impl Rec {
    /// `dir`: the folder of `contract/golden`; `roots`: folders of the test, named `<tmp>` in the answers.
    pub fn new(dir: &str, name: &str, roots: &[&Path]) -> Rec {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../contract/golden")
            .join(dir)
            .join(format!("{name}.json"));
        let record = std::env::var("AI_ROUTES_RECORD").is_ok_and(|v| v == "1");
        if record {
            assert_eq!(format!("{:?}", target()), "Python", "record from the Python server");
        }
        let golden = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<Map<String, Value>>(&text).expect("golden file parses"),
            Err(_) if record => Map::new(),
            Err(e) => panic!("{}: {e} (record it with AI_ROUTES_RECORD=1 PARITY_TARGET=python)", path.display()),
        };
        let mut all: Vec<String> = Vec::new();
        for root in roots {
            all.push(root.to_string_lossy().into_owned());
            if let Ok(real) = root.canonicalize() {
                all.push(real.to_string_lossy().into_owned());
            }
        }
        all.sort_by_key(|r| std::cmp::Reverse(r.len()));
        all.dedup();
        Rec { path, golden, got: BTreeMap::new(), record, roots: all, ignored: Vec::new() }
    }

    /// Leave out of every answer from now on the keys that hold a measurement, not behavior (a pid, a memory reading).
    pub fn ignore(&mut self, keys: &[&str]) {
        self.ignored.extend(keys.iter().map(|k| k.to_string()));
    }

    /// `check` with some keys left out of this answer only.
    pub fn check_hiding(&mut self, label: &str, r: &Resp, keys: &[&str]) {
        let before = self.ignored.len();
        self.ignore(keys);
        self.check(label, r);
        self.ignored.truncate(before);
    }

    fn without_ignored(&self, value: &Value) -> Value {
        match value {
            Value::Object(m) => Value::Object(
                m.iter()
                    .filter(|(k, _)| !self.ignored.contains(k))
                    .map(|(k, v)| (k.clone(), self.without_ignored(v)))
                    .collect(),
            ),
            Value::Array(a) => Value::Array(a.iter().map(|v| self.without_ignored(v)).collect()),
            other => other.clone(),
        }
    }

    fn clean(&self, text: &str) -> String {
        let mut text = text.to_string();
        for root in &self.roots {
            text = text.replace(root.as_str(), "<tmp>");
        }
        text
    }

    /// Note the answer under `label`.
    pub fn check(&mut self, label: &str, r: &Resp) {
        if r.is_ui_index() {
            // a GET no route serves, on a machine with a built UI: recorded as on a machine without one
            let entry = json!({"status": 404, "json": {"detail": "UI not built"}});
            assert!(self.got.insert(label.to_string(), entry).is_none(), "label {label} twice");
            return;
        }
        let mut entry = Map::new();
        entry.insert("status".into(), json!(r.status));
        let text = self.clean(&r.text());
        match serde_json::from_str::<Value>(&text) {
            Ok(body) if r.status == 422 && body["detail"].is_array() => {
                // the wording of a validation message is Pydantic's: the field is compared
                let locs: Vec<Value> =
                    body["detail"].as_array().expect("detail").iter().map(|d| d["loc"].clone()).collect();
                entry.insert("json".into(), json!({"loc": locs}));
            }
            Ok(body) => {
                entry.insert("json".into(), tidy(&self.without_ignored(&body)));
            }
            Err(_) => {
                entry.insert("text".into(), json!(text));
            }
        }
        assert!(self.got.insert(label.to_string(), Value::Object(entry)).is_none(), "label {label} twice");
    }

    /// Note a value that is not an answer (a row of the database, a file's content).
    pub fn note(&mut self, label: &str, value: Value) {
        let value = serde_json::from_str::<Value>(&self.clean(&value.to_string())).unwrap_or(value);
        assert!(self.got.insert(label.to_string(), json!({"note": tidy(&value)})).is_none(), "label {label} twice");
    }

    /// Compare with the recorded answers (or record them).
    pub fn finish(self) {
        if self.record {
            let all: Map<String, Value> = self.got.into_iter().collect();
            std::fs::create_dir_all(self.path.parent().expect("folder")).expect("mkdir");
            let mut text = serde_json::to_string_pretty(&Value::Object(all)).expect("json");
            text.push('\n');
            std::fs::write(&self.path, text).expect("write the golden file");
            return;
        }
        let mut bad = Vec::new();
        for (label, got) in &self.got {
            match self.golden.get(label) {
                Some(want) if want == got => {}
                Some(want) => bad.push(format!("{label}\n  want {want}\n  got  {got}")),
                None => bad.push(format!("{label}: not recorded")),
            }
        }
        for label in self.golden.keys() {
            if !self.got.contains_key(label) {
                bad.push(format!("{label}: recorded but not asked"));
            }
        }
        assert!(bad.is_empty(), "{} differences:\n{}", bad.len(), bad.join("\n"));
    }
}

fn prefixed_id() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"\b([a-z]{2,5})_([0-9a-f]{8,})\b").expect("static regex"))
}

/// Keys in order, ids of the form `acct_1a2b3c4d5e` numbered by first appearance, then uuids, times and ports (the
/// `testkit` normalizer).
pub fn tidy(value: &Value) -> Value {
    fn sorted(v: &Value) -> Value {
        match v {
            Value::Object(m) => {
                let mut keys: Vec<&String> = m.keys().collect();
                keys.sort();
                let mut out = Map::new();
                for k in keys {
                    out.insert(k.clone(), sorted(&m[k]));
                }
                Value::Object(out)
            }
            Value::Array(a) => Value::Array(a.iter().map(sorted).collect()),
            other => other.clone(),
        }
    }
    fn rename(s: &str, seen: &mut HashMap<String, usize>) -> String {
        prefixed_id()
            .replace_all(s, |c: &Captures| {
                let next = seen.len() + 1;
                let n = *seen.entry(c[0].to_string()).or_insert(next);
                format!("<{}:{n}>", &c[1])
            })
            .into_owned()
    }
    fn numbered(v: &Value, seen: &mut HashMap<String, usize>) -> Value {
        match v {
            Value::String(s) => Value::String(rename(s, seen)),
            Value::Array(a) => Value::Array(a.iter().map(|x| numbered(x, seen)).collect()),
            Value::Object(m) => {
                let mut out = Map::new();
                for (k, x) in m {
                    out.insert(rename(k, seen), numbered(x, seen));
                }
                Value::Object(out)
            }
            other => other.clone(),
        }
    }
    normalize(&numbered(&sorted(value), &mut HashMap::new()))
}
