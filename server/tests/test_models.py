import pytest
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from models import Project, Ticket, TicketRead


@pytest.fixture
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)

    async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with async_session() as s:
        yield s

    await engine.dispose()


async def test_create_and_read_project(session: AsyncSession):
    project = Project(name="My Project", prefix="IAM", color="#FF5733")
    session.add(project)
    await session.commit()
    await session.refresh(project)

    assert project.id is not None
    assert project.name == "My Project"
    assert project.prefix == "IAM"
    assert project.color == "#FF5733"
    assert project.ticket_counter == 0


async def test_create_and_read_ticket(session: AsyncSession):
    project = Project(name="Test Project", prefix="TST", color="#123456")
    session.add(project)
    await session.commit()
    await session.refresh(project)

    ticket = Ticket(
        id="TST-1",
        project_id=project.id,
        title="First ticket",
        status="todo",
        priority="high",
    )
    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)

    assert ticket.id == "TST-1"
    assert ticket.project_id == project.id
    assert ticket.title == "First ticket"
    assert ticket.status == "todo"
    assert ticket.priority == "high"
    assert ticket.description == ""
    assert ticket.tags == "[]"
    assert ticket.type == "task"


async def test_ticket_read_parses_json_fields(session: AsyncSession):
    project = Project(name="JSON Project", prefix="JSN", color="#AABBCC")
    session.add(project)
    await session.commit()
    await session.refresh(project)

    ticket = Ticket(
        id="JSN-1",
        project_id=project.id,
        title="JSON ticket",
        tags='["alpha", "beta"]',
        comments='[{"author": "alice", "text": "hello"}]',
    )
    session.add(ticket)
    await session.commit()
    await session.refresh(ticket)

    read = TicketRead.from_ticket(ticket)
    assert read.tags == ["alpha", "beta"]
    assert read.comments == [{"author": "alice", "text": "hello"}]
    assert read.acceptance_criteria == []
    assert read.work_log == []
