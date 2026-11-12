//! `tests/test_diagram_export.py`.
//!
//! The Python tests change the process environment and replace functions of the module (`monkeypatch`); the Rust
//! ones run the real thing: the environment is set under a lock, a hidden browser or the desktop app's command is a
//! small shell script, the editor is a socket (or a page served by this test), and `docs_write` of the MCP tools is
//! the service function it calls (`create_from_file`, `save_from_file`). What the MCP layer says in its reply
//! (`made["preview"]`) is not checked here: `preview_kind` of the stored version is.
//!
//! The browser tests find Chrome as `find_chrome` does (`KANBAN_CHROME_PATH`, else the usual names, else the
//! container's `/opt/pw-browsers`) and print a notice and pass when there is none.

mod common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use base64::Engine;
use common::drawio;
use common::service::{project, run};
use kb_draw::diagram_export as ex;
use kb_draw::{diagrams, diagram_model};
use serde_json::{Value, json};

const EXACT: &str =
    "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"9\" height=\"9\"><text>drawn by the editor</text></svg>";

static ENV: Mutex<()> = Mutex::new(());

/// Hold the environment: the tests below set `KANBAN_*` variables for the process.
fn env_lock() -> MutexGuard<'static, ()> {
    ENV.lock().unwrap_or_else(|e| e.into_inner())
}

#[allow(unsafe_code)]
fn set_env(name: &str, value: &str) {
    // every caller holds `env_lock`
    unsafe { std::env::set_var(name, value) }
}

#[allow(unsafe_code)]
fn unset_env(name: &str) {
    // every caller holds `env_lock`
    unsafe { std::env::remove_var(name) }
}

/// The variables every test starts from.
fn clean_env() {
    for name in [ex::SWITCH_ENV, ex::EXPORT_CMD_ENV, ex::CHROME_ENV] {
        unset_env(name);
    }
}

// --- small pieces ----------------------------------------------------------------------------

#[test]
fn test_switches() {
    let _g = env_lock();
    clean_env();
    assert!(ex::enabled("self-hosted") && !ex::enabled("public"));
    set_env(ex::SWITCH_ENV, "off");
    assert!(!ex::enabled("self-hosted") && !ex::enabled("public"));
    for off in ["0", "False", " NO "] {
        set_env(ex::SWITCH_ENV, off);
        assert!(!ex::enabled("self-hosted"), "{off}");
    }
    set_env(ex::SWITCH_ENV, "public");
    assert!(ex::enabled("public"));
    clean_env();
}

#[test]
fn test_decodes_the_editor_answer() {
    let encoded = base64::engine::general_purpose::STANDARD.encode(EXACT);
    assert_eq!(ex::decode(&format!("data:image/svg+xml;base64,{encoded}")).as_deref(), Ok(EXACT));
    assert_eq!(ex::decode("data:image/svg+xml,%3Csvg%2F%3E").as_deref(), Ok("<svg/>"));
    // characters outside the alphabet are skipped, as `base64.b64decode` does
    assert_eq!(ex::decode("data:image/svg+xml;base64,@@@").as_deref(), Ok(""));
    assert!(ex::decode("data:image/svg+xml;base64,QUJDR").is_err());
}

#[test]
fn test_only_the_editors_origin_may_load() {
    let editor = "http://localhost:8080";
    assert!(ex::same_origin("http://localhost:8080/js/app.js", editor));
    assert!(ex::same_origin("data:image/png;base64,AA", editor));
    assert!(ex::same_origin("blob:http://localhost:8080/x", editor));
    assert!(ex::same_origin("about:blank", editor));
    for other in ["https://clear.diagrams.net/", "http://localhost:9090/", "http://localhost.evil.com/", "http://localhost:8080@evil.com/"] {
        assert!(!ex::same_origin(other, editor), "{other}");
    }
}

#[test]
fn test_export_command_is_a_json_list_of_strings() {
    let _g = env_lock();
    clean_env();
    set_env(ex::EXPORT_CMD_ENV, "[\"/opt/Kanban Board\"]");
    assert_eq!(ex::command(), Some(vec!["/opt/Kanban Board".to_string()]));
    for bad in ["", "not json", "\"a string\"", "[]", "[1, 2]", "{\"a\": 1}"] {
        set_env(ex::EXPORT_CMD_ENV, bad);
        assert_eq!(ex::command(), None, "{bad}");
    }
    clean_env();
}

#[test]
fn test_chrome_path_can_be_given() {
    let _g = env_lock();
    clean_env();
    let tmp = tempfile::tempdir().expect("tempdir");
    let fake = tmp.path().join("chrome");
    std::fs::write(&fake, "").expect("write");
    set_env(ex::CHROME_ENV, &fake.to_string_lossy());
    assert_eq!(ex::find_chrome(), Some(fake.to_string_lossy().into_owned()));
    set_env(ex::CHROME_ENV, &tmp.path().join("missing").to_string_lossy());
    assert_eq!(ex::find_chrome(), None);
    clean_env();
}

// --- the desktop command contract -------------------------------------------------------------

/// A shell script as the desktop app's executable: `["/bin/sh", script]`.
fn fake_app(tmp: &Path, body: &str) -> String {
    let script = tmp.join("fake_app.sh");
    std::fs::write(&script, body).expect("script");
    json!(["/bin/sh", script.to_string_lossy()]).to_string()
}

/// A socket nothing listens on: its address as an editor URL.
fn dead_editor() -> String {
    let free = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = free.local_addr().expect("addr").port();
    drop(free);
    format!("http://127.0.0.1:{port}")
}

#[test]
fn test_runs_the_desktop_command_and_reads_its_svg() {
    let _g = env_lock();
    clean_env();
    let tmp = tempfile::tempdir().expect("tempdir");
    let up = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let editor = format!("http://127.0.0.1:{}", up.local_addr().expect("addr").port());
    let cmd = fake_app(
        tmp.path(),
        &format!(
            "[ \"$1\" = \"--export-svg\" ] && [ \"$4\" = \"--editor-url\" ] && [ \"$5\" = \"{editor}\" ] || exit 9\n\
             grep -q '<mxfile' \"$2\" || exit 8\n\
             printf '%s' '{EXACT}' > \"$3\"\n"
        ),
    );
    set_env(ex::EXPORT_CMD_ENV, &cmd);
    let got = run(ex::export_svg(&drawio(&["A"], ""), &format!("{editor}/"), None));
    assert_eq!(got.as_deref(), Some(EXACT));
    clean_env();
}

#[test]
fn test_a_failing_command_falls_back_quietly() {
    let _g = env_lock();
    clean_env();
    let tmp = tempfile::tempdir().expect("tempdir");
    let up = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let editor = format!("http://127.0.0.1:{}", up.local_addr().expect("addr").port());
    set_env(ex::EXPORT_CMD_ENV, &fake_app(tmp.path(), "exit 3\n"));
    assert_eq!(run(ex::export_svg(&drawio(&["A"], ""), &editor, None)), None);
    set_env(ex::EXPORT_CMD_ENV, &json!(["/no/such/program"]).to_string());
    assert_eq!(run(ex::export_svg(&drawio(&["A"], ""), &editor, None)), None);
    clean_env();
}

/// A subscriber that keeps what is logged, as `caplog` does.
#[derive(Clone, Default)]
struct Caught(Arc<Mutex<Vec<(tracing::Level, String)>>>);

impl tracing::Subscriber for Caught {
    fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
        true
    }

    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }

    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}

    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}

    fn event(&self, event: &tracing::Event<'_>) {
        struct Message(String);
        impl tracing::field::Visit for Message {
            fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
                if field.name() == "message" {
                    self.0 = format!("{value:?}");
                }
            }
        }
        let mut message = Message(String::new());
        event.record(&mut message);
        self.0.lock().unwrap_or_else(|e| e.into_inner()).push((*event.metadata().level(), message.0));
    }

    fn enter(&self, _: &tracing::span::Id) {}

    fn exit(&self, _: &tracing::span::Id) {}
}

#[test]
fn test_an_editor_that_is_not_running_starts_no_hidden_browser() {
    // The self-hosted default (http://localhost:8080) on a computer that never started draw.io: the desktop app was
    // started for every AI save only to fail with ERR_CONNECTION_REFUSED. Now nothing is started, and it is said once.
    let _g = env_lock();
    clean_env();
    let tmp = tempfile::tempdir().expect("tempdir");
    let started = tmp.path().join("started");
    set_env(ex::EXPORT_CMD_ENV, &fake_app(tmp.path(), &format!("echo x > '{}'\n", started.display())));
    ex::forget_unreachable();
    let editor = dead_editor();
    let caught = Caught::default();
    tracing::subscriber::with_default(caught.clone(), || {
        assert_eq!(run(ex::export_svg(&drawio(&["A"], ""), &editor, None)), None);
        assert_eq!(run(ex::export_svg(&drawio(&["A"], ""), &editor, None)), None);
    });
    assert!(!started.exists());
    let log = caught.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let said: Vec<_> = log.iter().filter(|(_, m)| m.contains("no draw.io editor answers")).collect();
    assert_eq!(said.len(), 1, "{log:?}");
    assert_eq!(said[0].0, tracing::Level::INFO);
    assert!(said[0].1.contains(&editor));
    clean_env();
}

#[test]
fn test_a_running_editor_is_reachable() {
    let up = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = up.local_addr().expect("addr").port();
    let probe = std::time::Duration::from_secs_f64(ex::PROBE_TIMEOUT);
    assert!(run(ex::reachable(&format!("http://127.0.0.1:{port}"), probe)));
    drop(up);
    assert!(!run(ex::reachable("not a url", probe)));
    assert!(!run(ex::reachable(&format!("http://127.0.0.1:{port}"), probe)));
}

#[test]
fn test_the_reason_is_the_apps_own_line_not_a_cut_off_tail() {
    let err = b"[1234:ERROR:navigation] Navigation failed: -2\r\n\
        (node:11508) electron: Failed to load URL: http://localhost:8080/clear.html with error: ERR_CONNECTION_REFUSED\n\
        (Use `Kanban Board --trace-warnings ...` to show where the warning was created)\n\
        export-svg failed: the draw.io editor at http://localhost:8080 could not be reached (ERR_CONNECTION_REFUSED)\n\n";
    assert_eq!(
        ex::why(err, 300),
        "the draw.io editor at http://localhost:8080 could not be reached (ERR_CONNECTION_REFUSED)"
    );
    // without that line: the last lines whole, never a word cut in two
    let mut tail = b"first line\n".to_vec();
    tail.extend(std::iter::repeat_n(b'x', 290));
    tail.extend_from_slice(b"\nlast words\n");
    let why = ex::why(&tail, 300);
    assert!(why.ends_with("last words") && !why.contains("first"), "{why}");
    assert_eq!(ex::why(b"", 300), "no output");
}

#[test]
fn test_without_a_command_or_browser_nothing_is_exported() {
    let _g = env_lock();
    clean_env();
    set_env(ex::CHROME_ENV, "/no/such/chrome");
    assert_eq!(run(ex::export_svg(&drawio(&["A"], ""), "http://editor:8080", None)), None);
    clean_env();
}

// --- what the agent is told and what is stored ------------------------------------------------

/// A project and a `.drawio` file of two shapes, for the preview tests.
struct Setup {
    pid: String,
    dir: tempfile::TempDir,
    editor: String,
    _up: std::net::TcpListener,
}

fn setup(name: &str) -> Setup {
    let pid = run(project(name, &name.to_uppercase()[..3.min(name.len())]));
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::write(dir.path().join("a.drawio"), drawio(&["A", "B"], "")).expect("drawio");
    // an editor that answers: a socket that accepts
    let up = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let editor = format!("http://127.0.0.1:{}", up.local_addr().expect("addr").port());
    run(async {
        let session = kb_db::session();
        diagrams::set_settings(&session, "self-hosted", Some(&editor), None).await.expect("settings");
    });
    Setup { pid, dir, editor, _up: up }
}

fn create(s: &Setup, svg_path: Option<&Path>) -> serde_json::Map<String, Value> {
    run(async {
        let session = kb_db::session();
        let path = s.dir.path().join("a.drawio");
        diagrams::create_from_file(
            &session,
            &s.pid,
            "Flow",
            &path.to_string_lossy(),
            svg_path.map(|p| p.to_string_lossy().into_owned()).as_deref(),
            None,
        )
        .await
        .expect("create from file")
    })
}

fn stored(id: &str) -> (Value, String) {
    run(async {
        let session = kb_db::session();
        let out = diagrams::get_diagram(&session, id, None, false).await.expect("get");
        let svg = diagrams::read_file(&session, id, "svg", None).await.expect("svg").0;
        (Value::Object(out), svg)
    })
}

/// A desktop command that records its `--editor-url` and draws `EXACT`.
fn recording_app(tmp: &Path) -> (String, PathBuf) {
    let seen = tmp.join("seen_editor");
    let cmd = fake_app(
        tmp,
        &format!("echo \"$5\" >> '{}'\nprintf '%s' '{EXACT}' > \"$3\"\n", seen.display()),
    );
    (cmd, seen)
}

#[test]
fn test_the_editors_picture_is_stored_and_reported() {
    let _g = env_lock();
    clean_env();
    let s = setup("exact");
    let (cmd, seen) = recording_app(s.dir.path());
    set_env(ex::EXPORT_CMD_ENV, &cmd);
    let made = create(&s, None);
    let id = made["id"].as_str().expect("id");
    let (info, svg) = stored(id);
    assert_eq!(info["preview_kind"], "editor");
    assert!(svg.contains("drawn by the editor"));
    assert_eq!(std::fs::read_to_string(seen).expect("seen").trim(), s.editor);
    clean_env();
}

#[test]
fn test_falls_back_to_the_plain_picture_and_says_so() {
    let _g = env_lock();
    clean_env();
    let s = setup("plain");
    set_env(ex::EXPORT_CMD_ENV, &fake_app(s.dir.path(), "exit 1\n"));
    let made = create(&s, None);
    let (info, svg) = stored(made["id"].as_str().expect("id"));
    assert_eq!(info["preview_kind"], "basic");
    assert!(svg.contains("<polyline") && svg.contains("marker-end"));
    clean_env();
}

#[test]
fn test_the_agents_own_svg_wins_and_no_browser_is_started() {
    let _g = env_lock();
    clean_env();
    let s = setup("own");
    let started = s.dir.path().join("started");
    set_env(ex::EXPORT_CMD_ENV, &fake_app(s.dir.path(), &format!("echo x > '{}'\n", started.display())));
    let svg = s.dir.path().join("a.svg");
    std::fs::write(&svg, EXACT).expect("svg");
    let made = create(&s, Some(&svg));
    let (info, stored_svg) = stored(made["id"].as_str().expect("id"));
    assert_eq!(info["preview_kind"], "agent");
    assert!(stored_svg.contains("drawn by the editor"));
    assert!(!started.exists(), "the export must not run when the agent gave an SVG");
    clean_env();
}

#[test]
fn test_the_public_editor_never_gets_a_drawing_unasked() {
    let _g = env_lock();
    clean_env();
    let s = setup("public");
    let (cmd, seen) = recording_app(s.dir.path());
    set_env(ex::EXPORT_CMD_ENV, &cmd);
    run(async {
        let session = kb_db::session();
        diagrams::set_settings(&session, "public", None, None).await.expect("settings");
    });
    // without the switch: the plain picture, and the command is never started
    let made = create(&s, None);
    assert_eq!(stored(made["id"].as_str().expect("id")).0["preview_kind"], "basic");
    assert!(!seen.exists());
    // the admin opted in: the export is tried for the public editor. Nothing answers at its address here (the
    // sandbox has no direct network), which is said in the log; where something does, the command saw its address
    set_env(ex::SWITCH_ENV, "public");
    ex::forget_unreachable();
    let caught = Caught::default();
    let made = tracing::subscriber::with_default(caught.clone(), || create(&s, None));
    let _ = made;
    let log = caught.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let said = log.iter().any(|(_, m)| m.contains("no draw.io editor answers at https://embed.diagrams.net"));
    let asked = std::fs::read_to_string(&seen).map(|t| t.trim() == "https://embed.diagrams.net").unwrap_or(false);
    assert!(said || asked, "{log:?}");
    clean_env();
}

#[test]
fn test_saving_a_new_version_redraws_and_restoring_keeps_the_kind() {
    let _g = env_lock();
    clean_env();
    let s = setup("redraw");
    let (cmd, _) = recording_app(s.dir.path());
    set_env(ex::EXPORT_CMD_ENV, &cmd);
    let made = create(&s, None);
    let id = made["id"].as_str().expect("id").to_string();
    let path = s.dir.path().join("a.drawio");
    std::fs::write(&path, drawio(&["A", "B", "C"], "")).expect("drawio");
    let saved = run(async {
        let session = kb_db::session();
        diagrams::save_from_file(&session, &id, &path.to_string_lossy(), 1, None, None).await.expect("save")
    });
    assert_eq!(saved["version"], 2);
    assert_eq!(stored(&id).0["preview_kind"], "editor");
    // unlink + restore must not touch the picture
    run(async {
        let session = kb_db::session();
        diagrams::delete_diagram(&session, &id).await.expect("delete");
        diagrams::restore_diagram(&session, &id).await.expect("restore");
    });
    assert!(stored(&id).1.contains("drawn by the editor"));
    clean_env();
}

// --- the real thing: a hidden browser driven over the DevTools protocol -----------------------

/// Chrome as the tests find it: `KANBAN_CHROME_PATH`, the usual names, then the container's browsers.
fn chrome_for_tests() -> Option<String> {
    if let Some(found) = ex::find_chrome() {
        return Some(found);
    }
    let root = Path::new("/opt/pw-browsers");
    let mut entries: Vec<PathBuf> = std::fs::read_dir(root).ok()?.filter_map(Result::ok).map(|e| e.path()).collect();
    entries.sort();
    entries.into_iter().find_map(|dir| {
        ["chrome-linux64/chrome", "chrome-linux/chrome"]
            .iter()
            .map(|rel| dir.join(rel))
            .find(|p| p.is_file())
            .map(|p| p.to_string_lossy().into_owned())
    })
}

/// A page of the editor's embed protocol, as the draw.io webapp speaks it: it says `init`, answers `load` and
/// answers `export` with an SVG that holds the labels of the drawing it was given.
const FAKE_EDITOR_PAGE: &str = "<!doctype html><html><body><script>\
let xml = '';\
window.addEventListener('message', (e) => {\
  let m; try { m = JSON.parse(e.data); } catch (_) { return; }\
  if (m.action === 'load') { xml = m.xml; parent.postMessage(JSON.stringify({event: 'load'}), '*'); }\
  else if (m.action === 'export') {\
    const labels = (xml.match(/value=\"[^\"]*\"/g) || []).join(' ').replace(/[<>&]/g, '');\
    const svg = '<svg xmlns=\"http://www.w3.org/2000/svg\"><text>' + labels + '</text></svg>';\
    parent.postMessage(JSON.stringify({event: 'export', data: 'data:image/svg+xml;base64,' + btoa(svg)}), '*');\
  }\
});\
parent.postMessage(JSON.stringify({event: 'init'}), '*');\
</script></body></html>";

/// Serve the fake editor on a local port: `/clear.html` is a blank page, `/` the editor.
async fn serve_fake_editor() -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else { break };
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..n]).into_owned();
                let target = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                let (status, body) = if target.starts_with("/clear.html") {
                    ("200 OK", "<!doctype html><html><body></body></html>".to_string())
                } else if target == "/" || target.starts_with("/?") {
                    ("200 OK", FAKE_EDITOR_PAGE.to_string())
                } else {
                    ("404 Not Found", String::new())
                };
                let reply = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(reply.as_bytes()).await;
                let _ = stream.shutdown().await;
            });
        }
    });
    format!("http://127.0.0.1:{port}")
}

#[test]
fn test_a_hidden_chrome_draws_the_picture_with_an_editor_page() {
    let _g = env_lock();
    clean_env();
    let Some(chrome) = chrome_for_tests() else {
        eprintln!("SKIPPED test_a_hidden_chrome_draws_the_picture_with_an_editor_page: no Chrome or Chromium found");
        return;
    };
    set_env(ex::CHROME_ENV, &chrome);
    let svg = run(async {
        let editor = serve_fake_editor().await;
        ex::export_svg(&drawio(&["Client", "Gateway", "Service"], ""), &editor, Some(30.0)).await
    });
    clean_env();
    let svg = svg.expect("Chrome exported an SVG");
    assert!(svg.trim_start().starts_with("<svg") && svg.contains("Gateway"), "{svg}");
}

#[test]
fn test_a_real_editor_draws_the_picture() {
    let _g = env_lock();
    clean_env();
    let Ok(url) = std::env::var("KANBAN_TEST_DRAWIO_URL") else {
        eprintln!("SKIPPED test_a_real_editor_draws_the_picture: needs KANBAN_TEST_DRAWIO_URL (a running draw.io webapp)");
        return;
    };
    let Some(chrome) = chrome_for_tests() else {
        eprintln!("SKIPPED test_a_real_editor_draws_the_picture: needs a Chrome/Chromium");
        return;
    };
    set_env(ex::CHROME_ENV, &chrome);
    let svg = run(ex::export_svg(&drawio(&["Client", "Gateway", "Service"], ""), &url, None));
    clean_env();
    let svg = svg.expect("the editor drew an SVG");
    assert!(svg.trim_start().starts_with("<svg") && svg.contains("Gateway"));
}

// `diagram_model` is used by the plain picture above
#[test]
fn the_plain_picture_is_what_diagram_model_draws() {
    let svg = diagram_model::render_svg(&drawio(&["A", "B"], "")).expect("svg");
    assert!(svg.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\""));
}
