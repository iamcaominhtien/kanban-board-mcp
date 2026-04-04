from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlmodel.ext.asyncio.session import AsyncSession

DATABASE_URL = "sqlite+aiosqlite:///./kanban.db"

engine = create_async_engine(DATABASE_URL, echo=False)

async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with async_session() as session:
        yield session


async def init_db():
    from sqlalchemy import text

    async with engine.begin() as conn:
        await conn.execute(text("PRAGMA journal_mode=WAL"))
