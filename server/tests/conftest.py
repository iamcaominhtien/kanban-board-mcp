import os
import tempfile

# Fake keys in tests write one character as an escape (`sk-ant\x2d…`) so secret scanners do not take them for real ones.

# `main` starts file logging when imported; keep test runs out of the developer's real log folder.
os.environ.setdefault("KANBAN_LOG_DIR", tempfile.mkdtemp(prefix="kanban-test-logs-"))

# The default database of a test run is a fresh file migrated to head, never the developer's kanban.db. Tests swap
# in their own engine for requests, but services that open a session of their own (AI hooks on ticket changes, the
# audit log) still reach the default one, which must have the full schema, as it does in production.
# Tests keep working folders and fake CLIs in temporary folders and in the repository.
os.environ.setdefault(
    "KANBAN_AI_ROOTS",
    os.pathsep.join(
        [
            tempfile.gettempdir(),
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        ]
    ),
)

# The path is read once, when `database` is imported; the variable is then dropped again so code that copies it into
# MCP client entries sees a plain environment.
_DEFAULT_DB = os.path.join(tempfile.mkdtemp(prefix="kanban-test-db-"), "kanban.db")
_DB_FROM_TESTS = "KANBAN_DB_PATH" not in os.environ
os.environ.setdefault("KANBAN_DB_PATH", _DEFAULT_DB)


def _migrate_default_db() -> None:
    from alembic import command
    from alembic.config import Config

    cfg = Config(
        os.path.join(os.path.dirname(os.path.dirname(__file__)), "alembic.ini")
    )
    cfg.set_main_option(
        "sqlalchemy.url", f"sqlite+aiosqlite:///{os.environ['KANBAN_DB_PATH']}"
    )
    command.upgrade(cfg, "head")


_migrate_default_db()
import database  # noqa: E402,F401

if _DB_FROM_TESTS:
    del os.environ["KANBAN_DB_PATH"]


import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _approvals_do_not_wait(monkeypatch):
    """A tool call that needs approval waits for the decision; tests that want the wait set it themselves."""
    from services.ai import guard

    monkeypatch.setattr(guard, "APPROVAL_WAIT_S", 0)
