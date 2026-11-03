"""Fresh, empty databases for tests without paying for the schema each time. Creating the 37 tables takes about
0.2 s in memory and 0.5 s in a file, which added minutes to a run; copying a ready file or emptying the tables
takes a few milliseconds."""

import functools
import os
import shutil
import tempfile

from sqlalchemy import create_engine, inspect, text
from sqlmodel import SQLModel

import models  # noqa: F401  (registers every table)

# KANBAN_TEST_DATABASE_URL runs the suites that use TEST_URL on PostgreSQL or MySQL/MariaDB instead of SQLite in memory
# (CI's "Databases" job): `postgresql://user:<password>@host/db`, `mysql://…`. The database must be empty or
# hold only the board's tables; the tests empty every table before each test.
_SERVER_URL = os.environ.get("KANBAN_TEST_DATABASE_URL", "")


def _test_url() -> str:
    if not _SERVER_URL:
        return "sqlite+aiosqlite:///:memory:"
    from dbkit import targets

    return targets.from_url(_SERVER_URL).url().render_as_string(hide_password=False)


TEST_URL = _test_url()


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
    have = set(inspect(sync_conn).get_table_names())
    if sync_conn.dialect.name != "sqlite":
        from dbkit import changes

        changes.create(sync_conn)  # every write transaction adds a row to it
    if not set(SQLModel.metadata.tables) <= have:
        if sync_conn.dialect.name == "sqlite":
            SQLModel.metadata.create_all(sync_conn)
        else:
            from dbkit.types import server_metadata

            server_metadata(SQLModel.metadata).create_all(sync_conn)
        return
    for table in reversed(SQLModel.metadata.sorted_tables):
        sync_conn.execute(table.delete())
    if "sqlite_sequence" in have:
        sync_conn.execute(text("DELETE FROM sqlite_sequence"))


async def fresh_tables(engine) -> None:
    """Empty every table of a test engine, creating the schema the first time."""
    if engine.dialect.name != "sqlite":
        # Each test runs in an event loop of its own, and asyncpg/aiomysql connections belong to the loop that
        # opened them: start every test with empty pools (without closing connections of a loop that is gone)
        import database

        await engine.dispose(close=False)
        await database.engine.dispose(close=False)
    async with engine.begin() as conn:
        await conn.run_sync(_empty)
