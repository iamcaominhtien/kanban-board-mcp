"""API keys at rest and secret redaction for logs, run output and the audit trail.

Keys are encrypted with a per-install key. The desktop app (``KANBAN_SECRET_STORE=keychain``) keeps that key in the
OS keychain (macOS Keychain, Windows Credential Manager, the Secret Service on Linux); elsewhere it is a file next to
the app config (``~/.kanban-board/ai-secret.key``, readable by the user only). Only the last 4 characters of an API key
ever leave the server.
"""

import os
import re
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken


class SecretStoreError(RuntimeError):
    """The key store could not be read or written (e.g. the folder is not writable)."""


def _key_file() -> Path:
    override = os.environ.get("KANBAN_AI_KEY_FILE")
    if override:
        return Path(override)
    return Path.home() / ".kanban-board" / "ai-secret.key"


KEYCHAIN_SERVICE = "kanban-board"
KEYCHAIN_ACCOUNT = "ai-secret-key"
KEYCHAIN_DENIED = (
    "Could not store the key in the OS keychain. Access to the system keychain was denied, so nothing was saved. "
    "Allow Kanban in your keychain settings, then retry."
)
_cached: dict[str, Fernet] = {}


def store_kind() -> str:
    """keychain (desktop app) | file."""
    return "keychain" if os.environ.get("KANBAN_SECRET_STORE") == "keychain" else "file"


def _keychain_fernet() -> Fernet:
    """The encryption key from the OS keychain; a key file left from before moves into the keychain once."""
    if "keychain" in _cached:
        return _cached["keychain"]
    try:
        import keyring

        stored = keyring.get_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        if not stored:
            path = _key_file()
            stored = (
                path.read_bytes().strip().decode()
                if path.is_file()
                else Fernet.generate_key().decode()
            )
            keyring.set_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, stored)
            if keyring.get_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) != stored:
                raise SecretStoreError(KEYCHAIN_DENIED)
            if path.is_file():
                path.unlink()  # the key now lives only in the keychain
        fernet = Fernet(stored.encode())
    except SecretStoreError:
        raise
    except Exception as exc:  # noqa: BLE001 - every backend failure means the same to the person
        raise SecretStoreError(KEYCHAIN_DENIED) from exc
    _cached["keychain"] = fernet
    return fernet


def _fernet() -> Fernet:
    if store_kind() == "keychain":
        return _keychain_fernet()
    path = _key_file()
    try:
        if path.is_file():
            return Fernet(path.read_bytes().strip())
        path.parent.mkdir(parents=True, exist_ok=True)
        key = Fernet.generate_key()
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(key)
        return Fernet(key)
    except (OSError, ValueError) as exc:
        raise SecretStoreError(
            f"Could not open the key store at {path}: {exc}. Nothing was saved."
        ) from exc


def encrypt(value: str) -> str:
    """Encrypt a secret for storage."""
    return _fernet().encrypt(value.encode()).decode()


def decrypt(token: str | None) -> str | None:
    """Decrypt a stored secret, or None when missing or unreadable."""
    if not token:
        return None
    try:
        return _fernet().decrypt(token.encode()).decode()
    except (InvalidToken, SecretStoreError, ValueError):
        return None


def last4(value: str) -> str:
    """The last 4 characters of a secret, the only part ever shown again."""
    return value.strip()[-4:]


_PATTERNS = [
    (re.compile(r"\b(sk-(?:ant-)?[A-Za-z0-9_\-]{8,})"), "sk-••••"),
    (re.compile(r"\b(gh[pousr]_[A-Za-z0-9]{12,})"), "gh_••••"),
    (re.compile(r"\b(xox[baprs]-[A-Za-z0-9\-]{8,})"), "xox-••••"),
    (re.compile(r"\bAIza[0-9A-Za-z_\-]{20,}"), "AIza••••"),
    (re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._~+/=\-]{8,}"), r"\1 ••••••••"),
    (
        re.compile(
            r"(?im)\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)\s*([=:])\s*\S+"
        ),
        r"\1\2••••••••",
    ),
]


def redact(text: str | None) -> str:
    """Mask keys, tokens and secret-looking env values before text is stored, logged or shown."""
    if not text:
        return text or ""
    out = text
    for pattern, repl in _PATTERNS:
        out = pattern.sub(repl, out)
    return out


def redact_obj(value):
    """`redact` applied to every string in a JSON-like value."""
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, list):
        return [redact_obj(v) for v in value]
    if isinstance(value, dict):
        return {
            k: ("••••••••" if _secret_key(k) else redact_obj(v))
            for k, v in value.items()
        }
    return value


def _secret_key(key: str) -> bool:
    low = str(key).lower()
    return any(
        w in low for w in ("api_key", "apikey", "password", "secret", "authorization")
    )
