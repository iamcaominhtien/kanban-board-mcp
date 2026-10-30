import asyncio
import logging
import sqlite3
from pathlib import Path

logger = logging.getLogger("kanban.events")

# ---------------------------------------------------------------------------
# Event type constants
# ---------------------------------------------------------------------------

INVALIDATE = "invalidate"

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


async def publish(event: str) -> None:
    """Broadcast an event string to all active SSE subscribers.

    A subscriber that is behind keeps its place: its oldest event is dropped for the new one. (Dropping the
    subscriber instead would leave its stream open but silent, so the board stopped updating until a restart.)
    """
    global _published
    _published += 1
    for q in _subscribers:
        if q.full():
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:
                pass
        q.put_nowait(event)


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

    def check() -> int:
        nonlocal conn
        if conn is None:
            conn = sqlite3.connect(path, timeout=1, check_same_thread=False)
        return conn.execute("PRAGMA data_version").fetchone()[0]

    while True:
        try:
            await asyncio.sleep(interval)
            before = _published
            version = await asyncio.to_thread(check)
            if seen is not None and version != seen:
                await asyncio.sleep(grace)
                if _published == before:
                    await publish(INVALIDATE)
            seen = version
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
