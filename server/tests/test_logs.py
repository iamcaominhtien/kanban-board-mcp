import logging
from datetime import datetime, timezone

import httpx
import pytest
from httpx import ASGITransport

import app_logging
from main import app

UTC = timezone.utc


@pytest.fixture
def log_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("KANBAN_LOG_DIR", str(tmp_path))
    return tmp_path


def _write(log_dir, lines):
    (log_dir / app_logging.LOG_FILE_NAME).write_text("".join(lines), encoding="utf-8")


SAMPLE = [
    "2026-10-12T10:00:00.000+00:00 INFO a started\n",
    "2026-10-12T10:05:00.000+00:00 ERROR a boom\n",
    "Traceback (most recent call last):\n",
    '  File "x.py", line 1\n',
    "ValueError: bad\n",
    "2026-10-12T10:10:00.000+00:00 WARNING b careful\n",
    "2026-10-12T11:00:00.000+00:00 INFO a later\n",
]


def test_range_filter_keeps_traceback_with_its_record(log_dir):
    _write(log_dir, SAMPLE)
    out = "".join(
        app_logging.iter_records(
            datetime(2026, 10, 12, 10, 3, tzinfo=UTC),
            datetime(2026, 10, 12, 10, 30, tzinfo=UTC),
        )
    )
    assert "boom" in out and "ValueError: bad" in out and "careful" in out
    assert "started" not in out and "later" not in out


def test_level_filter(log_dir):
    _write(log_dir, SAMPLE)
    out = "".join(app_logging.iter_records(min_level="ERROR"))
    assert "boom" in out and "ValueError" in out
    assert "careful" not in out and "started" not in out


def test_rotated_files_are_read_oldest_first(log_dir):
    (log_dir / "kanban.log.1").write_text(
        "2026-10-11T09:00:00.000+00:00 INFO old entry\n", encoding="utf-8"
    )
    _write(log_dir, SAMPLE)
    out = list(app_logging.iter_records())
    assert "old entry" in out[0]


def test_unknown_level_raises(log_dir):
    with pytest.raises(ValueError):
        list(app_logging.iter_records(min_level="LOUD"))


def test_setup_logging_writes_formatted_record(log_dir, monkeypatch):
    monkeypatch.setattr(app_logging, "_handler", None)
    root = logging.getLogger()
    before = list(root.handlers)
    app_logging.setup_logging()
    try:
        logging.getLogger("t").error("hello %s", "world")
        app_logging._handler.flush()
        text = app_logging.get_log_path().read_text(encoding="utf-8")
        assert " ERROR t hello world" in text
        assert datetime.fromisoformat(text.split(" ")[0]).tzinfo is not None
    finally:
        for h in list(root.handlers):
            if h not in before:
                root.removeHandler(h)
                h.close()


async def _get(path, **params):
    async with httpx.AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        return await client.get(path, params=params)


async def test_export_endpoint_filters_by_range(log_dir):
    _write(log_dir, SAMPLE)
    res = await _get(
        "/logs/export",
        since="2026-10-12T10:03:00Z",
        until="2026-10-12T10:30:00Z",
        level="INFO",
    )
    assert res.status_code == 200
    assert "attachment" in res.headers["content-disposition"]
    assert "boom" in res.text and "careful" in res.text
    assert "started" not in res.text and "later" not in res.text


async def test_export_endpoint_empty_range(log_dir):
    _write(log_dir, SAMPLE)
    res = await _get("/logs/export", since="2030-01-01T00:00:00Z")
    assert "no log entries" in res.text


async def test_export_endpoint_validates_input(log_dir):
    assert (await _get("/logs/export", since="nope")).status_code == 400
    assert (await _get("/logs/export", level="LOUD")).status_code == 400
    res = await _get(
        "/logs/export", since="2026-10-13T00:00:00Z", until="2026-10-12T00:00:00Z"
    )
    assert res.status_code == 400


def test_stdio_and_server_logs_merge_in_time_order(log_dir):
    _write(log_dir, SAMPLE)
    (log_dir / app_logging.STDIO_LOG_FILE_NAME).write_text(
        "2026-10-12T10:07:00.000+00:00 ERROR stdio:mcp tool failed\n", encoding="utf-8"
    )
    out = list(app_logging.iter_records())
    texts = [r.split(" ", 3)[3].split()[0:2] for r in out]
    assert [r for r in out if "tool failed" in r]
    assert "tool failed" in out[2] and "careful" in out[3]
    assert len(texts) == 5


def test_stdio_setup_writes_prefixed_records_to_own_file(log_dir, monkeypatch):
    monkeypatch.setattr(app_logging, "_handler", None)
    root = logging.getLogger()
    before = list(root.handlers)
    app_logging.setup_logging(stdio=True)
    try:
        logging.getLogger("t").error("oops")
        app_logging._handler.flush()
        text = (log_dir / app_logging.STDIO_LOG_FILE_NAME).read_text(encoding="utf-8")
        assert " ERROR stdio:t oops" in text
        assert not (log_dir / app_logging.LOG_FILE_NAME).exists()
    finally:
        for h in list(root.handlers):
            if h not in before:
                root.removeHandler(h)
                h.close()


async def _post(path, body):
    async with httpx.AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        return await client.post(path, json=body)


async def test_client_log_is_recorded_and_validated(log_dir, caplog):
    with caplog.at_level(logging.WARNING, logger="ui"):
        res = await _post(
            "/logs/client",
            {"level": "error", "message": "TypeError: x", "stack": "at f (a.js:1)"},
        )
    assert res.status_code == 204
    assert "TypeError: x" in caplog.text and "at f (a.js:1)" in caplog.text
    assert (
        await _post("/logs/client", {"level": "info", "message": "m"})
    ).status_code == 422
    assert (await _post("/logs/client", {"message": "x" * 3000})).status_code == 422


async def test_client_log_is_rate_limited(log_dir, monkeypatch):
    import api.logs as logs_api

    monkeypatch.setattr(logs_api, "_client_log_times", [])
    codes = [
        (await _post("/logs/client", {"message": "m"})).status_code for _ in range(62)
    ]
    assert codes[:60] == [204] * 60 and codes[60:] == [429, 429]


async def test_startup_migrations_keep_file_logging(log_dir, tmp_path, monkeypatch):
    """Alembic's fileConfig must not strip the file handler when init_db runs in-process."""
    import database

    monkeypatch.setattr(app_logging, "_handler", None)
    root = logging.getLogger()
    before = list(root.handlers)
    app_logging.setup_logging()
    handler = app_logging._handler
    try:
        url = f"sqlite+aiosqlite:///{tmp_path / 'x.db'}"
        monkeypatch.setattr(database, "DATABASE_URL", url)
        monkeypatch.setattr(database, "engine", database.create_async_engine(url))
        await database.init_db()
        assert handler in root.handlers
        assert not logging.getLogger("kanban.http").disabled
    finally:
        for h in list(root.handlers):
            if h not in before:
                root.removeHandler(h)
                h.close()
