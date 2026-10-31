"""REST API of AI safety and cost beyond the members, runs and approvals endpoints of `api/ai.py`: the inbox,
notifications and alerts, remembered approvals, the resume checklist, token revoke, "Preview as this AI",
workspace defaults, the first-time checklist, prompt-injection flags, loop limits, "why was this blocked" and keys."""

import json
from datetime import UTC, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlmodel import col, select

import events as board_events
from api.ai import Session, _ai, _by, _err, _project
from models import (
    AiApproval,
    AiAudit,
    AiGrant,
    AiMember,
    AiRun,
    Member,
    Ticket,
)
from services.ai import approvals as svc_approvals
from services.ai import audit as svc_audit
from services.ai import budget, injection, safety
from services.ai import permissions as perms
from services.ai import runs as svc_runs
from services.ai.context import STATUS_LABELS, RunContext, rules_block
from services.ai.store import get_settings, loads, now_iso, parse_iso

router = APIRouter(tags=["ai-safety"])


async def _need_owner(session, project_id: str, what: str) -> str:
    """The person making the request, who must be the project's owner."""
    by = _by()
    if await safety.role_name(session, project_id, by) != "owner":
        raise HTTPException(
            status_code=403, detail=f"Only the project owner can {what}."
        )
    return by


async def _need_admin(session, project_id: str, what: str) -> str:
    by = _by()
    if safety.ROLE_RANK[await safety.role_name(session, project_id, by)] < 2:
        raise HTTPException(
            status_code=403, detail=f"Only owners and admins can {what}."
        )
    return by


# ---------------------------------------------------------------------------
# Who am I, the inbox, approval backlog and remembered approvals
# ---------------------------------------------------------------------------


@router.get("/projects/{project_id}/ai/me")
async def get_me(project_id: str, session: Session) -> dict:
    """The person this browser acts as and their role in the project."""
    await _project(session, project_id)
    me = _by()
    return {"name": me, "role": await safety.role_name(session, project_id, me)}


@router.get("/projects/{project_id}/ai/inbox")
async def get_inbox(project_id: str, session: Session) -> dict:
    """Inbox: AI mentions of the person, questions AI members wait on, and the number of pending approvals."""
    await _project(session, project_id)
    me = _by()
    humans = (
        await session.exec(
            select(Member).where(
                Member.project_id == project_id, Member.kind == "human"
            )
        )
    ).all()
    mine = next((m for m in humans if m.name == me), None)
    ai_rows = (
        await session.exec(
            select(Member).where(Member.project_id == project_id, Member.kind == "ai")
        )
    ).all()
    ai_names = {m.name for m in ai_rows}
    since = (datetime.now(UTC) - timedelta(days=14)).isoformat()
    mentions = []
    if mine is not None:
        tickets = (
            await session.exec(
                select(Ticket).where(
                    Ticket.project_id == project_id, Ticket.updated_at >= since
                )
            )
        ).all()
        token = f"(member:{mine.id})"
        plain = f"@{mine.name}"
        for t in tickets:
            for c in loads(t.comments, []):
                if c.get("deleted_at") or c.get("author") not in ai_names:
                    continue
                text = c.get("text") or ""
                if token in text or plain in text:
                    mentions.append(
                        {
                            "ticket_id": t.id,
                            "ticket_title": t.title,
                            "comment_id": c.get("id"),
                            "author": c.get("author"),
                            "text": text[:240],
                            "at": c.get("at"),
                        }
                    )
    mentions.sort(key=lambda m: m["at"] or "", reverse=True)
    waiting = (
        await session.exec(
            select(AiRun).where(
                AiRun.project_id == project_id, AiRun.state == "needs_input"
            )
        )
    ).all()
    names = {m.id: m.name for m in ai_rows}
    titles = (
        {
            t.id: t.title
            for t in (
                await session.exec(
                    select(Ticket).where(
                        col(Ticket.id).in_([r.ticket_id for r in waiting])
                    )
                )
            ).all()
        }
        if waiting
        else {}
    )
    questions = [
        {
            "run_id": r.id,
            "ticket_id": r.ticket_id,
            "ticket_title": titles.get(r.ticket_id, ""),
            "member_name": names.get(r.member_id),
            "text": (loads(r.question, {}) or {}).get("text", ""),
            "options": (loads(r.question, {}) or {}).get("options", []),
            "asked_at": (loads(r.question, {}) or {}).get("asked_at"),
            "to": (loads(r.question, {}) or {}).get("to"),
        }
        for r in waiting
    ]
    pending = await svc_approvals.list_approvals(
        session, project_id, status="pending", actor=me
    )
    return {
        "mentions": mentions[:30],
        "questions": questions,
        "approvals": len(pending),
        "me": {"name": me, "role": await safety.role_name(session, project_id, me)},
    }


@router.get("/projects/{project_id}/ai/approvals-backlog")
async def get_approvals_backlog(project_id: str, session: Session) -> dict:
    """Pending approvals per agent against the limits (10 per agent, 25 per project)."""
    await _project(session, project_id)
    return await svc_approvals.backlog(session, project_id)


@router.get("/projects/{project_id}/ai/grants")
async def get_always_grants(project_id: str, session: Session) -> list[dict]:
    """ "Always allow" decisions of the project: what an AI may do without asking again, revocable."""
    await _project(session, project_id)
    return await svc_approvals.always_grants(session, project_id)


@router.get("/tickets/{ticket_id}/ai/grants")
async def get_ticket_grants(ticket_id: str, session: Session) -> list[dict]:
    """“Approve & remember” decisions on a ticket: listed there and revocable until the ticket is Done."""
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        raise HTTPException(status_code=404, detail="Ticket not found")
    if ticket.status in ("done", "wont_do"):
        return []
    return await svc_approvals.grants_for_ticket(session, ticket_id)


@router.delete("/ai/grants/{grant_id}")
async def delete_grant(grant_id: str, session: Session) -> dict:
    """Revoke a remembered approval; the next such action asks again."""
    g = await session.get(AiGrant, grant_id)
    if g is None or g.revoked_at:
        raise HTTPException(status_code=404, detail="Grant not found")
    if g.kind != "approval":
        raise HTTPException(
            status_code=409, detail="Only remembered approvals can be revoked here."
        )
    g.revoked_at = now_iso()
    session.add(g)
    await session.commit()
    await svc_audit.record(
        g.project_id,
        "grant_revoked",
        "info",
        member_id=g.member_id,
        on_behalf_of=_by(),
        target=g.ticket_id,
        detail={"grant_id": g.id, "action": g.action, "by": _by()},
    )
    await board_events.publish(board_events.INVALIDATE)
    return {"revoked": True}


# ---------------------------------------------------------------------------
# Notifications, alerts, keys and tokens
# ---------------------------------------------------------------------------


@router.get("/projects/{project_id}/ai/notifications")
async def get_notifications(
    project_id: str,
    session: Session,
    after: Optional[str] = None,
    event: Optional[str] = None,
    limit: int = 30,
) -> dict:
    """Safety notifications the caller may see, newest first. `after` (an ISO time) returns only newer ones, for
    the toast poller; held ones wait for the digest and are not returned."""
    await _project(session, project_id)
    await safety.release_digest(project_id)
    rows = await safety.visible_notifications(
        session,
        project_id,
        _by(),
        after=after,
        event=event,
        limit=max(1, min(limit, 100)),
    )
    return {
        "items": [safety.notification_to_dict(n) for n in rows],
        "now": now_iso(),
    }


@router.get("/projects/{project_id}/ai/alerts")
async def get_alerts(project_id: str, session: Session) -> list[dict]:
    """Budget alerts (80% and 100%) of the last days, including the ones held for the digest."""
    await _project(session, project_id)
    rows = await safety.visible_notifications(
        session, project_id, _by(), event="budget", include_held=True, limit=10
    )
    return [safety.notification_to_dict(n) for n in rows]


@router.get("/projects/{project_id}/ai/keys")
async def get_keys(project_id: str, session: Session) -> dict:
    """Keys and tokens (F6): when each API key was rotated, and each member's MCP token with its last use."""
    await _project(session, project_id)
    settings = await get_settings(session, project_id)
    rows = (
        await session.exec(
            select(AiMember)
            .where(AiMember.project_id == project_id)
            .order_by(AiMember.created_at)
        )
    ).all()
    names = {
        m.id: m.name
        for m in (
            await session.exec(select(Member).where(Member.project_id == project_id))
        ).all()
    }
    now = datetime.now(UTC)
    out = []
    for p in rows:
        rotated = parse_iso(p.key_rotated_at or (p.created_at if p.key_last4 else None))
        age = (now - rotated).days if rotated else None
        out.append(
            {
                "member_id": p.id,
                "name": names.get(p.id, ""),
                "provider": p.provider,
                "connection": p.connection,
                "key_last4": p.key_last4,
                "key_rotated_at": rotated.isoformat() if rotated else None,
                "key_age_days": age,
                "reminder_days": settings.key_reminder_days,
                "rotate_due": age is not None and age >= settings.key_reminder_days,
                "token_created_at": p.created_at,
                "token_last_used_at": p.mcp_last_used_at,
                "token_revoked_at": p.token_revoked_at,
                "token_revoked_by": p.token_revoked_by,
            }
        )
    return {"members": out, "reminder_days": settings.key_reminder_days}


@router.post("/ai/members/{member_id}/revoke-token")
async def post_revoke_token(member_id: str, session: Session) -> dict:
    """Revoke the member's MCP token: its runs stop at the next call and it cannot start until reconnected."""
    member, profile = await _ai(session, member_id)
    by = await _need_admin(session, member.project_id, "revoke an MCP token")
    await svc_runs.revoke_tokens(member.project_id, [member_id], by=by)
    active = (
        await session.exec(
            select(AiRun).where(
                AiRun.member_id == member_id,
                col(AiRun.state).in_(["starting", "running", "needs_input"]),
            )
        )
    ).all()
    for r in active:
        try:
            await svc_runs.cancel(r.id, by=by, reason=f"Token revoked by {by}")
        except svc_runs.RunError:
            pass
    await board_events.publish(board_events.INVALIDATE)
    return {"revoked": True, "cancelled": len(active)}


@router.post("/ai/members/{member_id}/reconnect")
async def post_reconnect(member_id: str, session: Session) -> dict:
    """Reconnect a member whose token was revoked (a fresh token is issued for its next run)."""
    member, _ = await _ai(session, member_id)
    await _need_admin(session, member.project_id, "reconnect an AI member")
    try:
        await svc_runs.reconnect(member_id, by=_by())
    except svc_runs.RunError as exc:
        _err(exc, 404)
    await board_events.publish(board_events.INVALIDATE)
    return {"reconnected": True}


# ---------------------------------------------------------------------------
# Resume checklist, preview, workspace defaults, first-time checklist
# ---------------------------------------------------------------------------


@router.get("/projects/{project_id}/ai/resume-info")
async def get_resume_info(project_id: str, session: Session) -> dict:
    """The Resume dialog's facts (D3): what the AI did in the 10 minutes before the stop, and the budgets."""
    await _project(session, project_id)
    settings = await get_settings(session, project_id)
    stop = parse_iso(settings.paused_at) or datetime.now(UTC)
    start = stop - timedelta(minutes=10)
    rows = await svc_audit.list_entries(
        session, project_id, since=start.isoformat(), until=stop.isoformat(), limit=200
    )
    acted = [
        e
        for e in rows
        if e.result in ("allowed", "approved", "reverted", "blocked", "denied")
        and e.action in perms.ACTIONS
    ]
    spent = await budget.spent(session, budget.today_start(), project_id=project_id)
    members = (
        await session.exec(select(AiMember).where(AiMember.project_id == project_id))
    ).all()
    names = {
        m.id: m.name
        for m in (
            await session.exec(select(Member).where(Member.project_id == project_id))
        ).all()
    }
    over = []
    for p in members:
        hit = await budget.blocked(session, p, settings)
        if hit:
            over.append(p.id)
    return {
        "paused_at": settings.paused_at,
        "paused_by": settings.paused_by,
        "window_start": start.isoformat(),
        "window_end": stop.isoformat(),
        "actions": [
            {
                "id": e.id,
                "at": e.created_at,
                "member_name": e.member_name,
                "action": e.action,
                "target": e.target,
                "result": e.result,
            }
            for e in acted[:20]
        ],
        "action_count": len(acted),
        "spent_today": round(spent, 4),
        "daily_cap": settings.board_daily_cap,
        "budgets_ok": not over
        and (settings.board_daily_cap is None or spent < settings.board_daily_cap),
        "members": [
            {
                "member_id": p.id,
                "name": names.get(p.id, ""),
                "over_budget": p.id in over,
                "token_revoked": bool(p.token_revoked_at),
            }
            for p in members
        ],
    }


@router.get("/ai/members/{member_id}/preview")
async def get_preview(member_id: str, session: Session) -> dict:
    """“Preview as this AI” (A1): what it sees, what each board action does for it, which statuses it may move a
    ticket to, and the trusted rules it is given. Changes nothing."""
    member, profile = await _ai(session, member_id)
    settings = await get_settings(session, member.project_id)
    project_tickets = (
        await session.exec(
            select(Ticket).where(
                Ticket.project_id == member.project_id,
                col(Ticket.status).not_in(["done", "wont_do"]),
            )
        )
    ).all()
    assigned = [t for t in project_tickets if t.assignee == member_id]
    seen = project_tickets if profile.scope == "project" else assigned
    project = await _project(session, member.project_id)
    first = assigned[0].id if assigned else (seen[0].id if seen else "")
    ctx = RunContext(
        run_id="preview",
        member_id=member_id,
        member_name=member.name,
        project_id=member.project_id,
        ticket_id=first or "<ticket>",
        on_behalf_of=_by(),
        mode="work",
    )
    effective = [perms.effective(profile, a, settings) for a in perms.ACTIONS]
    return {
        "name": member.name,
        "scope": profile.scope,
        "ceiling": profile.ceiling,
        "safe_mode": settings.safe_mode or profile.safe_mode,
        "paused": settings.paused_all or profile.paused,
        "allow_external": profile.allow_external,
        "ticket_count": len(seen),
        "tickets": [
            {"id": t.id, "title": t.title, "status": t.status} for t in seen[:8]
        ],
        "may": [
            {
                "action": d.action,
                "label": perms.ACTIONS[d.action][0],
                "mode": d.mode,
                "reason": d.reason,
            }
            for d in effective
        ],
        "status_moves": [
            {
                "status": s,
                "label": STATUS_LABELS[s],
                "allowed": perms.ceiling_rank(profile.ceiling or "review")
                >= perms.status_rank(s),
            }
            for s in perms.STATUS_ORDER
        ],
        "rules": rules_block(
            ctx,
            profile,
            settings,
            project_name=project.name,
            ticket_status=assigned[0].status if assigned else "todo",
        ),
        "domains": loads(settings.allowed_domains, []),
    }


class DefaultsBody(BaseModel):
    """Workspace defaults: start values for new AI members."""

    template: str
    ceiling: str
    delete_mode: str
    daily_budget: Optional[float] = None
    monthly_cap: Optional[float] = None


@router.get("/projects/{project_id}/ai/workspace-defaults")
async def get_workspace_defaults(project_id: str, session: Session) -> dict:
    """Workspace defaults (I7)."""
    await _project(session, project_id)
    d = safety.defaults_to_dict(await safety.workspace_defaults(session))
    me = _by()
    return {**d, "can_edit": await safety.role_name(session, project_id, me) == "owner"}


@router.put("/projects/{project_id}/ai/workspace-defaults")
async def put_workspace_defaults(
    project_id: str, body: DefaultsBody, session: Session
) -> dict:
    """Save the defaults (owners only, audited). Existing members are unchanged."""
    await _project(session, project_id)
    by = await _need_owner(session, project_id, "change the workspace defaults")
    if body.template not in perms.TEMPLATES or body.template == "custom":
        raise HTTPException(
            status_code=422, detail="Role template: Developer, Reviewer or Read-only."
        )
    if body.ceiling not in perms.CEILINGS or perms.ceiling_rank(
        body.ceiling
    ) > perms.ceiling_rank("review"):
        raise HTTPException(
            status_code=422,
            detail="The default status ceiling is at most Review; Done is a per-member decision.",
        )
    if body.delete_mode not in ("blocked", "approval"):
        raise HTTPException(
            status_code=422, detail="Delete tickets: Blocked or Needs approval."
        )
    if (
        body.daily_budget is not None
        and body.monthly_cap is not None
        and body.monthly_cap < body.daily_budget
    ):
        raise HTTPException(
            status_code=422,
            detail=f"The monthly cap must be at least the daily budget (${body.daily_budget:.2f}).",
        )
    d = await safety.workspace_defaults(session)
    before = safety.defaults_to_dict(d)
    for k, v in body.model_dump().items():
        setattr(d, k, v)
    d.updated_by, d.updated_at = by, now_iso()
    session.add(d)
    await session.commit()
    after = safety.defaults_to_dict(d)
    await svc_audit.record(
        project_id,
        "workspace_defaults_updated",
        "info",
        member_name=by,
        on_behalf_of=by,
        detail={
            "changes": {
                k: [before[k], after[k]] for k in after if before[k] != after[k]
            },
            "by_role": "owner",
        },
    )
    return {**after, "can_edit": True}


class ChecklistBody(BaseModel):
    """Tick an item of the first-time checklist, or dismiss it."""

    tick: Optional[str] = None
    dismiss: Optional[bool] = None


@router.get("/projects/{project_id}/ai/checklist")
async def get_checklist(project_id: str, session: Session) -> dict:
    """First-time checklist “Review AI safety defaults” (I8): shown to the owner once there is an AI member."""
    await _project(session, project_id)
    settings = await get_settings(session, project_id)
    n = len(
        (
            await session.exec(
                select(AiMember).where(AiMember.project_id == project_id)
            )
        ).all()
    )
    state = safety.checklist_state(settings, n)
    state["show"] = state["show"] and await safety.role_name(
        session, project_id, _by()
    ) in ("owner", "admin")
    return state


@router.post("/projects/{project_id}/ai/checklist")
async def post_checklist(
    project_id: str, body: ChecklistBody, session: Session
) -> dict:
    """Tick an item or dismiss the checklist for now."""
    await _project(session, project_id)
    settings = await get_settings(session, project_id)
    raw = loads(settings.checklist, {})
    if body.tick in ("notifications", "pause"):
        raw["ticked"] = sorted({*(raw.get("ticked") or []), body.tick})
    if body.dismiss is not None:
        raw["dismissed"] = bool(body.dismiss)
    settings.checklist = json.dumps(raw)
    session.add(settings)
    await session.commit()
    n = len(
        (
            await session.exec(
                select(AiMember).where(AiMember.project_id == project_id)
            )
        ).all()
    )
    return safety.checklist_state(settings, n)


# ---------------------------------------------------------------------------
# Prompt injection: flags on comments, hide from AI, the blocked banner
# ---------------------------------------------------------------------------


async def _ticket(session, ticket_id: str) -> Ticket:
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        raise HTTPException(status_code=404, detail="Ticket not found")
    return ticket


async def _trust_sets(session, project_id: str) -> tuple[set[str], set[str]]:
    rows = (
        await session.exec(select(Member).where(Member.project_id == project_id))
    ).all()
    return (
        {m.name for m in rows if m.kind == "human"},
        {m.name for m in rows if m.kind in ("ai", "ai_removed")},
    )


@router.get("/tickets/{ticket_id}/ai/flags")
async def get_flags(ticket_id: str, session: Session) -> list[dict]:
    """Comments that look like instructions or come from outside the project (F4): what the AI is told about them."""
    ticket = await _ticket(session, ticket_id)
    humans, ai_names = await _trust_sets(session, ticket.project_id)
    return injection.flags_for_comments(loads(ticket.comments, []), humans, ai_names)


@router.get("/tickets/{ticket_id}/ai/blocked")
async def get_blocked(ticket_id: str, session: Session) -> list[dict]:
    """“AI action blocked” on a ticket (F5): blocked actions of the last 24 hours that followed text flagged as
    instructions."""
    ticket = await _ticket(session, ticket_id)
    since = (datetime.now(UTC) - timedelta(hours=24)).isoformat()
    rows = await svc_audit.list_entries(
        session, ticket.project_id, q=ticket_id, result="blocked", since=since, limit=20
    )
    comments = {c.get("id"): c for c in loads(ticket.comments, [])}
    out = []
    for e in rows:
        d = loads(e.detail, {})
        source = d.get("source")
        if not isinstance(source, dict) or not source.get("comment_id"):
            continue
        c = comments.get(source["comment_id"])
        if c is None:
            continue
        out.append(
            {
                "entry_id": e.id,
                "member_name": e.member_name,
                "action": e.action,
                "at": e.created_at,
                "reason": d.get("reason"),
                "comment_id": source["comment_id"],
                "author": source.get("author"),
                "phrases": source.get("phrases") or [],
            }
        )
    return out


# ---------------------------------------------------------------------------
# Loops: the run limit of a ticket, the chain of mentions
# ---------------------------------------------------------------------------


@router.get("/tickets/{ticket_id}/ai/run-limit")
async def get_run_limit(ticket_id: str, session: Session) -> dict:
    """Runs of a ticket today against the limit (G): the box with “Allow 3 more runs”."""
    ticket = await _ticket(session, ticket_id)
    settings = await get_settings(session, ticket.project_id)
    used = len(await safety.limited_runs_today(session, ticket_id))
    extra = await safety.extra_runs_today(session, ticket_id)
    limit = settings.runs_per_ticket_per_day + extra
    return {
        "ticket_id": ticket_id,
        "used": used,
        "limit": limit,
        "base_limit": settings.runs_per_ticket_per_day,
        "extra": extra,
        "reached": used >= limit,
        "can_allow_more": await safety.role_name(session, ticket.project_id, _by())
        == "owner",
    }


@router.post("/tickets/{ticket_id}/ai/allow-more-runs")
async def post_allow_more_runs(ticket_id: str, session: Session) -> dict:
    """Owners allow 3 more runs on this ticket today."""
    ticket = await _ticket(session, ticket_id)
    by = await _need_owner(session, ticket.project_id, "allow more runs")
    await safety.add_grant(
        session,
        project_id=ticket.project_id,
        kind="extra_runs",
        ticket_id=ticket_id,
        amount=3,
        day=budget.day_key(),
        created_by=by,
    )
    await svc_audit.record(
        ticket.project_id,
        "extra_runs_allowed",
        "info",
        member_name=by,
        on_behalf_of=by,
        target=ticket_id,
        detail={"runs": 3},
    )
    return await get_run_limit(ticket_id, session)


@router.get("/tickets/{ticket_id}/ai/chain")
async def get_chain(ticket_id: str, session: Session) -> dict:
    """Who woke whom on this ticket (G): the latest chain of @mentions between AI members, and the last mention
    that was not delivered and why."""
    ticket = await _ticket(session, ticket_id)
    settings = await get_settings(session, ticket.project_id)
    runs = (
        await session.exec(
            select(AiRun)
            .where(AiRun.ticket_id == ticket_id)
            .order_by(col(AiRun.queued_at).desc())
            .limit(30)
        )
    ).all()
    names = {
        m.id: m.name
        for m in (
            await session.exec(
                select(Member).where(Member.project_id == ticket.project_id)
            )
        ).all()
    }
    chained = next((r for r in runs if loads(r.chain, [])), None)
    nodes: list[dict] = []
    if chained is not None:
        nodes.append({"kind": "person", "name": chained.started_by, "depth": 0})
        for i, mid in enumerate(loads(chained.chain, []), 1):
            nodes.append({"kind": "ai", "name": names.get(mid, "AI"), "depth": i})
        nodes.append(
            {
                "kind": "ai",
                "name": names.get(chained.member_id, "AI"),
                "depth": len(loads(chained.chain, [])) + 1,
            }
        )
    since = (datetime.now(UTC) - timedelta(hours=24)).isoformat()
    blocked = await svc_audit.list_entries(
        session,
        ticket.project_id,
        q=ticket_id,
        result="blocked",
        actions=["mention"],
        since=since,
        limit=1,
    )
    last = None
    if blocked:
        d = loads(blocked[0].detail, {})
        last = {
            "at": blocked[0].created_at,
            "to": d.get("to"),
            "reason": d.get("reason"),
            "chain": [names.get(i, "AI") for i in d.get("chain", [])],
        }
    return {
        "nodes": nodes,
        "max_depth": settings.max_chain_depth,
        "cooldown_s": settings.loop_cooldown_s,
        "no_repeat": settings.no_repeat_chain,
        "blocked": last,
    }


# ---------------------------------------------------------------------------
# Audit: the drawer, bulk revert preview, why was this blocked
# ---------------------------------------------------------------------------


@router.get("/ai/audit/{entry_id}")
async def get_audit_entry(entry_id: str, session: Session) -> dict:
    """The audit drawer (E1): the entry with its redaction count, the approval that allowed it and the
    prompt-source trace."""
    e = await session.get(AiAudit, entry_id)
    if e is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    (row,) = await svc_audit.enrich(session, [e])
    row["trace"] = await svc_audit.trace(session, e)
    approval_id = (row["detail"] or {}).get("approval_id")
    row["approval"] = None
    if approval_id and not str(approval_id).startswith("remembered:"):
        a = await session.get(AiApproval, approval_id)
        if a is not None:
            row["approval"] = {
                "id": a.id,
                "status": a.status,
                "decided_by": a.decided_by,
                "decided_at": a.decided_at,
                "note": a.decision_note,
                "run_id": a.run_id,
            }
    elif approval_id:
        row["approval"] = {
            "id": approval_id,
            "status": "remembered",
            "decided_by": None,
        }
    return row


class RevertPreviewBody(BaseModel):
    """Audit entries about to be reverted."""

    entry_ids: list[str]


@router.post("/ai/audit/revert-preview")
async def post_revert_preview(body: RevertPreviewBody, session: Session) -> list[dict]:
    """What a bulk revert would do (E2): one row per entry, “will revert” or “skipped” with the reason (a person
    changed it since)."""
    rows = (
        await session.exec(select(AiAudit).where(col(AiAudit.id).in_(body.entry_ids)))
    ).all()
    out = []
    for e in sorted(rows, key=lambda r: r.seq, reverse=True):
        d = loads(e.detail, {})
        before, after = d.get("before"), d.get("after")
        row = {
            "entry_id": e.id,
            "target": e.target,
            "member_name": e.member_name,
            "fields": list(before) if isinstance(before, dict) else [],
            "result": "revert",
            "reason": None,
            "line": None,
        }
        ticket = await session.get(Ticket, e.target) if e.target else None
        if (
            not isinstance(before, dict)
            or not isinstance(after, dict)
            or ticket is None
        ):
            row.update(result="skip", reason="This change cannot be reverted.")
        elif e.reverted_at:
            row.update(result="skip", reason="Already reverted.")
        else:
            conflicts = []
            for field in before:
                cur = getattr(ticket, field, None)
                if field == "tags":
                    cur = loads(cur, [])
                if (cur or None) != (after.get(field) or None):
                    who = next(
                        (
                            a
                            for a in reversed(loads(ticket.activity_log, []))
                            if a.get("field") == field
                        ),
                        None,
                    )
                    conflicts.append((field, cur, who))
            if len(conflicts) == len(before):
                field, cur, who = conflicts[0]
                row.update(
                    result="skip",
                    reason=(
                        f"{who.get('actor')} set {cur if cur not in (None, '') else '—'} at "
                        f"{(who.get('at') or '')[11:16]}, after the AI"
                        if who
                        else "Changed again after the AI"
                    ),
                )
            row["line"] = ", ".join(
                f"{f} → {before[f] if before[f] not in (None, '') else '—'}"
                for f in before
            )
        out.append(row)
    return out


_CODE_TEXT = {
    "status_ceiling": "Status ceiling (agent)",
    "approvals_full": "Approvals are full",
}


@router.get("/ai/audit/{entry_id}/why")
async def get_why_blocked(entry_id: str, session: Session) -> dict:
    """“Why was this blocked?” (I2): the action, what blocked it and who can change that."""
    e = await session.get(AiAudit, entry_id)
    if e is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    d = loads(e.detail, {})
    profile = await session.get(AiMember, e.member_id) if e.member_id else None
    settings = await get_settings(session, e.project_id)
    code = d.get("code")
    blocked_by = _CODE_TEXT.get(code or "", None)
    who = "Owners"
    layers: list[dict] = []
    if code == "status_ceiling" and profile is not None:
        blocked_by = f"Status ceiling (agent): {STATUS_LABELS.get(profile.ceiling, profile.ceiling)}"
    elif profile is not None and e.action in perms.ACTIONS:
        dec = perms.effective(profile, e.action, settings)
        layers = dec.layers
        worst = max(dec.layers, key=lambda x: perms._RANK[x["mode"]])
        if perms._RANK[worst["mode"]] > 0:
            blocked_by = (
                f"{worst['layer']}: {perms.ACTIONS[e.action][0]} is {worst['mode']}"
            )
            if worst["layer"].startswith(("Safe mode", "Pause")):
                who = "Owners and admins"
    if blocked_by is None:
        blocked_by = d.get("reason") or "A rule of this project"
    request = d.get("request") or {}
    action_text = (
        f"{e.member_name}: {perms.ACTIONS.get(e.action, (e.action,))[0].lower()}"
    )
    if e.target:
        action_text += f" on {e.target}"
    if request.get("status"):
        action_text = f"{e.member_name}: move {e.target} to {STATUS_LABELS.get(request['status'], request['status'])}"
    return {
        "entry_id": e.id,
        "action_text": action_text,
        "blocked_by": blocked_by,
        "who_can_change": who,
        "reason": d.get("reason"),
        "layers": [
            {"layer": layer["layer"], "mode": layer["mode"]} for layer in layers
        ],
        "owner": next(
            (
                m.name
                for m in (
                    await session.exec(
                        select(Member)
                        .where(
                            Member.project_id == e.project_id, Member.kind == "human"
                        )
                        .order_by(col(Member.created_at))
                    )
                ).all()
                if m.role == "admin"
            ),
            None,
        ),
    }


@router.post("/ai/audit/{entry_id}/ask-access")
async def post_ask_access(entry_id: str, session: Session) -> dict:
    """“Ask owner for access”: tells the owners what was blocked. Nothing changes until an owner confirms."""
    e = await session.get(AiAudit, entry_id)
    if e is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    why = await get_why_blocked(entry_id, session)
    by = _by()
    await safety.notify(
        e.project_id,
        "approval_requested",
        "Access requested",
        f"{by} asks for access: {why['action_text']} was blocked by {why['blocked_by']}.",
        ref_kind="audit",
        ref_id=e.id,
        member_id=e.member_id,
    )
    await svc_audit.record(
        e.project_id,
        "access_requested",
        "info",
        member_id=e.member_id,
        member_name=e.member_name,
        on_behalf_of=by,
        target=e.target,
        detail={"entry_id": e.id, "blocked_by": why["blocked_by"]},
    )
    return {"sent": True, "to": why["owner"]}
