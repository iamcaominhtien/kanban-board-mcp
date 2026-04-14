import os
from collections.abc import AsyncGenerator
from pathlib import Path

from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlmodel.ext.asyncio.session import AsyncSession

import config as app_config

_ALEMBIC_INI = Path(__file__).parent / "alembic.ini"


def _resolve_db_path() -> Path:
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


DATABASE_URL = f"sqlite+aiosqlite:///{_resolve_db_path()}"

engine = create_async_engine(DATABASE_URL, echo=False)

async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with async_session() as session:
        yield session


def _run_upgrade(sync_conn, alembic_cfg) -> None:
    """Sync callback executed by AsyncConnection.run_sync.

    Injects the sync connection into alembic config so env.py skips
    creating its own engine and avoids a nested asyncio.run() call.
    """
    from alembic import command

    alembic_cfg.attributes["connection"] = sync_conn
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
    global engine, async_session, DATABASE_URL  # noqa: PLW0603

    await engine.dispose()

    DATABASE_URL = f"sqlite+aiosqlite:///{new_db_path}"
    engine = create_async_engine(DATABASE_URL, echo=False)
    async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    await init_db()
