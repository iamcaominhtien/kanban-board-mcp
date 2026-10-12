"""Persistent application log: rotating file setup and time-range export.

Log lines look like `2026-10-12T10:15:30.123+07:00 ERROR logger.name message`; a
traceback or any other line that does not start with a timestamp belongs to the
record above it, so a range export never cuts a stack trace in half.
"""

import logging
import os
import re
import sys
import threading
from collections.abc import Iterator
from datetime import datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path

LOG_FILE_NAME = "kanban.log"
MAX_BYTES = 5 * 1024 * 1024
BACKUP_COUNT = 5

LEVELS = {"DEBUG": 10, "INFO": 20, "WARNING": 30, "ERROR": 40, "CRITICAL": 50}
_RECORD_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2}T\S+) (DEBUG|INFO|WARNING|ERROR|CRITICAL) "
)

_handler: RotatingFileHandler | None = None


class _IsoFormatter(logging.Formatter):
    """Format records with a millisecond ISO-8601 timestamp that carries the UTC offset."""

    def formatTime(self, record: logging.LogRecord, datefmt: str | None = None) -> str:
        """Return the record time as e.g. `2026-10-12T10:15:30.123+07:00`."""
        dt = datetime.fromtimestamp(record.created).astimezone()
        return dt.isoformat(timespec="milliseconds")


def get_log_dir() -> Path:
    """Return the folder holding the log files (`KANBAN_LOG_DIR`, else `~/.kanban-board/logs`).

    It is deliberately independent of the data folder so the log survives moving or
    importing data, and is still writable when the database cannot be opened.
    """
    env = os.environ.get("KANBAN_LOG_DIR", "").strip()
    return Path(env) if env else Path.home() / ".kanban-board" / "logs"


def get_log_path() -> Path:
    """Return the path of the active log file."""
    return get_log_dir() / LOG_FILE_NAME


def setup_logging() -> None:
    """Send the root logger (app, uvicorn, libraries) and uncaught exceptions to the log file.

    Safe to call more than once. A log folder that cannot be written is not fatal:
    the app keeps running without a file log.
    """
    global _handler
    if _handler is not None:
        return
    try:
        get_log_dir().mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(
            get_log_path(),
            maxBytes=MAX_BYTES,
            backupCount=BACKUP_COUNT,
            encoding="utf-8",
        )
    except OSError:
        logging.getLogger(__name__).warning("Cannot open log file; file logging off")
        return
    handler.setFormatter(
        _IsoFormatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    )
    root = logging.getLogger()
    root.addHandler(handler)
    if root.level == logging.NOTSET or root.level > logging.INFO:
        root.setLevel(logging.INFO)
    _handler = handler

    def _log_uncaught(exc_type, exc, tb) -> None:
        if not issubclass(exc_type, KeyboardInterrupt):
            logging.getLogger("uncaught").critical(
                "Uncaught exception", exc_info=(exc_type, exc, tb)
            )
        sys.__excepthook__(exc_type, exc, tb)

    def _log_thread_uncaught(args: threading.ExceptHookArgs) -> None:
        if args.exc_type is not SystemExit:
            logging.getLogger("uncaught").critical(
                "Uncaught exception in thread %s",
                args.thread.name if args.thread else "?",
                exc_info=(args.exc_type, args.exc_value, args.exc_traceback),
            )

    sys.excepthook = _log_uncaught
    threading.excepthook = _log_thread_uncaught


def _log_files() -> list[Path]:
    """Return existing log files, oldest first (`kanban.log.5` ... `kanban.log`)."""
    base = get_log_path()
    files = [Path(f"{base}.{i}") for i in range(BACKUP_COUNT, 0, -1)] + [base]
    return [f for f in files if f.is_file()]


def aware(dt: datetime) -> datetime:
    """Treat a naive datetime as local time."""
    return dt if dt.tzinfo else dt.astimezone()


def iter_records(
    since: datetime | None = None,
    until: datetime | None = None,
    min_level: str = "DEBUG",
) -> Iterator[str]:
    """Yield log records (each possibly multi-line) within [since, until] at or above min_level.

    Args:
        since: Inclusive start; naive values are local time. None means no lower bound.
        until: Inclusive end; naive values are local time. None means no upper bound.
        min_level: Lowest level to include.

    Raises:
        ValueError: If min_level is not a known level name.
    """
    threshold = LEVELS.get(min_level.upper())
    if threshold is None:
        raise ValueError(f"Unknown level: {min_level}")
    since = aware(since) if since else None
    until = aware(until) if until else None

    for path in _log_files():
        record: list[str] = []
        keep = False

        def flush() -> Iterator[str]:
            if record and keep:
                yield "".join(record)

        try:
            with path.open(encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    match = _RECORD_RE.match(line)
                    if match:
                        yield from flush()
                        record = [line]
                        try:
                            ts = aware(datetime.fromisoformat(match.group(1)))
                        except ValueError:
                            keep = False
                            continue
                        keep = (
                            LEVELS[match.group(2)] >= threshold
                            and (since is None or ts >= since)
                            and (until is None or ts <= until)
                        )
                    elif record:
                        record.append(line)
                yield from flush()
        except OSError:
            continue
