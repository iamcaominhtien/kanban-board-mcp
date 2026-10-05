import importlib
import sys
from pathlib import Path


def _reload_database_module():
    sys.modules.pop("database", None)
    import database

    return importlib.reload(database)


def test_database_uses_repo_default_path_when_env_missing(monkeypatch) -> None:
    monkeypatch.delenv("KANBAN_DB_PATH", raising=False)
    monkeypatch.setattr("config.get_data_folder", lambda: None)

    database = _reload_database_module()

    expected = Path(database.__file__).resolve().parent / "kanban.db"
    assert database._DB_PATH == expected
    assert database.DATABASE_URL == f"sqlite+aiosqlite:///{expected}"


def test_database_resolves_env_path_and_creates_parent_directory(
    monkeypatch, tmp_path: Path
) -> None:
    db_path = tmp_path / "nested" / "state" / "kanban.db"
    monkeypatch.setenv("KANBAN_DB_PATH", str(db_path))
    monkeypatch.setattr("config.get_data_folder", lambda: None)

    database = _reload_database_module()

    assert database._DB_PATH == db_path.resolve()
    assert db_path.parent.is_dir()
    assert database.DATABASE_URL == f"sqlite+aiosqlite:///{db_path.resolve()}"

def test_data_folder_from_settings_wins_over_env_path(monkeypatch, tmp_path: Path) -> None:
    # The desktop app always passes KANBAN_DB_PATH (its default location). Someone who moved
    # their data folder in Settings must still get that data after an upgrade.
    chosen = tmp_path / "my-data"
    monkeypatch.setenv("KANBAN_DB_PATH", str(tmp_path / "app-default" / "kanban.db"))
    monkeypatch.setattr("config.get_data_folder", lambda: chosen)

    database = _reload_database_module()

    assert database._DB_PATH == chosen / "kanban.db"


def test_uploads_uses_data_folder_when_configured(monkeypatch, tmp_path: Path) -> None:
    chosen = tmp_path / "my-data"
    monkeypatch.delenv("KANBAN_UPLOADS_DIR", raising=False)
    monkeypatch.setattr("config.get_data_folder", lambda: chosen)
    import uploads
    assert uploads.get_uploads_dir() == chosen / "uploads"


def test_uploads_uses_env_when_set(monkeypatch, tmp_path: Path) -> None:
    custom = tmp_path / "custom-uploads"
    monkeypatch.setenv("KANBAN_UPLOADS_DIR", str(custom))
    monkeypatch.setattr("config.get_data_folder", lambda: tmp_path / "other")
    import uploads
    assert uploads.get_uploads_dir() == custom

