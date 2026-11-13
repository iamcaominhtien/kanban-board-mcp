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
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kb_base::{pyjson, pytext};
use serde_json::{Value, json};

use crate::chrome::{self, Cdp, Filter, host_and_port, urlsplit};
pub use crate::chrome::{CHROME_ENV, EXPORT_CMD_ENV, command, find_chrome};
use crate::diagram_model::{b64decode, unquote};

/// Seconds to wait for the editor.
pub const EXPORT_TIMEOUT: f64 = 60.0;
/// Seconds to wait for the editor's address to answer before a hidden browser is started for it.
pub const PROBE_TIMEOUT: f64 = 3.0;
/// An editor that is not running (the self-hosted default, http://localhost:8080, on a computer that never started
/// one) is said once in this many seconds, not on every save.
pub const UNREACHABLE_LOG_EVERY: f64 = 600.0;
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

/// Whether a request URL may load: the editor's own origin, or an inline `data:`, `blob:` or `about:` URL.
pub fn same_origin(url: &str, editor: &str) -> bool {
    if url.starts_with("data:") || url.starts_with("blob:") || url.starts_with("about:") {
        return true;
    }
    urlsplit(url) == urlsplit(editor)
}

// --- a hidden Chrome over the DevTools protocol (the common part is in `chrome.rs`) -----------------

/// `_export_with_chrome`.
async fn export_with_chrome(chrome: &str, source: &str, editor: &str, timeout: f64) -> Result<String, String> {
    let owned = editor.to_string();
    let filter: Filter = Arc::new(move |url| same_origin(url, &owned));
    let browser = chrome::launch(chrome, "kanban-export-", &[], filter).await?;
    let result = drive_chrome(&browser.cdp, source, editor, timeout).await;
    browser.close().await;
    result
}

async fn drive_chrome(cdp: &Cdp, source: &str, editor: &str, timeout: f64) -> Result<String, String> {
    let target = cdp.call("Target.createTarget", json!({"url": "about:blank"}), None).await?;
    let target = target["targetId"].as_str().unwrap_or_default().to_string();
    let attached = cdp.call("Target.attachToTarget", json!({"targetId": target, "flatten": true}), None).await?;
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
    let lines: Vec<String> =
        pytext::splitlines(&text).into_iter().map(|l| pytext::strip(l).to_string()).filter(|l| !l.is_empty()).collect();
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
