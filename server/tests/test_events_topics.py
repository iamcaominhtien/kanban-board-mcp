"""Announcements with topics: a run's steady stream says only that the AI screens changed."""

import asyncio
import json

import events as board_events
from services.ai import runs


async def test_a_topic_makes_the_announcement_say_what_changed():
    q = board_events.subscribe()
    try:
        await board_events.publish(board_events.INVALIDATE)
        await board_events.publish(board_events.INVALIDATE, topics=("ai", "ai"))
        assert q.get_nowait() == "invalidate"
        assert json.loads(q.get_nowait()) == {"type": "invalidate", "topics": ["ai"]}
    finally:
        board_events.unsubscribe(q)


async def test_the_step_stream_names_the_ai_topic_but_a_state_change_says_anything():
    q = board_events.subscribe()
    try:
        runs.RT.last_publish = -1e9
        await runs._publish()
        assert json.loads(q.get_nowait())["topics"] == ["ai"]
        # inside the second: nothing more is announced
        await runs._publish()
        assert q.empty()
        await runs._publish(force=True)
        assert q.get_nowait() == "invalidate"
    finally:
        board_events.unsubscribe(q)
        await asyncio.sleep(0)


async def test_a_throttled_step_still_counts_as_this_process_changing_the_database():
    before = board_events._published
    runs.RT.last_publish = asyncio.get_running_loop().time()
    q = board_events.subscribe()
    try:
        await runs._publish()
        assert q.empty() and board_events._published == before + 1
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
