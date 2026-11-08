"""AI schedules (design/screens/ai-schedules.md, issue #153): an AI team works on a ticket at a set time, once or on
repeat. At the time the board checks that the team can start (paused, budget, runner), then starts a normal run tagged
`schedule`. The run's lead decides what is done and reports (the final JSON report); the board only follows the
run: it stops one that goes over its time limit, starts a crashed one again within the retries, closes the slot with
what the lead reported, and pauses a schedule that failed three times in a row. Defaults fail safe: when unsure, skip
and tell a person (G).

Each planned start is one `AiScheduleRun` row with a unique (schedule, slot) key, so a restart never runs a slot twice.
The loop polls run states instead of hooking into the run engine, which keeps both restart-safe.
"""

from __future__ import annotations

import asyncio
import collections
import itertools
import json
import logging
import time
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy.exc import IntegrityError
from sqlmodel import col, select

import database
import services.activity as svc_activity
from models import (
    AiRun,
    AiSchedule,
    AiScheduleRun,
    Member,
    Ticket,
)

from . import budget
from . import runs as svc_runs
from .store import get_profile, get_settings, loads, now_iso, parse_iso

log = logging.getLogger("kanban.ai.schedules")

DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
DEFAULT_LIMITS = {"stop_after_min": 45, "retries": 1, "max_cost": None}
NOTIFY_EVENTS = ("started", "needs_input", "failed", "finished")
OPEN = ("waiting", "ask", "running")
ENDED = ("passed", "partly", "failed", "skipped", "cancelled")
LATE_AFTER_S = 300  # a start this late counts as catch-up
BUSY_MAX_WAIT_MIN = 30  # slot busy: the run queues, but not longer than this
AUTO_PAUSE_AFTER = 3  # failed runs in a row
TICK_S = 20


async def role_of(session, project_id: str, person: str) -> str:
    """viewer | member | admin; the board's own user acts as an admin."""
    if not person or person == "user":
        return "admin"
    row = (
        await session.exec(
            select(Member).where(
                Member.project_id == project_id,
                Member.name == person,
                Member.kind == "human",
            )
        )
    ).first()
    return row.role if row else "member"


class ScheduleError(ValueError):
    """A schedule cannot be saved or changed; `code` maps to an HTTP status."""

    def __init__(self, code: str, message: str, **extra):
        """Keep the code and extra fields for the error body."""
        super().__init__(message)
        self.code = code
        self.extra = extra


class _Runtime:
    def __init__(self) -> None:
        """State of the scheduler in this process; set up when the module loads."""
        self.task: asyncio.Task | None = None
        self.lock = asyncio.Lock()
        self.asked: set[str] = set()  # runs whose "needs input" was already told
        self.events: collections.deque = collections.deque(maxlen=200)
        # Starts at the clock, so ids keep growing across restarts (clients keep the last id)
        self.seq = itertools.count(int(time.time() * 1000))


RT = _Runtime()


# ---------------------------------------------------------------------------
# Time
# ---------------------------------------------------------------------------


def zone(name: str | None) -> ZoneInfo:
    """The time zone, or ScheduleError."""
    try:
        return ZoneInfo(name or "UTC")
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ScheduleError("invalid", f"Unknown time zone: {name}.") from exc


def _hm(value: str | None) -> tuple[int, int]:
    try:
        h, m = (int(x) for x in (value or "").split(":")[:2])
    except ValueError:
        raise ScheduleError("invalid", f"Time must be HH:MM, not {value!r}.") from None
    if not (0 <= h < 24 and 0 <= m < 60):
        raise ScheduleError("invalid", f"Time must be HH:MM, not {value!r}.")
    return h, m


def tz_label(name: str, at: datetime | None = None) -> str:
    """UTC+7, UTC+5:30, UTC−3, UTC."""
    off = (at or datetime.now(UTC)).astimezone(zone(name)).utcoffset() or timedelta()
    mins = int(off.total_seconds() // 60)
    if not mins:
        return "UTC"
    sign = "+" if mins > 0 else "−"
    h, m = divmod(abs(mins), 60)
    return f"UTC{sign}{h}" + (f":{m:02d}" if m else "")


def _once_at(s: AiSchedule) -> datetime | None:
    if not s.run_at:
        return None
    try:
        local = datetime.fromisoformat(s.run_at)
    except ValueError:
        return None
    if local.tzinfo is None:
        local = local.replace(tzinfo=zone(s.tz))
    return local.astimezone(UTC)


def slots(s: AiSchedule, after: datetime, n: int = 5) -> list[datetime]:
    """The next `n` planned starts after `after` (UTC), honouring the end rule."""
    if s.kind == "once":
        at = _once_at(s)
        return [at] if at and at > after and not s.runs_count else []
    days = {int(d) for d in loads(s.days, [])}
    if not days:
        return []
    tz = zone(s.tz)
    h, m = _hm(s.time)
    out: list[datetime] = []
    first = after.astimezone(tz).date()
    for i in range(0, 400):
        day = first + timedelta(days=i)
        if s.ends == "on_date" and s.ends_on and day.isoformat() > s.ends_on:
            break
        if day.weekday() not in days:
            continue
        at = datetime(day.year, day.month, day.day, h, m, tzinfo=tz).astimezone(UTC)
        if at <= after:
            continue
        if (
            s.ends == "after"
            and s.ends_after
            and s.runs_count + len(out) >= s.ends_after
        ):
            break
        out.append(at)
        if len(out) >= n:
            break
    return out


def _advance(s: AiSchedule, after: datetime, *, end: bool = True) -> None:
    """Plan the next start; with nothing left the schedule ends (`end=False` while its last slot is still open)."""
    nxt = slots(s, after, 1)
    s.next_run_at = nxt[0].isoformat() if nxt else None
    if not nxt and end and s.state == "active":
        s.state = "ended"


def _fmt_day(at: datetime, tz: str) -> str:
    local = at.astimezone(zone(tz))
    return f"{DAY_NAMES[local.weekday()]} {local:%b} {local.day}"


def when_label(s: AiSchedule) -> str:
    """Weekdays at 02:00 · Every Mon, Wed at 22:00 · Once · Wed Oct 30, 23:30."""
    if s.kind == "once":
        at = _once_at(s)
        return (
            f"Once · {_fmt_day(at, s.tz)}, {at.astimezone(zone(s.tz)):%H:%M}"
            if at
            else "Once"
        )
    days = sorted({int(d) for d in loads(s.days, [])})
    if days == [0, 1, 2, 3, 4]:
        head = "Weekdays"
    elif days == list(range(7)):
        head = "Every day"
    elif days == [5, 6]:
        head = "Weekends"
    else:
        head = "Every " + ", ".join(DAY_NAMES[d] for d in days)
    return f"{head} at {s.time}"


def in_words(at: datetime, now: datetime | None = None) -> str:
    """in 6 h 12 m · in 1 d 21 h · in 5 d · 3 h ago."""
    delta = at - (now or datetime.now(UTC))
    past = delta.total_seconds() < 0
    secs = abs(int(delta.total_seconds()))
    d, rem = divmod(secs, 86400)
    h, rem = divmod(rem, 3600)
    m = rem // 60
    if d >= 3:
        text = f"{d} d"
    elif d:
        text = f"{d} d {h} h"
    elif h:
        text = f"{h} h {m} m"
    else:
        text = f"{max(m, 1)} min"
    return f"{text} ago" if past else f"in {text}"


# ---------------------------------------------------------------------------
# Reading a schedule
# ---------------------------------------------------------------------------


def limits_of(s: AiSchedule) -> dict:
    """Run limits with defaults."""
    return {**DEFAULT_LIMITS, **(loads(s.limits, {}) or {})}


async def _names(session, ids) -> dict[str, str]:
    ids = [i for i in set(ids) if i]
    if not ids:
        return {}
    rows = (await session.exec(select(Member).where(col(Member.id).in_(ids)))).all()
    return {m.id: m.name for m in rows}


async def summary_text(session, s: AiSchedule) -> str:
    """The plain-language "In short" line (C)."""
    names = await _names(session, [s.member_id, s.backup_member_id])
    ai = names.get(s.member_id, "The AI")
    tzl = tz_label(s.tz)
    if s.kind == "once":
        at = _once_at(s)
        when = (
            f"On {_fmt_day(at, s.tz)} at {at.astimezone(zone(s.tz)):%H:%M} ({tzl})"
            if at
            else "Once"
        )
    else:
        label = when_label(s)
        label = label[0].lower() + label[1:]
        when = (
            "Every " + label[len("every ") :]
            if label.startswith("every ")
            else f"Every {label}"
        )
        when = when.replace("Every weekdays", "Every weekday").replace(
            "Every weekends", "Every weekend"
        )
        when = when.replace("Every every day", "Every day") + f" ({tzl})"
    parts = [
        f"{when}, {ai} works on {s.ticket_id}.",
        "Its lead decides when the work is done and reports it.",
    ]
    if s.backup_member_id:
        parts.append(
            f"If {ai} is unavailable, {names.get(s.backup_member_id, 'the backup AI')} runs it."
        )
    if s.kind == "repeat" and s.ends == "after" and s.ends_after:
        parts.append(f"It ends after {s.ends_after} runs.")
    elif s.kind == "repeat" and s.ends == "on_date" and s.ends_on:
        parts.append(f"It ends on {s.ends_on}.")
    parts.append("It never moves past Review.")
    return " ".join(parts)


def run_to_dict(r: AiScheduleRun, names: dict[str, str] | None = None) -> dict:
    """One slot for the UI."""
    names = names or {}
    return {
        "id": r.id,
        "schedule_id": r.schedule_id,
        "ticket_id": r.ticket_id,
        "slot_at": r.slot_at,
        "state": r.state,
        "catch_up": r.catch_up,
        "member_id": r.member_id,
        "member_name": names.get(r.member_id or ""),
        "run_ids": loads(r.run_ids, []),
        "attempts": r.attempts,
        "note": r.note,
        "started_at": r.started_at,
        "ended_at": r.ended_at,
        "duration_s": r.duration_s,
        "cost_usd": round(r.cost_usd, 4),
    }


async def to_dict(session, s: AiSchedule, *, last: AiScheduleRun | None = None) -> dict:
    """A schedule for the UI: settings, labels and the last slot."""
    names = await _names(session, [s.member_id, s.backup_member_id])
    ticket = await session.get(Ticket, s.ticket_id)
    _, profile = await get_profile(session, s.member_id)
    nxt = parse_iso(s.next_run_at)
    if last is None:
        last = (
            await session.exec(
                select(AiScheduleRun)
                .where(AiScheduleRun.schedule_id == s.id)
                .order_by(col(AiScheduleRun.slot_at).desc())
                .limit(1)
            )
        ).first()
    return {
        "id": s.id,
        "project_id": s.project_id,
        "ticket_id": s.ticket_id,
        "ticket_title": ticket.title if ticket else None,
        "ticket_status": ticket.status if ticket else None,
        "member_id": s.member_id,
        "member_name": names.get(s.member_id),
        "connection": profile.connection if profile else None,
        "backup_member_id": s.backup_member_id,
        "backup_member_name": names.get(s.backup_member_id or ""),
        "created_by": s.created_by,
        "kind": s.kind,
        "run_at": s.run_at,
        "days": loads(s.days, []),
        "time": s.time,
        "tz": s.tz,
        "tz_label": tz_label(s.tz),
        "ends": s.ends,
        "ends_after": s.ends_after,
        "ends_on": s.ends_on,
        "window_end": s.window_end,
        "limits": limits_of(s),
        "catch_up": s.catch_up,
        "catch_up_hours": s.catch_up_hours,
        "notify": loads(s.notify, []),
        "notify_people": loads(s.notify_people, []),
        "instruction": s.instruction,
        "state": s.state,
        "paused_reason": s.paused_reason,
        "failures_in_row": s.failures_in_row,
        "runs_count": s.runs_count,
        "next_run_at": s.next_run_at,
        "next_in": in_words(nxt) if nxt else None,
        "when": when_label(s),
        "offline_risk": await _offline_risk(session, s, profile),
        "ticket_changed": bool(
            ticket
            and s.ticket_seen_at
            and ticket.updated_at
            and ticket.updated_at > s.ticket_seen_at
        ),
        "last_run": run_to_dict(last, names) if last else None,
        "created_at": s.created_at,
        "updated_at": s.updated_at,
    }


# ---------------------------------------------------------------------------
# Validation and preview
# ---------------------------------------------------------------------------

FIELDS = (
    "ticket_id",
    "member_id",
    "backup_member_id",
    "kind",
    "run_at",
    "days",
    "time",
    "tz",
    "ends",
    "ends_after",
    "ends_on",
    "window_end",
    "limits",
    "catch_up",
    "catch_up_hours",
    "notify",
    "notify_people",
    "instruction",
)
JSON_FIELDS = ("days", "limits", "notify", "notify_people")


def _apply(s: AiSchedule, data: dict) -> None:
    for key in FIELDS:
        if key not in data:
            continue
        value = data[key]
        if key in JSON_FIELDS:
            value = json.dumps(
                value if value is not None else ({} if key == "limits" else [])
            )
        if (
            key in ("backup_member_id", "window_end", "ends_on", "run_at")
            and value == ""
        ):
            value = None
        setattr(s, key, value)


async def availability(
    session, member_id: str | None, project_id: str
) -> tuple[bool, str | None]:
    """Whether the AI can start now (paused, kill switch, connection, budget); the reason when not."""
    if not member_id:
        return False, "No AI chosen"
    member, profile = await get_profile(session, member_id)
    if member is None or profile is None or member.kind != "ai":
        return False, "The AI member was removed"
    settings = await get_settings(session, project_id)
    if settings.paused_all:
        return False, "AI is paused for this project"
    if profile.paused:
        return False, f"{member.name} is paused"
    if profile.health in (
        "key_invalid",
        "not_logged_in",
        "runner_missing",
        "model_retired",
    ):
        return False, {
            "key_invalid": f"{member.name}: API key invalid",
            "not_logged_in": f"{member.name}: CLI not logged in",
            "runner_missing": f"{member.name}: runner offline",
            "model_retired": f"{member.name}: model retired",
        }[profile.health]
    over = await budget.blocked(session, profile, settings, "schedule")
    if over:
        return False, f"{member.name} is over its budget ({over[1]})"
    return True, None


async def _slots_in_use(session, member_id: str) -> int:
    return len(
        (
            await session.exec(
                select(AiRun).where(
                    AiRun.member_id == member_id,
                    col(AiRun.state).in_(["starting", "running"]),
                )
            )
        ).all()
    )


async def _running_tickets(
    session, member_id: str, states: list[str] | None = None
) -> list[str]:
    """The tickets an AI has runs on, in the given run states (default: working now)."""
    rows = (
        await session.exec(
            select(AiRun).where(
                AiRun.member_id == member_id,
                col(AiRun.state).in_(states or ["starting", "running"]),
            )
        )
    ).all()
    return [r.ticket_id for r in rows]


async def assess(
    session, s: AiSchedule, by: str, *, now: datetime | None = None
) -> list[dict]:
    """Problems and confirmations shown beside the editor (C "Checks", F). `level`: ok | warn | error."""
    now = now or datetime.now(UTC)
    out: list[dict] = []

    def add(level: str, text: str, key: str = "") -> None:
        out.append({"level": level, "text": text, "key": key})

    ticket = await session.get(Ticket, s.ticket_id) if s.ticket_id else None
    if ticket is None or ticket.project_id != s.project_id:
        add("error", "Pick a ticket of this project.", "ticket")
    elif ticket.status in ("done", "wont_do"):
        add(
            "error",
            f"{ticket.id} is {'Done' if ticket.status == 'done' else 'Won’t Do'}: a schedule needs an open ticket.",
            "ticket",
        )
    member, profile = (
        await get_profile(session, s.member_id) if s.member_id else (None, None)
    )
    if (
        member is None
        or profile is None
        or member.project_id != s.project_id
        or member.kind != "ai"
    ):
        add("error", "Pick an AI member of this project.", "member")
    else:
        if profile.connection == "inbox":
            add(
                "error",
                f"{member.name} has an inbox only: the board cannot start it at a set time.",
                "member",
            )
        role = await role_of(session, s.project_id, by)
        if role == "viewer":
            add(
                "error",
                f"You cannot schedule {member.name}. Ask an owner for permission to assign it.",
                "member",
            )
        elif ticket is not None:
            add("ok", f"You may assign this AI to {ticket.id}", "permission")
        ok, why = await availability(session, s.member_id, s.project_id)
        busy = await _slots_in_use(session, s.member_id)
        free = max(0, profile.max_parallel - busy)
        if ok and free == 0:
            # F "Slot busy": the run waits in the queue, but only so long
            running = await _running_tickets(session, s.member_id)
            ahead = len(await _running_tickets(session, s.member_id, ["queued"]))
            add(
                "warn",
                f"{member.name} has no free slot. "
                + (f"{', '.join(running[:2])} is running. " if running else "")
                + f"This run queues at position #{ahead + 1} and starts when a slot frees. "
                f"Max wait {BUSY_MAX_WAIT_MIN} min, then it is skipped.",
                "runner",
            )
        elif ok:
            what = (
                "Runner online now"
                if profile.connection == "local"
                else "Connected now"
            )
            add(
                "ok",
                f"{what}, {free} of {profile.max_parallel} slot{'s' if profile.max_parallel != 1 else ''} free",
                "runner",
            )
        else:
            add(
                "warn",
                f"{why}. At the time it {'runs on the backup AI' if s.backup_member_id else 'follows the catch-up rule'}.",
                "runner",
            )
        if profile.connection == "local":
            if s.catch_up == "run":
                add(
                    "warn",
                    f"Local runners run only while the board app is open. Catch-up is on ({s.catch_up_hours:g} h).",
                    "local",
                )
            else:
                add(
                    "warn",
                    "Local runners run only while the board app is open. If it is closed at the time, the run is skipped.",
                    "local",
                )
    if s.backup_member_id:
        if s.backup_member_id == s.member_id:
            add("error", "The backup AI must be a different AI.", "backup")
        else:
            bm, bp = await get_profile(session, s.backup_member_id)
            if (
                bm is None
                or bp is None
                or bm.project_id != s.project_id
                or bp.connection == "inbox"
            ):
                add(
                    "error",
                    "The backup AI must be an AI member of this project the board can start.",
                    "backup",
                )
    lim = limits_of(s)
    if not 5 <= int(lim.get("stop_after_min") or 0) <= 600:
        add("error", "Stop after must be 5 to 600 minutes.", "limits")
    if not 0 <= int(lim.get("retries") or 0) <= 3:
        add("error", "Retries must be 0 to 3.", "limits")
    if s.catch_up not in ("run", "skip", "ask"):
        add("error", "Pick what happens when it cannot run on time.", "catch_up")
    if not 0 < float(s.catch_up_hours or 0) <= 24:
        add("error", "Catch-up must be up to 24 hours.", "catch_up")
    try:
        zone(s.tz)
        if s.kind == "once":
            at = _once_at(s)
            if at is None:
                add("error", "Pick the date and time.", "when")
            elif now < at <= now + timedelta(minutes=1):
                add(
                    "error",
                    "That is less than a minute away. Pick a later time, or use Run now.",
                    "when",
                )
            elif at <= now:
                local = at.astimezone(zone(s.tz))
                nxt = datetime.combine(
                    now.astimezone(zone(s.tz)).date(), local.timetz()
                )
                while nxt.astimezone(UTC) <= now:
                    nxt += timedelta(days=1)
                add(
                    "error",
                    f"That time has passed. Next free time: {_fmt_day(nxt, s.tz)}, {nxt:%H:%M}.",
                    "when",
                )
        elif s.kind == "repeat":
            _hm(s.time)
            if not loads(s.days, []):
                add("error", "Pick at least one day.", "when")
            if s.ends == "after" and not (s.ends_after and s.ends_after > 0):
                add("error", "Enter how many runs.", "ends")
            if s.ends == "on_date" and not s.ends_on:
                add("error", "Pick the end date.", "ends")
        else:
            add("error", "kind must be once or repeat.", "when")
        if s.window_end:
            _hm(s.window_end)
    except ScheduleError as exc:
        add("error", str(exc), "when")
    if (
        not any(o["level"] == "error" and o["key"] in ("when", "ends") for o in out)
        and member is not None
    ):
        out.extend(await _overlaps(session, s, now))
        out.extend(await _offline_history(session, s))
    return out


async def _overlaps(session, s: AiSchedule, now: datetime) -> list[dict]:
    mine = slots(s, now, 10)
    if not mine:
        return []
    others = (
        await session.exec(
            select(AiSchedule).where(
                AiSchedule.project_id == s.project_id,
                AiSchedule.member_id == s.member_id,
                AiSchedule.state == "active",
                AiSchedule.id != (s.id or ""),
            )
        )
    ).all()
    out = []
    for o in others:
        for at in slots(o, now, 10):
            if any(abs((at - m).total_seconds()) < 3600 for m in mine):
                local = at.astimezone(zone(s.tz))
                out.append(
                    {
                        "level": "warn",
                        "text": f"{o.ticket_id} is scheduled for the same AI at {local:%H:%M} on "
                        f"{DAY_NAMES[local.weekday()]}. It will queue.",
                        "key": "overlap",
                    }
                )
                break
    return out[:3]


async def _offline_risk(session, s: AiSchedule, profile) -> str | None:
    """B1 "Runner often offline at 02:00" under the next run: a local runner that missed two of its last six slots."""
    if s.state != "active" or profile is None or profile.connection != "local":
        return None
    if not await _offline_history(session, s):
        return None
    at = s.time if s.kind == "repeat" else (s.run_at or "")[11:16]
    return f"Runner often offline at {at}" if at else "Runner is often offline"


async def _offline_history(session, s: AiSchedule) -> list[dict]:
    rows = (
        await session.exec(
            select(AiScheduleRun)
            .where(AiScheduleRun.member_id == s.member_id)
            .order_by(col(AiScheduleRun.slot_at).desc())
            .limit(6)
        )
    ).all()
    missed = [
        r
        for r in rows
        if r.catch_up or (r.state == "skipped" and "offline" in (r.note or ""))
    ]
    if len(missed) >= 2:
        return [
            {
                "level": "warn",
                "text": f"The runner was offline for {len(missed)} of its last {len(rows)} scheduled runs."
                + (
                    f" Catch-up is on ({s.catch_up_hours:g} h)."
                    if s.catch_up == "run"
                    else ""
                ),
                "key": "offline",
            }
        ]
    return []


async def preview(
    session, project_id: str, data: dict, by: str, schedule_id: str | None = None
) -> dict:
    """Summary, next 5 runs and checks for the editor, without saving."""
    s = AiSchedule(project_id=project_id, ticket_id="", member_id="", created_by=by)
    if schedule_id:
        existing = await session.get(AiSchedule, schedule_id)
        if existing:
            s = AiSchedule(**existing.model_dump())
    s.id = schedule_id or ""
    _apply(s, data)
    now = datetime.now(UTC)
    checks = await assess(session, s, by, now=now)
    nxt: list[dict] = []
    summary = ""
    if not any(c["level"] == "error" and c["key"] in ("when", "ends") for c in checks):
        for at in slots(s, now, 5):
            local = at.astimezone(zone(s.tz))
            nxt.append(
                {
                    "at": at.isoformat(),
                    "day": f"{DAY_NAMES[local.weekday()]} {local.day}",
                    "time": f"{local:%H:%M}",
                    "in": in_words(at, now),
                }
            )
        if s.member_id and s.ticket_id:
            summary = await summary_text(session, s)
    return {"summary": summary, "next_runs": nxt, "checks": checks}


# ---------------------------------------------------------------------------
# Create, change, pause
# ---------------------------------------------------------------------------


async def _may_manage(session, s: AiSchedule, by: str) -> None:
    if by == s.created_by:
        return
    if await role_of(session, s.project_id, by) == "admin":
        return
    raise ScheduleError(
        "forbidden",
        f"Only {s.created_by} (who made it) or an admin can change this schedule.",
    )


async def create(session, project_id: str, data: dict, by: str) -> AiSchedule:
    """Validate and save; the first run is planned at once."""
    s = AiSchedule(project_id=project_id, ticket_id="", member_id="", created_by=by)
    _apply(s, data)
    problems = [c for c in await assess(session, s, by) if c["level"] == "error"]
    if problems:
        raise ScheduleError("invalid", problems[0]["text"], problems=problems)
    ticket = await session.get(Ticket, s.ticket_id)
    s.ticket_seen_at = ticket.updated_at if ticket else None
    _advance(s, datetime.now(UTC))
    session.add(s)
    await session.commit()
    await session.refresh(s)
    await _activity(
        s.ticket_id,
        f"created a schedule for {s.ticket_id}: {when_label(s)[0].lower() + when_label(s)[1:]}",
        by,
    )
    await _publish_board()
    return s


async def update(session, schedule_id: str, data: dict, by: str) -> AiSchedule:
    """Change settings; the next run is re-planned."""
    s = await get_or_404(session, schedule_id)
    await _may_manage(session, s, by)
    if "ticket_id" in data and data["ticket_id"] != s.ticket_id:
        raise ScheduleError(
            "invalid",
            "A schedule stays on its ticket. Make a new one for another ticket.",
        )
    _apply(s, data)
    problems = [c for c in await assess(session, s, by) if c["level"] == "error"]
    if problems:
        raise ScheduleError("invalid", problems[0]["text"], problems=problems)
    ticket = await session.get(Ticket, s.ticket_id)
    s.ticket_seen_at = ticket.updated_at if ticket else None
    s.updated_at = now_iso()
    if s.state == "ended":
        s.state = "active"
    if s.state == "active":
        _advance(s, datetime.now(UTC))
    session.add(s)
    await session.commit()
    await session.refresh(s)
    await _publish_board()
    return s


async def set_paused(
    session, schedule_id: str, paused: bool, by: str, reason: str | None = None
) -> AiSchedule:
    """Pause or resume; resuming clears the failure count and plans the next run from now."""
    s = await get_or_404(session, schedule_id)
    await _may_manage(session, s, by)
    if paused:
        s.state = "paused"
        s.paused_reason = reason or f"Paused by {by}"
    else:
        if s.state == "ended":
            raise ScheduleError(
                "invalid", "This schedule has ended. Edit it to plan new runs."
            )
        s.state = "active"
        s.paused_reason = None
        s.failures_in_row = 0
        _advance(s, datetime.now(UTC))
    s.updated_at = now_iso()
    session.add(s)
    await session.commit()
    await session.refresh(s)
    await _publish_board()
    return s


async def delete(session, schedule_id: str, by: str) -> None:
    """Delete the schedule and its history; a run in progress keeps going as a normal run."""
    s = await get_or_404(session, schedule_id)
    await _may_manage(session, s, by)
    for r in (
        await session.exec(
            select(AiScheduleRun).where(AiScheduleRun.schedule_id == s.id)
        )
    ).all():
        await session.delete(r)
    await session.delete(s)
    await session.commit()
    await _activity(s.ticket_id, f"deleted the schedule for {s.ticket_id}", by)
    await _publish_board()


async def get_or_404(session, schedule_id: str) -> AiSchedule:
    """The schedule, or ScheduleError not_found."""
    s = await session.get(AiSchedule, schedule_id)
    if s is None:
        raise ScheduleError("not_found", "Schedule not found.")
    return s


async def run_now(session, schedule_id: str, by: str) -> AiScheduleRun:
    """Start a slot now, outside the plan (does not move the next planned run)."""
    s = await get_or_404(session, schedule_id)
    await _may_manage(session, s, by)
    busy = (
        await session.exec(
            select(AiScheduleRun).where(
                AiScheduleRun.schedule_id == s.id, col(AiScheduleRun.state).in_(OPEN)
            )
        )
    ).first()
    if busy:
        raise ScheduleError("conflict", "The last run of this schedule is still going.")
    srun = AiScheduleRun(
        schedule_id=s.id,
        project_id=s.project_id,
        ticket_id=s.ticket_id,
        slot_at=datetime.now(UTC).isoformat(),
    )
    session.add(srun)
    await session.commit()
    await session.refresh(srun)
    await _try_start(srun.id, manual=True)
    await session.refresh(srun)
    return srun


async def slot_action(
    session, srun_id: str, action: str, by: str, member_id: str | None = None
) -> AiScheduleRun:
    """A person answers a waiting slot: run it late, skip it, or run it on another AI."""
    srun = await session.get(AiScheduleRun, srun_id)
    if srun is None:
        raise ScheduleError("not_found", "Scheduled run not found.")
    s = await get_or_404(session, srun.schedule_id)
    await _may_manage(session, s, by)
    if srun.state not in ("waiting", "ask"):
        raise ScheduleError("conflict", "This run is not waiting any more.")
    if action == "skip":
        await _close(srun.id, "skipped", f"Skipped by {by}.")
    elif action in ("start", "use_member"):
        await _try_start(srun.id, manual=True, member_id=member_id)
    else:
        raise ScheduleError("invalid", "action must be start, skip or use_member.")
    await session.refresh(srun)
    return srun


# ---------------------------------------------------------------------------
# Listing
# ---------------------------------------------------------------------------


async def list_for(session, project_id: str, *, ticket_id: str | None = None) -> dict:
    """Schedules with their last slot, counts for the tab filters and the next-24 h badge."""
    stmt = select(AiSchedule).where(AiSchedule.project_id == project_id)
    if ticket_id:
        stmt = stmt.where(AiSchedule.ticket_id == ticket_id)
    rows = (await session.exec(stmt)).all()
    items = [await to_dict(session, s) for s in rows]
    items.sort(key=lambda d: (d["state"] != "active", d["next_run_at"] or "9999"))
    now = datetime.now(UTC)
    soon = sum(
        1
        for s in rows
        if s.state == "active"
        and (at := parse_iso(s.next_run_at))
        and at - now <= timedelta(hours=24)
    )
    hist = (
        await session.exec(
            select(AiScheduleRun).where(
                AiScheduleRun.project_id == project_id,
                col(AiScheduleRun.state).in_(ENDED),
            )
        )
    ).all()
    return {
        "items": items,
        "next24h": soon,
        "counts": {
            "upcoming": sum(1 for s in rows if s.state == "active"),
            "paused": sum(1 for s in rows if s.state == "paused"),
            "ended": sum(1 for s in rows if s.state == "ended"),
            "history": len(hist),
        },
    }


async def history(
    session, project_id: str, *, schedule_id: str | None = None, limit: int = 50
) -> list[dict]:
    """Ended and open slots, newest first."""
    stmt = select(AiScheduleRun).where(AiScheduleRun.project_id == project_id)
    if schedule_id:
        stmt = stmt.where(AiScheduleRun.schedule_id == schedule_id)
    rows = (
        await session.exec(
            stmt.order_by(col(AiScheduleRun.slot_at).desc()).limit(limit)
        )
    ).all()
    names = await _names(session, [r.member_id for r in rows])
    return [run_to_dict(r, names) for r in rows]


async def detail(session, schedule_id: str) -> dict:
    """One schedule: settings, stats over the last runs and the run history (D)."""
    s = await get_or_404(session, schedule_id)
    out = await to_dict(session, s)
    runs = await history(session, s.project_id, schedule_id=s.id, limit=100)
    ended = [r for r in runs if r["state"] in ENDED and r["state"] != "skipped"]
    timed = [r["duration_s"] for r in ended if r["duration_s"]]
    out["stats"] = {
        "passed": sum(1 for r in ended if r["state"] == "passed"),
        "of": len(ended),
        "avg_s": int(sum(timed) / len(timed)) if timed else None,
        "cost": round(sum(r["cost_usd"] for r in runs), 4),
        "metered": out["connection"] == "api_key",
    }
    out["runs"] = runs
    out["summary"] = await summary_text(session, s)
    # a one-off whose time has come is being run (or waits for its AI): "that time has passed" is for the editor
    out["problems"] = (
        [
            c
            for c in await assess(session, s, s.created_by)
            if c["level"] != "ok" and not (s.kind == "once" and c["key"] == "when")
        ]
        if s.state != "ended"
        else []
    )
    return out


async def week(session, project_id: str, start: datetime, days: int = 7) -> dict:
    """Planned runs per AI in a range (B2): overlaps (will queue) and offline risk."""
    end = start + timedelta(days=days)
    rows = (
        await session.exec(
            select(AiSchedule).where(
                AiSchedule.project_id == project_id,
                col(AiSchedule.state).in_(["active", "paused"]),
            )
        )
    ).all()
    items: list[dict] = []
    for s in rows:
        base = AiSchedule(**s.model_dump())
        for at in slots(base, start - timedelta(seconds=1), 50):
            if at >= end:
                break
            items.append(
                {
                    "schedule_id": s.id,
                    "ticket_id": s.ticket_id,
                    "member_id": s.member_id,
                    "at": at.isoformat(),
                    "kind": "run",
                    "paused": s.state == "paused",
                }
            )
    past = (
        await session.exec(
            select(AiScheduleRun).where(
                AiScheduleRun.project_id == project_id,
                AiScheduleRun.slot_at >= start.isoformat(),
                AiScheduleRun.slot_at < end.isoformat(),
            )
        )
    ).all()
    for r in past:
        items.append(
            {
                "schedule_id": r.schedule_id,
                "ticket_id": r.ticket_id,
                "member_id": r.member_id,
                "at": r.slot_at,
                "kind": "past",
                "state": r.state,
                "paused": False,
            }
        )
    members: dict[str, dict] = {}
    for mid in {i["member_id"] for i in items if i["member_id"]}:
        m, p = await get_profile(session, mid)
        ok, why = await availability(session, mid, project_id)
        members[mid] = {
            "id": mid,
            "name": m.name if m else "Removed AI",
            "connection": p.connection if p else None,
            "max_parallel": p.max_parallel if p else 1,
            "available": ok,
            "reason": why,
        }
    by_member: dict[str, list[dict]] = collections.defaultdict(list)
    for i in items:
        if i["kind"] == "run" and not i["paused"]:
            by_member[i["member_id"]].append(i)
    for mid, lst in by_member.items():
        lst.sort(key=lambda i: i["at"])
        cap = members.get(mid, {}).get("max_parallel", 1)
        for i, it in enumerate(lst):
            at = parse_iso(it["at"])
            near = [
                o
                for o in lst
                if o is not it and abs((parse_iso(o["at"]) - at).total_seconds()) < 3600
            ]
            if len(near) >= cap and any(o["at"] < it["at"] for o in near):
                it["overlap"] = True
            if (
                members.get(mid, {}).get("connection") == "local"
                and not members[mid]["available"]
            ):
                it["risk"] = "Runner offline?"
    items.sort(key=lambda i: i["at"])
    return {
        "start": start.isoformat(),
        "days": days,
        "items": items,
        "members": list(members.values()),
    }


# ---------------------------------------------------------------------------
# Notifications and activity
# ---------------------------------------------------------------------------


def _notify(s: AiSchedule, event: str, text: str, **extra) -> None:
    """A schedule event: the notification centre's log (for the people the schedule names), and the schedule's own
    feed. A run that needs input or fails is told by the run itself; a slot that ends is told here."""
    if event not in loads(s.notify, list(NOTIFY_EVENTS)):
        return
    if event == "started":
        from services import notifications as centre

        # design E4 "KAN-151 run started by schedule · Open run": a line for information, grouped when several start
        centre.enqueue(
            "schedule_started",
            project_id=s.project_id,
            names=[s.created_by, *loads(s.notify_people, [])],
            title=text,
            target_kind="run",
            target_id=extra.get("run_id"),
            ticket_id=s.ticket_id,
            follow_ticket=s.ticket_id,
            member_id=s.member_id,
            data={
                "schedule_id": s.id,
                "event": "started",
                "action": extra.get("action"),
            },
        )
    if event not in ("started", "needs_input"):
        from services import notifications as centre

        # a skipped slot is news, not work: it is told under the information kind, whichever switch let it through
        needs = event == "failed" and not extra.get("skipped")
        centre.enqueue(
            "run_failed" if needs else "schedule",
            project_id=s.project_id,
            names=[s.created_by, *loads(s.notify_people, [])],
            title=text,
            body=extra.get("note") or "",
            target_kind="schedule_run" if extra.get("srun_id") else "run",
            target_id=extra.get("srun_id") or extra.get("run_id"),
            ticket_id=s.ticket_id,
            follow_ticket=s.ticket_id,
            member_id=s.member_id,
            data={
                "schedule_id": s.id,
                "event": "skipped" if extra.get("skipped") else event,
                "action": extra.get("action"),
            },
        )
    RT.events.append(
        {
            "id": next(RT.seq),
            "at": now_iso(),
            "project_id": s.project_id,
            "schedule_id": s.id,
            "ticket_id": s.ticket_id,
            "event": event,
            "text": text,
            "to": [s.created_by, *loads(s.notify_people, [])],
            **extra,
        }
    )


def events_since(project_id: str, after: int = 0) -> list[dict]:
    """Toasts for the UI (E4): the client keeps the last id it showed."""
    return [e for e in RT.events if e["project_id"] == project_id and e["id"] > after]


async def _activity(
    ticket_id: str, text: str, actor: str, *, ai: dict | None = None
) -> None:
    """One Activity entry on the ticket: "<actor> <text>"."""
    async with database.async_session() as session:
        ticket = await session.get(Ticket, ticket_id)
        if ticket is None:
            return
        token = svc_activity.set_ai(ai) if ai else None
        try:
            svc_activity.record(ticket, "ai_schedule", None, text, actor=actor)
        finally:
            if token is not None:
                svc_activity.reset_ai(token)
        session.add(ticket)
        await session.commit()


# ---------------------------------------------------------------------------
# The loop
# ---------------------------------------------------------------------------


def start_scheduler() -> None:
    """Start the schedule loop (called from the app lifespan)."""
    if RT.task is None or RT.task.done():
        RT.task = asyncio.create_task(_loop())


async def stop_scheduler() -> None:
    """Stop the loop."""
    for t in [RT.task]:
        if t and not t.done():
            t.cancel()
            try:
                await t
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
    RT.task = None


async def _loop() -> None:
    while True:
        try:
            await tick()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("Schedule tick failed")
        await asyncio.sleep(TICK_S)


async def tick(now: datetime | None = None) -> None:
    """Open due slots, retry waiting ones, follow running ones."""
    async with RT.lock:
        now = now or datetime.now(UTC)
        async with database.async_session() as session:
            due = (
                await session.exec(
                    select(AiSchedule).where(
                        AiSchedule.state == "active",
                        col(AiSchedule.next_run_at).is_not(None),
                        AiSchedule.next_run_at <= now.isoformat(),
                    )
                )
            ).all()
            opened: list[str] = []
            for s in due:
                slot = s.next_run_at
                srun = AiScheduleRun(
                    schedule_id=s.id,
                    project_id=s.project_id,
                    ticket_id=s.ticket_id,
                    slot_at=slot,
                )
                session.add(srun)
                s.runs_count += 1
                _advance(s, parse_iso(slot), end=False)
                session.add(s)
                try:
                    await session.commit()
                except IntegrityError:
                    await (
                        session.rollback()
                    )  # this slot already started (restart): only move on
                    s = await session.get(AiSchedule, s.id)
                    _advance(s, parse_iso(slot), end=False)
                    session.add(s)
                    await session.commit()
                    continue
                opened.append(srun.id)
            open_rows = (
                await session.exec(
                    select(AiScheduleRun).where(col(AiScheduleRun.state).in_(OPEN))
                )
            ).all()
            follow = [(r.id, r.state) for r in open_rows]
        for sid in opened:
            await _try_start(sid, now=now)
        for sid, state in follow:
            if sid in opened:
                continue
            if state in ("waiting", "ask"):
                await _try_start(sid, now=now)
            elif state == "running":
                await _follow(sid, now)


def _deadline(s: AiSchedule, slot: datetime) -> datetime:
    """The latest a slot may start: the catch-up time, or the allowed window's end when set."""
    end = slot + timedelta(hours=float(s.catch_up_hours or 2))
    if s.window_end:
        h, m = _hm(s.window_end)
        local = slot.astimezone(zone(s.tz))
        w = local.replace(hour=h, minute=m, second=0, microsecond=0)
        if w <= local:
            w += timedelta(days=1)
        end = w.astimezone(UTC)
    return end


def _instruction(s: AiSchedule, extra: str = "") -> str:
    lines = [f"This is a scheduled run (schedule by {s.created_by})."]
    if s.instruction.strip():
        lines.append(s.instruction.strip())
    if extra:
        lines.append(extra)
    lines.append(
        "You decide when the work is done; say in your final report what was done and what was not. Do not move the "
        "ticket past Review."
    )
    return "\n\n".join(lines)


async def _try_start(
    srun_id: str,
    *,
    now: datetime | None = None,
    manual: bool = False,
    member_id: str | None = None,
) -> None:
    """Start the slot's run when the AI can; otherwise wait, use the backup, ask or skip per the catch-up rule."""
    now = now or datetime.now(UTC)
    async with database.async_session() as session:
        srun = await session.get(AiScheduleRun, srun_id)
        if srun is None or srun.state not in ("waiting", "ask"):
            return
        s = await session.get(AiSchedule, srun.schedule_id)
        if s is None:
            return
        slot = parse_iso(srun.slot_at) or now
        ticket = await session.get(Ticket, s.ticket_id)
    if ticket is None:
        return await _close(
            srun_id, "skipped", "Skipped: the ticket was deleted.", end_schedule=True
        )
    if s.state == "paused" and not manual:
        # a slot already waiting when the schedule was paused does not start behind the person's back
        return await _close(srun_id, "skipped", "Skipped: the schedule is paused.")
    if ticket.status in ("done", "wont_do"):
        label = "Done" if ticket.status == "done" else "Won’t Do"
        return await _close(srun_id, "skipped", f"Skipped: {ticket.id} is {label}.")
    async with database.async_session() as session:
        if await role_of(session, s.project_id, s.created_by) == "viewer":
            await set_paused(
                session,
                s.id,
                True,
                s.created_by,
                reason=f"{s.created_by} lost permission to assign this AI",
            )
            return await _close(
                srun_id,
                "skipped",
                "Skipped: the creator lost permission. The schedule is paused.",
            )
        prev = (
            await session.exec(
                select(AiScheduleRun).where(
                    AiScheduleRun.schedule_id == s.id,
                    AiScheduleRun.id != srun_id,
                    AiScheduleRun.state == "running",
                )
            )
        ).first()
    if prev:
        return await _close(
            srun_id, "skipped", "Skipped: the last run of this schedule is still going."
        )
    chosen: str | None = None
    why: str | None = None
    async with database.async_session() as session:
        candidates = [member_id] if member_id else [s.member_id, s.backup_member_id]
        for mid in [c for c in candidates if c]:
            ok, reason = await availability(session, mid, s.project_id)
            if ok:
                chosen = mid
                break
            why = why or reason
    deadline = _deadline(s, slot)
    if chosen is None:
        if not manual and now > deadline:
            return await _close(
                srun_id,
                "skipped",
                f"Skipped: {why} for more than {s.catch_up_hours:g} hours. {s.created_by} was told.",
                notify="failed",
            )
        if s.catch_up == "skip" and not manual:
            return await _close(
                srun_id,
                "skipped",
                f"Skipped: {why}. {s.created_by} was told.",
                notify="failed",
            )
        state = "ask" if s.catch_up == "ask" else "waiting"
        until = deadline.astimezone(zone(s.tz)).strftime("%H:%M")
        note = (
            f"Waiting: {why}. Starts when it is back, until {until}. Then it is skipped."
            if state == "waiting"
            else f"{why}. Run it late?"
        )
        await _set(srun_id, state=state, note=note)
        if manual:
            raise ScheduleError("unavailable", f"{why}.")
        return
    if (
        s.catch_up == "ask"
        and not manual
        and (now - slot).total_seconds() > LATE_AFTER_S
        and now <= deadline
    ):
        await _set(srun_id, state="ask", note="The run is late. Run it now?")
        return
    if not manual and now > deadline:
        return await _close(
            srun_id,
            "skipped",
            f"Skipped: the allowed time ended before it could start. {s.created_by} was told.",
            notify="failed",
        )
    late = (now - slot).total_seconds() > LATE_AFTER_S and not manual
    try:
        async with database.async_session() as session:
            run = await svc_runs.create_run(
                session,
                ticket_id=s.ticket_id,
                member_id=chosen,
                trigger="schedule",
                started_by=s.created_by,
                instruction=_instruction(s),
            )
    except svc_runs.RunConflict as exc:
        if manual:
            raise ScheduleError("conflict", str(exc)) from exc
        await _set(srun_id, state="waiting", note=f"Waiting: {exc}")
        return
    except svc_runs.RunError as exc:
        if manual:
            raise ScheduleError("unavailable", str(exc)) from exc
        return await _close(srun_id, "skipped", f"Skipped: {exc}", notify="failed")
    names = {}
    async with database.async_session() as session:
        names = await _names(session, [chosen])
    note = None
    if late:
        note = f"Started {now.astimezone(zone(s.tz)):%H:%M} when it was back."
    if chosen != s.member_id and not member_id:
        note = (
            note + " " if note else ""
        ) + f"Ran on the backup AI, {names.get(chosen)}."
    await _set(
        srun_id,
        state="running",
        member_id=chosen,
        run_ids=json.dumps([run.id]),
        attempts=1,
        catch_up=late,
        started_at=now_iso(),
        note=note,
    )
    ai = names.get(chosen, "The AI")
    await _activity(
        s.ticket_id,
        f"started a scheduled run on {s.ticket_id} (schedule by {s.created_by})",
        ai,
    )
    _notify(
        s,
        "started",
        f"{s.ticket_id} run started by schedule",
        run_id=run.id,
        action="open_run",
    )


async def _publish_board() -> None:
    """Tell open pages that schedules changed."""
    import events as board_events

    await board_events.publish(board_events.INVALIDATE)


async def _set(srun_id: str, **fields) -> None:
    async with database.async_session() as session:
        srun = await session.get(AiScheduleRun, srun_id)
        if srun is None:
            return
        for k, v in fields.items():
            setattr(srun, k, v)
        srun.updated_at = now_iso()
        session.add(srun)
        await session.commit()
    await _publish_board()


async def _close(
    srun_id: str,
    state: str,
    note: str | None,
    *,
    notify: str | None = None,
    end_schedule: bool = False,
) -> None:
    """End a slot: totals, the failure count (3 in a row pause), Activity and the notification."""
    async with database.async_session() as session:
        srun = await session.get(AiScheduleRun, srun_id)
        if srun is None or srun.state in ENDED:
            return
        s = await session.get(AiSchedule, srun.schedule_id)
        run_ids = loads(srun.run_ids, [])
        cost = 0.0
        if run_ids:
            rows = (
                await session.exec(select(AiRun).where(col(AiRun.id).in_(run_ids)))
            ).all()
            cost = sum(r.cost_usd for r in rows)
        if srun.note and srun.state == "running":
            note = (
                f"{srun.note} {note or ''}".strip()
            )  # keep how it started (catch-up, backup AI)
        srun.state = state
        srun.note = note
        srun.ended_at = now_iso()
        started = parse_iso(srun.started_at)
        srun.duration_s = (
            int((datetime.now(UTC) - started).total_seconds()) if started else 0
        )
        srun.cost_usd = cost
        srun.updated_at = now_iso()
        session.add(srun)
        paused_now = False
        if s is not None:
            if state == "failed":
                s.failures_in_row += 1
                if s.failures_in_row >= AUTO_PAUSE_AFTER and s.state == "active":
                    s.state = "paused"
                    s.paused_reason = f"Failed {s.failures_in_row} runs in a row: {note or 'see the last run'}"
                    paused_now = True
            elif state in ("passed", "partly"):
                s.failures_in_row = 0
            ticket = await session.get(Ticket, s.ticket_id)
            if ticket is not None:
                s.ticket_seen_at = (
                    ticket.updated_at
                )  # the schedule's own run edits are not "edited since"
            if end_schedule:
                s.state = "ended"
                s.next_run_at = None
            elif s.state == "active" and not s.next_run_at:
                s.state = "ended"
            session.add(s)
        await session.commit()
        names = await _names(session, [srun.member_id])
    if s is None:
        return
    who = names.get(srun.member_id or "", s.created_by)
    if state == "skipped":
        await _activity(
            s.ticket_id,
            f"skipped a scheduled run on {s.ticket_id}: {(note or '').removeprefix('Skipped: ')}",
            who if srun.member_id else "Schedule",
        )
        _notify(
            s,
            notify or "failed",
            f"{s.ticket_id} skipped: {(note or '').removeprefix('Skipped: ').rstrip('.')}",
            srun_id=srun_id,
            action="reschedule",
            skipped=True,
        )
    elif state == "failed":
        _notify(
            s,
            "failed",
            f"{s.ticket_id} scheduled run failed: {note}",
            srun_id=srun_id,
            action="open",
        )
    elif state == "partly":
        _notify(
            s,
            "finished",
            f"{s.ticket_id} partly done: {note}",
            srun_id=srun_id,
            action="open",
        )
    if paused_now:
        await _activity(
            s.ticket_id,
            f"paused the schedule for {s.ticket_id}: failed {AUTO_PAUSE_AFTER} runs in a row",
            "Schedule",
        )
        _notify(
            s,
            "failed",
            f"Schedule paused for {s.ticket_id}: failed {AUTO_PAUSE_AFTER} runs in a row",
            srun_id=srun_id,
            action="open",
        )
    await _publish_board()


async def _follow(srun_id: str, now: datetime) -> None:
    """Watch the slot's current run: limits, questions, and what to do when it ends. The run's lead decides when the
    work is done; the board only closes the slot with what it reported."""
    async with database.async_session() as session:
        srun = await session.get(AiScheduleRun, srun_id)
        if srun is None or srun.state != "running":
            return
        s = await session.get(AiSchedule, srun.schedule_id)
        run_ids = loads(srun.run_ids, [])
        run = await session.get(AiRun, run_ids[-1]) if run_ids else None
    if s is None or run is None:
        return await _close(srun_id, "failed", "The run was lost.")
    lim = limits_of(s)
    if run.state == "queued":
        queued = parse_iso(run.queued_at) or now
        if now - queued > timedelta(minutes=BUSY_MAX_WAIT_MIN):
            await svc_runs.cancel(
                run.id,
                by="schedule",
                reason=f"No free slot within {BUSY_MAX_WAIT_MIN} min",
            )
            return await _close(
                srun_id,
                "skipped",
                f"Skipped: no free slot within {BUSY_MAX_WAIT_MIN} min.",
                notify="failed",
            )
        return
    if run.state in ("starting", "running", "needs_input"):
        started = parse_iso(run.started_at)
        limit = int(lim.get("stop_after_min") or 45)
        over_time = (
            run.state != "needs_input"
            and started is not None
            and now - started > timedelta(minutes=limit)
        )
        max_cost = lim.get("max_cost")
        over_cost = (
            max_cost is not None and run.metered and run.cost_usd >= float(max_cost)
        )
        if over_time or over_cost:
            why = (
                f"Stopped at the {limit} min limit."
                if over_time
                else f"Stopped at the ${float(max_cost):.2f} cost limit."
            )
            try:
                await svc_runs.cancel(
                    run.id, by="schedule", reason=why, revert_status=False
                )
            except svc_runs.RunError:
                pass
            return await _close(srun_id, "partly", why)
        if run.state == "needs_input" and run.id not in RT.asked:
            RT.asked.add(run.id)
            _notify(
                s,
                "needs_input",
                f"{s.ticket_id} scheduled run needs input",
                run_id=run.id,
                action="open_run",
            )
        return
    if run.state == "cancelled":
        if run.ended_by == "schedule":
            return
        return await _close(
            srun_id, "cancelled", f"Run cancelled by {run.ended_by or 'a person'}."
        )
    if run.state in ("failed", "timed_out"):
        if srun.attempts < 1 + int(lim.get("retries") or 0):
            return await _restart(
                srun_id,
                s,
                run,
                "The last attempt failed: "
                + (run.ended_reason or "no reason given")
                + ". Try again.",
            )
        retried = " Retried, failed again." if srun.attempts > 1 else ""
        return await _close(
            srun_id,
            "failed",
            f"Run {run.state.replace('_', ' ')}: {run.ended_reason or 'no reason given'}.{retried}",
        )
    # finished: the lead's own report says how it went
    report = loads(run.report, {}) or {}
    status = str(report.get("status") or "done")
    said = _short(report.get("summary") or run.summary or "", 200)
    if status in ("partial", "blocked", "question"):
        return await _close(
            srun_id,
            "partly",
            f"The lead reported {status}." + (f" {said}" if said else ""),
        )
    await _close(srun_id, "passed", "Finished." + (f" {said}" if said else ""))
    _notify(
        s,
        "finished",
        f"{s.ticket_id} scheduled run finished",
        run_id=run.id,
        action="open",
    )


def _short(text: object, limit: int = 160) -> str:
    """One line of an error, cut: a CLI's last stderr lines can be a whole traceback."""
    one = " ".join(str(text).split())
    return one if len(one) <= limit else one[: limit - 1].rstrip() + "…"


async def _restart(srun_id: str, s: AiSchedule, run: AiRun, extra: str) -> None:
    async with database.async_session() as session:
        srun = await session.get(AiScheduleRun, srun_id)
        fresh = await session.get(AiSchedule, s.id)
        slot = parse_iso(srun.slot_at) or datetime.now(UTC)
        # nothing starts again behind a paused schedule; a run cut off when the board closed is not started again
        # past its allowed time either (a retry after the run itself ended is not held to it)
        if fresh is not None and fresh.state == "paused":
            await _close(
                srun_id, "skipped", "Not started again: the schedule is paused."
            )
            return
        if run.ended_by == "board" and datetime.now(UTC) > _deadline(s, slot):
            await _close(
                srun_id, "skipped", "Not started again: its allowed time has passed."
            )
            return
        try:
            new = await svc_runs.create_run(
                session,
                ticket_id=s.ticket_id,
                member_id=srun.member_id or s.member_id,
                trigger="schedule",
                started_by=s.created_by,
                instruction=_instruction(s, extra),
                resume_session=run.session_id,
            )
        except svc_runs.RunError as exc:
            await _close(srun_id, "failed", f"Could not start again: {exc}")
            return
        ids = loads(srun.run_ids, []) + [new.id]
        fields = {"run_ids": json.dumps(ids), "attempts": srun.attempts + 1}
    await _set(srun_id, **fields)


async def dry_run(
    session, schedule_id: str | None, project_id: str, data: dict, by: str
) -> dict:
    """What the AI would do, without doing it (C "Dry run"): a plan from the board's assistant (the
    `schedule-dry-run` skill). Nothing is changed."""
    from services.assistant import engine
    from services.assistant.errors import AssistError

    s = AiSchedule(project_id=project_id, ticket_id="", member_id="", created_by=by)
    if schedule_id:
        existing = await get_or_404(session, schedule_id)
        s = AiSchedule(**existing.model_dump())
    _apply(s, data)
    ticket = await session.get(Ticket, s.ticket_id)
    if ticket is None:
        raise ScheduleError("invalid", "Pick a ticket first.")
    acs = loads(ticket.acceptance_criteria, [])
    names = await _names(session, [s.member_id])
    try:
        out = await engine.turn(
            project_id,
            name=f"schedule:{s.id or 'new'}:dry-run",
            skill="schedule-dry-run",
            inputs={
                "ticket_id": ticket.id,
                "title": ticket.title,
                "description": (ticket.description or "")[:6000],
                "acceptance_criteria": [a.get("text") for a in acs],
                "instruction": _instruction(s),
            },
            by=by,
            feature="schedule_dry_run",
            ticket_id=ticket.id,
            fresh=True,
            timeout_s=300.0,
        )
    except AssistError as exc:
        raise ScheduleError("unavailable", f"The dry run failed: {exc}") from exc
    if out.state != "finished":
        raise ScheduleError("unavailable", f"The dry run failed: {out.error}")
    return {
        "text": (out.data().get("text") or out.text).strip(),
        "member_name": names.get(s.member_id) or out.member,
        "cost": round(out.cost, 4),
        "metered": False,
    }


async def for_tickets(session, project_id: str) -> dict[str, dict]:
    """Card footer state per ticket (E2): next run, starts soon, missed and waiting, paused."""
    rows = (
        await session.exec(
            select(AiSchedule).where(
                AiSchedule.project_id == project_id,
                col(AiSchedule.state).in_(["active", "paused"]),
            )
        )
    ).all()
    waiting = {
        r.schedule_id: r
        for r in (
            await session.exec(
                select(AiScheduleRun).where(
                    AiScheduleRun.project_id == project_id,
                    col(AiScheduleRun.state).in_(["waiting", "ask"]),
                )
            )
        ).all()
    }
    now = datetime.now(UTC)
    out: dict[str, dict] = {}
    for s in rows:
        if s.state == "paused":
            item = {"state": "paused", "label": "Schedule paused"}
        elif s.id in waiting:
            item = {
                "state": "missed",
                "label": "Missed, waiting for runner"
                if waiting[s.id].state == "waiting"
                else "Late: run it?",
            }
        else:
            at = parse_iso(s.next_run_at)
            if at is None:
                continue
            soon = at - now <= timedelta(minutes=60)
            local = at.astimezone(zone(s.tz))
            item = {
                "state": "soon" if soon else "planned",
                "label": f"Starts {in_words(at, now)}"
                if soon
                else f"{DAY_NAMES[local.weekday()]} {local:%H:%M}",
                "at": s.next_run_at,
            }
        item["schedule_id"] = s.id
        item["member_id"] = s.member_id
        cur = out.get(s.ticket_id)
        rank = {"missed": 0, "soon": 1, "planned": 2, "paused": 3}
        if (
            cur is None
            or rank[item["state"]] < rank[cur["state"]]
            or (
                item["state"] == cur["state"] == "planned"
                and item.get("at", "") < cur.get("at", "")
            )
        ):
            out[s.ticket_id] = item
    return out
