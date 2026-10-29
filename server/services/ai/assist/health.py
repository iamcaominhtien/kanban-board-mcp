"""Board health and the daily digest (design/screens/ai-board-assistant.md, F). Insights are found by rules on the
board's own data; the Board AI writes the standup summary and the nudge comments. Acting on an insight only prepares
a draft."""

import asyncio
import json
import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
import events as board_events
from models import AiDigest, AiInsight, Member, Project, Ticket

from .. import llm
from ..context import STATUS_LABELS
from ..store import loads, now_iso, parse_iso
from . import drafts as svc_drafts
from . import match, prompts
from . import settings as svc_settings
from .settings import AssistError

log = logging.getLogger(__name__)
OPEN = ("done", "wont_do")
_loop_task: asyncio.Task | None = None


def _when(iso: str | None) -> datetime | None:
    d = parse_iso(iso)
    if d and d.tzinfo is None:
        d = d.replace(tzinfo=UTC)
    return d


def _days(since: datetime | None) -> int:
    return (datetime.now(UTC) - since).days if since else 0


def _weekday(d: datetime | None) -> str:
    return d.astimezone().strftime("%A") if d else ""


def last_touch(t: Ticket) -> datetime | None:
    """The last comment or move on a ticket."""
    times = [_when(t.updated_at)]
    for e in loads(t.activity_log, []):
        if isinstance(e, dict):
            times.append(_when(e.get("at")))
    for c in loads(t.comments, []):
        if isinstance(c, dict):
            times.append(_when(c.get("at")))
    times = [x for x in times if x]
    return max(times) if times else None


def status_since(t: Ticket) -> datetime | None:
    """When the ticket entered its current status."""
    for e in reversed(loads(t.activity_log, [])):
        if (
            isinstance(e, dict)
            and e.get("field") == "status"
            and e.get("to") == t.status
        ):
            return _when(e.get("at"))
    return _when(t.created_at)


def _open_blockers(t: Ticket, by_id: dict[str, Ticket]) -> list[Ticket]:
    out = []
    for b in loads(t.blocked_by, []):
        bt = by_id.get(str(b))
        if bt and bt.status not in OPEN:
            out.append(bt)
    return out


def compute(tickets: list[Ticket], members: list[Member], cfg: dict) -> list[dict]:
    """Findings on the board right now, each {kind, key, ticket_id, title, detail, data, score, action}."""
    by_id = {t.id: t for t in tickets}
    humans = [m for m in members if m.kind == "human"]
    live = [t for t in tickets if t.status not in OPEN]
    out: list[dict] = []
    stuck_days = int(cfg["stuck_days"])

    # Stuck: In Progress (or Review) with no comment or move for longer than the limit
    for t in live:
        if t.status not in ("in-progress", "review"):
            continue
        since = status_since(t)
        touch = last_touch(t)
        idle = _days(touch)
        if idle < stuck_days:
            continue
        days = _days(since)
        out.append(
            {
                "kind": "stuck",
                "key": f"stuck:{t.id}",
                "ticket_id": t.id,
                "title": f"{t.id} {t.title} has been {STATUS_LABELS.get(t.status)} for {days} day{'s' if days != 1 else ''}",
                "detail": f"Over the {stuck_days}-day limit; no comment or move since {_weekday(touch)}.",
                "data": {
                    "days": days,
                    "idle": idle,
                    "chip": f"Stuck {days} day{'s' if days != 1 else ''}",
                },
                "score": 2 + idle,
                "action": "Draft a nudge",
            }
        )

    # WIP overload per person
    limit = int(cfg["wip_limit"])
    load = {
        m.id: [t for t in live if t.assignee == m.id and t.status == "in-progress"]
        for m in humans
    }
    open_count = {m.id: len([t for t in live if t.assignee == m.id]) for m in humans}
    for m in humans:
        wip = load[m.id]
        if len(wip) <= limit:
            continue
        others = sorted(
            (x for x in humans if x.id != m.id), key=lambda x: open_count[x.id]
        )
        target = others[0] if others else None
        movable = sorted(
            [t for t in live if t.assignee == m.id and t.status in ("todo", "backlog")],
            key=lambda t: t.updated_at or "",
        ) or sorted(wip, key=lambda t: _days(status_since(t)))
        mv = movable[0] if movable else None
        detail = "No one else in the project has room."
        if mv and target:
            detail = (
                f"{mv.id} is not started and could move to {target.name}, who has {open_count[target.id]}."
                if mv.status in ("todo", "backlog")
                else f"{mv.id} could move to {target.name}, who has {open_count[target.id]}."
            )
        out.append(
            {
                "kind": "wip",
                "key": f"wip:{m.id}",
                "ticket_id": mv.id if mv else None,
                "title": f"{m.name} has {len(wip)} tickets In Progress, limit {limit}",
                "detail": detail,
                "data": {
                    "member_id": m.id,
                    "count": len(wip),
                    "move": mv.id if mv else None,
                    "to": target.id if target else None,
                    "to_name": target.name if target else None,
                },
                "score": 2 + (len(wip) - limit) * 2,
                "action": "Draft a rebalance",
            }
        )

    # Blocked chains: follow open blockers
    seen_roots: set[str] = set()
    for t in live:
        chain = [t]
        cur = t
        while True:
            nxt = _open_blockers(cur, by_id)
            if not nxt or nxt[0] in chain:
                break
            cur = nxt[0]
            chain.append(cur)
        if len(chain) < 3:
            continue
        root = chain[-1]
        if root.id in seen_roots:
            continue
        seen_roots.add(root.id)
        oldest = max(_days(_when(x.updated_at)) for x in chain[:-1])
        words = ["Two", "Three", "Four", "Five", "Six"]
        depth = len(chain)
        title = f"{chain[0].id} waits on {chain[1].id}" + "".join(
            f", which waits on {x.id}" for x in chain[2:]
        )
        out.append(
            {
                "kind": "chain",
                "key": f"chain:{root.id}",
                "ticket_id": root.id,
                "title": title,
                "detail": f"{words[min(depth, 6) - 2]} deep, oldest block {oldest} day{'s' if oldest != 1 else ''}. "
                f"{root.id} has sat in {STATUS_LABELS.get(root.status)} since {_weekday(status_since(root))}.",
                "data": {"chain": [x.id for x in chain], "root": root.id},
                "score": depth * 2 + oldest / 2,
                "action": f"Draft a comment on {root.id}",
            }
        )

    # Unassigned important work
    for t in live:
        if t.assignee or t.priority not in ("critical", "high") or t.parent_id:
            continue
        age = _days(_when(t.created_at))
        out.append(
            {
                "kind": "unassigned",
                "key": f"unassigned:{t.id}",
                "ticket_id": t.id,
                "title": f"{t.id} is {t.priority.capitalize()} and has no assignee",
                "detail": f"Created {age} day{'s' if age != 1 else ''} ago.",
                "data": {"chip": "No assignee"},
                "score": 5 if t.priority == "critical" else 3,
                "action": "Suggest an assignee",
            }
        )

    # At risk: due soon and blocked, or overdue
    today = datetime.now().astimezone().date()
    risky = []
    for t in live:
        if not t.due_date:
            continue
        try:
            due = datetime.strptime(t.due_date[:10], "%Y-%m-%d").date()
        except ValueError:
            continue
        blocked = bool(_open_blockers(t, by_id))
        if due < today or (blocked and (due - today).days <= 2):
            risky.append((t, due, blocked))
    if risky:
        risky.sort(key=lambda x: x[1])
        parts = [
            f"{t.id} is due {due.strftime('%b %-d')} but blocked"
            if blocked and due >= today
            else f"{t.id} was due {due.strftime('%b %-d')}"
            for t, due, blocked in risky[:3]
        ]
        out.append(
            {
                "kind": "at_risk",
                "key": "at_risk:" + ",".join(sorted(t.id for t, _, _ in risky)),
                "ticket_id": risky[0][0].id,
                "title": "; ".join(parts),
                "detail": "Seen on the Timeline. Moving dates is only a suggestion.",
                "data": {"tickets": [t.id for t, _, _ in risky], "chip": "At risk"},
                "score": 4 + max(0, (today - risky[0][1]).days),
                "action": "Draft new due dates",
            }
        )

    # Priority: a ticket that blocks several, with a lower priority than what it blocks
    rank = {p: i for i, p in enumerate(prompts.PRIORITIES)}
    for t in live:
        blocked = [
            by_id[b]
            for b in loads(t.blocks, [])
            if b in by_id and by_id[b].status not in OPEN
        ]
        if len(blocked) < 2:
            continue
        top = max((b.priority for b in blocked), key=lambda p: rank.get(p, 0))
        if rank.get(t.priority, 0) >= rank.get(top, 0):
            continue
        out.append(
            {
                "kind": "priority",
                "key": f"priority:{t.id}",
                "ticket_id": t.id,
                "title": f"Raise {t.id} from {t.priority.capitalize()} to {top.capitalize()}",
                "detail": f"It blocks {len(blocked)} tickets"
                + (" and is the root of a chain." if t.id in seen_roots else "."),
                "data": {"to": top},
                "score": 3 + len(blocked),
                "action": "Draft priority change",
            }
        )
    return out


async def check(project_id: str, *, digest: bool = True) -> dict:
    """Run the board-health check of a project: store the insights and write the standup digest."""
    async with database.async_session() as session:
        row = await svc_settings.get(session)
        cfg = svc_settings.health_config(row)
        tickets = (
            await session.exec(select(Ticket).where(Ticket.project_id == project_id))
        ).all()
        members = (
            await session.exec(select(Member).where(Member.project_id == project_id))
        ).all()
        found = compute(list(tickets), list(members), cfg)
        existing = {
            i.key: i
            for i in (
                await session.exec(
                    select(AiInsight).where(AiInsight.project_id == project_id)
                )
            ).all()
        }
        best = {}
        for f in found:
            if f["kind"] == "unassigned":
                t = next((x for x in tickets if x.id == f["ticket_id"]), None)
                people = await match.suggest_assignee(
                    session,
                    project_id,
                    t.title if t else "",
                    exclude_ticket=f["ticket_id"],
                )
                person = next((p for p in people if p["kind"] == "human"), None)
                if person:
                    f["detail"] += f" {person['name']} is the best match."
                    f["data"]["suggest"] = person["member_id"]
                    best[f["key"]] = person
        now = now_iso()
        keys = set()
        new_count = 0
        for f in found:
            keys.add(f["key"])
            ins = existing.get(f["key"])
            data = json.dumps({**f["data"], "action": f["action"]})
            if ins is None:
                session.add(
                    AiInsight(
                        id=str(uuid.uuid4()),
                        project_id=project_id,
                        kind=f["kind"],
                        key=f["key"],
                        ticket_id=f["ticket_id"],
                        title=f["title"],
                        detail=f["detail"],
                        data=data,
                        score=f["score"],
                        created_at=now,
                        updated_at=now,
                    )
                )
                new_count += 1
                continue
            worse = f["score"] > ins.score
            if ins.state == "dismissed" and cfg["return_if_worse"] and worse:
                ins.state, ins.seen = "open", False
                new_count += 1
            if ins.state == "snoozed" and (
                _when(ins.snoozed_until) or datetime.now(UTC)
            ) <= datetime.now(UTC):
                ins.state, ins.seen = "open", False
            if ins.state in ("resolved", "acted"):
                ins.state, ins.seen = "open", False
                new_count += 1
            ins.title, ins.detail, ins.data, ins.score, ins.ticket_id = (
                f["title"],
                f["detail"],
                data,
                f["score"],
                f["ticket_id"],
            )
            ins.updated_at = now
            session.add(ins)
        for key, ins in existing.items():
            if key not in keys and ins.state in ("open", "snoozed"):
                ins.state, ins.updated_at = "resolved", now
                session.add(ins)
        await session.commit()
    summary = None
    if digest:
        summary = await write_digest(project_id)
    await board_events.publish(board_events.INVALIDATE)
    return {"insights": len(found), "new": new_count, "digest": summary}


def _standup(tickets: list[Ticket]) -> dict:
    """Done yesterday / In progress / Blocked."""
    by_id = {t.id: t for t in tickets}
    y0 = (datetime.now().astimezone() - timedelta(days=1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    done = []
    for t in tickets:
        if t.status != "done":
            continue
        for e in reversed(loads(t.activity_log, [])):
            if (
                isinstance(e, dict)
                and e.get("field") == "status"
                and e.get("to") == "done"
            ):
                at = _when(e.get("at"))
                if at and at >= y0.astimezone(UTC):
                    done.append(t.id)
                break
    progress = [t.id for t in tickets if t.status == "in-progress"]
    blocked = [
        t.id for t in tickets if t.status not in OPEN and _open_blockers(t, by_id)
    ]
    return {"done": done, "in_progress": progress, "blocked": blocked}


async def write_digest(project_id: str) -> dict | None:
    """Store today's digest; the Board AI adds a short summary when it is available."""
    async with database.async_session() as session:
        tickets = list(
            (
                await session.exec(
                    select(Ticket).where(Ticket.project_id == project_id)
                )
            ).all()
        )
        project = await session.get(Project, project_id)
        stand = _standup(tickets)
        day = datetime.now().astimezone().date().isoformat()
        text, cost, tokens, member_id = "", 0.0, 0, None
        try:
            info = await svc_settings.guard_request(session, project_id, "health")
            row = await svc_settings.get(session)
            lines = [
                f"{t.id} [{STATUS_LABELS.get(t.status)}] {t.title}"
                for t in tickets
                if t.status not in OPEN
            ][:120]
            out = await llm.complete(
                info["profile"],
                system=prompts.system(
                    info["member"].name,
                    project.name if project else "",
                    row,
                    "Reply in two or three plain sentences.",
                ),
                prompt=(
                    "Write today's standup summary for the team from these facts.\n"
                    f"Done yesterday: {', '.join(stand['done']) or 'none'}\n"
                    f"In progress: {', '.join(stand['in_progress']) or 'none'}\n"
                    f"Blocked: {', '.join(stand['blocked']) or 'none'}\n"
                    "Open tickets:\n" + "\n".join(lines)
                ),
                max_tokens=svc_settings.max_tokens_for(row, info["profile"], 300),
                timeout=60,
            )
            text, cost, tokens, member_id = (
                out.text.strip(),
                out.cost,
                out.tokens_in + out.tokens_out,
                info["member"].id,
            )
            await svc_settings.record_usage(
                session, project_id, "health", member_id, None, out
            )
        except (AssistError, llm.LlmError) as exc:
            log.info("Board health summary skipped for %s: %s", project_id, exc)
        dg = AiDigest(
            id=str(uuid.uuid4()),
            project_id=project_id,
            day=day,
            summary=json.dumps({**stand, "text": text, "tickets": len(tickets)}),
            member_id=member_id,
            cost=cost,
            tokens=tokens,
            created_at=now_iso(),
        )
        session.add(dg)
        await session.commit()
        return {"id": dg.id, "day": day}


def _insight(i: AiInsight) -> dict:
    return {
        "id": i.id,
        "project_id": i.project_id,
        "kind": i.kind,
        "ticket_id": i.ticket_id,
        "title": i.title,
        "detail": i.detail,
        "data": loads(i.data, {}),
        "score": i.score,
        "state": i.state,
        "snoozed_until": i.snoozed_until,
        "seen": i.seen,
        "draft_id": i.draft_id,
        "created_at": i.created_at,
        "updated_at": i.updated_at,
    }


async def panel(session: AsyncSession, project_id: str) -> dict:
    """The Board health panel: digest, insights by state, schedule, unseen count."""
    row = await svc_settings.get(session)
    cfg = svc_settings.health_config(row)
    rows = (
        await session.exec(select(AiInsight).where(AiInsight.project_id == project_id))
    ).all()
    now = datetime.now(UTC)
    for i in rows:
        if i.state == "snoozed" and (_when(i.snoozed_until) or now) <= now:
            i.state, i.seen = "open", False
            session.add(i)
    await session.commit()
    open_ = sorted(
        [i for i in rows if i.state == "open"], key=lambda i: i.score, reverse=True
    )
    needs = open_[: int(cfg["max_insights"])]
    dg = (
        await session.exec(
            select(AiDigest)
            .where(AiDigest.project_id == project_id)
            .order_by(col(AiDigest.created_at).desc())
        )
    ).first()
    drafts = []
    for i in needs:
        if i.draft_id:
            d = await session.get(svc_drafts.AiDraft, i.draft_id)
            if d:
                drafts.append(svc_drafts.describe(d))
    info = await svc_settings.board_ai(session, project_id)
    return {
        "digest": (
            {
                "id": dg.id,
                "day": dg.day,
                "created_at": dg.created_at,
                "cost": dg.cost,
                "tokens": dg.tokens,
                **loads(dg.summary, {}),
            }
            if dg
            else None
        ),
        "needs_action": [_insight(i) for i in needs],
        "snoozed": [_insight(i) for i in rows if i.state == "snoozed"],
        "dismissed": [_insight(i) for i in rows if i.state == "dismissed"],
        "unseen": len([i for i in needs if not i.seen]),
        "drafts": drafts,
        "schedule": cfg,
        "board_ai": info["member"].name if info["member"] else None,
        "enabled": svc_settings.features(row).get("health", True),
    }


async def chips(session: AsyncSession, project_id: str) -> list[dict]:
    """Insight chips for board cards ("Stuck 6 days"; hover shows why)."""
    row = await svc_settings.get(session)
    if not svc_settings.features(row).get("health", True):
        return []
    cfg = svc_settings.health_config(row)
    rows = (
        await session.exec(
            select(AiInsight).where(
                AiInsight.project_id == project_id, AiInsight.state == "open"
            )
        )
    ).all()
    top = sorted(rows, key=lambda i: i.score, reverse=True)[: int(cfg["max_insights"])]
    out = []
    for i in top:
        data = loads(i.data, {})
        if i.ticket_id and data.get("chip"):
            out.append(
                {
                    "ticket_id": i.ticket_id,
                    "label": data["chip"],
                    "why": f"{i.title}. {i.detail}",
                    "insight_id": i.id,
                    "kind": i.kind,
                }
            )
    return out


async def set_state(
    session: AsyncSession, insight_id: str, action: str, *, hours: int = 24
) -> dict:
    """Snooze, dismiss or restore an insight."""
    i = await session.get(AiInsight, insight_id)
    if i is None:
        raise AssistError("not_found", "Insight not found.")
    if action == "snooze":
        i.state = "snoozed"
        i.snoozed_until = (
            datetime.now(UTC) + timedelta(hours=max(1, hours))
        ).isoformat()
    elif action == "dismiss":
        i.state = "dismissed"
    elif action == "restore":
        i.state, i.snoozed_until = "open", None
    else:
        raise AssistError("invalid", "Unknown action.")
    i.updated_at = now_iso()
    session.add(i)
    await session.commit()
    await session.refresh(i)
    await board_events.publish(board_events.INVALIDATE)
    return _insight(i)


async def snooze_all(session: AsyncSession, project_id: str, hours: int = 24) -> int:
    """Snooze every open insight (the toast's "Snooze all")."""
    rows = (
        await session.exec(
            select(AiInsight).where(
                AiInsight.project_id == project_id, AiInsight.state == "open"
            )
        )
    ).all()
    until = (datetime.now(UTC) + timedelta(hours=hours)).isoformat()
    for i in rows:
        i.state, i.snoozed_until = "snoozed", until
        session.add(i)
    await session.commit()
    await board_events.publish(board_events.INVALIDATE)
    return len(rows)


async def mark_seen(session: AsyncSession, project_id: str) -> None:
    """The panel was opened: the sidebar badge clears."""
    rows = (
        await session.exec(
            select(AiInsight).where(
                AiInsight.project_id == project_id, col(AiInsight.seen).is_(False)
            )
        )
    ).all()
    for i in rows:
        i.seen = True
        session.add(i)
    await session.commit()


async def mark_acted(session: AsyncSession, insight_id: str) -> None:
    """A draft made from the insight was applied."""
    i = await session.get(AiInsight, insight_id)
    if i is not None:
        i.state = "acted"
        session.add(i)
        await session.commit()


async def act(session: AsyncSession, insight_id: str, person: str) -> dict:
    """Act on an insight: prepare a draft (a nudge comment, a rebalance, new dates, a priority or assignee change)."""
    i = await session.get(AiInsight, insight_id)
    if i is None:
        raise AssistError("not_found", "Insight not found.")
    data = loads(i.data, {})
    info = await svc_settings.board_ai(session, i.project_id)
    member = info["member"]
    if i.kind in ("stuck", "chain"):
        reason = i.title + ". " + i.detail
        d = await svc_drafts.start(
            session,
            project_id=i.project_id,
            kind="nudge",
            owner=person,
            ticket_id=data.get("root") or i.ticket_id,
            data={"reason": reason},
            insight_id=i.id,
        )
    else:
        state, names = await svc_drafts._ticket_state(session, i.project_id)
        raw: list[dict] = []
        if i.kind == "wip" and data.get("move") and data.get("to"):
            raw = [
                {"op": "assignee", "ticket": data["move"], "to": data.get("to_name")}
            ]
        elif i.kind == "unassigned" and data.get("suggest"):
            m = await session.get(Member, data["suggest"])
            raw = [
                {"op": "assignee", "ticket": i.ticket_id, "to": m.name if m else None}
            ]
        elif i.kind == "at_risk":
            new_due = (
                datetime.now().astimezone().date() + timedelta(days=7)
            ).isoformat()
            raw = [
                {"op": "due_date", "ticket": tid, "to": new_due}
                for tid in data.get("tickets") or []
            ]
        elif i.kind == "priority":
            raw = [{"op": "priority", "ticket": i.ticket_id, "to": data.get("to")}]
        changes, problems = prompts.check_changes(raw, state, names)
        if not changes:
            raise AssistError(
                "invalid",
                "Nothing to change any more; the board already looks different.",
            )
        d = await svc_drafts.start(
            session,
            project_id=i.project_id,
            kind="changes",
            owner=person,
            payload={"changes": changes, "problems": problems, "intro": i.title},
            insight_id=i.id,
            member=member,
        )
        base = {}
        for ch in changes:
            t = await session.get(Ticket, ch["ticket"])
            if t:
                base[t.id] = t.updated_at
        d.base = json.dumps(base)
        session.add(d)
        await session.commit()
    i.draft_id = d.id
    session.add(i)
    await session.commit()
    await board_events.publish(board_events.INVALIDATE)
    return svc_drafts.describe(d)


# ---------------------------------------------------------------------------
# Schedule
# ---------------------------------------------------------------------------


def due_now(cfg: dict, last_day: str | None, now: datetime | None = None) -> bool:
    """Whether today's check should run now (after the time, on a chosen day, not yet done today)."""
    now = (now or datetime.now()).astimezone()
    if last_day == now.date().isoformat():
        return False
    wd = now.weekday()
    if wd >= 5 and not cfg.get("weekend"):
        return False
    if wd not in cfg.get("days", []):
        return False
    hh, mm = (int(x) for x in str(cfg.get("time", "09:00")).split(":"))
    return (now.hour, now.minute) >= (hh, mm)


async def tick() -> int:
    """Check every project whose schedule says so."""
    ran = 0
    async with database.async_session() as session:
        row = await svc_settings.get(session)
        if not svc_settings.features(row).get("health", True):
            return 0
        cfg = svc_settings.health_config(row)
        projects = (await session.exec(select(Project))).all()
        todo = []
        for p in projects:
            if not svc_settings.project_shared(row, p.id):
                continue
            info = await svc_settings.board_ai(session, p.id)
            if info["state"] != "ready":
                continue
            last = (
                await session.exec(
                    select(AiDigest)
                    .where(AiDigest.project_id == p.id)
                    .order_by(col(AiDigest.created_at).desc())
                )
            ).first()
            if due_now(cfg, last.day if last else None):
                todo.append(p.id)
    for pid in todo:
        try:
            await check(pid)
            ran += 1
        except Exception:  # noqa: BLE001 - one project must not stop the others
            log.exception("Board health check failed for %s", pid)
    return ran


async def _loop() -> None:
    while True:
        try:
            await tick()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("Board health tick failed")
        await asyncio.sleep(60)


def start_scheduler() -> None:
    """Start the daily check loop (called from the app lifespan)."""
    global _loop_task  # noqa: PLW0603
    if _loop_task is None or _loop_task.done():
        _loop_task = asyncio.create_task(_loop())


async def stop_scheduler() -> None:
    """Stop the loop."""
    global _loop_task  # noqa: PLW0603
    if _loop_task:
        _loop_task.cancel()
        try:
            await _loop_task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        _loop_task = None
