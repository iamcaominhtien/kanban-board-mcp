import os
from collections.abc import AsyncGenerator
from pathlib import Path

from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlmodel.ext.asyncio.session import AsyncSession

import config as app_config

_ALEMBIC_INI = Path(__file__).parent / "alembic.ini"


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


_DB_PATH: Path = _resolve_db_path()
DATABASE_URL = f"sqlite+aiosqlite:///{_DB_PATH}"

engine = create_async_engine(DATABASE_URL, echo=False)

async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


def get_db_path() -> Path:
    """Return the absolute path to the current SQLite database file."""
    return _DB_PATH


async def get_session() -> AsyncGenerator[AsyncSession, None]:
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
    current = sync_conn.execute(text("SELECT version_num FROM alembic_version")).scalars().all()
    for old, new in LEGACY_REVISIONS.items():
        if old in current:
            sync_conn.execute(
                text("UPDATE alembic_version SET version_num = :new WHERE version_num = :old"),
                {"new": new, "old": old},
            )


def _run_upgrade(sync_conn, alembic_cfg) -> None:
    """Sync callback executed by AsyncConnection.run_sync.

    Injects the sync connection into alembic config so env.py skips
    creating its own engine and avoids a nested asyncio.run() call.
    """
    from alembic import command

    alembic_cfg.attributes["connection"] = sync_conn
    _restamp_legacy_revision(sync_conn)
    command.upgrade(alembic_cfg, "head")


async def init_db() -> None:
    """Apply pending Alembic migrations and enable WAL mode.

    Safe to call on every startup — idempotent when already at head.
    On a fresh database this creates all tables and stamps the version.
    """
    from sqlalchemy import text
    from alembic.config import Config

    alembic_cfg = Config(str(_ALEMBIC_INI))
    alembic_cfg.set_main_option("sqlalchemy.url", DATABASE_URL)

    async with engine.connect() as conn:
        await conn.execute(text("PRAGMA journal_mode=WAL"))
        await conn.commit()

    async with engine.begin() as conn:
        await conn.run_sync(_run_upgrade, alembic_cfg)


async def reinit_db(new_db_path: Path) -> None:
    """Point the DB engine at a new path, then run migrations.

    Updates the module-level ``engine``, ``async_session``, and
    ``DATABASE_URL`` globals so all subsequent ``get_session()`` calls
    use the new database.  In-flight requests that already have an open
    session will continue on the old engine until they complete.
    """
    global engine, async_session, DATABASE_URL, _DB_PATH  # noqa: PLW0603

    await engine.dispose()

    _DB_PATH = new_db_path
    DATABASE_URL = f"sqlite+aiosqlite:///{new_db_path}"
    engine = create_async_engine(DATABASE_URL, echo=False)
    async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    await init_db()
