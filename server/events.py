import asyncio
import json
import logging
from collections.abc import Iterable
import sqlite3
from pathlib import Path

logger = logging.getLogger("kanban.events")

# ---------------------------------------------------------------------------
# Event type constants
# ---------------------------------------------------------------------------

INVALIDATE = "invalidate"

# What an announcement can say changed. The app refetches only what depends on a topic; an announcement with no topic
# means "anything may have changed" and refetches everything (what every call site did before topics).
TOPIC_AI = "ai"  # a run's steps and state: the AI screens, the run panels, the workspace of a ticket

# Global set of subscriber queues
_subscribers: set[asyncio.Queue] = set()

# Number of events published so far (lets the database watcher tell whether this process already announced a change)
_published = 0


def subscribe() -> asyncio.Queue:
    """Register a new SSE subscriber and return its queue."""
    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    _subscribers.add(q)
    return q


def unsubscribe(q: asyncio.Queue) -> None:
    """Remove a subscriber's queue."""
    _subscribers.discard(q)


async def publish(event: str, topics: Iterable[str] | None = None) -> None:
    """Broadcast an event string to all active SSE subscribers.

    With `topics` an invalidation says what changed ({"type": "invalidate", "topics": [...]}), so the app refetches
    only that. Without, it is the plain string and the app refetches everything.

    A subscriber that is behind keeps its place: its oldest event is dropped for the new one. (Dropping the
    subscriber instead would leave its stream open but silent, so the board stopped updating until a restart.)
    """
    global _published
    _published += 1
    if topics:
        event = json.dumps({"type": event, "topics": sorted(set(topics))})
    for q in _subscribers:
        if q.full():
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:
                pass
        q.put_nowait(event)


def mark_own_change() -> None:
    """Note that this process changed the database and chose not to announce it yet (a run's steps are announced at
    most once a second). The database watcher then does not take the commit for another process's."""
    global _published
    _published += 1


async def watch_database(
    path: Path, interval: float = 0.4, grace: float = 0.15
) -> None:
    """Announce changes that another process made to the database.

    The stdio MCP server (`mcp_stdio.py`, what the desktop app and editors launch) is a separate process from the
    API: its own `publish` reaches nobody, so the board only showed the change after a restart. SQLite counts the
    commits of *other* connections (`PRAGMA data_version`), so this loop notices them and publishes one
    invalidation. A change this process published itself (a REST call, an MCP call over HTTP) is not repeated.

    Args:
        path: The SQLite file.
        interval: Seconds between checks.
        grace: Seconds to wait after a change, for this process's own `publish` to land.
    """
    conn: sqlite3.Connection | None = None
    seen: int | None = None
    # What this process had announced when the version was last read: an announcement since then explains a change
    seen_published = _published

    def check() -> int:
        nonlocal conn
        if conn is None:
            conn = sqlite3.connect(path, timeout=1, check_same_thread=False)
        return conn.execute("PRAGMA data_version").fetchone()[0]

    while True:
        try:
            await asyncio.sleep(interval)
            version = await asyncio.to_thread(check)
            if seen is not None and version != seen:
                await asyncio.sleep(grace)
                # Counted from the last read, not from now: this process announces right after it commits, usually
                # before the watcher looks, and a change it announced must not be announced a second time
                if _published == seen_published:
                    await publish(INVALIDATE)
            seen = version
            seen_published = _published
        except asyncio.CancelledError:
            if conn is not None:
                conn.close()
            raise
        except Exception:
            logger.debug("Database watcher could not read the version", exc_info=True)
            if conn is not None:
                conn.close()
            conn = None
            seen = None
