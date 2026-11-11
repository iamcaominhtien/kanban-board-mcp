//! API keys at rest and secret redaction for logs, run output and the audit trail.
//!
//! Keys are encrypted with a per-install key. The desktop app (`KANBAN_SECRET_STORE=keychain`) keeps that key in the
//! OS keychain (macOS Keychain, Windows Credential Manager, the Secret Service on Linux); elsewhere it is a file next
//! to the app config (`~/.kanban-board/ai-secret.key`, readable by the user only). Only the last 4 characters of an
//! API key ever leave the server.

use std::io::Write;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

use fernet::Fernet;
use regex::Regex;
use serde_json::Value;

/// The key store could not be read or written (e.g. the folder is not writable).
#[derive(Debug, Clone, thiserror::Error)]
#[error("{0}")]
pub struct SecretStoreError(pub String);

pub const KEYCHAIN_SERVICE: &str = "kanban-board";
pub const KEYCHAIN_ACCOUNT: &str = "ai-secret-key";
pub const KEYCHAIN_DENIED: &str = "Could not store the key in the OS keychain. Access to the system keychain was denied, so nothing was saved. \
     Allow Kanban in your keychain settings, then retry.";

static CACHED_KEYCHAIN: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

fn key_file() -> PathBuf {
    match std::env::var("KANBAN_AI_KEY_FILE") {
        Ok(path) if !path.is_empty() => PathBuf::from(path),
        _ => crate::config::home_dir()
            .join(".kanban-board")
            .join("ai-secret.key"),
    }
}

/// keychain (desktop app) | file.
pub fn store_kind() -> &'static str {
    if std::env::var("KANBAN_SECRET_STORE").is_ok_and(|v| v == "keychain") {
        "keychain"
    } else {
        "file"
    }
}

fn fernet_of(key: &str) -> Result<Fernet, String> {
    Fernet::new(key.trim())
        .ok_or_else(|| "Fernet key must be 32 url-safe base64-encoded bytes.".to_string())
}

/// The encryption key from the OS keychain; a key file left from before moves into the keychain once.
fn keychain_fernet() -> Result<Fernet, SecretStoreError> {
    let denied = || SecretStoreError(KEYCHAIN_DENIED.to_string());
    let mut cached = CACHED_KEYCHAIN.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(key) = cached.as_deref() {
        return fernet_of(key).map_err(|_| denied());
    }
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|_| denied())?;
    let stored = match entry.get_password() {
        Ok(stored) if !stored.is_empty() => stored,
        Ok(_) | Err(keyring::Error::NoEntry) => {
            let path = key_file();
            let stored = if path.is_file() {
                let bytes = std::fs::read(&path).map_err(|_| denied())?;
                String::from_utf8(bytes)
                    .map_err(|_| denied())?
                    .trim()
                    .to_string()
            } else {
                Fernet::generate_key()
            };
            entry.set_password(&stored).map_err(|_| denied())?;
            if entry.get_password().ok().as_deref() != Some(stored.as_str()) {
                return Err(denied());
            }
            if path.is_file() {
                // the key now lives only in the keychain
                std::fs::remove_file(&path).map_err(|_| denied())?;
            }
            stored
        }
        Err(_) => return Err(denied()),
    };
    let fernet = fernet_of(&stored).map_err(|_| denied())?;
    *cached = Some(stored);
    Ok(fernet)
}

fn fernet() -> Result<Fernet, SecretStoreError> {
    if store_kind() == "keychain" {
        return keychain_fernet();
    }
    let path = key_file();
    let fail = |err: String| {
        SecretStoreError(format!(
            "Could not open the key store at {}: {err}. Nothing was saved.",
            path.display()
        ))
    };
    if path.is_file() {
        let bytes = std::fs::read(&path).map_err(|e| fail(e.to_string()))?;
        let text = String::from_utf8_lossy(&bytes).trim().to_string();
        return fernet_of(&text).map_err(fail);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| fail(e.to_string()))?;
    }
    let key = Fernet::generate_key();
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|e| fail(e.to_string()))?;
    file.write_all(key.as_bytes())
        .map_err(|e| fail(e.to_string()))?;
    fernet_of(&key).map_err(fail)
}

/// Encrypt a secret for storage.
pub fn encrypt(value: &str) -> Result<String, SecretStoreError> {
    Ok(fernet()?.encrypt(value.as_bytes()))
}

/// Decrypt a stored secret, or `None` when missing or unreadable.
pub fn decrypt(token: Option<&str>) -> Option<String> {
    let token = token.filter(|t| !t.is_empty())?;
    let bytes = fernet().ok()?.decrypt(token).ok()?;
    String::from_utf8(bytes).ok()
}

/// The last 4 characters of a secret, the only part ever shown again.
pub fn last4(value: &str) -> String {
    let chars: Vec<char> = value.trim().chars().collect();
    chars[chars.len().saturating_sub(4)..].iter().collect()
}

static PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    let build = |pattern: &str| {
        Regex::new(pattern).expect("a redaction pattern written in the code compiles")
    };
    vec![
        (build(r"\b(sk-(?:ant-)?[A-Za-z0-9_\-]{8,})"), "sk-••••"),
        (build(r"\b(gh[pousr]_[A-Za-z0-9]{12,})"), "gh_••••"),
        (build(r"\b(xox[baprs]-[A-Za-z0-9\-]{8,})"), "xox-••••"),
        (build(r"\bAIza[0-9A-Za-z_\-]{20,}"), "AIza••••"),
        // a run's MCP token
        (build(r"\bkbr_[A-Za-z0-9_\-]{8,}"), "kbr_••••"),
        (
            build(r"(?i)\b(bearer)\s+[A-Za-z0-9._~+/=\-]{8,}"),
            "${1} ••••••••",
        ),
        (
            build(
                r"(?im)\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)\s*([=:])\s*\S+",
            ),
            "${1}${2}••••••••",
        ),
    ]
});

/// Mask keys, tokens and secret-looking env values before text is stored, logged or shown.
pub fn redact(text: &str) -> String {
    let mut out = text.to_string();
    for (pattern, replacement) in PATTERNS.iter() {
        out = pattern.replace_all(&out, *replacement).into_owned();
    }
    out
}

/// `redact` applied to every string in a JSON-like value.
pub fn redact_obj(value: &Value) -> Value {
    match value {
        Value::String(s) => Value::String(redact(s)),
        Value::Array(items) => Value::Array(items.iter().map(redact_obj).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        if secret_key(k) {
                            Value::String("••••••••".into())
                        } else {
                            redact_obj(v)
                        },
                    )
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

fn secret_key(key: &str) -> bool {
    let low = key.to_lowercase();
    ["api_key", "apikey", "password", "secret", "authorization"]
        .iter()
        .any(|w| low.contains(w))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_keys_and_secret_looking_values() {
        assert_eq!(redact("key sk-ant-abcdefgh12345 end"), "key sk-•••• end");
        assert_eq!(
            redact("Authorization: Bearer abcdefgh.ijk"),
            "Authorization: Bearer ••••••••"
        );
        assert_eq!(redact("MY_API_KEY = hunter2 x"), "MY_API_KEY=•••••••• x");
        assert_eq!(redact("token kbr_abcdefgh123"), "token kbr_••••");
        assert_eq!(
            redact_obj(&json!({"password": "p", "note": ["ghp_abcdefghijkl12"], "n": 1})),
            json!({"password": "••••••••", "note": ["gh_••••"], "n": 1})
        );
        assert_eq!(last4("  abcdefgh "), "efgh");
        assert_eq!(last4("ab"), "ab");
    }

    #[test]
    fn a_fernet_token_made_by_python_decrypts() {
        // made with cryptography.fernet: Fernet(key).encrypt(b"s3cret pass")
        let key = "x9M3bZ8mYq1o3Y0bYJc8gk2wN7v9x0QeXJmJ0n1V2nE=";
        let f = fernet_of(key).unwrap();
        let token = f.encrypt(b"s3cret pass");
        assert_eq!(f.decrypt(&token).unwrap(), b"s3cret pass");
    }
}
