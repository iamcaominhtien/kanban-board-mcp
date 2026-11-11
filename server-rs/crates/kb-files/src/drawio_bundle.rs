//! The draw.io editor shipped with the desktop app, served by the board at `/drawio`.
//!
//! The desktop app ships the static draw.io web app (`desktop/scripts/fetch-drawio.sh`, Apache 2.0) and tells the
//! server where it is with `KANBAN_DRAWIO_DIR`; a checkout finds `dist-drawio/` at the repository root once the
//! script ran. Served from the board's own address, the editor needs no service of its own and nothing leaves the
//! computer: before this, the default editor was a self-hosted one at http://localhost:8080 that nobody had started.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::pathlib;

pub const ENV: &str = "KANBAN_DRAWIO_DIR";
pub const PATH: &str = "/drawio";
const LOCAL_HOSTS: [&str; 3] = ["127.0.0.1", "localhost", "::1"];

static ORIGIN: Mutex<Option<String>> = Mutex::new(None);

/// The folder of the shipped editor (it holds `index.html`), or `None` when this install has none.
pub fn directory() -> Option<PathBuf> {
    let env = std::env::var(ENV).unwrap_or_default();
    let env = env.trim();
    // a checkout keeps the fetched editor in `dist-drawio/` at the repository root
    let candidate = if env.is_empty() {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../dist-drawio")
    } else {
        PathBuf::from(env)
    };
    if candidate.join("index.html").is_file() { Some(pathlib::resolve(&candidate)) } else { None }
}

/// Whether this install ships the editor.
pub fn available() -> bool {
    directory().is_some()
}

/// The shipped draw.io version (`VERSION` written by the fetch script).
pub fn version() -> Option<String> {
    let folder = directory()?;
    let text = std::fs::read_to_string(folder.join("VERSION")).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// Remember the board's own local address (learned at startup and from requests), for the server's own uses of the
/// editor (the exact diagram preview).
pub fn set_origin(host: &str, port: impl std::fmt::Display) {
    if LOCAL_HOSTS.contains(&host) {
        *ORIGIN.lock().unwrap_or_else(|e| e.into_inner()) = Some(format!("http://127.0.0.1:{port}"));
    }
}

/// The editor's address: on `origin` (a request's base URL) or on the board's own local address.
pub fn url(origin: Option<&str>) -> Option<String> {
    let remembered = ORIGIN.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let base = origin.filter(|o| !o.is_empty()).map(str::to_string).or(remembered).unwrap_or_default();
    let base = base.trim_end_matches('/');
    (!base.is_empty()).then(|| format!("{base}{PATH}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_address_is_the_origin_given_or_the_one_remembered() {
        assert_eq!(url(Some("http://example.test:9/")).as_deref(), Some("http://example.test:9/drawio"));
        set_origin("example.test", 1);
        set_origin("localhost", 8123);
        assert_eq!(url(None).as_deref(), Some("http://127.0.0.1:8123/drawio"));
        assert_eq!(url(Some("")).as_deref(), Some("http://127.0.0.1:8123/drawio"));
    }
}
