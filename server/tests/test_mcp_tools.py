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
    # uuid4 hex without hyphens guarantees alphanumeric chars
    prefix = (
        prefix
        or (
            "T"
            + "".join(c for c in str(uuid.uuid4()).replace("-", "") if c.isalnum())[:3]
        ).upper()
    )
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


# ---------------------------------------------------------------------------
# create_ticket — unknown project
# ---------------------------------------------------------------------------


async def test_create_ticket_unknown_project_raises():
    with pytest.raises(ValueError, match="Project not found"):
        await mcp_tools.create_ticket(project_id=str(uuid.uuid4()), title="x")


# ---------------------------------------------------------------------------
# list_tickets — wildcard escaping
# ---------------------------------------------------------------------------


async def test_list_tickets_percent_is_literal_not_wildcard():
    """q='%' should only match tickets whose title contains '%', not all tickets."""
    project = await _seed_project(prefix="PCT")
    await mcp_tools.create_ticket(project_id=project["id"], title="50% done")
    await mcp_tools.create_ticket(project_id=project["id"], title="no percent here")

    results = await mcp_tools.list_tickets(project_id=project["id"], q="%")
    assert len(results) == 1
    assert "%" in results[0]["title"]


# ---------------------------------------------------------------------------
# update_ticket
# ---------------------------------------------------------------------------


async def test_update_ticket_title():
    project = await _seed_project(prefix="UTT")
    ticket = await mcp_tools.create_ticket(project_id=project["id"], title="Old Title")
    updated = await mcp_tools.update_ticket(ticket["id"], title="New Title")
    assert updated is not None
    assert updated["title"] == "New Title"


async def test_update_ticket_unknown_id_returns_none():
    result = await mcp_tools.update_ticket("MISSING-0", title="x")
    assert result is None


# ---------------------------------------------------------------------------
# add_comment
# ---------------------------------------------------------------------------


async def test_add_comment():
    project = await _seed_project(prefix="CMT")
    ticket = await mcp_tools.create_ticket(
        project_id=project["id"], title="Commentable"
    )
    result = await mcp_tools.add_comment(
        ticket["id"], text="Hello world", author="alice"
    )
    assert result is not None
    assert any(
        c["text"] == "Hello world" and c["author"] == "alice"
        for c in result["comments"]
    )


async def test_add_comment_unknown_ticket_returns_none():
    result = await mcp_tools.add_comment("MISSING-0", text="hi", author="bob")
    assert result is None


# ---------------------------------------------------------------------------
# add_work_log
# ---------------------------------------------------------------------------


async def test_add_work_log():
    project = await _seed_project(prefix="WLG")
    ticket = await mcp_tools.create_ticket(
        project_id=project["id"], title="Work log test"
    )
    result = await mcp_tools.add_work_log(
        ticket["id"], author="dev", role="Developer", note="Implemented feature X"
    )
    assert result is not None
    assert any(
        w["author"] == "dev" and w["note"] == "Implemented feature X"
        for w in result["work_log"]
    )


async def test_add_work_log_unknown_ticket_returns_none():
    result = await mcp_tools.add_work_log(
        "MISSING-0", author="x", role="Other", note="n"
    )
    assert result is None


# ---------------------------------------------------------------------------
# add_test_case
# ---------------------------------------------------------------------------


async def test_add_test_case():
    project = await _seed_project(prefix="TCX")
    ticket = await mcp_tools.create_ticket(
        project_id=project["id"], title="Test case ticket"
    )
    result = await mcp_tools.add_test_case(
        ticket["id"], title="Login works", status="pending"
    )
    assert result is not None
    assert any(
        tc["title"] == "Login works" and tc["status"] == "pending"
        for tc in result["test_cases"]
    )


async def test_add_test_case_unknown_ticket_returns_none():
    result = await mcp_tools.add_test_case("MISSING-0", title="x")
    assert result is None


# ---------------------------------------------------------------------------
# update_test_case
# ---------------------------------------------------------------------------


async def test_update_test_case_status():
    project = await _seed_project(prefix="UTC")
    ticket = await mcp_tools.create_ticket(project_id=project["id"], title="TC update")
    with_tc = await mcp_tools.add_test_case(ticket["id"], title="Should pass")
    tc_id = with_tc["test_cases"][0]["id"]
    updated = await mcp_tools.update_test_case(
        ticket["id"], test_case_id=tc_id, status="pass", proof="screenshot.png"
    )
    assert updated is not None
    tc = next(tc for tc in updated["test_cases"] if tc["id"] == tc_id)
    assert tc["status"] == "pass"
    assert tc["proof"] == "screenshot.png"


async def test_update_test_case_unknown_ticket_returns_none():
    result = await mcp_tools.update_test_case(
        "MISSING-0", test_case_id="fake-id", status="pass"
    )
    assert result is None


# ---------------------------------------------------------------------------
# create_child_ticket
# ---------------------------------------------------------------------------


async def test_create_child_ticket():
    project = await _seed_project(prefix="CHD")
    parent = await mcp_tools.create_ticket(
        project_id=project["id"], title="Parent ticket"
    )
    child = await mcp_tools.create_child_ticket(
        parent_ticket_id=parent["id"], title="Child ticket", type="task"
    )
    assert child is not None
    assert child["parent_id"] == parent["id"]
    assert child["title"] == "Child ticket"


async def test_create_child_ticket_unknown_parent_returns_none():
    result = await mcp_tools.create_child_ticket(
        parent_ticket_id="MISSING-9999", title="orphan"
    )
    assert result is None


async def test_create_child_ticket_depth_violation_returns_none():
    project = await _seed_project(prefix="DEEP")
    parent = await mcp_tools.create_ticket(project_id=project["id"], title="Parent")
    child = await mcp_tools.create_child_ticket(
        parent_ticket_id=parent["id"], title="Child"
    )
    assert child is not None
    result = await mcp_tools.create_child_ticket(
        parent_ticket_id=child["id"], title="Grandchild"
    )
    assert result is None


# ---------------------------------------------------------------------------
# update_test_case — unknown test_case_id
# ---------------------------------------------------------------------------


async def test_update_test_case_unknown_id_returns_none():
    project = await _seed_project(prefix="UTCU")
    ticket = await mcp_tools.create_ticket(
        project_id=project["id"], title="TC unknown id"
    )
    result = await mcp_tools.update_test_case(
        ticket_id=ticket["id"],
        test_case_id=str(uuid.uuid4()),
        status="pass",
    )
    assert result is None
