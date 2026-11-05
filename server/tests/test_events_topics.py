"""Announcements with topics, and the typed events of AI v2 runs."""

import asyncio
import json

import events as board_events


async def test_a_topic_makes_the_announcement_say_what_changed():
    q = board_events.subscribe()
    try:
        await board_events.publish(board_events.INVALIDATE)
        await board_events.publish(board_events.INVALIDATE, topics=("ai", "ai"))
        assert q.get_nowait() == "invalidate"
        assert json.loads(q.get_nowait()) == {"type": "invalidate", "topics": ["ai"]}
    finally:
        board_events.unsubscribe(q)


async def test_a_runs_steps_are_one_typed_event_not_a_refetch():
    """AI v2: the app patches its cache from `ai.step`; nothing asks every screen to refetch."""
    q = board_events.subscribe()
    try:
        await board_events.publish_typed(
            "ai.step", {"run_id": "r1", "steps": [{"seq": 1}]}
        )
        got = json.loads(q.get_nowait())
        assert got == {"type": "ai.step", "run_id": "r1", "steps": [{"seq": 1}]}
        assert q.empty()
    finally:
        board_events.unsubscribe(q)
        await asyncio.sleep(0)


async def test_a_typed_event_counts_as_this_process_changing_the_database():
    before = board_events._published
    q = board_events.subscribe()
    try:
        await board_events.publish_typed("ai.run", {"run": {"id": "r1"}})
        assert board_events._published == before + 1
    finally:
        board_events.unsubscribe(q)


async def test_the_watcher_announces_another_process_but_not_a_change_this_one_announced(
    tmp_path,
):
    import sqlite3

    path = tmp_path / "w.db"
    conn = sqlite3.connect(path)
    conn.execute("create table t (x)")
    conn.commit()
    watcher = asyncio.create_task(
        board_events.watch_database(path, interval=0.05, grace=0.02)
    )
    q = board_events.subscribe()
    try:
        await asyncio.sleep(0.2)
        # this process commits and announces: one announcement, not two
        conn.execute("insert into t values (1)")
        conn.commit()
        await board_events.publish(board_events.INVALIDATE)
        await asyncio.sleep(0.3)
        assert q.qsize() == 1
        q.get_nowait()
        # another process commits and says nothing: the watcher announces it
        conn.execute("insert into t values (2)")
        conn.commit()
        await asyncio.sleep(0.3)
        assert q.qsize() == 1
    finally:
        watcher.cancel()
        board_events.unsubscribe(q)
        conn.close()
