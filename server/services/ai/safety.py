"""Who may decide what, standing grants, notifications and budget alerts, workspace defaults and the first-time
checklist (design/screens/ai-safety-cost.md, B5, C3, H, I7, I8).

Project roles are the Docs roles of a person (viewer / member / admin). The board's own user and the first admin of
a project count as its owner; that is the only role with the last word on High risk and on widening an AI member.
"""

import json
from datetime import UTC, datetime, timedelta

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
from models import (
    AiGrant,
    AiMember,
    AiNotification,
    AiProjectSettings,
    AiWorkspaceDefaults,
    Member,
)

from .budget import day_key as local_day, today_start
from .store import get_settings, loads, parse_iso

ROLE_RANK = {"viewer": 0, "member": 1, "admin": 2, "owner": 3}
ROLE_LABEL = {
    "viewer": "Viewer",
    "member": "Member",
    "admin": "Admin",
    "owner": "Owner",
}
DEFAULT_APPROVERS = {"low": "member", "medium": "admin", "high": "owner"}
RISKS = ("low", "medium", "high")

# event: (label, urgent, in-app default, desktop default). Urgent ones are never held for the digest.
EVENTS: dict[str, tuple[str, bool, bool, bool]] = {
    "approval_requested": ("Approval requested", True, True, True),
    "auto_trip": ("Auto-trip or Pause all AI", True, True, True),
    "budget": ("Budget at 80% or cap reached", False, True, False),
    "blocked": ("Blocked or injection attempt", False, True, False),
    "offline": ("Agent offline, token revoked", True, True, True),
    "question": ("An AI question is still unanswered", True, True, True),
    "run_restarted": ("A run was restarted (memory)", True, True, False),
    "run_stopped_memory": ("A run was stopped (memory)", True, True, True),
}
DIGESTS = ("off", "daily", "weekdays")
DIGEST_HOUR = 9


# ---------------------------------------------------------------------------
# Roles, approvers and delegates
# ---------------------------------------------------------------------------


async def role_name(session: AsyncSession, project_id: str, person: str | None) -> str:
    """owner | admin | member | viewer of a person in a project. The board's own user is the owner, and so is
    the project's first admin."""
    if not person or person == "user":
        return "owner"
    rows = (
        await session.exec(
            select(Member)
            .where(Member.project_id == project_id, Member.kind == "human")
            .order_by(col(Member.created_at))
        )
    ).all()
    mine = next((m for m in rows if m.name == person), None)
    if mine is None:
        return "member"
    if mine.role == "admin":
        first = next((m for m in rows if m.role == "admin"), None)
        return "owner" if first is not None and first.id == mine.id else "admin"
    return mine.role if mine.role in ROLE_RANK else "member"


def approvers_of(settings: AiProjectSettings) -> dict[str, str]:
    """Least role that may decide each risk level."""
    raw = loads(settings.approvers, {})
    return {
        r: raw.get(r) if raw.get(r) in ROLE_RANK else DEFAULT_APPROVERS[r]
        for r in RISKS
    }


def delegates_of(settings: AiProjectSettings) -> list[dict]:
    """Delegations still in force today: {from, to, until}."""
    today = local_day()
    out = []
    for d in loads(settings.delegates, []):
        if (
            isinstance(d, dict)
            and d.get("from")
            and d.get("to")
            and (not d.get("until") or str(d["until"]) >= today)
        ):
            out.append(
                {
                    "from": str(d["from"]),
                    "to": str(d["to"]),
                    "until": d.get("until") or None,
                }
            )
    return out


async def can_decide(
    session: AsyncSession,
    settings: AiProjectSettings,
    *,
    project_id: str,
    risk: str,
    on_behalf_of: str | None,
    person: str | None,
) -> tuple[bool, str]:
    """May `person` approve or deny a request of this risk? (ok, reason when not.) The assigner (the person the
    AI acts for) may decide Low and Medium; delegates decide as the person they stand in for."""
    role = await role_name(session, project_id, person)
    if role == "viewer":
        return False, "Viewers can't decide approvals."
    if person and person != "user":
        # An AI can never approve (itself or another AI): only people decide, whatever name a request carries
        ai = (
            await session.exec(
                select(Member).where(
                    Member.project_id == project_id,
                    Member.name == person,
                    col(Member.kind).in_(["ai", "ai_removed"]),
                )
            )
        ).first()
        if ai is not None:
            return False, "AI members can't decide approvals; a person has to."
    need = approvers_of(settings).get(risk, "owner")
    people = [person]
    for d in delegates_of(settings):
        if d["to"] == person:
            people.append(d["from"])
    for who in people:
        who_role = role if who == person else await role_name(session, project_id, who)
        if ROLE_RANK[who_role] >= ROLE_RANK[need]:
            return True, ""
        if (
            risk in ("low", "medium")
            and on_behalf_of
            and who == on_behalf_of
            and who_role != "viewer"
        ):
            return True, ""
    text = {
        "member": "any member",
        "admin": "an admin or the owner",
        "owner": "the project owner",
    }[need]
    return False, f"{risk.capitalize()} risk is decided by {text}."


# ---------------------------------------------------------------------------
# Grants: remembered approvals, cap raises, extra runs
# ---------------------------------------------------------------------------


async def add_grant(
    session: AsyncSession,
    *,
    project_id: str,
    kind: str,
    created_by: str,
    member_id: str | None = None,
    ticket_id: str | None = None,
    action: str | None = None,
    amount: float = 0.0,
    day: str | None = None,
    source_approval_id: str | None = None,
) -> AiGrant:
    """Store a grant and return it."""
    g = AiGrant(
        project_id=project_id,
        kind=kind,
        member_id=member_id,
        ticket_id=ticket_id,
        action=action,
        amount=amount,
        day=day,
        created_by=created_by,
        source_approval_id=source_approval_id,
    )
    session.add(g)
    await session.commit()
    await session.refresh(g)
    return g


async def remembered(
    session: AsyncSession, member_id: str, ticket_id: str | None, actions: list[str]
) -> list[AiGrant]:
    """Active remembered approvals covering every one of `actions` on the ticket (empty when one is missing). A
    grant ends when its ticket reaches Done or it is revoked."""
    if not actions:
        return []
    from models import Ticket

    ticket = await session.get(Ticket, ticket_id) if ticket_id else None
    on_ticket = ticket is not None and ticket.status not in ("done", "wont_do")
    # A grant made with "Always allow" belongs to no ticket and ends only when it is revoked
    rows = (
        await session.exec(
            select(AiGrant).where(
                AiGrant.kind == "approval",
                AiGrant.member_id == member_id,
                col(AiGrant.revoked_at).is_(None),
            )
        )
    ).all()
    rows = [
        g
        for g in rows
        if g.ticket_id is None or (on_ticket and g.ticket_id == ticket_id)
    ]
    found = [g for a in actions for g in rows if g.action == a][: len(actions)]
    covered = {g.action for g in found}
    return found if all(a in covered for a in actions) else []


async def limited_runs_today(session: AsyncSession, ticket_id: str) -> list:
    """Runs today that count against a ticket's run limit: the scheduled or AI-started work runs of API-key members.
    Claude Code and Antigravity run on the person's own CLI, so they are not limited and not counted."""
    from sqlalchemy import or_

    from models import AiRun

    return list(
        (
            await session.exec(
                select(AiRun)
                .join(AiMember, col(AiMember.id) == col(AiRun.member_id))
                .where(
                    AiRun.ticket_id == ticket_id,
                    AiRun.mode == "work",
                    AiRun.queued_at >= today_start().isoformat(),
                    AiMember.connection == "api_key",
                    or_(AiRun.trigger == "schedule", AiRun.chain != "[]"),
                )
            )
        ).all()
    )


async def extra_runs_today(session: AsyncSession, ticket_id: str) -> int:
    """Runs an owner allowed on a ticket today beyond the daily limit."""
    rows = (
        await session.exec(
            select(AiGrant).where(
                AiGrant.kind == "extra_runs",
                AiGrant.ticket_id == ticket_id,
                AiGrant.day == local_day(),
                col(AiGrant.revoked_at).is_(None),
            )
        )
    ).all()
    return int(sum(g.amount for g in rows))


# ---------------------------------------------------------------------------
# Notifications and budget alerts
# ---------------------------------------------------------------------------


def notify_prefs(settings: AiProjectSettings) -> dict[str, dict]:
    """In-app / desktop switches per event, with the design's defaults filled in."""
    raw = loads(settings.notify, {})
    out = {}
    for key, (label, urgent, inapp, desktop) in EVENTS.items():
        mine = raw.get(key) if isinstance(raw.get(key), dict) else {}
        out[key] = {
            "label": label,
            "urgent": urgent,
            "inapp": bool(mine.get("inapp", inapp)),
            "desktop": bool(mine.get("desktop", desktop)),
        }
    return out


async def notify(
    project_id: str,
    event: str,
    title: str,
    body: str = "",
    *,
    ref_kind: str | None = None,
    ref_id: str | None = None,
    member_id: str | None = None,
    people: list[str] | None = None,
    data: dict | None = None,
) -> AiNotification | None:
    """Record a safety notification unless the project switched this event off in-app and on the desktop. Owners
    and admins see all of them; `people` also see this one. Non-urgent events wait for the daily digest."""
    async with database.async_session() as session:
        settings = await get_settings(session, project_id)
        prefs = notify_prefs(settings)[event]
        if not prefs["inapp"] and not prefs["desktop"]:
            return None
        row = AiNotification(
            project_id=project_id,
            event=event,
            title=title,
            body=body,
            ref_kind=ref_kind,
            ref_id=ref_id,
            member_id=member_id,
            people=json.dumps(sorted({p for p in (people or []) if p})),
            urgent=prefs["urgent"],
            inapp=prefs["inapp"],
            desktop=prefs["desktop"],
            digest=(not prefs["urgent"]) and settings.digest != "off",
            data=json.dumps(data or {}),
        )
        session.add(row)
        await session.commit()
        await session.refresh(row)
        return row


def notification_to_dict(n: AiNotification) -> dict:
    """A notification for the API."""
    return {
        "id": n.id,
        "project_id": n.project_id,
        "event": n.event,
        "title": n.title,
        "body": n.body,
        "ref_kind": n.ref_kind,
        "ref_id": n.ref_id,
        "member_id": n.member_id,
        "urgent": n.urgent,
        "inapp": n.inapp,
        "desktop": n.desktop,
        "held": n.digest,
        "data": loads(n.data, {}),
        "created_at": n.created_at,
    }


async def visible_notifications(
    session: AsyncSession,
    project_id: str,
    person: str | None,
    *,
    after: str | None = None,
    event: str | None = None,
    include_held: bool = False,
    limit: int = 50,
) -> list[AiNotification]:
    """Notifications this person may see, newest first."""
    stmt = select(AiNotification).where(AiNotification.project_id == project_id)
    if after:
        stmt = stmt.where(col(AiNotification.created_at) > after)
    if event:
        stmt = stmt.where(AiNotification.event == event)
    if not include_held:
        stmt = stmt.where(AiNotification.digest == False)  # noqa: E712
    rows = (
        await session.exec(
            stmt.order_by(col(AiNotification.created_at).desc()).limit(200)
        )
    ).all()
    role = await role_name(session, project_id, person)
    if ROLE_RANK[role] < ROLE_RANK["admin"]:
        rows = [n for n in rows if person and person in loads(n.people, [])]
    return list(rows)[:limit]


async def check_key_reminders(project_id: str) -> int:
    """Remind owners once a month that an API key has not been rotated for the project's reminder period (F6)."""
    async with database.async_session() as session:
        settings = await get_settings(session, project_id)
        rows = (
            await session.exec(
                select(AiMember).where(
                    AiMember.project_id == project_id, AiMember.connection == "api_key"
                )
            )
        ).all()
        state = loads(settings.alert_state, {})
        now = datetime.now(UTC)
        due = []
        for p in rows:
            since = parse_iso(p.key_rotated_at or p.created_at)
            if since is None or (now - since).days < settings.key_reminder_days:
                continue
            key = f"key:{p.id}"
            last = parse_iso(state.get(key))
            if last is None or (now - last).days >= 30:
                state[key] = now.isoformat()
                due.append((p, (now - since).days))
        if not due:
            return 0
        settings.alert_state = json.dumps(state)
        session.add(settings)
        await session.commit()
        names = {
            m.id: m.name
            for m in (
                await session.exec(
                    select(Member).where(Member.project_id == project_id)
                )
            ).all()
        }
    for p, days in due:
        await notify(
            project_id,
            "budget",
            f"Rotate the key of {names.get(p.id, 'an AI member')}",
            f"Its API key was last rotated {days} days ago (reminder at {settings.key_reminder_days}).",
            ref_kind="member",
            ref_id=p.id,
            member_id=p.id,
            data={"kind": "key_reminder"},
        )
    return len(due)


async def release_digest(project_id: str) -> int:
    """Once a day at 09:00 (Mon to Fri for the weekday digest) turn the held notifications into one digest
    notification. Returns how many were summarised."""
    now = datetime.now().astimezone()
    async with database.async_session() as session:
        settings = await get_settings(session, project_id)
        if settings.digest == "off" or now.hour < DIGEST_HOUR:
            return 0
        if settings.digest == "weekdays" and now.weekday() >= 5:
            return 0
        state = loads(settings.alert_state, {})
        if state.get("digest_day") == local_day(now):
            return 0
        held = (
            await session.exec(
                select(AiNotification).where(
                    AiNotification.project_id == project_id,
                    AiNotification.digest == True,  # noqa: E712
                    col(AiNotification.event) != "digest",
                )
            )
        ).all()
        state["digest_day"] = local_day(now)
        settings.alert_state = json.dumps(state)
        session.add(settings)
        await session.commit()
    if not held:
        return 0
    by_event: dict[str, int] = {}
    for n in held:
        by_event[n.event] = by_event.get(n.event, 0) + 1
    parts = ", ".join(
        f"{c} {EVENTS[e][0].lower() if e in EVENTS else e}" for e, c in by_event.items()
    )
    async with database.async_session() as session:
        session.add(
            AiNotification(
                project_id=project_id,
                event="digest",
                title="AI safety digest",
                body=f"Since the last digest: {parts}.",
                urgent=True,
                inapp=True,
                desktop=False,
                digest=False,
            )
        )
        await session.commit()
    return len(held)


async def check_budget_alerts(member_id: str) -> None:
    """Alert once per threshold a day when an agent's spend passes its warn percentages (50 / 80 / 100) of the
    daily budget (C3). The alert goes to owners, admins and the assigner of the run in progress."""
    from . import budget

    async with database.async_session() as session:
        profile = await session.get(AiMember, member_id)
        member = await session.get(Member, member_id)
        if (
            profile is None
            or member is None
            or profile.connection != "api_key"
            or not profile.daily_budget
        ):
            return
        settings = await get_settings(session, profile.project_id)
        today = await budget.spent(session, today_start(), member_id=member_id)
        pct = today / profile.daily_budget * 100
        state = loads(settings.alert_state, {})
        day = local_day()
        sent: list[int] = []
        for th in sorted(set(loads(profile.warn_at, [80, 100]))):
            key = f"{member_id}:{th}"
            if pct >= th and state.get(key) != day:
                state[key] = day
                sent.append(int(th))
        if not sent:
            return
        settings.alert_state = json.dumps(state)
        session.add(settings)
        await session.commit()
        name, project_id, budget_usd = (
            member.name,
            profile.project_id,
            profile.daily_budget,
        )
    for th in sent:
        if th >= 100:
            title, body = (
                f"{name}: daily budget reached",
                f"{name} used ${today:.2f} of ${budget_usd:.2f} today; new runs pause until 00:00.",
            )
        else:
            title, body = (
                f"{name}: {th}% of today's budget",
                f"{name} used ${today:.2f} of ${budget_usd:.2f} today.",
            )
        await notify(
            project_id,
            "budget",
            title,
            body,
            ref_kind="member",
            ref_id=member_id,
            member_id=member_id,
            data={"percent": th, "spent": round(today, 4), "limit": budget_usd},
        )


# ---------------------------------------------------------------------------
# Workspace defaults and the first-time checklist
# ---------------------------------------------------------------------------


async def workspace_defaults(session: AsyncSession) -> AiWorkspaceDefaults:
    """The workspace's start values for new AI members (created on first use)."""
    row = await session.get(AiWorkspaceDefaults, 1)
    if row is None:
        row = AiWorkspaceDefaults(id=1)
        session.add(row)
        await session.commit()
        await session.refresh(row)
    return row


def defaults_to_dict(d: AiWorkspaceDefaults) -> dict:
    """Workspace defaults for the API."""
    return {
        "template": d.template,
        "ceiling": d.ceiling,
        "delete_mode": d.delete_mode,
        "daily_budget": d.daily_budget,
        "monthly_cap": d.monthly_cap,
        "updated_by": d.updated_by,
        "updated_at": d.updated_at,
    }


def checklist_state(settings: AiProjectSettings, members: int) -> dict:
    """The first-time checklist of a project (I8): three items are facts about the defaults, two are ticked by the
    person when they have looked at them."""
    raw = loads(settings.checklist, {})
    ticked = set(raw.get("ticked") or [])
    items = [
        ("ceiling", "Status ceiling: up to Review", True),
        ("approver", "Who approves: you, as owner", True),
        ("budget", "Daily budget: $5.00 per agent", True),
        ("notifications", "Notifications for approvals", "notifications" in ticked),
        ("pause", "Find “Pause all AI” in the header", "pause" in ticked),
    ]
    return {
        "show": members > 0 and not raw.get("dismissed"),
        "dismissed": bool(raw.get("dismissed")),
        "items": [{"key": k, "label": label, "done": done} for k, label, done in items],
        "done": sum(1 for _, _, d in items if d),
        "total": len(items),
    }


def parse_since(value: str | None) -> str | None:
    """A date (YYYY-MM-DD, local midnight) or an ISO time as a UTC ISO string."""
    if not value:
        return None
    try:
        if len(value) == 10:
            day = datetime.fromisoformat(value).replace(tzinfo=None)
            return day.astimezone().astimezone(UTC).isoformat()
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return (dt if dt.tzinfo else dt.astimezone()).astimezone(UTC).isoformat()
    except ValueError:
        return None


def end_of_day(value: str | None) -> str | None:
    """The start of the day after a YYYY-MM-DD date (so a range is inclusive of its last day)."""
    if value and len(value) == 10:
        try:
            nxt = datetime.fromisoformat(value) + timedelta(days=1)
        except ValueError:
            return None
        return parse_since(nxt.date().isoformat())
    return parse_since(value)
