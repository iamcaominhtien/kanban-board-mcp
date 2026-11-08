"""The AI helpers of the Idea Space on the assistant engine (AI v2): triage advice, Shape with AI, Ask, Prepare a
ticket and the grooming digest. Each is one turn with a skill; the ideas are given to the skill (the board's tools
do not read ideas). Nothing is applied for the person: the results come back as suggestions."""

import asyncio
import json
from datetime import UTC, datetime
from typing import Any

from sqlmodel import col, func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import AiUsage, IdeaAdvice, IdeaAiSettings, IdeaDigest, IdeaTicket, Project

from . import engine, sessions
from .errors import AssistError

FEATURE = "ideas"
OPEN_STAGES_OFF = ("archived", "shipped", "merged")
SETTING_KEYS = (
    "enabled",
    "triage_advice",
    "weekly_grooming",
    "ask",
    "read_docs",
    "read_repo",
    "daily_cap",
)
SHAPE_KINDS = ("problem", "assumptions", "tests", "effort", "exists", "ask")
SHAPES: dict[str, asyncio.Task] = {}


class IdeaAiError(AssistError):
    """The Idea Space's AI cannot help now: `off`, `no_member`, `unavailable`, `cap`, `failed`, `bad_answer`."""


async def get_settings(session: AsyncSession, project_id: str | None) -> IdeaAiSettings:
    """The AI switches of a project's ideas (created with defaults on first use)."""
    row = await session.get(IdeaAiSettings, project_id or "")
    if row is None:
        row = IdeaAiSettings(project_id=project_id or "")
        session.add(row)
        await session.commit()
        await session.refresh(row)
    return row


def settings_out(row: IdeaAiSettings) -> dict[str, Any]:
    """The switches as the API shows them."""
    return {k: getattr(row, k) for k in SETTING_KEYS}


async def update_settings(
    session: AsyncSession, project_id: str | None, **values: Any
) -> IdeaAiSettings:
    """Change the AI switches; values left out stay as they are."""
    row = await get_settings(session, project_id)
    for k, v in values.items():
        if k in SETTING_KEYS and v is not None:
            setattr(row, k, v)
    row.updated_at = datetime.now(UTC).isoformat()
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


async def spent_today(session: AsyncSession) -> float:
    """What the Idea Space's AI helpers cost today."""
    start = (
        datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    )
    total = (
        await session.exec(
            select(func.coalesce(func.sum(AiUsage.cost), 0.0)).where(
                AiUsage.feature == FEATURE, col(AiUsage.created_at) >= start
            )
        )
    ).one()
    return round(float(total or 0), 4)


async def _booking_project(session: AsyncSession, project_id: str | None) -> str | None:
    """The project a turn is booked on: the idea's own, else the first project of the board."""
    if project_id:
        return project_id
    first = (
        await session.exec(select(Project).order_by(col(Project.name)).limit(1))
    ).first()
    return first.id if first else None


async def status(session: AsyncSession, project_id: str | None) -> dict[str, Any]:
    """Whether AI help is available for the project (or for ideas with no project), and why not."""
    row = await get_settings(session, project_id)
    spent = await spent_today(session)
    booking = await _booking_project(session, project_id)
    info = (
        await engine.ready(booking)
        if booking
        else {
            "state": "not_configured",
            "message": "Create a project first.",
            "member": None,
        }
    )
    if not row.enabled:
        state, message = "off", "AI help is off for these ideas."
    elif info["state"] != "ready":
        state, message = "unavailable", info["message"]
    elif spent >= row.daily_cap:
        state, message = (
            "cap",
            "Today's AI budget for ideas is used up. It resets tomorrow.",
        )
    else:
        state, message = "on", ""
    return {
        "state": state,
        "message": message,
        "settings": settings_out(row),
        "member": "Idea AI",
        "spent_today": spent,
        "cap": row.daily_cap,
        "limited": project_id is None,
        "hints": {
            "advice": 0.02,
            "shape": 0.03,
            "exists": 0.05,
            "grooming": 0.05,
            "ask": 0.03,
            "ticket": 0.04,
        },
    }


async def _require(
    session: AsyncSession, project_id: str | None, switch: str | None = None
) -> str:
    """The project to book on, or the reason AI cannot help now."""
    st = await status(session, project_id)
    if st["state"] != "on":
        raise IdeaAiError(
            {"off": "off", "cap": "cap"}.get(st["state"], "unavailable"), st["message"]
        )
    if switch and not st["settings"].get(switch, True):
        raise IdeaAiError("off", "This helper is off for these ideas.")
    return await _booking_project(session, project_id)  # type: ignore[return-value]


def brief(i: IdeaTicket, *, full: bool = False) -> dict[str, Any]:
    """An idea as a skill is given it: a short line, or everything with `full`."""
    out: dict[str, Any] = {
        "id": i.id,
        "title": i.title,
        "stage": i.stage,
        "summary": (i.description or i.problem_statement or i.body or "")[:300],
        "last_touched_at": i.last_touched_at or i.updated_at,
    }
    if full:
        out.update(
            {
                "body": (i.body or "")[:12000],
                "description": (i.description or "")[:4000],
                "problem_statement": i.problem_statement,
                "tags": json.loads(i.tags or "[]"),
                "effort_guess": i.effort_guess,
                "assumptions": [
                    {"id": a.id, "text": a.text, "impact": a.impact, "status": a.status}
                    for a in (i.assumption_records or [])
                ],
            }
        )
    return out


async def _ideas(
    session: AsyncSession,
    project_id: str | None,
    scope: str = "project",
    limit: int = 80,
) -> list[IdeaTicket]:
    stmt = select(IdeaTicket).where(col(IdeaTicket.stage).notin_(OPEN_STAGES_OFF))
    if scope == "project" and project_id:
        stmt = stmt.where(IdeaTicket.project_id == project_id)
    elif scope == "none":
        stmt = stmt.where(col(IdeaTicket.project_id).is_(None))
    return list(
        (
            await session.exec(
                stmt.order_by(col(IdeaTicket.updated_at).desc()).limit(limit)
            )
        ).all()
    )


async def _turn(
    project_id: str,
    name: str,
    skill: str,
    inputs: dict[str, Any],
    person: str,
    **kw: Any,
) -> engine.Turn:
    out = await engine.turn(
        project_id,
        name=name,
        skill=skill,
        inputs=inputs,
        by=person,
        feature=FEATURE,
        timeout_s=300.0,
        **kw,
    )
    if out.state == "cancelled":
        raise IdeaAiError("stopped", "Stopped.")
    if out.state != "finished":
        raise IdeaAiError("failed", out.error or "The AI could not answer. Try again.")
    return out


# --------------------------------------------------------------------------- triage advice


async def advise(
    session: AsyncSession, idea_id: str, *, person: str
) -> IdeaAdvice | None:
    """Read an idea and suggest Keep, Park, Merge or Archive. Returns None when the AI is not sure."""
    idea = await session.get(IdeaTicket, idea_id)
    if idea is None:
        raise IdeaAiError("not_found", "Idea not found.")
    project_id = await _require(session, idea.project_id, "triage_advice")
    others = [
        {"id": o.id, "title": o.title}
        for o in await _ideas(session, idea.project_id)
        if o.id != idea.id
    ][:60]
    stamp = idea.updated_at
    out = await _turn(
        project_id,
        sessions.idea_name(idea.id),
        "idea-triage",
        {"idea": brief(idea, full=True), "others": others},
        person,
    )
    data = out.data()
    action = data.get("action")
    if action not in ("keep", "park", "merge", "archive", "none"):
        raise IdeaAiError("bad_answer", "The AI gave an answer that could not be used.")
    if action == "merge" and data.get("target_id") not in {o["id"] for o in others}:
        action = "none"
    for old in (
        await session.exec(
            select(IdeaAdvice).where(
                IdeaAdvice.idea_id == idea.id, IdeaAdvice.state == "open"
            )
        )
    ).all():
        await session.delete(old)
    row = IdeaAdvice(
        idea_id=idea.id,
        action=action,
        reason=str(data.get("reason") or "")[:500],
        confidence=data.get("confidence")
        if data.get("confidence") in ("high", "medium", "low")
        else "medium",
        target_id=data.get("target_id") if action == "merge" else None,
        archive_reason=data.get("archive_reason") if action == "archive" else None,
        park_days=int(data["park_days"])
        if action == "park" and str(data.get("park_days") or "").isdigit()
        else None,
        idea_stamp=stamp,
        cost=out.cost,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return None if action == "none" else row


async def advice_for(
    session: AsyncSession, idea_ids: list[str], *, include_none: bool = False
) -> list[dict[str, Any]]:
    """Open advice for the ideas, each marked `stale` when the idea changed after the AI read it."""
    if not idea_ids:
        return []
    rows = (
        await session.exec(
            select(IdeaAdvice)
            .where(col(IdeaAdvice.idea_id).in_(idea_ids), IdeaAdvice.state == "open")
            .order_by(col(IdeaAdvice.created_at))
        )
    ).all()
    out = []
    for a in rows:
        if a.action == "none" and not include_none:
            continue
        idea = await session.get(IdeaTicket, a.idea_id)
        target = await session.get(IdeaTicket, a.target_id) if a.target_id else None
        out.append(
            {
                "id": a.id,
                "idea_id": a.idea_id,
                "action": a.action,
                "reason": a.reason,
                "confidence": a.confidence,
                "target_id": a.target_id,
                "target_title": target.title if target else None,
                "archive_reason": a.archive_reason,
                "park_days": a.park_days,
                "cost": a.cost,
                "created_at": a.created_at,
                "stale": bool(
                    idea is not None
                    and a.idea_stamp
                    and idea.updated_at != a.idea_stamp
                ),
            }
        )
    return out


async def set_advice_state(
    session: AsyncSession, advice_id: str, state: str
) -> IdeaAdvice:
    """Mark a piece of advice accepted or ignored."""
    a = await session.get(IdeaAdvice, advice_id)
    if a is None:
        raise ValueError("Advice not found")
    a.state = state
    session.add(a)
    await session.commit()
    return a


# --------------------------------------------------------------------------- ask, shape, prepare a ticket


async def ask(
    session: AsyncSession,
    question: str,
    *,
    project_id: str | None,
    scope: str,
    person: str,
) -> dict[str, Any]:
    """Answer a question about the ideas in view, naming the ideas it used."""
    booking = await _require(session, project_id, "ask")
    ideas = await _ideas(session, project_id, scope)
    out = await _turn(
        booking,
        f"idea-ask:{project_id or 'all'}",
        "idea-ask",
        {"question": question, "scope": scope, "ideas": [brief(i) for i in ideas]},
        person,
    )
    data = out.data()
    known = {i.id: i.title for i in ideas}
    actions = []
    for a in data.get("actions") or []:
        ids = (
            [x for x in (a.get("idea_ids") or []) if x in known]
            if isinstance(a, dict)
            else []
        )
        if ids:
            actions.append(
                {
                    "kind": "open_idea",
                    "idea_id": ids[0],
                    "idea_title": known[ids[0]],
                    "title": a.get("label"),
                }
            )
    return {
        "answer": data.get("answer") or out.text,
        "sources": [
            {"id": s["id"], "title": s.get("title") or known[s["id"]]}
            for s in data.get("sources") or []
            if isinstance(s, dict) and s.get("id") in known
        ],
        "actions": actions[:3],
        "ideas_read": len(ideas),
        "member": out.member,
        "cost": out.cost,
    }


async def shape(
    session: AsyncSession, idea_id: str, kind: str, *, question: str | None, person: str
) -> dict[str, Any]:
    """Draft the problem, assumptions, cheapest tests, an effort guess, what already exists, or an answer."""
    if kind not in SHAPE_KINDS:
        raise ValueError("Unknown kind of help")
    if kind == "ask" and not (question or "").strip():
        raise ValueError("Write a question first")
    idea = await session.get(IdeaTicket, idea_id)
    if idea is None:
        raise IdeaAiError("not_found", "Idea not found.")
    project_id = await _require(session, idea.project_id)
    inputs = {"kind": kind, "question": question, "idea": brief(idea, full=True)}
    out = await _turn(
        project_id, sessions.idea_name(idea.id), "idea-shape", inputs, person
    )
    data = out.data()
    if not data:
        if kind != "ask" or not out.text:
            raise IdeaAiError(
                "bad_answer", "The AI gave an answer that could not be used."
            )
        data = {"answer": out.text}
    keep = {
        "problem": ("problem", "idea"),
        "assumptions": ("assumptions",),
        "tests": ("tests",),
        "effort": ("effort", "why", "files"),
        "exists": ("summary", "items", "found"),
        "ask": ("answer",),
    }[kind]
    result = {k: data[k] for k in keep if k in data}
    if kind == "exists":
        result["items"] = [
            x
            for x in (result.pop("found", None) or result.get("items") or [])
            if isinstance(x, dict)
        ]
    return {
        "kind": kind,
        "ai": True,
        "member": out.member,
        "member_id": "",
        "cost": out.cost,
        "model": out.model,
        **result,
    }


async def run_stoppable(request_id: str | None, coro) -> Any:
    """Run a shape request so `stop_shape(request_id)` can end it."""
    if not request_id:
        return await coro
    task = asyncio.ensure_future(coro)
    SHAPES[request_id] = task
    try:
        return await task
    except asyncio.CancelledError as exc:
        raise IdeaAiError("stopped", "Stopped.") from exc
    finally:
        SHAPES.pop(request_id, None)


def stop_shape(request_id: str) -> bool:
    """Stop a running shape request. False when it had already ended."""
    task = SHAPES.get(request_id)
    if task is None or task.done():
        return False
    task.cancel()
    return True


async def prepare_ticket(
    session: AsyncSession, idea_id: str, *, person: str
) -> dict[str, Any]:
    """Draft the ticket text, acceptance criteria and a split for the Promote dialog."""
    idea = await session.get(IdeaTicket, idea_id)
    if idea is None:
        raise IdeaAiError("not_found", "Idea not found.")
    project_id = await _require(session, idea.project_id)
    out = await _turn(
        project_id,
        sessions.idea_name(idea.id),
        "idea-prepare-ticket",
        {"idea": brief(idea, full=True)},
        person,
    )
    data = out.data()
    if not data.get("title"):
        raise IdeaAiError("bad_answer", "The AI gave an answer that could not be used.")
    return {
        "title": str(data["title"])[:200],
        "description": data.get("description") or "",
        "acceptance_criteria": [str(x) for x in data.get("acceptance_criteria") or []],
        "sub_tickets": [str(x) for x in data.get("sub_tickets") or []],
        "member": out.member,
        "cost": out.cost,
    }


# --------------------------------------------------------------------------- the grooming digest


def digest_out(d: IdeaDigest) -> dict[str, Any]:
    """A digest as the API shows it."""
    return {
        "id": d.id,
        "project_id": d.project_id or None,
        "text": d.text,
        "items": json.loads(d.items or "[]"),
        "ai": d.ai,
        "cost": d.cost,
        "ideas_read": d.ideas_read,
        "created_at": d.created_at,
    }


async def latest_digest(
    session: AsyncSession, project_id: str | None
) -> IdeaDigest | None:
    """The newest grooming digest of a project (or of the ideas with no project)."""
    return (
        await session.exec(
            select(IdeaDigest)
            .where(IdeaDigest.project_id == (project_id or ""))
            .order_by(col(IdeaDigest.created_at).desc())
            .limit(1)
        )
    ).first()


async def groom(
    session: AsyncSession, project_id: str | None, *, person: str
) -> IdeaDigest:
    """Write the digest now."""
    booking = await _require(session, project_id, "weekly_grooming")
    ideas = await _ideas(session, project_id, "project" if project_id else "none")
    out = await _turn(
        booking,
        f"idea-digest:{project_id or 'all'}",
        "idea-digest",
        {"project_id": project_id, "ideas": [brief(i) for i in ideas]},
        person,
    )
    data = out.data()
    known = {i.id for i in ideas}
    items = [
        {
            "kind": str(x.get("kind") or "note"),
            "idea_ids": [i for i in x.get("idea_ids") or [] if i in known],
            "text": str(x.get("text") or ""),
        }
        for x in data.get("items") or []
        if isinstance(x, dict)
    ]
    row = IdeaDigest(
        project_id=project_id or "",
        text=data.get("text") or out.text,
        items=json.dumps(items),
        ai=True,
        cost=out.cost,
        ideas_read=len(ideas),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row
