//! PDF export: prints the HTML of [`crate::render_html`] (made with [`crate::HtmlOptions::print`], so it carries the
//! print stylesheet with the page size, margins, header and page numbers) with a headless Chromium, Chrome or
//! Edge.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::ExportError;

/// Options of [`render_pdf`].
#[derive(Debug, Clone)]
pub struct PdfOptions {
    /// How long the browser may take before it is stopped.
    pub timeout: Duration,
    /// The browser to run; `None` looks for one with [`find_browser`].
    pub browser: Option<PathBuf>,
}

impl Default for PdfOptions {
    fn default() -> Self {
        PdfOptions { timeout: Duration::from_secs(120), browser: None }
    }
}

/// Finds a Chromium-family browser: `KANBAN_CHROME`, then a Playwright headless shell under `/opt/pw-browsers`,
/// then the usual install paths of Linux, macOS and Windows, then Playwright's full Chromium. Returns `None` when
/// there is none.
pub fn find_browser() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("KANBAN_CHROME").map(PathBuf::from) {
        if p.is_file() {
            return Some(p);
        }
    }
    let mut candidates: Vec<PathBuf> = [
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/microsoft-edge",
        "/usr/bin/microsoft-edge-stable",
        "/snap/bin/chromium",
        "/opt/google/chrome/chrome",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    ]
    .iter()
    .map(PathBuf::from)
    .collect();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(Path::new(&local).join(r"Google\Chrome\Application\chrome.exe"));
    }
    // Playwright's browsers: the headless shell first (the full Chromium can hang without a desktop session).
    if let Ok(entries) = std::fs::read_dir("/opt/pw-browsers") {
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("chromium")))
            .collect();
        dirs.sort();
        let mut shells = Vec::new();
        let mut full = Vec::new();
        for d in dirs.into_iter().rev() {
            for sub in ["chrome-headless-shell-linux64", "chrome-linux", "chrome-linux64"] {
                shells.push(d.join(sub).join("chrome-headless-shell"));
                shells.push(d.join(sub).join("headless_shell"));
                full.push(d.join(sub).join("chrome"));
            }
        }
        candidates.splice(0..0, shells);
        candidates.extend(full);
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// Prints `html` to PDF with a headless browser, in a temporary folder that is removed afterwards.
///
/// The page size and margins come from the `@page` rules of the HTML (see [`crate::HtmlOptions::print`]).
///
/// # Errors
///
/// [`ExportError::NoBrowser`] when no browser is found, [`ExportError::Timeout`] when it runs longer than
/// `opts.timeout` (it is killed), [`ExportError::Browser`] when it gives no PDF, [`ExportError::Io`] when the
/// temporary files cannot be written.
pub fn render_pdf(html: &str, opts: &PdfOptions) -> Result<Vec<u8>, ExportError> {
    let browser = match &opts.browser {
        Some(p) if p.is_file() => p.clone(),
        Some(_) => return Err(ExportError::NoBrowser),
        None => find_browser().ok_or(ExportError::NoBrowser)?,
    };
    let dir = tempfile::Builder::new().prefix("kb-pdf-").tempdir()?;
    let page = dir.path().join("page.html");
    let out = dir.path().join("out.pdf");
    let profile = dir.path().join("profile");
    std::fs::write(&page, html)?;
    let mut child = Command::new(&browser)
        .arg("--headless")
        .arg("--no-sandbox")
        .arg("--disable-gpu")
        .arg("--disable-dev-shm-usage")
        .arg("--disable-extensions")
        .arg("--no-first-run")
        .arg("--disable-background-networking")
        .arg("--disable-component-update")
        .arg("--disable-sync")
        .arg("--no-default-browser-check")
        .arg("--hide-scrollbars")
        .arg("--mute-audio")
        .arg("--no-pdf-header-footer")
        .arg("--print-to-pdf-no-header")
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg(format!("--print-to-pdf={}", out.display()))
        .arg(file_url(&page))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    // Read stderr on a thread so a chatty browser never blocks on a full pipe.
    let mut stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(e) = stderr.as_mut() {
            let _ = e.read_to_string(&mut s);
        }
        s
    });
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() >= opts.timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ExportError::Timeout(opts.timeout.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let log = reader.join().unwrap_or_default();
    match std::fs::read(&out) {
        Ok(bytes) if bytes.starts_with(b"%PDF") => Ok(bytes),
        _ => {
            let tail: String =
                log.lines().rev().take(5).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" | ");
            Err(ExportError::Browser(format!("exit {status}; {tail}")))
        }
    }
}

/// A `file://` URL for a local path.
fn file_url(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    let encoded: String = s
        .chars()
        .map(|c| match c {
            ' ' => "%20".to_string(),
            '#' => "%23".to_string(),
            '?' => "%3F".to_string(),
            '%' => "%25".to_string(),
            c => c.to_string(),
        })
        .collect();
    if encoded.starts_with('/') { format!("file://{encoded}") } else { format!("file:///{encoded}") }
}
