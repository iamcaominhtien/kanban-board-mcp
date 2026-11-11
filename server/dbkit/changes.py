"""How the board hears about changes another process made, on PostgreSQL and MySQL.

On SQLite the board reads ``PRAGMA data_version`` (``events.watch_database``). A server database has nothing like it,
so every write transaction of every app process adds one row to ``kanban_change`` (in the same transaction, so it is
there exactly when the change is): who wrote. The board polls the newest row written by another process, which is an
index lookup on a table kept to about a thousand rows. Appending, rather than bumping one counter row, means two
writers never wait on each other's lock.

The table is not part of the models: it is not data, it is not copied or exported, and SQLite never has it.
"""

import time

from sqlalchemy import (
    BigInteger,
    Column,
    Float,
    Integer,
    MetaData,
    String,
    Table,
    delete,
    event,
    func,
    insert,
    select,
)
from sqlalchemy.orm import Session

from . import targets

TABLE = "kanban_change"
KEEP_ROWS = 1000

metadata = MetaData()
kanban_change = Table(
    TABLE,
    metadata,
    Column(
        "id",
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    ),
    Column("origin", String(32), nullable=False),
    Column("at", Float, nullable=False),
)

_WROTE = "kanban_wrote"
_COMMITTING = "kanban_committing"
_TABLES = "kanban_tables"
_installed = False
# Called (synchronously, cheaply) after each commit of this process that wrote something (the runner tells the API)
_on_write_commit: list = []
# Origins whose rows are not "another process": the AI runner this API started announces its own changes
_ignored_origins: set[str] = set()


def on_write_commit(callback) -> None:
    """Call `callback(tables)` after every commit of this process that wrote: `tables` names the tables written
    (``"*"`` when a statement's table is not known). It runs inside the commit: keep it cheap."""
    if callback not in _on_write_commit:
        _on_write_commit.append(callback)


def ignore_origin(token: str) -> None:
    """Treat the rows of this process token as this process's own (the AI runner, whose changes come as events)."""
    if token:
        _ignored_origins.add(token[:32])


def create(sync_conn) -> None:
    """Make the table when it is missing (server databases only)."""
    if sync_conn.dialect.name != "sqlite":
        metadata.create_all(sync_conn, checkfirst=True)


def _mark(session: Session, tables: set[str]) -> None:
    session.info[_WROTE] = True
    if _on_write_commit:
        # commit() flushes after before_commit, so what its own flush writes is only known here
        session.info[_COMMITTING] = True
        session.info.setdefault(_TABLES, set()).update(tables)


def _table_of(obj) -> str:  # noqa: ANN001
    table = getattr(obj, "__table__", None)
    return getattr(table, "name", None) or "*"


def _after_flush(session: Session, _ctx) -> None:  # noqa: ANN001
    if session.new or session.dirty or session.deleted:
        _mark(
            session,
            {_table_of(o) for o in (*session.new, *session.dirty, *session.deleted)},
        )


def _orm_execute(state) -> None:  # noqa: ANN001 - ORMExecuteState
    table = getattr(getattr(state.statement, "table", None), "name", None) or "*"
    if state.is_insert or state.is_update or state.is_delete:
        _mark(state.session, {table})
        return
    if not state.is_select:
        head = str(state.statement).lstrip()[:7].upper()
        if head.startswith(("INSERT", "UPDATE", "DELETE", "REPLACE")):
            _mark(state.session, {"*"})


def _before_commit(session: Session) -> None:
    # commit() flushes only after this hook: changes still pending (a plain add() then commit()) are a write too, and
    # their row of the change log must go in the same transaction
    if not session.info.get(_WROTE) and not (
        session.new or session.dirty or session.deleted
    ):
        return
    try:
        bind = session.get_bind()
    except Exception:  # noqa: BLE001 - an unbound session writes nowhere we watch
        session.info.pop(_WROTE, None)
        return
    if bind.dialect.name != "sqlite":
        session.flush()
        session.execute(
            insert(kanban_change).values(
                origin=targets.PROCESS_TOKEN[:32], at=time.time()
            )
        )
    session.info.pop(_WROTE, None)


def _after_commit(session: Session) -> None:
    tables = session.info.pop(_TABLES, None) or {"*"}
    if not session.info.pop(_COMMITTING, False):
        return
    for cb in _on_write_commit:
        try:
            cb(tables)
        except Exception:  # noqa: BLE001 - a listener never fails a commit
            pass


def _forget(session: Session, *_args) -> None:
    session.info.pop(_WROTE, None)
    session.info.pop(_COMMITTING, None)
    session.info.pop(_TABLES, None)


def install() -> None:
    """Listen to every ORM session of this process (once)."""
    global _installed  # noqa: PLW0603
    if _installed:
        return
    event.listen(Session, "after_flush", _after_flush)
    event.listen(Session, "do_orm_execute", _orm_execute)
    event.listen(Session, "before_commit", _before_commit)
    event.listen(Session, "after_commit", _after_commit)
    event.listen(Session, "after_rollback", _forget)
    _installed = True


async def latest_from_others(engine) -> int:
    """The id of the newest change another process wrote (0 when none)."""
    async with engine.connect() as conn:
        value = (
            await conn.execute(
                select(func.max(kanban_change.c.id)).where(
                    kanban_change.c.origin.notin_(
                        [targets.PROCESS_TOKEN[:32], *_ignored_origins]
                    )
                )
            )
        ).scalar()
    return int(value or 0)


async def trim(engine) -> None:
    """Keep only the newest rows; nobody reads further back."""
    async with engine.begin() as conn:
        newest = (await conn.execute(select(func.max(kanban_change.c.id)))).scalar()
        if newest:
            await conn.execute(
                delete(kanban_change).where(
                    kanban_change.c.id < int(newest) - KEEP_ROWS
                )
            )
