import os
from collections.abc import AsyncGenerator
from pathlib import Path

from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlmodel.ext.asyncio.session import AsyncSession

_ALEMBIC_INI = Path(__file__).parent / "alembic.ini"

_db_path_env = os.environ.get("KANBAN_DB_PATH", "")
if _db_path_env:
    _DB_PATH = Path(_db_path_env).resolve()
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
else:
    _DB_PATH = Path(__file__).parent / "kanban.db"

DATABASE_URL = f"sqlite+aiosqlite:///{_DB_PATH}"

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
