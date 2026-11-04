"""The notification centre (design/screens/notifications.md, docs/specs/notifications.md).

One append-only event log (`NotifyEvent`, increasing integer ids) is the source. Each event is written as one
`Notification` row per recipient: a person's key (a name, lower case; "user" for the board's own user) or
"ai:<member id>" for an AI member. Read, done (and why), snoozed and cleared are kept per row.

Two kinds of notification:
- Needs you: the work cannot go on without a person. It may interrupt (toast, desktop) and it closes itself when the
  thing it points at no longer needs a person (`reconcile`), wherever that happened.
- For information: it only adds to the list. Same-kind events of one project inside 10 minutes are one row.

"Off" means quiet, not unrecorded: every event is written; a switch or a mute only makes a row quiet (`inapp`
False: not in the panel or the count, still on the All notifications page and in the day card). A Needs you row is
never quiet.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections import deque
from datetime import UTC, datetime, timedelta
from typing import Any, Iterable, TypedDict, Unpack

from sqlalchemy import and_, case, delete, false, func, not_, or_
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
import events as board_events
from models import (
    AiAccount,
    AiTeam,
    AiProjectSettings,
    AiRun,
    AiSchedule,
    DocsComment,
    DocsCommentThread,
    DocsPage,
    Member,
    Notification,
    NotifyEvent,
    NotifyFollow,
    NotifyPrefs,
    Project,
    Ticket,
)

logger = logging.getLogger("kanban.notifications")

TOPIC = "notifications"

# kind: (label in Settings, Needs you, desktop by default, can be dismissed)
KINDS: dict[str, tuple[str, bool, bool, bool]] = {
    # Needs you: may interrupt. In app is locked on.
    "question": ("A question from an AI", True, True, False),
    "approval": ("An approval request", True, True, False),
    "run_failed": ("A run failed or timed out", True, True, True),
    "blocked": ("An AI was blocked by a permission", True, True, True),
    "account_signed_out": ("An AI account signed out", True, True, False),
    "mention": ("Someone mentioned you", True, True, True),
    "run_stopped_memory": ("A run was stopped for memory", True, True, True),
    "budget": ("Budget or cap reached", True, True, True),
    "page_proposal": ("A page proposal from an AI", True, True, False),
    "auto_trip": ("AI was paused (auto-trip or Pause all AI)", True, True, True),
    "offline": ("An AI member went offline", True, False, True),
    # AI team v2 (design/screens/ai-operations.md C, D; ai-board-wave3.md L)
    "run_stuck": ("An AI stopped moving", True, True, True),
    "board_fault": ("The board failed an AI (a board fault)", True, True, True),
    "merge_conflict": ("A merge conflict", True, True, False),
    "arbitration": ("Two AIs could not agree", True, True, False),
    "window_urgent": ("Urgent work waits for a usage window", True, True, True),
    "workflow_step": (
        "A workflow waits for you (the design to approve)",
        True,
        True,
        False,
    ),
    "workflow_blocked": (
        "A workflow step cannot start, or a ticket reached its token cap",
        True,
        True,
        False,
    ),
    "story_plan": ("A Story's plan waits for you", True, True, False),
    "story_blocked": ("A Story cannot go on without you", True, True, False),
    # For information: never interrupts.
    "ai_finished": ("An AI finished work", False, False, False),
    "schedule": ("A scheduled run finished or was skipped", False, False, False),
    "schedule_started": ("A scheduled run started", False, False, False),
    "page_published": ("A page was published", False, False, False),
    "comment": ("A new comment in a thread you follow", False, False, False),
    "run_restarted": ("A run was restarted for memory", False, False, False),
    "run_cancelled": ("A run was cancelled", False, False, False),
    "budget_warning": ("Budget passed a warning level", False, False, False),
    "access_request": ("Someone asked for access to Docs", False, False, False),
    "day_card": ("The day in one card", False, False, False),
    "window_wait": ("Runs wait for the next usage window", False, False, False),
    "lesson": ("An AI proposed a lesson for the project", False, False, False),
    "story_done": ("A Story is done", False, False, False),
}

# The order of the Settings table (L)
NEEDS_KINDS = [k for k, v in KINDS.items() if v[1]]
INFO_KINDS = [k for k, v in KINDS.items() if not v[1]]

# The sounds a person can pick (the desktop app and the browser play the same three, see
# desktop/sounds.js and ui/src/utils/notificationSound.ts)
SOUND_NAMES = ("chime", "drop", "bell")
# What "Remind me if unanswered" offers, in minutes (0 = off)
REMIND_CHOICES = (0, 5, 10, 15, 30, 60)
REMIND_MAX_MIN = 24 * 60
REMIND_EVERY_S = (
    30  # how often the loop looks for Needs you rows that waited long enough
)

GROUP_WINDOW = timedelta(minutes=10)
GROUP_NAMES_MAX = 20  # above this a grouped row says "20+"
GROUP_ITEMS_KEPT = 50
PANEL_DAYS = 30
DEFAULT_RETENTION_DAYS = 90
DEFAULT_PREFS: dict[str, Any] = {
    "events": {},
    "quiet": {"on": True, "start": "22:00", "end": "08:00"},
    "desktop_on": True,  # the master switch: no OS notification at all when off
    "dnd": True,
    # A short sound for Needs you events (never for information): on by default, a choice of a few (#270)
    "sound": True,
    "sound_name": "chime",
    # Minutes a Needs you row may stay unanswered before it notifies once more; 0 = never remind
    "remind_after_min": 15,
    "day_card": {"on": True, "time": "18:00", "days": [0, 1, 2, 3, 4]},
}

# What a recipient key looks like when it is the board's own user
_SELF = {"", "user", "you", "me"}

# Who an AI member is called when the member is gone
_AN_AI_MEMBER = "An AI member"


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def now_iso() -> str:
    """Current UTC time, ISO formatted."""
    return datetime.now(UTC).isoformat()


def _s(n: int) -> str:
    """The plural ending of a count: "1 run", "2 runs"."""
    return "" if n == 1 else "s"


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def _loads(value: str | None, default):
    if not value:
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


def person_key(name: str | None) -> str:
    """The recipient key of a person: the name in lower case, "user" for the board's own user."""
    n = (name or "").strip().lower()
    return "user" if n in _SELF else n


def ai_key(member_id: str) -> str:
    """The recipient key of an AI member."""
    return f"ai:{member_id}"


def is_needs(kind: str) -> bool:
    """Whether a kind is Needs you."""
    return KINDS.get(kind, ("", False, False, False))[1]


def _local(dt: datetime) -> datetime:
    return dt.astimezone()


# ---------------------------------------------------------------------------
# Delivery: "the log moved to id N"
# ---------------------------------------------------------------------------

_dirty: asyncio.Event | None = None  # made by start(), on the loop that runs it
_pending: deque[dict] = (
    deque()
)  # events queued by synchronous callers (schedules), written by the loop
_later: deque[tuple] = (
    deque()
)  # (async function, argument) to run once the caller has committed


def mark_dirty() -> None:
    """Something changed on the board: check the open Needs you rows soon."""
    if _dirty is not None:
        _dirty.set()


async def _announce(head: int | None) -> None:
    """Tell every open window (and the desktop notifier) that the log or a row moved. The window asks for what it has
    not seen, so a dropped message costs nothing."""
    msg = json.dumps({"type": "invalidate", "topics": [TOPIC], "head": head or 0})
    await board_events.publish(msg)


async def head_id(session: AsyncSession) -> int:
    """The newest id of the log (0 when empty); never below what retention deleted, so a cursor never goes back."""
    top = int((await session.exec(select(func.max(NotifyEvent.id)))).one() or 0)
    g = await _global(session)
    return max(top, int(g.get("pruned_through") or 0))


# ---------------------------------------------------------------------------
# Who gets it
# ---------------------------------------------------------------------------


async def ai_names(session: AsyncSession, project_id: str | None) -> dict[str, str]:
    """name (lower case) -> member id of the AI members of a project."""
    if not project_id:
        return {}
    rows = (
        await session.exec(
            select(Member).where(Member.project_id == project_id, Member.kind == "ai")
        )
    ).all()
    return {m.name.strip().lower(): m.id for m in rows}


async def recipient_keys(
    session: AsyncSession, project_id: str | None, names: Iterable[str | None]
) -> list[str]:
    """Recipient keys for names: an AI member's name becomes "ai:<id>", anyone else is a person."""
    ais = await ai_names(session, project_id)
    out: list[str] = []
    for n in names:
        if n is None:
            continue
        raw = n.strip()
        if raw.startswith("ai:"):
            key = raw
        elif raw.lower() in ais:
            key = ai_key(ais[raw.lower()])
        else:
            key = person_key(raw)
        if key not in out:
            out.append(key)
    return out


async def owners_and_admins(session: AsyncSession, project_id: str | None) -> list[str]:
    """The board's own user, and the people who are owners or admins of the project (decision 2 on #253: they are
    recipients of every AI safety event, as they saw every one before)."""
    out = ["user"]
    if not project_id:
        return out
    rows = (
        await session.exec(
            select(Member).where(
                Member.project_id == project_id, Member.kind == "human"
            )
        )
    ).all()
    for m in rows:
        if m.role in ("admin", "owner"):
            k = person_key(m.name)
            if k not in out:
                out.append(k)
    return out


async def managed_projects(session: AsyncSession, me: str) -> set[str] | None:
    """The projects this person is an owner or admin of; None means every project (the board's own user)."""
    if me == "user":
        return None
    rows = (
        await session.exec(
            select(Member).where(
                Member.kind == "human", col(Member.role).in_(["admin", "owner"])
            )
        )
    ).all()
    return {m.project_id for m in rows if person_key(m.name) == me}


async def may_manage(session: AsyncSession, me: str) -> bool:
    """Whether a person may change the app-wide notification settings: the board's own user, or an owner or admin
    of a project (as for every AI safety event, `owners_and_admins`)."""
    managed = await managed_projects(session, me)
    return managed is None or bool(managed)


async def followers(
    session: AsyncSession, scope: str, scope_id: str | None
) -> list[str]:
    """Recipients who follow a ticket, page or Docs space (not muted)."""
    if not scope_id:
        return []
    rows = (
        await session.exec(
            select(NotifyFollow).where(
                NotifyFollow.scope == scope,
                NotifyFollow.scope_id == scope_id,
                col(NotifyFollow.level).in_(["follow", "everything"]),
            )
        )
    ).all()
    return [r.recipient for r in rows]


# ---------------------------------------------------------------------------
# Settings › Notifications
# ---------------------------------------------------------------------------


async def get_prefs(session: AsyncSession, recipient: str) -> dict[str, Any]:
    """A recipient's settings, with the defaults filled in."""
    return _prefs_of(await session.get(NotifyPrefs, recipient))


def _prefs_of(row: NotifyPrefs | None) -> dict[str, Any]:
    """Settings from a stored row (None: never saved), with the defaults filled in."""
    mine = _loads(row.prefs, {}) if row else {}
    out = json.loads(json.dumps(DEFAULT_PREFS))
    for k, v in mine.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k].update(v)
        else:
            out[k] = v
    return out


def event_switch(prefs: dict, kind: str) -> tuple[bool, bool]:
    """(in app, desktop) for a kind. In app is locked on for Needs you."""
    _, needs, desktop_default, _ = KINDS.get(kind, ("", False, False, False))
    mine = prefs.get("events", {}).get(kind) or {}
    inapp = True if needs else bool(mine.get("inapp", True))
    desktop = bool(prefs.get("desktop_on", True)) and bool(
        mine.get("desktop", desktop_default)
    )
    return inapp, desktop


async def retention_days(session: AsyncSession) -> int:
    """How long notifications and the log are kept (one app-wide setting)."""
    row = await session.get(NotifyPrefs, "*")
    days = _loads(row.prefs, {}).get("retention_days") if row else None
    try:
        return max(1, int(days)) if days else DEFAULT_RETENTION_DAYS
    except (TypeError, ValueError):
        return DEFAULT_RETENTION_DAYS


async def _global(session: AsyncSession) -> dict:
    row = await session.get(NotifyPrefs, "*")
    return _loads(row.prefs, {}) if row else {}


async def _set_global(session: AsyncSession, **values) -> None:
    row = await session.get(NotifyPrefs, "*") or NotifyPrefs(recipient="*")
    g = _loads(row.prefs, {})
    g.update(values)
    row.prefs = json.dumps(g)
    row.updated_at = now_iso()
    session.add(row)


def _hhmm(value: str, fallback: str) -> str:
    return (
        value
        if isinstance(value, str) and re.fullmatch(r"\d{2}:\d{2}", value)
        else fallback
    )


async def settings_for(session: AsyncSession, recipient: str) -> dict[str, Any]:
    """The Settings › Notifications page: the event table, quiet hours, sound, the day card, retention, Muted."""
    prefs = await get_prefs(session, recipient)
    events = []
    for kind in NEEDS_KINDS + INFO_KINDS:
        label, needs, _, _ = KINDS[kind]
        # the table shows each kind's own choice; the master switch is shown on its own
        inapp, desktop = event_switch({**prefs, "desktop_on": True}, kind)
        events.append(
            {
                "kind": kind,
                "label": label,
                "needs": needs,
                "inapp": inapp,
                "inapp_locked": needs,
                "desktop": desktop,
            }
        )
    return {
        "events": events,
        "quiet": prefs["quiet"],
        "desktop_on": bool(prefs.get("desktop_on", True)),
        "dnd": bool(prefs["dnd"]),
        "sound": bool(prefs["sound"]),
        "sound_name": _sound_name(prefs),
        "remind_after_min": _remind_after(prefs),
        "day_card": prefs["day_card"],
        "retention_days": await retention_days(session),
        "retention_editable": await may_manage(session, recipient),
        "muted": await muted_list(session, recipient),
    }


def _sound_name(prefs: dict) -> str:
    """The sound the person picked; an unknown name falls back to the first."""
    name = prefs.get("sound_name")
    return name if name in SOUND_NAMES else SOUND_NAMES[0]


def _remind_after(prefs: dict) -> int:
    """Minutes before an unanswered Needs you row reminds once; 0 when reminders are off."""
    try:
        minutes = int(prefs.get("remind_after_min", DEFAULT_PREFS["remind_after_min"]))
    except (TypeError, ValueError):
        return DEFAULT_PREFS["remind_after_min"]
    return (
        minutes if 0 <= minutes <= REMIND_MAX_MIN else DEFAULT_PREFS["remind_after_min"]
    )


def _apply_event_choices(mine: dict, events: list[dict]) -> None:
    """The per-kind In app and desktop choices. A Needs you kind's In app cannot be switched off."""
    for item in events:
        kind = item.get("kind")
        if kind not in KINDS:
            raise ValueError(f"Unknown kind: {kind}")
        cur = dict(mine.setdefault("events", {}).get(kind) or {})
        if item.get("inapp") is not None:
            if KINDS[kind][1] and not item["inapp"]:
                raise ValueError(
                    "In app stays on for everything that needs you: an AI waiting on an answer with no row and no "
                    "count would wait for ever. Only its desktop notification can be switched off."
                )
            cur["inapp"] = bool(item["inapp"])
        if item.get("desktop") is not None:
            cur["desktop"] = bool(item["desktop"])
        mine["events"][kind] = cur


def _apply_quiet(mine: dict, src: dict) -> None:
    q = {**DEFAULT_PREFS["quiet"], **mine.get("quiet", {})}
    if "on" in src:
        q["on"] = bool(src["on"])
    for k in ("start", "end"):
        if k in src:
            q[k] = _hhmm(src[k], q[k])
    mine["quiet"] = q


def _apply_day_card(mine: dict, src: dict) -> None:
    d = {**DEFAULT_PREFS["day_card"], **mine.get("day_card", {})}
    if "on" in src:
        d["on"] = bool(src["on"])
    if "time" in src:
        d["time"] = _hhmm(src["time"], d["time"])
    if isinstance(src.get("days"), list):
        d["days"] = sorted({int(x) for x in src["days"] if 0 <= int(x) <= 6})
    mine["day_card"] = d


async def update_settings(
    session: AsyncSession, recipient: str, body: dict[str, Any]
) -> dict[str, Any]:
    """Save part of a recipient's settings. A Needs you kind's In app cannot be switched off (ValueError). The
    app-wide `retention_days` deletes everyone's history: only the board's own user or an owner or admin of a
    project changes it (PermissionError)."""
    if body.get("retention_days") is not None and not await may_manage(
        session, recipient
    ):
        raise PermissionError(
            "Only the board's own user, or an owner or admin of a project, changes how long notifications are kept."
        )
    row = await session.get(NotifyPrefs, recipient) or NotifyPrefs(recipient=recipient)
    mine = _loads(row.prefs, {})
    _apply_event_choices(mine, body.get("events") or [])
    if isinstance(body.get("quiet"), dict):
        _apply_quiet(mine, body["quiet"])
    for k in ("dnd", "sound", "desktop_on"):
        if k in body and body[k] is not None:
            mine[k] = bool(body[k])
    if body.get("sound_name") is not None:
        if body["sound_name"] not in SOUND_NAMES:
            raise ValueError(f"Pick a sound: {', '.join(SOUND_NAMES)}.")
        mine["sound_name"] = body["sound_name"]
    if body.get("remind_after_min") is not None:
        minutes = int(body["remind_after_min"])
        if not 0 <= minutes <= REMIND_MAX_MIN:
            raise ValueError("Remind after 1 to 1440 minutes, or 0 for never.")
        mine["remind_after_min"] = minutes
    if isinstance(body.get("day_card"), dict):
        _apply_day_card(mine, body["day_card"])
    row.prefs = json.dumps(mine)
    row.updated_at = now_iso()
    session.add(row)
    if body.get("retention_days") is not None:
        days = int(body["retention_days"])
        if not 1 <= days <= 3650:
            raise ValueError("Keep notifications for 1 to 3650 days.")
        await _set_global(session, retention_days=days)
    await session.commit()
    await _announce(await head_id(session))
    return await settings_for(session, recipient)


def in_quiet_hours(prefs: dict, at: datetime | None = None) -> bool:
    """Whether quiet hours are on now for these settings."""
    q = prefs.get("quiet") or {}
    if not q.get("on"):
        return False
    t = _local(at or datetime.now(UTC)).strftime("%H:%M")
    start, end = q.get("start", "22:00"), q.get("end", "08:00")
    if start == end:
        return False
    return start <= t < end if start < end else (t >= start or t < end)


# ---------------------------------------------------------------------------
# Follow and mute
# ---------------------------------------------------------------------------


def _active(f: NotifyFollow, now: datetime) -> bool:
    until = _parse(f.until)
    return until is None or until > now


async def _follows_of(session: AsyncSession, recipient: str) -> list[NotifyFollow]:
    rows = (
        await session.exec(
            select(NotifyFollow).where(NotifyFollow.recipient == recipient)
        )
    ).all()
    now = datetime.now(UTC)
    return [f for f in rows if _active(f, now)]


def _quiet_by_follows(
    follows: list[NotifyFollow],
    *,
    kind: str,
    project_id: str | None,
    ticket_id: str | None,
    page_id: str | None,
) -> bool:
    """Whether a mute makes this row quiet. Never for a Needs you row (it is addressed to the recipient)."""
    if is_needs(kind):
        return False
    return any(
        f.level in ("mute", "mentions")
        and _mutes(
            f, kind=kind, project_id=project_id, ticket_id=ticket_id, page_id=page_id
        )
        for f in follows
    )


def _mutes(
    f: NotifyFollow,
    *,
    kind: str,
    project_id: str | None,
    ticket_id: str | None,
    page_id: str | None,
) -> bool:
    """Whether one mute (of a kind, a project, a ticket or a page) covers this row."""
    if f.scope == "kind":
        return f.scope_id == kind and (
            f.project_id is None or f.project_id == project_id
        )
    if f.scope == "project":
        return f.scope_id == project_id
    if f.scope == "ticket":
        return bool(ticket_id) and f.scope_id == ticket_id
    if f.scope == "page":
        return bool(page_id) and f.scope_id == page_id
    return False


async def muted_list(session: AsyncSession, recipient: str) -> list[dict]:
    """What the recipient muted, for the Muted list in Settings."""
    rows = await _follows_of(session, recipient)
    return [follow_to_dict(f) for f in rows if f.level in ("mute", "mentions")]


def follow_to_dict(f: NotifyFollow) -> dict:
    """A follow or mute for the API."""
    return {
        "id": f.id,
        "scope": f.scope,
        "scope_id": f.scope_id,
        "project_id": f.project_id,
        "level": f.level,
        "until": f.until,
        "label": f.label,
        "created_at": f.created_at,
    }


async def follow_state(
    session: AsyncSession, recipient: str, scope: str, scope_id: str
) -> dict:
    """What the bell on a ticket, page or space shows: following, everything, mentions only, muted, or nothing."""
    rows = [
        f
        for f in await _follows_of(session, recipient)
        if f.scope == scope and f.scope_id == scope_id
    ]
    f = rows[0] if rows else None
    return {
        "scope": scope,
        "scope_id": scope_id,
        "level": f.level if f else None,
        "until": f.until if f else None,
        "id": f.id if f else None,
    }


async def set_follow(
    session: AsyncSession,
    recipient: str,
    *,
    scope: str,
    scope_id: str,
    level: str | None,
    project_id: str | None = None,
    minutes: int | None = None,
    label: str = "",
) -> dict:
    """Follow, mute or forget a ticket, page, Docs space, project or kind (level None forgets it)."""
    if scope not in ("ticket", "page", "space", "project", "kind"):
        raise ValueError("scope must be ticket, page, space, project or kind")
    if level not in (None, "follow", "everything", "mentions", "mute"):
        raise ValueError("level must be follow, everything, mentions or mute")
    if scope == "kind" and scope_id not in KINDS:
        raise ValueError(f"Unknown kind: {scope_id}")
    stmt = select(NotifyFollow).where(
        NotifyFollow.recipient == recipient,
        NotifyFollow.scope == scope,
        NotifyFollow.scope_id == scope_id,
    )
    if scope == "kind":
        stmt = (
            stmt.where(NotifyFollow.project_id == project_id)
            if project_id
            else stmt.where(col(NotifyFollow.project_id).is_(None))
        )
    for row in (await session.exec(stmt)).all():
        await session.delete(row)
    if level:
        session.add(
            NotifyFollow(
                recipient=recipient,
                scope=scope,
                scope_id=scope_id,
                project_id=project_id,
                level=level,
                until=(datetime.now(UTC) + timedelta(minutes=minutes)).isoformat()
                if minutes
                else None,
                label=label
                or await _follow_label(session, scope, scope_id, project_id),
            )
        )
    await session.commit()
    await _announce(await head_id(session))
    return await follow_state(session, recipient, scope, scope_id)


async def _follow_label(
    session: AsyncSession, scope: str, scope_id: str, project_id: str | None
) -> str:
    if scope == "ticket":
        return scope_id
    if scope == "page":
        page = await session.get(DocsPage, scope_id)
        return page.title if page else "A Docs page"
    if scope in ("project", "space"):
        p = await session.get(Project, scope_id)
        name = p.name if p else "A project"
        return f"{name} · Docs space" if scope == "space" else name
    label = KINDS[scope_id][0]
    if project_id:
        p = await session.get(Project, project_id)
        if p:
            return f"{label}, in {p.name}"
    return label


async def unmute(session: AsyncSession, recipient: str, follow_id: str) -> None:
    """Remove one follow or mute of the recipient."""
    row = await session.get(NotifyFollow, follow_id)
    if row is None or row.recipient != recipient:
        raise LookupError("Not found")
    await session.delete(row)
    await session.commit()
    await _announce(await head_id(session))


# ---------------------------------------------------------------------------
# Writing: the log, then one row per recipient
# ---------------------------------------------------------------------------


def _group_key(
    kind: str,
    project_id: str | None,
    target_kind: str | None,
    target_id: str | None,
    ticket_id: str | None,
) -> str:
    if is_needs(kind):
        # Needs you items group only when they are the same request (a question asked again); failures of one
        # ticket are one row, as Retry answers them all
        if kind in ("run_failed", "run_stopped_memory", "board_fault") and ticket_id:
            return f"{kind}:ticket:{ticket_id}"
        if target_id:
            return f"{kind}:{target_kind or '-'}:{target_id}"
        # nothing to point at: one row per project, never across projects
        return f"{kind}:project:{project_id or '-'}"
    if kind == "run_restarted" and target_id:
        return (
            f"{kind}:{target_id}"  # several restarts of one run in minutes are one row
        )
    return f"{kind}:{project_id or '-'}"


class _EmitRequired(TypedDict):
    project_id: str | None
    recipients: Iterable[str]
    title: str


class EmitFields(_EmitRequired, total=False):
    """What an event says, for `emit`: its project (None when it is about no one project), who is told, its words,
    what it points at, who caused it, its data, and `since` (when the thing began, if before now)."""

    body: str
    target_kind: str | None
    target_id: str | None
    ticket_id: str | None
    page_id: str | None
    member_id: str | None
    actor: str | None
    data: dict | None
    since: str | None


def _check_fields(fields: dict) -> None:
    """The checks a plain keyword signature would make: every required field given, no unknown one."""
    missing = EmitFields.__required_keys__ - fields.keys()
    unknown = (
        fields.keys() - EmitFields.__required_keys__ - EmitFields.__optional_keys__
    )
    if missing or unknown:
        raise TypeError(
            f"emit() fields missing: {sorted(missing)}, unknown: {sorted(unknown)}"
        )


async def emit(
    kind: str,
    *,
    session: AsyncSession | None = None,
    **fields: Unpack[EmitFields],
) -> int | None:
    """Append an event to the log and write (or merge into) one row per recipient. Returns the event id.

    The person who caused an information event is not told about it. Every event is recorded, even when nobody
    is left to tell (the day card and a later `wait` read the log)."""
    if kind not in KINDS:
        raise ValueError(f"Unknown notification kind: {kind}")
    _check_fields(fields)
    if session is None:
        async with database.async_session() as s:
            return await emit(kind, session=s, **fields)
    needs = is_needs(kind)
    keys = _keys_to_tell(fields["recipients"], fields.get("actor"), needs)
    data = fields.get("data") or {}
    ev = NotifyEvent(
        project_id=fields["project_id"],
        kind=kind,
        op="new",
        needs=needs,
        target_kind=fields.get("target_kind"),
        target_id=fields.get("target_id"),
        ticket_id=fields.get("ticket_id"),
        page_id=fields.get("page_id"),
        member_id=fields.get("member_id"),
        actor=fields.get("actor"),
        title=fields["title"][:300],
        body=(fields.get("body") or "")[:2000],
        data=json.dumps(data),
        recipients=json.dumps(keys),
    )
    session.add(ev)
    await session.flush()
    group_key = _group_key(
        kind, ev.project_id, ev.target_kind, ev.target_id, ev.ticket_id
    )
    now = datetime.now(UTC)
    item = {
        "event_id": ev.id,
        "title": ev.title,
        "body": ev.body[:200],
        "ticket_id": ev.ticket_id,
        "member_id": ev.member_id,
        "actor": ev.actor,
        "at": ev.created_at,
    }
    # Read what every recipient's row depends on in three queries, not three per recipient: the event's insert holds
    # the database's write lock until the commit below, and each await while it is held lets other work run first
    known = await _recipients_state(session, keys, group_key, ev.needs, now)
    for key in keys:
        prefs, follows, row = known[key]
        _write_row(
            session,
            key,
            ev,
            prefs=prefs,
            follows=follows,
            row=row,
            item=item,
            data=data,
            group_key=group_key,
            now=now,
            since=fields.get("since"),
        )
    await session.commit()
    await _announce(ev.id)
    return ev.id


def _keys_to_tell(
    recipients: Iterable[str], actor: str | None, needs: bool
) -> list[str]:
    """Each recipient once. The person who caused an information event is not told about it."""
    keys: list[str] = []
    for r in recipients:
        if r and r not in keys:
            keys.append(r)
    if actor and not needs:
        me = person_key(actor)
        keys = [k for k in keys if k != me]
    return keys


async def _recipients_state(
    session: AsyncSession, keys: list[str], group_key: str, needs: bool, now: datetime
) -> dict[str, tuple[dict[str, Any], list[NotifyFollow], Notification | None]]:
    """For each recipient: their settings, their active follows and mutes, and the open row of this group an event
    merges into (a Needs you row always, an information row while it is inside the group window)."""
    if not keys:
        return {}
    prefs_rows = {
        r.recipient: r
        for r in (
            await session.exec(
                select(NotifyPrefs).where(col(NotifyPrefs.recipient).in_(keys))
            )
        ).all()
    }
    follows: dict[str, list[NotifyFollow]] = {k: [] for k in keys}
    for f in (
        await session.exec(
            select(NotifyFollow).where(col(NotifyFollow.recipient).in_(keys))
        )
    ).all():
        if _active(f, now):
            follows[f.recipient].append(f)
    open_rows: dict[str, Notification] = {}
    for r in (
        await session.exec(
            select(Notification)
            .where(
                col(Notification.recipient).in_(keys),
                Notification.group_key == group_key,
                col(Notification.done_at).is_(None),
                col(Notification.cleared_at).is_(None),
            )
            .order_by(col(Notification.created_at), col(Notification.id))
        )
    ).all():
        if r.recipient in open_rows:
            continue
        first = _parse(r.created_at)
        if needs or (first and now - first <= GROUP_WINDOW):
            open_rows[r.recipient] = r
    return {
        k: (_prefs_of(prefs_rows.get(k)), follows[k], open_rows.get(k)) for k in keys
    }


def _write_row(
    session: AsyncSession,
    key: str,
    ev: NotifyEvent,
    *,
    prefs: dict[str, Any],
    follows: list[NotifyFollow],
    row: Notification | None,
    item: dict,
    data: dict,
    group_key: str,
    now: datetime,
    since: str | None,
) -> None:
    """One recipient's row of an event: merged into `row` (their open row of its group), or a new row."""
    inapp, desktop = event_switch(prefs, ev.kind)
    quiet = _quiet_by_follows(
        follows,
        kind=ev.kind,
        project_id=ev.project_id,
        ticket_id=ev.ticket_id,
        page_id=ev.page_id,
    )
    if row is not None and ev.kind != "day_card":
        _merge_into(row, ev, item, data, now)
        session.add(row)
        return
    session.add(
        Notification(
            recipient=key,
            event_id=ev.id,
            last_event_id=ev.id,
            project_id=ev.project_id,
            kind=ev.kind,
            needs=ev.needs,
            group_key=group_key,
            items=json.dumps([item]),
            target_kind=ev.target_kind,
            target_id=ev.target_id,
            ticket_id=ev.ticket_id,
            page_id=ev.page_id,
            member_id=ev.member_id,
            actor=ev.actor,
            title=ev.title,
            body=ev.body,
            data=ev.data,
            inapp=inapp and not quiet,
            desktop=desktop and not quiet,
            # how long it has waited counts from when the thing began (an AI's question: when it asked)
            created_at=since or ev.created_at,
            updated_at=ev.created_at,
        )
    )


def _merge_into(
    row: Notification, ev: NotifyEvent, item: dict, data: dict, now: datetime
) -> None:
    """One more event in an open row: counted, unread again, and its words updated. A reminder of the same request
    is not one more thing: the row only comes back (newest event, unread, not snoozed)."""
    row.last_event_id = ev.id
    row.read_at = None
    row.updated_at = now.isoformat()
    kept = _loads(row.data, {})
    if data.get("reminder"):
        row.snoozed_until = None
        # remembered, so the "unanswered for N minutes" reminder comes once per request (#270)
        row.data = json.dumps({**kept, "reminded_at": now.isoformat()})
        return
    if "reminded_at" in kept:
        # a new event is a new request for attention: it may remind again if it too stays unanswered
        kept.pop("reminded_at")
        row.data = json.dumps(kept)
    items = _loads(row.items, [])
    items.append(item)
    row.items = json.dumps(items[-GROUP_ITEMS_KEPT:])
    row.count += 1
    row.snoozed_until = None if ev.needs else row.snoozed_until
    if ev.needs:
        # the latest words of the same request (a failure again, a question asked again); a safety
        # reminder of it ("has waited 6 h") keeps the request's own words
        if not data.get("safety_id"):
            row.title, row.body = ev.title, ev.body
        if ev.target_kind == "run" or row.target_kind != "run":
            row.target_kind, row.target_id = ev.target_kind, ev.target_id
    else:
        row.title, row.body = (
            _group_title(ev.kind, items, row.count),
            _group_body(items, row.count),
        )
        row.data = json.dumps({**_loads(row.data, {}), **data})


def enqueue(kind: str, **fields) -> None:
    """Record an event from synchronous code (the schedules' own feed); the loop writes it within a second."""
    _pending.append({"kind": kind, **fields})
    mark_dirty()


async def flush_pending() -> int:
    """Write the events queued by synchronous callers."""
    n = 0
    while _later:
        fn, arg = _later.popleft()
        await fn(arg)
        n += 1
    while _pending:
        item = _pending.popleft()
        kind = item.pop("kind")
        names = item.pop("names", None)
        try:
            await _prepare_pending(item, names)
            await emit(kind, **item)
            n += 1
        except Exception:  # noqa: BLE001 - a notification never breaks the feature that sent it
            logger.exception("Could not record a %s notification", kind)
    return n


async def _prepare_pending(item: dict, names: list[str] | None) -> None:
    """A queued event's names become recipient keys, and a scheduled slot points at its last run."""
    async with database.async_session() as s:
        if names is not None:
            item["recipients"] = await recipient_keys(s, item.get("project_id"), names)
        # the bell on a ticket brings "comments, runs and schedule events of this ticket" (design, Notifications)
        watched = item.pop("follow_ticket", None)
        if watched:
            item["recipients"] = list(
                dict.fromkeys(
                    [
                        *(item.get("recipients") or []),
                        *await followers(s, "ticket", watched),
                    ]
                )
            )
        if item.get("target_kind") == "schedule_run" and item.get("target_id"):
            await _point_at_last_run(s, item)


async def _point_at_last_run(session: AsyncSession, item: dict) -> None:
    """A scheduled slot points at its last run, so Retry and "retried" work as for any run."""
    from models import AiScheduleRun

    srun = await session.get(AiScheduleRun, item["target_id"])
    run_ids = _loads(srun.run_ids, []) if srun else []
    if run_ids:
        item["data"] = {
            **(item.get("data") or {}),
            "srun_id": item["target_id"],
        }
        item["target_kind"], item["target_id"] = "run", run_ids[-1]


_GROUP_TITLES = {
    "ai_finished": "{n} AI finished work",
    "schedule": "{n} scheduled runs ended",
    "schedule_started": "{n} scheduled runs started",
    "page_published": "{n} pages were published",
    "comment": "{n} new comments in threads you follow",
    "run_cancelled": "{n} runs were cancelled",
    "budget_warning": "{n} budget warnings",
    "access_request": "{n} people asked for access to Docs",
}


def _group_title(kind: str, items: list[dict], count: int) -> str:
    if kind == "run_restarted":
        tid = items[-1].get("ticket_id") or "A run"
        return f"{tid}: restarted {count} times (memory)"
    n = "20+" if count > GROUP_NAMES_MAX else str(count)
    return _GROUP_TITLES.get(kind, "{n} updates").format(n=n)


def _group_body(items: list[dict], count: int | None = None) -> str:

    total = count or len(items)
    if total > GROUP_NAMES_MAX:
        return f"{total} in 10 minutes"
    names: list[str] = []
    for i in items:
        who = i.get("actor") or ""
        if who and who not in names:
            names.append(who)
    tickets = sorted(
        {i["ticket_id"] for i in items if i.get("ticket_id")}, key=_ticket_order
    )
    parts = []
    if names:
        shown = names[:4]
        more = len(names) - len(shown)
        parts.append(", ".join(shown) + (f" and {more} more" if more > 0 else ""))
    if tickets:
        parts.append(
            tickets[0] if len(tickets) == 1 else f"{tickets[0]} to {tickets[-1]}"
        )
    return " · ".join(parts)


def _ticket_order(t: str):
    m = re.match(r"([A-Za-z]+)-(\d+)$", t)
    return (m.group(1), int(m.group(2))) if m else (t, 0)


# ---------------------------------------------------------------------------
# Resolving: a Needs you row closes itself
# ---------------------------------------------------------------------------


async def _resolve_rows(
    session: AsyncSession,
    rows: list[Notification],
    reason: str,
    by: str | None,
    *,
    gone: bool = False,
) -> int | None:
    """Mark rows done with why, and write one resolve event per target to the log."""
    if not rows:
        return None
    at = now_iso()
    targets: dict[tuple, list[str]] = {}
    for r in rows:
        r.done_at = at
        r.done_reason = reason
        r.done_by = by
        r.snoozed_until = None
        if gone:
            r.data = json.dumps({**_loads(r.data, {}), "gone": True})
        session.add(r)
        targets.setdefault(
            (r.kind, r.target_kind, r.target_id, r.project_id, r.ticket_id), []
        ).append(r.recipient)
    last = None
    for (kind, tk, tid, pid, ticket), keys in targets.items():
        ev = NotifyEvent(
            project_id=pid,
            kind=kind,
            op="resolve",
            needs=True,
            target_kind=tk,
            target_id=tid,
            ticket_id=ticket,
            actor=by,
            title=reason,
            recipients=json.dumps(sorted(set(keys))),
            data=json.dumps({"gone": gone}),
        )
        session.add(ev)
        await session.flush()
        last = ev.id
    await session.commit()
    await _announce(last)
    return last


async def resolve_target(
    target_kind: str,
    target_id: str,
    reason: str,
    *,
    by: str | None = None,
    kinds: Iterable[str] | None = None,
) -> int:
    """Close every open Needs you row that points at this thing (for every recipient)."""
    async with database.async_session() as session:
        stmt = select(Notification).where(
            Notification.target_kind == target_kind,
            Notification.target_id == target_id,
            Notification.needs == True,  # noqa: E712
            col(Notification.done_at).is_(None),
        )
        if kinds:
            stmt = stmt.where(col(Notification.kind).in_(list(kinds)))
        rows = list((await session.exec(stmt)).all())
        await _resolve_rows(session, rows, reason, by)
        return len(rows)


_VIA = {
    "mcp": " over MCP",
    "ticket": " in the ticket",
    "ai_team": " in AI Team",
    "notification": " from the notification",
    "toast": " from the notification",
}


# Why a Needs you row closed: (reason with {who}, by, gone), or None while it still needs someone
_Why = tuple[str, str | None, bool] | None


async def _why_closed(session: AsyncSession, r: Notification) -> _Why:
    """Why an open Needs you row no longer needs anyone: (reason with {who}, by, gone), or None while it still does."""
    if r.ticket_id and await session.get(Ticket, r.ticket_id) is None:
        return f"{r.ticket_id} was deleted, so this cannot be answered.", None, True
    if r.target_kind == "run" and r.target_id:
        run = await session.get(AiRun, r.target_id)
        if run is None:
            return "The run is gone.", None, True
        if r.kind == "question":
            return _why_question_closed(run)
    return await _why_closed_by_kind(session, r)


async def _why_closed_by_kind(session: AsyncSession, r: Notification) -> _Why:
    """`_why_closed` once the ticket and the run it points at are still there."""
    if r.kind in ("run_stuck",) and r.target_kind == "run" and r.target_id:
        return await _why_trouble_closed(session, r.target_id)
    if r.kind in ("run_failed", "run_stopped_memory", "board_fault") and r.ticket_id:
        return await _why_retried(session, r)
    if r.kind == "window_urgent" and r.target_id:
        return await _why_window_closed(session, r.target_id)
    if r.kind in ("merge_conflict", "arbitration"):
        return await _why_flag_closed(session, r)
    if r.kind == "workflow_step" and r.target_id:
        from models import AiTicketStep

        step = await session.get(AiTicketStep, r.target_id)
        if step is None or step.state != "waiting":
            return "{who} decided it.", None, False
    if r.target_kind == "approval" and r.target_id:
        return await _why_approval_closed(session, r.target_id)
    if r.target_kind == "account" and r.target_id:
        return await _why_account_closed(session, r.target_id)
    if r.target_kind == "thread" and r.target_id:
        return await _why_thread_closed(session, r)
    if r.kind == "budget":
        return await _why_budget_closed(session, r)
    if r.kind == "auto_trip":
        return await _why_pause_closed(session, r)
    return None


def _why_question_closed(run: AiRun) -> _Why:
    if run.state == "needs_input":
        return None
    q = _loads(run.question, {}) or {}
    if q.get("answered_at"):
        where = _VIA.get(q.get("answered_via") or "", " in the ticket")
        return "{who} answered" + where, q.get("answered_by"), False
    return (
        f"The run ended ({run.state.replace('_', ' ')}).",
        run.ended_by,
        False,
    )


async def _why_trouble_closed(session: AsyncSession, run_id: str) -> _Why:
    """A run in trouble: the row closes once it moved again, someone chose to wait, or the run ended."""
    run = await session.get(AiRun, run_id)
    if run is None:
        return "The run is gone.", None, True
    if run.state not in ("running", "starting"):
        return f"The run ended ({run.state.replace('_', ' ')}).", run.ended_by, False
    diag = _loads(run.diagnosis, {}) or {}
    if not diag or diag.get("cleared_at"):
        return diag.get("cleared_why") or "It started moving again.", None, False
    return None


async def _why_window_closed(session: AsyncSession, run_id: str) -> _Why:
    run = await session.get(AiRun, run_id)
    if run is None:
        return "The run is gone.", None, True
    if run.state != "queued":
        return "The run started.", None, False
    return None


async def _why_flag_closed(session: AsyncSession, r: Notification) -> _Why:
    """A merge conflict or an arbitration closes when the ticket no longer carries the flag (services/ai/flags)."""
    return None


async def _why_retried(session: AsyncSession, r: Notification) -> _Why:
    # Retry answers every failure of the ticket: a run started after the latest one closes the row
    newer = (
        await session.exec(
            select(AiRun)
            .where(
                AiRun.ticket_id == r.ticket_id,
                AiRun.mode == "work",
                col(AiRun.queued_at) > r.updated_at,
            )
            .order_by(col(AiRun.queued_at))
        )
    ).first()
    if newer is not None:
        return (
            f"{{who}} retried: run #{newer.number} started",
            newer.started_by,
            False,
        )
    return None


async def _why_approval_closed(session: AsyncSession, approval_id: str) -> _Why:
    return "The request is gone.", None, True


async def _why_account_closed(session: AsyncSession, account_id: str) -> _Why:
    acc = await session.get(AiAccount, account_id)
    if acc is None:
        return "The account was removed.", None, True
    # only a confirmed sign-in closes it: a CLI briefly off PATH (cli_missing) says nothing about the sign-in
    if acc.status != "signed_in":
        return None
    return "The account signed in again", None, False


async def _why_thread_closed(session: AsyncSession, r: Notification) -> _Why:
    thread = await session.get(DocsCommentThread, r.target_id)
    if thread is None:
        return "The thread is gone.", None, True
    if r.recipient.startswith("ai:"):
        return None
    replies = (
        await session.exec(
            select(DocsComment).where(
                DocsComment.thread_id == r.target_id,
                col(DocsComment.created_at) > r.created_at,
            )
        )
    ).all()
    if any(person_key(c.author) == r.recipient for c in replies):
        return "{who} replied", r.recipient, False
    return None


async def _why_budget_closed(session: AsyncSession, r: Notification) -> _Why:
    day = _local(_parse(r.created_at) or datetime.now(UTC)).date()
    if day != _local(datetime.now(UTC)).date():
        return "The day rolled over", None, False
    if not r.member_id:
        return None
    return None


async def _why_pause_closed(session: AsyncSession, r: Notification) -> _Why:
    """Pause all AI of a project, or one AI member paused (auto-trip)."""
    if r.project_id and r.target_kind in (None, "project"):
        s = await session.get(AiProjectSettings, r.project_id)
        if s is not None and not s.paused_all:
            return "AI was resumed", None, False
        return None
    if r.target_kind == "member" and r.target_id:
        profile = await session.get(AiTeam, r.target_id)
        if profile is None:
            return "The AI member was removed.", None, True
        if not profile.paused:
            return "The AI member was resumed", None, False
    return None


_reconcile_lock: asyncio.Lock | None = None


async def reconcile() -> int:
    """Close every open Needs you row whose thing no longer needs a person, and note AI accounts that signed out.
    Cheap: it reads only open Needs you rows. One at a time (requests and the loop both call it), so an account is
    noted and a row resolved once. Returns how many rows closed."""
    global _reconcile_lock
    if _reconcile_lock is None:
        _reconcile_lock = asyncio.Lock()
    try:
        async with _reconcile_lock:
            return await _reconcile()
    except (
        RuntimeError
    ):  # the lock was made on another event loop (tests): make a new one
        _reconcile_lock = asyncio.Lock()
        async with _reconcile_lock:
            return await _reconcile()


async def _reconcile() -> int:
    closed = 0
    await flush_pending()
    async with database.async_session() as session:
        await _watch_accounts(session)
        groups = list((await _open_needs_groups(session)).values())
        # rows that only their target going away can close are checked together, in a few queries
        static = [g for g in groups if not _closes_by_itself(g[0])]
        alive = await _alive_targets(session, [g[0] for g in static])
        for same in groups:
            try:
                if _closes_by_itself(same[0]):
                    why = await _why_closed(session, same[0])
                else:
                    why = _why_gone(same[0], alive)
            except Exception:  # noqa: BLE001
                logger.exception("Could not check notification %s", same[0].id)
                continue
            if why is None:
                continue
            reason, by, gone = why
            if gone:
                # The row says so and offers only Dismiss; it is not closed quietly
                await _mark_gone(session, same, reason)
                continue
            await _resolve_rows(session, list(same), reason, by)
            closed += len(same)
    return closed


# A row whose target is gone says so once (`_mark_gone`) and then waits for Dismiss: nothing closes it by itself
_GONE = '"gone": true'


async def _open_needs_groups(
    session: AsyncSession,
) -> dict[tuple, list[Notification]]:
    """The open Needs you rows, by what they point at (each group is judged once). Rows already marked gone are left
    out: nothing but Dismiss closes them."""
    rows = (
        await session.exec(
            select(Notification).where(
                Notification.needs == True,  # noqa: E712
                col(Notification.done_at).is_(None),
                not_(col(Notification.data).contains(_GONE)),
            )
        )
    ).all()
    groups: dict[tuple, list[Notification]] = {}
    for r in rows:
        # a reply closes the mention of the person who replied, not everyone's: threads are judged per row
        who = r.recipient if r.target_kind == "thread" else ""
        groups.setdefault(
            (r.kind, r.target_kind, r.target_id, r.ticket_id, r.project_id, who),
            [],
        ).append(r)
    return groups


def _closes_by_itself(r: Notification) -> bool:
    """Whether something other than its target going away can close a row. A blocked or offline row closes only by
    Dismiss, and a mention of an AI member only when its thread goes (an AI does not reply in Docs)."""
    if r.kind in ("blocked", "offline"):
        return r.target_kind in ("approval", "account", "thread")
    if r.kind == "mention" and r.target_kind == "thread":
        return not r.recipient.startswith("ai:")
    return True


async def _alive_targets(
    session: AsyncSession, rows: list[Notification]
) -> dict[str, set[str]]:
    """Which of the tickets, runs and threads these rows point at still exist: one query per table, not per row."""
    wanted: dict[str, set[str]] = {"ticket": set(), "run": set(), "thread": set()}
    for r in rows:
        if r.ticket_id:
            wanted["ticket"].add(r.ticket_id)
        if r.target_kind in ("run", "thread") and r.target_id:
            wanted[r.target_kind].add(r.target_id)
    models = {"ticket": Ticket, "run": AiRun, "thread": DocsCommentThread}
    alive: dict[str, set[str]] = {}
    for name, ids in wanted.items():
        model = models[name]
        found: set[str] = set()
        chunk = sorted(ids)
        for i in range(0, len(chunk), 500):
            found.update(
                (
                    await session.exec(
                        select(model.id).where(col(model.id).in_(chunk[i : i + 500]))
                    )
                ).all()
            )
        alive[name] = found
    return alive


def _why_gone(r: Notification, alive: dict[str, set[str]]) -> _Why:
    """`_why_closed` of a row that does not close by itself: only its ticket, run or thread going away changes it."""
    if r.ticket_id and r.ticket_id not in alive["ticket"]:
        return f"{r.ticket_id} was deleted, so this cannot be answered.", None, True
    if r.target_kind == "run" and r.target_id and r.target_id not in alive["run"]:
        return "The run is gone.", None, True
    if r.target_kind == "thread" and r.target_id and r.target_id not in alive["thread"]:
        return "The thread is gone.", None, True
    return None


async def _mark_gone(
    session: AsyncSession, rows: list[Notification], reason: str
) -> None:
    """The thing a row points at is gone: the row says so (once) and offers only Dismiss."""
    changed = False
    for r in rows:
        d = _loads(r.data, {})
        if not d.get("gone"):
            d["gone"] = True
            d["gone_reason"] = reason
            r.data = json.dumps(d)
            r.updated_at = now_iso()
            session.add(r)
            changed = True
    if changed:
        await session.commit()
        await _announce(await head_id(session))


async def _watch_accounts(session: AsyncSession) -> None:
    """One Needs you notification per AI account that was found signed out (not per member on it)."""
    rows = (
        await session.exec(
            select(AiAccount).where(
                AiAccount.status == "needs_sign_in",
                col(AiAccount.signed_out_at).is_not(None),
            )
        )
    ).all()
    for acc in rows:
        if await _sign_out_noted(session, acc):
            continue
        on = (
            await session.exec(select(AiTeam).where(AiTeam.account_id == acc.id))
        ).all()
        projects = sorted({p.project_id for p in on})
        n = len(on)
        body = "No AI member uses it right now."
        if n:
            body = f"{n} AI member{_s(n)} on this account stopped. Their queued runs are held."
        await emit(
            "account_signed_out",
            project_id=projects[0] if len(projects) == 1 else None,
            recipients=await _user_and_admins_of(session, projects),
            title=f"{acc.name} is signed out",
            body=body,
            target_kind="account",
            target_id=acc.id,
            data={"members": n, "how": acc.signed_out_how},
            session=session,
        )


async def _sign_out_noted(session: AsyncSession, acc: AiAccount) -> bool:
    """Whether this sign-out of the account was already told."""
    seen = (
        await session.exec(
            select(NotifyEvent).where(
                NotifyEvent.kind == "account_signed_out",
                NotifyEvent.target_id == acc.id,
                NotifyEvent.op == "new",
                col(NotifyEvent.created_at) >= (acc.signed_out_at or ""),
            )
        )
    ).first()
    return seen is not None


async def _user_and_admins_of(
    session: AsyncSession, project_ids: list[str]
) -> list[str]:
    """The board's own user, then the owners and admins of these projects, each once."""
    recipients = ["user"]
    for pid in project_ids:
        for k in await owners_and_admins(session, pid):
            if k not in recipients:
                recipients.append(k)
    return recipients


# ---------------------------------------------------------------------------
# What the features write (the six notifiers of the app moved here, to the server)
# ---------------------------------------------------------------------------


async def _run_people(session: AsyncSession, run: AiRun) -> list[str]:
    """Who hears about a run: the person it acts for, the ticket's followers and its assignee; when it was started
    by an AI (a chain), the owners and admins too, so a person always hears of it."""
    keys = await recipient_keys(session, run.project_id, [run.started_by])
    ticket = await session.get(Ticket, run.ticket_id)
    if ticket is not None and ticket.assignee:
        m = await session.get(Member, ticket.assignee)
        if m is not None and m.kind == "human":
            keys += [person_key(m.name)]
    keys += await followers(session, "ticket", run.ticket_id)
    if not any(not k.startswith("ai:") for k in keys):
        keys += await owners_and_admins(session, run.project_id)
    out: list[str] = []
    for k in keys:
        if k not in out:
            out.append(k)
    return out


async def on_run_question(
    run_id: str,
    *,
    reminder: bool = False,
    passed_to: str | None = None,
    by: str | None = None,
) -> None:
    """An AI asked and its run paused: a question for the person it asked (Needs you). A `reminder` (15 min, then
    every 2 h unanswered) brings the same row back to the top and toasts again, without counting as a new item.
    `passed_to`: the question was passed to this person ("Ask someone else", by `by`); whoever is no longer one of
    its recipients sees their row close ("Passed to Hoa Mai")."""
    try:
        async with database.async_session() as session:
            run = await session.get(AiRun, run_id)
            if run is None:
                return
            q = _loads(run.question, {}) or {}
            member = await session.get(Member, run.member_id)
            name = member.name if member else _AN_AI_MEMBER
            keys = await recipient_keys(
                session, run.project_id, [q.get("to"), run.started_by]
            )
            if not any(not k.startswith("ai:") for k in keys):
                keys += await owners_and_admins(session, run.project_id)
            await emit(
                "question",
                project_id=run.project_id,
                recipients=keys,
                title=f"{name} asks a question",
                body=f"“{(q.get('text') or '').strip()[:400]}”",
                target_kind="run",
                target_id=run.id,
                ticket_id=run.ticket_id,
                member_id=run.member_id,
                actor=name,
                since=q.get("asked_at"),
                data={
                    "to": q.get("to"),
                    "options": q.get("options") or [],
                    "run_number": run.number,
                    **({"reminder": True} if reminder else {}),
                },
                session=session,
            )
            if passed_to:
                await _close_passed_question(session, run, keys, passed_to, by)
    except Exception:  # noqa: BLE001 - a notification never breaks a run
        # the run id can come from a request: it is not written to the log (log injection)
        logger.exception("Could not write a question notification")


async def _close_passed_question(
    session: AsyncSession,
    run: AiRun,
    keys: list[str],
    passed_to: str,
    by: str | None,
) -> None:
    """A question passed to someone else: the open rows of the people it is no longer addressed to close."""
    group_key = _group_key("question", run.project_id, "run", run.id, run.ticket_id)
    stale = (
        await session.exec(
            select(Notification).where(
                Notification.group_key == group_key,
                col(Notification.done_at).is_(None),
                col(Notification.recipient).not_in(keys),
            )
        )
    ).all()
    await _resolve_rows(session, list(stale), f"Passed to {passed_to}", by)


async def on_run_ended(run_id: str) -> None:
    """A run ended: finished work (for information, grouped), failed or timed out (Needs you), or cancelled
    because its ticket was archived (for information). A scheduled run is told by its schedule instead."""
    try:
        async with database.async_session() as session:
            run = await session.get(AiRun, run_id)
            if run is None:
                return
            member = await session.get(Member, run.member_id)
            name = member.name if member else _AN_AI_MEMBER
            keys = await _run_people(session, run)
            notice = _run_end_notice(run, name)
            if notice is None:
                return
            kind, title, body = notice
            await emit(
                kind,
                project_id=run.project_id,
                recipients=keys,
                title=title,
                body=body,
                target_kind="run",
                target_id=run.id,
                ticket_id=run.ticket_id,
                member_id=run.member_id,
                actor=name,
                data={
                    "run_number": run.number,
                    "state": run.state,
                    "cost_usd": run.cost_usd,
                    **(
                        {"diagnosis": _loads(run.diagnosis, None)}
                        if run.diagnosis and kind != "ai_finished"
                        else {}
                    ),
                },
                session=session,
            )
    except Exception:  # noqa: BLE001
        logger.exception("Could not write a run end notification")


async def on_run_trouble(run_id: str) -> None:
    """A running AI stopped moving and the board diagnosed it (design C, D): one Needs you row per run and cause,
    carrying the diagnosis and the actions it allows. A board fault comes straight to people."""
    try:
        async with database.async_session() as session:
            run = await session.get(AiRun, run_id)
            if run is None:
                return
            diag = _loads(run.diagnosis, {}) or {}
            member = await session.get(Member, run.member_id)
            name = member.name if member else _AN_AI_MEMBER
            keys = await _run_people(session, run)
            keys += [
                k
                for k in await owners_and_admins(session, run.project_id)
                if k not in keys
            ]
            kind = "run_stuck"  # a board fault while running is the same card, marked board fault in its data
            title = f"{name} has produced nothing for {max(1, int(diag.get('quiet_s', 0)) // 60)} min on {run.ticket_id}"
            if diag.get("cause") == "busy":
                title = f"{name} is still working on {run.ticket_id}: one command has run a long time"
            await emit(
                kind,
                project_id=run.project_id,
                recipients=keys,
                title=title,
                body=f"{diag.get('what', '')} {diag.get('means', '')}".strip()[:600],
                target_kind="run",
                target_id=run.id,
                ticket_id=run.ticket_id,
                member_id=run.member_id,
                actor=name,
                data={"run_number": run.number, "diagnosis": diag},
                session=session,
            )
    except Exception:  # noqa: BLE001
        logger.exception("Could not write a run trouble notification")


async def on_window_urgent(run_id: str, *, until: str, room: list[dict]) -> None:
    """Urgent work waits for a usage window and no other account has room (or moving is off): Needs you."""
    try:
        async with database.async_session() as session:
            run = await session.get(AiRun, run_id)
            if run is None:
                return
            keys = await _run_people(session, run)
            keys += [
                k
                for k in await owners_and_admins(session, run.project_id)
                if k not in keys
            ]
            when = ""
            try:
                when = datetime.fromisoformat(until).astimezone().strftime("%H:%M")
            except ValueError:
                pass
            await emit(
                "window_urgent",
                project_id=run.project_id,
                recipients=keys,
                title=f"Urgent {run.ticket_id} waits for the usage window (reopens {when})",
                body=(
                    f"{len(room)} other account{'s have' if len(room) != 1 else ' has'} room: move it there."
                    if room
                    else "No other Claude account has room right now."
                ),
                target_kind="run",
                target_id=run.id,
                ticket_id=run.ticket_id,
                member_id=run.member_id,
                data={"until": until, "room": room},
                session=session,
            )
    except Exception:  # noqa: BLE001
        logger.exception("Could not write a usage window notification")


def _run_end_notice(run: AiRun, name: str) -> tuple[str, str, str] | None:
    """(kind, title, body) of what a run's end tells, or None when it tells nothing here."""
    if run.state == "finished" and run.mode == "work":
        return _finished_notice(run, name)
    if run.state in ("failed", "timed_out") and run.mode == "work":
        return _failed_notice(run)
    if run.state == "cancelled" and run.stop_code == "archive":
        by = f" by {run.ended_by}" if run.ended_by else ""
        return (
            "run_cancelled",
            f"{run.ticket_id} was archived{by}",
            f"Run #{run.number} was cancelled. Files stay on the branch.",
        )
    return None


def _finished_notice(run: AiRun, name: str) -> tuple[str, str, str] | None:
    if run.trigger == "schedule":
        return None
    report = _loads(run.report, {}) or {}
    summary = (report.get("summary") or run.summary or "").strip().splitlines()
    body = summary[0][:200] if summary else "AI summary ready for review."
    return "ai_finished", f"{name} finished {run.ticket_id}", body


def _failed_notice(run: AiRun) -> tuple[str, str, str] | None:
    if run.stop_code == "memory":
        return None  # "stopped for memory" was written by the safety event
    if run.trigger == "schedule":
        return None  # its schedule tells the slot's failure, once
    verb = "failed" if run.state == "failed" else "timed out"
    diag = _loads(run.diagnosis, {}) or {}
    if diag.get("board_fault"):
        return (
            "board_fault",
            f"The board failed run #{run.number} on {run.ticket_id}",
            (diag.get("what") or run.ended_reason or "")[:400],
        )
    return (
        "run_failed",
        f"Run #{run.number} on {run.ticket_id} {verb}",
        (run.ended_reason or "")[:400],
    )


async def on_blocked_move(run_id: str, target: str) -> None:
    """An AI tried to move a ticket past its permission (Needs you: change the permission, or dismiss)."""
    try:
        async with database.async_session() as session:
            run = await session.get(AiRun, run_id)
            if run is None:
                return
            member = await session.get(Member, run.member_id)
            name = member.name if member else _AN_AI_MEMBER
            label = (
                "Done" if target == "done" else target.replace("-", " ").capitalize()
            )
            await emit(
                "blocked",
                project_id=run.project_id,
                recipients=await _run_people(session, run),
                title=f"{name} can’t move {run.ticket_id} to {label}",
                body="Its permission stops before that. The ticket stays where it is.",
                target_kind="ticket",
                target_id=run.ticket_id,
                ticket_id=run.ticket_id,
                member_id=run.member_id,
                actor=name,
                data={"to": target, "run_id": run.id},
                session=session,
            )
    except Exception:  # noqa: BLE001
        logger.exception("Could not write a blocked-move notification")


async def on_page_published(page: dict[str, Any], note: str | None = None) -> None:
    """A page was published: for the people who follow its space or the page (not the author)."""
    try:
        async with database.async_session() as session:
            keys = await followers(session, "space", page.get("project_id"))
            keys += await followers(session, "page", page.get("id"))
            author = page.get("updated_by") or "user"
            await emit(
                "page_published",
                project_id=page.get("project_id"),
                recipients=keys,
                title=f"{author} published v{page.get('version')} of {page.get('title')}",
                body=(note or "").strip()[:300],
                target_kind="page",
                target_id=page.get("id"),
                page_id=page.get("id"),
                actor=author,
                data={"version": page.get("version"), "path": page.get("path")},
                session=session,
            )
    except Exception:  # noqa: BLE001
        logger.exception("Could not write the publish notification")


_background: set[asyncio.Task] = set()


def comment_event(e: Any, session: Any = None) -> None:
    """Called where a Docs comment event is added. In the board's server the loop writes it within a second; in a
    process without the loop (the stdio MCP server) it is written right after `session` commits (or now, when it
    was already committed)."""
    fields = {
        "project_id": e.project_id,
        "page_id": e.page_id,
        "thread_id": e.thread_id,
        "comment_id": e.comment_id,
        "kind": e.kind,
        "actor": e.actor,
        "mentioned": e.mentioned,
        "recipients": e.recipients,
        "page_title": e.page_title,
        "snippet": e.snippet,
    }
    if _task is not None and not _task.done():
        _later.append((on_comment_event, fields))
        mark_dirty()
        return

    def run(*_args) -> None:
        try:
            t = asyncio.get_running_loop().create_task(on_comment_event(fields))
        except RuntimeError:
            return
        _background.add(t)
        t.add_done_callback(_background.discard)

    if session is not None:
        from sqlalchemy import event as sa_event

        sa_event.listen(session.sync_session, "after_commit", run, once=True)
    else:
        run()


async def on_comment_event(fields: dict) -> None:
    """A Docs comment event: a mention is Needs you (replying or Dismiss closes it); a reply in a thread you follow
    and an access request are for information."""
    from types import SimpleNamespace

    try:
        e = SimpleNamespace(**fields)
        async with database.async_session() as session:
            names = _loads(e.recipients, [])
            mentioned = {person_key(n) for n in _loads(e.mentioned, [])}
            who = "Someone" if person_key(e.actor) == "user" else e.actor
            keys = await recipient_keys(session, e.project_id, names)
            for key in keys:
                kind, title = _comment_notice(e, who, mentioned=key in mentioned)
                await emit(
                    kind,
                    project_id=e.project_id,
                    recipients=[key],
                    title=title,
                    body=_comment_body(e, kind),
                    target_kind="thread" if e.thread_id else None,
                    target_id=e.thread_id,
                    page_id=e.page_id,
                    actor=e.actor,
                    data={
                        "page_title": e.page_title,
                        "comment_id": e.comment_id,
                        "event": e.kind,
                    },
                    session=session,
                )
    except Exception:  # noqa: BLE001
        logger.exception("Could not write a comment notification")


def _comment_notice(e: Any, who: str, *, mentioned: bool) -> tuple[str, str]:
    """(kind, title) of a Docs comment event for one recipient."""
    if e.kind == "access_request":
        return "access_request", f"{who} asked for access to Docs"
    if mentioned:
        return "mention", f"{who} mentioned you"
    if e.kind in ("resolved", "reopened"):
        return "comment", f"{who} {e.kind} a thread on {e.page_title}"
    return "comment", "New reply in a thread you follow"


def _comment_body(e: Any, kind: str) -> str:
    """The comment's words; a reply in a followed thread says who wrote them."""
    if not e.snippet:
        return ""
    if kind == "comment":
        return f"{e.actor}: “{e.snippet}”"
    return f"“{e.snippet}”"


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------


def _actions(r: Notification, gone: bool) -> list[dict]:
    if r.done_at:
        return []
    if gone:
        return [{"id": "dismiss", "label": "Dismiss"}]
    k = r.kind
    if k == "question":
        return [
            {"id": "answer", "label": "Answer"},
            {"id": "open_ticket", "label": "Open ticket"},
        ]
    if k == "approval":
        return [
            {"id": "approve", "label": "Approve"},
            {"id": "deny", "label": "Deny"},
            {"id": "review", "label": "Review"},
        ]
    if k == "page_proposal":
        return [{"id": "review", "label": "Review"}]
    if k in ("run_failed", "run_stopped_memory", "board_fault"):
        # a stopped run: the four ways out, always in this order (design D)
        return [
            {"id": "retry", "label": "Try again"},
            {"id": "continue_note", "label": "Continue with a note"},
            {"id": "hand_to", "label": "Hand to another AI"},
            {"id": "open_run_log", "label": "Open the run"},
        ]
    if k == "run_stuck":
        labels = {
            "stop_child": "Stop that command, keep the run",
            "tell_ai": "Tell the AI to run it in the background",
            "wait": "Wait, tell me again at 30 min",
            "continue_note": "Continue with a note",
            "cancel": "Cancel the run",
        }
        diag = (_loads(r.data, {}) or {}).get("diagnosis") or {}
        ids = [
            a
            for a in diag.get("actions") or ["continue_note", "wait", "cancel"]
            if a in labels
        ]
        return [{"id": f"trouble:{a}", "label": labels[a]} for a in ids] + [
            {"id": "open_run_log", "label": "Open the run"}
        ]
    if k == "merge_conflict":
        return [
            {"id": "conflict:ai", "label": "Hand it to an AI"},
            {"id": "conflict:me", "label": "I will do it"},
            {"id": "open_ticket", "label": "Open ticket"},
        ]
    if k == "arbitration":
        return [
            {"id": "arbitration:reviewer", "label": "Side with Reviewer"},
            {"id": "arbitration:dev", "label": "Side with Dev"},
            {"id": "arbitration:split", "label": "Split the ticket"},
            {"id": "open_ticket", "label": "Read the arbitration"},
        ]
    if k == "workflow_step":
        return [
            {"id": "workflow:approve", "label": "Approve"},
            {"id": "workflow:send_back", "label": "Send back"},
            {"id": "open_ticket", "label": "Open ticket"},
        ]
    if k == "window_urgent":
        return [
            {"id": "move_account", "label": "Move urgent work"},
            {"id": "open_ai", "label": "Open accounts"},
        ]
    if k == "account_signed_out":
        return [{"id": "sign_in", "label": "Sign in again"}]
    if k == "mention":
        return [{"id": "reply", "label": "Reply"}, {"id": "open", "label": "Open"}]
    if k == "blocked":
        return [
            {"id": "open_ticket", "label": "Open ticket"},
            {"id": "change_permission", "label": "Change permission"},
        ]
    if k in ("budget", "auto_trip", "offline"):
        return [{"id": "open_ai", "label": "Open AI Team"}]
    if k == "day_card":
        return [{"id": "open", "label": "Open"}]
    if k == "schedule_started" and r.count <= 1:
        return [{"id": "open_run_log", "label": "Open run"}]
    if (
        k == "schedule"
        and r.count <= 1
        and (_loads(r.data, {}) or {}).get("event") == "skipped"
        and (_loads(r.data, {}) or {}).get("schedule_id")
    ):
        # design E4: a skipped slot offers to plan it again
        return [
            {"id": "reschedule", "label": "Reschedule"},
            {"id": "open", "label": "Open"},
        ]
    if r.count > 1:
        return [{"id": "expand", "label": f"Show all {r.count}"}]
    return [{"id": "open", "label": "Open"}]


def _done_text(r: Notification, me: str) -> str | None:
    if not r.done_at:
        return None
    reason = r.done_reason or "Done"
    if "{who}" in reason:
        who = (
            "you"
            if (r.done_by and person_key(r.done_by) == me)
            else (r.done_by or "someone")
        )
        reason = reason.replace("{who}", who)
    return reason[:1].upper() + reason[1:]


def to_dict(r: Notification, me: str, names: dict[str, str] | None = None) -> dict:
    """A row for the API, as `me` sees it."""
    data = _loads(r.data, {})
    gone = bool(data.get("gone"))
    now = datetime.now(UTC)
    snoozed = bool(r.snoozed_until and (_parse(r.snoozed_until) or now) > now)
    return {
        "id": r.id,
        "kind": r.kind,
        "kind_label": KINDS.get(r.kind, (r.kind,))[0],
        "needs": r.needs,
        "project_id": r.project_id,
        "title": r.title,
        "body": r.body,
        "target_kind": r.target_kind,
        "target_id": r.target_id,
        "ticket_id": r.ticket_id,
        "page_id": r.page_id,
        "member_id": r.member_id,
        "member_name": (names or {}).get(r.member_id or "") if r.member_id else None,
        "actor": r.actor,
        "count": r.count,
        "items": _loads(r.items, []),
        "data": data,
        "inapp": r.inapp,
        "desktop": r.desktop,
        "read": r.read_at is not None,
        "read_at": r.read_at,
        "done": r.done_at is not None,
        "done_at": r.done_at,
        "done_text": _done_text(r, me),
        "done_by": r.done_by,
        "gone": gone,
        "gone_reason": data.get("gone_reason"),
        "snoozed": snoozed,
        "snoozed_until": r.snoozed_until if snoozed else None,
        "cleared": r.cleared_at is not None,
        "cleared_at": r.cleared_at,
        "group_key": r.group_key,
        "event_id": r.event_id,
        "last_event_id": r.last_event_id,
        "created_at": r.created_at,
        "updated_at": r.updated_at,
        "actions": _actions(r, gone),
        "reminded": bool(data.get("reminded_at")),
        "dismissable": (not r.done_at)
        and (gone or KINDS.get(r.kind, ("", False, False, False))[3]),
    }


async def member_names(
    session: AsyncSession, rows: list[Notification]
) -> dict[str, str]:
    """member id -> name of the members named by these rows."""
    ids = {r.member_id for r in rows if r.member_id}
    if not ids:
        return {}
    ms = (await session.exec(select(Member).where(col(Member.id).in_(ids)))).all()
    return {m.id: m.name for m in ms}


FILTERS = ("all", "unread", "needs", "snoozed", "done", "cleared")


async def list_rows(
    session: AsyncSession,
    me: str,
    *,
    view: str = "page",
    tab: str | None = None,
    filter: str = "all",
    q: str | None = None,
    project_id: str | None = None,
    kinds: list[str] | None = None,
    family: str | None = None,
    days: int | None = None,
    limit: int = 100,
    before: str | None = None,
) -> dict:
    """Rows of one recipient, newest activity first.

    view "panel": the last 30 days, quiet rows left out, cleared rows left out, snoozed rows left out; `tab` needs
    (Needs you, open first by waiting time, then today's done rows) or updates.
    view "page": everything still kept, with `filter` (All · Unread · Needs you · Snoozed · Done · Cleared).
    """
    now = datetime.now(UTC)
    stmt = _rows_stmt(
        me,
        now,
        view=view,
        tab=tab,
        q=q,
        project_id=project_id,
        kinds=kinds,
        family=family,
        days=days,
        before=before,
    )
    if view == "panel":
        stmt = stmt.where(_not_snoozed(now))
    else:
        stmt = _where_page_filter(stmt, filter, now)
    total = int(
        (await session.exec(select(func.count()).select_from(stmt.subquery()))).one()
        or 0
    )
    if view == "panel" and tab == "needs":
        # open first, the longest waiting first; then today's done rows, newest activity first
        open_first = col(Notification.done_at).is_(None)
        order = (
            not_(open_first),
            case((open_first, col(Notification.created_at)), else_=""),
            col(Notification.updated_at).desc(),
        )
    else:
        order = (col(Notification.updated_at).desc(),)
    page = list(
        (await session.exec(stmt.order_by(*order).limit(max(1, min(limit, 500))))).all()
    )
    names = await member_names(session, page)
    out = [to_dict(r, me, names) for r in page]
    day_card = None
    if view == "panel" and tab != "needs":
        day_card = await _day_card_dict(session, me)
    if view == "panel":
        out = [o for o in out if o["kind"] != "day_card"]
    return {
        "items": out,
        "total": total,
        "head": await head_id(session),
        "day_card": day_card,
        "now": now.isoformat(),
    }


def _rows_stmt(
    me: str,
    now: datetime,
    *,
    view: str,
    tab: str | None,
    q: str | None,
    project_id: str | None,
    kinds: list[str] | None,
    family: str | None,
    days: int | None,
    before: str | None,
):
    """The query of `list_rows`: the recipient's rows narrowed by the view, the tab and the page's filters."""
    stmt = select(Notification).where(Notification.recipient == me)
    if project_id:
        stmt = stmt.where(Notification.project_id == project_id)
    if kinds:
        stmt = stmt.where(col(Notification.kind).in_(kinds))
    stmt = _where_family(stmt, family)
    if view == "panel":
        days = PANEL_DAYS
        stmt = _where_panel(stmt, tab, now)
    if days:
        stmt = stmt.where(
            col(Notification.updated_at) >= (now - timedelta(days=days)).isoformat()
        )
    if before:
        stmt = stmt.where(col(Notification.updated_at) < before)
    if q:
        stmt = _where_search(stmt, q)
    return stmt


async def _day_card_dict(session: AsyncSession, me: str) -> dict | None:
    """The recipient's latest day card, the first row of the panel's Updates tab."""
    card = await _latest_day_card(session, me)
    return to_dict(card, me) if card is not None else None


# The Docs family (NT-5): rows about a page (a comment, a mention, a proposal) and the Docs kinds with no page
DOCS_KINDS = ("page_proposal", "page_published", "access_request")


def _where_family(stmt, family: str | None):
    """Only the rows of a family: ai | people | schedules | info | needs | docs (any other value: every row)."""
    if family == "needs":
        return stmt.where(Notification.needs == True)  # noqa: E712
    if family == "docs":
        return stmt.where(
            or_(
                col(Notification.page_id).is_not(None),
                col(Notification.kind).in_(DOCS_KINDS),
            )
        )
    if family == "ai":
        return stmt.where(col(Notification.member_id).is_not(None))
    if family == "people":
        return stmt.where(
            col(Notification.member_id).is_(None), col(Notification.kind) != "day_card"
        )
    if family == "schedules":
        return stmt.where(col(Notification.kind).in_(["schedule", "schedule_started"]))
    if family == "info":
        return stmt.where(Notification.needs == False)  # noqa: E712
    return stmt


def _where_panel(stmt, tab: str | None, now: datetime):
    """The bell panel: rows shown in app and not cleared; the Needs you tab keeps open rows and today's done ones."""
    stmt = stmt.where(
        Notification.inapp == True,  # noqa: E712
        col(Notification.cleared_at).is_(None),
    )
    if tab == "needs":
        today0 = (
            _local(now)
            .replace(hour=0, minute=0, second=0, microsecond=0)
            .astimezone(UTC)
        )
        return stmt.where(
            Notification.needs == True,  # noqa: E712
            or_(
                col(Notification.done_at).is_(None),
                col(Notification.done_at) >= today0.isoformat(),
            ),
        )
    if tab == "updates":
        return stmt.where(Notification.needs == False)  # noqa: E712
    return stmt


def _where_search(stmt, q: str):
    like = f"%{q.strip()}%"
    return stmt.where(
        or_(
            col(Notification.title).ilike(like),
            col(Notification.body).ilike(like),
            col(Notification.ticket_id).ilike(like),
            col(Notification.items).ilike(like),
        )
    )


def _is_snoozed(r: Notification, now: datetime) -> bool:
    return bool(r.snoozed_until and (_parse(r.snoozed_until) or now) > now)


def _snoozed(now: datetime):
    """A row hidden by a snooze that has not run out (times are kept as UTC ISO text, so they compare as text)."""
    return col(Notification.snoozed_until) > now.isoformat()


def _not_snoozed(now: datetime):
    return or_(
        col(Notification.snoozed_until).is_(None),
        col(Notification.snoozed_until) <= now.isoformat(),
    )


def _where_page_filter(stmt, filter: str | None, now: datetime):
    """The All notifications page's filter: all | unread | needs | snoozed | done | cleared."""
    if filter == "unread":
        return stmt.where(
            col(Notification.read_at).is_(None), col(Notification.cleared_at).is_(None)
        )
    if filter == "needs":
        return stmt.where(
            Notification.needs == True,  # noqa: E712
            col(Notification.done_at).is_(None),
            _not_snoozed(now),
        )
    if filter == "snoozed":
        return stmt.where(_snoozed(now))
    if filter == "done":
        return stmt.where(col(Notification.done_at).is_not(None))
    if filter == "cleared":
        return stmt.where(col(Notification.cleared_at).is_not(None))
    return stmt.where(col(Notification.cleared_at).is_(None))


async def _latest_day_card(session: AsyncSession, me: str) -> Notification | None:
    return (
        await session.exec(
            select(Notification)
            .where(Notification.recipient == me, Notification.kind == "day_card")
            .order_by(col(Notification.created_at).desc())
        )
    ).first()


async def counts(session: AsyncSession, me: str) -> dict:
    """The bell: the red number is open Needs you rows (not snoozed); a blue dot for unread updates. Counted in SQL,
    so it costs the same however long the history is."""
    now = datetime.now(UTC)
    since = (now - timedelta(days=PANEL_DAYS)).isoformat()
    shown = and_(
        Notification.inapp == True,  # noqa: E712
        col(Notification.cleared_at).is_(None),
    )
    unread = col(Notification.read_at).is_(None)
    needs_open = and_(
        shown,
        Notification.needs == True,  # noqa: E712
        col(Notification.done_at).is_(None),
        _not_snoozed(now),
    )
    updates = and_(
        shown,
        Notification.needs == False,  # noqa: E712
        col(Notification.updated_at) >= since,
    )

    def n(cond):
        return func.coalesce(func.sum(case((cond, 1), else_=0)), 0)

    row = (
        await session.exec(
            select(
                n(needs_open),
                n(and_(needs_open, unread)),
                n(and_(updates, unread, _not_snoozed(now))),
                n(updates),
                n(_snoozed(now)),
                n(and_(unread, col(Notification.cleared_at).is_(None))),
                func.min(case((needs_open, col(Notification.created_at)))),
            ).where(Notification.recipient == me)
        )
    ).one()
    needs, needs_unread, updates_unread, n_updates, snoozed, unread_all, oldest = row
    return {
        "needs": int(needs),
        "needs_unread": int(needs_unread),
        "updates_unread": int(updates_unread),
        "updates": int(n_updates),
        "snoozed": int(snoozed),
        "unread": int(unread_all),
        "head": await head_id(session),
        "oldest_needs_at": oldest,
    }


async def feed(session: AsyncSession, me: str, since: int | None) -> dict:
    """What moved since log id `since`, for this recipient: new or merged rows (toasts, the desktop notifier) and
    rows closed since (a toast or a desktop notice for them is withdrawn). A cursor older than what the log still
    keeps gets `cursor_too_old` and should start from `head`."""
    head = await head_id(session)
    g = await _global(session)
    pruned = int(g.get("pruned_through") or 0)
    # below what was deleted, or above the head (the database was restored or switched): start again from head
    too_old = since is not None and since > 0 and (since < pruned or since > head)
    if since is None or too_old:
        return {"head": head, "cursor_too_old": too_old, "items": [], "resolved": []}
    rows = (
        await session.exec(
            select(Notification).where(
                Notification.recipient == me,
                col(Notification.last_event_id) > since,
            )
        )
    ).all()
    resolved_events = (
        await session.exec(
            select(NotifyEvent).where(
                NotifyEvent.op == "resolve", col(NotifyEvent.id) > since
            )
        )
    ).all()
    resolved_targets = {(e.target_kind, e.target_id) for e in resolved_events}
    closed = []
    if resolved_targets:
        cand = (
            await session.exec(
                select(Notification).where(
                    Notification.recipient == me,
                    col(Notification.done_at).is_not(None),
                    col(Notification.target_id).in_(
                        [t[1] for t in resolved_targets if t[1]]
                    ),
                )
            )
        ).all()
        closed = [r.id for r in cand]
    prefs = await get_prefs(session, me)
    names = await member_names(session, list(rows))
    return {
        "head": head,
        "cursor_too_old": False,
        "items": [
            to_dict(r, me, names) for r in sorted(rows, key=lambda r: r.last_event_id)
        ],
        "resolved": closed,
        "quiet": in_quiet_hours(prefs),
        "dnd": bool(prefs.get("dnd")),
        "sound": bool(prefs.get("sound")),
        "sound_name": _sound_name(prefs),
    }


async def log_since(
    session: AsyncSession,
    since: int,
    *,
    project_id: str | None = None,
    limit: int = 200,
    readers: list[str] | None = None,
) -> dict:
    """The raw log after an id (the planned `wait` tool and `kanban wait` read this). `readers`: the caller's
    recipient keys, so only the events told to them, and every event of the projects they own or administer, come
    back; None reads everything (the board's own user)."""
    head = await head_id(session)
    g = await _global(session)
    pruned = int(g.get("pruned_through") or 0)
    if since > 0 and (since < pruned or since > head):
        return {"head": head, "cursor_too_old": True, "events": []}
    stmt = select(NotifyEvent).where(col(NotifyEvent.id) > since)
    if project_id:
        stmt = stmt.where(NotifyEvent.project_id == project_id)
    if readers is not None:
        stmt = stmt.where(await _readable_by(session, readers))
    rows = (
        await session.exec(
            stmt.order_by(col(NotifyEvent.id)).limit(max(1, min(limit, 1000)))
        )
    ).all()
    return {
        "head": head,
        "cursor_too_old": False,
        "events": [
            {
                "id": e.id,
                "project_id": e.project_id,
                "kind": e.kind,
                "op": e.op,
                "needs": e.needs,
                "target_kind": e.target_kind,
                "target_id": e.target_id,
                "ticket_id": e.ticket_id,
                "page_id": e.page_id,
                "member_id": e.member_id,
                "actor": e.actor,
                "title": e.title,
                "body": e.body,
                "data": _loads(e.data, {}),
                "recipients": _loads(e.recipients, []),
                "created_at": e.created_at,
            }
            for e in rows
        ],
    }


async def _readable_by(session: AsyncSession, readers: list[str]):
    """The log events these recipient keys may read: the ones told to them, and the events of the projects one of
    them owns or administers (who are told every AI safety event there anyway)."""
    told = [
        col(NotifyEvent.recipients).contains(json.dumps(k), autoescape=True)
        for k in readers
    ]
    managed: set[str] = set()
    for k in readers:
        managed |= await managed_projects(session, k) or set()
    if managed:
        told.append(col(NotifyEvent.project_id).in_(sorted(managed)))
    return or_(false(), *told)


# ---------------------------------------------------------------------------
# A person acting on rows: read, dismiss, snooze, clear
# ---------------------------------------------------------------------------


async def _mine(session: AsyncSession, me: str, row_id: str) -> Notification:
    r = await session.get(Notification, row_id)
    if r is None or r.recipient != me:
        raise LookupError("Notification not found")
    return r


class PageFilters(TypedDict, total=False):
    """The All notifications page's filters, as `GET /notifications?view=page` takes them."""

    filter: str | None
    q: str | None
    project_id: str | None
    kinds: list[str] | None
    family: str | None
    days: int | None


async def mark_read(
    session: AsyncSession,
    me: str,
    *,
    ids: list[str] | None = None,
    all: bool = False,
    tab: str | None = None,
    **page: Unpack[PageFilters],
) -> int:
    """Reading is not resolving: a Needs you row stays open, and Mark all read clears the count of unread, not the
    list (the red number counts open work, not unread rows). With `all` and any of the page's filters, only the rows
    that page lists are read."""
    at = now_iso()
    now = datetime.now(UTC)
    if ids:
        stmt = select(Notification).where(
            Notification.recipient == me, col(Notification.id).in_(ids)
        )
    elif not all:
        return 0
    elif any(v not in (None, "", []) for v in page.values()):
        if page.get("filter") not in (None, *FILTERS):
            raise ValueError(f"filter must be one of {', '.join(FILTERS)}")
        stmt = _rows_stmt(
            me,
            now,
            view="page",
            tab=None,
            q=page.get("q"),
            project_id=page.get("project_id"),
            kinds=page.get("kinds"),
            family=page.get("family"),
            days=page.get("days"),
            before=None,
        )
        stmt = _where_page_filter(stmt, page.get("filter") or "all", now)
    else:
        stmt = select(Notification).where(Notification.recipient == me)
    stmt = stmt.where(col(Notification.read_at).is_(None))
    if tab == "needs":
        stmt = stmt.where(Notification.needs == True)  # noqa: E712
    elif tab == "updates":
        stmt = stmt.where(Notification.needs == False)  # noqa: E712
    rows = (await session.exec(stmt)).all()
    for r in rows:
        r.read_at = at
        session.add(r)
    await session.commit()
    if rows:
        await _announce(await head_id(session))
    return len(rows)


async def mark_target_read(
    session: AsyncSession, me: str, target_kind: str, target_id: str
) -> int:
    """Opening what a row points at marks it read (not done)."""
    rows = (
        await session.exec(
            select(Notification).where(
                Notification.recipient == me,
                or_(
                    (Notification.target_kind == target_kind)
                    & (Notification.target_id == target_id),
                    (Notification.ticket_id == target_id)
                    if target_kind == "ticket"
                    else False,
                    (Notification.page_id == target_id)
                    if target_kind == "page"
                    else False,
                ),
                col(Notification.read_at).is_(None),
            )
        )
    ).all()
    at = now_iso()
    for r in rows:
        r.read_at = at
        session.add(r)
    await session.commit()
    if rows:
        await _announce(await head_id(session))
    return len(rows)


# Kinds addressed to each recipient on their own: dismissing one closes only the caller's row (a mention of you is
# not a mention of the others in the thread)
PER_RECIPIENT_KINDS = {"mention"}


async def dismiss(session: AsyncSession, me: str, row_id: str, by: str) -> dict:
    """Dismiss resolves: the row goes grey with "Dismissed by you", for every recipient of the same thing (shared
    work, such as a failed run). A mention is the caller's own: only their row closes."""
    r = await _mine(session, me, row_id)
    gone = bool(_loads(r.data, {}).get("gone"))
    if r.done_at:
        return to_dict(r, me)
    if not r.needs:
        raise ValueError("Only a Needs you row is dismissed; clear an update instead.")
    if not (gone or KINDS[r.kind][3]):
        raise ValueError(
            "This one closes when the work is done; it cannot be dismissed."
        )
    stmt = select(Notification).where(
        Notification.group_key == r.group_key,
        col(Notification.done_at).is_(None),
    )
    if r.kind in PER_RECIPIENT_KINDS:
        stmt = stmt.where(Notification.recipient == me)
    same = (await session.exec(stmt)).all()
    await _resolve_rows(session, list(same), "Dismissed by {who}", by)
    await session.refresh(r)
    return to_dict(r, me)


async def snooze(
    session: AsyncSession, me: str, row_id: str, until: str | None
) -> dict:
    """Hide a row until a time (1 hour, this evening, tomorrow morning). It never clears the work."""
    r = await _mine(session, me, row_id)
    if until is not None:
        when = _parse(until)
        if when is None or when <= datetime.now(UTC):
            raise ValueError("Snooze until a time in the future.")
        r.snoozed_until = when.astimezone(UTC).isoformat()
    else:
        r.snoozed_until = None
    session.add(r)
    await session.commit()
    await _announce(await head_id(session))
    return to_dict(r, me)


async def clear(session: AsyncSession, me: str, row_id: str, on: bool = True) -> dict:
    """The x on a row: it leaves the panel and stays on the page under Cleared. Clearing is a state, not a delete.
    An open Needs you row is resolved or snoozed instead."""
    r = await _mine(session, me, row_id)
    if on and r.needs and not r.done_at:
        raise ValueError(
            "A Needs you row closes when the work is done, or is snoozed; it is not cleared."
        )
    r.cleared_at = now_iso() if on else None
    if on and r.read_at is None:
        r.read_at = r.cleared_at
    session.add(r)
    await session.commit()
    await _announce(await head_id(session))
    return to_dict(r, me)


async def clear_read(session: AsyncSession, me: str) -> int:
    """Clear every read update (the panel's Clear)."""
    rows = (
        await session.exec(
            select(Notification).where(
                Notification.recipient == me,
                Notification.needs == False,  # noqa: E712
                col(Notification.read_at).is_not(None),
                col(Notification.cleared_at).is_(None),
            )
        )
    ).all()
    at = now_iso()
    for r in rows:
        r.cleared_at = at
        session.add(r)
    await session.commit()
    if rows:
        await _announce(await head_id(session))
    return len(rows)


# ---------------------------------------------------------------------------
# The day in one card, and retention
# ---------------------------------------------------------------------------


async def _people(session: AsyncSession) -> list[str]:
    """Every person who has settings or a row (never an AI member): the day card goes to each of them."""
    keys = {"user"}
    keys.update((await session.exec(select(NotifyPrefs.recipient))).all())
    keys.update((await session.exec(select(Notification.recipient).distinct())).all())
    return sorted(k for k in keys if k != "*" and not k.startswith("ai:"))


async def build_day_card(
    session: AsyncSession, me: str, *, since: datetime, until: datetime
) -> dict:
    """The day in numbers and lines, counted from the log and the runs. Nothing is asked of an AI."""
    s_iso, u_iso = since.isoformat(), until.isoformat()
    runs = await _runs_of_the_day(session, me, s_iso, u_iso)
    finished = [r for r in runs if r.state == "finished"]
    failed = [r for r in runs if r.state in ("failed", "timed_out")]
    spent = round(sum(r.cost_usd or 0 for r in runs), 2)
    now = datetime.now(UTC)
    waiting_open, snoozed = await _waiting_of(session, me, now)
    projects = {p.id: p for p in (await session.exec(select(Project))).all()}
    lines = _finished_lines(finished, projects)
    not_retried = await _not_retried(session, failed)
    if failed:
        lines.append(_failed_line(failed, not_retried))
    if waiting_open:
        lines.append(_waiting_line(waiting_open, now))
    published = await _published_between(session, s_iso, u_iso)
    proposals = [r for r in waiting_open if r.kind == "page_proposal"]
    if published or proposals:
        lines.append(_docs_line(published, proposals))
    if snoozed:
        lines.append(
            {
                "kind": "snoozed",
                "text": f"{len(snoozed)} still snoozed: {', '.join(r.title for r in snoozed[:2])}.",
            }
        )
    tomorrow = await _tomorrow_line(session, now)
    if tomorrow is not None:
        lines.append(tomorrow)
    quiet = not runs and not waiting_open and not published
    if quiet:
        lines = [
            {
                "kind": "quiet",
                "text": "A quiet day: nothing ran and nothing waits for you.",
            }
        ]
    project_ids = sorted(
        {r.project_id for r in runs}
        | {r.project_id for r in waiting_open if r.project_id}
    )
    return {
        "since": s_iso,
        "until": u_iso,
        "finished": len(finished),
        "failed": len(failed),
        # only what has not been retried yet, so "Retry both failed" never starts a run twice
        "failed_runs": [r.id for r in not_retried],
        "waiting": len(waiting_open),
        "waiting_ids": [r.id for r in waiting_open],
        "snoozed": len(snoozed),
        "spent": spent,
        "projects": len(project_ids),
        "lines": lines,
        "quiet": quiet,
    }


async def _waiting_of(
    session: AsyncSession, me: str, now: datetime
) -> tuple[list[Notification], list[Notification]]:
    """The recipient's open Needs you rows: (still waiting, oldest first; snoozed)."""
    waiting = (
        await session.exec(
            select(Notification).where(
                Notification.recipient == me,
                Notification.needs == True,  # noqa: E712
                col(Notification.done_at).is_(None),
            )
        )
    ).all()
    snoozed = [r for r in waiting if _is_snoozed(r, now)]
    waiting_open = sorted(
        [r for r in waiting if r not in snoozed], key=lambda r: r.created_at
    )
    return waiting_open, snoozed


async def _runs_of_the_day(
    session: AsyncSession, me: str, s_iso: str, u_iso: str
) -> list[AiRun]:
    """The work runs that ended in the span: every one for the board's own user, else the person's own runs and
    the runs of the projects they have notifications in."""
    run_stmt = select(AiRun).where(
        col(AiRun.ended_at) >= s_iso, col(AiRun.ended_at) < u_iso, AiRun.mode == "work"
    )
    runs = list((await session.exec(run_stmt)).all())
    if me == "user":
        return runs
    mine_projects = {
        r.project_id
        for r in (
            await session.exec(select(Notification).where(Notification.recipient == me))
        ).all()
    }
    return [
        r
        for r in runs
        if person_key(r.started_by) == me or r.project_id in mine_projects
    ]


def _finished_lines(finished: list[AiRun], projects: dict[str, Project]) -> list[dict]:
    """One line per project with finished runs, the busiest first."""
    by_project: dict[str, list[AiRun]] = {}
    for r in finished:
        by_project.setdefault(r.project_id, []).append(r)
    lines: list[dict] = []
    for pid, rs in sorted(by_project.items(), key=lambda x: -len(x[1])):
        p = projects.get(pid)
        tickets = sorted({r.ticket_id for r in rs}, key=_ticket_order)
        text = f"{p.name if p else 'A project'}: {len(rs)} AI run{_s(len(rs))} finished"
        if tickets:
            more = " and more" if len(tickets) > 3 else ""
            text += f" on {', '.join(tickets[:3])}{more}"
        lines.append({"kind": "project", "project_id": pid, "text": text + "."})
    return lines


async def _not_retried(session: AsyncSession, failed: list[AiRun]) -> list[AiRun]:
    """The failed runs with no later run of their ticket."""
    not_retried: list[AiRun] = []
    for r in failed:
        newer = (
            await session.exec(
                select(AiRun).where(
                    AiRun.ticket_id == r.ticket_id,
                    AiRun.mode == "work",
                    col(AiRun.queued_at) > (r.ended_at or r.queued_at),
                )
            )
        ).first()
        if newer is None:
            not_retried.append(r)
    return not_retried


def _failed_line(failed: list[AiRun], not_retried: list[AiRun]) -> dict:
    parts = []
    for r in failed[:3]:
        why = (r.ended_reason or r.state.replace("_", " ")).split(". ")[0][:60]
        parts.append(f"{r.ticket_id} ({why})")
    if len(failed) > len(not_retried):
        end = "."
    elif len(failed) == 2:
        end = ". Neither has been retried."
    else:
        end = ". Not retried yet."
    return {
        "kind": "failed",
        "text": f"{len(failed)} run{_s(len(failed))} failed: " + ", ".join(parts) + end,
    }


def _waiting_line(waiting_open: list[Notification], now: datetime) -> dict:
    oldest = waiting_open[0]
    t = _local(_parse(oldest.created_at) or now).strftime("%H:%M")
    who = (
        (oldest.data and _loads(oldest.data, {}).get("member_name"))
        or oldest.actor
        or ""
    )
    if who:
        about = f" — {who} on {oldest.ticket_id or oldest.title}"
    else:
        about = f" — {oldest.title}"
    return {
        "kind": "waiting",
        "text": f"{len(waiting_open)} still wait for you, the oldest since {t}{about}.",
    }


async def _published_between(session: AsyncSession, s_iso: str, u_iso: str) -> int:
    return (
        await session.exec(
            select(func.count())
            .select_from(NotifyEvent)
            .where(
                NotifyEvent.kind == "page_published",
                col(NotifyEvent.created_at) >= s_iso,
                col(NotifyEvent.created_at) < u_iso,
            )
        )
    ).one()


def _docs_line(published: int, proposals: list[Notification]) -> dict:
    text = f"Docs: {published} page{_s(published)} published"
    if proposals:
        text += f", {len(proposals)} proposal{_s(len(proposals))} unanswered"
    return {"kind": "docs", "text": text + "."}


async def _tomorrow_line(session: AsyncSession, now: datetime) -> dict | None:
    """Tomorrow's scheduled runs, or None when there are none."""
    tomorrow0 = (_local(now) + timedelta(days=1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    tomorrow1 = tomorrow0 + timedelta(days=1)
    sched = (
        await session.exec(
            select(AiSchedule).where(
                AiSchedule.state == "active",
                col(AiSchedule.next_run_at) >= tomorrow0.astimezone(UTC).isoformat(),
                col(AiSchedule.next_run_at) < tomorrow1.astimezone(UTC).isoformat(),
            )
        )
    ).all()
    if not sched:
        return None
    first = min(_parse(s.next_run_at) for s in sched if s.next_run_at)
    return {
        "kind": "tomorrow",
        "text": f"Tomorrow: {len(sched)} scheduled run{_s(len(sched))}, "
        f"the first at {_local(first).strftime('%H:%M')}.",
    }


async def write_day_cards(
    now: datetime | None = None, *, force_for: str | None = None
) -> int:
    """At the card time (weekdays at 18:00 by default) write each person's card for the day, once. Only what
    happened since the last card; a closed app writes it the next time it runs, with the date."""
    now = now or datetime.now(UTC)
    local = _local(now)
    n = 0
    async with database.async_session() as session:
        people = [force_for] if force_for else await _people(session)
        for me in people:
            prefs = await get_prefs(session, me)
            if not force_for and not _card_due(prefs.get("day_card") or {}, local):
                continue
            day_id = _day_id(me, local, now, forced=bool(force_for))
            # the scheduled card of the day is written once: a card asked for now ("Sum up today") neither stands in
            # for it nor makes it come again
            if not force_for and await _card_of(session, me, day_id) is not None:
                continue
            last = await _latest_scheduled_card(session, me)
            facts = await build_day_card(
                session, me, since=_card_since(last, local), until=now
            )
            title = "Today on your boards"
            body = f"{local.strftime('%a %d %b')} · {local.strftime('%H:%M')} · {facts['projects']} project{_s(facts['projects'])}"
            await emit(
                "day_card",
                project_id=None,
                recipients=[me],
                title=title,
                body=body,
                target_kind="day",
                target_id=day_id,
                data=facts,
                session=session,
            )
            n += 1
    return n


async def _card_of(session: AsyncSession, me: str, day_id: str) -> Notification | None:
    """The person's card that points at this day id."""
    return (
        await session.exec(
            select(Notification).where(
                Notification.recipient == me,
                Notification.kind == "day_card",
                Notification.target_id == day_id,
            )
        )
    ).first()


async def _latest_scheduled_card(session: AsyncSession, me: str) -> Notification | None:
    """The person's latest card written at the card time (not one asked for now): a card counts from it."""
    return (
        await session.exec(
            select(Notification)
            .where(
                Notification.recipient == me,
                Notification.kind == "day_card",
                not_(col(Notification.target_id).contains(_FORCED)),
            )
            .order_by(col(Notification.created_at).desc())
        )
    ).first()


def _card_due(card: dict, local: datetime) -> bool:
    """Whether a person's card is due now: it is on, today is one of its days and its time has come."""
    if not card.get("on", True) or local.weekday() not in card.get(
        "days", [0, 1, 2, 3, 4]
    ):
        return False
    return local.strftime("%H:%M") >= card.get("time", "18:00")


def _day_id(me: str, local: datetime, now: datetime, *, forced: bool) -> str:
    """What a card points at: the person's day (one card a day), or this moment for a card asked for now."""
    day_id = f"{me}:{local.date().isoformat()}"
    return f"{day_id}{_FORCED}{int(now.timestamp())}" if forced else day_id


# What the day id of a card asked for now has after the day
_FORCED = ":now:"


def _card_since(last: Notification | None, local: datetime) -> datetime | None:
    """A card counts from the last scheduled card, or from midnight for the first one."""
    if last is not None:
        return _parse(last.created_at)
    return local.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(UTC)


async def prune(now: datetime | None = None) -> int:
    """Retention is the only thing that deletes: rows and log events older than the setting (90 days by default).
    The id of the newest deleted event is kept, so a cursor older than that gets "cursor too old"."""
    now = now or datetime.now(UTC)
    async with database.async_session() as session:
        days = await retention_days(session)
        cutoff = (now - timedelta(days=days)).isoformat()
        last = (
            await session.exec(
                select(func.max(NotifyEvent.id)).where(
                    col(NotifyEvent.created_at) < cutoff
                )
            )
        ).one()
        r1 = await session.exec(
            delete(Notification).where(
                col(Notification.updated_at) < cutoff,
                # an open Needs you row is work still waiting: it stays until it is done
                or_(
                    Notification.needs == False,  # noqa: E712
                    col(Notification.done_at).is_not(None),
                ),
            )
        )
        await session.exec(
            delete(NotifyEvent).where(col(NotifyEvent.created_at) < cutoff)
        )
        if last:
            g = await _global(session)
            await _set_global(
                session,
                pruned_through=max(int(g.get("pruned_through") or 0), int(last)),
            )
        await session.commit()
        return int(getattr(r1, "rowcount", 0) or 0)


# ---------------------------------------------------------------------------
# The loop
# ---------------------------------------------------------------------------

_task: asyncio.Task | None = None


async def remind_unanswered(now: datetime | None = None) -> int:
    """Do not let it slip (#270): a Needs you row still open and unread `remind_after_min` minutes after its newest
    event notifies once more. The reminder is one more event on the same row (it comes back unread and does not
    count as a new item), so the panel, a toast, the browser notifier and the desktop notifier all see it the way
    they see any other change. Once per request: the row remembers `reminded_at` until a new event arrives.
    Not during quiet hours (it waits for them to end), not for a snoozed, closed, cleared or unreachable row, and
    never for an AI recipient. Returns how many reminders were sent."""
    now = now or datetime.now(UTC)
    sent = 0
    async with database.async_session() as session:
        rows = (
            await session.exec(
                select(Notification).where(
                    Notification.needs == True,  # noqa: E712
                    col(Notification.done_at).is_(None),
                    col(Notification.cleared_at).is_(None),
                    col(Notification.read_at).is_(None),
                )
            )
        ).all()
        prefs_of: dict[str, dict] = {}
        for r in rows:
            if r.recipient.startswith("ai:") or not (r.inapp or r.desktop):
                continue
            if r.snoozed_until and (_parse(r.snoozed_until) or now) > now:
                continue
            data = _loads(r.data, {})
            if data.get("reminded_at") or data.get("gone"):
                continue
            if r.recipient not in prefs_of:
                prefs_of[r.recipient] = await get_prefs(session, r.recipient)
            prefs = prefs_of[r.recipient]
            minutes = _remind_after(prefs)
            last = _parse(r.updated_at)
            if minutes <= 0 or last is None or now - last < timedelta(minutes=minutes):
                continue
            if in_quiet_hours(prefs, now):
                continue
            await emit(
                r.kind,
                project_id=r.project_id,
                recipients=[r.recipient],
                title=r.title,
                body=r.body,
                target_kind=r.target_kind,
                target_id=r.target_id,
                ticket_id=r.ticket_id,
                page_id=r.page_id,
                member_id=r.member_id,
                actor=r.actor,
                data={"reminder": True},
                session=session,
            )
            sent += 1
    return sent


async def wake_snoozed(now: datetime | None = None) -> int | None:
    """A snooze that ran out brings its row back: one event per target, the row points at it and is unread again, so
    the panel, the count, a toast and the desktop notifier all see it come back (design C, "brings it back in 1
    hour"). Returns the newest event id, or None when nothing woke."""
    now = now or datetime.now(UTC)
    async with database.async_session() as session:
        rows = (
            await session.exec(
                select(Notification).where(
                    col(Notification.snoozed_until).is_not(None),
                    col(Notification.snoozed_until) <= now.isoformat(),
                    col(Notification.done_at).is_(None),
                )
            )
        ).all()
        if not rows:
            return None
        targets: dict[tuple, list[Notification]] = {}
        for r in rows:
            key = (r.kind, r.target_kind, r.target_id, r.project_id, r.ticket_id)
            targets.setdefault(key, []).append(r)
        last = None
        for (kind, tk, tid, pid, ticket), group in targets.items():
            ev = NotifyEvent(
                project_id=pid,
                kind=kind,
                op="wake",
                needs=group[0].needs,
                target_kind=tk,
                target_id=tid,
                ticket_id=ticket,
                title=group[0].title,
                recipients=json.dumps(sorted({r.recipient for r in group})),
            )
            session.add(ev)
            await session.flush()
            last = ev.id
            for r in group:
                r.snoozed_until = None
                r.read_at = None
                r.last_event_id = ev.id
                session.add(r)
        await session.commit()
    await _announce(last)
    return last


async def backfill_waiting() -> int:
    """Once, on the first start after the upgrade: what was already waiting for a person gets its row, since the old
    toast hooks are gone and nothing else would write one (a pending approval, an open question, an account found
    signed out). Returns how many were written."""
    return 0


RECONCILE_EVERY_S = 15.0


async def _loop() -> None:
    last_full = 0.0
    last_hour = -1.0
    last_remind = -REMIND_EVERY_S
    loop = asyncio.get_running_loop()
    dirty = _dirty or asyncio.Event()
    try:
        await backfill_waiting()
    except Exception:  # noqa: BLE001 - never stops the loop
        logger.exception("Could not write the rows of what was already waiting")
    while True:
        try:
            try:
                await asyncio.wait_for(dirty.wait(), timeout=1.0)
            except asyncio.TimeoutError:
                pass
            t = loop.time()
            if dirty.is_set() or t - last_full >= RECONCILE_EVERY_S:
                dirty.clear()
                last_full = t
                await reconcile()
                await wake_snoozed()
            if t - last_remind >= REMIND_EVERY_S:
                last_remind = t
                await remind_unanswered()
            if t - last_hour >= 60:
                last_hour = t
                await write_day_cards()
                await prune()
            await asyncio.sleep(0.25)  # many changes at once are one check
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("Notification loop failed")
            await asyncio.sleep(2)


def start() -> None:
    """Start the loop that closes rows, writes day cards and prunes."""
    global _task, _dirty
    if _task is None or _task.done():
        _dirty = asyncio.Event()
        board_events.on_publish(mark_dirty)
        _task = asyncio.create_task(_loop())


async def stop() -> None:
    """Stop the loop."""
    global _task
    if _task is not None:
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:
            # the loop's own cancellation is expected; a cancellation of stop() itself goes on
            current = asyncio.current_task()
            if current is not None and current.cancelling():
                raise
    _task = None
