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

# Called (without waiting) on every publish: the notification centre checks its open rows soon after any change
_on_publish: list = []

# Number of events published so far (lets the database watcher tell whether this process already announced a change)
_published = 0


def subscribe() -> asyncio.Queue:
    """Register a new SSE subscriber and return its queue."""
    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    _subscribers.add(q)
    return q


def on_publish(callback) -> None:
    """Call `callback()` (synchronously, cheaply) whenever something is published."""
    if callback not in _on_publish:
        _on_publish.append(callback)


def unsubscribe(q: asyncio.Queue) -> None:
    """Remove a subscriber's queue."""
    _subscribers.discard(q)


_forwarder = None  # set in the runner process: events go to the API over HTTP instead of local subscribers


def set_forwarder(fn) -> None:
    """Route every announcement through `fn(event_json)` (the runner process has no SSE subscribers of its own)."""
    global _forwarder
    _forwarder = fn


async def publish(event: str, topics: Iterable[str] | None = None) -> None:
    """Broadcast an event string to all active SSE subscribers.

    With `topics` an invalidation says what changed ({"type": "invalidate", "topics": [...]}), so the app refetches
    only that. Without, it is the plain string and the app refetches everything.

    A subscriber that is behind keeps its place: its oldest event is dropped for the new one. (Dropping the
    subscriber instead would leave its stream open but silent, so the board stopped updating until a restart.)
    """
    global _published
    _published += 1
    for cb in _on_publish:
        try:
            cb()
        except Exception:  # noqa: BLE001 - a listener never stops an announcement
            logger.debug("A publish listener failed", exc_info=True)
    if topics:
        event = json.dumps({"type": event, "topics": sorted(set(topics))})
    if _forwarder is not None:
        await _forwarder(event)
        return
    for q in _subscribers:
        if q.full():
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:
                pass
        q.put_nowait(event)


async def publish_typed(kind: str, payload: dict) -> None:
    """Broadcast a typed event (AI v2): `{"type": kind, ...payload}`. The app patches its cache from it instead of
    refetching; `kind` is `ai.step`, `ai.run`, `ai.agent` or `ai.message`."""
    global _published
    _published += 1
    for cb in _on_publish:
        try:
            cb()
        except Exception:  # noqa: BLE001 - a listener never stops an announcement
            logger.debug("A publish listener failed", exc_info=True)
    event = json.dumps({"type": kind, **payload}, default=str)
    if _forwarder is not None:
        await _forwarder(event)
        return
    for q in _subscribers:
        if q.full():
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:
                pass
        q.put_nowait(event)


def broadcast_raw(event: str) -> None:
    """An event that arrived from the runner process: to every subscriber as it is."""
    global _published
    _published += 1
    for cb in _on_publish:
        try:
            cb()
        except Exception:  # noqa: BLE001
            logger.debug("A publish listener failed", exc_info=True)
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
    path: Path | None = None, interval: float = 0.4, grace: float = 0.15
) -> None:
    """Announce changes that another process made to the database.

    The stdio MCP server (`mcp_stdio.py`, what the desktop app and editors launch) is a separate process from the
    API: its own `publish` reaches nobody, so the board only showed the change after a restart. This loop notices
    such changes and publishes one invalidation. A change this process published itself (a REST call, an MCP call
    over HTTP) is not repeated.

    On SQLite it reads the commit counter of *other* connections (`PRAGMA data_version`); on PostgreSQL and MySQL it
    reads the newest row another process added to the change log (`dbkit.changes`). It follows the database in use,
    so a switch in Settings needs no restart.

    Args:
        path: The SQLite file to watch; None follows the database in use.
        interval: Seconds between checks.
        grace: Seconds to wait after a change, for this process's own `publish` to land.
    """
    import database

    conn: sqlite3.Connection | None = None
    conn_path: Path | None = None
    seen: int | None = None
    watching = None  # the engine (server database) or the path (SQLite) the last value came from
    trimmed_at = 0.0
    # What this process had announced when the version was last read: an announcement since then explains a change
    seen_published = _published

    def close() -> None:
        nonlocal conn, conn_path
        if conn is not None:
            conn.close()
        conn = conn_path = None

    def check(db_path: Path) -> int:
        nonlocal conn, conn_path
        if conn is None or conn_path != db_path:
            close()
            conn = sqlite3.connect(db_path, timeout=1, check_same_thread=False)
            conn_path = db_path
        return conn.execute("PRAGMA data_version").fetchone()[0]

    while True:
        try:
            await asyncio.sleep(interval)
            if path is not None or database.is_sqlite():
                db_path = path or database.get_db_path()
                source = db_path
                version = await asyncio.to_thread(check, db_path)
                server = False
            else:
                close()
                from dbkit import changes

                source = database.engine
                version = await changes.latest_from_others(source)
                server = True
            if source != watching:
                seen, watching = (
                    None,
                    source,
                )  # another database: start over, nothing to announce yet
            if seen is not None and version != seen:
                await asyncio.sleep(grace)
                # Counted from the last read, not from now: this process announces right after it commits, usually
                # before the watcher looks, and a change it announced must not be announced a second time. The
                # change log of a server database names the writer, so only other processes' rows are counted.
                if server or _published == seen_published:
                    await publish(INVALIDATE)
            seen = version
            seen_published = _published
            if server and asyncio.get_running_loop().time() - trimmed_at > 300:
                trimmed_at = asyncio.get_running_loop().time()
                await changes.trim(source)
        except asyncio.CancelledError:
            close()
            raise
        except Exception:
            logger.debug("Database watcher could not read the version", exc_info=True)
            close()
            seen = None
