import uuid

import pytest
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

import mcp_tools
from database import async_session as real_async_session
from models import BoardType, IdeaColor, Ticket


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


async def _seed_project(name: str = "Idea Project", prefix: str | None = None) -> dict:
    prefix = (
        prefix
        or (
            "I"
            + "".join(c for c in str(uuid.uuid4()).replace("-", "") if c.isalnum())[:3]
        ).upper()
    )
    return await mcp_tools.create_project(name=name, prefix=prefix, color="#4488cc")


async def _seed_legacy_idea_ticket(project_id: str) -> str:
    async with mcp_tools.async_session() as session:
        ticket = Ticket(
            id="LEGACY-IDEA-1",
            project_id=project_id,
            title="Legacy idea",
            board=BoardType.idea,
            idea_status=None,
            description="Legacy description",
        )
        session.add(ticket)
        await session.commit()
    return ticket.id


IDEA_COLORS = [member.value for member in IdeaColor]


async def test_list_idea_tickets_returns_only_idea_board_tickets():
    project = await _seed_project(prefix="IDEA")
    main_ticket = await mcp_tools.create_ticket(project_id=project["id"], title="Main")
    draft_idea = await mcp_tools.create_idea_ticket(
        project_id=project["id"], title="Draft idea"
    )
    approved_idea = await mcp_tools.create_idea_ticket(
        project_id=project["id"], title="Approved idea"
    )
    await mcp_tools.update_idea_ticket(approved_idea["id"], idea_status="approved")

    results = await mcp_tools.list_idea_tickets(project_id=project["id"])

    assert {ticket["id"] for ticket in results} == {draft_idea["id"], approved_idea["id"]}
    assert all(ticket["board"] == "idea" for ticket in results)
    assert all(ticket["id"] != main_ticket["id"] for ticket in results)


async def test_list_idea_tickets_filters_by_idea_status():
    project = await _seed_project(prefix="ISTA")
    draft_idea = await mcp_tools.create_idea_ticket(
        project_id=project["id"], title="Draft idea"
    )
    approved_idea = await mcp_tools.create_idea_ticket(
        project_id=project["id"], title="Approved idea"
    )
    await mcp_tools.update_idea_ticket(approved_idea["id"], idea_status="approved")

    approved_results = await mcp_tools.list_idea_tickets(
        project_id=project["id"], status="approved"
    )

    assert [ticket["id"] for ticket in approved_results] == [approved_idea["id"]]
    assert all(ticket["idea_status"] == "approved" for ticket in approved_results)
    assert all(ticket["id"] != draft_idea["id"] for ticket in approved_results)


async def test_list_idea_tickets_invalid_project_id_raises_value_error():
    with pytest.raises(ValueError):
        await mcp_tools.list_idea_tickets(project_id=str(uuid.uuid4()))


async def test_create_idea_ticket_sets_idea_defaults_and_returns_ticket_dict():
    project = await _seed_project(prefix="CRT1")

    ticket = await mcp_tools.create_idea_ticket(
        project_id=project["id"],
        title="Explore bulk import",
        description="Support CSV uploads",
        tags=["import", "csv"],
    )

    assert ticket["id"].startswith("CRT1-")
    assert ticket["title"] == "Explore bulk import"
    assert ticket["description"] == "Support CSV uploads"
    assert ticket["tags"] == ["import", "csv"]
    assert ticket["board"] == "idea"
    assert ticket["idea_status"] == "draft"
    assert ticket["idea_emoji"] == "💡"
    assert ticket["idea_color"] in IDEA_COLORS


@pytest.mark.parametrize("title", ["", "   ", "x" * 256])
async def test_create_idea_ticket_rejects_invalid_titles(title: str):
    project = await _seed_project(prefix="CRT2")

    with pytest.raises(ValueError):
        await mcp_tools.create_idea_ticket(project_id=project["id"], title=title)


@pytest.mark.parametrize(
    ("idea_emoji", "expected"),
    [(None, "💡"), ("", "💡"), ("🚀 launch", "🚀")],
)
async def test_create_idea_ticket_normalizes_emoji(idea_emoji: str | None, expected: str):
    project = await _seed_project(prefix="EMJ")

    ticket = await mcp_tools.create_idea_ticket(
        project_id=project["id"],
        title=f"Emoji {expected}",
        idea_emoji=idea_emoji,
    )

    assert ticket["idea_emoji"] == expected


async def test_create_idea_ticket_rejects_invalid_color():
    project = await _seed_project(prefix="COLR")

    with pytest.raises(ValueError):
        await mcp_tools.create_idea_ticket(
            project_id=project["id"], title="Bad color", idea_color="magenta"
        )


async def test_update_idea_ticket_only_updates_provided_fields():
    project = await _seed_project(prefix="UPD1")
    ticket = await mcp_tools.create_idea_ticket(
        project_id=project["id"],
        title="Original title",
        description="Original description",
        tags=["alpha", "beta"],
        idea_emoji="🚀",
        idea_color="blue",
    )

    updated = await mcp_tools.update_idea_ticket(
        ticket["id"], description="Updated description"
    )

    assert updated["title"] == "Original title"
    assert updated["description"] == "Updated description"
    assert updated["tags"] == ["alpha", "beta"]
    assert updated["idea_emoji"] == "🚀"
    assert updated["idea_color"] == "blue"
    assert updated["idea_status"] == "draft"


@pytest.mark.parametrize(
    "payload",
    [
        {"title": "Changed title"},
        {"description": "Changed description"},
        {"tags": ["changed"]},
    ],
)
async def test_update_idea_ticket_blocks_content_edits_when_approved(payload: dict):
    project = await _seed_project(prefix="LOCK")
    ticket = await mcp_tools.create_idea_ticket(
        project_id=project["id"],
        title="Approved idea",
        description="Locked description",
        tags=["locked"],
    )
    await mcp_tools.update_idea_ticket(ticket["id"], idea_status="approved")

    with pytest.raises(ValueError):
        await mcp_tools.update_idea_ticket(ticket["id"], **payload)


async def test_update_idea_ticket_allows_emoji_and_color_edits_when_approved():
    project = await _seed_project(prefix="LOCK2")
    ticket = await mcp_tools.create_idea_ticket(
        project_id=project["id"], title="Approved styling"
    )
    await mcp_tools.update_idea_ticket(ticket["id"], idea_status="approved")

    updated = await mcp_tools.update_idea_ticket(
        ticket["id"], idea_emoji="🎨 palette", idea_color="pink"
    )

    assert updated["idea_status"] == "approved"
    assert updated["idea_emoji"] == "🎨"
    assert updated["idea_color"] == "pink"


@pytest.mark.parametrize(
    ("start_status", "target_status"),
    [
        ("draft", "approved"),
        ("draft", "dropped"),
        ("approved", "draft"),
        ("approved", "dropped"),
    ],
)
async def test_update_idea_ticket_allows_supported_status_transitions(
    start_status: str, target_status: str
):
    project = await _seed_project(prefix="STAT")
    ticket = await mcp_tools.create_idea_ticket(
        project_id=project["id"], title=f"{start_status} idea"
    )
    if start_status != "draft":
        await mcp_tools.update_idea_ticket(ticket["id"], idea_status=start_status)

    updated = await mcp_tools.update_idea_ticket(
        ticket["id"], idea_status=target_status
    )

    assert updated["idea_status"] == target_status


@pytest.mark.parametrize("target_status", ["draft", "approved"])
async def test_update_idea_ticket_rejects_status_changes_from_dropped(target_status: str):
    project = await _seed_project(prefix="DROP")
    ticket = await mcp_tools.create_idea_ticket(
        project_id=project["id"], title="Dropped idea"
    )
    await mcp_tools.update_idea_ticket(ticket["id"], idea_status="dropped")

    with pytest.raises(ValueError):
        await mcp_tools.update_idea_ticket(ticket["id"], idea_status=target_status)


async def test_update_idea_ticket_treats_null_idea_status_as_draft():
    project = await _seed_project(prefix="LEG")
    legacy_ticket_id = await _seed_legacy_idea_ticket(project["id"])

    updated = await mcp_tools.update_idea_ticket(
        legacy_ticket_id,
        title="Trimmed legacy title",
        idea_status="approved",
    )

    assert updated["title"] == "Trimmed legacy title"
    assert updated["idea_status"] == "approved"


@pytest.mark.parametrize("title", ["   ", "x" * 256])
async def test_update_idea_ticket_rejects_invalid_title_values(title: str):
    project = await _seed_project(prefix="UTTL")
    ticket = await mcp_tools.create_idea_ticket(project_id=project["id"], title="Valid")

    with pytest.raises(ValueError):
        await mcp_tools.update_idea_ticket(ticket["id"], title=title)


async def test_update_idea_ticket_strips_title_when_provided():
    project = await _seed_project(prefix="STRP")
    ticket = await mcp_tools.create_idea_ticket(project_id=project["id"], title="Valid")

    updated = await mcp_tools.update_idea_ticket(ticket["id"], title="  Trimmed title  ")

    assert updated["title"] == "Trimmed title"


@pytest.mark.parametrize("tags", ["not-a-list", ["ok", 123]])
async def test_update_idea_ticket_rejects_invalid_tags(tags):
    project = await _seed_project(prefix="TAGS")
    ticket = await mcp_tools.create_idea_ticket(project_id=project["id"], title="Tagged")

    with pytest.raises(ValueError):
        await mcp_tools.update_idea_ticket(ticket["id"], tags=tags)


async def test_update_idea_ticket_raises_for_missing_ticket():
    with pytest.raises(ValueError):
        await mcp_tools.update_idea_ticket("MISSING-IDEA", title="Ghost")


async def test_update_idea_ticket_raises_for_main_board_ticket():
    project = await _seed_project(prefix="MAIN")
    ticket = await mcp_tools.create_ticket(project_id=project["id"], title="Main ticket")

    with pytest.raises(ValueError):
        await mcp_tools.update_idea_ticket(ticket["id"], title="Nope")


async def test_promote_idea_ticket_requires_approved_status():
    project = await _seed_project(prefix="PRO1")
    ticket = await mcp_tools.create_idea_ticket(
        project_id=project["id"], title="Needs approval"
    )

    with pytest.raises(ValueError):
        await mcp_tools.promote_idea_ticket(ticket["id"])


async def test_promote_idea_ticket_creates_main_ticket_and_drops_idea():
    project = await _seed_project(prefix="PRO2")
    idea_ticket = await mcp_tools.create_idea_ticket(
        project_id=project["id"],
        title="Promotable idea",
        description="Carry this description over",
        tags=["idea", "approved"],
        idea_emoji="🚀",
        idea_color="orange",
    )
    await mcp_tools.update_idea_ticket(idea_ticket["id"], idea_status="approved")

    result = await mcp_tools.promote_idea_ticket(idea_ticket["id"])
    promoted_ticket = result["promoted_ticket"]
    dropped_ideas = await mcp_tools.list_idea_tickets(
        project_id=project["id"], status="dropped"
    )

    assert result["idea_ticket_id"] == idea_ticket["id"]
    assert result["promoted_ticket_id"] == promoted_ticket["id"]
    assert promoted_ticket["board"] == "main"
    assert promoted_ticket["status"] == "backlog"
    assert promoted_ticket["origin_idea_id"] == idea_ticket["id"]
    assert promoted_ticket["title"] == "Promotable idea"
    assert promoted_ticket["description"] == "Carry this description over"
    assert promoted_ticket["tags"] == ["idea", "approved"]
    assert any(ticket["id"] == idea_ticket["id"] for ticket in dropped_ideas)


@pytest.mark.parametrize("ticket_id_factory", ["missing", "main"])
async def test_promote_idea_ticket_raises_for_missing_or_non_idea_ticket(ticket_id_factory: str):
    project = await _seed_project(prefix="PRO3")
    if ticket_id_factory == "missing":
        ticket_id = "MISSING-9999"
    else:
        main_ticket = await mcp_tools.create_ticket(
            project_id=project["id"], title="Main ticket"
        )
        ticket_id = main_ticket["id"]

    with pytest.raises(ValueError):
        await mcp_tools.promote_idea_ticket(ticket_id)


async def test_drop_idea_ticket_sets_dropped_and_rejects_repeat_drop():
    project = await _seed_project(prefix="DRP1")
    idea_ticket = await mcp_tools.create_idea_ticket(
        project_id=project["id"], title="Drop me"
    )

    dropped = await mcp_tools.drop_idea_ticket(idea_ticket["id"])

    assert dropped["idea_status"] == "dropped"

    with pytest.raises(ValueError):
        await mcp_tools.drop_idea_ticket(idea_ticket["id"])


@pytest.mark.parametrize("ticket_id_factory", ["missing", "main"])
async def test_drop_idea_ticket_raises_for_missing_or_non_idea_ticket(ticket_id_factory: str):
    project = await _seed_project(prefix="DRP2")
    if ticket_id_factory == "missing":
        ticket_id = "MISSING-1000"
    else:
        main_ticket = await mcp_tools.create_ticket(
            project_id=project["id"], title="Main ticket"
        )
        ticket_id = main_ticket["id"]

    with pytest.raises(ValueError):
        await mcp_tools.drop_idea_ticket(ticket_id)


async def test_list_tickets_defaults_to_main_board_and_supports_board_filter():
    project = await _seed_project(prefix="LST1")
    main_ticket = await mcp_tools.create_ticket(
        project_id=project["id"], title="Main backlog item"
    )
    idea_ticket = await mcp_tools.create_idea_ticket(
        project_id=project["id"], title="Idea item"
    )

    default_results = await mcp_tools.list_tickets(project_id=project["id"])
    main_results = await mcp_tools.list_tickets(project_id=project["id"], board="main")
    idea_results = await mcp_tools.list_tickets(project_id=project["id"], board="idea")

    assert [ticket["id"] for ticket in default_results] == [main_ticket["id"]]
    assert [ticket["id"] for ticket in main_results] == [main_ticket["id"]]
    assert [ticket["id"] for ticket in idea_results] == [idea_ticket["id"]]


async def test_list_tickets_rejects_invalid_board_value():
    project = await _seed_project(prefix="LST2")

    with pytest.raises(ValueError):
        await mcp_tools.list_tickets(project_id=project["id"], board="archive")