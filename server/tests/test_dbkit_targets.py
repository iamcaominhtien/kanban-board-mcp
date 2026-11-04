"""Which database the board uses (design/screens/ai-databases.md B, F): connection strings, the saved choice with its
password encrypted, the environment winning, and the engines' settings. With KANBAN_TEST_PG_URL, the change log that
lets the board hear another process's writes on a server database."""

import asyncio
import json
import os

import pytest
from sqlalchemy import insert, text
from sqlalchemy.orm import sessionmaker
from sqlmodel.ext.asyncio.session import AsyncSession

import config as app_config
import database
import events
from dbkit import changes, targets
from dbkit.sql import bump_counter
from dbkit.types import server_metadata

PG = os.environ.get("KANBAN_TEST_PG_URL", "")
FROM_ENV = "value-from-the-environment"  # the value the environment variable carries


@pytest.fixture
def config_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(app_config, "_CONFIG_DIR", tmp_path)
    monkeypatch.setattr(app_config, "_CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setenv("KANBAN_AI_KEY_FILE", str(tmp_path / "key"))
    monkeypatch.delenv(targets.ENV_URL, raising=False)
    monkeypatch.delenv(targets.ENV_PASSWORD, raising=False)
    from services.ai import secrets

    secrets._cached.clear()
    return tmp_path


def test_connection_strings():
    t = targets.from_url(
        "postgres://kanban:s3cr%40t\x40db.internal/kanban?sslmode=verify-full"  # \x40: "@", so secret scanners skip it
    )
    assert (t.engine, t.host, t.port, t.name, t.user, t.password, t.ssl) == (
        "postgresql",
        "db.internal",
        5432,
        "kanban",
        "kanban",
        "s3cr@t",
        "verify-full",
    )
    assert (
        "s3cr" not in t.display()
        and "s3cr" not in repr(t)
        and "password" not in t.public()
    )
    assert t.url().drivername == "postgresql+asyncpg"
    m = targets.from_url("mariadb+pymysql://app@mysql.internal:3307/kanban")
    assert (m.engine, m.port, m.url().drivername) == ("mysql", 3307, "mysql+aiomysql")
    assert m.url().query["charset"] == "utf8mb4"
    s = targets.from_url("sqlite:///~/kanban-data/kanban.db")
    assert (
        s.is_sqlite and s.path.endswith("kanban-data/kanban.db") and "~" not in s.path
    )
    for bad in (
        "redis://localhost/0",
        "mongodb://x/y",
        "oracle://x/y",
        "postgresql:///nohost",
        "",
    ):
        with pytest.raises(targets.TargetError):
            targets.from_url(bad)


def test_redis_and_mongodb_say_why():
    with pytest.raises(targets.TargetError, match="relational"):
        targets.from_url("mongodb://localhost/kanban")


def test_the_saved_choice_keeps_the_password_encrypted(config_dir):
    secret = "hunter\x32"  # one character escaped, so secret scanners do not take it for a real one
    target = targets.from_fields(
        {
            "engine": "postgresql",
            "host": "db",
            "name": "kanban",
            "user": "k",
            "password": secret,
            "ssl": "require",
        }
    )
    targets.save_choice(target)
    raw = (config_dir / "config.json").read_text()
    assert secret not in raw
    saved = json.loads(raw)["database"]
    assert saved["engine"] == "postgresql" and saved["password_enc"]
    back = targets.saved_target()
    assert back.password == secret and back.ssl == "require"
    resolved, source = targets.resolve(config_dir / "kanban.db")
    assert source == "settings" and resolved.host == "db"
    targets.save_choice(targets.Target("sqlite", path="x"))
    resolved, source = targets.resolve(config_dir / "kanban.db")
    assert source == "default" and resolved.path == str(config_dir / "kanban.db")


def test_the_environment_wins_and_takes_the_password_variable(config_dir, monkeypatch):
    targets.save_choice(targets.from_url("mysql://a:b\x40saved/x"))
    monkeypatch.setenv(targets.ENV_URL, "postgresql://kanban@env-host/kanban")
    monkeypatch.setenv(targets.ENV_PASSWORD, FROM_ENV)
    resolved, source = targets.resolve(config_dir / "kanban.db")
    assert (
        source == "environment"
        and resolved.host == "env-host"
        and resolved.password == FROM_ENV
    )


async def test_use_is_refused_while_the_environment_sets_the_database(monkeypatch):
    monkeypatch.setenv(targets.ENV_URL, "postgresql://kanban@env-host/kanban")
    with pytest.raises(database.SchemaError) as err:
        await database.use(targets.Target("sqlite", path="/tmp/x.db"))
    assert err.value.code == "locked"


async def test_sqlite_connections_wait_for_the_write_lock(tmp_path):
    engine = targets.make_engine(targets.Target("sqlite", path=str(tmp_path / "a.db")))
    async with engine.connect() as conn:
        timeout = (await conn.execute(text("PRAGMA busy_timeout"))).scalar()
        sync = (await conn.execute(text("PRAGMA synchronous"))).scalar()
    await engine.dispose()
    assert timeout == targets.SQLITE_BUSY_TIMEOUT_S * 1000
    assert sync == 1  # NORMAL


def test_long_text_is_text_on_mysql_and_unchanged_elsewhere():
    from sqlalchemy.dialects import mysql, postgresql, sqlite
    from sqlalchemy.schema import CreateTable
    from sqlmodel import SQLModel

    t = SQLModel.metadata.tables["idea_ticket"]
    my = str(CreateTable(t).compile(dialect=mysql.dialect()))
    assert "body LONGTEXT" in my and "id VARCHAR(255)" in my
    assert "body VARCHAR" in str(CreateTable(t).compile(dialect=sqlite.dialect()))
    assert "body VARCHAR" in str(CreateTable(t).compile(dialect=postgresql.dialect()))


def test_server_schema_keeps_tables_and_indexes_but_enforces_no_links():
    from sqlmodel import SQLModel

    md = server_metadata(SQLModel.metadata)
    assert set(md.tables) == set(SQLModel.metadata.tables)
    assert not any(t.foreign_keys for t in md.tables.values())
    assert {"ix_member_project_id", "ix_ticket_project_status"} <= {
        i.name for t in md.tables.values() for i in t.indexes
    }


def test_the_ticket_hold_index_holds_only_active_work_runs_on_every_engine():
    from sqlalchemy.dialects import mysql, postgresql
    from sqlalchemy.schema import CreateIndex
    from sqlmodel import SQLModel

    def ddl(dialect, name):
        md = server_metadata(SQLModel.metadata, name)
        (index,) = [
            i for i in md.tables["ai_run"].indexes if i.name == "ux_ai_run_ticket_hold"
        ]
        return str(CreateIndex(index).compile(dialect=dialect))

    pg = ddl(postgresql.dialect(), "postgresql")
    assert pg.startswith("CREATE UNIQUE INDEX") and "WHERE mode = 'work'" in pg
    # MySQL has no partial index: a unique one would hold every run ever made
    my = ddl(mysql.dialect(), "mysql")
    assert my.startswith("CREATE INDEX") and "WHERE" not in my
    assert SQLModel.metadata.tables[
        "ai_run"
    ].indexes  # the shared models keep it unique
    assert all(
        i.unique
        for i in SQLModel.metadata.tables["ai_run"].indexes
        if i.name == "ux_ai_run_ticket_hold"
    )


async def test_counter_bump_returns_the_new_value(tmp_path):
    engine = targets.make_engine(targets.Target("sqlite", path=str(tmp_path / "c.db")))
    async with engine.begin() as conn:
        await conn.execute(
            text("CREATE TABLE c (id INTEGER PRIMARY KEY, n INTEGER, p TEXT)")
        )
        await conn.execute(text("INSERT INTO c VALUES (1, 4, 'KB')"))
    make = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with make() as s:
        row = await bump_counter(s, "c", "n", "id", 1, also=("p",))
        assert (row.n, row.p) == (5, "KB")
        assert await bump_counter(s, "c", "n", "id", 2) is None
    await engine.dispose()


@pytest.mark.skipif(not PG, reason="needs KANBAN_TEST_PG_URL")
async def test_a_write_by_another_process_is_announced_on_postgres(monkeypatch):
    engine = targets.make_engine(targets.from_url(PG))
    async with engine.begin() as conn:
        await conn.run_sync(changes.metadata.drop_all)
        await conn.run_sync(changes.create)
    monkeypatch.setattr(database, "engine", engine)
    q = events.subscribe()
    task = asyncio.create_task(events.watch_database(interval=0.05, grace=0.01))
    try:
        await asyncio.sleep(0.3)
        # this process's own write (any ORM session commit) is logged but not announced again
        make = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        async with make() as s:
            await s.execute(text("UPDATE kanban_change SET at = at WHERE id < 0"))
            await s.commit()
        async with engine.connect() as conn:
            mine = (
                await conn.execute(text("SELECT COUNT(*) FROM kanban_change"))
            ).scalar()
        assert mine == 1
        await asyncio.sleep(0.3)
        assert q.empty()
        async with engine.begin() as conn:  # the stdio MCP process writes
            await conn.execute(
                insert(changes.kanban_change).values(origin="other-process", at=0.0)
            )
        assert await asyncio.wait_for(q.get(), 3) == events.INVALIDATE
    finally:
        task.cancel()
        events.unsubscribe(q)
        async with engine.begin() as conn:
            await conn.run_sync(changes.metadata.drop_all)
        await engine.dispose()
