"""The MCP servers a Claude Code opened in a member's working folder would load from its own files.

The CLI runs with `--strict-mcp-config`, so that nothing else is loaded (account connectors, plugins nobody enabled
for this folder). What the folder does ask for is read here and passed on explicitly:

- project scope: the folder's `.mcp.json`;
- local and user scope: the `mcpServers` of `~/.claude.json` (the entry of this folder, and the top-level one);
- the plugins the folder's `.claude/settings.json` and `settings.local.json` enable (`enabledPlugins`), with the
  servers of each plugin's own `.mcp.json` or `plugin.json`.

A nearer scope wins a name. The board's own `kanban` server is never taken from a file: it is the one that carries
the permission guard's token.
"""

import json
import os
import re

MAX_FILE = 1_000_000


def _read_json(path: str) -> dict:
    try:
        if os.path.getsize(path) > MAX_FILE:
            return {}
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _usable(listed) -> dict[str, dict]:
    """The enabled servers of one `mcpServers` object, except the board's own."""
    if not isinstance(listed, dict):
        return {}
    return {
        name: spec
        for name, spec in listed.items()
        if isinstance(name, str)
        and name != "kanban"
        and isinstance(spec, dict)
        and not spec.get("disabled")
        and spec.get("enabled", True)
    }


def _same_path(a: str, b: str) -> bool:
    def norm(p: str) -> str:
        return os.path.normcase(os.path.normpath(p.replace("\\", "/")))

    return norm(a) == norm(b)


def _config_dir() -> str:
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")


def _account_file() -> str:
    custom = os.environ.get("CLAUDE_CONFIG_DIR")
    return os.path.join(custom or os.path.expanduser("~"), ".claude.json")


def _substitute(value, root: str):
    if isinstance(value, str):
        return value.replace("${CLAUDE_PLUGIN_ROOT}", root)
    if isinstance(value, list):
        return [_substitute(v, root) for v in value]
    if isinstance(value, dict):
        return {k: _substitute(v, root) for k, v in value.items()}
    return value


def _clean(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", text)


def enabled_plugins(folder: str) -> list[str]:
    """`name@marketplace` of the plugins the folder's own settings files switch on."""
    names: dict[str, bool] = {}
    for fname in ("settings.json", "settings.local.json"):
        listed = _read_json(os.path.join(folder, ".claude", fname)).get(
            "enabledPlugins"
        )
        if isinstance(listed, dict):
            names.update(
                {k: v is True for k, v in listed.items() if isinstance(k, str)}
            )
    return [k for k, on in names.items() if on]


def _install_path(key: str, folder: str) -> str | None:
    """Where Claude Code installed a plugin for this folder (its own scope first, then the user's)."""
    installed = _read_json(
        os.path.join(_config_dir(), "plugins", "installed_plugins.json")
    )
    entries = (installed.get("plugins") or {}).get(key)
    if not isinstance(entries, list):
        return None
    found: str | None = None
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("installPath"), str):
            continue
        scope, project = entry.get("scope"), entry.get("projectPath")
        if project and not _same_path(str(project), folder):
            continue
        if scope in ("local", "project"):
            return entry["installPath"]
        found = found or entry["installPath"]
    return found


def _plugin_servers(root: str) -> dict[str, dict]:
    """The servers one installed plugin declares: its `.mcp.json` (with or without the `mcpServers` wrapper) and the
    `mcpServers` of its `plugin.json`."""
    found: dict[str, dict] = {}
    manifest: dict = {}
    for rel in (os.path.join(".claude-plugin", "plugin.json"), "plugin.json"):
        manifest = _read_json(os.path.join(root, rel))
        if manifest:
            break
    declared = manifest.get("mcpServers")
    if isinstance(declared, str):  # a path inside the plugin
        target = os.path.normpath(os.path.join(root, declared))
        if target.startswith(os.path.normpath(root) + os.sep):
            declared = _read_json(target)
            declared = declared.get("mcpServers", declared)
    found.update(_usable(declared))
    flat = _read_json(os.path.join(root, ".mcp.json"))
    found.update(_usable(flat.get("mcpServers", flat)))
    return found


def plugin_servers(folder: str) -> dict[str, dict]:
    """The servers of the plugins this folder enables, named `plugin_<plugin>_<server>` (what the CLI's own
    `plugin:<plugin>:<server>` becomes in a tool name)."""
    out: dict[str, dict] = {}
    for key in enabled_plugins(folder):
        root = _install_path(key, folder)
        if not root or not os.path.isdir(root):
            continue
        plugin = _clean(key.split("@", 1)[0])
        for name, spec in _plugin_servers(root).items():
            out[f"plugin_{plugin}_{_clean(name)}"] = _substitute(spec, root)
    return out


def folder_servers(folder: str | None) -> dict[str, dict]:
    """Every server the folder asks for (see the module notes), by name."""
    if not folder:
        return {}
    account = _read_json(_account_file())
    local: dict = {}
    projects = account.get("projects")
    if isinstance(projects, dict):
        for key, entry in projects.items():
            if isinstance(entry, dict) and _same_path(key, folder):
                local = entry.get("mcpServers") or {}
                break
    return {
        **plugin_servers(folder),
        **_usable(account.get("mcpServers")),
        **_usable(_read_json(os.path.join(folder, ".mcp.json")).get("mcpServers")),
        **_usable(local),
    }
