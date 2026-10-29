import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from main import app
from tests.fast_db import fresh_tables

test_engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
test_async_session = sessionmaker(
    test_engine, class_=AsyncSession, expire_on_commit=False
)


async def override_get_session():
    async with test_async_session() as session:
        yield session


@pytest.fixture(autouse=True)
async def setup_db():
    await fresh_tables(test_engine)
    app.dependency_overrides[get_session] = override_get_session
    yield
    app.dependency_overrides.pop(get_session, None)


@pytest.fixture
async def c():
    async with httpx.AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client


@pytest.fixture
async def pid(c):
    r = await c.post(
        "/projects", json={"name": "Kanban", "prefix": "KAN", "color": "#0a0"}
    )
    pid = r.json()["id"]
    for name, role in (("Vera", "viewer"), ("Mia", "member"), ("Ada", "admin")):
        await c.post(f"/projects/{pid}/members", json={"name": name, "role": role})
    return pid


@pytest.fixture
async def page(c, pid):
    r = await c.post(f"/projects/{pid}/docs/pages", json={"title": "API"})
    page = r.json()
    await c.put(f"/docs/pages/{page['id']}/draft", json={"markdown": "## Hi\n\nText\n"})
    cur = (await c.get(f"/docs/pages/{page['id']}")).json()
    await c.post(
        f"/docs/pages/{page['id']}/publish", json={"base_version": cur["version"]}
    )
    return page


def as_(name):
    return {"x-actor": name}


async def edits(c, pid, page_id, who):
    """Status codes for a draft save and a page create by `who`."""
    draft = await c.put(
        f"/docs/pages/{page_id}/draft", json={"markdown": "x"}, headers=as_(who)
    )
    create = await c.post(
        f"/projects/{pid}/docs/pages", json={"title": f"By {who}"}, headers=as_(who)
    )
    return draft.status_code, create.status_code


async def test_default_policy_lets_members_edit_and_viewers_only_read(c, pid, page):
    access = (await c.get(f"/projects/{pid}/docs/access", headers=as_("Vera"))).json()
    assert access["role"] == "viewer"
    assert access["can_edit"] is False
    assert access["policy"] == "members"
    assert access["admins"] == ["Ada"]

    assert (
        await c.get(f"/docs/pages/{page['id']}", headers=as_("Vera"))
    ).status_code == 200
    r = await c.put(
        f"/docs/pages/{page['id']}/draft", json={"markdown": "x"}, headers=as_("Vera")
    )
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "read_only"
    for method, url, body in (
        ("DELETE", f"/docs/pages/{page['id']}", None),
        ("POST", f"/docs/pages/{page['id']}/publish", {"base_version": 1}),
        ("POST", f"/docs/pages/{page['id']}/versions/1/restore", {}),
    ):
        r = await c.request(method, url, json=body, headers=as_("Vera"))
        assert r.status_code == 403, url

    assert await edits(c, pid, page["id"], "Mia") == (200, 201)
    assert (await c.get(f"/projects/{pid}/docs/access", headers=as_("Mia"))).json()[
        "can_edit"
    ]


async def test_admins_only_and_everyone_policies(c, pid, page):
    r = await c.patch(f"/projects/{pid}", json={"docs_edit_policy": "admins"})
    assert r.status_code == 200
    assert r.json()["docs_edit_policy"] == "admins"
    assert (await edits(c, pid, page["id"], "Mia"))[0] == 403
    assert await edits(c, pid, page["id"], "Ada") == (200, 201)
    # the board's own user is always an admin
    assert (await edits(c, pid, page["id"], "user"))[0] == 200

    await c.patch(f"/projects/{pid}", json={"docs_edit_policy": "everyone"})
    assert await edits(c, pid, page["id"], "Vera") == (200, 201)


async def test_only_admins_change_docs_settings(c, pid):
    r = await c.patch(
        f"/projects/{pid}", json={"docs_edit_policy": "everyone"}, headers=as_("Mia")
    )
    assert r.status_code == 403
    r = await c.patch(
        f"/projects/{pid}", json={"docs_enabled": False}, headers=as_("Mia")
    )
    assert r.status_code == 403
    r = await c.patch(
        f"/projects/{pid}", json={"docs_edit_policy": "admins"}, headers=as_("Ada")
    )
    assert r.status_code == 200
    assert (
        await c.patch(f"/projects/{pid}", json={"docs_edit_policy": "nobody"})
    ).status_code == 422
    # other project fields stay open to everyone
    r = await c.patch(f"/projects/{pid}", json={"name": "K2"}, headers=as_("Mia"))
    assert r.status_code == 200


async def test_non_member_has_no_access_and_can_request_it(c, pid, page):
    r = await c.get(f"/docs/pages/{page['id']}", headers=as_("Stranger"))
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "docs_no_access"
    r = await c.get(f"/projects/{pid}/docs/tree", headers=as_("Stranger"))
    assert r.json()["detail"]["code"] == "docs_no_access"
    access = (
        await c.get(f"/projects/{pid}/docs/access", headers=as_("Stranger"))
    ).json()
    assert access["access"] is False
    assert access["can_edit"] is False

    r = await c.post(
        f"/projects/{pid}/docs/access-requests",
        json={"note": "I need to read the API docs"},
        headers=as_("Stranger"),
    )
    assert r.status_code == 201
    assert r.json() == {"sent": True, "admins": ["Ada"]}
    # asking again right away does not notify twice
    again = await c.post(
        f"/projects/{pid}/docs/access-requests", json={}, headers=as_("Stranger")
    )
    assert again.json()["sent"] is False

    events = (
        await c.get(f"/projects/{pid}/docs/comment-events", params={"recipient": "Ada"})
    ).json()
    assert len(events) == 1
    e = events[0]
    assert e["kind"] == "access_request"
    assert e["actor"] == "Stranger"
    assert e["page_id"] is None
    assert e["snippet"] == "I need to read the API docs"
    assert "user" in e["recipients"]

    # a member asking is a no-op
    r = await c.post(
        f"/projects/{pid}/docs/access-requests", json={}, headers=as_("Mia")
    )
    assert r.json()["sent"] is False


async def test_disabled_space_answers_docs_disabled_before_access(c, pid):
    await c.patch(f"/projects/{pid}", json={"docs_enabled": False})
    r = await c.get(f"/projects/{pid}/docs/access", headers=as_("Stranger"))
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "docs_disabled"
