"""Register this Kanban MCP server in the config files of AI clients (Claude Code, Antigravity).

Both clients keep a JSON file with a top-level ``mcpServers`` object. We only ever touch our own
entry (``SERVER_NAME``); every other key is preserved, and a file that is not valid JSON is never
overwritten.
"""

import json
import os
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

SERVER_NAME = "kanban-board"
_SERVER_DIR = Path(__file__).resolve().parent.parent


class McpConfigError(Exception):
    """The client's config file cannot be read or written safely."""


@dataclass(frozen=True)
class McpClient:
    id: str
    label: str
    config_rel: tuple[str, ...]  # relative to the home directory
    typed_entry: bool  # Claude Code wants "type": "stdio"; Antigravity does not

    def config_path(self) -> Path:
        return Path.home().joinpath(*self.config_rel)


CLIENTS: dict[str, McpClient] = {
    "claude-code": McpClient("claude-code", "Claude Code", (".claude.json",), True),
    "antigravity": McpClient(
        "antigravity", "Antigravity", (".gemini", "antigravity", "mcp_config.json"), False
    ),
}


def stdio_command() -> tuple[str, list[str]]:
    """Command + args that start the stdio MCP server in this install."""
    if getattr(sys, "frozen", False):
        # Packaged desktop app: the stdio binary ships next to the server binary.
        ext = ".exe" if os.name == "nt" else ""
        return str(Path(sys.executable).resolve().parent / f"kanban-mcp-stdio{ext}"), []
    uv = shutil.which("uv") or "uv"
    return uv, ["--directory", str(_SERVER_DIR), "run", "mcp_stdio.py"]


def build_entry(client: McpClient, db_path: Path) -> dict:
    command, args = stdio_command()
    entry: dict = {"command": command, "args": args, "env": {"KANBAN_DB_PATH": str(db_path)}}
    if client.typed_entry:
        entry = {"type": "stdio", **entry}
    return entry


def _read(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8") or "{}")
    except (OSError, ValueError) as exc:
        raise McpConfigError(
            f"{path} is not valid JSON, so it was left untouched. Fix or remove it and try again."
        ) from exc
    if not isinstance(data, dict):
        raise McpConfigError(f"{path} does not contain a JSON object; it was left untouched.")
    return data


def _write(path: Path, data: dict) -> None:
    tmp = path.with_name(path.name + ".kanban-tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        if path.exists():
            shutil.copymode(path, tmp)
        os.replace(tmp, path)
    except OSError as exc:
        tmp.unlink(missing_ok=True)
        raise McpConfigError(f"Could not write {path}: {exc}") from exc


def _servers(data: dict, path: Path) -> dict:
    servers = data.get("mcpServers", {})
    if not isinstance(servers, dict):
        raise McpConfigError(f"'mcpServers' in {path} is not an object; it was left untouched.")
    return servers


def get_status(client: McpClient, db_path: Path) -> dict:
    path = client.config_path()
    status = {
        "id": client.id,
        "label": client.label,
        "config_path": str(path),
        "installed": False,
        "up_to_date": False,
        "error": None,
    }
    try:
        entry = _servers(_read(path), path).get(SERVER_NAME)
    except McpConfigError as exc:
        status["error"] = str(exc)
        return status
    if entry is not None:
        status["installed"] = True
        status["up_to_date"] = entry == build_entry(client, db_path)
    return status


def install(client: McpClient, db_path: Path) -> dict:
    path = client.config_path()
    data = _read(path)
    servers = _servers(data, path)
    servers[SERVER_NAME] = build_entry(client, db_path)
    data["mcpServers"] = servers
    _write(path, data)
    return get_status(client, db_path)


def uninstall(client: McpClient, db_path: Path) -> dict:
    path = client.config_path()
    data = _read(path)
    servers = _servers(data, path)
    if SERVER_NAME in servers:
        del servers[SERVER_NAME]
        data["mcpServers"] = servers
        _write(path, data)
    return get_status(client, db_path)
