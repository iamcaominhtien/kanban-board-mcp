"""RAM and CPU of the AI runs and of the machine (design/screens/ai-resources.md).

One monitor reads every running CLI every 2 s with psutil: the CLI process itself (what the memory limit counts) and
what it started (a test, a build: shown apart, never counted). It keeps a short history per run, the peak and the last
value (saved with the run), sends a snapshot to whoever watches (the Resources tab streams it), and calls back when a
CLI passes the project's memory limit so the run engine can start it again (`runs.py`).

The monitor runs only while a CLI runs or someone watches, so an idle board costs nothing.
"""

import asyncio
import json
import time
from collections import deque
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import psutil
from sqlmodel import col, select

import database
from models import AiRun, AiMember, Member, Ticket

from .store import get_settings, loads

MB = 1024 * 1024
SAMPLE_S = 2.0  # how often every CLI is read
HISTORY_EVERY_S = 5.0  # a history point every 5 s, 60 points = the last 5 minutes
HISTORY_POINTS = 60
SAVE_EVERY_S = 15.0  # how often the peak and last value are written to the run
LIMIT_TTL_S = 10.0  # how long a project's limit is remembered
AUTO_RESTARTS = 2  # restarts by the system before the next breach stops the run
ENDED_SHOWN_S = 600  # an ended run stays in the table for 10 minutes
ACCESS_LEVELS = ("none", "view", "control")

_procs: dict[int, psutil.Process] = {}


def _process(pid: int) -> psutil.Process:
    """A cached Process: `cpu_percent()` measures from the previous call on the same object."""
    proc = _procs.get(pid)
    if proc is None:
        proc = _procs[pid] = psutil.Process(pid)
    return proc


def read_run(pid: int) -> dict | None:
    """{cli_rss_mb, extra_mb, cpu_pct, readable} for a CLI and what it started; None when it is gone.

    `cpu_pct` is of one core (200 = two cores) over the CLI and its children together."""
    try:
        cli = _process(pid)
        rss = cli.memory_info().rss
        cpu = cli.cpu_percent(None)
        extra = 0
        for child in cli.children(recursive=True):
            try:
                kid = _process(child.pid)
                extra += kid.memory_info().rss
                cpu += kid.cpu_percent(None)
            except (psutil.NoSuchProcess, psutil.ZombieProcess):
                _procs.pop(child.pid, None)
            except psutil.AccessDenied:
                continue
    except (psutil.NoSuchProcess, psutil.ZombieProcess):
        _procs.pop(pid, None)
        return None
    except psutil.AccessDenied:
        return {
            "cli_rss_mb": None,
            "extra_mb": None,
            "cpu_pct": None,
            "readable": False,
        }
    return {
        "cli_rss_mb": round(rss / MB, 1),
        "extra_mb": round(extra / MB, 1),
        "cpu_pct": round(cpu, 1),
        "readable": True,
    }


def read_machine() -> dict:
    """RAM and load of the whole machine."""
    mem = psutil.virtual_memory()
    try:
        load1 = round(psutil.getloadavg()[0], 2)
    except (AttributeError, OSError):
        load1 = None
    return {
        "ram_total_mb": round(mem.total / MB),
        "ram_free_mb": round(mem.available / MB),
        "load1": load1,
        "cores": psutil.cpu_count() or 1,
    }


def forget_dead() -> None:
    """Drop cached Process objects whose process is gone (a long-running server meets many pids)."""
    for pid in list(_procs):
        if not psutil.pid_exists(pid):
            _procs.pop(pid, None)


class Monitor:
    """Reads the tracked CLIs, keeps their history and tells watchers and the run engine what it sees."""

    def __init__(self) -> None:
        """Nothing is read until a CLI is tracked or someone subscribes."""
        self.tracked: dict[
            str, tuple[Any, str]
        ] = {}  # run id -> (CliProcess, project id)
        self.readings: dict[str, dict] = {}
        self.history: dict[str, deque] = {}
        self.peak: dict[str, float] = {}
        self.subscribers: dict[str, set[asyncio.Queue]] = {}
        self.on_breach: Callable[[str, float, int], Awaitable[None]] | None = None
        self.task: asyncio.Task | None = None
        self._hist_at: dict[str, float] = {}
        self._saved_at: dict[str, float] = {}
        self._breached: set[str] = set()
        self._limits: dict[str, tuple[float, int]] = {}

    def reset(self) -> None:
        """Forget everything (tests; each starts on its own event loop)."""
        if self.task is not None and not self.task.done():
            self.task.cancel()
        self.task = None
        self.tracked.clear()
        self.readings.clear()
        self.history.clear()
        self.peak.clear()
        self.subscribers.clear()
        self._hist_at.clear()
        self._saved_at.clear()
        self._breached.clear()
        self._limits.clear()

    # --- what is watched -------------------------------------------------

    def track(self, run_id: str, proc: Any, project_id: str) -> None:
        """Start reading a run's CLI (`proc` is a CliProcess); the new CLI after a restart is tracked again."""
        self.tracked[run_id] = (proc, project_id)
        self._breached.discard(run_id)
        self.readings.pop(run_id, None)
        self.ensure_running()

    async def untrack(self, run_id: str) -> None:
        """The CLI ended: save its peak and last value with the run."""
        self.tracked.pop(run_id, None)
        await self.save(run_id)
        self.readings.pop(run_id, None)

    def live(self) -> dict[str, tuple[int, str]]:
        """run id -> (pid, project id) of the CLIs that are running."""
        out = {}
        for run_id, (proc, project_id) in self.tracked.items():
            inner = getattr(proc, "proc", None)
            if inner is not None and inner.returncode is None:
                out[run_id] = (inner.pid, project_id)
        return out

    def ensure_running(self) -> None:
        """Start the reading loop if it is not running."""
        if self.task is None or self.task.done():
            self.task = asyncio.get_running_loop().create_task(self._loop())

    # --- limits ------------------------------------------------------------

    async def limit_mb(self, project_id: str) -> int:
        """The project's memory limit for a run's CLI (0: none), remembered for a few seconds."""
        now = time.monotonic()
        cached = self._limits.get(project_id)
        if cached and now - cached[0] < LIMIT_TTL_S:
            return cached[1]
        async with database.async_session() as session:
            limit = int((await get_settings(session, project_id)).run_memory_limit_mb)
        self._limits[project_id] = (now, limit)
        return limit

    def limit_changed(self, project_id: str) -> None:
        """A person changed the project's limit: use it from the next reading."""
        self._limits.pop(project_id, None)

    # --- the loop ----------------------------------------------------------

    async def _loop(self) -> None:
        try:
            while True:
                live = self.live()
                if not live and not self.subscribers:
                    return
                await self._read_all(live)
                await self._publish()
                await asyncio.sleep(SAMPLE_S)
        except asyncio.CancelledError:
            raise
        finally:
            self.task = None

    async def _read_all(self, live: dict[str, tuple[int, str]]) -> None:
        now = time.monotonic()
        for run_id, (pid, project_id) in live.items():
            reading = await asyncio.to_thread(read_run, pid)
            if reading is None:
                continue
            reading["at"] = datetime.now(UTC).isoformat()
            self.readings[run_id] = reading
            if not reading["readable"]:
                continue
            rss = reading["cli_rss_mb"]
            self.peak[run_id] = max(self.peak.get(run_id, 0.0), rss)
            if now - self._hist_at.get(run_id, 0.0) >= HISTORY_EVERY_S:
                self._hist_at[run_id] = now
                self.history.setdefault(run_id, deque(maxlen=HISTORY_POINTS)).append(
                    {"at": reading["at"], "rss_mb": rss, "cpu_pct": reading["cpu_pct"]}
                )
            if now - self._saved_at.get(run_id, 0.0) >= SAVE_EVERY_S:
                self._saved_at[run_id] = now
                await self.save(run_id)
            limit = await self.limit_mb(project_id)
            if (
                limit > 0
                and rss > limit
                and run_id not in self._breached
                and self.on_breach is not None
            ):
                self._breached.add(run_id)
                await self.on_breach(run_id, rss, limit)
        if len(_procs) > 200:
            await asyncio.to_thread(forget_dead)

    async def save(self, run_id: str) -> None:
        """Write the peak and the last value to the run."""
        reading = self.readings.get(run_id)
        if reading is None or not reading.get("readable"):
            return
        async with database.async_session() as session:
            run = await session.get(AiRun, run_id)
            if run is None:
                return
            run.last_rss_mb = reading["cli_rss_mb"]
            run.peak_rss_mb = max(run.peak_rss_mb or 0.0, self.peak.get(run_id, 0.0))
            session.add(run)
            await session.commit()

    # --- watchers ----------------------------------------------------------

    def subscribe(self, project_id: str) -> asyncio.Queue:
        """A queue that receives the project's snapshot every reading; keeps only the newest."""
        queue: asyncio.Queue = asyncio.Queue(maxsize=1)
        self.subscribers.setdefault(project_id, set()).add(queue)
        self.ensure_running()
        return queue

    def unsubscribe(self, project_id: str, queue: asyncio.Queue) -> None:
        """Stop sending to a queue."""
        queues = self.subscribers.get(project_id)
        if queues is not None:
            queues.discard(queue)
            if not queues:
                self.subscribers.pop(project_id, None)

    async def _publish(self) -> None:
        for project_id, queues in list(self.subscribers.items()):
            snap = await snapshot(project_id)
            for queue in list(queues):
                if queue.full():
                    queue.get_nowait()
                queue.put_nowait(snap)


MON = Monitor()


# ---------------------------------------------------------------------------
# What the API and the MCP tool return
# ---------------------------------------------------------------------------


def restarts_of(run: AiRun) -> list[dict]:
    """The restarts logged on a run: [{at, rss_mb, limit_mb, by, n}]."""
    return [r for r in loads(run.restarts, []) if isinstance(r, dict)]


def _row(run: AiRun, names: dict, colors: dict, tickets: dict, live: bool) -> dict:
    reading = MON.readings.get(run.id) if live else None
    readable = reading is None or reading.get("readable", True)
    peak = (
        max(run.peak_rss_mb or 0.0, MON.peak.get(run.id, 0.0))
        if live
        else run.peak_rss_mb
    )
    return {
        "run_id": run.id,
        "number": run.number,
        "member_id": run.member_id,
        "member_name": names.get(run.member_id),
        "member_color": colors.get(run.member_id),
        "ticket_id": run.ticket_id,
        "ticket_title": tickets.get(run.ticket_id),
        "state": run.state,
        "started_at": run.started_at,
        "ended_at": run.ended_at,
        "live": live,
        "readable": readable,
        "cli_rss_mb": reading["cli_rss_mb"] if reading else run.last_rss_mb,
        "extra_mb": reading["extra_mb"] if reading else None,
        "cpu_pct": reading["cpu_pct"] if reading else None,
        "peak_rss_mb": peak,
        "restarts": restarts_of(run),
        "history": list(MON.history.get(run.id, [])) if live else [],
    }


async def snapshot(project_id: str) -> dict:
    """The Resources tab: the machine, the project's limits, every running run and the recently ended ones."""
    machine = read_machine()
    cutoff = (datetime.now(UTC) - timedelta(seconds=ENDED_SHOWN_S)).isoformat()
    async with database.async_session() as session:
        settings = await get_settings(session, project_id)
        live_ids = [r for r, (_, p) in MON.live().items() if p == project_id]
        active = (
            await session.exec(
                select(AiRun).where(
                    AiRun.project_id == project_id,
                    col(AiRun.state).in_(("starting", "running")),
                )
            )
        ).all()
        ended = (
            await session.exec(
                select(AiRun).where(
                    AiRun.project_id == project_id,
                    col(AiRun.ended_at) >= cutoff,
                    col(AiRun.peak_rss_mb).is_not(None),
                )
            )
        ).all()
        runs = list(active) + [r for r in ended if r.id not in {a.id for a in active}]
        member_ids = {r.member_id for r in runs}
        people = (
            (
                await session.exec(select(Member).where(col(Member.id).in_(member_ids)))
            ).all()
            if member_ids
            else []
        )
        names = {m.id: m.name for m in people}
        colors = {m.id: m.color for m in people}
        ticket_ids = {r.ticket_id for r in runs}
        tickets = (
            {
                t.id: t.title
                for t in (
                    await session.exec(
                        select(Ticket).where(col(Ticket.id).in_(ticket_ids))
                    )
                ).all()
            }
            if ticket_ids
            else {}
        )
    rows = [_row(r, names, colors, tickets, r.id in live_ids) for r in runs]
    rows.sort(key=lambda r: (not r["live"], -(r["cli_rss_mb"] or 0)))
    ai_mb = sum(
        (r["cli_rss_mb"] or 0) + (r["extra_mb"] or 0) for r in rows if r["live"]
    )
    return {
        "at": datetime.now(UTC).isoformat(),
        "machine": {
            **machine,
            "ai_rss_mb": round(ai_mb, 1),
            "cli_count": sum(1 for r in rows if r["live"]),
        },
        "limits": {
            "run_memory_limit_mb": settings.run_memory_limit_mb,
            "auto_restarts": AUTO_RESTARTS,
            "board_max_parallel": settings.board_max_parallel,
        },
        "runs": rows,
    }


def card_view(run: AiRun, limit_mb: int) -> dict | None:
    """What the AI's card in Now shows about a run: the CLI's RAM and CPU now, its peak and its restarts."""
    reading = MON.readings.get(run.id)
    if reading is None and not run.peak_rss_mb:
        return None
    reading = reading or {}
    return {
        "cli_rss_mb": reading.get("cli_rss_mb") if reading else run.last_rss_mb,
        "extra_mb": reading.get("extra_mb"),
        "cpu_pct": reading.get("cpu_pct"),
        "peak_rss_mb": max(run.peak_rss_mb or 0.0, MON.peak.get(run.id, 0.0)) or None,
        "readable": reading.get("readable", True),
        "restarts": len(restarts_of(run)),
        "limit_mb": limit_mb,
    }


def access_of(profile: AiMember | None) -> str:
    """none | view | control for an AI member (a missing or odd value is none)."""
    level = getattr(profile, "resource_access", "none")
    return level if level in ACCESS_LEVELS else "none"


def dump(value: Any) -> str:
    """JSON for the `restarts` column."""
    return json.dumps(value, ensure_ascii=False)
