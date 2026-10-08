"""Install the Kanban MCP server into Claude Code and Antigravity (Settings -> MCP integrations).

Claude Code is configured only through its own CLI (``claude mcp add/remove``); its config files
are read, never written, by us. Antigravity has no CLI, so we merge a single ``kanban`` key into
its ``mcp_config.json`` (atomic write; a file that is not valid JSON is never overwritten).
Other servers in either config are never changed.
"""

import asyncio
import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

SERVER_NAME = "kanban"
CLAUDE_SCOPES = ("user", "project", "local")
ANTIGRAVITY_SCOPES = ("global", "workspace")
_SERVER_DIR = Path(__file__).resolve().parent.parent
_CLI_TIMEOUT = 30
_TEST_TIMEOUT = 30


class McpClientError(Exception):
    """An expected failure, reported to the UI as ``error`` on the client status."""

    def __init__(self, code: str, message: str):
        """Store a machine-readable `code` with the message."""
        super().__init__(message)
        self.code = code
        self.message = message


class BadRequest(Exception):
    """The request itself is wrong (unknown client or scope, missing or invalid folder)."""


# ---------------------------------------------------------------- the server entry


def stdio_command() -> tuple[str, list[str]]:
    """Command + args that start the stdio MCP server in this install."""
    if getattr(sys, "frozen", False):
        # Packaged desktop app: the stdio binary ships next to the server binary.
        ext = ".exe" if os.name == "nt" else ""
        return str(Path(sys.executable).resolve().parent / f"kanban-mcp-stdio{ext}"), []
    uv = shutil.which("uv") or "uv"
    return uv, ["--directory", str(_SERVER_DIR), "run", "mcp_stdio.py"]


def stdio_env() -> dict[str, str]:
    """The packaged app points the stdio binary at its database through KANBAN_DB_PATH."""
    value = os.environ.get("KANBAN_DB_PATH", "")
    return {"KANBAN_DB_PATH": value} if value else {}


def _join(parts: list[str]) -> str:
    return subprocess.list2cmdline(parts) if os.name == "nt" else shlex.join(parts)


def _entry(with_type: bool) -> dict:
    command, args = stdio_command()
    entry: dict = {"command": command, "args": args}
    if env := stdio_env():
        entry["env"] = env
    return {"type": "stdio", **entry} if with_type else entry


def _same_entry(installed: dict, expected: dict) -> bool:
    return (
        installed.get("command") == expected["command"]
        and list(installed.get("args", [])) == expected["args"]
        and dict(installed.get("env", {})) == expected.get("env", {})
    )


# ---------------------------------------------------------------- files


def _read_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8") or "{}")
    except (OSError, ValueError) as exc:
        raise McpClientError(
            "invalid_json",
            f"{path} is not valid JSON, so it was left untouched. Fix or remove it and try again.",
        ) from exc
    if not isinstance(data, dict):
        raise McpClientError(
            "invalid_json",
            f"{path} does not contain a JSON object; it was left untouched.",
        )
    return data


def _write_json(path: Path, data: dict) -> None:
    tmp = path.with_name(path.name + ".kanban-tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        if path.exists():
            shutil.copymode(path, tmp)
        os.replace(tmp, path)
    except OSError as exc:
        tmp.unlink(missing_ok=True)
        reason = exc.strerror or str(exc)
        raise McpClientError(
            "write_failed",
            f"Couldn't write {path}: {reason}. Nothing was changed. Copy the JSON and add it to the file yourself.",
        ) from exc


def _servers(data: dict, path: Path) -> dict:
    servers = data.get("mcpServers", {})
    if not isinstance(servers, dict):
        raise McpClientError(
            "invalid_json",
            f"'mcpServers' in {path} is not an object; it was left untouched.",
        )
    return servers


def _folder(raw: str | None, *, required: bool) -> Path | None:
    if not raw or not raw.strip():
        if required:
            raise BadRequest("Choose a project folder first.")
        return None
    path = Path(os.path.realpath(raw.strip()))
    if not path.is_dir():
        raise BadRequest(f"{path} is not a folder.")
    return path


def _tilde(path: Path) -> str:
    try:
        return "~/" + path.relative_to(Path.home()).as_posix()
    except ValueError:
        return str(path)


# ---------------------------------------------------------------- Claude Code


def find_claude() -> str | None:
    """Locate the `claude` CLI on PATH or in common install folders."""
    found = shutil.which("claude")
    if found:
        return found
    # GUI apps (the desktop build) often start without the shell's PATH.
    home = Path.home()
    for candidate in (
        home / ".claude" / "local" / "claude",
        home / ".local" / "bin" / "claude",
        Path("/opt/homebrew/bin/claude"),
        Path("/usr/local/bin/claude"),
    ):
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def _claude_add_args(scope: str) -> list[str]:
    command, args = stdio_command()
    env = [a for k, v in stdio_env().items() for a in ("--env", f"{k}={v}")]
    return [
        "mcp",
        "add",
        SERVER_NAME,
        "--transport",
        "stdio",
        "--scope",
        scope,
        *env,
        "--",
        command,
        *args,
    ]


def claude_command_text(scope: str) -> str:
    """Return the `claude mcp add ...` command for a scope, as text to copy."""
    return _join(["claude", *_claude_add_args(scope)])


def _claude_stored(scope: str, folder: Path | None) -> tuple[Path, dict | None]:
    """Where the kanban entry lives for a scope, and its current value (read-only)."""
    if scope == "project":
        path = folder / ".mcp.json" if folder else Path(".mcp.json")
        return path, (
            _servers(_read_json(path), path).get(SERVER_NAME) if folder else None
        )
    path = Path.home() / ".claude.json"
    data = _read_json(path)
    if scope == "user":
        return path, _servers(data, path).get(SERVER_NAME)
    project = (data.get("projects") or {}).get(str(folder)) if folder else None
    servers = project.get("mcpServers") if isinstance(project, dict) else None
    return path, (servers or {}).get(SERVER_NAME)


def _run_claude(args: list[str], cwd: Path | None) -> subprocess.CompletedProcess:
    claude = find_claude()
    if not claude:
        raise McpClientError(
            "claude_not_found",
            "Couldn't find the claude command. Install Claude Code first, or copy the command and run it yourself.",
        )
    try:
        return subprocess.run(
            [claude, *args],
            cwd=str(cwd or Path.home()),
            capture_output=True,
            text=True,
            timeout=_CLI_TIMEOUT,
        )
    except subprocess.TimeoutExpired as exc:
        raise McpClientError(
            "command_failed", f"claude did not finish within {_CLI_TIMEOUT} seconds."
        ) from exc
    except OSError as exc:
        raise McpClientError("command_failed", f"Couldn't run claude: {exc}") from exc


# ---------------------------------------------------------------- Antigravity


def _antigravity_path(scope: str, folder: Path | None) -> Path:
    if scope == "workspace":
        return (folder or Path(".")) / ".agents" / "mcp_config.json"
    return Path.home() / ".gemini" / "config" / "mcp_config.json"


# ---------------------------------------------------------------- status / actions


def _scope_for(client: str, scope: str | None) -> str:
    options = CLAUDE_SCOPES if client == "claude-code" else ANTIGRAVITY_SCOPES
    scope = scope or options[0]
    if scope not in options:
        raise BadRequest(f"Unknown scope '{scope}' for {client}.")
    return scope


def _needs_folder(client: str, scope: str) -> bool:
    return scope in (
        ("project", "local") if client == "claude-code" else ("workspace",)
    )


def get_status(
    client: str, scope: str | None, folder_raw: str | None, tool_count: int
) -> dict:
    """Report whether the MCP server is installed for a client and scope."""
    if client not in ("claude-code", "antigravity"):
        raise BadRequest(f"Unknown MCP client '{client}'")
    scope = _scope_for(client, scope)
    needs_folder = _needs_folder(client, scope)
    folder = _folder(folder_raw, required=False) if needs_folder else None

    status: dict = {
        "id": client,
        "scope": scope,
        "needs_folder": needs_folder and folder is None,
        "tool_count": tool_count,
        "detected": True,
        "installed": False,
        "update_available": False,
        "installed_command": None,
        "command": None,
        "entry_json": None,
        "stored_in": None,
        "error": None,
    }
    try:
        if client == "claude-code":
            status["detected"] = find_claude() is not None
            status["command"] = claude_command_text(scope)
            path, installed = _claude_stored(scope, folder)
            expected = _entry(with_type=True)
        else:
            path = _antigravity_path(scope, folder)
            status["entry_json"] = json.dumps(
                {"mcpServers": {SERVER_NAME: _entry(False)}}, indent=2
            )
            installed = (
                _servers(_read_json(path), path).get(SERVER_NAME)
                if not status["needs_folder"]
                else None
            )
            expected = _entry(with_type=False)
    except McpClientError as exc:
        status["error"] = {"code": exc.code, "message": exc.message}
        return status

    status["stored_in"] = _tilde(path) if not status["needs_folder"] else None
    if isinstance(installed, dict):
        status["installed"] = True
        status["installed_command"] = _join(
            [str(installed.get("command", "")), *map(str, installed.get("args", []))]
        )
        status["update_available"] = not _same_entry(installed, expected)
    return status


def install(
    client: str, scope: str | None, folder_raw: str | None, tool_count: int
) -> dict:
    """Add or replace the kanban entry. Expected failures come back as ``status['error']``."""
    status = get_status(client, scope, folder_raw, tool_count)
    scope = status["scope"]
    folder = _folder(folder_raw, required=_needs_folder(client, scope))
    if status["error"]:
        return status
    try:
        if client == "claude-code":
            if status[
                "installed"
            ]:  # `claude mcp add` refuses an existing name; replace it
                _run_claude(["mcp", "remove", SERVER_NAME, "--scope", scope], folder)
            result = _run_claude(_claude_add_args(scope), folder)
            if result.returncode != 0:
                detail = (result.stderr or result.stdout).strip()
                raise McpClientError(
                    "command_failed",
                    f"claude mcp add failed: {detail or 'unknown error'}",
                )
        else:
            path = _antigravity_path(scope, folder)
            data = _read_json(path)
            servers = _servers(data, path)
            servers[SERVER_NAME] = _entry(with_type=False)
            data["mcpServers"] = servers
            _write_json(path, data)
    except McpClientError as exc:
        status["error"] = {"code": exc.code, "message": exc.message}
        return status
    return get_status(client, scope, folder_raw, tool_count)


def remove(
    client: str, scope: str | None, folder_raw: str | None, tool_count: int
) -> dict:
    """Uninstall the MCP server from a client and return the new status."""
    status = get_status(client, scope, folder_raw, tool_count)
    scope = status["scope"]
    folder = _folder(folder_raw, required=_needs_folder(client, scope))
    if status["error"] or not status["installed"]:
        return status
    try:
        if client == "claude-code":
            result = _run_claude(
                ["mcp", "remove", SERVER_NAME, "--scope", scope], folder
            )
            if result.returncode != 0:
                detail = (result.stderr or result.stdout).strip()
                raise McpClientError(
                    "command_failed",
                    f"claude mcp remove failed: {detail or 'unknown error'}",
                )
        else:
            path = _antigravity_path(scope, folder)
            data = _read_json(path)
            servers = _servers(data, path)
            servers.pop(SERVER_NAME, None)
            data["mcpServers"] = servers
            _write_json(path, data)
    except McpClientError as exc:
        status["error"] = {"code": exc.code, "message": exc.message}
        return status
    return get_status(client, scope, folder_raw, tool_count)


def config_file(client: str, scope: str | None, folder_raw: str | None) -> Path:
    """Return the client's config file path for a scope."""
    scope = _scope_for(client, scope)
    folder = _folder(folder_raw, required=_needs_folder(client, scope))
    if client == "antigravity":
        return _antigravity_path(scope, folder)
    return _claude_stored(scope, folder)[0]


def open_file(path: Path) -> None:
    """Open a config file in the OS default editor."""
    if not path.exists():
        raise BadRequest(
            f"{path} doesn't exist yet. Install first, or create it yourself."
        )
    try:
        if sys.platform == "win32":
            os.startfile(str(path))  # type: ignore[attr-defined]
        else:
            subprocess.Popen(
                ["open" if sys.platform == "darwin" else "xdg-open", str(path)]
            )
    except OSError as exc:
        raise BadRequest(f"Couldn't open {path}: {exc}") from exc


async def test_connection(
    client: str, scope: str | None, folder_raw: str | None
) -> dict:
    """Start the installed server the way the client would and list its tools."""
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    scope = _scope_for(client, scope)
    folder = _folder(folder_raw, required=_needs_folder(client, scope))
    try:
        if client == "claude-code":
            entry = _claude_stored(scope, folder)[1]
        else:
            path = _antigravity_path(scope, folder)
            entry = _servers(_read_json(path), path).get(SERVER_NAME)
    except McpClientError as exc:
        return {"ok": False, "tool_count": 0, "message": exc.message}
    if not isinstance(entry, dict) or not entry.get("command"):
        return {
            "ok": False,
            "tool_count": 0,
            "message": "kanban isn't installed here yet.",
        }

    params = StdioServerParameters(
        command=str(entry["command"]),
        args=[str(a) for a in entry.get("args", [])],
        env={
            **os.environ,
            **{str(k): str(v) for k, v in (entry.get("env") or {}).items()},
        },
    )

    async def _probe() -> int:
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                return len((await session.list_tools()).tools)

    try:
        count = await asyncio.wait_for(_probe(), timeout=_TEST_TIMEOUT)
    except asyncio.TimeoutError:
        return {
            "ok": False,
            "tool_count": 0,
            "message": f"No answer within {_TEST_TIMEOUT} seconds.",
        }
    except Exception as exc:  # the server could not start or spoke nonsense
        return {
            "ok": False,
            "tool_count": 0,
            "message": f"Couldn't start the server: {exc}",
        }
    return {
        "ok": True,
        "tool_count": count,
        "message": f"Connected - {count} tools available",
    }
