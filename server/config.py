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


def set_data_folder(path: Path) -> None:
    """Persist the data folder path in the config file."""
    data = _load()
    data["data_folder"] = str(path)
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
