"""How the board's own connections share a SQLite file inside one process: one SQLite call at a time, and writers in
line.

aiosqlite gives every connection a thread of its own, and Python's ``sqlite3`` lets go of the GIL and takes it back
on every row it steps through. With ten requests at once, ten threads fight for the GIL and every call gets slower
than all of them run one after the other (a 6 ms read took 120-330 ms). So:

- **One call at a time.** Every call of a connection (a statement, a fetch, a commit) waits for the call lock, an
  asyncio lock of the event loop: calls are queued in order instead of fighting in threads. A call that can wait for
  another *process* (the first write of a transaction, which waits for SQLite's write lock: the AI runner or an
  editor's MCP server) runs outside it, so that wait never stops the other requests.
- **Writers in line.** SQLite lets one writer in at a time, and the others poll for the lock (sleep, try again), which
  is not first come, first served: under load a writer could miss its turn for the whole busy timeout and fail with
  "database is locked". Before its first write, a transaction takes the write gate, a lock of the process that gives
  the turns in order; it lets go when the transaction ends (commit, rollback, close). Other processes still meet at
  SQLite's own lock, as before.

PostgreSQL and MySQL are not concerned. This relies on ``aiosqlite.Connection._execute``, through which every call of
a connection goes (aiosqlite 0.22: tests/test_sqlite_gate.py checks it).
"""

from __future__ import annotations

import asyncio
import os
import re
import sqlite3
import weakref
from typing import Any

import aiosqlite

# How long a writer waits for its turn, as SQLite's busy timeout does for the lock itself.
WRITE_WAIT_S = 30

# Statements that never wait for a lock (WAL: readers do not wait for writers).
_READ = re.compile(r"\s*(SELECT|EXPLAIN|VALUES)\b", re.I)
_WITH = re.compile(r"\s*WITH\b", re.I)
_DML = re.compile(r"\b(INSERT|UPDATE|DELETE|REPLACE)\b", re.I)
_PRAGMA = re.compile(r"\s*PRAGMA\s+(?:\w+\.)?(\w+)", re.I)
# The pragmas that take a lock of the file; the others are settings of the connection, or reads.
_LOCKING_PRAGMAS = {
    "journal_mode",
    "user_version",
    "application_id",
    "schema_version",
    "wal_checkpoint",
    "incremental_vacuum",
    "optimize",
    "auto_vacuum",
    "page_size",
    "locking_mode",
}
_CALLS = {"execute", "executemany", "executescript"}

# Per event loop (tests run several): the call lock, and the write gate of each file (copying a board to another
# file writes one while it reads the other).
_locks: weakref.WeakKeyDictionary[
    asyncio.AbstractEventLoop, tuple[asyncio.Lock, dict[str, asyncio.Lock]]
] = weakref.WeakKeyDictionary()


def _loop_locks(path: str) -> tuple[asyncio.Lock, asyncio.Lock]:
    """The call lock of the running event loop and its write gate for the file at `path`."""
    loop = asyncio.get_running_loop()
    locks = _locks.get(loop)
    if locks is None:
        locks = _locks[loop] = (asyncio.Lock(), {})
    call, gates = locks
    gate = gates.get(path)
    if gate is None:
        gate = gates[path] = asyncio.Lock()
    return call, gate


def may_wait(sql: str) -> bool:
    """Whether a statement can take the write lock (and so wait for another process)."""
    if _READ.match(sql):
        return False
    if _WITH.match(sql):
        return bool(_DML.search(sql))
    pragma = _PRAGMA.match(sql)
    if pragma:
        return pragma.group(1).lower() in _LOCKING_PRAGMAS
    return True


class GatedConnection(aiosqlite.Connection):
    """An aiosqlite connection whose calls take the call lock, and whose writes wait for the write gate."""

    _gate: asyncio.Lock | None = None
    _path = ""

    async def _execute(self, fn, *args: Any, **kwargs: Any):  # noqa: ANN001 - aiosqlite's signature
        call, gate = _loop_locks(self._path)
        first_write = False
        if (
            self._gate is None
            and getattr(fn, "__name__", "") in _CALLS
            and args
            and isinstance(args[0], str)
            and may_wait(args[0])
        ):
            try:
                await asyncio.wait_for(gate.acquire(), WRITE_WAIT_S)
            except TimeoutError:
                raise sqlite3.OperationalError("database is locked") from None
            self._gate = gate
            first_write = True
        try:
            if first_write:
                # It may wait for another process's write lock: not under the call lock.
                return await super()._execute(fn, *args, **kwargs)
            async with call:
                return await super()._execute(fn, *args, **kwargs)
        finally:
            if self._gate is not None:
                conn = self._connection
                if (
                    conn is None or not conn.in_transaction
                ):  # committed, rolled back, closed, or autocommit
                    self._let_go()

    def _let_go(self) -> None:
        gate, self._gate = self._gate, None
        if gate is not None and gate.locked():
            gate.release()

    def stop(self):  # noqa: ANN201 - aiosqlite's signature
        """Closed without a call (SQLAlchemy's terminate): let the next writer in."""
        self._let_go()
        return super().stop()


def connector(path: str, **kwargs: Any):
    """The ``async_creator`` of SQLAlchemy's engine: a gated connection to the file at `path`."""

    async def connect() -> GatedConnection:
        def raw() -> sqlite3.Connection:
            return sqlite3.connect(path, check_same_thread=False, **kwargs)

        conn = GatedConnection(raw, 64)
        conn._path = os.path.realpath(path)
        conn._thread.daemon = (
            True  # SQLAlchemy does this for its own connections, not for a creator's
        )
        return await conn

    return connect
