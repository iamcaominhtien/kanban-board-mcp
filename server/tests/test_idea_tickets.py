from collections.abc import AsyncGenerator
import uuid

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

import mcp_tools
from database import async_session as real_async_session
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
async def setup_db(monkeypatch):
    async with test_engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
        await conn.execute(
            text("INSERT INTO idea_counter (id, counter) VALUES (1, 0)")
        )
    app.dependency_overrides[get_session] = override_get_session
    monkeypatch.setattr(mcp_tools, "async_session", test_async_session)
    yield
    app.dependency_overrides.pop(get_session, None)
    monkeypatch.setattr(mcp_tools, "async_session", real_async_session)
    async with test_engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.drop_all)


@pytest.fixture
def client():
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _create_project(c: httpx.AsyncClient) -> dict:
    suffix = uuid.uuid4().hex[:4].upper()
    response = await c.post(
        "/projects",
        json={
            "name": f"Idea Project {suffix}",
            "prefix": f"ID{suffix[:2]}",
            "color": "#123456",
        },
    )
    assert response.status_code == 201
    return response.json()


async def _create_idea(
    c: httpx.AsyncClient,
    project_id: str,
    **overrides,
) -> dict:
    payload = {
        "project_id": project_id,
        "title": "[TEST] Idea ticket",
    }
    payload.update(overrides)
    response = await c.post("/api/idea-tickets", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _trail_text(entry: dict) -> str:
    return " ".join(str(value) for value in entry.values()).lower()


async def test_create_idea_ticket_required_fields_only(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        created = await _create_idea(c, project["id"])

    assert created["id"].startswith("IDEA-")
    assert created["project_id"] == project["id"]
    assert created["title"] == "[TEST] Idea ticket"
    assert created["idea_status"] == "draft"
    assert created["idea_color"] == "yellow"
    assert created["idea_emoji"] == "💡"
    assert created["ice_impact"] == 3
    assert created["ice_effort"] == 3
    assert created["ice_confidence"] == 3
    assert created["microthoughts"] == []
    assert created["assumptions"] == []


async def test_create_idea_ticket_all_fields(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        created = await _create_idea(
            c,
            project["id"],
            title="[TEST] Complete idea",
            description="Detailed idea",
            idea_color="blue",
            idea_emoji="🚀",
            idea_energy="high",
            tags=["growth", "beta"],
            problem_statement="Users cannot find their next best idea.",
        )

    assert created["title"] == "[TEST] Complete idea"
    assert created["description"] == "Detailed idea"
    assert created["idea_color"] == "blue"
    assert created["idea_emoji"] == "🚀"
    assert created["idea_energy"] == "high"
    assert created["tags"] == ["growth", "beta"]
    assert created["problem_statement"] == "Users cannot find their next best idea."


async def test_get_idea_ticket_by_id(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        created = await _create_idea(c, project["id"], title="[TEST] Fetch me")
        response = await c.get(f"/api/idea-tickets/{created['id']}")

    assert response.status_code == 200
    assert response.json()["id"] == created["id"]
    assert response.json()["title"] == "[TEST] Fetch me"


async def test_list_idea_tickets_by_project_id(client: httpx.AsyncClient):
    async with client as c:
        project_a = await _create_project(c)
        project_b = await _create_project(c)
        idea_a = await _create_idea(c, project_a["id"], title="[TEST] Alpha")
        await _create_idea(c, project_b["id"], title="[TEST] Beta")
        response = await c.get(
            "/api/idea-tickets", params={"project_id": project_a["id"]}
        )

    assert response.status_code == 200
    results = response.json()
    assert [ticket["id"] for ticket in results] == [idea_a["id"]]


async def test_update_idea_ticket_fields(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        created = await _create_idea(c, project["id"])
        response = await c.patch(
            f"/api/idea-tickets/{created['id']}",
            json={
                "title": "[TEST] Updated idea",
                "description": "Updated description",
                "idea_energy": "medium",
                "tags": ["updated"],
                "ice_impact": 5,
                "ice_effort": 2,
                "ice_confidence": 4,
                "revisit_date": "2026-05-01",
            },
        )

    assert response.status_code == 200
    updated = response.json()
    assert updated["title"] == "[TEST] Updated idea"
    assert updated["description"] == "Updated description"
    assert updated["idea_energy"] == "medium"
    assert updated["tags"] == ["updated"]
    assert updated["ice_impact"] == 5
    assert updated["ice_effort"] == 2
    assert updated["ice_confidence"] == 4
    assert updated["revisit_date"] == "2026-05-01"


async def test_delete_idea_ticket(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        created = await _create_idea(c, project["id"])
        delete_response = await c.delete(f"/api/idea-tickets/{created['id']}")
        get_response = await c.get(f"/api/idea-tickets/{created['id']}")

    assert delete_response.status_code == 204
    assert get_response.status_code == 404


async def test_valid_status_transition_draft_to_in_review(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        created = await _create_idea(c, project["id"])
        response = await c.patch(
            f"/api/idea-tickets/{created['id']}/status",
            json={"new_status": "in_review"},
        )

    assert response.status_code == 200
    assert response.json()["idea_status"] == "in_review"


async def test_valid_status_transition_in_review_to_approved(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        created = await _create_idea(c, project["id"])
        first = await c.patch(
            f"/api/idea-tickets/{created['id']}/status",
            json={"new_status": "in_review"},
        )
        assert first.status_code == 200
        response = await c.patch(
            f"/api/idea-tickets/{created['id']}/status",
            json={"new_status": "approved"},
        )

    assert response.status_code == 200
    assert response.json()["idea_status"] == "approved"


async def test_invalid_status_transition_approved_to_draft_fails(
    client: httpx.AsyncClient,
):
    async with client as c:
        project = await _create_project(c)
        created = await _create_idea(c, project["id"])
        await c.patch(
            f"/api/idea-tickets/{created['id']}/status",
            json={"new_status": "in_review"},
        )
        await c.patch(
            f"/api/idea-tickets/{created['id']}/status",
            json={"new_status": "approved"},
        )
        response = await c.patch(
            f"/api/idea-tickets/{created['id']}/status",
            json={"new_status": "draft"},
        )

    assert response.status_code == 400
    assert "cannot transition" in response.json()["detail"].lower()


async def test_invalid_status_transition_draft_to_approved_fails(
    client: httpx.AsyncClient,
):
    async with client as c:
        project = await _create_project(c)
        created = await _create_idea(c, project["id"])
        response = await c.patch(
            f"/api/idea-tickets/{created['id']}/status",
            json={"new_status": "approved"},
        )

    assert response.status_code == 400
    assert "cannot transition" in response.json()["detail"].lower()


async def test_add_microthought_returns_id_text_at(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        created = await _create_idea(c, project["id"])
        response = await c.post(
            f"/api/idea-tickets/{created['id']}/microthoughts",
            json={"text": "[TEST] Quick thought"},
        )

    assert response.status_code == 200
    microthought = response.json()["microthoughts"][0]
    assert microthought["id"]
    assert microthought["text"] == "[TEST] Quick thought"
    assert microthought["at"]


async def test_delete_microthought(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        created = await _create_idea(c, project["id"])
        added = await c.post(
            f"/api/idea-tickets/{created['id']}/microthoughts",
            json={"text": "[TEST] Remove me"},
        )
        microthought_id = added.json()["microthoughts"][0]["id"]
        response = await c.delete(
            f"/api/idea-tickets/{created['id']}/microthoughts/{microthought_id}"
        )

    assert response.status_code == 200
    assert response.json()["microthoughts"] == []


async def test_add_update_delete_assumption(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        created = await _create_idea(c, project["id"])
        added = await c.post(
            f"/api/idea-tickets/{created['id']}/assumptions",
            json={"text": "[TEST] Users want reminders"},
        )
        assert added.status_code == 200
        assumption = added.json()["assumptions"][0]
        assert assumption["status"] == "untested"

        updated = await c.patch(
            f"/api/idea-tickets/{created['id']}/assumptions/{assumption['id']}",
            json={"status": "validated"},
        )
        assert updated.status_code == 200
        updated_assumption = updated.json()["assumptions"][0]
        assert updated_assumption["status"] == "validated"

        deleted = await c.delete(
            f"/api/idea-tickets/{created['id']}/assumptions/{assumption['id']}"
        )

    assert deleted.status_code == 200
    assert deleted.json()["assumptions"] == []


async def test_invalid_assumption_status_rejected(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        created = await _create_idea(c, project["id"])
        added = await c.post(
            f"/api/idea-tickets/{created['id']}/assumptions",
            json={"text": "[TEST] Risky assumption"},
        )
        assumption_id = added.json()["assumptions"][0]["id"]
        response = await c.patch(
            f"/api/idea-tickets/{created['id']}/assumptions/{assumption_id}",
            json={"status": "maybe"},
        )

    assert response.status_code == 422


async def test_create_idea_ticket_adds_activity_entry(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        created = await _create_idea(c, project["id"])

    assert created["activity_trail"]
    assert "idea created" in _trail_text(created["activity_trail"][-1])


async def test_status_change_adds_activity_entry(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        created = await _create_idea(c, project["id"])
        response = await c.patch(
            f"/api/idea-tickets/{created['id']}/status",
            json={"new_status": "in_review"},
        )

    assert response.status_code == 200
    assert any(
        "status changed" in _trail_text(entry) and "draft" in _trail_text(entry)
        for entry in response.json()["activity_trail"]
    )


async def test_get_idea_activity_trail_returns_entries_in_reverse_order(
    client: httpx.AsyncClient,
):
    async with client as c:
        project = await _create_project(c)
        created = await _create_idea(c, project["id"])
        status_response = await c.patch(
            f"/api/idea-tickets/{created['id']}/status",
            json={"new_status": "in_review"},
        )
        assert status_response.status_code == 200
        microthought_response = await c.post(
            f"/api/idea-tickets/{created['id']}/microthoughts",
            json={"text": "[TEST] Latest event"},
        )
        assert microthought_response.status_code == 200

    trail = await mcp_tools.get_idea_activity_trail(created["id"])

    assert isinstance(trail, list)
    assert len(trail) >= 3
    assert "microthought" in _trail_text(trail[0])
    assert "idea created" in _trail_text(trail[-1])