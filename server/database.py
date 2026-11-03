"""The board's database: which one is in use, its engine and sessions, and bringing its schema up to date.

SQLite in the data folder is the default. PostgreSQL or MySQL/MariaDB is used when ``KANBAN_DATABASE_URL`` says so or
when it was chosen in Settings › Storage & backup (``dbkit.targets``). Every module reaches the database through
``database.engine`` and ``database.async_session``, so ``reinit_db`` re-points the whole app without a restart.
"""

import logging
import os
import re
from collections.abc import AsyncGenerator
from pathlib import Path

from sqlalchemy.ext.asyncio import create_async_engine  # noqa: F401 - tests build engines through it
from sqlalchemy.orm import sessionmaker
from sqlmodel.ext.asyncio.session import AsyncSession

import config as app_config
from dbkit import changes, targets

logger = logging.getLogger(__name__)

_ALEMBIC_INI = Path(__file__).parent / "alembic.ini"
_MIGRATIONS_DIR = Path(__file__).parent / "alembic" / "versions"


class SchemaError(RuntimeError):
    """The database cannot be used as it is: it was made by a newer app, or it holds something that is not a board.
    `code` is "newer" or "foreign"."""

    def __init__(self, code: str, message: str):
        """Say why."""
        super().__init__(message)
        self.code = code


def _resolve_db_path() -> Path:
    # A data folder chosen in Settings wins over KANBAN_DB_PATH. The desktop app always sets
    # KANBAN_DB_PATH to its default location, so letting it win would hide the data of anyone
    # who moved their data folder (the board would look empty after an upgrade).
    configured = app_config.get_data_folder()
    if configured:
        configured.mkdir(parents=True, exist_ok=True)
        return configured / "kanban.db"
    _db_path_env = os.environ.get("KANBAN_DB_PATH", "")
    if _db_path_env:
        p = Path(_db_path_env).resolve()
        p.parent.mkdir(parents=True, exist_ok=True)
        return p
    return Path(__file__).parent / "kanban.db"


def _resolve_target() -> tuple[targets.Target, str]:
    try:
        return targets.resolve(_DB_PATH)
    except targets.TargetError:
        # A broken KANBAN_DATABASE_URL must not silently fall back to another database
        if os.environ.get(targets.ENV_URL):
            raise
        logger.exception("The saved database setting cannot be used; using SQLite")
        return targets.Target("sqlite", path=str(_DB_PATH)), "default"


_DB_PATH: Path = _resolve_db_path()
_TARGET, _SOURCE = _resolve_target()
DATABASE_URL = _TARGET.url().render_as_string(hide_password=True)

engine = targets.make_engine(_TARGET)

async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

changes.install()


def get_db_path() -> Path:
    """The SQLite file in the data folder (the database when SQLite is in use; folders of the app sit next to it)."""
    return _DB_PATH


def get_data_dir() -> Path:
    """The data folder: attachments, AI run logs and the SQLite file live here whichever database is in use."""
    return _DB_PATH.parent


def current_target() -> targets.Target:
    """The database in use (with its password; never print it, use `display()`)."""
    return _TARGET


def target_source() -> str:
    """Where the database in use was set: "environment", "settings" or "default"."""
    return _SOURCE


def is_sqlite() -> bool:
    """Whether the board runs on a SQLite file (FTS5 search, the WAL file, the file-based export)."""
    return engine.dialect.name == "sqlite"


async def insert_missing(session: AsyncSession, model, **values) -> None:
    """Insert one row unless it exists (INSERT OR IGNORE), in the session's transaction: how a row is made on first use.

    Two requests that both find the row missing can both try to make it. With a plain add and commit, the second
    one's commit fails and it has to roll back, and a rollback expires everything that session had loaded: reading
    any of it afterwards is lazy IO outside the async context (MissingGreenlet), a 500. With this, the second insert
    does nothing and both read the row back. The model's column defaults fill what ``values`` leaves out. The same on
    every engine: SQLite's and PostgreSQL's ON CONFLICT DO NOTHING, MySQL's INSERT IGNORE.
    """
    dialect = session.get_bind().dialect.name
    if dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert as pg_insert

        stmt = pg_insert(model).values(**values).on_conflict_do_nothing()
    elif dialect == "mysql":
        from sqlalchemy.dialects.mysql import insert as my_insert

        stmt = my_insert(model).values(**values).prefix_with("IGNORE")
    else:
        from sqlalchemy.dialects.sqlite import insert as sqlite_insert

        stmt = sqlite_insert(model).values(**values).on_conflict_do_nothing()
    await session.exec(stmt)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """Yield a database session (FastAPI dependency)."""
    async with async_session() as session:
        yield session


# Databases made by pre-release builds are stamped with a migration that was later removed
# from the chain, and alembic cannot start from an unknown revision ("Can't locate revision").
# Map each such revision to the nearest revision that still exists, which has the same schema
# minus what the removed one added (extra, unused columns are harmless).
LEGACY_REVISIONS = {
    # "add_idea_board_fields" (April 2026 baseline) added board/idea_* columns to ticket;
    # Idea Space moved to its own idea_ticket table (f1a2b3c4d5e6), whose parent is this one.
    "f6a7b8c9d0e1": "1e1bb4aa5fa4",
}


def _restamp_legacy_revision(sync_conn) -> None:
    from sqlalchemy import inspect, text

    if not inspect(sync_conn).has_table("alembic_version"):
        return
    current = (
        sync_conn.execute(text("SELECT version_num FROM alembic_version"))
        .scalars()
        .all()
    )
    for old, new in LEGACY_REVISIONS.items():
        if old in current:
            sync_conn.execute(
                text(
                    "UPDATE alembic_version SET version_num = :new WHERE version_num = :old"
                ),
                {"new": new, "old": old},
            )


def alembic_config():
    """The migrations' config, for the database in use."""
    from alembic.config import Config

    cfg = Config(str(_ALEMBIC_INI))
    # A literal % in a URL (an encoded password character) would be read as interpolation
    cfg.set_main_option("sqlalchemy.url", DATABASE_URL.replace("%", "%%"))
    return cfg


def head_revision() -> str:
    """The newest migration this app knows."""
    from alembic.script import ScriptDirectory

    return ScriptDirectory.from_config(alembic_config()).get_current_head()


def known_revision(rev: str) -> bool:
    """Whether this app knows the migration `rev` (a database stamped with one it does not was made by a newer app)."""
    from alembic.script import ScriptDirectory

    try:
        return (
            ScriptDirectory.from_config(alembic_config()).get_revision(rev) is not None
        )
    except Exception:  # noqa: BLE001 - alembic raises several kinds for an unknown id
        return rev in LEGACY_REVISIONS


_REVISION_RE = re.compile(r"""^revision\b[^=\n]*=\s*["']([^"']+)["']""", re.MULTILINE)
_DOWN_REVISION_RE = re.compile(r"^down_revision\b[^=\n]*=(.*)$", re.MULTILINE)
_QUOTED_RE = re.compile(r"""["']([^"']+)["']""")


def migration_heads() -> set[str]:
    """The head revisions of the migration scripts, read from the files without loading alembic.

    Takes ``revision`` and ``down_revision`` from each script's header (a tuple for a merge); the
    heads are the revisions no other script points back to. tests/test_database_startup.py checks
    that this agrees with alembic's own view of the scripts.
    """
    revisions: set[str] = set()
    parents: set[str] = set()
    for script in _MIGRATIONS_DIR.glob("*.py"):
        source = script.read_text(encoding="utf-8")
        revision = _REVISION_RE.search(source)
        if not revision:
            continue
        revisions.add(revision[1])
        down = _DOWN_REVISION_RE.search(source)
        if down:
            parents.update(_QUOTED_RE.findall(down[1]))
    return revisions - parents


def _is_at_head(sync_conn) -> bool:
    """Whether the database is stamped with the one head revision, so there is nothing to migrate."""
    from sqlalchemy import inspect, text

    heads = migration_heads()
    if len(heads) != 1 or not inspect(sync_conn).has_table("alembic_version"):
        return False
    current = (
        sync_conn.execute(text("SELECT version_num FROM alembic_version"))
        .scalars()
        .all()
    )
    return current == list(heads)


def _run_upgrade(sync_conn, alembic_cfg) -> None:
    """Sync callback executed by AsyncConnection.run_sync.

    Injects the sync connection into alembic config so env.py skips
    creating its own engine and avoids a nested asyncio.run() call.
    """
    from alembic import command

    alembic_cfg.attributes["connection"] = sync_conn
    _restamp_legacy_revision(sync_conn)
    command.upgrade(alembic_cfg, "head")


def schema_state(sync_conn) -> dict:
    """What a database holds: {"state": "empty" | "board" | "foreign", "revision", "tables"} (app tables only for
    "board": the change log and the FTS tables are left out)."""
    from sqlalchemy import inspect, text

    names = set(inspect(sync_conn).get_table_names())
    names.discard(changes.TABLE)
    if not names:
        return {"state": "empty", "revision": None, "tables": 0}
    if "alembic_version" not in names:
        return {"state": "foreign", "revision": None, "tables": len(names)}
    revs = (
        sync_conn.execute(text("SELECT version_num FROM alembic_version"))
        .scalars()
        .all()
    )
    return {
        "state": "board",
        "revision": revs[0] if revs else None,
        "tables": len(names - {"alembic_version"}),
    }


def create_schema(sync_conn, alembic_cfg) -> None:
    """Make the app's tables on an empty PostgreSQL or MySQL database from the models and stamp it at the newest
    migration. The migrations were written for SQLite; replaying them on a new engine would only rebuild what the
    models already say. Later migrations then run on it as on SQLite. Links between tables are not enforced by the
    database, as on SQLite (`dbkit.types.server_metadata`)."""
    from alembic import command
    from sqlmodel import SQLModel

    import models  # noqa: F401 - registers every table
    from dbkit.types import server_metadata

    server_metadata(SQLModel.metadata).create_all(sync_conn)
    changes.create(sync_conn)
    alembic_cfg.attributes["connection"] = sync_conn
    command.stamp(alembic_cfg, "head")


def _prepare_server(sync_conn, alembic_cfg) -> None:
    state = schema_state(sync_conn)
    if state["state"] == "empty":
        create_schema(sync_conn, alembic_cfg)
        return
    if state["state"] == "foreign":
        raise SchemaError(
            "foreign",
            f"This database already holds {state['tables']} tables that are not a Kanban board. "
            "Choose an empty database.",
        )
    rev = state["revision"]
    if rev and not known_revision(rev):
        raise SchemaError(
            "newer",
            f"This database was made by a newer version of the app (migration {rev[:8]}…). Update the app first; "
            "the board will not touch it.",
        )
    changes.create(sync_conn)
    _run_upgrade(sync_conn, alembic_cfg)


async def init_db() -> None:
    """Bring the database in use up to the newest schema.

    SQLite: apply pending Alembic migrations and turn on WAL (readers never wait for a writer). PostgreSQL and MySQL:
    an empty database gets the app's tables, one of ours gets its pending migrations, anything else is refused.
    Safe to call on every startup; idempotent when already at head.
    A SQLite database already at head skips alembic altogether: importing it and loading every
    migration script took about 0.17 s of every start.
    """
    from sqlalchemy import text

    if engine.dialect.name == "sqlite":
        async with engine.connect() as conn:
            await conn.execute(text("PRAGMA journal_mode=WAL"))
            await conn.commit()
            if await conn.run_sync(_is_at_head):
                return

        async with engine.begin() as conn:
            await conn.run_sync(_run_upgrade, alembic_config())
        return

    async with engine.begin() as conn:
        await conn.run_sync(_prepare_server, alembic_config())


def _set_target(target: targets.Target, source: str) -> None:
    global engine, async_session, DATABASE_URL, _TARGET, _SOURCE  # noqa: PLW0603

    _TARGET, _SOURCE = target, source
    DATABASE_URL = target.url().render_as_string(hide_password=True)
    engine = targets.make_engine(target)
    async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def reinit_db(new_db_path: Path | None = None) -> None:
    """Re-read which database to use (after the data folder moved, an import, or a switch), then run migrations.

    Updates the module-level ``engine``, ``async_session``, and ``DATABASE_URL`` globals so all subsequent
    ``get_session()`` calls use the new database. In-flight requests that already have an open session will continue
    on the old engine until they complete.
    """
    global _DB_PATH  # noqa: PLW0603

    await engine.dispose()
    if new_db_path is not None:
        _DB_PATH = new_db_path
    _set_target(*_resolve_target())
    await init_db()


async def use(target: targets.Target) -> None:
    """Point the app at `target` now and remember it in Settings (the wizard's Switch). Refused while
    ``KANBAN_DATABASE_URL`` is set: the environment wins."""
    if os.environ.get(targets.ENV_URL):
        raise SchemaError(
            "locked",
            "KANBAN_DATABASE_URL is set, so the database cannot be changed from here.",
        )
    old = app_config.get_section(targets.CONFIG_KEY)
    targets.save_choice(target)
    try:
        await reinit_db()
    except Exception:
        app_config.set_section(targets.CONFIG_KEY, old or None)
        await reinit_db()
        raise


# ---------------------------------------------------------------------------
# Following the setting, and a database that does not answer
# ---------------------------------------------------------------------------

# Set while the database in use cannot be reached: {"since": epoch seconds, "error": str, "target": public dict}.
# The API answers 503 with code "database_unreachable" meanwhile, and the app shows the reconnect screen (design E).
UNREACHABLE: dict | None = None
RETRY_S = 8


def _settings_key() -> str:
    """What decides the database: the environment variable and the saved choice (never shown)."""
    import json

    return json.dumps(
        [
            os.environ.get(targets.ENV_URL, ""),
            app_config.get_section(targets.CONFIG_KEY),
        ],
        sort_keys=True,
    )


def _is_connection_error(exc: BaseException) -> bool:
    from sqlalchemy.exc import DBAPIError, InterfaceError, OperationalError

    if isinstance(exc, (OSError, TimeoutError)):
        return True
    if isinstance(exc, (OperationalError, InterfaceError)):
        return True
    if isinstance(exc, DBAPIError) and exc.connection_invalidated:
        return True
    name = type(exc).__name__
    return name in ("ConnectionDoesNotExistError", "CannotConnectNowError")


async def init_db_or_wait() -> None:
    """`init_db`, but a server database that does not answer at startup leaves the app running in the
    "cannot reach its database" state, retrying every few seconds, instead of failing to start."""
    global UNREACHABLE  # noqa: PLW0603
    import asyncio
    import time

    try:
        await init_db()
        UNREACHABLE = None
        return
    except SchemaError:
        raise
    except Exception as exc:
        if is_sqlite() or not _is_connection_error(exc):
            raise
        UNREACHABLE = {
            "since": time.time(),
            "error": str(getattr(exc, "orig", None) or exc).split("\n")[0][:300],
            "target": {
                **_TARGET.public(),
                "label": _TARGET.label,
                "display": _TARGET.display(),
            },
        }
        logger.error("The database cannot be reached: %s", UNREACHABLE["error"])

    async def retry() -> None:
        global UNREACHABLE  # noqa: PLW0603
        while UNREACHABLE is not None:
            await asyncio.sleep(RETRY_S)
            try:
                await init_db()
                UNREACHABLE = None
                logger.info("The database answers again")
            except Exception as exc:  # noqa: BLE001 - keep trying
                if UNREACHABLE is not None:
                    UNREACHABLE["error"] = str(getattr(exc, "orig", None) or exc).split(
                        "\n"
                    )[0][:300]

    asyncio.get_running_loop().create_task(retry())


async def check_reachable(timeout: float = 5.0) -> dict:
    """Ask the database in use for one row; updates `UNREACHABLE`."""
    global UNREACHABLE  # noqa: PLW0603
    import asyncio
    import time

    from sqlalchemy import text

    started = time.monotonic()
    try:

        async def ping():
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))

        await asyncio.wait_for(ping(), timeout)
        UNREACHABLE = None
        return {"ok": True, "latency_ms": int((time.monotonic() - started) * 1000)}
    except Exception as exc:  # noqa: BLE001 - the answer is the point
        error = (
            str(getattr(exc, "orig", None) or exc).split("\n")[0][:300]
            or type(exc).__name__
        )
        if UNREACHABLE is None:
            UNREACHABLE = {
                "since": time.time(),
                "error": error,
                "target": {
                    **_TARGET.public(),
                    "label": _TARGET.label,
                    "display": _TARGET.display(),
                },
            }
        else:
            UNREACHABLE["error"] = error
        return {"ok": False, "error": error}


async def follow_settings(interval: float = 2.0) -> None:
    """Re-point this process when the database setting changes (the wizard's switch in the board, `kanban-db use`
    on the command line): the board and the stdio MCP processes that editors launch then always use one database."""
    import asyncio

    seen = _settings_key()
    while True:
        await asyncio.sleep(interval)
        try:
            now = _settings_key()
            if now == seen:
                continue
            seen = now
            target, _source = _resolve_target()
            if target.url() == _TARGET.url() and target.password == _TARGET.password:
                continue
            logger.info("The database setting changed; now using %s", target.label)
            await reinit_db()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - keep following
            logger.exception("Could not follow the database setting")
