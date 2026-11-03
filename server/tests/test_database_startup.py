"""init_db skips alembic when the database is already at head, and migrates it otherwise."""

import pytest
from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text

import database


def test_migration_heads_agree_with_alembic():
    """The heads read from the script headers are the ones alembic finds."""
    script = ScriptDirectory.from_config(Config(str(database._ALEMBIC_INI)))
    assert database.migration_heads() == set(script.get_heads())
    assert len(database.migration_heads()) == 1


@pytest.fixture
def db_at(tmp_path, monkeypatch):
    url = f"sqlite+aiosqlite:///{tmp_path / 'kanban.db'}"
    engine = database.create_async_engine(url)
    monkeypatch.setattr(database, "DATABASE_URL", url)
    monkeypatch.setattr(database, "engine", engine)
    yield engine


async def _version(engine) -> str:
    async with engine.connect() as conn:
        return (
            await conn.execute(text("SELECT version_num FROM alembic_version"))
        ).scalar_one()


async def test_a_new_database_is_migrated_to_head(db_at):
    await database.init_db()
    assert await _version(db_at) == database.migration_heads().pop()
    await db_at.dispose()


async def test_a_database_at_head_does_not_load_alembic(db_at, monkeypatch):
    await database.init_db()

    def no_upgrade(*_args, **_kwargs):
        raise AssertionError("alembic ran on a database already at head")

    monkeypatch.setattr(command, "upgrade", no_upgrade)
    await database.init_db()
    async with db_at.connect() as conn:
        mode = (await conn.execute(text("PRAGMA journal_mode"))).scalar_one()
    assert mode == "wal"
    await db_at.dispose()


async def test_a_database_behind_head_is_migrated(db_at):
    """A database stamped at an older revision still goes through alembic."""
    script = ScriptDirectory.from_config(Config(str(database._ALEMBIC_INI)))
    head = script.get_revision(database.migration_heads().pop())
    parent = head.down_revision
    assert isinstance(parent, str)  # the head is not a merge, so it has one parent

    cfg = Config(str(database._ALEMBIC_INI))
    cfg.set_main_option("sqlalchemy.url", database.DATABASE_URL)

    def upgrade_to_parent(sync_conn) -> None:
        cfg.attributes["connection"] = sync_conn
        command.upgrade(cfg, parent)

    async with db_at.begin() as conn:
        await conn.run_sync(upgrade_to_parent)

    await database.init_db()
    assert await _version(db_at) == head.revision
    await db_at.dispose()
