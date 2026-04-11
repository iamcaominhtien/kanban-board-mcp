import importlib
import sys
from pathlib import Path


def _reload_database_module():
    sys.modules.pop("database", None)
    import database

    return importlib.reload(database)


def test_database_uses_repo_default_path_when_env_missing(monkeypatch) -> None:
    monkeypatch.delenv("KANBAN_DB_PATH", raising=False)

    database = _reload_database_module()

    expected = Path(database.__file__).resolve().parent / "kanban.db"
    assert database._DB_PATH == expected
    assert database.DATABASE_URL == f"sqlite+aiosqlite:///{expected}"


def test_database_resolves_env_path_and_creates_parent_directory(
    monkeypatch, tmp_path: Path
) -> None:
    db_path = tmp_path / "nested" / "state" / "kanban.db"
    monkeypatch.setenv("KANBAN_DB_PATH", str(db_path))

    database = _reload_database_module()

    assert database._DB_PATH == db_path.resolve()
    assert db_path.parent.is_dir()
    assert database.DATABASE_URL == f"sqlite+aiosqlite:///{db_path.resolve()}"