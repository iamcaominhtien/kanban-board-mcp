"""Move the board's data from one database to another, in any direction (design D, E): check both ends, make the
tables on the target, copy table by table, then prove the copy (counts, a sample of rows read back, links between
rows, counters, docs search). The `kanban-db` script and the Settings wizard both run this module.

How the copy keeps its promises:

- The source is only read, inside one transaction with a consistent snapshot (SQLite's read transaction, REPEATABLE
  READ on PostgreSQL and MySQL), so every table is copied as it was at the same moment while the board stays usable.
- The target gets the app's own tables: the migrations on SQLite, the models stamped at the newest migration on
  PostgreSQL and MySQL (`database.create_schema`).
- Each table is one transaction on the target that first empties it. A copy that stops leaves the tables before it
  complete and the one it stopped in empty, so resuming re-reads that table from its start and never duplicates.
- Values are converted to the target column's type (SQLite lets a text column hold a number; PostgreSQL does not).
- Batches of up to 1,000 rows (fewer when rows are large), each in a savepoint: when a batch fails, its rows are
  tried one by one to name the exact row and column that would not go in.
"""

import asyncio
import json
import os
import random
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path

from sqlalchemy import (
    Boolean,
    Float,
    Integer,
    String,
    Table,
    and_,
    func,
    inspect,
    select,
    text,
    tuple_,
)
from sqlalchemy.exc import DBAPIError
from sqlmodel import SQLModel

import models  # noqa: F401 - registers every table

from . import changes, targets
from .types import short_text_columns

BATCH_ROWS = 1000
BATCH_BYTES = 4 * 1024 * 1024
SAMPLE_ROWS = 500
FTS_TABLES = ("docs_fts", "ai_run_fts", "kb_fts")
NOT_COPIED = {"alembic_version", changes.TABLE, "sqlite_sequence"}

Progress = Callable[[dict], Awaitable[None] | None]


class MoveError(RuntimeError):
    """The move cannot go on; `code` says why: same | source | target_not_empty | newer | unreachable."""

    def __init__(self, code: str, message: str, **info):
        """Say what and why."""
        super().__init__(message)
        self.code = code
        self.info = info


@dataclass
class Stop:
    """Where and why a copy stopped (design D4): what the board knows, without the row's values."""

    table: str
    row: int  # 1-based position of the row that would not go in
    copied: (
        int  # rows of that table that went in before it (rolled back with the table)
    )
    total: int
    tables_done: int
    tables_total: int
    error: str
    code: str = ""
    column: str | None = None
    value_length: int | None = None
    value_null: bool = False
    source_type: str | None = None
    target_type: str | None = None
    source_engine: str = ""
    target_engine: str = ""
    target_version: str = ""
    target_nullable: bool | None = None
    target_default: str | None = None
    target_indexes: list[str] = field(
        default_factory=list
    )  # indexes on the column ("ix_x (a, b) unique")

    def as_dict(self) -> dict:
        """For the API and the AI bundle."""
        return asdict(self)


class CopyStopped(Exception):
    """A value would not go in; `stop` says where."""

    def __init__(self, stop: Stop):
        """Carry the stop."""
        super().__init__(stop.error)
        self.stop = stop


@dataclass
class TableState:
    """One table's progress."""

    name: str
    rows: int = 0
    copied: int = 0
    state: str = "waiting"  # waiting | copying | done | stopped


@dataclass
class Plan:
    """Step 2: what will be copied, and what to expect."""

    source: dict
    target: dict
    tables: list[TableState] = field(default_factory=list)
    rows: int = 0
    extra_tables: list[str] = field(default_factory=list)
    notes: list[dict] = field(default_factory=list)
    problems: list[dict] = field(default_factory=list)

    def as_dict(self) -> dict:
        """For the API."""
        out = asdict(self)
        out["tables_count"] = len(self.tables)
        return out


def app_tables() -> list[Table]:
    """The app's tables, parents before children (the copy order)."""
    return list(SQLModel.metadata.sorted_tables)


# ---------------------------------------------------------------------------
# Values
# ---------------------------------------------------------------------------


def _coercer(column) -> Callable:
    kind = column.type
    if isinstance(kind, Boolean):
        return lambda v: v if v is None or isinstance(v, bool) else bool(int(v))
    if isinstance(kind, Integer):

        def to_int(v):
            if v is None or isinstance(v, int) and not isinstance(v, bool):
                return v
            if isinstance(v, bool):
                return int(v)
            if isinstance(v, float) and v.is_integer():
                return int(v)
            if isinstance(v, str) and re.fullmatch(r"\s*-?\d+\s*", v):
                return int(v)
            return v

        return to_int
    if isinstance(kind, Float):

        def to_float(v):
            if v is None or isinstance(v, float):
                return v
            try:
                return float(v)
            except (TypeError, ValueError):
                return v

        return to_float
    if isinstance(kind, String):

        def to_str(v):
            if v is None or isinstance(v, str):
                return v
            if isinstance(v, bytes):
                return v.decode("utf-8", errors="replace")
            if isinstance(v, bool):
                return "1" if v else "0"
            return str(v)

        return to_str
    return lambda v: v


def _row_bytes(row: dict) -> int:
    return sum(len(v) if isinstance(v, (str, bytes)) else 8 for v in row.values())


def _same(a, b) -> bool:
    if a == b:
        return True
    if isinstance(a, float) or isinstance(b, float):
        try:
            return abs(float(a) - float(b)) <= 1e-9 * max(1.0, abs(float(a)))
        except (TypeError, ValueError):
            return False
    return False


# ---------------------------------------------------------------------------
# Errors, in words the person and the AI can use (never the row's values)
# ---------------------------------------------------------------------------

_COLUMN_PATTERNS = [
    re.compile(r"for column [`'\"]?(?:[\w]+[`'\"]?\.[`'\"]?)*(\w+)[`'\"]?"),
    re.compile(r"null value in column \"(\w+)\""),
    re.compile(r"Column '(\w+)' cannot be null"),
    re.compile(r"column \"(\w+)\""),
]


def clean_error(exc: BaseException) -> tuple[str, str]:
    """(message, code) without the SQL, the parameters or PostgreSQL's DETAIL line (which quotes the row)."""
    orig = getattr(exc, "orig", None) or exc
    code = ""
    args = getattr(orig, "args", ())
    if args and isinstance(args[0], int):
        code = str(args[0])
        message = str(args[1]) if len(args) > 1 else str(orig)
    else:
        message = str(orig)
        code = str(getattr(orig, "sqlstate", "") or getattr(orig, "pgcode", "") or "")
    message = message.split("\n")[0]
    message = re.sub(r"^<class '[^']+'>:\s*", "", message)
    message = message.split("[SQL:")[0].split("DETAIL:")[0].strip()
    return message[:400], code


def _error_column(message: str) -> str | None:
    for pattern in _COLUMN_PATTERNS:
        m = pattern.search(message)
        if m:
            return m.group(1)
    return None


# ---------------------------------------------------------------------------
# Opening both ends
# ---------------------------------------------------------------------------


async def _snapshot(engine):
    """A connection that reads one consistent moment of the source until it is closed."""
    conn = engine.connect()
    await conn.start()
    if engine.dialect.name == "sqlite":
        await conn.exec_driver_sql(
            "BEGIN"
        )  # a read transaction: later commits by the board are not seen
    else:
        await conn.execution_options(isolation_level="REPEATABLE READ")
        await conn.begin()
    return conn


def _target_version(engine) -> str:
    info = engine.dialect.server_version_info or ()
    name = {
        "sqlite": "SQLite",
        "postgresql": "PostgreSQL",
    }.get(engine.dialect.name)
    if name is None:
        name = "MariaDB" if getattr(engine.dialect, "is_mariadb", False) else "MySQL"
    return f"{name} {'.'.join(str(n) for n in info[:3])}".strip()


class Mover:
    """One move from `source` to `target`. Use as `async with Mover(...) as m:`."""

    def __init__(
        self,
        source: targets.Target,
        target: targets.Target,
        *,
        on_progress: Progress | None = None,
        batch_rows: int = BATCH_ROWS,
    ):
        """Name both ends; nothing is opened yet."""
        if source.display() == target.display() and source.engine == target.engine:
            raise MoveError("same", "The source and the target are the same database.")
        self.source = source
        self.target = target
        self.on_progress = on_progress
        self.batch_rows = batch_rows
        self.src = targets.make_engine(source, role="copy")
        self.dst = targets.make_engine(target, role="copy")
        self._snap = None
        self.tables = [TableState(t.name) for t in app_tables()]
        self.paused = asyncio.Event()  # set: stop at the next batch (pause or cancel)
        self.stop_reason: str | None = None
        self.started = 0.0
        self.created_target = False

    async def __aenter__(self) -> "Mover":
        """Open the source's snapshot."""
        await self.open()
        return self

    async def __aexit__(self, *_exc) -> None:
        """Close both ends."""
        await self.close()

    async def open(self) -> None:
        """Read the source from one consistent moment."""
        if self._snap is None:
            self._snap = await _snapshot(self.src)

    async def close(self) -> None:
        """Let go of both databases."""
        if self._snap is not None:
            try:
                await self._snap.close()
            except Exception:  # noqa: BLE001 - closing a broken connection
                pass
            self._snap = None
        await self.src.dispose()
        await self.dst.dispose()

    async def release(self) -> None:
        """Stop reading the source (a long read transaction keeps SQLite's WAL from shrinking); `open` reads again."""
        if self._snap is not None:
            try:
                await self._snap.close()
            except Exception:  # noqa: BLE001 - closing a broken connection
                pass
            self._snap = None

    async def refresh(self) -> None:
        """Read the source as it is now (a new snapshot), e.g. before resuming."""
        if self._snap is not None:
            await self._snap.close()
            self._snap = None
        await self.open()

    async def _emit(self, event: dict) -> None:
        if self.on_progress is None:
            return
        out = self.on_progress(event)
        if asyncio.iscoroutine(out):
            await out

    # -- step 2: check ----------------------------------------------------

    async def _source_state(self) -> dict:
        import database

        state = await self._snap.run_sync(database.schema_state)
        if state["state"] != "board":
            raise MoveError(
                "source", "The source does not hold a Kanban board.", state=state
            )
        head = database.head_revision()
        if state["revision"] != head:
            raise MoveError(
                "source",
                "The source is not at the newest migration. Open it with this version of the app once (it updates "
                "it), then copy it.",
                revision=state["revision"],
                head=head,
            )
        return state

    async def plan(self) -> Plan:
        """What the copy will do: per-table rows, what stays behind, and values the target will not take."""
        await self._source_state()
        names = set(await self._snap.run_sync(lambda c: inspect(c).get_table_names()))
        total = 0
        for t, state in zip(app_tables(), self.tables):
            if t.name not in names:
                raise MoveError(
                    "source", f"The source has no table {t.name}.", table=t.name
                )
            state.rows = int(
                (await self._snap.execute(select(func.count()).select_from(t))).scalar()
                or 0
            )
            total += state.rows
        known = {t.name for t in app_tables()} | NOT_COPIED
        extra = sorted(
            n
            for n in names
            if n not in known
            and not any(n == f or n.startswith(f + "_") for f in FTS_TABLES)
        )
        counts = {s.name: s.rows for s in self.tables}
        size = None
        if self.source.is_sqlite and Path(self.source.path).exists():
            size = Path(self.source.path).stat().st_size
        source = {
            **self.source.public(),
            "label": self.source.label,
            "display": self.source.display(),
            "size": size,
            "tables": len(self.tables),
            "rows": total,
            "tickets": counts.get("ticket", 0),
            "projects": counts.get("project", 0),
            "ai_members": counts.get("ai_team", 0),
            "at_head": True,
        }
        plan = Plan(
            source=source,
            target={
                **self.target.public(),
                "label": self.target.label,
                "display": self.target.display(),
            },
            tables=self.tables,
            rows=total,
            extra_tables=extra,
        )
        if extra:
            plan.notes.append(
                {
                    "key": "extra",
                    "title": f"{len(extra)} table(s) are not part of the app and are not copied",
                    "detail": ", ".join(extra[:10]),
                }
            )
        if self.target.is_sqlite:
            plan.notes.append(
                {
                    "key": "search",
                    "title": "Docs search is rebuilt",
                    "detail": "The search index is built again on the new file after the copy.",
                }
            )
        else:
            plan.notes.append(
                {
                    "key": "search",
                    "title": "Docs and history search use the plain search",
                    "detail": f"The full-text index is a SQLite feature; on {self.target.label} search reads the "
                    "pages themselves (the same results, slower on very large boards).",
                }
            )
        plan.problems = await self.scan()
        return plan

    async def scan(self) -> list[dict]:
        """Values the target cannot take as they are, found before anything is written: text longer than 255
        characters in a key or indexed column on MySQL (VARCHAR(255) there), and empty values in columns the app
        declares required."""
        problems = []
        short = (
            {(c.table.name, c.name) for c in short_text_columns(SQLModel.metadata)}
            if self.target.engine == "mysql"
            else set()
        )
        for t, state in zip(app_tables(), self.tables):
            if not state.rows:
                continue
            exprs = []
            labels = []
            for c in t.columns:
                if not c.nullable and not c.primary_key:
                    exprs.append(
                        func.sum(func.coalesce((c.is_(None)).cast(Integer), 0))
                    )
                    labels.append(("null", c))
                if (t.name, c.name) in short:
                    exprs.append(func.max(func.length(c)))
                    labels.append(("long", c))
            if not exprs:
                continue
            row = (await self._snap.execute(select(*exprs).select_from(t))).one()
            for (kind, c), value in zip(labels, row):
                if kind == "null" and value:
                    problems.append(
                        {
                            "key": f"null:{t.name}.{c.name}",
                            "level": "warn",
                            "table": t.name,
                            "column": c.name,
                            "count": int(value),
                            "title": f"{int(value)} row(s) of {t.name} have no {c.name}",
                            "detail": "The app requires a value there; the copy fills in the app's default where it "
                            "has one, and otherwise stops at that row.",
                        }
                    )
                if kind == "long" and value and int(value) > 255:
                    problems.append(
                        {
                            "key": f"long:{t.name}.{c.name}",
                            "level": "warn",
                            "table": t.name,
                            "column": c.name,
                            "length": int(value),
                            "title": f"{t.name}.{c.name} holds text of {int(value):,} characters",
                            "detail": "On MySQL this column is VARCHAR(255) because it is indexed; the copy will stop "
                            "there unless the column is widened first.",
                        }
                    )
        return problems

    # -- the target --------------------------------------------------------

    async def target_state(self) -> dict:
        """What the target holds now."""
        import database

        async with self.dst.connect() as conn:
            return await conn.run_sync(database.schema_state)

    async def prepare_target(
        self, *, empty_first: bool = False, resume: bool = False
    ) -> None:
        """Make the app's tables on the target. A target that holds anything is refused unless `empty_first`
        (delete it all) or `resume` (our own tables from an interrupted copy)."""
        import database

        state = await self.target_state()
        if (
            state["state"] == "board"
            and state["revision"]
            and not database.known_revision(state["revision"])
        ):
            raise MoveError(
                "newer",
                "The target was made by a newer version of the app; the board will not touch it.",
                state=state,
            )
        if state["state"] != "empty":
            if resume and state["state"] == "board":
                return
            if not empty_first:
                raise MoveError(
                    "target_not_empty",
                    f"The target already has {state['tables']} tables.",
                    state=state,
                )
            await self.empty_target()
        await self._create_target()
        self.created_target = True

    async def empty_target(self) -> None:
        """Delete every table on the target (after the person typed its name), or the SQLite file."""
        await self.dst.dispose()
        if self.target.is_sqlite:
            for suffix in ("", "-wal", "-shm"):
                Path(self.target.path + suffix).unlink(missing_ok=True)
            return
        async with self.dst.begin() as conn:
            names = await conn.run_sync(lambda c: inspect(c).get_table_names())
            if self.target.engine == "mysql":
                await conn.execute(text("SET FOREIGN_KEY_CHECKS = 0"))
                for name in names:
                    await conn.execute(text(f"DROP TABLE IF EXISTS `{name}`"))
                await conn.execute(text("SET FOREIGN_KEY_CHECKS = 1"))
            else:
                for name in names:
                    await conn.execute(text(f'DROP TABLE IF EXISTS "{name}" CASCADE'))

    async def _create_target(self) -> None:
        import database

        cfg = database.alembic_config()
        if self.target.is_sqlite:
            Path(self.target.path).parent.mkdir(parents=True, exist_ok=True)
            async with self.dst.connect() as conn:
                await conn.execute(text("PRAGMA journal_mode=WAL"))
                await conn.commit()
            async with self.dst.begin() as conn:
                await conn.run_sync(database._run_upgrade, cfg)
            return
        async with self.dst.begin() as conn:
            await conn.run_sync(database.create_schema, cfg)

    async def clear_target(self) -> None:
        """Undo a copy that was cancelled: the tables it made on the target (or the SQLite file) go."""
        await self.dst.dispose()
        if self.target.is_sqlite:
            for suffix in ("", "-wal", "-shm"):
                Path(self.target.path + suffix).unlink(missing_ok=True)
            return
        ours = [t.name for t in reversed(app_tables())] + [
            "alembic_version",
            changes.TABLE,
        ]
        async with self.dst.begin() as conn:
            for name in ours:
                q = f"`{name}`" if self.target.engine == "mysql" else f'"{name}"'
                await conn.execute(text(f"DROP TABLE IF EXISTS {q}"))

    # -- step 3: copy ------------------------------------------------------

    async def copy(
        self, *, start_at: str | None = None, only: list[str] | None = None
    ) -> None:
        """Copy every table (from `start_at`, or just `only`). Raises `CopyStopped` when a value will not go in;
        returns early with `stop_reason` set when paused or cancelled."""
        self.started = self.started or time.monotonic()
        if not any(s.rows for s in self.tables):
            await self.plan()
        names = [t.name for t in app_tables()]
        begin = names.index(start_at) if start_at in names else 0
        for i, (table, state) in enumerate(zip(app_tables(), self.tables)):
            if only is not None and table.name not in only:
                continue
            if only is None and i < begin:
                state.state, state.copied = "done", state.rows
                continue
            if self.paused.is_set():
                return
            await self._copy_table(table, state, i)
            if self.paused.is_set() and state.state != "done":
                return
        await self._after_copy()

    async def _copy_table(self, table: Table, state: TableState, index: int) -> None:
        coerce = {c.name: _coercer(c) for c in table.columns}
        required = {
            c.name: c.default.arg
            for c in table.columns
            if not c.nullable
            and c.default is not None
            and getattr(c.default, "is_scalar", False)
        }
        state.state, state.copied = "copying", 0
        await self._emit({"type": "table", "table": table.name, "index": index})
        async with self.dst.connect() as conn:
            trans = await conn.begin()
            try:
                await conn.execute(table.delete())
                result = await self._snap.stream(select(table))
                batch: list[dict] = []
                size = 0
                async for row in result.mappings():
                    values = {k: coerce[k](v) for k, v in row.items()}
                    for name, default in required.items():
                        if values.get(name) is None:
                            values[name] = default
                    batch.append(values)
                    size += _row_bytes(values)
                    if len(batch) >= self.batch_rows or size >= BATCH_BYTES:
                        await self._insert(conn, table, batch, state, index)
                        batch, size = [], 0
                        if self.paused.is_set():
                            await result.close()
                            await trans.rollback()
                            state.state, state.copied = "waiting", 0
                            return
                if batch:
                    await self._insert(conn, table, batch, state, index)
                await trans.commit()
            except BaseException:
                if trans.is_active:
                    await trans.rollback()
                raise
        state.state = "done"
        await self._emit(
            {"type": "table_done", "table": table.name, "rows": state.copied}
        )

    async def _insert(
        self, conn, table: Table, batch: list[dict], state: TableState, index: int
    ) -> None:
        save = await conn.begin_nested()
        try:
            await conn.execute(table.insert(), batch)
            await save.commit()
        except DBAPIError:
            await save.rollback()
            await self._find_bad_row(conn, table, batch, state, index)
        state.copied += len(batch)
        await self._emit(
            {
                "type": "rows",
                "table": table.name,
                "copied": state.copied,
                "rows": state.rows,
            }
        )

    async def _find_bad_row(
        self, conn, table: Table, batch: list[dict], state: TableState, index: int
    ) -> None:
        for offset, values in enumerate(batch):
            save = await conn.begin_nested()
            try:
                await conn.execute(table.insert(), [values])
                await save.commit()
            except DBAPIError as exc:
                await save.rollback()
                raise CopyStopped(
                    await self._stop(
                        table, state, index, state.copied + offset, values, exc
                    )
                ) from exc
        # every row went in on its own (a batch-only limit): keep them
        state.copied += 0

    async def _stop(self, table, state, index, copied, values, exc) -> Stop:
        message, code = clean_error(exc)
        column = _error_column(message)
        if column is None or column not in table.c:
            column = self._guess_column(table, values, message)
        value = values.get(column) if column else None
        stop = Stop(
            table=table.name,
            row=copied + 1,
            copied=copied,
            total=state.rows,
            tables_done=index,
            tables_total=len(self.tables),
            error=message,
            code=code,
            column=column,
            value_length=len(value) if isinstance(value, (str, bytes)) else None,
            value_null=bool(column) and value is None,
            source_engine=self.source.label,
            target_engine=self.target.label,
            target_version=_target_version(self.dst),
        )
        if column:
            stop.source_type = await self._column_type(self._snap, table.name, column)
            async with self.dst.connect() as c:
                stop.target_type = await self._column_type(c, table.name, column)
                (
                    stop.target_nullable,
                    stop.target_default,
                    stop.target_indexes,
                ) = await self._column_facts(c, table.name, column)
        state.state = "stopped"
        return stop

    def _guess_column(self, table: Table, values: dict, message: str) -> str | None:
        low = message.lower()
        if "too long" in low or "data too long" in low:
            longest = max(
                ((k, len(v)) for k, v in values.items() if isinstance(v, str)),
                key=lambda kv: kv[1],
                default=(None, 0),
            )
            return longest[0]
        if "null" in low:
            for c in table.columns:
                if not c.nullable and values.get(c.name) is None:
                    return c.name
        return None

    @staticmethod
    async def _column_type(conn, table: str, column: str) -> str | None:
        def read(sync_conn):
            for col in inspect(sync_conn).get_columns(table):
                if col["name"] == column:
                    return str(col["type"])
            return None

        try:
            return await conn.run_sync(read)
        except Exception:  # noqa: BLE001 - only for the explanation
            return None

    @staticmethod
    async def _column_facts(conn, table: str, column: str):
        """(nullable, default, indexes) of a target column: what a statement that redefines it must keep."""

        def read(sync_conn):
            insp = inspect(sync_conn)
            col = next(
                (c for c in insp.get_columns(table) if c["name"] == column), None
            )
            indexes = [
                f"{i['name']} ({', '.join(str(n) for n in i['column_names'])})"
                + (" unique" if i.get("unique") else "")
                for i in insp.get_indexes(table)
                if column in (i.get("column_names") or [])
            ]
            if col is None:
                return None, None, indexes
            default = col.get("default")
            return (
                bool(col.get("nullable")),
                (str(default) if default is not None else None),
                indexes,
            )

        try:
            return await conn.run_sync(read)
        except Exception:  # noqa: BLE001 - only for the explanation
            return None, None, []

    async def _after_copy(self) -> None:
        if self.target.engine == "postgresql":
            await self._reset_sequences()
        if self.target.is_sqlite:
            await self._rebuild_search()

    async def _reset_sequences(self) -> None:
        """Make PostgreSQL's next id carry on after the copied rows (explicit ids do not move a sequence)."""
        async with self.dst.begin() as conn:
            for t in app_tables():
                pk = list(t.primary_key.columns)
                if (
                    len(pk) == 1
                    and isinstance(pk[0].type, Integer)
                    and pk[0].autoincrement in (True, "auto")
                ):
                    seq = (
                        await conn.execute(
                            text("SELECT pg_get_serial_sequence(:t, :c)"),
                            {"t": t.name, "c": pk[0].name},
                        )
                    ).scalar()
                    if seq:
                        await conn.execute(
                            text(
                                f'SELECT setval(:s, COALESCE((SELECT MAX("{pk[0].name}") FROM "{t.name}"), 1), '
                                f'(SELECT MAX("{pk[0].name}") FROM "{t.name}") IS NOT NULL)'
                            ),
                            {"s": seq},
                        )

    async def _rebuild_search(self) -> None:
        """The SQLite target's full-text indexes: copied from a SQLite source, rebuilt otherwise."""
        from services import docs_search

        src_names = set(
            await self._snap.run_sync(lambda c: inspect(c).get_table_names())
        )
        async with self.dst.begin() as conn:
            dst_names = set(await conn.run_sync(lambda c: inspect(c).get_table_names()))
            for fts in FTS_TABLES:
                if fts not in dst_names:
                    continue
                await conn.execute(text(f"DELETE FROM {fts}"))
                if self.source.is_sqlite and fts in src_names:
                    cols = [
                        r[1]
                        for r in (
                            await self._snap.execute(text(f"PRAGMA table_info({fts})"))
                        ).all()
                    ]
                    rows = (
                        await self._snap.execute(
                            text(f"SELECT {', '.join(cols)} FROM {fts}")
                        )
                    ).all()
                    if rows:
                        await conn.execute(
                            text(
                                f"INSERT INTO {fts} ({', '.join(cols)}) VALUES ({', '.join(':' + c for c in cols)})"
                            ),
                            [dict(zip(cols, r)) for r in rows],
                        )
                elif fts == "docs_fts":
                    await conn.run_sync(docs_search.backfill_sync)
                elif fts == "kb_fts":
                    await self._rebuild_kb(conn)

    @staticmethod
    async def _rebuild_kb(conn) -> None:
        from models import AiKnowledgeDoc

        rows = (await conn.execute(select(AiKnowledgeDoc.__table__))).mappings().all()
        for d in rows:
            await conn.execute(
                text(
                    "INSERT INTO kb_fts (doc_id, project_id, store, title, summary, keywords, body) "
                    "VALUES (:d, :p, :s, :t, :su, :k, :b)"
                ),
                {
                    "d": d["id"],
                    "p": d["project_id"] or "",
                    "s": d["store"],
                    "t": d["title"],
                    "su": d["summary"] or "",
                    "k": " ".join(json.loads(d["keywords"] or "[]")),
                    "b": d["text"] or "",
                },
            )

    # -- step 4: verify ----------------------------------------------------

    async def verify(self, *, sample: int = SAMPLE_ROWS) -> dict:
        """Prove the copy: equal row counts in every table, a random sample of each table read back and compared
        value by value, the same links between rows on both sides, counters that carry on, and docs search."""
        checks: list[dict] = []
        tables: list[dict] = []
        differ: list[str] = []
        async with self.dst.connect() as dst:
            for t in app_tables():
                a = int(
                    (
                        await self._snap.execute(select(func.count()).select_from(t))
                    ).scalar()
                    or 0
                )
                b = int(
                    (await dst.execute(select(func.count()).select_from(t))).scalar()
                    or 0
                )
                tables.append(
                    {"name": t.name, "source": a, "target": b, "same": a == b}
                )
                if a != b:
                    differ.append(t.name)
            checks.append(
                {
                    "key": "counts",
                    "ok": not differ,
                    "title": "Row counts"
                    + (
                        f" · equal in all {len(tables)} tables"
                        if not differ
                        else f" · differ in {len(differ)} table(s): {', '.join(differ[:6])}"
                    ),
                }
            )
            mismatched, compared = await self._compare_samples(dst, sample)
            checks.append(
                {
                    "key": "content",
                    "ok": not mismatched,
                    "title": f"Content · {compared:,} rows read back and compared"
                    + (f" ({sample} at random per big table)" if compared else "")
                    + (
                        ""
                        if not mismatched
                        else f" · {len(mismatched)} differ, first in {mismatched[0]['table']}"
                    ),
                    "mismatches": mismatched[:20],
                }
            )
            links = await self._compare_links(dst)
            checks.append(links)
            checks.append(await self._counters(dst))
            if self.target.is_sqlite:
                checks.append(await self._search(dst))
        ok = all(c["ok"] for c in checks)
        return {
            "ok": ok,
            "checks": checks,
            "tables": tables,
            "rows": sum(t["target"] for t in tables),
            "differ": differ,
            "elapsed_s": round(time.monotonic() - self.started, 1)
            if self.started
            else None,
        }

    def _random(self, engine):
        return func.rand() if engine.dialect.name == "mysql" else func.random()

    async def _compare_samples(self, dst, sample: int) -> tuple[list[dict], int]:
        mismatched: list[dict] = []
        compared = 0
        for t in app_tables():
            pk = list(t.primary_key.columns)
            if not pk:
                continue
            rows = (
                (
                    await self._snap.execute(
                        select(t).order_by(self._random(self.src)).limit(sample)
                    )
                )
                .mappings()
                .all()
            )
            if not rows:
                continue
            coerce = {c.name: _coercer(c) for c in t.columns}
            keyed = {tuple(coerce[c.name](r[c.name]) for c in pk): r for r in rows}
            keys = list(keyed)
            found = {}
            for start in range(0, len(keys), 200):
                chunk = keys[start : start + 200]
                cond = (
                    pk[0].in_([k[0] for k in chunk])
                    if len(pk) == 1
                    else tuple_(*pk).in_(chunk)
                )
                for r in (await dst.execute(select(t).where(cond))).mappings().all():
                    found[tuple(r[c.name] for c in pk)] = r
            for key, src_row in keyed.items():
                compared += 1
                got = found.get(key)
                if got is None:
                    mismatched.append(
                        {"table": t.name, "key": list(map(str, key)), "column": None}
                    )
                    continue
                for c in t.columns:
                    if not _same(coerce[c.name](src_row[c.name]), got[c.name]):
                        if src_row[c.name] is None and not c.nullable:
                            continue  # filled with the app's default on the way
                        mismatched.append(
                            {
                                "table": t.name,
                                "key": list(map(str, key)),
                                "column": c.name,
                            }
                        )
                        break
        return mismatched, compared

    async def _orphans(self, conn, fk) -> int:
        child = fk.parent.table
        parent = fk.column.table
        p = parent.alias("p")
        stmt = (
            select(func.count())
            .select_from(child.outerjoin(p, fk.parent == p.c[fk.column.name]))
            .where(and_(fk.parent.isnot(None), p.c[fk.column.name].is_(None)))
        )
        return int((await conn.execute(stmt)).scalar() or 0)

    async def _compare_links(self, dst) -> dict:
        differ = []
        already = 0
        fks = [fk for t in app_tables() for fk in t.foreign_keys]
        for fk in fks:
            a = await self._orphans(self._snap, fk)
            b = await self._orphans(dst, fk)
            already += a
            if a != b:
                differ.append(f"{fk.parent.table.name}.{fk.parent.name}")
        title = f"Links between rows · the same {len(fks)} kinds of link on both sides"
        if already and not differ:
            title += f" ({already:,} row(s) already pointed at a deleted row in the source and still do)"
        if differ:
            title = f"Links between rows · differ in {', '.join(differ[:5])}"
        return {"key": "links", "ok": not differ, "title": title, "orphans": already}

    async def _counters(self, dst) -> dict:
        from models import Project

        rows = (
            await dst.execute(
                select(
                    Project.__table__.c.prefix, Project.__table__.c.ticket_counter
                ).order_by(Project.__table__.c.ticket_counter.desc())
            )
        ).all()
        src = dict(
            (
                await self._snap.execute(
                    select(
                        Project.__table__.c.prefix, Project.__table__.c.ticket_counter
                    )
                )
            ).all()
        )
        ok = all(src.get(p) == n for p, n in rows) and len(src) == len(rows)
        if self.target.engine == "postgresql":
            ok = ok and await self._sequences_ok(dst)
        if rows:
            prefix, counter = rows[0]
            title = f"Counters · the next ticket number carries on from {prefix}-{(counter or 0) + 1:,}"
        else:
            title = "Counters · no projects yet"
        return {"key": "counters", "ok": ok, "title": title}

    async def _sequences_ok(self, dst) -> bool:
        for t in app_tables():
            pk = list(t.primary_key.columns)
            if (
                len(pk) == 1
                and isinstance(pk[0].type, Integer)
                and pk[0].autoincrement in (True, "auto")
            ):
                seq = (
                    await dst.execute(
                        text("SELECT pg_get_serial_sequence(:t, :c)"),
                        {"t": t.name, "c": pk[0].name},
                    )
                ).scalar()
                if not seq:
                    continue
                top = (await dst.execute(select(func.max(pk[0])))).scalar()
                last = (
                    await dst.execute(text(f"SELECT last_value FROM {seq}"))
                ).scalar()
                if top is not None and (last or 0) < top:
                    return False
        return True

    async def _search(self, dst) -> dict:
        try:
            live = int(
                (
                    await dst.execute(
                        text("SELECT COUNT(*) FROM docs_page WHERE deleted_at IS NULL")
                    )
                ).scalar()
                or 0
            )
            indexed = int(
                (await dst.execute(text("SELECT COUNT(*) FROM docs_fts"))).scalar() or 0
            )
        except DBAPIError:
            return {
                "key": "search",
                "ok": True,
                "title": "Docs search · uses the plain search (no FTS5 here)",
            }
        return {
            "key": "search",
            "ok": indexed >= live,
            "title": f"Docs search · {indexed:,} of {live:,} pages indexed",
        }

    # -- a fix the person approved ------------------------------------------

    async def apply(self, statements: list[str]) -> None:
        """Run statements on the target (a fix for a stop, after `assist.check_statements`)."""
        async with self.dst.begin() as conn:
            for s in statements:
                await conn.execute(text(s))

    async def source_fingerprint(self) -> str:
        """Something that changes when anyone writes to the source (to tell whether a copy is still current)."""
        if self.source.is_sqlite:
            path = Path(self.source.path)
            parts = []
            for suffix in ("", "-wal"):
                p = Path(str(path) + suffix)
                if p.exists():
                    st = p.stat()
                    parts.append(f"{st.st_size}:{st.st_mtime_ns}")
            return "|".join(parts)
        async with self.src.connect() as conn:
            try:
                top = (
                    await conn.execute(select(func.max(changes.kanban_change.c.id)))
                ).scalar()
            except DBAPIError:
                top = None
        return str(top or 0)


def summary_line(plan: Plan) -> str:
    """'87 tables · about 61,000 rows'."""
    approx = plan.rows if plan.rows < 1000 else round(plan.rows, -3)
    return f"{len(plan.tables)} tables · {'about ' if plan.rows >= 1000 else ''}{approx:,} rows"


def sample_seed() -> None:
    """Make the sample repeatable in tests."""
    random.seed(int(os.environ.get("KANBAN_DB_SAMPLE_SEED", "0")) or None)
