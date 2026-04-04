import uuid

import pytest
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

import mcp_tools
from database import async_session as real_async_session

DATABASE_URL_TEST = "sqlite+aiosqlite:///:memory:"

test_engine = create_async_engine(DATABASE_URL_TEST, echo=False)
test_async_session = sessionmaker(
    test_engine, class_=AsyncSession, expire_on_commit=False
)


@pytest.fixture(autouse=True)
async def setup_db(monkeypatch):
    async with test_engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    monkeypatch.setattr(mcp_tools, "async_session", test_async_session)
    yield
    monkeypatch.setattr(mcp_tools, "async_session", real_async_session)
    async with test_engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.drop_all)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _seed_project(name: str = "Test", prefix: str | None = None) -> dict:
    prefix = prefix or f"T{str(uuid.uuid4())[:4].upper()}"
    return await mcp_tools.create_project(name=name, prefix=prefix, color="#aabbcc")


# ---------------------------------------------------------------------------
# list_projects
# ---------------------------------------------------------------------------


async def test_list_projects_returns_list():
    result = await mcp_tools.list_projects()
    assert isinstance(result, list)


async def test_list_projects_shows_created_project():
    await _seed_project(name="Alpha", prefix="ALPHA")
    result = await mcp_tools.list_projects()
    assert any(p["prefix"] == "ALPHA" for p in result)


# ---------------------------------------------------------------------------
# create_project
# ---------------------------------------------------------------------------


async def test_create_project_returns_correct_fields():
    result = await mcp_tools.create_project(
        name="My App", prefix="MYAPP", color="#ff0000"
    )
    assert result["name"] == "My App"
    assert result["prefix"] == "MYAPP"
    assert result["color"] == "#ff0000"
    assert "id" in result
    assert result["ticket_counter"] == 0


async def test_create_project_uppercases_prefix():
    result = await mcp_tools.create_project(name="Lower", prefix="low")
    assert result["prefix"] == "LOW"


# ---------------------------------------------------------------------------
# list_tickets & create_ticket
# ---------------------------------------------------------------------------


async def test_create_ticket_appears_in_list_tickets():
    project = await _seed_project(prefix="LTST")
    ticket = await mcp_tools.create_ticket(
        project_id=project["id"],
        title="My first ticket",
        type="task",
        priority="high",
    )
    assert ticket["title"] == "My first ticket"
    assert ticket["id"].startswith("LTST-")

    tickets = await mcp_tools.list_tickets(project_id=project["id"])
    assert any(t["id"] == ticket["id"] for t in tickets)


async def test_list_tickets_filter_by_status():
    project = await _seed_project(prefix="FILT")
    await mcp_tools.create_ticket(
        project_id=project["id"], title="In progress ticket", status="in-progress"
    )
    await mcp_tools.create_ticket(
        project_id=project["id"], title="Backlog ticket", status="backlog"
    )

    in_progress = await mcp_tools.list_tickets(
        project_id=project["id"], status="in-progress"
    )
    assert all(t["status"] == "in-progress" for t in in_progress)
    assert len(in_progress) == 1


# ---------------------------------------------------------------------------
# get_ticket
# ---------------------------------------------------------------------------


async def test_get_ticket_returns_ticket():
    project = await _seed_project(prefix="GETK")
    ticket = await mcp_tools.create_ticket(project_id=project["id"], title="Fetch me")
    result = await mcp_tools.get_ticket(ticket["id"])
    assert result is not None
    assert result["id"] == ticket["id"]
    assert result["title"] == "Fetch me"


async def test_get_ticket_returns_none_for_missing_id():
    result = await mcp_tools.get_ticket("MISSING-9999")
    assert result is None


# ---------------------------------------------------------------------------
# update_ticket_status
# ---------------------------------------------------------------------------


async def test_update_ticket_status_changes_status():
    project = await _seed_project(prefix="UPD")
    ticket = await mcp_tools.create_ticket(
        project_id=project["id"], title="Status test", status="backlog"
    )

    updated = await mcp_tools.update_ticket_status(ticket["id"], "done")
    assert updated is not None
    assert updated["status"] == "done"

    fetched = await mcp_tools.get_ticket(ticket["id"])
    assert fetched["status"] == "done"


async def test_update_ticket_status_returns_none_for_missing():
    result = await mcp_tools.update_ticket_status("MISSING-0", "done")
    assert result is None
