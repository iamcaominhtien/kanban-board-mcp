"""The runner process: `python main.py --runner` (the API starts it with KANBAN_RUNNER=process).

It owns every Claude Code CLI the board runs: the scheduler of `services/ai/runs.py` runs here, steps go to the
database from here, and every board event is sent to the API (`POST /internal/ai/events`) so the people's
browsers hear it. The API tells it what to do with a run through `ai_run_command`. When the API process is gone
the runner stops its CLIs and exits.
"""

import asyncio
import json
import logging
import os
import signal
import sys
import time

logger = logging.getLogger("kanban.runner")

POLL_S = 0.5
PARENT_CHECK_S = 3.0


def _parent_alive(pid: int) -> bool:
    if pid <= 0:
        return True
    try:
        import psutil

        return psutil.pid_exists(pid)
    except ImportError:
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True


class Forwarder:
    """Posts the board's events to the API, and tells it when this process wrote to the database."""

    def __init__(self, board_url: str, token: str):
        """`token` is what the API gave this runner when it started it."""
        self.url = f"{board_url.rstrip('/')}/internal/ai/events"
        self.token = token
        self._client = None
        self._failed_at = 0.0
        self._loop: asyncio.AbstractEventLoop | None = None
        self._wrote: list[float] = []
        self._noting: asyncio.Task | None = None
        self._tickets = (
            False  # a commit wrote a ticket since the last announcement of it
        )

    async def __call__(self, event: str) -> None:
        """Send one event; a failure is logged (at most every 30 s) and dropped."""
        await self._post({"event": event})

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        """The loop `note_write` schedules its posts on."""
        self._loop = loop

    def note_write(self, tables: set[str] | None = None) -> None:
        """A commit of this process wrote (called inside the commit, so it only schedules). The API's database watcher
        would otherwise take it for another app's change and make every window refetch everything: say it was the
        runner's, and when (the watcher matches a commit to its readings by time). Commits while a post is on its way
        are told in one more post.

        A commit that wrote a ticket (a run's closing comment, its question, Pending, the work log) is also announced:
        the windows refetch the tickets (topic `tickets`), as they do for a change made through the API."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        ticket = not tables or "ticket" in tables or "*" in tables
        loop.call_soon_threadsafe(self._kick, time.time(), ticket)

    def _kick(self, at: float, ticket: bool = False) -> None:
        self._wrote.append(at)
        self._tickets = self._tickets or ticket
        if self._noting is None or self._noting.done():
            self._noting = asyncio.get_running_loop().create_task(self._send_notes())

    async def _send_notes(self) -> None:
        while self._wrote or self._tickets:
            times, self._wrote = self._wrote[-500:], []
            if times:
                await self._post({"own_change": True, "at": times})
            if self._tickets:
                self._tickets = False
                await self._post(
                    {"event": json.dumps({"type": "invalidate", "topics": ["tickets"]})}
                )

    async def _post(self, body: dict) -> None:
        import httpx

        if self._client is None:
            self._client = httpx.AsyncClient(timeout=3.0)
        try:
            await self._client.post(
                self.url,
                json=body,
                headers={"X-Kanban-Internal": self.token},
            )
            self._failed_at = 0.0
        except Exception as exc:  # noqa: BLE001 - the API may be restarting; the rows are in the database anyway
            if time.monotonic() - self._failed_at > 30:
                logger.warning("Could not forward an event to the API: %s", exc)
                self._failed_at = time.monotonic()


async def _dispatch(row) -> None:
    from services.ai import runs

    payload = json.loads(row.payload or "{}")
    try:
        if row.command == "cancel":
            await runs.cancel(
                row.run_id,
                by=payload.get("by") or "board",
                reason=payload.get("reason"),
                stop_code=payload.get("stop_code"),
            )
        elif row.command == "restart":
            await runs.restart_run(row.run_id, by=payload.get("by") or "board")
        elif row.command == "message":
            await runs.send_message(
                row.run_id,
                payload.get("text") or "",
                by=payload.get("by") or "board",
                peer=payload.get("peer"),
            )
        elif row.command == "answer":
            await runs.answer(
                row.run_id,
                by=payload.get("by") or "board",
                text=payload.get("text") or "",
            )
        elif row.command == "wake":
            import database
            from services.ai import power

            async with database.async_session() as session:
                await power.after_wake(session)
        elif row.command == "start":
            runs.RT.wake.set()
        else:
            logger.warning("Unknown runner command %s", row.command)
    except runs.RunError as exc:
        logger.info("Command %s on %s did nothing: %s", row.command, row.run_id, exc)
    except Exception:  # noqa: BLE001
        logger.exception("Command %s on %s failed", row.command, row.run_id)


async def poll_commands(once: bool = False) -> int:
    """Take and run the commands the API left; returns how many."""
    import database
    from models import AiRunCommand
    from services.ai.store import now_iso
    from sqlmodel import col, select

    n = 0
    while True:
        async with database.async_session() as session:
            rows = (
                await session.exec(
                    select(AiRunCommand)
                    .where(col(AiRunCommand.taken_at).is_(None))
                    .order_by(col(AiRunCommand.id).asc())
                    .limit(20)
                )
            ).all()
            for row in rows:
                row.taken_at = now_iso()
                session.add(row)
            await session.commit()
            taken = list(rows)
        for row in taken:
            await _dispatch(row)
            n += 1
        if once or not taken:
            return n


async def serve(
    *, board_url: str, token: str, parent_pid: int, stop: asyncio.Event | None = None
) -> None:
    """Run until the parent is gone or `stop` is set."""
    import events as board_events
    from services.ai import runs

    from dbkit import changes

    os.environ["KANBAN_IN_RUNNER"] = "1"
    forwarder = Forwarder(board_url, token)
    forwarder.bind(asyncio.get_running_loop())
    board_events.set_forwarder(forwarder)
    changes.on_write_commit(forwarder.note_write)
    runs.set_board_url(board_url)
    await runs.start_scheduler()
    logger.info("AI runner serving for %s (parent %s)", board_url, parent_pid)
    last_parent = time.monotonic()
    try:
        while not (stop and stop.is_set()):
            try:
                await poll_commands()
            except Exception:  # noqa: BLE001
                logger.exception("Polling the commands failed")
            if time.monotonic() - last_parent >= PARENT_CHECK_S:
                last_parent = time.monotonic()
                if not _parent_alive(parent_pid):
                    logger.info("The API process is gone: stopping")
                    break
            await asyncio.sleep(POLL_S)
    finally:
        await runs.stop_scheduler()


def main() -> None:
    """Entry point of `main.py --runner`."""
    import app_logging

    app_logging.setup_logging()
    # Every event the runner forwards is one HTTP request: httpx's line per request filled the log (tens of thousands
    # a day while the AI works) and cost the disk writes. Its warnings and errors still show.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    board_url = os.environ.get("KANBAN_BOARD_URL") or "http://127.0.0.1:8000"
    token = os.environ.get("KANBAN_INTERNAL_TOKEN") or ""
    parent_pid = int(os.environ.get("KANBAN_PARENT_PID") or "0")
    stop = asyncio.Event()

    async def run() -> None:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, stop.set)
            except (NotImplementedError, RuntimeError):
                pass
        await serve(board_url=board_url, token=token, parent_pid=parent_pid, stop=stop)

    asyncio.run(run())
    sys.exit(0)
