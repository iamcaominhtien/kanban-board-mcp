"""While an AI runs in the runner process, the windows must not be told "anything changed" over and over.

`ai.resources` (RAM and CPU every 2 s) is a reading, not an announcement; the runner tells the API when it wrote
(`own_change`), so the database watcher does not take the runner's commits for another app's; on a server database
the runner's rows of the change log are not "another process's".
"""

import asyncio
import sqlite3
import time

import httpx
from httpx import ASGITransport
from sqlalchemy import insert
from sqlalchemy.ext.asyncio import create_async_engine

import database
import events
from dbkit import changes, targets
from models import Project
from runner import main as runner_main
from services.ai import runner_link


async def _drain(q: asyncio.Queue) -> list[str]:
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return out


def _no_global(got: list[str]) -> bool:
    """Nothing told every window to refetch everything; at most the occasional refetch of tickets and Docs that stands
    in for another app's change hidden behind the runner's (events.RUNNER_MASK_REFRESH_S)."""
    return all(
        g == '{"type": "invalidate", "topics": ["docs", "tickets"]}' for g in got
    )


async def test_ai_resources_reaches_the_windows_but_is_not_an_announcement():
    calls: list[int] = []

    def listener() -> None:
        calls.append(1)

    events.on_publish(listener)
    q = events.subscribe()
    try:
        before = events._published
        await events.publish_typed("ai.resources", {"project_id": "p", "runs": []})
        events.broadcast_raw('{"type": "ai.resources", "project_id": "p"}')
        assert events._published == before
        assert calls == []
        got = await _drain(q)
        assert len(got) == 2 and all('"ai.resources"' in g for g in got)
        # a real change still counts
        events.broadcast_raw('{"type": "ai.step", "run_id": "r"}')
        assert events._published == before + 1
        assert calls == [1]
    finally:
        events.unsubscribe(q)
        events._on_publish.remove(listener)


async def test_another_apps_change_is_announced_while_readings_keep_coming(tmp_path):
    db = tmp_path / "kanban.db"
    writer = sqlite3.connect(db)
    writer.execute("PRAGMA journal_mode=WAL")
    writer.execute("CREATE TABLE t (x)")
    writer.commit()
    q = events.subscribe()
    task = asyncio.create_task(events.watch_database(db, interval=0.02, grace=0.1))
    try:
        await asyncio.sleep(0.15)
        writer.execute("INSERT INTO t VALUES (1)")
        writer.commit()
        for _ in range(5):  # readings during the grace period explain nothing
            await asyncio.sleep(0.03)
            await events.publish_typed("ai.resources", {"project_id": "p"})
        await asyncio.sleep(0.3)
        assert events.INVALIDATE in await _drain(q)
    finally:
        task.cancel()
        events.unsubscribe(q)
        writer.close()


async def test_the_runners_own_change_is_not_announced_as_another_apps(tmp_path):
    db = tmp_path / "kanban.db"
    writer = sqlite3.connect(db)
    writer.execute("PRAGMA journal_mode=WAL")
    writer.execute("CREATE TABLE t (x)")
    writer.commit()
    q = events.subscribe()
    task = asyncio.create_task(events.watch_database(db, interval=0.02, grace=0.1))
    try:
        await asyncio.sleep(0.15)
        writer.execute("INSERT INTO t VALUES (1)")
        writer.commit()
        events.mark_own_change([time.time()])  # what POST /internal/ai/events does
        await asyncio.sleep(0.3)
        assert _no_global(await _drain(q))
    finally:
        task.cancel()
        events.unsubscribe(q)
        writer.close()


async def test_a_runner_commit_told_while_the_watcher_waits_is_still_the_runners(
    tmp_path,
):
    """The watcher sees a change and waits for its announcement; the runner commits again meanwhile and says so at
    once. That second commit is only seen at the next reading, and must not be taken for another app's."""
    db = tmp_path / "kanban.db"
    writer = sqlite3.connect(db)
    writer.execute("PRAGMA journal_mode=WAL")
    writer.execute("CREATE TABLE t (x)")
    writer.commit()
    q = events.subscribe()
    task = asyncio.create_task(events.watch_database(db, interval=0.05, grace=0.3))
    try:
        await asyncio.sleep(0.2)
        writer.execute("INSERT INTO t VALUES (1)")
        writer.commit()
        events.mark_own_change([time.time()])
        await asyncio.sleep(0.15)  # the watcher saw the first commit and waits
        writer.execute("INSERT INTO t VALUES (2)")
        writer.commit()
        events.mark_own_change([time.time()])
        await asyncio.sleep(0.8)
        assert _no_global(await _drain(q))
        # another app's commit, long after the runner's, is announced
        writer.execute("INSERT INTO t VALUES (3)")
        writer.commit()
        assert await asyncio.wait_for(q.get(), 2) == events.INVALIDATE
    finally:
        task.cancel()
        events.unsubscribe(q)
        writer.close()


async def test_own_change_over_http_counts_and_reaches_nobody():
    from main import app

    q = events.subscribe()
    try:
        before = events._published
        now = time.time()
        async with httpx.AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            refused = await client.post(
                "/internal/ai/events", json={"own_change": True}
            )
            assert refused.status_code == 403
            ok = await client.post(
                "/internal/ai/events",
                json={"own_change": True, "at": [now - 0.2, now]},
                headers={"X-Kanban-Internal": runner_link.TOKEN},
            )
        assert ok.status_code == 200
        # timed commits are matched to the readings by time, not counted as an announcement
        assert events._published == before
        assert events._runner_committed(now - 0.1, now + 0.1)
        assert not events._runner_committed(now + 1, now + 2)
        assert await _drain(q) == []
    finally:
        events.unsubscribe(q)


async def test_a_writing_commit_is_told_and_a_reading_one_is_not():
    calls: list[set[str]] = []

    def listener(tables: set[str]) -> None:
        calls.append(tables)

    changes.on_write_commit(listener)
    try:
        async with database.async_session() as session:
            await session.get(Project, "nope")
            await session.commit()
        assert calls == []
        async with database.async_session() as session:
            session.add(Project(name="Told", prefix="TLD", color="#336699"))
            await session.commit()
        assert len(calls) == 1 and "project" in calls[0]
    finally:
        changes._on_write_commit.remove(listener)


async def test_the_runners_rows_of_the_change_log_are_not_another_apps(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'log.db'}")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(changes.metadata.create_all)
            await conn.execute(
                insert(changes.kanban_change).values(origin="other-app", at=1.0)
            )
            await conn.execute(
                insert(changes.kanban_change).values(
                    origin=runner_link.RUNNER_ORIGIN, at=2.0
                )
            )
            await conn.execute(
                insert(changes.kanban_change).values(
                    origin=targets.PROCESS_TOKEN[:32], at=3.0
                )
            )
        changes.ignore_origin(runner_link.RUNNER_ORIGIN)
        assert await changes.latest_from_others(engine) == 1
    finally:
        changes._ignored_origins.discard(runner_link.RUNNER_ORIGIN[:32])
        await engine.dispose()


async def test_the_runner_tells_its_writes_in_few_posts(monkeypatch):
    posted: list[dict] = []
    gate = asyncio.Event()

    async def post(self, body: dict) -> None:
        posted.append(body)
        await gate.wait()

    monkeypatch.setattr(runner_main.Forwarder, "_post", post)
    fwd = runner_main.Forwarder("http://127.0.0.1:1", "t")
    fwd.bind(asyncio.get_running_loop())
    for _ in range(10):
        fwd.note_write({"ai_run_step"})
    await asyncio.sleep(0.01)
    assert len(posted) == 1 and posted[0]["own_change"] is True  # one on its way
    assert len(posted[0]["at"]) == 10
    for _ in range(3):
        fwd.note_write({"ai_run"})
    gate.set()
    await asyncio.sleep(0.05)
    assert (
        len(posted) == 2 and len(posted[1]["at"]) == 3
    )  # the writes meanwhile, in one more


async def test_a_ticket_the_runner_wrote_is_announced_once_for_a_burst(monkeypatch):
    """A run's closing comment, its question, Pending, the work log: the windows refetch the tickets."""
    posted: list[dict] = []

    async def post(self, body: dict) -> None:
        posted.append(body)

    monkeypatch.setattr(runner_main.Forwarder, "_post", post)
    fwd = runner_main.Forwarder("http://127.0.0.1:1", "t")
    fwd.bind(asyncio.get_running_loop())
    fwd.note_write({"ai_run_step"})
    await asyncio.sleep(0.02)
    assert all("event" not in b for b in posted)
    for _ in range(5):
        fwd.note_write({"ticket", "ai_run"})
    await asyncio.sleep(0.05)
    told = [b["event"] for b in posted if "event" in b]
    assert told and len(told) <= 2
    assert all(t == '{"type": "invalidate", "topics": ["tickets"]}' for t in told)


async def test_the_change_log_is_written_by_a_plain_add_then_commit(tmp_path):
    """On a server database the change log gets its row even when commit() does the only flush (no explicit flush)."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'log.db'}")
    from sqlalchemy import select
    from sqlmodel import SQLModel

    try:
        async with engine.begin() as conn:
            await conn.run_sync(changes.metadata.create_all)
            await conn.run_sync(SQLModel.metadata.create_all)
        # pretend the dialect is a server's, so the row is written (SQLite itself never has the table)
        from sqlmodel.ext.asyncio.session import AsyncSession

        async with AsyncSession(engine) as session:
            monkey = session.sync_session.get_bind().dialect
            real = monkey.name
            monkey.name = "postgresql"
            try:
                session.add(Project(name="Logged", prefix="LOG", color="#336699"))
                await session.commit()
            finally:
                monkey.name = real
        async with engine.connect() as conn:
            rows = (await conn.execute(select(changes.kanban_change))).all()
        assert len(rows) == 1
    finally:
        await engine.dispose()


async def test_another_apps_change_hidden_by_the_runners_still_refreshes_tickets_and_docs(
    tmp_path, monkeypatch
):
    """The runner commits about once a second; another app (an editor's MCP server) edits a ticket at the same
    moment. SQLite cannot tell the two apart, so the tickets and Docs are refetched now and then (not everything)."""
    monkeypatch.setattr(events, "RUNNER_MASK_REFRESH_S", 0.5)
    db = tmp_path / "kanban.db"
    writer = sqlite3.connect(db)
    writer.execute("PRAGMA journal_mode=WAL")
    writer.execute("CREATE TABLE t (x)")
    writer.commit()
    q = events.subscribe()
    task = asyncio.create_task(events.watch_database(db, interval=0.05, grace=0.05))
    try:
        await asyncio.sleep(0.2)
        for i in range(8):
            writer.execute(
                "INSERT INTO t VALUES (?)", (i,)
            )  # the runner's commit and, once, another app's with it
            writer.commit()
            events.mark_own_change([time.time()])
            await asyncio.sleep(0.15)
        got = await _drain(q)
        assert '{"type": "invalidate", "topics": ["docs", "tickets"]}' in got
        assert events.INVALIDATE not in got
    finally:
        task.cancel()
        events.unsubscribe(q)
        writer.close()
