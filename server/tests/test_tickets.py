from collections.abc import AsyncGenerator

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from main import app

DATABASE_URL_TEST = "sqlite+aiosqlite:///:memory:"

test_engine = create_async_engine(DATABASE_URL_TEST, echo=False)
test_async_session = sessionmaker(
    test_engine, class_=AsyncSession, expire_on_commit=False
)


async def override_get_session() -> AsyncGenerator[AsyncSession, None]:
    async with test_async_session() as session:
        yield session


@pytest.fixture(autouse=True)
async def setup_db():
    async with test_engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    app.dependency_overrides[get_session] = override_get_session
    yield
    app.dependency_overrides.pop(get_session, None)
    async with test_engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.drop_all)


@pytest.fixture
def client():
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _create_project(c: httpx.AsyncClient, prefix: str = "TST") -> dict:
    r = await c.post(
        "/projects", json={"name": "Test Project", "prefix": prefix, "color": "#123456"}
    )
    assert r.status_code == 201
    return r.json()


async def _create_ticket(
    c: httpx.AsyncClient, project_id: str, title: str = "My ticket", **kwargs
) -> dict:
    body = {"title": title, **kwargs}
    r = await c.post(f"/projects/{project_id}/tickets", json=body)
    assert r.status_code == 201
    return r.json()


# ---------------------------------------------------------------------------
# Core CRUD
# ---------------------------------------------------------------------------


async def test_create_ticket_appears_in_list(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"], "First ticket")
        r = await c.get(f"/projects/{project['id']}/tickets")
    assert r.status_code == 200
    tickets = r.json()
    assert len(tickets) == 1
    assert tickets[0]["id"] == ticket["id"]
    assert tickets[0]["title"] == "First ticket"


async def test_get_ticket_404_if_missing(client: httpx.AsyncClient):
    async with client as c:
        r = await c.get("/tickets/DOESNOTEXIST-999")
    assert r.status_code == 404


async def test_update_ticket_title_logs_activity(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"], "Old title")
        r = await c.patch(f"/tickets/{ticket['id']}", json={"title": "New title"})
    assert r.status_code == 200
    body = r.json()
    assert body["title"] == "New title"
    assert any(
        e["field"] == "title" and e["from"] == "Old title" and e["to"] == "New title"
        for e in body["activity_log"]
    )


async def test_update_ticket_status_logs_activity(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])
        r = await c.patch(f"/tickets/{ticket['id']}", json={"status": "in-progress"})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "in-progress"
    assert any(
        e["field"] == "status" and e["to"] == "in-progress"
        for e in body["activity_log"]
    )


async def test_delete_ticket_then_404(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])
        r_del = await c.delete(f"/tickets/{ticket['id']}")
        assert r_del.status_code == 204
        r_get = await c.get(f"/tickets/{ticket['id']}")
    assert r_get.status_code == 404


async def test_quick_status_patch(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])
        r = await c.patch(f"/tickets/{ticket['id']}/status", json={"status": "done"})
    assert r.status_code == 200
    assert r.json()["status"] == "done"


# ---------------------------------------------------------------------------
# Parent / child nesting
# ---------------------------------------------------------------------------


async def test_create_child_ticket(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        parent = await _create_ticket(c, project["id"], "Parent")
        child = await _create_ticket(c, project["id"], "Child", parent_id=parent["id"])
    assert child["parent_id"] == parent["id"]


async def test_create_child_of_child_returns_400(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        parent = await _create_ticket(c, project["id"], "Parent")
        child = await _create_ticket(c, project["id"], "Child", parent_id=parent["id"])
        r = await c.post(
            f"/projects/{project['id']}/tickets",
            json={"title": "Grandchild", "parent_id": child["id"]},
        )
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# Comments
# ---------------------------------------------------------------------------


async def test_add_and_delete_comment(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])

        r_add = await c.post(
            f"/tickets/{ticket['id']}/comments",
            json={"text": "Hello", "author": "alice"},
        )
        assert r_add.status_code == 200
        comments = r_add.json()["comments"]
        assert len(comments) == 1
        assert comments[0]["text"] == "Hello"
        comment_id = comments[0]["id"]

        r_del = await c.delete(f"/tickets/{ticket['id']}/comments/{comment_id}")
    assert r_del.status_code == 200
    assert r_del.json()["comments"] == []


# ---------------------------------------------------------------------------
# Acceptance criteria
# ---------------------------------------------------------------------------


async def test_add_toggle_delete_acceptance_criterion(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])

        r_add = await c.post(
            f"/tickets/{ticket['id']}/acceptance-criteria", json={"text": "It works"}
        )
        assert r_add.status_code == 200
        acs = r_add.json()["acceptance_criteria"]
        assert len(acs) == 1
        assert acs[0]["done"] is False
        ac_id = acs[0]["id"]

        r_toggle = await c.patch(
            f"/tickets/{ticket['id']}/acceptance-criteria/{ac_id}/toggle"
        )
        assert r_toggle.status_code == 200
        ac_after = r_toggle.json()["acceptance_criteria"][0]
        assert ac_after["done"] is True

        r_del = await c.delete(f"/tickets/{ticket['id']}/acceptance-criteria/{ac_id}")
    assert r_del.status_code == 200
    assert r_del.json()["acceptance_criteria"] == []


# ---------------------------------------------------------------------------
# Work log
# ---------------------------------------------------------------------------


async def test_add_work_log(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])
        r = await c.post(
            f"/tickets/{ticket['id']}/work-log",
            json={"author": "bob", "role": "dev", "note": "Did stuff"},
        )
    assert r.status_code == 200
    wl = r.json()["work_log"]
    assert len(wl) == 1
    assert wl[0]["note"] == "Did stuff"


async def test_delete_work_log(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])
        r_add = await c.post(
            f"/tickets/{ticket['id']}/work-log",
            json={"author": "alice", "role": "qa", "note": "Reviewed"},
        )
        assert r_add.status_code == 200
        log_id = r_add.json()["work_log"][0]["id"]
        r_del = await c.delete(f"/tickets/{ticket['id']}/work-log/{log_id}")
    assert r_del.status_code == 200
    assert r_del.json()["work_log"] == []


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------


async def test_add_update_delete_test_case(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])

        r_add = await c.post(
            f"/tickets/{ticket['id']}/test-cases",
            json={"title": "TC1", "status": "pending"},
        )
        assert r_add.status_code == 200
        tcs = r_add.json()["test_cases"]
        assert len(tcs) == 1
        tc_id = tcs[0]["id"]
        assert tcs[0]["status"] == "pending"

        r_upd = await c.patch(
            f"/tickets/{ticket['id']}/test-cases/{tc_id}",
            json={"status": "pass", "proof": "screenshot.png"},
        )
        assert r_upd.status_code == 200
        tc_after = r_upd.json()["test_cases"][0]
        assert tc_after["status"] == "pass"
        assert tc_after["proof"] == "screenshot.png"

        r_del = await c.delete(f"/tickets/{ticket['id']}/test-cases/{tc_id}")
    assert r_del.status_code == 200
    assert r_del.json()["test_cases"] == []


# ---------------------------------------------------------------------------
# List with filters
# ---------------------------------------------------------------------------


async def test_list_tickets_with_status_filter(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        t1 = await _create_ticket(c, project["id"], "Backlog ticket")
        await c.patch(f"/tickets/{t1['id']}/status", json={"status": "done"})
        await _create_ticket(c, project["id"], "Another backlog ticket")

        r = await c.get(f"/projects/{project['id']}/tickets", params={"status": "done"})
    assert r.status_code == 200
    results = r.json()
    assert len(results) == 1
    assert results[0]["status"] == "done"


# ---------------------------------------------------------------------------
# Wont Do status
# ---------------------------------------------------------------------------


async def test_set_wont_do_requires_reason(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])
        r = await c.patch(f"/tickets/{ticket['id']}", json={"status": "wont_do"})
    assert r.status_code == 400
    assert "wont_do_reason" in r.json()["detail"]


async def test_set_wont_do_with_reason(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])
        r = await c.patch(
            f"/tickets/{ticket['id']}",
            json={"status": "wont_do", "wont_do_reason": "Out of scope"},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "wont_do"
    assert body["wont_do_reason"] == "Out of scope"


async def test_wont_do_tickets_excluded_by_default(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        t1 = await _create_ticket(c, project["id"], "Normal ticket")
        t2 = await _create_ticket(c, project["id"], "Wont do ticket")
        await c.patch(
            f"/tickets/{t2['id']}",
            json={"status": "wont_do", "wont_do_reason": "Not needed"},
        )
        r_default = await c.get(f"/projects/{project['id']}/tickets")
        r_include = await c.get(
            f"/projects/{project['id']}/tickets", params={"include_wont_do": "true"}
        )
    assert r_default.status_code == 200
    default_ids = [t["id"] for t in r_default.json()]
    assert t1["id"] in default_ids
    assert t2["id"] not in default_ids

    all_ids = [t["id"] for t in r_include.json()]
    assert t1["id"] in all_ids
    assert t2["id"] in all_ids
