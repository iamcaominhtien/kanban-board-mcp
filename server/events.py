import asyncio
import json
import logging
import time
from collections import deque
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

# Typed events that are readings, not changes (publish_typed): they reach the windows but are not announcements
QUIET_KINDS = frozenset({"ai.resources"})
_QUIET_PREFIXES = tuple(f'{{"type": "{k}"' for k in QUIET_KINDS)


def _is_quiet(event: str) -> bool:
    """Is this event string (as publish_typed wrote it) one of the QUIET_KINDS?"""
    return event.startswith(_QUIET_PREFIXES)


# Global set of subscriber queues
_subscribers: set[asyncio.Queue] = set()

# Called (without waiting) on every publish: the notification centre checks its open rows soon after any change
_on_publish: list = []

# Number of events published so far (lets the database watcher tell whether this process already announced a change)
_published = 0

# When the AI runner's commits happened (time.time(), told by the runner with `own_change`): the database watcher
# takes a change it sees for the runner's when one of these falls between its last two readings
_runner_commits: deque[float] = deque(maxlen=2000)


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


def mark_announced() -> None:
    """Count a change of this process as announced without telling anyone (nothing the app shows changed): the
    database watcher then does not announce it as another process's."""
    global _published
    _published += 1


async def publish_typed(kind: str, payload: dict) -> None:
    """Broadcast a typed event (AI v2): `{"type": kind, ...payload}`. The app patches its cache from it instead of
    refetching; `kind` is `ai.step`, `ai.run`, `ai.agent`, `ai.message` or `ai.resources`.

    `ai.resources` (RAM and CPU every 2 s while a CLI runs) is a reading, not a change: it does not count as an
    announcement (the database watcher would take another process's change for this one's) and does not wake the
    notification centre."""
    global _published
    if kind not in QUIET_KINDS:
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
    if not _is_quiet(event):
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


def mark_own_change(at: Iterable[float] | None = None) -> None:
    """Note that this process changed the database and chose not to announce it yet (a run's steps are announced at
    most once a second). The database watcher then does not take the commit for another process's.

    `at`: the times of commits the AI runner made (`POST /internal/ai/events` with `own_change`). They are matched
    to the watcher's readings by when they happened, not by when the news arrived: a commit made while the watcher
    waits for an announcement is only seen at its next reading, and must be explained there too."""
    global _published
    if at is None:
        _published += 1
        return
    for t in at:
        _runner_commits.append(float(t))


def _runner_committed(after: float, until: float) -> bool:
    """Did the runner say it committed between these two times (with a little slack for the clocks of the reads)?"""
    lo, hi = after - COMMIT_SLACK_S, until + COMMIT_SLACK_S
    for t in reversed(_runner_commits):
        if lo < t <= hi:
            return True
        if t <= lo:
            break
    return False


COMMIT_SLACK_S = 0.05


RUNNER_GRACE_S = 0.5
RUNNER_MASK_REFRESH_S = 15.0


def _grace_for(grace: float) -> float:
    """How long to wait for a change's announcement. The AI runner writes from its own process and says so over
    HTTP (`own_change`), which takes longer than this process's own announcement: wait for it while it runs."""
    try:
        from services.ai import runner_link

        if runner_link.alive():
            return max(grace, RUNNER_GRACE_S)
    except Exception:  # noqa: BLE001 - the watcher never fails over this
        pass
    return grace


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
    # when the version was last read: a runner commit since then explains a change
    read_at = time.time()
    runner_masked_at = 0.0  # the last refetch of tickets and Docs for changes the runner's commits explained

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
            last_read_at = read_at
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
            # after the read: a runner commit made while the version was being read is in this reading
            read_at = time.time()
            if source != watching:
                seen, watching = (
                    None,
                    source,
                )  # another database: start over, nothing to announce yet
            if seen is not None and version != seen:
                await asyncio.sleep(_grace_for(grace))
                # Counted from the last read, not from now: this process announces right after it commits, usually
                # before the watcher looks, and a change it announced must not be announced a second time. The
                # change log of a server database names the writer, so only other processes' rows are counted. A
                # commit the AI runner told about counts when it was made between the last reading and this one.
                if server or _published == seen_published:
                    if server or not _runner_committed(last_read_at, read_at):
                        await publish(INVALIDATE)
                    elif time.time() - runner_masked_at >= RUNNER_MASK_REFRESH_S:
                        # SQLite does not say who wrote: a change made by another app in the same moment as one of
                        # the runner's (an editor's MCP server, while a run streams) would never show. So while the
                        # runner's commits explain the changes, the tickets and Docs are refetched now and then.
                        runner_masked_at = time.time()
                        await publish(INVALIDATE, topics=["tickets", "docs"])
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
