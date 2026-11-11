"""Many writers on one SQLite file: SQLite calls take turns, writers wait in line, and two changes of one ticket at once
both stay (dbkit/sqlite_gate.py, services.tickets._for_edit)."""

import asyncio
import sqlite3

import aiosqlite
import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy import text
from sqlalchemy.orm import sessionmaker
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from dbkit import sqlite_gate, targets
from main import app
from tests.fast_db import fresh_db_file


@pytest.fixture
async def engine(tmp_path):
    fresh_db_file(tmp_path / "board.db")
    with sqlite3.connect(tmp_path / "board.db") as raw:  # as init_db leaves the board's file
        raw.execute("PRAGMA journal_mode=WAL")
    eng = targets.make_engine(targets.Target("sqlite", path=str(tmp_path / "board.db")))
    yield eng
    await eng.dispose()


@pytest.fixture
async def client(engine):
    maker = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def session():
        async with maker() as s:
            yield s

    app.dependency_overrides[get_session] = session
    async with httpx.AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c
    app.dependency_overrides.pop(get_session, None)


def test_aiosqlite_still_sends_every_call_through_execute():
    # The gate overrides this private method; a new aiosqlite that renamed it would bypass the gate silently.
    assert callable(getattr(aiosqlite.Connection, "_execute", None))
    assert callable(getattr(aiosqlite.Connection, "stop", None))


@pytest.mark.parametrize(
    "sql, waits",
    [
        ("SELECT 1", False),
        ("  select * from ticket", False),
        ("WITH a AS (SELECT 1) SELECT * FROM a", False),
        ("WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a", True),
        ("PRAGMA data_version", False),
        ("PRAGMA busy_timeout=30000", False),
        ("PRAGMA journal_mode=WAL", True),
        ("PRAGMA wal_checkpoint(TRUNCATE)", True),
        ("INSERT INTO ticket VALUES (1)", True),
        ("UPDATE ticket SET title = 'x'", True),
        ("BEGIN IMMEDIATE", True),
        ("CREATE TABLE t (a)", True),
    ],
)
def test_which_statements_can_wait_for_the_write_lock(sql, waits):
    assert sqlite_gate.may_wait(sql) is waits


async def test_the_write_gate_is_held_for_the_transaction_and_let_go_after(engine):
    async with engine.connect() as a:
        await a.execute(text("CREATE TABLE IF NOT EXISTS gate_t (n INTEGER)"))
        await a.commit()
        await a.execute(text("INSERT INTO gate_t VALUES (1)"))
        raw = (await a.get_raw_connection()).driver_connection
        assert raw._gate is not None and raw._gate.locked()
        await a.rollback()
        assert raw._gate is None
    # a second writer waits for the first instead of failing, and gets in once it commits
    order: list[str] = []

    async def writer(name: str, hold: float) -> None:
        async with engine.begin() as conn:
            await conn.execute(text("INSERT INTO gate_t VALUES (2)"))
            order.append(f"{name} in")
            await asyncio.sleep(hold)
            order.append(f"{name} out")

    await asyncio.gather(writer("first", 0.2), writer("second", 0))
    assert order == ["first in", "first out", "second in", "second out"]


async def test_a_connection_closed_without_a_call_lets_the_next_writer_in(tmp_path):
    conn = await sqlite_gate.connector(str(tmp_path / "x.db"))()
    await conn.execute("CREATE TABLE t (n INTEGER)")
    await conn.execute("INSERT INTO t VALUES (1)")  # a transaction is open
    gate = conn._gate
    assert gate is not None and gate.locked()
    await conn.stop()  # what SQLAlchemy's terminate does
    assert not gate.locked()


async def test_a_writer_that_never_gets_its_turn_fails_like_a_locked_database(
    engine, monkeypatch
):
    monkeypatch.setattr(sqlite_gate, "WRITE_WAIT_S", 0.1)
    async with engine.connect() as a:
        await a.execute(text("CREATE TABLE IF NOT EXISTS gate_t (n INTEGER)"))
        await a.commit()
        await a.execute(text("INSERT INTO gate_t VALUES (1)"))
        async with engine.connect() as b:
            with pytest.raises(Exception) as err:
                await b.execute(text("INSERT INTO gate_t VALUES (2)"))
            assert isinstance(err.value.orig, sqlite3.OperationalError)  # type: ignore[attr-defined]
        await a.rollback()


async def test_comments_and_criteria_added_at_once_are_all_kept(client):
    """Ten AIs commenting on one ticket at once: every comment stays (the second writer no longer overwrites the
    first one's list)."""
    r = await client.post(
        "/projects", json={"name": "Load", "prefix": "LD", "color": "#123456"}
    )
    pid = r.json()["id"]
    tid = (
        await client.post(f"/projects/{pid}/tickets", json={"title": "Shared"})
    ).json()["id"]
    n = 20
    results = await asyncio.gather(
        *(
            client.post(
                f"/tickets/{tid}/comments",
                json={"text": f"note {i}", "author": f"AI {i}"},
            )
            for i in range(n)
        ),
        *(
            client.post(
                f"/tickets/{tid}/acceptance-criteria", json={"text": f"crit {i}"}
            )
            for i in range(n)
        ),
    )
    assert all(r.status_code in (200, 201) for r in results), [
        r.text for r in results if r.status_code >= 300
    ]
    ticket = (await client.get(f"/tickets/{tid}")).json()
    assert sorted(c["text"] for c in ticket["comments"]) == sorted(
        f"note {i}" for i in range(n)
    )
    assert len(ticket["acceptance_criteria"]) == n


async def test_reads_take_turns_only_in_wal_mode(tmp_path):
    """Outside WAL a read can wait for a commit: it must not hold the call lock meanwhile."""
    old = await sqlite_gate.connector(str(tmp_path / "old.db"))()
    assert old._wal is False
    await old.close()
    with sqlite3.connect(tmp_path / "wal.db") as raw:
        raw.execute("PRAGMA journal_mode=WAL")
    wal = await sqlite_gate.connector(str(tmp_path / "wal.db"))()
    assert wal._wal is True
    await wal.close()
