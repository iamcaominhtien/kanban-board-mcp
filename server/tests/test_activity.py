import subprocess
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


async def _ticket(c, title="t", prefix="ACT", **kw):
    p = (await c.post("/projects", json={"name": prefix, "prefix": prefix, "color": "#123456"})).json()
    r = await c.post(f"/projects/{p['id']}/tickets", json={"title": title, **kw})
    assert r.status_code == 201, r.text
    return p, r.json()


async def _log(c, tid):
    return (await c.get(f"/tickets/{tid}")).json()["activity_log"]


def _fields(log):
    return [e["field"] for e in log]


async def test_created_entry_and_default_actor(client):
    async with client as c:
        _, t = await _ticket(c, "Hello")
        log = await _log(c, t["id"])
        assert len(log) == 1
        assert log[0]["field"] == "created" and log[0]["ref"] == "Hello"
        assert log[0]["actor"] == "user" and log[0]["at"]


async def test_x_actor_header_attributes_the_change(client):
    async with client as c:
        _, t = await _ticket(c)
        await c.patch(f"/tickets/{t['id']}", json={"priority": "high"}, headers={"X-Actor": "An Nguyen"})
        await c.patch(f"/tickets/{t['id']}", json={"title": "New"})
        log = await _log(c, t["id"])
        assert [(e["field"], e["actor"]) for e in log[-2:]] == [("priority", "An Nguyen"), ("title", "user")]


async def test_comment_lifecycle_uses_author_as_actor(client):
    async with client as c:
        _, t = await _ticket(c)
        tid = t["id"]
        r = await c.post(f"/tickets/{tid}/comments", json={"text": "first", "author": "Bao"})
        cid = r.json()["comments"][0]["id"]
        await c.patch(f"/tickets/{tid}/comments/{cid}", json={"text": "edited"})
        await c.patch(f"/tickets/{tid}/comments/{cid}", json={"text": "edited"})  # no-op
        await c.delete(f"/tickets/{tid}/comments/{cid}")
        log = [e for e in await _log(c, tid) if e["field"] == "comment"]
        assert [(e["from"], e["to"]) for e in log] == [(None, "first"), ("first", "edited"), ("edited", None)]
        assert log[0]["actor"] == "Bao" and log[1]["actor"] == "user"


async def test_long_text_is_clipped(client):
    async with client as c:
        _, t = await _ticket(c)
        await c.post(f"/tickets/{t['id']}/comments", json={"text": "x" * 5000})
        e = [e for e in await _log(c, t["id"]) if e["field"] == "comment"][0]
        assert len(e["to"]) == 200 and e["to"].endswith("…")


async def test_acceptance_criteria_work_log_and_test_cases(client):
    async with client as c:
        _, t = await _ticket(c)
        tid = t["id"]
        ac = (await c.post(f"/tickets/{tid}/acceptance-criteria", json={"text": "works"})).json()["acceptance_criteria"][0]["id"]
        await c.patch(f"/tickets/{tid}/acceptance-criteria/{ac}/toggle")
        await c.patch(f"/tickets/{tid}/acceptance-criteria/{ac}/toggle")
        await c.delete(f"/tickets/{tid}/acceptance-criteria/{ac}")

        lg = (await c.post(f"/tickets/{tid}/work-log", json={"author": "Chi", "role": "Developer", "note": "did"})).json()["work_log"][0]["id"]
        await c.patch(f"/tickets/{tid}/work-log/{lg}", json={"note": "did more"})
        await c.patch(f"/tickets/{tid}/work-log/{lg}", json={"pinned": True})  # not a note change
        await c.delete(f"/tickets/{tid}/work-log/{lg}")

        tc = (await c.post(f"/tickets/{tid}/test-cases", json={"title": "login"})).json()["test_cases"][0]["id"]
        await c.patch(f"/tickets/{tid}/test-cases/{tc}", json={"status": "pass"})
        await c.patch(f"/tickets/{tid}/test-cases/{tc}", json={"status": "pass"})  # no-op
        await c.patch(f"/tickets/{tid}/test-cases/{tc}", json={"title": "login v2"})
        await c.delete(f"/tickets/{tid}/test-cases/{tc}")

        log = await _log(c, tid)
        by = lambda f: [(e["from"], e["to"]) for e in log if e["field"] == f]  # noqa: E731
        assert by("acceptance_criterion") == [(None, "works"), ("open", "done"), ("done", "open"), ("works", None)]
        assert by("work_log") == [(None, "did"), ("did", "did more"), ("did more", None)]
        assert [e["actor"] for e in log if e["field"] == "work_log"][0] == "Chi"
        assert by("test_case_status") == [("pending", "pass")]
        assert [e["ref"] for e in log if e["field"] == "test_case_status"] == ["TC-1 login"]
        assert by("test_case") == [(None, "login"), ("login", "login v2"), ("login v2", None)]


async def test_blocks_and_links_are_logged_on_both_tickets(client):
    async with client as c:
        p, a = await _ticket(c, "A", prefix="LNK")
        b = (await c.post(f"/projects/{p['id']}/tickets", json={"title": "B"})).json()
        await c.post(f"/tickets/{a['id']}/blocks/{b['id']}")
        await c.post(f"/tickets/{a['id']}/blocks/{b['id']}")  # already linked: no second entry
        link = (await c.post(f"/tickets/{a['id']}/links", json={"target_id": b["id"], "relation_type": "causes"})).json()
        la, lb = await _log(c, a["id"]), await _log(c, b["id"])
        assert [(e["field"], e["to"]) for e in la if e["field"] in ("blocks", "link")] == [("blocks", b["id"]), ("link", f"causes {b['id']}")]
        assert [(e["field"], e["to"]) for e in lb if e["field"] in ("blocked_by", "link")] == [("blocked_by", a["id"]), ("link", f"caused by {a['id']}")]
        await c.delete(f"/tickets/{a['id']}/links/{link['id']}")
        await c.delete(f"/tickets/{a['id']}/blocks/{b['id']}")
        la, lb = await _log(c, a["id"]), await _log(c, b["id"])
        assert ("link", f"causes {b['id']}", None) in [(e["field"], e["from"], e["to"]) for e in la]
        assert ("link", f"caused by {a['id']}", None) in [(e["field"], e["from"], e["to"]) for e in lb]
        assert ("blocked_by", a["id"], None) in [(e["field"], e["from"], e["to"]) for e in lb]


async def test_parent_wont_do_reason_repo_and_retention(client, tmp_path):
    async with client as c:
        p, parent = await _ticket(c, "Parent", prefix="PAR")
        child = (await c.post(f"/projects/{p['id']}/tickets", json={"title": "Child"})).json()
        cid = child["id"]
        await c.patch(f"/tickets/{cid}", json={"parent_id": parent["id"]})
        solo = (await c.post(f"/projects/{p['id']}/tickets", json={"title": "Solo"})).json()["id"]
        r = await c.patch(f"/tickets/{solo}", json={"status": "wont_do", "wont_do_reason": "not needed"})
        assert r.status_code == 200, r.text
        await c.patch(f"/tickets/{solo}", json={"status": "todo"})  # reason is cleared silently
        solo_log = await _log(c, solo)
        assert [(e["from"], e["to"]) for e in solo_log if e["field"] == "wont_do_reason"] == [(None, "not needed")]
        await c.patch("/workspace/settings", json={"root_path": str(tmp_path)})
        await c.patch(f"/tickets/{cid}/workspace/retention", json={"retention_days": 7})
        await c.patch(f"/tickets/{cid}/workspace/retention", json={"retention_days": 0})
        await c.patch(f"/tickets/{cid}/workspace/retention", json={"retention_days": None})
        log = await _log(c, cid)
        by = lambda f: [(e["from"], e["to"]) for e in log if e["field"] == f]  # noqa: E731
        assert by("parent_id") == [(None, parent["id"])]
        assert by("workspace_retention") == [("default", "7 days"), ("7 days", "forever"), ("forever", "default")]


@pytest.fixture
def repo_dir(tmp_path):
    def git(*args):
        subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True)

    git("init", "-b", "main")
    git("config", "user.email", "t@example.com")
    git("config", "user.name", "T")
    (tmp_path / "a.txt").write_text("a")
    git("add", ".")
    git("commit", "-m", "init")
    return tmp_path


async def test_branch_lifecycle_is_logged(client, repo_dir):
    async with client as c:
        p, t = await _ticket(c, prefix="BRN")
        await c.patch(f"/projects/{p['id']}", json={"repo_path": str(repo_dir)})
        tid = t["id"]
        br = (await c.post(f"/tickets/{tid}/branches", json={"name": "feat/a", "branch_from": "main"})).json()["branches"][-1]
        await c.post(f"/tickets/{tid}/branches/{br['id']}/checkout")
        r = await c.patch(f"/tickets/{tid}/branches/{br['id']}", json={"name": "feat/b"})
        assert r.status_code == 200, r.text
        r = await c.patch(f"/tickets/{tid}/branches/{br['id']}", json={"status": "archived"})
        assert r.status_code == 200, r.text
        await c.post(f"/tickets/{tid}/branches/{br['id']}/checkout")  # re-checkout is logged again
        await c.patch(f"/tickets/{tid}/branches/{br['id']}", json={"status": "archived"})  # unchanged
        await c.delete(f"/tickets/{tid}/branches/{br['id']}")
        log = await _log(c, tid)
        got = [(e["field"], e["from"], e["to"]) for e in log if e["field"].startswith("branch")]
        assert ("branch", None, "feat/a") in got
        assert ("branch_checkout", None, "feat/a") in got
        assert ("branch", "feat/a", "feat/b") in got
        assert [g for g in got if g[0] == "branch_status"] == [("branch_status", "open", "archived")]
        assert ("branch", "feat/b", None) in got


async def test_mcp_changes_are_attributed_to_the_agent(client):
    async with client as c:
        _, t = await _ticket(c)
    await mcp_tools.update_ticket_status(t["id"], "in-progress")
    await mcp_tools.add_comment(t["id"], "from agent", "claude")
    await mcp_tools.add_comment(t["id"], "default author", "user")
    async with httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        log = await _log(c, t["id"])
        await c.patch(f"/tickets/{t['id']}", json={"priority": "low"})
        log2 = await _log(c, t["id"])
    got = {(e["field"], e["to"]): e["actor"] for e in log}
    assert got[("status", "in-progress")] == "agent"
    assert got[("comment", "from agent")] == "claude"
    assert got[("comment", "default author")] == "agent"
    assert log2[-1]["actor"] == "user"  # the agent actor did not leak into later REST calls


async def test_project_timeline_does_not_duplicate_created_or_comment(client):
    async with client as c:
        p, t = await _ticket(c, prefix="TML")
        await c.post(f"/tickets/{t['id']}/comments", json={"text": "hi"})
        await c.patch(f"/tickets/{t['id']}", json={"priority": "high"})
        events = (await c.get(f"/projects/{p['id']}/activities")).json()
        kinds = [e["event_type"] for e in events]
        assert kinds.count("created") == 1 and kinds.count("commented") == 1
        assert "changed:created" not in kinds and "changed:comment" not in kinds
        assert "changed:priority" in kinds
