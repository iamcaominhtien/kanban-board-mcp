//! A request script that records what the server answers, to compare with `contract/golden/idea_routes.json`, the
//! answers of the Python server (written with `KANBAN_WRITE_GOLDEN=1 PARITY_TARGET=python`). Ids and times are
//! normalized; the 422 of a validation keeps the place of the error (Pydantic's words are not the contract).
#![allow(dead_code)]

use std::sync::Mutex;

use serde_json::{Value, json};
use testkit::{Client, Resp, Target, normalize, target};

/// The golden file is shared by the tests of this crate: one of them reads or writes it at a time.
static GOLDEN_FILE: Mutex<()> = Mutex::new(());

const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../contract/golden/idea_routes.json");

/// What a script has asked and been answered, in order.
#[derive(Default)]
pub struct Script {
    pub log: Vec<Value>,
}

impl Script {
    /// One request: `body` is JSON. Records the request, the status and the answer, and gives the answer back.
    pub async fn call(&mut self, c: &Client, method: &str, path: &str, body: Option<Value>) -> Resp {
        self.call_as(c, None, method, path, body).await
    }

    /// `call` with the actor header.
    pub async fn call_as(
        &mut self,
        c: &Client,
        actor: Option<&str>,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Resp {
        let mut headers: Vec<(&str, &str)> = Vec::new();
        if let Some(actor) = actor {
            headers.push(("x-actor", actor));
        }
        let bytes = body.as_ref().map(|b| {
            headers.push(("content-type", "application/json"));
            serde_json::to_vec(b).expect("json")
        });
        let response = c.request(method, path, &headers, bytes).await;
        self.record(method, path, actor, body.as_ref(), &response);
        response
    }

    pub async fn get(&mut self, c: &Client, path: &str) -> Resp {
        self.call(c, "GET", path, None).await
    }

    pub async fn post(&mut self, c: &Client, path: &str, body: Value) -> Resp {
        self.call(c, "POST", path, Some(body)).await
    }

    pub async fn patch(&mut self, c: &Client, path: &str, body: Value) -> Resp {
        self.call(c, "PATCH", path, Some(body)).await
    }

    pub async fn put(&mut self, c: &Client, path: &str, body: Value) -> Resp {
        self.call(c, "PUT", path, Some(body)).await
    }

    pub async fn delete(&mut self, c: &Client, path: &str) -> Resp {
        self.call(c, "DELETE", path, None).await
    }

    fn record(&mut self, method: &str, path: &str, actor: Option<&str>, body: Option<&Value>, r: &Resp) {
        let answer = match serde_json::from_slice::<Value>(&r.body) {
            // (the index page, on a machine with a built UI: see `Resp::is_ui_index`)
            _ if r.is_ui_index() => json!("<the UI route>"),
            Ok(value) if r.status == 422 => {
                // the place of each error, not Pydantic's words
                // (up to the field: Pydantic names the item of a list and the key of an object inside it, the
                // foundation's errors the field; and FastAPI lists every field in error, the foundation's the first)
                let places: Vec<Value> = value["detail"]
                    .as_array()
                    .map(|errors| {
                        errors
                            .iter()
                            .map(|e| {
                                let loc = e["loc"].as_array().cloned().unwrap_or_default();
                                let keep = loc.len().min(2);
                                Value::Array(loc.into_iter().take(keep).collect())
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                // (FastAPI lists every field that is missing; the foundation's body errors name the first)
                let places: Vec<Value> = places.into_iter().take(1).collect();
                json!({"detail_loc": places})
            }
            // a GET that no route of the idea routers serves goes on to the UI route of the app (see
            // `kb_ideas::api`): 404 "UI not built" where the UI is not built, whatever the app says otherwise
            Ok(value)
                if method == "GET"
                    && r.status == 404
                    && (value["detail"] == "UI not built" || value["detail"] == "Not Found") =>
            {
                json!("<the UI route>")
            }
            Ok(value) => normalize(&value),
            Err(_) => json!(String::from_utf8_lossy(&r.body)),
        };
        let mut entry = serde_json::Map::new();
        let who = actor.map(|a| format!(" as {a}")).unwrap_or_default();
        let sent = body.map(|b| format!(" {}", kb_base::pyjson::dumps(b))).unwrap_or_default();
        entry.insert("request".into(), json!(format!("{method} {path}{who}{sent}")));
        entry.insert("status".into(), json!(if r.is_ui_index() { 404 } else { r.status }));
        if r.status == 405 {
            let allow = r.headers.get("allow").and_then(|v| v.to_str().ok()).unwrap_or("");
            entry.insert("allow".into(), json!(allow));
        }
        entry.insert("answer".into(), answer);
        self.log.push(normalize(&Value::Object(entry)));
    }

    /// `check`, and when it fails, the end of the server's log first (a 500 says nothing on its own).
    pub fn check_dumping_the_log(&self, key: &str, server: &testkit::Server) {
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.check(key)));
        if let Err(failure) = outcome {
            for entry in std::fs::read_dir(server.log_dir()).into_iter().flatten().flatten() {
                let text = std::fs::read_to_string(entry.path()).unwrap_or_default();
                let lines: Vec<&str> = text.lines().filter(|l| l.contains("ERROR")).collect();
                let tail = &lines[lines.len().saturating_sub(12)..];
                eprintln!("SERVER LOG {}:\n{}", entry.path().display(), tail.join("\n"));
            }
            std::panic::resume_unwind(failure);
        }
    }

    /// Compare the recorded answers with the part of the golden file under `key`, after writing it when the golden
    /// file is being written (`KANBAN_WRITE_GOLDEN=1`, Python only).
    pub fn check(&self, key: &str) {
        let _one_at_a_time = GOLDEN_FILE.lock().unwrap_or_else(|e| e.into_inner());
        let read = || -> Value {
            match std::fs::read_to_string(GOLDEN) {
                Ok(text) => serde_json::from_str(&text).expect("golden file parses"),
                Err(_) => json!({}),
            }
        };
        if std::env::var("KANBAN_WRITE_GOLDEN").is_ok_and(|v| v == "1") {
            assert_eq!(target(), Target::Python, "the golden file is what the Python server answers");
            let mut golden = read();
            golden[key] = Value::Array(self.log.clone());
            std::fs::write(GOLDEN, serde_json::to_string_pretty(&golden).expect("json") + "\n").expect("write golden");
        }
        let golden = read();
        let expected = golden[key].as_array().unwrap_or_else(|| panic!("golden file has no {key}")).clone();
        for (at, (got, want)) in self.log.iter().zip(&expected).enumerate() {
            assert_eq!(got, want, "{key} #{at}: {}", want["request"]);
        }
        assert_eq!(self.log.len(), expected.len(), "{key}: the number of requests");
    }
}
