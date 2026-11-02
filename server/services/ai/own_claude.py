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


def plugins(home: Path | None = None) -> list[dict]:
    """Every plugin in the person's Claude Code folder, with whether a run loads it and why not (ai-story-flow Q2):
    `{name, scope, skills, path, loaded, reason}`."""
    home = home or claude_home()
    installed = _load(home / "plugins" / "installed_plugins.json")
    installed = (
        installed.get("plugins", installed) if isinstance(installed, dict) else {}
    )
    enabled = _load(home / "settings.json").get("enabledPlugins") or {}
    loaded = set(plugin_dirs(home))
    out = []
    for name, entries in installed.items():
        if not isinstance(entries, list):
            entries = [entries]
        entries = [e for e in entries if isinstance(e, dict) and e.get("installPath")]
        if not entries:
            continue
        mine = [e for e in entries if e.get("scope") == "user"]
        pick = next(
            (e for e in entries if e["installPath"] in loaded), (mine or entries)[0]
        )
        path = Path(pick["installPath"])
        skills = (
            len([p for p in (path / "skills").glob("*/SKILL.md")])
            if path.is_dir()
            else 0
        )
        reason = None
        if pick["installPath"] not in loaded:
            if enabled.get(name) is False:
                reason = "Switched off in your Claude Code."
            elif not mine:
                reason = "Installed for another project only, and not switched on."
            else:
                reason = "Its folder is missing."
        out.append(
            {
                "name": name,
                "scope": pick.get("scope") or "user",
                "skills": skills,
                "path": pick["installPath"],
                "loaded": reason is None,
                "reason": reason,
            }
        )
    return sorted(out, key=lambda p: (not p["loaded"], p["name"]))


def for_role(
    role: str | None, roles: list | None, home: Path | None = None
) -> list[str]:
    """The folders a member with `role` loads: every plugin that is on, less those narrowed to other roles."""
    narrowed = {
        r.get("plugin"): set(r.get("roles") or [])
        for r in roles or []
        if isinstance(r, dict) and r.get("plugin")
    }
    out = []
    for p in plugins(home):
        if not p["loaded"]:
            continue
        allowed = narrowed.get(p["name"])
        if allowed is not None and (role or "") not in allowed:
            continue
        out.append(p["path"])
    return out


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
