"""Settings -> MCP integrations: install the kanban MCP server into Claude Code / Antigravity."""

import json
import os
import shutil
import stat
import sys

import httpx
import pytest
from httpx import ASGITransport

from main import app

FAKE_CLAUDE = """#!{python}
import json, os, sys
home = os.environ["FAKE_HOME"]
path = os.path.join(home, ".claude.json")
data = json.load(open(path)) if os.path.exists(path) else {{}}
args = sys.argv[1:]
if os.environ.get("FAKE_CLAUDE_FAIL"):
    print("boom", file=sys.stderr); sys.exit(1)
scope = args[args.index("--scope") + 1]
if args[:2] == ["mcp", "add"]:
    if "kanban" in data.get("mcpServers", {{}}):
        print("already exists", file=sys.stderr); sys.exit(1)
    cmd = args[args.index("--") + 1:]
    data.setdefault("mcpServers", {{}})["kanban"] = {{"type": "stdio", "command": cmd[0], "args": cmd[1:]}}
elif args[:2] == ["mcp", "remove"]:
    data.get("mcpServers", {{}}).pop("kanban", None)
json.dump(data, open(path, "w"))
"""


@pytest.fixture
def client():
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.fixture
def fake_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr("pathlib.Path.home", classmethod(lambda cls: home))
    monkeypatch.setenv("FAKE_HOME", str(home))
    uv_dir = os.path.dirname(shutil.which("uv") or "/usr/bin/uv")
    monkeypatch.setenv("PATH", f"{uv_dir}:/usr/bin:/bin")  # keep uv, no real claude
    import services.mcp_clients as mc

    monkeypatch.setattr(mc, "find_claude", lambda: shutil.which("claude"))
    return home


@pytest.fixture
def fake_claude(fake_home, tmp_path, monkeypatch):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    script = bindir / "claude"
    script.write_text(FAKE_CLAUDE.format(python=sys.executable))
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{bindir}:{os.environ['PATH']}")
    return script


def _new():
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _get(client, cid, **params):
    async with _new() as c:
        return await c.get(f"/settings/mcp-clients/{cid}", params=params)


async def _post(client, cid, action, **body):
    async with _new() as c:
        return await c.post(f"/settings/mcp-clients/{cid}/{action}", json=body)


# ---- Claude Code


async def test_claude_not_detected_without_cli(client, fake_home):
    r = await _get(client, "claude-code")
    s = r.json()
    assert r.status_code == 200
    assert s["detected"] is False and s["installed"] is False
    assert s["command"].startswith(
        "claude mcp add kanban --transport stdio --scope user"
    )
    assert s["stored_in"] == "~/.claude.json"
    assert s["tool_count"] > 0


async def test_claude_install_without_cli_reports_error_and_changes_nothing(
    client, fake_home
):
    r = await _post(client, "claude-code", "install", scope="user")
    assert r.status_code == 200
    assert r.json()["error"]["code"] == "claude_not_found"
    assert not (fake_home / ".claude.json").exists()


async def test_claude_install_reinstall_remove(client, fake_claude, fake_home):
    r = await _post(client, "claude-code", "install", scope="user")
    s = r.json()
    assert s["error"] is None and s["installed"] and not s["update_available"]
    entry = json.loads((fake_home / ".claude.json").read_text())["mcpServers"]["kanban"]
    assert entry["command"]

    again = await _post(
        client, "claude-code", "install", scope="user"
    )  # replaces, no duplicate
    assert again.json()["error"] is None and again.json()["installed"]

    gone = await _post(client, "claude-code", "remove", scope="user")
    assert gone.json()["installed"] is False
    assert (
        "kanban"
        not in json.loads((fake_home / ".claude.json").read_text())["mcpServers"]
    )


async def test_claude_stale_entry_is_update_available(client, fake_claude, fake_home):
    (fake_home / ".claude.json").write_text(
        json.dumps(
            {
                "mcpServers": {
                    "kanban": {"type": "stdio", "command": "/old/path", "args": []}
                }
            }
        )
    )
    s = (await _get(client, "claude-code", scope="user")).json()
    assert s["installed"] and s["update_available"]
    assert s["installed_command"] == "/old/path"


async def test_claude_cli_failure_is_reported(
    client, fake_claude, fake_home, monkeypatch
):
    monkeypatch.setenv("FAKE_CLAUDE_FAIL", "1")
    s = (await _post(client, "claude-code", "install", scope="user")).json()
    assert s["error"]["code"] == "command_failed" and "boom" in s["error"]["message"]


async def test_claude_project_scope_needs_a_folder(client, fake_claude, fake_home):
    s = (await _get(client, "claude-code", scope="project")).json()
    assert s["needs_folder"] is True
    r = await _post(client, "claude-code", "install", scope="project")
    assert r.status_code == 400


async def test_claude_project_scope_reads_mcp_json(
    client, fake_claude, fake_home, tmp_path
):
    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / ".mcp.json").write_text(
        json.dumps({"mcpServers": {"kanban": {"command": "x", "args": []}}})
    )
    s = (await _get(client, "claude-code", scope="project", folder=str(proj))).json()
    assert s["installed"] and s["stored_in"].endswith(".mcp.json")


# ---- Antigravity


async def test_antigravity_install_global_merges_and_keeps_others(client, fake_home):
    cfg = fake_home / ".gemini" / "config" / "mcp_config.json"
    cfg.parent.mkdir(parents=True)
    cfg.write_text(
        json.dumps({"theme": "x", "mcpServers": {"other": {"command": "x"}}})
    )
    s = (await _post(client, "antigravity", "install", scope="global")).json()
    assert s["error"] is None and s["installed"] and s["detected"]
    data = json.loads(cfg.read_text())
    assert data["theme"] == "x" and data["mcpServers"]["other"] == {"command": "x"}
    assert (
        "type" not in data["mcpServers"]["kanban"]
        and data["mcpServers"]["kanban"]["command"]
    )


async def test_antigravity_workspace_scope(client, fake_home, tmp_path):
    proj = tmp_path / "proj"
    proj.mkdir()
    s = (
        await _post(
            client, "antigravity", "install", scope="workspace", folder=str(proj)
        )
    ).json()
    assert s["installed"]
    assert (
        "kanban"
        in json.loads((proj / ".agents" / "mcp_config.json").read_text())["mcpServers"]
    )


async def test_antigravity_remove_only_ours(client, fake_home):
    await _post(client, "antigravity", "install", scope="global")
    cfg = fake_home / ".gemini" / "config" / "mcp_config.json"
    data = json.loads(cfg.read_text())
    data["mcpServers"]["other"] = {"command": "x"}
    cfg.write_text(json.dumps(data))
    s = (await _post(client, "antigravity", "remove", scope="global")).json()
    assert s["installed"] is False
    assert list(json.loads(cfg.read_text())["mcpServers"]) == ["other"]


async def test_antigravity_corrupt_file_never_overwritten(client, fake_home):
    cfg = fake_home / ".gemini" / "config" / "mcp_config.json"
    cfg.parent.mkdir(parents=True)
    cfg.write_text("{not json")
    s = (await _post(client, "antigravity", "install", scope="global")).json()
    assert s["error"]["code"] == "invalid_json"
    assert cfg.read_text() == "{not json"


async def test_antigravity_write_failure_names_the_file(client, fake_home, monkeypatch):
    def deny(*a, **k):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr("services.mcp_clients.os.replace", deny)
    s = (await _post(client, "antigravity", "install", scope="global")).json()
    assert (
        s["error"]["code"] == "write_failed"
        and "Permission denied" in s["error"]["message"]
    )
    assert s["entry_json"]  # the manual fallback stays available


async def test_unknown_client_and_scope_are_400(client, fake_home):
    assert (await _get(client, "nope")).status_code == 400
    assert (await _get(client, "antigravity", scope="user")).status_code == 400


async def test_test_connection_requires_install(client, fake_home):
    r = await _post(client, "antigravity", "test", scope="global")
    assert r.json()["ok"] is False


async def test_test_connection_starts_the_real_server(client, fake_home):
    await _post(client, "antigravity", "install", scope="global")
    r = await _post(client, "antigravity", "test", scope="global")
    assert r.json()["ok"] is True, r.json()
    assert r.json()["tool_count"] > 0
