//! Exact SVG previews for diagrams, made by the draw.io editor itself in a hidden browser.
//!
//! When a diagram is saved without a browser (an AI agent through MCP) the server has nobody to ask the editor for the
//! picture. This module opens the editor in a headless browser, loads the drawing, and asks it to export an SVG: the
//! same renderer a person gets when they save, so the picture is the same as in draw.io.
//!
//! Two ways to get a hidden browser, tried in this order:
//!
//! 1. `KANBAN_EXPORT_CMD` (a JSON list, set by the desktop app): the desktop app's own executable, started with
//!    `--export-svg`. It uses the Chromium that Electron already ships, so nothing extra is installed.
//! 2. A Chrome / Chromium / Edge found on the machine (or `KANBAN_CHROME_PATH`), driven over the DevTools protocol.
//!
//! Anything that goes wrong returns `None` and the caller keeps the plain preview. Only the editor's own origin may be
//! loaded, and nothing is exported when the editor is the public diagrams.net unless the admin switches it on,
//! because the drawing would be sent out without anybody asking.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use kb_base::{pyjson, pytext};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

use crate::diagram_model::{b64decode, unquote};

/// Seconds to wait for the editor.
pub const EXPORT_TIMEOUT: f64 = 60.0;
/// Seconds to wait for the editor's address to answer before a hidden browser is started for it.
pub const PROBE_TIMEOUT: f64 = 3.0;
/// An editor that is not running (the self-hosted default, http://localhost:8080, on a computer that never started
/// one) is said once in this many seconds, not on every save.
pub const UNREACHABLE_LOG_EVERY: f64 = 600.0;
pub const EXPORT_CMD_ENV: &str = "KANBAN_EXPORT_CMD";
pub const CHROME_ENV: &str = "KANBAN_CHROME_PATH";
/// `"off"` turns it off, `"public"` also allows the public editor.
pub const SWITCH_ENV: &str = "KANBAN_DIAGRAM_EXPORT";

static UNREACHABLE_SAID: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);

/// The editor's embed protocol, driven from a page on the editor's own origin: the drawing is loaded into a frame,
/// then exported. A frame is needed because the editor only talks to a parent window. Same code runs in Electron.
pub const PAGE_SCRIPT: &str = "
(xml, editorUrl, timeoutMs) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('the editor did not answer')), timeoutMs);
  const frame = document.createElement('iframe');
  frame.style.cssText = 'width:1400px;height:900px;border:0';
  const send = (m) => frame.contentWindow.postMessage(JSON.stringify(m), '*');
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || typeof e.data !== 'string') return;
    let m; try { m = JSON.parse(e.data); } catch (_) { return; }
    if (m.event === 'init') send({ action: 'load', xml });
    else if (m.event === 'load') send({ action: 'export', format: 'svg' });
    else if (m.event === 'export') { clearTimeout(timer); resolve(m.data); }
  });
  frame.src = editorUrl + '/?embed=1&proto=json&spin=0&ui=min&noSaveBtn=1&noExitBtn=1&libraries=0&lang=en';
  document.body.appendChild(frame);
})
";

/// Whether exact previews may be made for this editor mode (`self-hosted` or `public`).
pub fn enabled(mode: &str) -> bool {
    let switch = pytext::strip(&std::env::var(SWITCH_ENV).unwrap_or_default()).to_lowercase();
    if matches!(switch.as_str(), "off" | "0" | "false" | "no") {
        return false;
    }
    mode != "public" || switch == "public"
}

/// The text of the editor's `data:image/svg+xml` answer.
pub fn decode(data: &str) -> Result<String, String> {
    let (head, body) = data.split_once(',').unwrap_or((data, ""));
    if head.contains(";base64") {
        let bytes = b64decode(body).ok_or_else(|| "Incorrect padding".to_string())?;
        return String::from_utf8(bytes).map_err(|e| e.to_string());
    }
    Ok(unquote(body))
}

fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// `shutil.which(name)`.
fn which(name: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable_file(candidate))
        .map(|p| p.to_string_lossy().into_owned())
}

/// A Chrome, Chromium or Edge to drive: `KANBAN_CHROME_PATH` first, then the usual places.
pub fn find_chrome() -> Option<String> {
    let given = pytext::strip(&std::env::var(CHROME_ENV).unwrap_or_default()).to_string();
    if !given.is_empty() {
        return Path::new(&given).is_file().then_some(given);
    }
    let names =
        ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "msedge", "microsoft-edge"];
    if let Some(found) = names.iter().find_map(|n| which(n)) {
        return Some(found);
    }
    let candidates: Vec<String> = if cfg!(target_os = "macos") {
        vec![
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".into(),
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge".into(),
            "/Applications/Chromium.app/Contents/MacOS/Chromium".into(),
        ]
    } else if cfg!(windows) {
        let mut out = Vec::new();
        for key in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
            let root = std::env::var(key).unwrap_or_default();
            if root.is_empty() {
                continue;
            }
            let root = PathBuf::from(root);
            out.push(root.join("Google/Chrome/Application/chrome.exe").to_string_lossy().into_owned());
            out.push(root.join("Microsoft/Edge/Application/msedge.exe").to_string_lossy().into_owned());
        }
        out
    } else {
        Vec::new()
    };
    candidates.into_iter().find(|c| Path::new(c).is_file())
}

/// `urllib.parse.urlsplit(url)`: `(scheme, netloc)`, the scheme in lower case; empty strings when there is none.
fn urlsplit(url: &str) -> (String, String) {
    let url = url.trim_start_matches(|c: char| c <= ' ');
    let url: String = url.chars().filter(|c| !matches!(c, '\t' | '\r' | '\n')).collect();
    let Some((scheme, rest)) = url.split_once(':') else {
        return (String::new(), String::new());
    };
    let valid = scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c));
    if !valid {
        return (String::new(), String::new());
    }
    let scheme = scheme.to_ascii_lowercase();
    match rest.strip_prefix("//") {
        Some(after) => {
            let end = after.find(['/', '?', '#']).unwrap_or(after.len());
            (scheme, after[..end].to_string())
        }
        None => (scheme, String::new()),
    }
}

/// `(hostname, port)` of a URL as `urlsplit(url).hostname` / `.port` give them; `Err` where `.port` raises.
fn host_and_port(url: &str) -> (Option<String>, Result<Option<u16>, ()>) {
    let (_, netloc) = urlsplit(url);
    let host_part = netloc.rsplit_once('@').map_or(netloc.as_str(), |(_, h)| h);
    let (host, port_text) = if let Some(rest) = host_part.strip_prefix('[') {
        match rest.split_once(']') {
            Some((h, after)) => (h.to_string(), after.strip_prefix(':').map(str::to_string)),
            None => (rest.to_string(), None),
        }
    } else {
        match host_part.split_once(':') {
            Some((h, p)) => (h.to_string(), Some(p.to_string())),
            None => (host_part.to_string(), None),
        }
    };
    let host = (!host.is_empty()).then(|| host.to_lowercase());
    let port = match port_text {
        None => Ok(None),
        Some(p) if p.is_empty() => Ok(None),
        Some(p) => match p.parse::<u32>() {
            Ok(n) if n <= 65535 && p.chars().all(|c| c.is_ascii_digit()) => Ok(Some(n as u16)),
            _ => Err(()),
        },
    };
    (host, port)
}

/// Whether a request URL may load: the editor's own origin, or an inline `data:`, `blob:` or `about:` URL.
pub fn same_origin(url: &str, editor: &str) -> bool {
    if url.starts_with("data:") || url.starts_with("blob:") || url.starts_with("about:") {
        return true;
    }
    urlsplit(url) == urlsplit(editor)
}

// --- a hidden Chrome over the DevTools protocol ---------------------------------------------------

type Reply = oneshot::Sender<Result<Value, String>>;

#[derive(Default)]
struct CdpState {
    next_id: u64,
    pending: HashMap<u64, Reply>,
    waiters: Vec<(String, oneshot::Sender<Value>)>,
}

/// Just enough of the DevTools protocol over one websocket: commands, events, and a request filter.
#[derive(Clone)]
struct Cdp {
    state: Arc<Mutex<CdpState>>,
    out: mpsc::UnboundedSender<String>,
}

impl Cdp {
    async fn call(&self, method: &str, params: Value, session: Option<&str>) -> Result<Value, String> {
        let (tx, rx) = oneshot::channel();
        let id = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.next_id += 1;
            let id = state.next_id;
            state.pending.insert(id, tx);
            id
        };
        let mut msg = json!({"id": id, "method": method, "params": params});
        if let Some(session) = session {
            msg["sessionId"] = json!(session);
        }
        self.out.send(msg.to_string()).map_err(|_| "the browser connection closed".to_string())?;
        rx.await.map_err(|_| "the browser connection closed".to_string())?
    }

    fn wait_for(&self, method: &str) -> oneshot::Receiver<Value> {
        let (tx, rx) = oneshot::channel();
        self.state.lock().unwrap_or_else(|e| e.into_inner()).waiters.push((method.to_string(), tx));
        rx
    }

    /// One message from the browser: a reply to a command, or an event.
    fn handle(&self, text: &str, editor: &str) {
        let Ok(msg) = serde_json::from_str::<Value>(text) else { return };
        if let Some(id) = msg.get("id").and_then(Value::as_u64) {
            let reply = self.state.lock().unwrap_or_else(|e| e.into_inner()).pending.remove(&id);
            if let Some(reply) = reply {
                let result = match msg.get("error") {
                    Some(error) => Err(error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("devtools error")
                        .to_string()),
                    None => Ok(msg.get("result").cloned().unwrap_or_else(|| json!({}))),
                };
                let _ = reply.send(result);
            }
            return;
        }
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
        // only the editor's own origin may load
        if method == "Fetch.requestPaused" {
            let url = params["request"]["url"].as_str().unwrap_or("");
            let mut args = json!({"requestId": params["requestId"]});
            let verb = if same_origin(url, editor) {
                "continueRequest"
            } else {
                args["errorReason"] = json!("BlockedByClient");
                "failRequest"
            };
            let this = self.clone();
            let session = msg.get("sessionId").and_then(Value::as_str).map(str::to_string);
            tokio::spawn(async move {
                let _ = this.call(&format!("Fetch.{verb}"), args, session.as_deref()).await;
            });
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let mut i = 0;
        while i < state.waiters.len() {
            if state.waiters[i].0 == method {
                let (_, tx) = state.waiters.remove(i);
                let _ = tx.send(params.clone());
            } else {
                i += 1;
            }
        }
    }
}

fn is_root() -> bool {
    // `os.geteuid() == 0` without a libc dependency: the effective user of this process owns /proc/self
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata("/proc/self").map(|m| m.uid() == 0).unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// `_export_with_chrome`.
async fn export_with_chrome(chrome: &str, source: &str, editor: &str, timeout: f64) -> Result<String, String> {
    let profile = tempfile::Builder::new().prefix("kanban-export-").tempdir().map_err(|e| e.to_string())?;
    let mut args: Vec<String> = vec![
        "--headless=new".into(),
        "--remote-debugging-port=0".into(),
        format!("--user-data-dir={}", profile.path().display()),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-gpu".into(),
        "--disable-extensions".into(),
        "--disable-background-networking".into(),
        "--mute-audio".into(),
        "about:blank".into(),
    ];
    // Chrome refuses to start as root without this
    if is_root() {
        args.insert(0, "--no-sandbox".into());
    }
    let mut child = tokio::process::Command::new(chrome)
        .args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let stderr = child.stderr.take();
    let result = drive_chrome(stderr, source, editor, timeout).await;
    let _ = child.start_kill();
    let _ = child.wait().await;
    drop(profile);
    result
}

async fn drive_chrome(
    stderr: Option<tokio::process::ChildStderr>,
    source: &str,
    editor: &str,
    timeout: f64,
) -> Result<String, String> {
    let Some(stderr) = stderr else {
        return Err("the browser exited before it was ready".into());
    };
    let endpoint = async {
        let mut lines = BufReader::new(stderr);
        loop {
            let mut raw = Vec::new();
            let n = lines.read_until(b'\n', &mut raw).await.map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("the browser exited before it was ready".to_string());
            }
            let line = String::from_utf8_lossy(&raw).into_owned();
            if let Some((_, after)) = line.split_once("DevTools listening on") {
                // keep reading the pipe so Chrome never blocks on a full one
                tokio::spawn(async move {
                    let mut sink = Vec::new();
                    loop {
                        sink.clear();
                        match lines.read_until(b'\n', &mut sink).await {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {}
                        }
                    }
                });
                return Ok(pytext::strip(after).to_string());
            }
        }
    };
    let url = tokio::time::timeout(Duration::from_secs(20), endpoint)
        .await
        .map_err(|_| "timed out".to_string())??;
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(64 * 1024 * 1024);
    config.max_frame_size = Some(64 * 1024 * 1024);
    let (ws, _) = tokio_tungstenite::connect_async_with_config(url.as_str(), Some(config), false)
        .await
        .map_err(|e| e.to_string())?;
    let (mut sink, mut stream) = ws.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let cdp = Cdp { state: Arc::new(Mutex::new(CdpState::default())), out: out_tx };
    let writer = tokio::spawn(async move {
        while let Some(text) = out_rx.recv().await {
            if sink.send(Message::text(text)).await.is_err() {
                break;
            }
        }
    });
    let reader = {
        let cdp = cdp.clone();
        let editor = editor.to_string();
        tokio::spawn(async move {
            // the socket closing ends the loop; whoever waits will time out
            while let Some(Ok(message)) = stream.next().await {
                if let Message::Text(text) = message {
                    cdp.handle(text.as_ref(), &editor);
                }
            }
        })
    };
    let result = async {
        let target = cdp.call("Target.createTarget", json!({"url": "about:blank"}), None).await?;
        let target = target["targetId"].as_str().unwrap_or_default().to_string();
        let attached = cdp
            .call("Target.attachToTarget", json!({"targetId": target, "flatten": true}), None)
            .await?;
        let session = attached["sessionId"].as_str().unwrap_or_default().to_string();
        let session = Some(session.as_str());
        cdp.call("Page.enable", json!({}), session).await?;
        cdp.call("Fetch.enable", json!({"patterns": [{"urlPattern": "*"}]}), session).await?;
        let loaded = cdp.wait_for("Page.loadEventFired");
        // a page on the editor's own origin hosts the frame that runs the editor
        let nav = cdp.call("Page.navigate", json!({"url": format!("{editor}/clear.html")}), session).await?;
        if let Some(text) = nav.get("errorText").and_then(Value::as_str).filter(|t| !t.is_empty()) {
            return Err(format!("the editor at {editor} could not be reached ({text})"));
        }
        tokio::time::timeout(Duration::from_secs(30), loaded)
            .await
            .map_err(|_| "timed out".to_string())?
            .map_err(|_| "the browser connection closed".to_string())?;
        let expression = format!(
            "({PAGE_SCRIPT})({}, {}, {})",
            pyjson::dumps(&source),
            pyjson::dumps(&editor),
            (timeout * 1000.0) as i64
        );
        let evaluated = tokio::time::timeout(
            Duration::from_secs_f64(timeout + 5.0),
            cdp.call(
                "Runtime.evaluate",
                json!({"expression": expression, "awaitPromise": true, "returnByValue": true}),
                session,
            ),
        )
        .await
        .map_err(|_| "timed out".to_string())??;
        if let Some(detail) = evaluated.get("exceptionDetails") {
            let text = detail
                .get("exception")
                .and_then(|e| e.get("description"))
                .and_then(Value::as_str)
                .filter(|d| !d.is_empty())
                .or_else(|| detail.get("text").and_then(Value::as_str))
                .unwrap_or("script error");
            return Err(text.to_string());
        }
        let value = evaluated["result"]["value"].as_str().ok_or_else(|| "the editor answered nothing".to_string())?;
        decode(value)
    }
    .await;
    reader.abort();
    writer.abort();
    result
}

// --- the desktop app's own Chromium ---------------------------------------------------------------

/// `_export_with_command`.
async fn export_with_command(command: &[String], source: &str, editor: &str, timeout: f64) -> Result<String, String> {
    let tmp = tempfile::Builder::new().prefix("kanban-export-").tempdir().map_err(|e| e.to_string())?;
    let (src, out) = (tmp.path().join("in.drawio"), tmp.path().join("out.svg"));
    std::fs::write(&src, source).map_err(|e| e.to_string())?;
    let mut child = tokio::process::Command::new(&command[0])
        .args(&command[1..])
        .arg("--export-svg")
        .arg(&src)
        .arg(&out)
        .arg("--editor-url")
        .arg(editor)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stderr = child.stderr.take();
    let collect = async {
        let mut err = Vec::new();
        if let Some(pipe) = stderr.as_mut() {
            tokio::io::AsyncReadExt::read_to_end(pipe, &mut err).await.map_err(|e| e.to_string())?;
        }
        let status = child.wait().await.map_err(|e| e.to_string())?;
        Ok::<_, String>((status, err))
    };
    let (status, err) = match tokio::time::timeout(Duration::from_secs_f64(timeout + 15.0), collect).await {
        Ok(done) => done?,
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err("the export command timed out".to_string());
        }
    };
    if !status.success() || !out.is_file() {
        let code = status.code().map_or("None".to_string(), |c| c.to_string());
        return Err(format!("the export command failed ({code}): {}", why(&err, 300)));
    }
    std::fs::read_to_string(&out).map_err(|e| e.to_string())
}

/// What the export command said went wrong: its own `export-svg failed:` line when there is one, else its last
/// lines whole (Electron and Chromium write warnings before it; cutting the text by characters left
/// "tion failed: -2").
pub fn why(stderr: &[u8], limit: usize) -> String {
    let text = String::from_utf8_lossy(stderr).into_owned();
    let lines: Vec<String> = pytext::splitlines(&text)
        .into_iter()
        .map(|l| pytext::strip(l).to_string())
        .filter(|l| !l.is_empty())
        .collect();
    let own: Vec<&String> = lines.iter().filter(|l| l.starts_with("export-svg failed:")).collect();
    if let Some(last) = own.last() {
        let rest = pytext::strip(&last["export-svg failed:".len()..]);
        return rest.chars().take(limit).collect();
    }
    let mut kept: Vec<String> = Vec::new();
    for line in lines.iter().rev() {
        let width: usize = kept.iter().map(|k| k.chars().count() + 3).sum();
        if !kept.is_empty() && width + line.chars().count() > limit {
            break;
        }
        let len = line.chars().count();
        let item = if len <= limit {
            line.clone()
        } else {
            format!("…{}", line.chars().skip(len - limit).collect::<String>())
        };
        kept.insert(0, item);
    }
    if kept.is_empty() { "no output".to_string() } else { kept.join(" | ") }
}

/// Whether something answers at the editor's host and port, checked before a hidden browser is started for it.
pub async fn reachable(editor: &str, timeout: Duration) -> bool {
    let (host, port) = host_and_port(editor);
    let Some(host) = host else { return false };
    let Ok(port) = port else { return false };
    let port = match port {
        Some(p) if p != 0 => p,
        _ => {
            if urlsplit(editor).0 == "https" {
                443
            } else {
                80
            }
        }
    };
    matches!(tokio::time::timeout(timeout, tokio::net::TcpStream::connect((host.as_str(), port))).await, Ok(Ok(_)))
}

/// Say that no editor answers at `editor`, once in `UNREACHABLE_LOG_EVERY` seconds; whether it was said.
pub fn say_unreachable(editor: &str) -> bool {
    let now = Instant::now();
    let mut guard = UNREACHABLE_SAID.lock().unwrap_or_else(|e| e.into_inner());
    let said = guard.get_or_insert_with(HashMap::new);
    if said.get(editor).is_some_and(|last| now.duration_since(*last).as_secs_f64() < UNREACHABLE_LOG_EVERY) {
        return false;
    }
    said.insert(editor.to_string(), now);
    tracing::info!(
        "exact diagram previews skipped: no draw.io editor answers at {editor}, so the plain preview is used. Start a \
         self-hosted draw.io there, or choose the editor in Settings > Diagrams (draw.io)."
    );
    true
}

/// `_unreachable_said = {}` (for tests).
pub fn forget_unreachable() {
    *UNREACHABLE_SAID.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// `KANBAN_EXPORT_CMD` as a non-empty JSON list of strings.
pub fn command() -> Option<Vec<String>> {
    let raw = std::env::var(EXPORT_CMD_ENV).unwrap_or_default();
    let raw = pytext::strip(&raw);
    if raw.is_empty() {
        return None;
    }
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(raw) else {
        return None;
    };
    let strings: Option<Vec<String>> = items.iter().map(|v| v.as_str().map(str::to_string)).collect();
    strings.filter(|s| !s.is_empty())
}

/// The editor's own SVG of a drawing, or `None` when no hidden browser is available or it failed.
///
/// `source` is the `.drawio` XML, `editor_url` the editor's address (its origin is the only one the hidden page may
/// load), `timeout` the seconds to wait for the editor.
pub async fn export_svg(source: &str, editor_url: &str, timeout: Option<f64>) -> Option<String> {
    let timeout = timeout.unwrap_or(EXPORT_TIMEOUT);
    let editor = editor_url.trim_end_matches('/');
    let command = command();
    let chrome = if command.is_some() { None } else { find_chrome() };
    if command.is_none() && chrome.is_none() {
        return None;
    }
    // No hidden browser for an editor that is not running: it could only fail, a minute and a process later
    if !reachable(editor, Duration::from_secs_f64(PROBE_TIMEOUT)).await {
        say_unreachable(editor);
        return None;
    }
    let result = match (&command, &chrome) {
        (Some(command), _) => export_with_command(command, source, editor, timeout).await,
        (None, Some(chrome)) => export_with_chrome(chrome, source, editor, timeout).await,
        (None, None) => return None,
    };
    match result {
        Ok(svg) => Some(svg),
        Err(e) => {
            // never let a preview failure fail a save
            tracing::warn!("exact diagram preview failed: {e}");
            None
        }
    }
}
