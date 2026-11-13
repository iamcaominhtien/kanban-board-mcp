//! A hidden Chrome driven over the DevTools protocol: what `services/diagram_export.py` (`_Cdp`, `find_chrome`,
//! `_command`) and `services/screenshots.py` (`_Filter`, the launch of `_with_chrome`) both need, written once.
//!
//! * [`find_chrome`] / [`command`]: which browser, or which export command, to use.
//! * [`launch`]: start the browser headless, wait for its DevTools address and connect to it. The caller gives the
//!   request filter (`Fetch.requestPaused`): only the URLs it lets through load, everything else is failed with
//!   `BlockedByClient`.
//! * [`Cdp`]: commands, events and the filter on one websocket.
//! * [`urlsplit`] / [`host_and_port`]: `urllib.parse.urlsplit(url)` as far as the two callers need it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use kb_base::pytext;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

/// A path to a Chrome / Chromium / Edge, which wins over the ones found on the machine.
pub const CHROME_ENV: &str = "KANBAN_CHROME_PATH";
/// A JSON list: the desktop app's own executable, started with `--export-svg` / `--export-png`.
pub const EXPORT_CMD_ENV: &str = "KANBAN_EXPORT_CMD";

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// On Windows a file runs by its extension (`which` tries those of `PATHEXT`).
#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

/// The names `which` looks for in each folder: `name` itself, and on Windows `name` with each extension of `PATHEXT`
/// when it has none of them yet (as `shutil.which` does).
fn names_to_try(name: &str) -> Vec<String> {
    if cfg!(windows) {
        let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        let exts: Vec<String> = exts.split(';').filter(|e| !e.is_empty()).map(str::to_lowercase).collect();
        if exts.iter().any(|e| name.to_lowercase().ends_with(e.as_str())) {
            return vec![name.to_string()];
        }
        return exts.iter().map(|e| format!("{name}{e}")).collect();
    }
    vec![name.to_string()]
}

/// `shutil.which(name)`.
fn which(name: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    let names = names_to_try(name);
    std::env::split_paths(&path)
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
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

/// `urllib.parse.urlsplit(url)`: `(scheme, netloc)`, the scheme in lower case; empty strings when there is none.
pub fn urlsplit(url: &str) -> (String, String) {
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
pub fn host_and_port(url: &str) -> (Option<String>, Result<Option<u16>, ()>) {
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

type Reply = oneshot::Sender<Result<Value, String>>;

#[derive(Default)]
struct CdpState {
    next_id: u64,
    pending: HashMap<u64, Reply>,
    waiters: Vec<(String, oneshot::Sender<Value>)>,
}

/// Which request URLs may load.
pub type Filter = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// Just enough of the DevTools protocol over one websocket: commands, events, and a request filter.
#[derive(Clone)]
pub struct Cdp {
    state: Arc<Mutex<CdpState>>,
    out: mpsc::UnboundedSender<String>,
    filter: Filter,
    blocked: Arc<Mutex<Vec<String>>>,
}

impl Cdp {
    /// Send a command and wait for its reply (`error.message` of the browser becomes the `Err`).
    pub async fn call(&self, method: &str, params: Value, session: Option<&str>) -> Result<Value, String> {
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

    /// The next event of this kind (register it before the command that causes it).
    pub fn wait_for(&self, method: &str) -> oneshot::Receiver<Value> {
        let (tx, rx) = oneshot::channel();
        self.state.lock().unwrap_or_else(|e| e.into_inner()).waiters.push((method.to_string(), tx));
        rx
    }

    /// The URLs the filter refused so far.
    pub fn blocked(&self) -> Vec<String> {
        self.blocked.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// One message from the browser: a reply to a command, or an event.
    fn handle(&self, text: &str) {
        let Ok(msg) = serde_json::from_str::<Value>(text) else { return };
        if let Some(id) = msg.get("id").and_then(Value::as_u64) {
            let reply = self.state.lock().unwrap_or_else(|e| e.into_inner()).pending.remove(&id);
            if let Some(reply) = reply {
                let result = match msg.get("error") {
                    Some(error) => {
                        Err(error.get("message").and_then(Value::as_str).unwrap_or("devtools error").to_string())
                    }
                    None => Ok(msg.get("result").cloned().unwrap_or_else(|| json!({}))),
                };
                let _ = reply.send(result);
            }
            return;
        }
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
        if method == "Fetch.requestPaused" {
            let url = params["request"]["url"].as_str().unwrap_or("");
            let mut args = json!({"requestId": params["requestId"]});
            let verb = if (self.filter)(url) {
                "continueRequest"
            } else {
                args["errorReason"] = json!("BlockedByClient");
                self.blocked.lock().unwrap_or_else(|e| e.into_inner()).push(url.to_string());
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

/// A started hidden browser with its DevTools connection. [`Browser::close`] kills it and removes its profile.
pub struct Browser {
    /// The DevTools connection (the request filter is already on it).
    pub cdp: Cdp,
    child: tokio::process::Child,
    profile: tempfile::TempDir,
    reader: JoinHandle<()>,
    writer: JoinHandle<()>,
}

impl Browser {
    /// Stop reading, kill the browser and delete its profile folder.
    pub async fn close(mut self) {
        self.reader.abort();
        self.writer.abort();
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
        drop(self.profile);
    }
}

/// Start `chrome` headless on its own profile folder (`prefix` names it) with `extra` flags between the common ones
/// and `about:blank`, wait for the DevTools address (20 seconds) and connect. `filter` decides which requests load.
pub async fn launch(chrome: &str, prefix: &str, extra: &[&str], filter: Filter) -> Result<Browser, String> {
    let profile = tempfile::Builder::new().prefix(prefix).tempdir().map_err(|e| e.to_string())?;
    let mut args: Vec<String> = vec![
        "--headless=new".into(),
        "--remote-debugging-port=0".into(),
        format!("--user-data-dir={}", profile.path().display()),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-gpu".into(),
        "--disable-extensions".into(),
        "--disable-background-networking".into(),
    ];
    args.extend(extra.iter().map(|a| a.to_string()));
    args.push("--mute-audio".into());
    args.push("about:blank".into());
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
    match connect(stderr, filter).await {
        Ok((cdp, reader, writer)) => Ok(Browser { cdp, child, profile, reader, writer }),
        Err(e) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            Err(e)
        }
    }
}

async fn connect(
    stderr: Option<tokio::process::ChildStderr>,
    filter: Filter,
) -> Result<(Cdp, JoinHandle<()>, JoinHandle<()>), String> {
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
    let url = tokio::time::timeout(Duration::from_secs(20), endpoint).await.map_err(|_| "timed out".to_string())??;
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(128 * 1024 * 1024);
    config.max_frame_size = Some(128 * 1024 * 1024);
    let (ws, _) = tokio_tungstenite::connect_async_with_config(url.as_str(), Some(config), false)
        .await
        .map_err(|e| e.to_string())?;
    let (mut sink, mut stream) = ws.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let cdp = Cdp {
        state: Arc::new(Mutex::new(CdpState::default())),
        out: out_tx,
        filter,
        blocked: Arc::new(Mutex::new(Vec::new())),
    };
    let writer = tokio::spawn(async move {
        while let Some(text) = out_rx.recv().await {
            if sink.send(Message::text(text)).await.is_err() {
                break;
            }
        }
    });
    let reader = {
        let cdp = cdp.clone();
        tokio::spawn(async move {
            // the socket closing ends the loop; whoever waits will time out
            while let Some(Ok(message)) = stream.next().await {
                if let Message::Text(text) = message {
                    cdp.handle(text.as_ref());
                }
            }
        })
    };
    Ok((cdp, reader, writer))
}
