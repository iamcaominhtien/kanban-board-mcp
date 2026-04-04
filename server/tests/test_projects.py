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
    app.dependency_overrides.clear()
    async with test_engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.drop_all)


@pytest.fixture
def client():
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


async def test_list_returns_empty(client: httpx.AsyncClient):
    async with client as c:
        response = await c.get("/projects")
    assert response.status_code == 200
    assert response.json() == []


async def test_create_project_appears_in_list(client: httpx.AsyncClient):
    payload = {"name": "My Project", "prefix": "MYP", "color": "#ff0000"}
    async with client as c:
        create_response = await c.post("/projects", json=payload)
        assert create_response.status_code == 201
        created = create_response.json()
        assert created["prefix"] == "MYP"
        assert created["ticket_counter"] == 0

        list_response = await c.get("/projects")
    assert list_response.status_code == 200
    projects = list_response.json()
    assert len(projects) == 1
    assert projects[0]["id"] == created["id"]


async def test_create_duplicate_prefix_returns_error(client: httpx.AsyncClient):
    payload = {"name": "Project A", "prefix": "DUP", "color": "#aabbcc"}
    async with client as c:
        await c.post("/projects", json=payload)
        response = await c.post("/projects", json=payload)
    # DB unique constraint → 500 from integrity error, or 400 from explicit check
    assert response.status_code in (400, 422, 500)


async def test_get_nonexistent_returns_404(client: httpx.AsyncClient):
    async with client as c:
        response = await c.get("/projects/does-not-exist")
    assert response.status_code == 404


async def test_update_name_reflected_in_get(client: httpx.AsyncClient):
    payload = {"name": "Original", "prefix": "UPD", "color": "#123456"}
    async with client as c:
        create_resp = await c.post("/projects", json=payload)
        project_id = create_resp.json()["id"]

        patch_resp = await c.patch(
            f"/projects/{project_id}", json={"name": "Updated Name"}
        )
        assert patch_resp.status_code == 200
        assert patch_resp.json()["name"] == "Updated Name"

        get_resp = await c.get(f"/projects/{project_id}")
    assert get_resp.json()["name"] == "Updated Name"


async def test_update_nonexistent_returns_404(client: httpx.AsyncClient):
    async with client as c:
        response = await c.patch("/projects/ghost", json={"name": "x"})
    assert response.status_code == 404


async def test_delete_project_then_404(client: httpx.AsyncClient):
    payload = {"name": "To Delete", "prefix": "DEL", "color": "#000000"}
    async with client as c:
        create_resp = await c.post("/projects", json=payload)
        project_id = create_resp.json()["id"]

        del_resp = await c.delete(f"/projects/{project_id}")
        assert del_resp.status_code == 204

        get_resp = await c.get(f"/projects/{project_id}")
    assert get_resp.status_code == 404


async def test_delete_nonexistent_returns_404(client: httpx.AsyncClient):
    async with client as c:
        response = await c.delete("/projects/no-such-id")
    assert response.status_code == 404


async def test_delete_project_with_tickets_returns_400():
    from datetime import datetime, timezone

    from models import Ticket

    proj_payload = {"name": "Has Tickets", "prefix": "HAS", "color": "#abcdef"}
    async with httpx.AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        create_resp = await c.post("/projects", json=proj_payload)
        project_id = create_resp.json()["id"]

    # Insert a ticket directly into the test DB
    async with test_async_session() as session:
        ticket = Ticket(
            id="HAS-1",
            project_id=project_id,
            title="A ticket",
            created_at=datetime.now(timezone.utc).isoformat(),
            updated_at=datetime.now(timezone.utc).isoformat(),
        )
        session.add(ticket)
        await session.commit()

    async with httpx.AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        del_resp = await c.delete(f"/projects/{project_id}")
    assert del_resp.status_code == 400
    assert "tickets" in del_resp.json()["detail"].lower()


async def test_create_project_invalid_prefix_lowercase_returns_400(
    client: httpx.AsyncClient,
):
    payload = {"name": "Bad Prefix", "prefix": "lower", "color": "#ffffff"}
    async with client as c:
        response = await c.post("/projects", json=payload)
    assert response.status_code == 400


async def test_create_project_prefix_too_long_returns_400(client: httpx.AsyncClient):
    payload = {"name": "Long Prefix", "prefix": "TOOLONG", "color": "#ffffff"}
    async with client as c:
        response = await c.post("/projects", json=payload)
    assert response.status_code == 400
