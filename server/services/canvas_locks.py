"""Locks on canvas boards: one per board, held only while its content is open for changing.

Moving, resizing, notes, arrows and comments need no lock. A lock ends when its holder saves or cancels, closes the
editor, or has been idle for 10 minutes (the editor warns first). Locks live in memory with a time limit: they are not
versions and a restart simply frees them. An AI member never takes a lock from a person; it proposes instead.
"""

import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

IDLE_SECONDS = 10 * 60
WARN_SECONDS = 9 * 60  # the editor tells the holder from here on


@dataclass
class Lock:
    """Who holds a board and since when."""

    holder: str
    since: float
    last: float
    since_iso: str


_LOCKS: dict[tuple[str, str], Lock] = {}


def _clock() -> float:
    return time.monotonic()


def _iso() -> str:
    return datetime.now(UTC).isoformat()


def _live(key: tuple[str, str]) -> Lock | None:
    lock = _LOCKS.get(key)
    if lock is not None and _clock() - lock.last > IDLE_SECONDS:
        del _LOCKS[key]
        return None
    return lock


def holder_of(canvas_id: str, board_id: str) -> Lock | None:
    """The live lock on a board, if any (an idle one is released first)."""
    return _live((canvas_id, board_id))


def describe(canvas_id: str, board_id: str) -> dict[str, Any] | None:
    """``{holder, since, idle_seconds, expires_in}`` for the API, or None when the board is free."""
    lock = _live((canvas_id, board_id))
    if lock is None:
        return None
    idle = _clock() - lock.last
    return {
        "board_id": board_id,
        "holder": lock.holder,
        "since": lock.since_iso,
        "started_seconds_ago": int(_clock() - lock.since),
        "idle_seconds": int(idle),
        "expires_in": max(0, int(IDLE_SECONDS - idle)),
        "warn": idle >= WARN_SECONDS,
    }


def locks_of(canvas_id: str) -> list[dict[str, Any]]:
    """Every live lock of one canvas."""
    out = []
    for cid, bid in list(_LOCKS):
        if cid == canvas_id:
            d = describe(cid, bid)
            if d:
                out.append(d)
    return out


def acquire(canvas_id: str, board_id: str, holder: str) -> tuple[bool, Lock]:
    """Take the lock if it is free or already yours (refreshing it).

    Returns:
        ``(taken, lock)``; when not taken, ``lock`` is the one somebody else holds.
    """
    key = (canvas_id, board_id)
    lock = _live(key)
    if lock is not None and lock.holder != holder:
        return False, lock
    now = _clock()
    if lock is None:
        lock = Lock(holder, now, now, _iso())
        _LOCKS[key] = lock
    else:
        lock.last = now
    return True, lock


def heartbeat(canvas_id: str, board_id: str, holder: str) -> bool:
    """Show the holder is still there. False if the lock was lost (it ended, or somebody else holds it now)."""
    lock = _live((canvas_id, board_id))
    if lock is None or lock.holder != holder:
        return False
    lock.last = _clock()
    return True


def release(canvas_id: str, board_id: str, holder: str | None = None) -> bool:
    """Let go. With ``holder`` only that person's lock is released. True if a lock was removed."""
    key = (canvas_id, board_id)
    lock = _LOCKS.get(key)
    if lock is None or (holder is not None and lock.holder != holder):
        return False
    del _LOCKS[key]
    return True


def release_all(canvas_id: str, board_ids: list[str] | None = None) -> None:
    """Free every lock of a canvas (or of the given boards): a deleted canvas or board, a restored version."""
    for cid, bid in list(_LOCKS):
        if cid == canvas_id and (board_ids is None or bid in board_ids):
            del _LOCKS[(cid, bid)]


def reset() -> None:
    """Forget every lock (tests)."""
    _LOCKS.clear()
