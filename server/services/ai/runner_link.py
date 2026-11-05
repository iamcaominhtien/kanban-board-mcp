"""The API's side of the runner process (AI v2, stage 6).

With `KANBAN_RUNNER=process` the Claude Code CLIs are started and read by a second process (`runner/main.py`), so
the API's event loop never shares its time with a run's stream. The API queues runs (rows) and sends commands
(cancel, message, answer, wake) through `ai_run_command`; the runner sends every board event back over
`POST /internal/ai/events`. With `inprocess` (the tests, a developer's server) `runs` does it all here.
"""

import asyncio
import logging
import os
import secrets
import subprocess
import sys
import time
from pathlib import Path

import config as app_config
import database
from models import AiRunCommand

logger = logging.getLogger("kanban.ai.runner")

TOKEN = secrets.token_urlsafe(24)  # what the runner shows when it posts events back
COMMAND_WAIT_S = 8.0
RESPAWN_LIMIT = 5  # restarts within RESPAWN_WINDOW_S before the board gives up
RESPAWN_WINDOW_S = 600.0

_proc: subprocess.Popen | None = None
_watch: asyncio.Task | None = None
_board_url: str | None = None
_starts: list[float] = []
_log = None


def mode() -> str:
    """`process` or `inprocess`."""
    return (
        "process"
        if os.environ.get("KANBAN_RUNNER", "inprocess").lower() == "process"
        else "inprocess"
    )


def in_runner() -> bool:
    """Is this process the runner itself?"""
    return os.environ.get("KANBAN_IN_RUNNER") == "1"


def _command_line() -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, "--runner"]
    return [
        sys.executable,
        str(Path(__file__).resolve().parents[2] / "main.py"),
        "--runner",
    ]


def _spawn() -> subprocess.Popen:
    global _log
    env = {
        **os.environ,
        "KANBAN_IN_RUNNER": "1",
        "KANBAN_BOARD_URL": _board_url or "",
        "KANBAN_INTERNAL_TOKEN": TOKEN,
        "KANBAN_PARENT_PID": str(os.getpid()),
        "KANBAN_DB_PATH": str(database.get_db_path()),
        # the same config folder as this process, whatever chose it: the runner must open the same database
        "KANBAN_CONFIG_DIR": str(app_config._CONFIG_DIR),
    }
    env.pop("KANBAN_API_SECRET_STDIN", None)
    log_path = database.get_data_dir() / "ai-v2" / "runner.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    _log = open(log_path, "ab")  # noqa: SIM115 - held for the runner's lifetime
    kwargs: dict = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    proc = subprocess.Popen(
        _command_line(),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=_log,
        stderr=subprocess.STDOUT,
        **kwargs,
    )
    _starts.append(time.monotonic())
    logger.info("AI runner started (pid %s)", proc.pid)
    return proc


def ensure_started(board_url: str | None = None) -> bool:
    """Start the runner (once) when the mode asks for it and the board's URL is known."""
    global _proc, _watch, _board_url
    if mode() != "process" or in_runner():
        return False
    if board_url:
        _board_url = board_url
    if not _board_url:
        return False
    if _proc is not None and _proc.poll() is None:
        return True
    try:
        _proc = _spawn()
    except OSError as exc:
        logger.error("The AI runner could not be started: %s", exc)
        return False
    if _watch is None or _watch.done():
        try:
            _watch = asyncio.get_running_loop().create_task(_watch_loop())
        except RuntimeError:
            pass
    return True


async def _watch_loop() -> None:
    global _proc
    while True:
        await asyncio.sleep(5.0)
        if _proc is None:
            return
        if _proc.poll() is None:
            continue
        code = _proc.returncode
        recent = [t for t in _starts if time.monotonic() - t < RESPAWN_WINDOW_S]
        if len(recent) >= RESPAWN_LIMIT:
            logger.error(
                "The AI runner exited (code %s) too often; not starting it again", code
            )
            _proc = None
            return
        logger.warning("The AI runner exited (code %s); starting it again", code)
        try:
            _proc = _spawn()
        except OSError as exc:
            logger.error("The AI runner could not be started again: %s", exc)
            _proc = None
            return


def stop() -> None:
    """The board closes: the runner ends its runs (board_closed) and exits."""
    global _proc, _watch
    if _watch is not None:
        _watch.cancel()
        _watch = None
    if _proc is not None and _proc.poll() is None:
        try:
            _proc.terminate()
            _proc.wait(timeout=15)
        except (OSError, subprocess.TimeoutExpired):
            try:
                _proc.kill()
            except OSError:
                pass
    _proc = None
    if _log is not None:
        try:
            _log.close()
        except OSError:
            pass


def alive() -> bool:
    """Is the runner this process started still running?"""
    return _proc is not None and _proc.poll() is None


def status() -> dict:
    """What `GET /ai/runner` shows."""
    return {
        "mode": mode(),
        "alive": alive(),
        "pid": _proc.pid if _proc else None,
        "starts": len(_starts),
    }


async def command(
    run_id: str, command_name: str, payload: dict | None = None, *, wait: bool = True
) -> AiRunCommand:
    """Ask the runner to do something with a run; with `wait`, until the runner took it (or COMMAND_WAIT_S)."""
    import json

    async with database.async_session() as session:
        row = AiRunCommand(
            run_id=run_id, command=command_name, payload=json.dumps(payload or {})
        )
        session.add(row)
        await session.commit()
        await session.refresh(row)
        row_id = row.id
    if not wait:
        return row
    deadline = time.monotonic() + COMMAND_WAIT_S
    while time.monotonic() < deadline:
        await asyncio.sleep(0.2)
        async with database.async_session() as session:
            row = await session.get(AiRunCommand, row_id)
            if row is not None and row.taken_at:
                return row
    return row
