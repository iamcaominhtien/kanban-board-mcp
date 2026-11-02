"""The person's own Claude Code plugins in the board's runs (`ops.own_claude`).

A run starts Claude Code with the account's own config folder, so the plugins a person installed for themselves in
`~/.claude` are not there, and an AI on the board works with less than the same model in the person's terminal. With
the setting on, each run of a Claude Code member also loads, with `--plugin-dir`, every plugin the person installed
for their user and did not switch off, and every plugin they switched on. The skills synced from the desktop app
(`~/.claude/skills/synced`) are left out: they drive the app's own tools (its browser, the screen), which a run does
not have.
"""

import json
import os
from pathlib import Path


def claude_home() -> Path:
    """The person's Claude Code folder (`KANBAN_CLAUDE_HOME` for tests)."""
    return Path(os.environ.get("KANBAN_CLAUDE_HOME") or Path.home() / ".claude")


def _load(path: Path) -> dict:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def plugin_dirs(home: Path | None = None) -> list[str]:
    """The folders of the person's plugins that are on: installed for the user and not switched off, or switched on
    by name. One folder per plugin (the user install first, else the newest that exists)."""
    home = home or claude_home()
    installed = _load(home / "plugins" / "installed_plugins.json")
    installed = (
        installed.get("plugins", installed) if isinstance(installed, dict) else {}
    )
    enabled = _load(home / "settings.json").get("enabledPlugins") or {}
    out: list[str] = []
    for name, entries in installed.items():
        if not isinstance(entries, list):
            entries = [entries]
        entries = [e for e in entries if isinstance(e, dict) and e.get("installPath")]
        if enabled.get(name) is False:
            continue
        mine = [e for e in entries if e.get("scope") == "user"]
        if not mine and enabled.get(name) is not True:
            continue  # installed for one project only, and not switched on for the person
        for e in mine + sorted(
            entries, key=lambda e: e.get("lastUpdated") or "", reverse=True
        ):
            if Path(e["installPath"]).is_dir():
                out.append(e["installPath"])
                break
    return list(dict.fromkeys(out))
