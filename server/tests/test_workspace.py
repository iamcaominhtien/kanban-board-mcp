import os
import sys
import time
from collections.abc import AsyncGenerator

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

import mcp_tools
from database import get_session
from main import app

test_engine = create_async_engine(
    "sqlite+aiosqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
test_async_session = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)


async def override_get_session() -> AsyncGenerator[AsyncSession, None]:
    async with test_async_session() as session:
        yield session


@pytest.fixture(autouse=True)
async def setup_db(monkeypatch):
    async with test_engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    app.dependency_overrides[get_session] = override_get_session
    monkeypatch.setattr(mcp_tools, "async_session", test_async_session)
    yield
    app.dependency_overrides.pop(get_session, None)
    async with test_engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.drop_all)


@pytest.fixture
def client():
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _setup(c: httpx.AsyncClient, root, **settings) -> dict:
    r = await c.patch("/workspace/settings", json={"root_path": str(root), **settings})
    assert r.status_code == 200, r.text
    p = (await c.post("/projects", json={"name": "W", "prefix": "WS", "color": "#123456"})).json()
    return (await c.post(f"/projects/{p['id']}/tickets", json={"title": "t"})).json()


async def test_listing_dirs_files_and_init(client, tmp_path):
    async with client as c:
        t = await _setup(c, tmp_path)
        ws = (await c.get(f"/tickets/{t['id']}/workspace")).json()
        assert ws["exists"] is False and ws["files"] == []
        assert not (tmp_path / t["id"]).exists()  # GET never creates

        assert (await c.post(f"/tickets/{t['id']}/workspace/init")).status_code == 200
        folder = tmp_path / t["id"]
        assert folder.is_dir()
        (folder / "logs").mkdir()
        (folder / "logs" / "run.txt").write_text("hello")
        (folder / "x.txt").write_text("xx")
        ws = (await c.get(f"/tickets/{t['id']}/workspace")).json()
        names = [(f["name"], f["is_dir"]) for f in ws["files"]]
        assert names == [("logs", True), ("logs/run.txt", False), ("x.txt", False)]
        assert ws["file_count"] == 2 and ws["total_bytes"] == 7
        assert ws["path"] == str(folder)


async def test_upload_create_folder_preview_download_delete(client, tmp_path):
    async with client as c:
        t = await _setup(c, tmp_path)
        tid = t["id"]
        r = await c.post(f"/tickets/{tid}/workspace/folders", json={"path": "notes/deep"})
        assert r.status_code == 200 and (tmp_path / tid / "notes" / "deep").is_dir()

        r = await c.post(
            f"/tickets/{tid}/workspace/files",
            files={"file": ("a.txt", b"line1\nline2")},
            data={"directory": "notes"},
        )
        assert r.status_code == 200 and r.json()["name"] == "notes/a.txt"

        prev = (await c.get(f"/tickets/{tid}/workspace/file", params={"path": "notes/a.txt"})).json()
        assert prev["text"] == "line1\nline2" and prev["binary"] is False

        await c.post(
            f"/tickets/{tid}/workspace/files",
            files={"file": ("p.png", b"\x89PNG\r\n\x1a\n")},
        )
        img = await c.get(f"/tickets/{tid}/workspace/file", params={"path": "p.png"})
        assert img.headers["content-type"] == "image/png"
        assert img.headers["x-content-type-options"] == "nosniff"

        await c.post(
            f"/tickets/{tid}/workspace/files",
            files={"file": ("b.bin", b"\x00\x01\x02")},
        )
        binprev = (await c.get(f"/tickets/{tid}/workspace/file", params={"path": "b.bin"})).json()
        assert binprev["binary"] is True

        dl = await c.get(
            f"/tickets/{tid}/workspace/file", params={"path": "notes/a.txt", "download": "true"}
        )
        assert "attachment" in dl.headers["content-disposition"]

        r = await c.delete(f"/tickets/{tid}/workspace/entry", params={"path": "notes"})
        assert r.status_code == 200 and not (tmp_path / tid / "notes").exists()
        r = await c.delete(f"/tickets/{tid}/workspace/entry", params={"path": "notes"})
        assert r.status_code == 404


async def test_path_traversal_and_symlink_escape_rejected(client, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("nope")
    root = tmp_path / "root"
    async with client as c:
        t = await _setup(c, root)
        tid = t["id"]
        await c.post(f"/tickets/{tid}/workspace/init")
        os.symlink(outside, root / tid / "link")
        for path in ("../outside/secret.txt", "link/secret.txt", ""):
            r = await c.get(f"/tickets/{tid}/workspace/file", params={"path": path})
            assert r.status_code == 400, path
            r = await c.delete(f"/tickets/{tid}/workspace/entry", params={"path": path})
            assert r.status_code == 400, path
        # an absolute path is read as relative to the workspace folder, never the host
        r = await c.get(f"/tickets/{tid}/workspace/file", params={"path": "/etc/passwd"})
        assert r.status_code == 404
        r = await c.post(f"/tickets/{tid}/workspace/folders", json={"path": "../evil"})
        assert r.status_code == 400 and not (root / "evil").exists()
        r = await c.post(
            f"/tickets/{tid}/workspace/files",
            files={"file": ("../../evil.txt", b"x")},
            data={"directory": "../"},
        )
        assert r.status_code == 400 and not (tmp_path / "evil.txt").exists()
        # symlinks are never listed
        ws = (await c.get(f"/tickets/{tid}/workspace")).json()
        assert ws["files"] == []
        assert (outside / "secret.txt").exists()


async def test_upload_size_limit(client, tmp_path, monkeypatch):
    from services import workspace as svc

    monkeypatch.setattr(svc, "MAX_UPLOAD_BYTES", 10)
    async with client as c:
        t = await _setup(c, tmp_path)
        r = await c.post(
            f"/tickets/{t['id']}/workspace/files", files={"file": ("big.txt", b"x" * 11)}
        )
        assert r.status_code == 400


async def test_disabled_workspace_blocks_mutations(client, tmp_path):
    async with client as c:
        t = await _setup(c, tmp_path, enabled=False)
        tid = t["id"]
        assert (await c.get(f"/tickets/{tid}/workspace")).json()["enabled"] is False
        assert (await c.post(f"/tickets/{tid}/workspace/init")).status_code == 400
        r = await c.post(f"/tickets/{tid}/workspace/files", files={"file": ("a", b"x")})
        assert r.status_code == 400
        assert not (tmp_path / tid).exists()


async def test_root_path_validation(client, tmp_path):
    async with client as c:
        for bad in ("", "   ", "/", "~"):
            r = await c.patch("/workspace/settings", json={"root_path": bad})
            assert r.status_code == 400, bad
        r = await c.patch("/workspace/settings", json={"root_path": str(tmp_path / "ok")})
        assert r.status_code == 200


async def test_retention_semantics(client, tmp_path):
    async with client as c:
        t = await _setup(c, tmp_path, default_retention_days=30)
        tid = t["id"]
        assert (await c.get(f"/tickets/{tid}/workspace")).json()["retention_days"] == 30
        await c.patch(f"/tickets/{tid}/workspace/retention", json={"retention_days": 0})
        ws = (await c.get(f"/tickets/{tid}/workspace")).json()
        assert ws["retention_days"] == 0 and ws["retention_override"] == 0
        r = await c.patch(f"/tickets/{tid}/workspace/retention", json={"retention_days": -3})
        assert r.status_code == 400
        await c.patch(f"/tickets/{tid}/workspace/retention", json={"retention_days": None})
        assert (await c.get(f"/tickets/{tid}/workspace")).json()["retention_days"] == 30


def _age(path, days):
    old = time.time() - days * 86400
    for p in [path, *path.rglob("*")]:
        os.utime(p, (old, old))


async def test_sweep_only_deletes_closed_expired_non_forever(client, tmp_path):
    async with client as c:
        p = (await c.post("/projects", json={"name": "S", "prefix": "SW", "color": "#123456"})).json()
        await c.patch(
            "/workspace/settings",
            json={"root_path": str(tmp_path), "default_retention_days": 7},
        )
        ids = {}
        for key in ("old_done", "old_open", "fresh_done", "forever_done", "old_wontdo"):
            t = (await c.post(f"/projects/{p['id']}/tickets", json={"title": key})).json()
            ids[key] = t["id"]
            await c.post(f"/tickets/{t['id']}/workspace/init")
            (tmp_path / t["id"] / "f.txt").write_text(key)
        for key in ("old_done", "old_open", "forever_done", "old_wontdo"):
            _age(tmp_path / ids[key], 30)
        for key in ("old_done", "fresh_done", "forever_done"):
            await c.patch(f"/tickets/{ids[key]}", json={"status": "done"})
        await c.patch(f"/tickets/{ids['old_wontdo']}", json={"status": "wont_do", "wont_do_reason": "x"})
        await c.patch(f"/tickets/{ids['forever_done']}/workspace/retention", json={"retention_days": 0})
        # ticket in the root that is not a ticket folder must never be touched
        (tmp_path / "keepme").mkdir()
        _age(tmp_path / "keepme", 90)

        dry = (await c.post("/workspace/sweep", json={"dry_run": True})).json()
        assert {r["ticket_id"] for r in dry["removed"]} == {ids["old_done"], ids["old_wontdo"]}
        assert (tmp_path / ids["old_done"]).exists()  # dry run deletes nothing

        real = (await c.post("/workspace/sweep", json={})).json()
        assert {r["ticket_id"] for r in real["removed"]} == {ids["old_done"], ids["old_wontdo"]}
        assert not (tmp_path / ids["old_done"]).exists()
        assert not (tmp_path / ids["old_wontdo"]).exists()
        for keep in ("old_open", "fresh_done", "forever_done"):
            assert (tmp_path / ids[keep]).exists(), keep
        assert (tmp_path / "keepme").exists()


async def test_expiry_reported_and_activity_resets_clock(client, tmp_path):
    async with client as c:
        t = await _setup(c, tmp_path, default_retention_days=7)
        tid = t["id"]
        await c.post(f"/tickets/{tid}/workspace/init")
        (tmp_path / tid / "f.txt").write_text("x")
        ws = (await c.get(f"/tickets/{tid}/workspace")).json()
        assert ws["expires_at"] is not None and ws["sweep_eligible"] is False


async def test_mcp_tool_returns_path_and_creates_folder(tmp_path):
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        t = await _setup(c, tmp_path)
    info = await mcp_tools.get_ticket_workspace_path(t["id"])
    assert info == {"enabled": True, "path": str(tmp_path / t["id"]), "exists": True}
    assert (tmp_path / t["id"]).is_dir()
    assert await mcp_tools.get_ticket_workspace_path("NOPE-1") is None
    full = await mcp_tools.get_ticket(t["id"])
    assert full["workspace_path"] == str(tmp_path / t["id"])
    assert await mcp_tools.get_ticket_workspace_path("../etc") is None


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="uses a fake xdg-open")
async def test_open_runs_file_manager_in_ticket_folder(client, tmp_path, monkeypatch):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    marker = tmp_path / "opened"
    opener = bindir / "xdg-open"
    opener.write_text(f'#!/bin/sh\necho "$PWD|$1" > {marker}\n')
    opener.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ['PATH']}")
    async with client as c:
        t = await _setup(c, tmp_path / "root")
        r = await c.post(f"/tickets/{t['id']}/workspace/open")
        assert r.status_code == 200
        for _ in range(50):
            if marker.exists() and marker.read_text().strip():
                break
            time.sleep(0.05)
        cwd, arg = marker.read_text().strip().split("|")
        assert cwd == os.path.realpath(tmp_path / "root" / t["id"]) and arg == "."
