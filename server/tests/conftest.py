import os
import shutil
import tempfile

# Fake keys in tests write one character as an escape (`sk-ant\x2d…`) so secret scanners do not take them for real ones.

# `main` starts file logging when imported; keep test runs out of the developer's real log folder.
os.environ.setdefault("KANBAN_LOG_DIR", tempfile.mkdtemp(prefix="kanban-test-logs-"))
# a diagram save must not start a browser during tests; the export tests switch it back on
os.environ.setdefault("KANBAN_DIAGRAM_EXPORT", "off")
# no shipped draw.io editor unless a test gives one, whether or not dist-drawio/ was fetched on this machine
os.environ.setdefault(
    "KANBAN_DRAWIO_DIR", os.path.join(tempfile.mkdtemp(prefix="kanban-test-"), "none")
)

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
# A data folder chosen in the developer's own ~/.kanban-board/config.json wins over KANBAN_DB_PATH, so `database` must be
# imported with a config folder of its own, or tests that open their own session would read (and write) the real kanban.db.
_CONFIG_FROM_TESTS = "KANBAN_CONFIG_DIR" not in os.environ
os.environ.setdefault(
    "KANBAN_CONFIG_DIR", tempfile.mkdtemp(prefix="kanban-test-config-")
)


# Running every migration takes about 4 s. The first process does it and keeps a copy whose path it leaves in this
# variable; pytest-xdist's workers inherit it and copy the file instead (CI names the shard's files on the command
# line, so the controller loads this conftest before it starts the workers).
_MIGRATED_ENV = "KANBAN_TEST_MIGRATED_DB"


def _migrate_default_db() -> None:
    target = os.environ["KANBAN_DB_PATH"]
    ready = os.environ.get(_MIGRATED_ENV, "")
    if ready and os.path.isfile(ready):
        shutil.copyfile(ready, target)
        return

    from alembic import command
    from alembic.config import Config

    cfg = Config(
        os.path.join(os.path.dirname(os.path.dirname(__file__)), "alembic.ini")
    )
    cfg.set_main_option("sqlalchemy.url", f"sqlite+aiosqlite:///{target}")
    command.upgrade(cfg, "head")
    copy = os.path.join(tempfile.mkdtemp(prefix="kanban-test-migrated-"), "kanban.db")
    shutil.copyfile(target, copy)
    os.environ[_MIGRATED_ENV] = copy


_migrate_default_db()
# With KANBAN_TEST_DATABASE_URL (tests/fast_db.py) the services' own sessions use that server database too
if os.environ.get("KANBAN_TEST_DATABASE_URL"):
    os.environ["KANBAN_DATABASE_URL"] = os.environ["KANBAN_TEST_DATABASE_URL"]
import database  # noqa: E402,F401

if _DB_FROM_TESTS:
    del os.environ["KANBAN_DB_PATH"]
if _CONFIG_FROM_TESTS:
    del os.environ["KANBAN_CONFIG_DIR"]


import pytest  # noqa: E402


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "memory_extraction: let a run's end start the light model that keeps notes (services/ai/memory.after_run)",
    )


@pytest.fixture(autouse=True)
def _no_notes_kept_after_runs(request, monkeypatch):
    """When a run ends, the board starts a light model in the background to keep notes from it: with the fake CLI
    that is one more Python process per run, half of what the run tests spent. Only a test marked
    `memory_extraction` gets it; the extraction itself is tested by calling it (tests/test_ai_memory.py)."""
    if request.node.get_closest_marker("memory_extraction"):
        return
    from services.ai import memory

    monkeypatch.setattr(memory, "after_run", lambda run_id: None)


@pytest.fixture(autouse=True)
def _claude_account_is_empty(monkeypatch, tmp_path_factory):
    """The MCP servers of the machine's own `~/.claude.json`, and the plugins of its `~/.claude`, must not leak into
    a test."""
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path_factory.mktemp("claude-home")))
    monkeypatch.setenv("KANBAN_CLAUDE_HOME", str(tmp_path_factory.mktemp("own-claude")))


@pytest.fixture(autouse=True)
def _workspaces_in_a_temp_folder(monkeypatch, tmp_path_factory):
    """A run makes its ticket's Workspace (issue #269): never in the machine's own home folder."""
    monkeypatch.setenv(
        "KANBAN_WORKSPACE_ROOT", str(tmp_path_factory.mktemp("kanban-workspace"))
    )


@pytest.fixture(autouse=True)
def _app_config_in_a_temp_folder(monkeypatch, tmp_path_factory):
    """App-wide switches (config.json) must never touch the developer's own ~/.kanban-board."""
    import config

    folder = tmp_path_factory.mktemp("app-config")
    monkeypatch.setattr(config, "_CONFIG_DIR", folder)
    monkeypatch.setattr(config, "_CONFIG_FILE", folder / "config.json")
    # A process a test starts (the real MCP server, the AI runner) reads its config folder from the environment. Without
    # this it reads the developer's own config.json, opens the database named there and runs this branch's migrations
    # on it: on 2026-11-05 that emptied the AI tables of a real board. Its log goes to a temp folder too.
    monkeypatch.setenv("KANBAN_CONFIG_DIR", str(folder))
    monkeypatch.setenv("KANBAN_LOG_DIR", str(tmp_path_factory.mktemp("app-logs")))


@pytest.fixture(autouse=True)
def _resource_monitor_starts_empty():
    """The RAM/CPU monitor is process-wide; every test starts without readings, watchers or a running loop."""
    from services.ai import resources

    resources.MON.reset()
    yield
    resources.MON.reset()


@pytest.fixture(autouse=True)
async def _notification_queues_are_per_test():
    """Events queued for the notification log by one test must not be written into the next test's database."""
    import asyncio

    from services import notifications

    notifications._pending.clear()
    notifications._later.clear()
    yield
    if notifications._background:
        await asyncio.gather(*notifications._background, return_exceptions=True)
    notifications._pending.clear()
    notifications._later.clear()


@pytest.fixture(autouse=True)
def _no_marketplace_clones(monkeypatch):
    """Making a member from a pack installs the pack's plugins from their marketplaces: never from a test."""
    from services.ai import packs

    async def nothing(*_a, **_k):
        return {"installed": [], "failed": []}

    monkeypatch.setattr(packs, "install_plugins", nothing)
