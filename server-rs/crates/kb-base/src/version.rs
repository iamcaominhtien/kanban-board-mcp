//! App version info served by `GET /version` (the UI uses it to detect an out-of-date build).

use serde_json::{Value, json};

/// Keep in sync with desktop/package.json and ui/package.json when releasing.
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The oldest UI build that still works with this server. Raise it when the API changes in a way an old, still-open
/// browser tab cannot cope with; that tab then shows "A new version is available".
pub const MIN_SUPPORTED_UI_VERSION: &str = "1.4.0";

/// The running and latest app versions for the update check.
pub fn version_info() -> Value {
    // Overridable so a deployment (or a test) can force the update-required screen
    let min = std::env::var("KANBAN_MIN_UI_VERSION").unwrap_or_else(|_| MIN_SUPPORTED_UI_VERSION.to_string());
    json!({"version": APP_VERSION, "latest": APP_VERSION, "min_supported_version": min})
}
