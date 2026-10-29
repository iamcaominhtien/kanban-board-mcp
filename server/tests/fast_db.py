"""Fresh, empty databases for tests without paying for the schema each time. Creating the 37 tables takes about
0.2 s in memory and 0.5 s in a file, which added minutes to a run; copying a ready file or emptying the tables
takes a few milliseconds."""

import functools
import os
import shutil
import tempfile

from sqlalchemy import create_engine, text
from sqlmodel import SQLModel

import models  # noqa: F401  (registers every table)


@functools.cache
def _template() -> str:
    path = os.path.join(tempfile.mkdtemp(prefix="kanban-test-template-"), "empty.db")
    engine = create_engine(f"sqlite:///{path}")
    SQLModel.metadata.create_all(engine)
    engine.dispose()
    return path


def fresh_db_file(path) -> str:
    """Put an empty database with the full schema at `path`; returns its SQLAlchemy async URL."""
    shutil.copyfile(_template(), path)
    return f"sqlite+aiosqlite:///{path}"


def _empty(sync_conn) -> None:
    have = {
        r[0]
        for r in sync_conn.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        )
    }
    if not set(SQLModel.metadata.tables) <= have:
        SQLModel.metadata.create_all(sync_conn)
        return
    for table in reversed(SQLModel.metadata.sorted_tables):
        sync_conn.execute(table.delete())
    if "sqlite_sequence" in have:
        sync_conn.execute(text("DELETE FROM sqlite_sequence"))


async def fresh_tables(engine) -> None:
    """Empty every table of a test engine, creating the schema the first time."""
    async with engine.begin() as conn:
        await conn.run_sync(_empty)
