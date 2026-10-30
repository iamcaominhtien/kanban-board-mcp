"""The SSE hub: slow subscribers keep their stream, and changes made by another process are announced."""

import asyncio
import sqlite3

import events


async def _drain(q: asyncio.Queue) -> list[str]:
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return out


async def test_full_queue_keeps_the_subscriber_and_drops_the_oldest():
    q = events.subscribe()
    try:
        for i in range(100):
            await events.publish(f"e{i}")
        await events.publish("latest")
        assert q in events._subscribers
        got = await _drain(q)
        assert len(got) == 100
        assert got[0] == "e1" and got[-1] == "latest"
    finally:
        events.unsubscribe(q)


async def test_change_from_another_process_is_published(tmp_path):
    db = tmp_path / "kanban.db"
    writer = sqlite3.connect(db)
    writer.execute("PRAGMA journal_mode=WAL")
    writer.execute("CREATE TABLE t (x)")
    writer.commit()
    q = events.subscribe()
    task = asyncio.create_task(events.watch_database(db, interval=0.02, grace=0.02))
    try:
        await asyncio.sleep(0.15)  # the watcher takes its first reading
        assert await _drain(q) == []
        writer.execute("INSERT INTO t VALUES (1)")
        writer.commit()
        assert await asyncio.wait_for(q.get(), 2) == events.INVALIDATE
    finally:
        task.cancel()
        events.unsubscribe(q)
        writer.close()


async def test_change_this_process_already_announced_is_not_repeated(tmp_path):
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
        await asyncio.sleep(0.04)  # the watcher saw it and is in its grace period
        await events.publish(
            events.INVALIDATE
        )  # what a REST handler does right after its commit
        await asyncio.sleep(0.3)
        assert await _drain(q) == [events.INVALIDATE]
    finally:
        task.cancel()
        events.unsubscribe(q)
        writer.close()
