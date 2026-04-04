from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel import SQLModel

DATABASE_URL = "sqlite+aiosqlite:///./kanban.db"

engine = create_async_engine(DATABASE_URL, echo=False)


async def init_db() -> None:
    import models  # noqa: F401 — must be imported so SQLModel.metadata is populated

    async with engine.begin() as conn:
        await conn.execute(text("PRAGMA journal_mode=WAL"))
        await conn.run_sync(SQLModel.metadata.create_all)
