"""Idea Space data model: stages, assumption records, ideas without a project, and the one-time conversion."""

import json
import sqlite3
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlmodel.ext.asyncio.session import AsyncSession

import database
import services.idea_promote as idea_promote
import services.idea_tickets as svc
from models import IdeaVote, Project, Ticket
from tests.fast_db import fresh_tables

OLD_HEAD = "b3e5f7a9c1d2"
NEW_HEAD = "f4a6b8c0d2e4"
PAST, FUTURE = "2020-01-01", "2999-01-01"


def _config(url: str) -> Config:
    cfg = Config(str(database._ALEMBIC_INI))
    cfg.set_main_option("sqlalchemy.url", url)
    return cfg


def _migrate(db_file: Path, revision: str, direction: str = "upgrade") -> None:
    cfg = _config(f"sqlite+aiosqlite:///{db_file}")
    getattr(command, direction)(cfg, revision)


def _trail(*labels: str) -> str:
    return json.dumps(
        [
            {"id": f"t{i}", "label": label, "at": "2026-01-01"}
            for i, label in enumerate(labels)
        ]
    )


def _seed_old_ideas(db_file: Path) -> None:
    """The ideas of the old model: one of each kind the conversion has to place."""
    conn = sqlite3.connect(db_file)
    conn.execute(
        "INSERT INTO project (id, name, prefix, color, ticket_counter) VALUES ('p1', 'P', 'PP', '#000', 2)"
    )
    # every column the ticket table requires and does not default
    required = {
        r[1]: ("" if "INT" not in r[2].upper() and "FLOAT" not in r[2].upper() else 0)
        for r in conn.execute("PRAGMA table_info(ticket)")
        if r[3] and r[4] is None and not r[5]
    }
    for tid, status in (("PP-1", "done"), ("PP-2", "in-progress"), ("PP-3", "wont_do")):
        values = {
            **required,
            "id": tid,
            "project_id": "p1",
            "title": "t",
            "status": status,
        }
        conn.execute(
            f"INSERT INTO ticket ({', '.join(values)}) VALUES ({', '.join('?' * len(values))})",
            list(values.values()),
        )
    conn.execute(
        "INSERT INTO idea_counter (id, counter) VALUES (1, 0) ON CONFLICT DO NOTHING"
    )
    cols = (
        "id, project_id, title, description, idea_status, idea_energy, tags, problem_statement, "
        "ice_impact, ice_effort, ice_confidence, revisit_date, promoted_to_ticket_id, promoted_at, "
        "activity_trail, microthoughts, assumptions, idea_color, idea_emoji, created_at, updated_at"
    )
    marks = ",".join("?" * 21)
    ideas = [
        # untouched draft -> Inbox
        (
            "IDEA-1",
            "p1",
            "Untouched",
            "",
            "draft",
            None,
            "[]",
            None,
            3,
            3,
            3,
            None,
            None,
            None,
            _trail("Idea created"),
            "[]",
            "[]",
        ),
        # edited draft -> Exploring; keeps assumptions, microthoughts, ICE and energy notes
        (
            "IDEA-2",
            "p1",
            "Worked on",
            "Some text",
            "draft",
            "hot",
            '["a"]',
            "The problem",
            5,
            2,
            4,
            None,
            None,
            None,
            _trail("Idea created", "Fields updated: title"),
            json.dumps([{"id": "m1", "text": "thought", "at": "x"}]),
            json.dumps(
                [
                    {
                        "id": "a1",
                        "text": "Users care",
                        "status": "untested",
                        "at": "2026-02-01",
                    },
                    {
                        "id": "a2",
                        "text": "It is cheap",
                        "status": "validated",
                        "at": "2026-02-02",
                    },
                    {
                        "id": "a3",
                        "text": "They pay",
                        "status": "invalidated",
                        "at": "2026-02-03",
                    },
                ]
            ),
        ),
        (
            "IDEA-3",
            "p1",
            "In review",
            "",
            "in_review",
            None,
            "[]",
            None,
            3,
            3,
            3,
            None,
            None,
            None,
            _trail("Idea created", "Status changed"),
            "[]",
            "[]",
        ),
        # approved, not promoted -> Ready
        (
            "IDEA-4",
            "p1",
            "Approved",
            "",
            "approved",
            None,
            "[]",
            "P",
            3,
            3,
            3,
            None,
            None,
            None,
            _trail("Idea created", "x"),
            "[]",
            "[]",
        ),
        # promoted: ticket done -> Shipped, in progress -> Building, wont_do -> Exploring, gone -> Ready
        (
            "IDEA-5",
            "p1",
            "Shipped",
            "",
            "approved",
            None,
            "[]",
            "P",
            3,
            3,
            3,
            None,
            "PP-1",
            "2026-03-01",
            _trail("Idea created", "x"),
            "[]",
            "[]",
        ),
        (
            "IDEA-6",
            "p1",
            "Building",
            "",
            "approved",
            None,
            "[]",
            "P",
            3,
            3,
            3,
            None,
            "PP-2",
            "2026-03-01",
            _trail("Idea created", "x"),
            "[]",
            "[]",
        ),
        (
            "IDEA-7",
            "p1",
            "Dropped ticket",
            "",
            "approved",
            None,
            "[]",
            "P",
            3,
            3,
            3,
            None,
            "PP-3",
            "2026-03-01",
            _trail("Idea created", "x"),
            "[]",
            "[]",
        ),
        (
            "IDEA-8",
            "p1",
            "Ticket deleted",
            "",
            "approved",
            None,
            "[]",
            "P",
            3,
            3,
            3,
            None,
            "PP-99",
            "2026-03-01",
            _trail("Idea created", "x"),
            "[]",
            "[]",
        ),
        (
            "IDEA-9",
            "p1",
            "Dropped",
            "",
            "dropped",
            None,
            "[]",
            None,
            3,
            3,
            3,
            None,
            None,
            None,
            _trail("Idea created", "x"),
            "[]",
            "[]",
        ),
        # revisit dates: future -> Parked until then, past -> Parked now and back in the Inbox on first open
        (
            "IDEA-10",
            "p1",
            "Later",
            "",
            "in_review",
            None,
            "[]",
            None,
            3,
            3,
            3,
            FUTURE,
            None,
            None,
            _trail("Idea created", "x"),
            "[]",
            "[]",
        ),
        (
            "IDEA-11",
            "p1",
            "Overdue",
            "",
            "in_review",
            None,
            "[]",
            None,
            3,
            3,
            3,
            PAST,
            None,
            None,
            _trail("Idea created", "x"),
            "[]",
            "[]",
        ),
    ]
    for idea in ideas:
        conn.execute(
            f"INSERT INTO idea_ticket ({cols}) VALUES ({marks})",
            (*idea, "yellow", "💡", "2026-01-01", "2026-01-01"),
        )
    conn.commit()
    conn.close()


def _rows(db_file: Path, sql: str) -> list[sqlite3.Row]:
    conn = sqlite3.connect(db_file)
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute(sql).fetchall()
    finally:
        conn.close()


@pytest.fixture
def converted(tmp_path: Path) -> Path:
    db_file = tmp_path / "kanban.db"
    _migrate(db_file, OLD_HEAD)
    _seed_old_ideas(db_file)
    _migrate(db_file, NEW_HEAD)
    return db_file


def test_ideas_are_placed_in_the_stage_the_design_gives_them(converted: Path):
    stages = {
        r["id"]: r["stage"]
        for r in _rows(converted, "SELECT id, stage FROM idea_ticket")
    }
    assert stages == {
        "IDEA-1": "inbox",
        "IDEA-2": "exploring",
        "IDEA-3": "exploring",
        "IDEA-4": "ready",
        "IDEA-5": "shipped",
        "IDEA-6": "building",
        "IDEA-7": "exploring",
        "IDEA-8": "ready",
        "IDEA-9": "archived",
        "IDEA-10": "parked",
        "IDEA-11": "parked",
    }


def test_archived_parked_and_unlinked_details(converted: Path):
    rows = {r["id"]: r for r in _rows(converted, "SELECT * FROM idea_ticket")}
    assert rows["IDEA-9"]["archive_reason"] == "Imported from the old Idea Space"
    assert rows["IDEA-10"]["park_until"] == FUTURE
    assert rows["IDEA-11"]["park_until"] == PAST
    assert rows["IDEA-1"]["park_until"] is None
    # a deleted ticket clears the link; the others keep it
    assert rows["IDEA-8"]["promoted_to_ticket_id"] is None
    assert rows["IDEA-6"]["promoted_to_ticket_id"] == "PP-2"
    assert all(r["source"] == "import" for r in rows.values())


def test_tickets_of_building_and_shipped_ideas_point_back_to_them(converted: Path):
    marks = {
        r["id"]: r["from_idea_id"]
        for r in _rows(converted, "SELECT id, from_idea_id FROM ticket")
    }
    assert marks == {"PP-1": "IDEA-5", "PP-2": "IDEA-6", "PP-3": None}


def test_page_body_and_details_are_built_from_the_old_fields(converted: Path):
    idea = {r["id"]: r for r in _rows(converted, "SELECT * FROM idea_ticket")}["IDEA-2"]
    assert idea["body"] == "## Problem\n\nThe problem\n\nSome text"
    assert idea["details"] == "Energy: hot\nICE: impact 5, effort 2, confidence 4"
    # the old fields stay where they were
    assert (
        idea["description"] == "Some text"
        and idea["problem_statement"] == "The problem"
    )
    assert json.loads(idea["microthoughts"])[0]["text"] == "thought"
    # ... and they are comments on the idea page now
    comments = _rows(converted, "SELECT id, idea_id, body FROM idea_comment")
    assert [(c["id"], c["idea_id"], c["body"]) for c in comments] == [
        ("m1", "IDEA-2", "thought")
    ]


def test_assumptions_become_records_with_medium_impact(converted: Path):
    rows = _rows(
        converted,
        "SELECT id, idea_id, position, text, impact, status FROM idea_assumption ORDER BY position",
    )
    assert [
        (r["id"], r["text"], r["status"], r["impact"], r["position"]) for r in rows
    ] == [
        ("a1", "Users care", "untested", "medium", 0),
        ("a2", "It is cheap", "validated", "medium", 1),
        ("a3", "They pay", "disproved", "medium", 2),
    ]
    assert {r["idea_id"] for r in rows} == {"IDEA-2"}


def test_conversion_is_recorded_in_the_activity_and_nothing_is_lost(converted: Path):
    rows = _rows(converted, "SELECT id, activity_trail FROM idea_ticket")
    assert len(rows) == 11
    for r in rows:
        last = json.loads(r["activity_trail"])[-1]
        assert last["label"].startswith("Converted to the new Idea Space")
        assert last["author"] == "system"


def test_a_backup_is_made_before_converting(converted: Path):
    backups = list(converted.parent.glob("kanban.before-idea-space-*.db"))
    assert len(backups) == 1
    conn = sqlite3.connect(backups[0])
    try:
        # the copy is the database as it was: old shape, all ideas
        columns = [r[1] for r in conn.execute("PRAGMA table_info(idea_ticket)")]
        assert "stage" not in columns
        assert conn.execute("SELECT COUNT(*) FROM idea_ticket").fetchone()[0] == 11
    finally:
        conn.close()


def test_no_backup_when_there_are_no_ideas(tmp_path: Path):
    db_file = tmp_path / "kanban.db"
    _migrate(db_file, OLD_HEAD)
    _migrate(db_file, NEW_HEAD)
    assert list(tmp_path.glob("*.before-idea-space-*.db")) == []


def test_downgrade_writes_assumptions_back_and_upgrade_again_works(converted: Path):
    _migrate(converted, OLD_HEAD, "downgrade")
    conn = sqlite3.connect(converted)
    try:
        assumptions = json.loads(
            conn.execute(
                "SELECT assumptions FROM idea_ticket WHERE id = 'IDEA-2'"
            ).fetchone()[0]
        )
        assert [a["status"] for a in assumptions] == [
            "untested",
            "validated",
            "invalidated",
        ]
        assert conn.execute("SELECT COUNT(*) FROM idea_ticket").fetchone()[0] == 11
    finally:
        conn.close()
    _migrate(converted, NEW_HEAD)


# ── services on the new model ────────────────────────────────────────────────

engine = create_async_engine("sqlite+aiosqlite:///:memory:")
make_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


@pytest.fixture
async def session():
    await fresh_tables(engine)
    async with engine.begin() as conn:
        await conn.execute(text("INSERT INTO idea_counter (id, counter) VALUES (1, 0)"))
    async with make_session() as s:
        s.add(Project(id="p1", name="P", prefix="PP", color="#000"))
        await s.commit()
        yield s


async def test_a_new_idea_starts_in_the_inbox_with_its_page_and_author(session):
    idea = await svc.create_idea_ticket(
        session, "p1", "T", description="D", problem_statement="Why", author="Tuan"
    )
    assert (idea.stage, idea.source, idea.park_until, idea.archive_reason) == (
        "inbox",
        "manual",
        None,
        None,
    )
    assert idea.body == "## Problem\n\nWhy\n\nD"
    assert json.loads(idea.activity_trail)[0]["author"] == "Tuan"


async def test_an_idea_can_belong_to_no_project(session):
    idea = await svc.create_idea_ticket(session, None, "Loose")
    assert idea.project_id is None
    with pytest.raises(ValueError, match="not found"):
        await svc.create_idea_ticket(session, "missing", "x")
    with pytest.raises(ValueError, match="source"):
        await svc.create_idea_ticket(session, None, "x", source="telepathy")


async def test_old_status_moves_keep_the_stage_in_step(session):
    idea = await svc.create_idea_ticket(session, "p1", "T")
    idea = await svc.update_idea_status(session, idea.id, "in_review")
    assert idea.stage == "exploring"
    idea = await svc.update_idea_status(session, idea.id, "approved")
    assert idea.stage == "ready"
    idea = await svc.update_idea_status(session, idea.id, "dropped", reason="no")
    assert (idea.stage, idea.archive_reason) == ("archived", "no")
    idea = await svc.update_idea_status(session, idea.id, "draft")
    assert (idea.stage, idea.archive_reason) == ("exploring", None)


async def test_promoting_makes_the_idea_building_and_building_cannot_be_dropped(
    session,
):
    idea = await svc.create_idea_ticket(session, "p1", "T", problem_statement="P")
    await svc.update_idea_status(session, idea.id, "in_review")
    await svc.update_idea_status(session, idea.id, "approved")
    await idea_promote.promote(
        session, idea.id, project_id="p1", acknowledge_not_ready=True
    )
    idea = await svc.get_idea_ticket(session, idea.id)
    assert idea.stage == "building"
    with pytest.raises(ValueError, match="Not allowed while the ticket is open"):
        await svc.update_idea_status(session, idea.id, "dropped")


async def test_a_parked_idea_returns_to_the_inbox_once_its_date_has_come(session):
    due = await svc.create_idea_ticket(session, "p1", "Due")
    waiting = await svc.create_idea_ticket(session, "p1", "Waiting")
    for idea, date in ((due, PAST), (waiting, FUTURE)):
        idea.stage, idea.park_until = "parked", date
        session.add(idea)
    await session.commit()

    listed = {i.id: i for i in await svc.list_idea_tickets(session, "p1")}
    assert (listed[due.id].stage, listed[due.id].park_until) == ("inbox", None)
    assert (listed[waiting.id].stage, listed[waiting.id].park_until) == (
        "parked",
        FUTURE,
    )
    entry = json.loads(listed[due.id].activity_trail)[-1]
    assert entry["author"] == "system" and "Back in the Inbox" in entry["label"]
    # woken once: asking again changes nothing
    assert await svc.wake_parked_ideas(session) == 0


async def test_assumption_records_carry_impact_status_and_test_ticket(session):
    idea = await svc.create_idea_ticket(session, "p1", "T")
    session.add(
        Ticket(
            id="PP-1", project_id="p1", title="Test it", created_at="x", updated_at="x"
        )
    )
    await session.commit()

    idea = await svc.add_assumption(session, idea.id, "People pay", impact="high")
    a = idea.assumption_records[0]
    assert (a.impact, a.status, a.test_ticket_id) == ("high", "untested", None)

    idea = await svc.update_assumption_status(session, idea.id, a.id, "invalidated")
    assert idea.assumption_records[0].status == "disproved"
    idea = await svc.update_assumption_status(session, idea.id, a.id, "testing")
    idea = await svc.update_assumption(
        session,
        idea.id,
        a.id,
        text="They pay monthly",
        impact="low",
        test_ticket_id="PP-1",
    )
    a = idea.assumption_records[0]
    assert (a.text, a.impact, a.status, a.test_ticket_id) == (
        "They pay monthly",
        "low",
        "testing",
        "PP-1",
    )
    with pytest.raises(ValueError, match="not found"):
        await svc.update_assumption(session, idea.id, a.id, test_ticket_id="PP-404")
    with pytest.raises(ValueError, match="impact"):
        await svc.add_assumption(session, idea.id, "x", impact="huge")

    idea = await svc.update_assumption(session, idea.id, a.id, test_ticket_id=None)
    assert idea.assumption_records[0].test_ticket_id is None


async def test_deleting_an_assumption_renumbers_the_rest(session):
    idea = await svc.create_idea_ticket(session, "p1", "T")
    for t in ("one", "two", "three"):
        idea = await svc.add_assumption(session, idea.id, t)
    idea = await svc.delete_assumption(session, idea.id, idea.assumption_records[0].id)
    assert [(a.text, a.position) for a in idea.assumption_records] == [
        ("two", 0),
        ("three", 1),
    ]


async def test_deleting_an_idea_removes_its_assumptions_and_votes(session):
    idea = await svc.create_idea_ticket(session, "p1", "T")
    await svc.add_assumption(session, idea.id, "x")
    session.add(IdeaVote(idea_id=idea.id, voter="Tuan"))
    await session.commit()
    assert await svc.delete_idea_ticket(session, idea.id)
    for table in ("idea_assumption", "idea_vote"):
        count = (await session.execute(text(f"SELECT COUNT(*) FROM {table}"))).scalar()
        assert count == 0


async def test_a_person_votes_once_per_idea(session):
    idea_id = (await svc.create_idea_ticket(session, "p1", "T")).id
    session.add(IdeaVote(idea_id=idea_id, voter="Tuan"))
    await session.commit()
    session.add(IdeaVote(idea_id=idea_id, voter="Tuan"))
    with pytest.raises(IntegrityError):
        await session.commit()
    await session.rollback()
    session.add(IdeaVote(idea_id=idea_id, voter="Lan"))
    await session.commit()
    assert len((await svc._reload(session, idea_id)).vote_records) == 2
