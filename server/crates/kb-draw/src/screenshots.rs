//! `services/screenshots.py`: PNG pictures of what an AI drew (a diagram, a canvas frame, a local page), so it can look
//! before it hands in (#267).
//!
//! An AI that only has the board's MCP server cannot open a browser itself, and Playwright is often not set up. The
//! server draws the picture for it, in this order:
//!
//! 1. `KANBAN_EXPORT_CMD` (the desktop app's own executable, set by the app) started with `--export-png`: the
//!    Chromium that Electron ships, nothing to install.
//! 2. A Chrome / Chromium / Edge on the machine (`KANBAN_CHROME_PATH` first), driven headless over DevTools
//!    (`chrome.rs`, shared with `diagram_export`).
//! 3. Neither: a wireframe made without a browser (`canvas_png`), honest about being one.
//!
//! A page is served from a throwaway HTTP server on 127.0.0.1 that only serves its own folder (no `file://`, so the
//! page cannot read other files of the machine), and the hidden browser may load only that server and public http(s)
//! hosts (fonts and CDN libraries), never another port of this machine or the private network.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Method, StatusCode, Uri, header};
use axum::response::Response;
use base64::Engine;
use regex::Regex;
use serde_json::json;
use tokio::sync::oneshot;

use crate::chrome::{self, Cdp, Filter, host_and_port, urlsplit};
use crate::diagram_export::why;

/// Seconds the hidden browser has to draw a picture.
pub const TIMEOUT: f64 = 45.0;
/// The tallest picture.
pub const MAX_HEIGHT: i64 = 8000;
/// The widest picture.
pub const MAX_WIDTH: i64 = 4000;
/// Fonts and late scripts get this long after the load event before the picture is taken.
pub const SETTLE_SECONDS: f64 = 0.8;

// --- the local server -----------------------------------------------------------------------------------------

/// `posixpath.normpath` of an absolute path, as its list of components.
fn normpath(path: &str) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other.to_string()),
        }
    }
    parts
}

/// `urllib.parse.unquote(text)`: `%XX` runs decoded as UTF-8, a bad one left as it is.
fn unquote(text: &str) -> String {
    crate::diagram_model::unquote(text)
}

/// `os.path.realpath(path)`: symbolic links resolved as far as the path exists, the rest kept as it is.
fn realpath(path: &Path) -> PathBuf {
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    let mut here = path.to_path_buf();
    loop {
        if let Ok(real) = std::fs::canonicalize(&here) {
            let mut out = real;
            for part in rest.iter().rev() {
                out.push(part);
            }
            return out;
        }
        match (here.file_name().map(|n| n.to_os_string()), here.parent().map(Path::to_path_buf)) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                here = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// `_OneFolder.translate_path(path)`: the file for a URL path, or a path that does not exist when it would leave the
/// folder (by `..` or by a symbolic link).
pub fn translate_path(directory: &Path, url_path: &str) -> PathBuf {
    // `SimpleHTTPRequestHandler.translate_path`: query and fragment off, unquoted, normalised, no `..` or `.` left
    let path = url_path.split(['?', '#']).next().unwrap_or("");
    let trailing_slash = path.ends_with('/');
    let path = unquote(path);
    let mut full = directory.to_path_buf();
    for word in normpath(&path) {
        full.push(word);
    }
    if trailing_slash {
        full.push("");
    }
    let root = realpath(directory);
    let real = realpath(&full);
    if real != root && !real.starts_with(&root) {
        return root.join("__outside__");
    }
    full
}

fn error_page(status: StatusCode, message: &str, explain: &str) -> Response {
    let body = format!(
        "<!DOCTYPE HTML>\n<html lang=\"en\">\n    <head>\n        <meta charset=\"utf-8\">\n        <title>Error response</title>\n    </head>\n    <body>\n        <h1>Error response</h1>\n        <p>Error code: {}</p>\n        <p>Message: {message}.</p>\n        <p>Error code explanation: {} - {explain}.</p>\n    </body>\n</html>\n",
        status.as_u16(),
        status.as_u16()
    );
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/html;charset=utf-8")
        .header(header::CONTENT_LENGTH, body.len())
        .header(header::CONNECTION, "close")
        .body(Body::from(body))
        .expect("static response")
}

/// `SimpleHTTPRequestHandler.guess_type(path)`.
fn guess_type(path: &Path) -> String {
    let name = path.to_string_lossy();
    let ext = Path::new(name.as_ref()).extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    for candidate in [ext.clone(), ext.to_lowercase()] {
        match candidate.as_str() {
            ".gz" => return "application/gzip".into(),
            ".Z" => return "application/octet-stream".into(),
            ".bz2" => return "application/x-bzip2".into(),
            ".xz" => return "application/x-xz".into(),
            _ => {}
        }
    }
    kb_files::mimetypes::guess_type(&name).unwrap_or("application/octet-stream").to_string()
}

/// `html.escape(text, quote=False)`.
fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// `SimpleHTTPRequestHandler.list_directory(path)`.
fn list_directory(dir: &Path, url_path: &str, head: bool) -> Response {
    let Ok(read) = std::fs::read_dir(dir) else {
        return error_page(StatusCode::NOT_FOUND, "No permission to list directory", "Nothing matches the given URI");
    };
    let mut names: Vec<String> =
        read.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort_by_key(|n| n.to_lowercase());
    let shown = html_escape(&unquote(url_path));
    let mut body = format!(
        "<!DOCTYPE HTML>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Directory listing for {shown}</title>\n</head>\n<body>\n<h1>Directory listing for {shown}</h1>\n<hr>\n<ul>\n"
    );
    for name in names {
        let full = dir.join(&name);
        let (mut display, mut link) = (name.clone(), name.clone());
        if full.is_dir() {
            display.push('/');
            link.push('/');
        }
        if full.is_symlink() {
            display.push('@');
        }
        body.push_str(&format!("<li><a href=\"{}\">{}</a></li>\n", percent_quote(&link), html_escape(&display)));
    }
    body.push_str("</ul>\n<hr>\n</body>\n</html>\n");
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CONTENT_LENGTH, body.len())
        .body(if head { Body::empty() } else { Body::from(body) })
        .expect("static response")
}

/// `urllib.parse.quote(text)` (`/` is safe).
pub fn percent_quote(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-' | b'~' | b'/') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `_OneFolder`: serves one folder and nothing outside it (a link that leads out is refused), quietly. Only GET and
/// HEAD are answered; any other method is 501 as in `http.server`.
async fn one_folder(State(directory): State<Arc<PathBuf>>, method: Method, uri: Uri) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return error_page(
            StatusCode::NOT_IMPLEMENTED,
            &format!("Unsupported method ('{method}')"),
            "Server does not support this operation",
        );
    }
    let head = method == Method::HEAD;
    let request_target = uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
    let url_path = uri.path();
    let mut path = translate_path(&directory, request_target);
    if path.is_dir() {
        if !url_path.ends_with('/') {
            // redirect browser - doing basically what apache does
            let query = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
            return Response::builder()
                .status(StatusCode::MOVED_PERMANENTLY)
                .header(header::LOCATION, format!("{url_path}/{query}"))
                .header(header::CONTENT_LENGTH, 0)
                .body(Body::empty())
                .expect("static response");
        }
        let index = ["index.html", "index.htm"].iter().map(|n| path.join(n)).find(|p| p.exists());
        match index {
            Some(index) => path = index,
            None => return list_directory(&path, request_target, head),
        }
    }
    // a path that ends with "/" and is no folder is no file
    if path.to_string_lossy().ends_with('/') {
        return error_page(StatusCode::NOT_FOUND, "File not found", "Nothing matches the given URI");
    }
    let Ok(data) = std::fs::read(&path) else {
        return error_page(StatusCode::NOT_FOUND, "File not found", "Nothing matches the given URI");
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, guess_type(&path))
        .header(header::CONTENT_LENGTH, data.len())
        .body(if head { Body::empty() } else { Body::from(data) })
        .expect("static response")
}

/// A throwaway HTTP server on 127.0.0.1 for one folder.
pub struct Serve {
    /// `http://127.0.0.1:<port>`.
    pub origin: String,
    stop: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

impl Serve {
    /// Serve `folder` on a free port of 127.0.0.1 (and nowhere else).
    pub async fn start(folder: &Path) -> std::io::Result<Serve> {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let origin = format!("http://127.0.0.1:{}", listener.local_addr()?.port());
        let app = Router::new().fallback(one_folder).with_state(Arc::new(folder.to_path_buf()));
        let (stop, stopped) = oneshot::channel::<()>();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = stopped.await;
                })
                .await;
        });
        Ok(Serve { origin, stop: Some(stop), task })
    }

    /// Stop serving.
    pub async fn stop(mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        // a browser connection that is still open must not keep the server alive
        if tokio::time::timeout(Duration::from_secs(2), &mut self.task).await.is_err() {
            self.task.abort();
        }
    }
}

// --- what the hidden browser may load -----------------------------------------------------------------------------

fn in_v4(ip: u32, net: u32, bits: u32) -> bool {
    let mask = if bits == 0 { 0 } else { u32::MAX << (32 - bits) };
    ip & mask == net & mask
}

fn in_v6(ip: u128, net: u128, bits: u32) -> bool {
    let mask = if bits == 0 { 0 } else { u128::MAX << (128 - bits) };
    ip & mask == net & mask
}

fn v4(a: u8, b: u8, c: u8, d: u8) -> u32 {
    u32::from(Ipv4Addr::new(a, b, c, d))
}

/// `ipaddress.IPv4Address.is_private` (Python 3.12).
fn v4_is_private(addr: Ipv4Addr) -> bool {
    let ip = u32::from(addr);
    let private = [
        (v4(0, 0, 0, 0), 8),
        (v4(10, 0, 0, 0), 8),
        (v4(127, 0, 0, 0), 8),
        (v4(169, 254, 0, 0), 16),
        (v4(172, 16, 0, 0), 12),
        (v4(192, 0, 0, 0), 24),
        (v4(192, 0, 0, 170), 31),
        (v4(192, 0, 2, 0), 24),
        (v4(192, 168, 0, 0), 16),
        (v4(198, 18, 0, 0), 15),
        (v4(198, 51, 100, 0), 24),
        (v4(203, 0, 113, 0), 24),
        (v4(240, 0, 0, 0), 4),
        (v4(255, 255, 255, 255), 32),
    ];
    let exceptions = [(v4(192, 0, 0, 9), 32), (v4(192, 0, 0, 10), 32)];
    private.iter().any(|&(n, b)| in_v4(ip, n, b)) && !exceptions.iter().any(|&(n, b)| in_v4(ip, n, b))
}

/// `ipaddress.IPv4Address.is_global` (Python 3.12): not private, and not the shared address space `100.64.0.0/10`.
fn v4_is_global(addr: Ipv4Addr) -> bool {
    !in_v4(u32::from(addr), v4(100, 64, 0, 0), 10) && !v4_is_private(addr)
}

/// `ipaddress.IPv6Address.is_global` (Python 3.12).
fn v6_is_global(addr: Ipv6Addr) -> bool {
    // an IPv4-mapped address is as private as the IPv4 address in it
    if let Some(mapped) = addr.to_ipv4_mapped() {
        return !v4_is_private(mapped);
    }
    let ip = u128::from(addr);
    let net = |s: &str| s.parse::<Ipv6Addr>().map(u128::from).expect("a static address");
    let private: [(&str, u32); 9] = [
        ("::1", 128),
        ("::", 128),
        ("64:ff9b:1::", 48),
        ("100::", 64),
        ("2001::", 23),
        ("2001:db8::", 32),
        ("2002::", 16),
        ("fc00::", 7),
        ("fe80::", 10),
    ];
    let exceptions: [(&str, u32); 6] = [
        ("2001:1::1", 128),
        ("2001:1::2", 128),
        ("2001:3::", 32),
        ("2001:4:112::", 48),
        ("2001:20::", 28),
        ("2001:30::", 28),
    ];
    let is_private =
        private.iter().any(|&(n, b)| in_v6(ip, net(n), b)) && !exceptions.iter().any(|&(n, b)| in_v6(ip, net(n), b));
    !is_private
}

/// `ipaddress.ip_address(host)`: `None` when it is not an address (a name).
fn ip_address(host: &str) -> Option<IpAddr> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Some(ip);
    }
    // an IPv6 address may carry a scope id ("fe80::1%eth0")
    let (addr, scope) = host.split_once('%')?;
    if scope.is_empty() || scope.contains('/') {
        return None;
    }
    addr.parse::<Ipv6Addr>().ok().map(IpAddr::V6)
}

/// Whether the hidden browser may load `url`: the page's own server, inline data, and public http(s) hosts.
pub fn allowed(url: &str, origin: &str) -> bool {
    if url.starts_with("data:") || url.starts_with("blob:") || url.starts_with("about:") {
        return true;
    }
    let (scheme, netloc) = urlsplit(url);
    if format!("{scheme}://{netloc}") == origin {
        return true;
    }
    if scheme != "http" && scheme != "https" {
        return false;
    }
    // `urlsplit` raises for a netloc with one bracket only; a request that cannot be judged is not allowed
    if netloc.contains('[') != netloc.contains(']') {
        return false;
    }
    let (Some(host), _) = host_and_port(url) else { return false };
    if host == "localhost" || [".localhost", ".local", ".internal"].iter().any(|s| host.ends_with(s)) {
        return false;
    }
    match ip_address(&host) {
        // a public name; what it resolves to is the browser's business, as for a person's browser
        None => true,
        Some(IpAddr::V4(ip)) => v4_is_global(ip),
        Some(IpAddr::V6(ip)) => v6_is_global(ip),
    }
}

// --- drawing -------------------------------------------------------------------------------------------------------

async fn with_chrome(
    chrome: &str,
    url: &str,
    origin: &str,
    width: i64,
    height: Option<i64>,
) -> Result<Vec<u8>, String> {
    let owned = origin.to_string();
    let filter: Filter = Arc::new(move |u| allowed(u, &owned));
    let browser = chrome::launch(chrome, "kanban-shot-", &["--hide-scrollbars"], filter).await?;
    let result = shoot(&browser.cdp, url, width, height).await;
    browser.close().await;
    result
}

async fn shoot(cdp: &Cdp, url: &str, width: i64, mut height: Option<i64>) -> Result<Vec<u8>, String> {
    let target = cdp.call("Target.createTarget", json!({"url": "about:blank"}), None).await?;
    let target = target["targetId"].as_str().unwrap_or_default().to_string();
    let attached = cdp.call("Target.attachToTarget", json!({"targetId": target, "flatten": true}), None).await?;
    let session = attached["sessionId"].as_str().unwrap_or_default().to_string();
    let session = Some(session.as_str());
    cdp.call("Page.enable", json!({}), session).await?;
    cdp.call("Fetch.enable", json!({"patterns": [{"urlPattern": "*"}]}), session).await?;
    let mobile = width <= 500;
    cdp.call(
        "Emulation.setDeviceMetricsOverride",
        json!({"deviceScaleFactor": 1, "mobile": mobile, "width": width, "height": height.unwrap_or(800)}),
        session,
    )
    .await?;
    let loaded = cdp.wait_for("Page.loadEventFired");
    cdp.call("Page.navigate", json!({"url": url}), session).await?;
    tokio::time::timeout(Duration::from_secs(30), loaded)
        .await
        .map_err(|_| "timed out".to_string())?
        .map_err(|_| "the browser connection closed".to_string())?;
    cdp.call(
        "Runtime.evaluate",
        json!({"expression": "document.fonts ? document.fonts.ready.then(() => 1) : 1", "awaitPromise": true}),
        session,
    )
    .await?;
    tokio::time::sleep(Duration::from_secs_f64(SETTLE_SECONDS)).await;
    let height = match height.take() {
        Some(h) => h,
        None => {
            let measured = cdp
                .call(
                    "Runtime.evaluate",
                    json!({
                        "expression": "Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)",
                        "returnByValue": true
                    }),
                    session,
                )
                .await?;
            let value = measured["result"]["value"].as_f64().map(|v| v as i64).filter(|v| *v != 0).unwrap_or(800);
            let h = value.clamp(100, MAX_HEIGHT);
            cdp.call(
                "Emulation.setDeviceMetricsOverride",
                json!({"deviceScaleFactor": 1, "mobile": mobile, "width": width, "height": h}),
                session,
            )
            .await?;
            tokio::time::sleep(Duration::from_millis(200)).await;
            h
        }
    };
    let shot = cdp
        .call(
            "Page.captureScreenshot",
            json!({"format": "png", "clip": {"x": 0, "y": 0, "width": width, "height": height, "scale": 1}}),
            session,
        )
        .await?;
    base64::engine::general_purpose::STANDARD
        .decode(shot["data"].as_str().unwrap_or_default())
        .map_err(|e| e.to_string())
}

async fn with_command(command: &[String], url: &str, width: i64, height: Option<i64>) -> Result<Vec<u8>, String> {
    let tmp = tempfile::Builder::new().prefix("kanban-shot-").tempdir().map_err(|e| e.to_string())?;
    let out = tmp.path().join("out.png");
    let mut cmd = tokio::process::Command::new(&command[0]);
    cmd.args(&command[1..]).arg("--export-png").arg(url).arg(&out).arg("--width").arg(width.to_string());
    if let Some(height) = height.filter(|h| *h != 0) {
        cmd.arg("--height").arg(height.to_string());
    }
    let mut child =
        cmd.stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true).spawn().map_err(|e| e.to_string())?;
    let mut stderr = child.stderr.take();
    let collect = async {
        let mut err = Vec::new();
        if let Some(pipe) = stderr.as_mut() {
            tokio::io::AsyncReadExt::read_to_end(pipe, &mut err).await.map_err(|e| e.to_string())?;
        }
        let status = child.wait().await.map_err(|e| e.to_string())?;
        Ok::<_, String>((status, err))
    };
    let (status, err) = match tokio::time::timeout(Duration::from_secs_f64(TIMEOUT + 15.0), collect).await {
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
    std::fs::read(&out).map_err(|e| e.to_string())
}

/// What would draw a real picture on this machine: `"desktop"`, `"browser"` or `None`.
pub fn available() -> Option<&'static str> {
    if chrome::command().is_some() {
        return Some("desktop");
    }
    chrome::find_chrome().map(|_| "browser")
}

/// A screenshot of `folder/entry` drawn at `width` (and `height`; `None`: the whole page, up to 8000 px), or `None`
/// when no browser is available or it failed.
pub async fn page_png(folder: &Path, entry: &str, width: i64, height: Option<i64>) -> Option<Vec<u8>> {
    let width = width.clamp(200, MAX_WIDTH);
    let height = height.map(|h| h.clamp(100, MAX_HEIGHT));
    let command = chrome::command();
    let chrome = if command.is_some() { None } else { chrome::find_chrome() };
    if command.is_none() && chrome.is_none() {
        return None;
    }
    let served = match Serve::start(folder).await {
        Ok(served) => served,
        Err(e) => {
            tracing::warn!("screenshot failed: {e}");
            return None;
        }
    };
    let url = format!("{}/{}", served.origin, percent_quote(entry));
    let result = match (&command, &chrome) {
        (Some(command), _) => {
            match tokio::time::timeout(
                Duration::from_secs_f64(TIMEOUT + 20.0),
                with_command(command, &url, width, height),
            )
            .await
            {
                Ok(r) => r,
                Err(_) => Err("timed out".to_string()),
            }
        }
        (None, Some(chrome)) => {
            match tokio::time::timeout(
                Duration::from_secs_f64(TIMEOUT),
                with_chrome(chrome, &url, &served.origin, width, height),
            )
            .await
            {
                Ok(r) => r,
                Err(_) => Err("timed out".to_string()),
            }
        }
        (None, None) => Err("no browser".to_string()),
    };
    served.stop().await;
    match result {
        Ok(png) => Some(png),
        // a picture that cannot be drawn never fails the call; the caller falls back
        Err(e) => {
            tracing::warn!("screenshot failed: {e}");
            None
        }
    }
}

/// A PNG of an SVG drawing at its own size (or `width`), on white, or `None` without a browser.
pub async fn svg_png(svg: &str, width: Option<i64>) -> Option<Vec<u8>> {
    let tmp = tempfile::Builder::new().prefix("kanban-svg-").tempdir().ok()?;
    let (mut w, mut h) = svg_size(svg);
    if let Some(width) = width.filter(|w| *w != 0) {
        h = (h as f64 * width as f64 / w.max(1) as f64) as i64;
        w = width;
    }
    // the viewport line matters: a drawing under 500 px is drawn as a phone would, and without it a phone lays the
    // page out 980 px wide, so a live run saw only the top left corner of its diagram, twice as large (#267)
    let page = "<!doctype html><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'>\
                <style>html,body{margin:0;background:#fff}img{display:block;width:100%;height:auto}</style>\
                <img src='drawing.svg' alt=''>";
    std::fs::write(tmp.path().join("drawing.svg"), svg).ok()?;
    std::fs::write(tmp.path().join("index.html"), page).ok()?;
    page_png(tmp.path(), "index.html", w, Some(h)).await
}

fn size_attribute(head: &str, name: &str) -> Option<f64> {
    static CACHE: OnceLock<[Regex; 2]> = OnceLock::new();
    let res = CACHE.get_or_init(|| {
        [
            Regex::new(r#"\bwidth="([\d.]+)(px)?""#).expect("static pattern"),
            Regex::new(r#"\bheight="([\d.]+)(px)?""#).expect("static pattern"),
        ]
    });
    let re = if name == "width" { &res[0] } else { &res[1] };
    re.captures(head).and_then(|m| m[1].parse::<f64>().ok())
}

/// The drawn size of an SVG from its width/height or viewBox (draw.io writes both), else 800 x 600.
pub fn svg_size(svg: &str) -> (i64, i64) {
    static VIEW_BOX: OnceLock<Regex> = OnceLock::new();
    let head: String = svg.chars().take(2000).collect();
    let mut w = size_attribute(&head, "width");
    let mut h = size_attribute(&head, "height");
    if !(w.is_some_and(|v| v != 0.0) && h.is_some_and(|v| v != 0.0)) {
        let re = VIEW_BOX
            .get_or_init(|| Regex::new(r#"viewBox="[\d.\-]+ [\d.\-]+ ([\d.]+) ([\d.]+)""#).expect("static pattern"));
        if let Some(m) = re.captures(&head) {
            if let (Ok(vw), Ok(vh)) = (m[1].parse::<f64>(), m[2].parse::<f64>()) {
                (w, h) = (Some(vw), Some(vh));
            }
        }
    }
    let w = w.filter(|v| *v != 0.0).unwrap_or(800.0);
    let h = h.filter(|v| *v != 0.0).unwrap_or(600.0);
    ((w.round_ties_even() as i64).max(1), (h.round_ties_even() as i64).max(1))
}
