"""Backups from older builds must open, and importing a backup must not corrupt the database."""
import sqlite3
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

import database
from api import data as data_api


def _make_db(path: Path, rows: int = 3) -> None:
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
    conn.executemany("INSERT INTO t (v) VALUES (?)", [(f"row {i}",) for i in range(rows)])
    conn.commit()
    conn.close()


def test_check_sqlite_file_accepts_a_healthy_database(tmp_path: Path) -> None:
    db_file = tmp_path / "ok.db"
    _make_db(db_file)
    assert data_api._check_sqlite_file(db_file) is None


def test_check_sqlite_file_rejects_garbage_and_truncated_files(tmp_path: Path) -> None:
    garbage = tmp_path / "garbage.db"
    garbage.write_bytes(b"this is not a database" * 500)
    assert data_api._check_sqlite_file(garbage) is not None

    good = tmp_path / "good.db"
    _make_db(good, rows=2000)
    truncated = tmp_path / "truncated.db"
    truncated.write_bytes(good.read_bytes()[:5000])
    assert data_api._check_sqlite_file(truncated) is not None


def test_remove_wal_files_only_touches_the_sidecar_files(tmp_path: Path) -> None:
    db_file = tmp_path / "kanban.db"
    db_file.write_bytes(b"x")
    wal = Path(str(db_file) + "-wal")
    shm = Path(str(db_file) + "-shm")
    wal.write_bytes(b"old wal")
    shm.write_bytes(b"old shm")

    data_api._remove_wal_files(db_file)

    assert db_file.exists()
    assert not wal.exists() and not shm.exists()
    data_api._remove_wal_files(db_file)  # nothing left: must not raise


async def test_database_stamped_with_a_removed_migration_still_upgrades(
    monkeypatch, tmp_path: Path
) -> None:
    """Pre-release builds stamped f6a7b8c9d0e1, a migration that no longer exists."""
    db_file = tmp_path / "kanban.db"
    url = f"sqlite+aiosqlite:///{db_file}"
    engine = create_async_engine(url)
    monkeypatch.setattr(database, "engine", engine)
    monkeypatch.setattr(database, "DATABASE_URL", url)

    cfg = Config(str(database._ALEMBIC_INI))
    cfg.set_main_option("sqlalchemy.url", url)

    def upgrade_to_parent(sync_conn) -> None:
        cfg.attributes["connection"] = sync_conn
        command.upgrade(cfg, "1e1bb4aa5fa4")

    async with engine.begin() as conn:
        await conn.run_sync(upgrade_to_parent)
        await conn.execute(text("UPDATE alembic_version SET version_num = 'f6a7b8c9d0e1'"))
        await conn.execute(text("ALTER TABLE ticket ADD COLUMN board TEXT NOT NULL DEFAULT 'main'"))
        await conn.execute(text(
            "INSERT INTO project (id, name, prefix, color, ticket_counter) "
            "VALUES ('p1', 'Old project', 'OLD', '#2E6F40', 0)"
        ))

    await database.init_db()  # used to fail with "Can't locate revision identified by 'f6a7b8c9d0e1'"

    async with engine.connect() as conn:
        version = (await conn.execute(text("SELECT version_num FROM alembic_version"))).scalar_one()
        projects = (await conn.execute(text("SELECT name FROM project"))).scalars().all()
        tables = (await conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))).scalars().all()
    await engine.dispose()

    assert version != "f6a7b8c9d0e1"
    assert projects == ["Old project"]
    assert "idea_ticket" in tables
