//! One check per route of the first AI routers (`api/ai_accounts.py`, `api/ai_knowledge.py`, `api/ai_power.py`): the
//! answer of each route, for the success case and for each error branch, as status and JSON with ids, times and paths
//! normalized, must be what the Python server answers. The expected answers are recorded from the Python server in
//! `contract/golden/ai_routes/<test>.json` and compared on both targets:
//!
//! `AI_ROUTES_RECORD=1 PARITY_TARGET=python cargo test -p kb-ai-api --test ai_routes`
//!
//! A 422 for a body or query the server cannot read is compared by its status and the location of the field (the
//! wording is Pydantic's). The stand-in CLI answers for `claude` (see `tests/common`); a team, a run, a lesson are
//! rows added to the database.

mod common;

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::OnceLock;

use common::{Fixture, NOW, Refused, account, insert, login, project, run, scalar, start, team_as, terminal, ticket};
use regex::{Captures, Regex};
use serde_json::{Map, Value, json};
use testkit::{Resp, normalize, target};

/// The recorded answers of one test, and what this run answers.
struct Rec {
    path: PathBuf,
    golden: Map<String, Value>,
    got: BTreeMap<String, Value>,
    record: bool,
    roots: Vec<String>,
}

impl Rec {
    fn new(name: &str, f: &Fixture) -> Rec {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../contract/golden/ai_routes")
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
        let mut roots = vec![f.accounts.to_string_lossy().into_owned()];
        if let Ok(real) = f.accounts.canonicalize() {
            roots.push(real.to_string_lossy().into_owned());
        }
        roots.sort_by_key(|r| std::cmp::Reverse(r.len()));
        roots.dedup();
        Rec { path, golden, got: BTreeMap::new(), record, roots }
    }

    /// Note the answer under `label`.
    fn check(&mut self, label: &str, r: &Resp) {
        if r.is_ui_index() {
            // a GET no route serves, on a machine with a built UI: recorded as on a machine without one
            let entry = json!({"status": 404, "json": {"detail": "UI not built"}});
            assert!(self.got.insert(label.to_string(), entry).is_none(), "label {label} twice");
            return;
        }
        let mut entry = Map::new();
        entry.insert("status".into(), json!(r.status));
        let mut text = r.text();
        for root in &self.roots {
            text = text.replace(root.as_str(), "<accounts>");
        }
        match serde_json::from_str::<Value>(&text) {
            Ok(body) if r.status == 422 && body["detail"].is_array() => {
                // the wording of a validation message is Pydantic's: the field is compared
                let locs: Vec<Value> =
                    body["detail"].as_array().expect("detail").iter().map(|d| d["loc"].clone()).collect();
                entry.insert("json".into(), json!({"loc": locs}));
            }
            Ok(body) => {
                entry.insert("json".into(), tidy(&body));
            }
            Err(_) => {
                entry.insert("text".into(), json!(text));
            }
        }
        assert!(self.got.insert(label.to_string(), Value::Object(entry)).is_none(), "label {label} twice");
    }

    /// Note a value that is not an answer (a row of the database, what a handshake said).
    fn note(&mut self, label: &str, value: Value) {
        assert!(self.got.insert(label.to_string(), json!({"note": tidy(&value)})).is_none(), "label {label} twice");
    }

    /// Compare with the recorded answers (or record them).
    fn finish(self) {
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
/// `testkit` normalizer); the version of a CLI is read in the background and may or may not be known yet.
fn tidy(value: &Value) -> Value {
    fn sorted(v: &Value) -> Value {
        match v {
            Value::Object(m) => {
                let mut keys: Vec<&String> = m.keys().collect();
                keys.sort();
                let mut out = Map::new();
                for k in keys {
                    if k == "version" && m.contains_key("blurb") {
                        out.insert(k.clone(), Value::Null);
                    } else {
                        out.insert(k.clone(), sorted(&m[k]));
                    }
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
                    let key = rename(k, seen);
                    out.insert(key, numbered(x, seen));
                }
                Value::Object(out)
            }
            other => other.clone(),
        }
    }
    normalize(&numbered(&sorted(value), &mut HashMap::new()))
}

fn aid(a: &Value) -> String {
    a["id"].as_str().expect("id").to_string()
}

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------

#[tokio::test]
async fn account_routes() {
    let name = "account_routes";
    let Some(f) = start(name, true, &[]).await else { return };
    let c = &f.c;
    let mut rec = Rec::new(name, &f);
    rec.check("GET /ai/accounts: none", &c.get("/ai/accounts").await);
    rec.check("GET /ai/accounts: project_id", &c.get("/ai/accounts?project_id=nope").await);
    rec.check("GET /ai/accounts: DELETE is not served", &c.delete("/ai/accounts").await);
    // name-check
    rec.check("name-check: no name", &c.get("/ai/accounts/name-check").await);
    rec.check("name-check: blank", &c.get_query("/ai/accounts/name-check", &[("name", "   ")]).await);
    rec.check("name-check: free", &c.get_query("/ai/accounts/name-check", &[("name", "  Work   Claude ")]).await);
    // create
    let url = "/ai/accounts";
    let made = c.post(url, json!({"name": "Work Claude", "cli": "claude"})).await;
    rec.check("create", &made);
    let a = made.json();
    let id = aid(&a);
    rec.check("create: same name", &c.post(url, json!({"name": "Work Claude", "cli": "claude"})).await);
    rec.check("create: same name in other case", &c.post(url, json!({"name": "work claude", "cli": "claude"})).await);
    rec.check("create: blank name", &c.post(url, json!({"name": "  ", "cli": "claude"})).await);
    rec.check("create: name too long", &c.post(url, json!({"name": "n".repeat(61), "cli": "claude"})).await);
    rec.check("create: sixty characters", &c.post(url, json!({"name": "é".repeat(60), "cli": "claude"})).await);
    rec.check("create: no cli", &c.post(url, json!({"name": "No CLI"})).await);
    rec.check("create: null cli", &c.post(url, json!({"name": "No CLI", "cli": null})).await);
    rec.check("create: other cli", &c.post(url, json!({"name": "Codex", "cli": "codex"})).await);
    rec.check("create: unknown cli", &c.post(url, json!({"name": "Vim", "cli": "vim"})).await);
    rec.check("create: empty body", &c.post(url, json!({})).await);
    rec.check("create: name not text", &c.post(url, json!({"name": 5, "cli": "claude"})).await);
    rec.check("create: slash in the name", &c.post(url, json!({"name": "a/b", "cli": "claude"})).await);
    rec.check("create: same folder name", &c.post(url, json!({"name": "work-claude", "cli": "claude"})).await);
    rec.check("create: dots", &c.post(url, json!({"name": "..", "cli": "claude"})).await);
    // name-check with accounts
    rec.check("name-check: taken", &c.get_query("/ai/accounts/name-check", &[("name", "WORK claude")]).await);
    rec.check("name-check: free again", &c.get_query("/ai/accounts/name-check", &[("name", "Other")]).await);
    // one account
    rec.check("GET one", &c.get(&format!("/ai/accounts/{id}")).await);
    rec.check("GET one: unknown", &c.get("/ai/accounts/nope").await);
    // rename
    rec.check("rename", &c.patch(&format!("/ai/accounts/{id}"), json!({"name": "Main"})).await);
    rec.check("rename: same name", &c.patch(&format!("/ai/accounts/{id}"), json!({"name": "main"})).await);
    rec.check("rename: blank", &c.patch(&format!("/ai/accounts/{id}"), json!({"name": " "})).await);
    rec.check("rename: unknown", &c.patch("/ai/accounts/nope", json!({"name": "x"})).await);
    rec.check("rename: no name", &c.patch(&format!("/ai/accounts/{id}"), json!({})).await);
    let second = c.post(url, json!({"name": "Second", "cli": "claude"})).await;
    rec.check("create: second", &second);
    let second_id = aid(&second.json());
    rec.check(
        "rename: taken by another",
        &c.patch(&format!("/ai/accounts/{second_id}"), json!({"name": "MAIN"})).await,
    );
    // check
    rec.check("check: not signed in", &c.post_empty(&format!("/ai/accounts/{id}/check")).await);
    rec.check("check: unknown", &c.post_empty("/ai/accounts/nope/check").await);
    login(&a, "an@work.example");
    rec.check("check: signed in", &c.post_empty(&format!("/ai/accounts/{id}/check")).await);
    rec.check("GET /ai/accounts: two", &c.get("/ai/accounts").await);
    // sign out
    rec.check("sign-out", &c.post_empty(&format!("/ai/accounts/{id}/sign-out")).await);
    rec.check("sign-out: again", &c.post_empty(&format!("/ai/accounts/{id}/sign-out")).await);
    rec.check("sign-out: unknown", &c.post_empty("/ai/accounts/nope/sign-out").await);
    rec.note(
        "the login file is gone",
        json!(!std::path::Path::new(a["folder"].as_str().expect("folder")).join(".fake-login").exists()),
    );
    // the logins on this computer
    rec.check("on this computer: nobody", &c.get("/ai/accounts-on-this-computer").await);
    std::fs::write(f.claude.join(".fake-login"), "me@home.example").expect("login");
    rec.check("on this computer: signed in", &c.get("/ai/accounts-on-this-computer").await);
    // members of an account
    let (pid, _) = project(c).await;
    team_as(&f.server, &pid, "Backend", "mem_backend0001", json!({"account_id": id})).await;
    team_as(&f.server, &pid, "Frontend", "mem_frontend001", json!({"account_id": id})).await;
    let (other_pid, _) = {
        let r = c.post("/projects", json!({"name": "Other", "prefix": "OTH", "color": "#123456"})).await;
        (common::id(&r.json()), ())
    };
    team_as(&f.server, &other_pid, "Elsewhere", "mem_elsewhere01", json!({"account_id": id})).await;
    rec.check("GET /ai/accounts: members here and elsewhere", &c.get(&format!("/ai/accounts?project_id={pid}")).await);
    rec.check("GET /ai/accounts: members, no project", &c.get("/ai/accounts").await);
    rec.check("GET one: with members", &c.get(&format!("/ai/accounts/{id}")).await);
    // remove
    let del = format!("/ai/accounts/{id}");
    rec.check("remove: unknown", &c.delete("/ai/accounts/nope").await);
    rec.check("remove: bad members", &c.delete(&format!("{del}?members=all")).await);
    rec.check("remove: other, no other_id", &c.delete(&format!("{del}?members=other")).await);
    rec.check("remove: other, itself", &c.delete(&format!("{del}?members=other&other_id={id}")).await);
    rec.check("remove: other, unknown", &c.delete(&format!("{del}?members=other&other_id=nope")).await);
    rec.note("nothing was removed", json!(std::path::Path::new(a["folder"].as_str().expect("folder")).exists()));
    rec.check("remove: to another account", &c.delete(&format!("{del}?members=other&other_id={second_id}")).await);
    rec.note(
        "members moved to the other account",
        scalar(
            &f.server,
            "SELECT group_concat(id || ':' || COALESCE(account_id, '-'), ',') FROM (SELECT * FROM ai_team ORDER BY id)",
            &[],
        )
        .await,
    );
    let third = c.post(url, json!({"name": "Third", "cli": "claude"})).await;
    let third_id = aid(&third.json());
    team_as(&f.server, &pid, "Third team", "mem_third000001", json!({"account_id": third_id})).await;
    rec.check("remove: pause the members", &c.delete(&format!("/ai/accounts/{third_id}?members=none")).await);
    rec.note(
        "the member is paused",
        scalar(&f.server, "SELECT paused || '|' || COALESCE(account_id, '-') || '|' || COALESCE(paused_reason, '') FROM ai_team WHERE id = ?", &[json!("mem_third000001")]).await,
    );
    let fourth = c.post(url, json!({"name": "Fourth", "cli": "claude"})).await;
    let fourth_id = aid(&fourth.json());
    team_as(&f.server, &pid, "Fourth team", "mem_fourth00001", json!({"account_id": fourth_id})).await;
    rec.check("remove: members to the login of this computer", &c.delete(&format!("/ai/accounts/{fourth_id}")).await);
    rec.check("remove: no members", &c.delete(&format!("/ai/accounts/{second_id}")).await);
    rec.check("remove: again", &c.delete(&format!("/ai/accounts/{second_id}")).await);
    rec.check("GET /ai/accounts: after", &c.get("/ai/accounts").await);
    rec.finish();
}

#[tokio::test]
async fn who_can_change_accounts() {
    let name = "who_can_change_accounts";
    let Some(f) = start(name, true, &[]).await else { return };
    let c = &f.c;
    let mut rec = Rec::new(name, &f);
    let a = account(c, "Work Claude").await;
    let id = aid(&a);
    // the address of the client is taken from X-Forwarded-For, as uvicorn does for a proxy on this computer
    for forwarded in [
        "203.0.113.9",
        "127.0.0.1, 203.0.113.9",
        "203.0.113.9, 127.0.0.1",
        "127.0.0.1",
        "127.0.0.1, 127.0.0.1",
        "::1",
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1",
        "localhost",
        "unknown",
        "   ",
        ",",
        "10.0.0.5,",
    ] {
        let web = c.clone().header("X-Forwarded-For", forwarded);
        rec.check(&format!("[{forwarded}] list"), &web.get("/ai/accounts").await);
        rec.check(&format!("[{forwarded}] check"), &web.post_empty(&format!("/ai/accounts/{id}/check")).await);
    }
    let web = c.clone().header("X-Forwarded-For", "203.0.113.9");
    rec.check("[web] one", &web.get(&format!("/ai/accounts/{id}")).await);
    rec.check("[web] name-check", &web.get("/ai/accounts/name-check?name=x").await);
    rec.check("[web] on this computer", &web.get("/ai/accounts-on-this-computer").await);
    rec.check("[web] create", &web.post("/ai/accounts", json!({"name": "X", "cli": "claude"})).await);
    rec.check("[web] create: bad body is a 422 first", &web.post("/ai/accounts", json!({})).await);
    rec.check("[web] rename", &web.patch(&format!("/ai/accounts/{id}"), json!({"name": "Y"})).await);
    rec.check("[web] rename: unknown", &web.patch("/ai/accounts/nope", json!({"name": "Y"})).await);
    rec.check("[web] check: unknown", &web.post_empty("/ai/accounts/nope/check").await);
    rec.check("[web] sign-out", &web.post_empty(&format!("/ai/accounts/{id}/sign-out")).await);
    rec.check("[web] signin", &web.post_empty(&format!("/ai/accounts/{id}/signin")).await);
    rec.check("[web] stop signin", &web.delete(&format!("/ai/accounts/{id}/signin")).await);
    rec.check("[web] signin done", &web.post_empty(&format!("/ai/accounts/{id}/signin/done")).await);
    rec.check("[web] remove", &web.delete(&format!("/ai/accounts/{id}")).await);
    rec.check("[web] remove: bad members is a 422 first", &web.delete(&format!("/ai/accounts/{id}?members=x")).await);
    rec.check("still there", &c.get("/ai/accounts").await);
    rec.finish();
}

#[tokio::test]
async fn signin_routes() {
    let name = "signin_routes";
    let Some(f) = start(name, true, &[]).await else { return };
    let c = &f.c;
    let mut rec = Rec::new(name, &f);
    let (pid, _) = project(c).await;
    let a = account(c, "Work Claude").await;
    let id = aid(&a);
    team_as(&f.server, &pid, "Backend", "mem_backend0001", json!({"account_id": id})).await;
    team_as(&f.server, &pid, "Frontend", "mem_frontend001", json!({"account_id": id})).await;
    rec.check("signin: unknown", &c.post_empty("/ai/accounts/nope/signin").await);
    rec.check("signin: size not a number", &c.post_empty(&format!("/ai/accounts/{id}/signin?cols=wide")).await);
    rec.check("done: nothing was open", &c.post_empty(&format!("/ai/accounts/{id}/signin/done")).await);
    rec.check("stop: nothing was open", &c.delete(&format!("/ai/accounts/{id}/signin")).await);
    rec.check("signin", &c.post_empty(&format!("/ai/accounts/{id}/signin?cols=100&rows=30")).await);
    rec.check("signin: busy", &c.post_empty(&format!("/ai/accounts/{id}/signin")).await);
    rec.check(
        "signin: busy, by someone",
        &c.clone().header("X-Actor", "Ada").post_empty(&format!("/ai/accounts/{id}/signin")).await,
    );
    rec.check("GET one: signing in", &c.get(&format!("/ai/accounts/{id}")).await);
    rec.check("GET /ai/accounts: signing in", &c.get("/ai/accounts").await);
    rec.check("check while signing in", &c.post_empty(&format!("/ai/accounts/{id}/check")).await);
    rec.check("sign-out while signing in", &c.post_empty(&format!("/ai/accounts/{id}/sign-out")).await);
    rec.check("remove while signing in", &c.delete(&format!("/ai/accounts/{id}")).await);
    rec.note(
        "the sign-in was written to the audit trail of the project",
        scalar(
            &f.server,
            "SELECT group_concat(action || ':' || result || ':' || COALESCE(on_behalf_of, '-') || ':' || detail, '|') FROM (SELECT * FROM ai_audit ORDER BY seq)",
            &[],
        )
        .await,
    );
    // the terminal
    let handshake = |label: &'static str, r: Result<common::Terminal, Refused>| -> (String, Value) {
        match r {
            Ok(_) => (label.to_string(), json!({"handshake": "open"})),
            Err(Refused(code)) => (label.to_string(), json!({"handshake": code})),
        }
    };
    let cases: [(&str, Vec<(&str, &str)>); 9] = [
        ("terminal: no origin", vec![]),
        ("terminal: origin null", vec![("Origin", "null")]),
        ("terminal: origin file", vec![("Origin", "file://")]),
        ("terminal: origin localhost", vec![("Origin", "http://localhost:5173")]),
        ("terminal: origin uppercase host", vec![("Origin", "http://LOCALHOST:5173")]),
        ("terminal: origin loopback address", vec![("Origin", "http://127.0.0.1:8080")]),
        ("terminal: origin another site", vec![("Origin", "https://evil.example")]),
        ("terminal: origin that starts like localhost", vec![("Origin", "http://localhost.evil.example")]),
        ("terminal: origin without a host", vec![("Origin", "localhost:5173")]),
    ];
    for (label, headers) in cases {
        let (label, value) = handshake(label, terminal(&f.server, &id, &headers).await);
        rec.note(&label, value);
    }
    let (label, value) =
        handshake("terminal: another computer", terminal(&f.server, &id, &[("X-Forwarded-For", "10.0.0.5")]).await);
    rec.note(&label, value);
    let (label, value) = handshake("terminal: no sign-in open", terminal(&f.server, "nobody", &[]).await);
    rec.note(&label, value);
    // the window: output so far and the state, then what it sends
    let mut window = terminal(&f.server, &id, &[]).await.expect("the terminal opens");
    let (text, state) = window.drain(common::asks_for_the_code).await;
    rec.note(
        "terminal: first state",
        json!({"url_in_output": text.contains("https://claude.example/oauth/authorize"), "running": state["running"],
               "ended": state["ended"], "signed_in": state["signed_in"], "phase": state["phase"],
               "url": state["url"], "keys": state.as_object().map(|m| { let mut k: Vec<&String> = m.keys().collect(); k.sort(); k })}),
    );
    // what the window sends that the server skips
    window.send_raw("not json").await;
    window.send(json!({"type": "unknown"})).await;
    window.send(json!({"type": "input", "data": 5})).await;
    window.send(json!({"type": "resize", "cols": "x", "rows": 30})).await;
    window.send(json!({"type": "resize", "cols": 120.7, "rows": "40"})).await;
    window.send(json!({"type": "paste", "data": "ba"})).await;
    window.send(json!({"type": "input", "data": "d\n"})).await;
    let (_, state) = window.drain(|m| m["type"] == "state" && m["ended"] == "exited").await;
    rec.note("terminal: a rejected code", json!({"exit_code": state["exit_code"], "signed_in": state["signed_in"]}));
    rec.check("GET one: after a rejected code", &c.get(&format!("/ai/accounts/{id}")).await);
    window.close().await;
    // a second sign-in, stopped
    rec.check("signin: again", &c.post_empty(&format!("/ai/accounts/{id}/signin")).await);
    rec.check("stop", &c.delete(&format!("/ai/accounts/{id}/signin")).await);
    rec.check("stop: again", &c.delete(&format!("/ai/accounts/{id}/signin")).await);
    rec.check("done: after a stop", &c.post_empty(&format!("/ai/accounts/{id}/signin/done")).await);
    // a third one that ends signed in, and "done"
    rec.check("signin: third", &c.post_empty(&format!("/ai/accounts/{id}/signin")).await);
    let mut window = terminal(&f.server, &id, &[]).await.expect("the terminal opens");
    window.drain(common::asks_for_the_code).await;
    window.write("good\n").await;
    let (_, state) = window.drain(common::says_signed_in).await;
    rec.note("terminal: signed in", json!({"status": state["account"]["status"], "email": state["account"]["email"]}));
    common::until(10, async || c.get(&format!("/ai/accounts/{id}")).await.json()["signing_in_by"].is_null()).await;
    rec.check("GET one: signed in", &c.get(&format!("/ai/accounts/{id}")).await);
    rec.check("done: after the login ended", &c.post_empty(&format!("/ai/accounts/{id}/signin/done")).await);
    rec.check("signin: a signed in account", &c.post_empty(&format!("/ai/accounts/{id}/signin")).await);
    rec.check("done: while open", &c.post_empty(&format!("/ai/accounts/{id}/signin/done")).await);
    rec.check("GET one: after done", &c.get(&format!("/ai/accounts/{id}")).await);
    window.close().await;
    rec.finish();
}

#[tokio::test]
async fn logins_on_this_computer() {
    // the stand-in CLI that is signed in as it always is (no per-account logins), then one that is signed out
    for (name, mode) in [("logins_on_this_computer", ""), ("logins_on_this_computer_signed_out", "logged_out")] {
        let extra =
            [("FAKE_CLAUDE_ACCOUNTS", "0"), ("FAKE_CLAUDE_MODE", if mode.is_empty() { "finish" } else { mode })];
        let Some(f) = start(name, true, &extra).await else { return };
        let mut rec = Rec::new(name, &f);
        rec.check("on this computer", &f.c.get("/ai/accounts-on-this-computer").await);
        rec.check(
            "web: on this computer",
            &f.c.clone().header("X-Forwarded-For", "203.0.113.9").get("/ai/accounts-on-this-computer").await,
        );
        rec.finish();
    }
}

#[tokio::test]
async fn accounts_without_a_cli() {
    let name = "accounts_without_a_cli";
    let Some(f) = start(name, false, &[]).await else { return };
    let c = &f.c;
    let mut rec = Rec::new(name, &f);
    rec.check("create: the CLI is missing", &c.post("/ai/accounts", json!({"name": "Work", "cli": "claude"})).await);
    rec.check("GET /ai/accounts", &c.get("/ai/accounts").await);
    rec.check("on this computer", &c.get("/ai/accounts-on-this-computer").await);
    let folder = f.accounts.join("work");
    std::fs::create_dir_all(&folder).expect("folder");
    insert(
        &f.server,
        "ai_account",
        &json!({"id": "acct_0123456789", "name": "Work", "cli": "claude", "folder": folder.to_string_lossy(),
                "status": "signed_in", "created_at": NOW, "updated_at": NOW}),
    )
    .await;
    rec.check("check: the CLI is missing", &c.post_empty("/ai/accounts/acct_0123456789/check").await);
    rec.check("signin: the CLI is missing", &c.post_empty("/ai/accounts/acct_0123456789/signin").await);
    rec.check("sign-out: the CLI is missing", &c.post_empty("/ai/accounts/acct_0123456789/sign-out").await);
    rec.check("GET one", &c.get("/ai/accounts/acct_0123456789").await);
    rec.finish();
}

// ---------------------------------------------------------------------------
// knowledge
// ---------------------------------------------------------------------------

#[tokio::test]
async fn knowledge_routes() {
    let name = "knowledge_routes";
    let Some(f) = start(name, true, &[]).await else { return };
    let c = &f.c;
    let mut rec = Rec::new(name, &f);
    let (pid, _) = project(c).await;
    let know = format!("/projects/{pid}/ai/knowledge");
    rec.check("knowledge: unknown project", &c.get("/projects/nope/ai/knowledge").await);
    rec.check("knowledge: empty", &c.get(&know).await);
    // instructions
    let inst = format!("{know}/instructions");
    rec.check(
        "instructions: unknown project",
        &c.put("/projects/nope/ai/knowledge/instructions", json!({"instructions": "x"})).await,
    );
    rec.check("instructions: v1", &c.put(&inst, json!({"instructions": "v1"})).await);
    rec.check(
        "instructions: v2 by Ada",
        &c.clone().header("X-Actor", "Ada").put(&inst, json!({"instructions": "v2"})).await,
    );
    rec.check("instructions: empty text", &c.put(&inst, json!({"instructions": ""})).await);
    rec.check("instructions: empty text keeps no history", &c.put(&inst, json!({"instructions": "v3"})).await);
    rec.check("instructions: exactly 40000", &c.put(&inst, json!({"instructions": "é".repeat(40_000)})).await);
    rec.check("instructions: too long", &c.put(&inst, json!({"instructions": "é".repeat(40_001)})).await);
    rec.check("instructions: missing", &c.put(&inst, json!({})).await);
    rec.check("instructions: not text", &c.put(&inst, json!({"instructions": 5})).await);
    rec.check(
        "instructions: unknown project and too long",
        &c.put("/projects/nope/ai/knowledge/instructions", json!({"instructions": "x".repeat(40_001)})).await,
    );
    c.put(&inst, json!({"instructions": "Tests: uv run pytest."})).await;
    // lessons
    let lessons = format!("/projects/{pid}/ai/lessons");
    rec.check("lesson: unknown project", &c.post("/projects/nope/ai/lessons", json!({"text": "x"})).await);
    let made = c.post(&lessons, json!({"text": "  Run   the tests\nfirst. "})).await;
    rec.check("lesson: add", &made);
    let lesson = common::id(&made.json());
    rec.check("lesson: duplicate", &c.post(&lessons, json!({"text": "Run the tests first."})).await);
    rec.check("lesson: blank", &c.post(&lessons, json!({"text": "   "})).await);
    rec.check("lesson: missing text", &c.post(&lessons, json!({})).await);
    rec.check("lesson: long text is cut", &c.post(&lessons, json!({"text": "w".repeat(700)})).await);
    insert(
        &f.server,
        "ai_lesson",
        &json!({"id": "lsn_0123456789ab", "project_id": pid, "text": "Use uv run alembic revision.",
                "state": "proposed", "proposed_by": "model", "uses": 0, "created_at": NOW, "updated_at": NOW}),
    )
    .await;
    rec.check("knowledge: with lessons", &c.get(&know).await);
    let one = format!("/ai/lessons/{lesson}");
    rec.check("lesson: unknown", &c.patch("/ai/lessons/nope", json!({"text": "x"})).await);
    rec.check(
        "lesson: edit",
        &c.clone().header("X-Actor", "Ada").patch(&one, json!({"text": "Run the tests first, always."})).await,
    );
    rec.check("lesson: nothing to change", &c.patch(&one, json!({})).await);
    rec.check("lesson: null state", &c.patch(&one, json!({"state": null})).await);
    rec.check("lesson: bad state", &c.patch(&one, json!({"state": "maybe"})).await);
    rec.check("lesson: empty text", &c.patch(&one, json!({"text": " "})).await);
    rec.check("lesson: text not text", &c.patch(&one, json!({"text": 5})).await);
    rec.check(
        "lesson: keep a proposal",
        &c.clone().header("X-Actor", "Mia").patch("/ai/lessons/lsn_0123456789ab", json!({"state": "kept"})).await,
    );
    rec.check("lesson: back to proposed", &c.patch("/ai/lessons/lsn_0123456789ab", json!({"state": "proposed"})).await);
    rec.check("lesson: drop", &c.patch(&one, json!({"state": "dropped"})).await);
    rec.check("knowledge: after changes", &c.get(&know).await);
    rec.check("lesson: delete", &c.delete("/ai/lessons/lsn_0123456789ab").await);
    rec.check("lesson: delete again", &c.delete("/ai/lessons/lsn_0123456789ab").await);
    rec.check("lesson: delete unknown", &c.delete("/ai/lessons/nope").await);
    rec.check(
        "lesson: a dropped one can be added again",
        &c.post(&lessons, json!({"text": "Use uv run alembic revision."})).await,
    );
    // notes
    let tid = ticket(c, &pid, "Fix add()", "todo").await;
    let notes = format!("/projects/{pid}/ai/notes");
    let note = |text: &str| json!({"text": text, "scope": "ticket", "scope_key": tid});
    rec.check("note: unknown project", &c.post("/projects/nope/ai/notes", note("x")).await);
    let first = c.post(&notes, note("One")).await;
    rec.check("note: add", &first);
    let first_id = common::id(&first.json());
    rec.check("note: the same again", &c.post(&notes, note("one")).await);
    rec.check("note: no scope", &c.post(&notes, json!({"text": "x"})).await);
    rec.check("note: no key", &c.post(&notes, json!({"text": "x", "scope": "role"})).await);
    rec.check("note: empty key", &c.post(&notes, json!({"text": "x", "scope": "role", "scope_key": ""})).await);
    rec.check("note: bad scope", &c.post(&notes, json!({"text": "x", "scope": "team", "scope_key": "a"})).await);
    rec.check(
        "note: bad kind",
        &c.post(&notes, json!({"text": "x", "scope": "role", "scope_key": "a", "kind": "idea"})).await,
    );
    rec.check("note: blank", &c.post(&notes, json!({"text": "  ", "scope": "role", "scope_key": "a"})).await);
    rec.check("note: no text", &c.post(&notes, json!({"scope": "role", "scope_key": "a"})).await);
    rec.check(
        "note: learned",
        &c.post(&notes, json!({"text": "Use `npm test`.", "scope": "role", "scope_key": "dev", "kind": "learned"}))
            .await,
    );
    rec.check(
        "note: feedback by default, long text is cut",
        &c.post(&notes, json!({"text": "n".repeat(600), "scope": "member", "scope_key": "someone"})).await,
    );
    for i in 0..14 {
        c.post(&notes, note(&format!("Fact {i}"))).await;
    }
    rec.check("note: the memory is full", &c.post(&notes, note("One too many")).await);
    let one = format!("/ai/notes/{first_id}");
    rec.check("note: unknown", &c.patch("/ai/notes/nope", json!({"text": "x"})).await);
    rec.check("note: edit", &c.clone().header("X-Actor", "Ada").patch(&one, json!({"text": "One, corrected"})).await);
    rec.check(
        "note: change the kind",
        &c.patch(&one, json!({"text": "One, corrected again", "kind": "learned"})).await,
    );
    rec.check("note: keep the kind", &c.patch(&one, json!({"text": "One, third time"})).await);
    rec.check(
        "note: scope in an edit is ignored",
        &c.patch(&one, json!({"text": "One, fourth", "scope": "role", "scope_key": "x"})).await,
    );
    rec.check("note: edit without text", &c.patch(&one, json!({})).await);
    rec.check("note: blank edit", &c.patch(&one, json!({"text": " "})).await);
    rec.check("note: bad kind in an edit", &c.patch(&one, json!({"text": "x", "kind": "idea"})).await);
    rec.check("knowledge: with notes", &c.get(&know).await);
    rec.check("note: delete", &c.delete(&one).await);
    rec.check("note: delete again", &c.delete(&one).await);
    rec.check("note: delete unknown", &c.delete("/ai/notes/nope").await);
    rec.finish();
}

// ---------------------------------------------------------------------------
// power
// ---------------------------------------------------------------------------

#[tokio::test]
async fn power_routes() {
    let name = "power_routes";
    let Some(f) = start(name, true, &[]).await else { return };
    let c = &f.c;
    let mut rec = Rec::new(name, &f);
    rec.check("power: nothing", &c.get("/ai/power").await);
    rec.check("wake: nothing", &c.post_empty("/ai/power/wake").await);
    rec.check("power: DELETE is not served", &c.delete("/ai/power").await);
    rec.check("wake: GET is not served", &c.get("/ai/power/wake").await);
    let (pid, _) = project(c).await;
    team_as(&f.server, &pid, "Backend", "mem_backend0001", json!({})).await;
    for (state, pid_of) in
        [("queued", None), ("starting", None), ("running", Some(999_999)), ("needs_input", None), ("finished", None)]
    {
        let t = ticket(c, &pid, "Fix add()", "todo").await;
        run(&f.server, &pid, "mem_backend0001", &t, state, pid_of).await;
    }
    rec.check("power: two live runs", &c.get("/ai/power").await);
    rec.check("wake: runs with no process", &c.post_empty("/ai/power/wake").await);
    rec.note(
        "the runs after the wake",
        scalar(
            &f.server,
            "SELECT group_concat(state || ':' || COALESCE(stop_code, '-') || ':' || COALESCE(ended_by, '-') || ':' || COALESCE(token_hash, '-') || ':' || COALESCE(substr(ended_reason, 1, 24), '-'), '|') FROM (SELECT * FROM ai_run ORDER BY queued_at, state)",
            &[],
        )
        .await,
    );
    rec.check("power: after", &c.get("/ai/power").await);
    rec.check("wake: again", &c.post_empty("/ai/power/wake").await);
    rec.finish();
}
