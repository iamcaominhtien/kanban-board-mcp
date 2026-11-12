"""
Manages runtime config (data folder path) persisted to a JSON file.
Config file location: ~/.kanban-board/config.json (KANBAN_CONFIG_DIR picks another folder, so a test instance can
keep its own settings and data folder while HOME stays the person's own).
"""

import json
import os
from pathlib import Path

_CONFIG_DIR = (
    Path(os.environ["KANBAN_CONFIG_DIR"]).expanduser()
    if os.environ.get("KANBAN_CONFIG_DIR")
    else Path.home() / ".kanban-board"
)
_CONFIG_FILE = _CONFIG_DIR / "config.json"


def _load() -> dict:
    try:
        return json.loads(_CONFIG_FILE.read_text())
    except FileNotFoundError:
        return {}
    except Exception:
        import logging

        logging.getLogger(__name__).warning(
            "Corrupted config file at %s — using defaults", _CONFIG_FILE
        )
        return {}


def _save(data: dict) -> None:
    _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    _CONFIG_FILE.write_text(json.dumps(data, indent=2))


def get_data_folder() -> Path | None:
    """Return the stored data folder path, or None if not set."""
    value = _load().get("data_folder")
    return Path(value) if value else None


def get_uploads_dir() -> Path | None:
    """The uploads folder the desktop app recorded at its start (`uploads_dir`), or None when it never did.
    A server that did not get `KANBAN_UPLOADS_DIR` (the stdio MCP of an outside session) serves and writes the same
    folder as the app through this."""
    value = _load().get("uploads_dir")
    return Path(value) if isinstance(value, str) and value else None


def set_data_folder(path: Path) -> None:
    """Persist the data folder path in the config file."""
    data = _load()
    data["data_folder"] = str(path)
    _save(data)


def get_port() -> int | None:
    """The port the server listened on last time (`port`), or None when it never saved one."""
    value = _load().get("port")
    return value if isinstance(value, int) and 0 < value < 65536 else None


def set_port(port: int) -> None:
    """Remember the port the server listens on, so the next start asks for the same one."""
    data = _load()
    if data.get("port") != port:
        data["port"] = port
        _save(data)


def get_section(name: str) -> dict:
    """A saved group of settings (for example "database"); empty when never saved."""
    value = _load().get(name)
    return dict(value) if isinstance(value, dict) else {}


def set_section(name: str, value: dict | None) -> None:
    """Save a group of settings, or remove it with None."""
    data = _load()
    if value is None:
        data.pop(name, None)
    else:
        data[name] = value
    _save(data)


def get_flag(name: str) -> bool:
    """Whether the app-wide switch `name` is on (off when never set)."""
    return _load().get(name) is True


def set_flag(name: str, on: bool) -> None:
    """Persist an app-wide switch."""
    data = _load()
    data[name] = bool(on)
    _save(data)


# The switch behind "Full control over MCP" (Settings > Integrations)
MCP_FULL_CONTROL = "mcp_full_control"
