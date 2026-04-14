"""
Manages runtime config (data folder path) persisted to a JSON file.
Config file location: ~/.kanban-board/config.json
"""

import json
from pathlib import Path

_CONFIG_DIR = Path.home() / ".kanban-board"
_CONFIG_FILE = _CONFIG_DIR / "config.json"


def _load() -> dict:
    try:
        return json.loads(_CONFIG_FILE.read_text())
    except Exception:
        return {}


def _save(data: dict) -> None:
    _CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    _CONFIG_FILE.write_text(json.dumps(data, indent=2))


def get_data_folder() -> Path | None:
    """Return the stored data folder path, or None if not set."""
    value = _load().get("data_folder")
    return Path(value) if value else None


def set_data_folder(path: Path) -> None:
    data = _load()
    data["data_folder"] = str(path)
    _save(data)
