"""Settings → MCP clients: register the Kanban MCP server in Claude Code / Antigravity configs."""
import json

import httpx
import pytest
from httpx import ASGITransport

from main import app


@pytest.fixture
def client():
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.fixture
def fake_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr("pathlib.Path.home", classmethod(lambda cls: home))
    return home


async def test_status_is_not_installed_when_no_config(client, fake_home):
    async with client as c:
        r = await c.get("/settings/mcp-clients")
    assert r.status_code == 200
    assert {x["id"]: x["installed"] for x in r.json()} == {"claude-code": False, "antigravity": False}


async def test_install_claude_code_preserves_other_keys(client, fake_home):
    cfg = fake_home / ".claude.json"
    cfg.write_text(json.dumps({"theme": "dark", "mcpServers": {"other": {"command": "x"}}}))
    async with client as c:
        r = await c.post("/settings/mcp-clients/claude-code")
    assert r.status_code == 200
    assert r.json()["installed"] and r.json()["up_to_date"]
    data = json.loads(cfg.read_text())
    assert data["theme"] == "dark"
    assert data["mcpServers"]["other"] == {"command": "x"}
    assert data["mcpServers"]["kanban-board"]["type"] == "stdio"
    assert "KANBAN_DB_PATH" in data["mcpServers"]["kanban-board"]["env"]


async def test_install_antigravity_creates_file_without_type(client, fake_home):
    async with client as c:
        r = await c.post("/settings/mcp-clients/antigravity")
    assert r.status_code == 200
    cfg = fake_home / ".gemini" / "antigravity" / "mcp_config.json"
    entry = json.loads(cfg.read_text())["mcpServers"]["kanban-board"]
    assert "type" not in entry and entry["command"]


async def test_uninstall_removes_only_our_entry(client, fake_home):
    async with client as c:
        await c.post("/settings/mcp-clients/antigravity")
        cfg = fake_home / ".gemini" / "antigravity" / "mcp_config.json"
        data = json.loads(cfg.read_text())
        data["mcpServers"]["other"] = {"command": "x"}
        cfg.write_text(json.dumps(data))
        r = await c.delete("/settings/mcp-clients/antigravity")
    assert r.json()["installed"] is False
    assert list(json.loads(cfg.read_text())["mcpServers"]) == ["other"]


async def test_corrupt_config_is_never_overwritten(client, fake_home):
    cfg = fake_home / ".claude.json"
    cfg.write_text("{not json")
    async with client as c:
        r = await c.post("/settings/mcp-clients/claude-code")
    assert r.status_code == 409
    assert cfg.read_text() == "{not json"


async def test_unknown_client_404(client, fake_home):
    async with client as c:
        r = await c.post("/settings/mcp-clients/nope")
    assert r.status_code == 404
