"""Approvals (a person decides an AI action) and reverts (undo one AI change, or a whole run's)."""

import json
from datetime import UTC, datetime, timedelta

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
import events as board_events
import services.activity as svc_activity
import services.tickets as svc_tickets
from models import (
    AiApproval,
    AiAudit,
    AiGrant,
    AiMember,
    AiRun,
    DocsPage,
    Member,
    Ticket,
    TicketUpdate,
)

from . import audit, guard, safety
from .context import RunContext
from .store import get_settings, loads, now_iso, parse_iso

RAISE_CAP = "raise_cap"  # approval action created at the cap with the "Ask an owner first" policy
RAISE_CAP_USD = 2.0

FIELD_LABELS = {
    "title": "Title",
    "description": "Description",
    "type": "Type",
    "priority": "Priority",
    "status": "Status",
    "estimate": "Estimate",
    "due_date": "Due date",
    "start_date": "Start date",
    "tags": "Tags",
    "assignee": "Assignee",
}
TRIGGERS = {
    "assign": "Your assignment of {ticket}",
    "run_button": "A run started from {ticket}",
    "mention": "A mention on {ticket}",
    "ask": "A question asked on {ticket}",
    "retry": "A retry of the run on {ticket}",
    "request_changes": "Requested changes on {ticket}",
    "answer": "An answer on {ticket}",
    "schedule": "A schedule on {ticket}",
}


PROPOSAL_TOOL = "docs_proposal"  # an AI member's page edit, reviewed as a Docs AI proposal (services/docs_ai/proposals)


def is_proposal(a: AiApproval) -> bool:
    """The approval stands for a Docs AI proposal (decided by accepting or rejecting its changes)."""
    return loads(a.payload, {}).get("tool") == PROPOSAL_TOOL


class ApprovalError(ValueError):
    """An approval or revert request was refused."""


class ApprovalForbidden(ApprovalError):
    """The person may not decide a request of this risk (B5)."""


class ApprovalStale(ApprovalError):
    """The ticket changed since the request; the person must approve the updated change or deny."""

    def __init__(self, stale: dict):
        """`stale` is the same structure the approval card shows."""
        super().__init__(
            "The ticket changed since the request. Approve the updated change, or deny."
        )
        self.stale = stale


# Actions a person may allow for good (not only until a ticket is Done): editing Docs pages
ALWAYS_ALLOWED = ("edit_docs",)


def always_allowed(a: AiApproval) -> bool:
    """Whether "Always allow" is offered for this request: a Docs edit that is not high risk."""
    return a.action in ALWAYS_ALLOWED and a.risk != "high" and not is_proposal(a)


def to_dict(a: AiApproval, member_name: str | None = None) -> dict:
    """An approval for the API (the plain row; `enrich` adds the diff, trigger and who may decide)."""
    payload = loads(a.payload, {})
    return {
        "id": a.id,
        "project_id": a.project_id,
        "member_id": a.member_id,
        "member_name": member_name,
        "run_id": a.run_id,
        "ticket_id": a.ticket_id,
        "action": a.action,
        "summary": a.summary,
        "params": payload.get("params") or {},
        "proposal_id": payload.get("proposal_id"),
        "page_id": (payload.get("params") or {}).get("page_id")
        if payload.get("proposal_id")
        else None,
        "reason": a.reason,
        "risk": a.risk,
        "status": a.status,
        "on_behalf_of": a.on_behalf_of,
        "requested_at": a.requested_at,
        "expires_at": a.expires_at,
        "decided_by": a.decided_by,
        "decided_at": a.decided_at,
        "decision_note": a.decision_note,
    }


async def _names(session: AsyncSession, ids: list[str]) -> dict[str, str]:
    ids = [i for i in dict.fromkeys(ids) if i]
    if not ids:
        return {}
    rows = (await session.exec(select(Member).where(col(Member.id).in_(ids)))).all()
    return {m.id: m.name for m in rows}


def _shown(field: str, value, names: dict[str, str]):
    if field == "assignee":
        return names.get(value, value) if value else None
    return value


def _field_now(ticket: Ticket | None, field: str):
    value = getattr(ticket, field, None) if ticket is not None else None
    return loads(value, []) if field == "tags" else value


async def _stale_of(
    session: AsyncSession, a: AiApproval, ticket: Ticket | None, names: dict
) -> dict | None:
    """The fields that changed since the request was made, with who changed them (B6)."""
    before = loads(a.before, {})
    if a.status != "pending" or ticket is None or not before:
        return None
    rows = []
    for field, asked in before.items():
        now = _field_now(ticket, field)
        if (now or None) == (asked or None):
            continue
        if field == "assignee":
            names = {**names, **await _names(session, [asked or "", now or ""])}
        by, at = None, None
        for e in reversed(loads(ticket.activity_log, [])):
            if e.get("field") == field:
                by, at = e.get("actor"), e.get("at")
                break
        rows.append(
            {
                "field": field,
                "label": FIELD_LABELS.get(field, field),
                "asked": _shown(field, asked, names),
                "now": _shown(field, now, names),
                "set_by": by,
                "set_at": at,
            }
        )
    return {"fields": rows} if rows else None


async def enrich(
    session: AsyncSession, rows: list[AiApproval], actor: str | None
) -> list[dict]:
    """Approvals with everything the card shows: before → after diff, the AI's reason, what triggered the run,
    whether the ticket changed since, and whether `actor` may decide."""
    if not rows:
        return []
    settings_by_project: dict[str, object] = {}
    ids = [a.member_id for a in rows]
    for a in rows:
        p = loads(a.payload, {}).get("params") or {}
        ids += [v for k, v in p.items() if k == "assignee" and isinstance(v, str)]
        ids += [v for v in loads(a.before, {}).values() if isinstance(v, str)]
    names = await _names(session, ids)
    out = []
    for a in rows:
        d = to_dict(a, names.get(a.member_id))
        payload = loads(a.payload, {})
        if payload.get("tool") == "docs_write":
            # older requests stored a raw tool name and page id as their summary
            params_ = payload.get("params") or {}
            page = (
                await session.get(DocsPage, params_["page_id"])
                if params_.get("page_id")
                else None
            )
            d["summary"] = guard.docs_summary(
                payload.get("action") or "",
                params_,
                page.title if page is not None else None,
            )
        params = payload.get("params") or {}
        before = loads(a.before, {})
        ticket = await session.get(Ticket, a.ticket_id) if a.ticket_id else None
        diff = []
        for field, new in params.items():
            if field in ("ticket_id", "clear_fields", "_reason") or (
                field not in FIELD_LABELS and field != "markdown"
            ):
                continue
            if field == "markdown":
                diff.append(
                    {
                        "field": field,
                        "label": "Page text",
                        "from": None,
                        "to": f"{len(str(new).splitlines())} lines",
                    }
                )
                continue
            diff.append(
                {
                    "field": field,
                    "label": FIELD_LABELS[field],
                    "from": _shown(field, before.get(field), names),
                    "to": _shown(field, new, names),
                }
            )
        d["diff"] = diff
        d["target_title"] = ticket.title if ticket else None
        run = await session.get(AiRun, a.run_id) if a.run_id else None
        d["run"] = (
            {
                "id": run.id,
                "number": run.number,
                "state": run.state,
                "trigger": run.trigger,
                "started_by": run.started_by,
            }
            if run
            else None
        )
        if run:
            label = TRIGGERS.get(run.trigger, "Run #{n} on {ticket}").format(
                ticket=run.ticket_id, n=run.number
            )
            chain = loads(run.chain, [])
            d["trigger"] = {
                "label": label,
                "trust": "data_only" if chain else "trusted",
                "by": run.started_by,
            }
        else:
            d["trigger"] = {
                "label": "A request at the budget cap" if a.action == RAISE_CAP else "",
                "trust": "trusted",
                "by": a.on_behalf_of,
            }
        d["stale"] = await _stale_of(session, a, ticket, names)
        settings = settings_by_project.get(a.project_id)
        if settings is None:
            settings = settings_by_project[a.project_id] = await get_settings(
                session, a.project_id
            )
        ok, why = await safety.can_decide(
            session,
            settings,
            project_id=a.project_id,
            risk=a.risk,
            on_behalf_of=a.on_behalf_of,
            person=actor,
        )
        d["can_decide"] = ok
        d["cannot_reason"] = why
        d["always_allowed"] = always_allowed(a)
        d["remember_allowed"] = (
            a.risk != "high" and bool(a.ticket_id) and a.action != RAISE_CAP
        )
        out.append(d)
    return out


async def expire(session: AsyncSession) -> int:
    """Expired requests are skipped (the run goes on, the AI was already told the action waits), or, when the
    project says so, the run stops."""
    now = datetime.now(UTC)
    rows = (
        await session.exec(select(AiApproval).where(AiApproval.status == "pending"))
    ).all()
    n = 0
    stop: list[AiApproval] = []
    for a in rows:
        if is_proposal(a):
            continue  # a proposal expires with its own time (services/docs_ai/proposals.expire_due)
        exp = parse_iso(a.expires_at)
        if exp and exp < now:
            a.status = "expired"
            a.decision_note = "No decision before it expired"
            session.add(a)
            n += 1
            stop.append(a)
    if n:
        await session.commit()
        from . import runs

        for a in stop:
            settings = await get_settings(session, a.project_id)
            if settings.approval_on_expiry == "stop" and a.run_id:
                try:
                    await runs.cancel(
                        a.run_id,
                        by="board",
                        reason="Stopped: an approval expired and the project stops the run then",
                    )
                except runs.RunError:
                    pass
    return n


async def mark_run_ended(run_id: str) -> int:
    """The run of pending approvals was lost (its runner went away): they can no longer be applied (I5)."""
    async with database.async_session() as session:
        rows = (
            await session.exec(
                select(AiApproval).where(
                    AiApproval.run_id == run_id, AiApproval.status == "pending"
                )
            )
        ).all()
        # a proposal outlives its run: a person can still accept it into a draft
        rows = [a for a in rows if not is_proposal(a)]
        for a in rows:
            a.status = "run_ended"
            a.decision_note = "The run ended before anyone decided"
            session.add(a)
        if rows:
            await session.commit()
        return len(rows)


async def list_approvals(
    session: AsyncSession,
    project_id: str,
    *,
    status: str | None = None,
    ticket_id: str | None = None,
    member_id: str | None = None,
    risk: str | None = None,
    actor: str | None = None,
) -> list[dict]:
    """Approvals of a project, pending first (soonest to expire) then decided, newest first."""
    await expire(session)
    stmt = select(AiApproval).where(AiApproval.project_id == project_id)
    if status:
        stmt = stmt.where(AiApproval.status == status)
    if ticket_id:
        stmt = stmt.where(AiApproval.ticket_id == ticket_id)
    if member_id:
        stmt = stmt.where(AiApproval.member_id == member_id)
    if risk:
        stmt = stmt.where(AiApproval.risk == risk)
    rows = list(
        (
            await session.exec(
                stmt.order_by(col(AiApproval.requested_at).desc()).limit(200)
            )
        ).all()
    )
    pending = sorted(
        [a for a in rows if a.status == "pending"], key=lambda a: a.expires_at or ""
    )
    decided = [a for a in rows if a.status != "pending"]
    return await enrich(session, pending + decided, actor)


async def backlog(session: AsyncSession, project_id: str) -> dict:
    """Pending approvals per agent against the limits of 10 per agent and 25 per project (I3)."""
    rows = (
        await session.exec(
            select(AiApproval).where(
                AiApproval.project_id == project_id, AiApproval.status == "pending"
            )
        )
    ).all()
    names = await _names(session, [a.member_id for a in rows])
    per: dict[str, dict] = {}
    for a in sorted(rows, key=lambda a: a.requested_at):
        e = per.setdefault(
            a.member_id,
            {
                "member_id": a.member_id,
                "name": names.get(a.member_id, "AI member"),
                "count": 0,
                "low": [],
                "oldest": a.id,
            },
        )
        e["count"] += 1
        if a.risk == "low":
            e["low"].append(a.id)
    return {
        "pending": len(rows),
        "agent_limit": guard.MAX_PENDING_PER_AGENT,
        "project_limit": guard.MAX_PENDING_PER_PROJECT,
        "agents": sorted(per.values(), key=lambda e: -e["count"]),
    }


async def _apply(approval: AiApproval, member_name: str, by: str = "user"):
    """Run the stored tool call as the AI member, on behalf of the person, with the mode check skipped."""
    from kanban_mcp.tools.branches import BRANCH_OPS
    from kanban_mcp.tools.docs import DOCS_WRITE_OPS
    from kanban_mcp.tools.items import ITEM_OPS
    from kanban_mcp.tools.routing import route
    from kanban_mcp.tools.tickets import TICKET_OPS

    if approval.action == RAISE_CAP:
        return await _apply_raise_cap(approval, by)
    payload = loads(approval.payload, {})
    tool, action, params = (
        payload.get("tool"),
        payload.get("action"),
        dict(payload.get("params") or {}),
    )
    if tool == "ticket_items":
        item, op_name = action.split(".", 1)
        op = ITEM_OPS[(item, op_name)]
    else:
        table = {
            "manage_ticket": TICKET_OPS,
            "docs_write": DOCS_WRITE_OPS,
            "ticket_branches": BRANCH_OPS,
        }.get(tool)
        if table is None or action not in table:
            raise ApprovalError(f"This request ({tool}.{action}) cannot be applied.")
        op = table[action]
    async with database.async_session() as session:
        run = await session.get(AiRun, approval.run_id) if approval.run_id else None
    ctx = RunContext(
        run_id=approval.run_id or "",
        member_id=approval.member_id,
        member_name=member_name,
        project_id=approval.project_id,
        ticket_id=(run.ticket_id if run else approval.ticket_id) or "",
        on_behalf_of=approval.on_behalf_of or "user",
        mode="work",
    )
    tokens = guard.enter(ctx)
    scope = guard.approved_scope(approval.id)
    try:
        return await guard.guarded(
            tool, action, params, lambda g: route(f"{tool}(action='{action}')", op, g)
        )
    finally:
        guard.reset_approved(scope)
        guard.leave(tokens)


async def _apply_raise_cap(approval: AiApproval, by: str) -> None:
    """Approving "Raise cap" adds a few dollars to today's cap, for the agent or the board, until midnight."""
    params = loads(approval.payload, {}).get("params") or {}
    async with database.async_session() as session:
        await safety.add_grant(
            session,
            project_id=approval.project_id,
            kind="cap_raise",
            member_id=None if params.get("scope") == "board" else approval.member_id,
            amount=float(params.get("amount") or RAISE_CAP_USD),
            day=safety.local_day(),
            created_by=by,
            source_approval_id=approval.id,
        )
    from . import runs

    runs.RT.wake.set()


async def decide(
    approval_id: str,
    *,
    by: str,
    approve: bool,
    note: str | None = None,
    stop_run: bool = False,
    remember: bool = False,
    always: bool = False,
    accept_updated: bool = False,
    enforce_roles: bool = True,
    delegate: bool = False,
    via: str | None = None,
) -> dict:
    """Approve once (the board applies the action now) or deny with a reason (sent to the run's ticket).

    `delegate` is for Autopilot only: the project's delegate AI decides on the owner's behalf (services/ai/autopilot.py
    checks everything first), which is the one case an AI member decides a request. `via` names that path.

    Raises:
        ApprovalError: Not found, already decided, run ended, or the person may not decide this risk.
        ApprovalStale: The ticket changed since the request and `accept_updated` is not set.
    """
    proposal = False
    async with database.async_session() as session:
        await expire(session)
        a = await session.get(AiApproval, approval_id)
        if a is None:
            raise ApprovalError("Approval not found.")
        if a.status == "run_ended":
            if approve:
                raise ApprovalError(
                    "The run ended before this was decided, so it can't be applied. Deny it, or ask the AI again."
                )
        elif a.status != "pending":
            raise ApprovalError(f"This request is already {a.status}.")
        if not delegate:
            await _forbid_ai(session, a.project_id, by)
        settings = await get_settings(session, a.project_id)
        if enforce_roles and not delegate:
            ok, why = await safety.can_decide(
                session,
                settings,
                project_id=a.project_id,
                risk=a.risk,
                on_behalf_of=a.on_behalf_of,
                person=by,
            )
            if not ok:
                raise ApprovalForbidden(why)
        if is_proposal(a):
            proposal = True
        elif approve and not accept_updated:
            ticket = await session.get(Ticket, a.ticket_id) if a.ticket_id else None
            stale = await _stale_of(session, a, ticket, {})
            if stale:
                raise ApprovalStale(stale)
        member = await session.get(Member, a.member_id)
        name = member.name if member else "AI member"
        if proposal:
            return await _decide_proposal(a, name, by=by, approve=approve, note=note)
        a.decided_by = by
        a.decided_via = via or svc_activity.current_origin()
        a.decided_at = now_iso()
        a.decision_note = (note or "").strip()[:500] or None
        a.status = "approved" if approve else "denied"
        session.add(a)
        await session.commit()
        await session.refresh(a)
        if approve and always and always_allowed(a):
            # "Always allow": every later edit of this kind by this AI goes through, on any ticket or page
            await safety.add_grant(
                session,
                project_id=a.project_id,
                kind="approval",
                member_id=a.member_id,
                action=a.action,
                created_by=by,
                source_approval_id=a.id,
            )
        elif approve and remember and a.risk != "high" and a.ticket_id:
            await safety.add_grant(
                session,
                project_id=a.project_id,
                kind="approval",
                member_id=a.member_id,
                ticket_id=a.ticket_id,
                action=a.action,
                created_by=by,
                source_approval_id=a.id,
            )
    error = None
    if approve:
        try:
            await _apply(a, name, by)
        except (ValueError, ApprovalError) as exc:
            error = str(exc)
            async with database.async_session() as session:
                a = await session.get(AiApproval, approval_id)
                a.status = "failed"
                a.decision_note = f"Approved but could not be applied: {error}"[:500]
                session.add(a)
                await session.commit()
        if a.action == RAISE_CAP and not error:
            await audit.record(
                a.project_id,
                RAISE_CAP,
                "approved",
                member_id=a.member_id,
                member_name=name,
                on_behalf_of=by,
                run_id=a.run_id,
                target=a.ticket_id,
                detail={"approval_id": a.id, "amount": RAISE_CAP_USD, "day": "today"},
            )
    else:
        await audit.record(
            a.project_id,
            a.action,
            "denied",
            member_id=a.member_id,
            member_name=name,
            on_behalf_of=a.on_behalf_of,
            run_id=a.run_id,
            target=a.ticket_id,
            detail={"approval_id": a.id, "denied_by": by, "reason": a.decision_note},
        )
        if a.ticket_id and a.action != RAISE_CAP:
            async with database.async_session() as session:
                await svc_tickets.add_comment(
                    session,
                    a.ticket_id,
                    f"Denied {name}'s request “{a.summary}”"
                    + (f": {a.decision_note}" if a.decision_note else "."),
                    author=by,
                    meta={"approval_id": a.id},
                )
        if stop_run and a.run_id:
            from . import runs

            try:
                await runs.cancel(
                    a.run_id, by=by, reason=f"Stopped by {by} when denying an approval"
                )
            except runs.RunError:
                pass
    await board_events.publish(board_events.INVALIDATE)
    async with database.async_session() as session:
        a = await session.get(AiApproval, approval_id)
        return {**to_dict(a, name), "error": error}


async def _forbid_ai(session: AsyncSession, project_id: str, by: str) -> None:
    """An AI member never decides an approval (its own proposal included)."""
    from services.docs_ai import DocsAiError
    from services.docs_ai.proposals import forbid_ai

    try:
        await forbid_ai(session, project_id, by)
    except DocsAiError as exc:
        raise ApprovalForbidden(str(exc)) from exc


async def _decide_proposal(
    a: AiApproval, name: str, *, by: str, approve: bool, note: str | None
) -> dict:
    """Approve = accept every change that still applies into `by`'s draft of the page; deny = reject the proposal."""
    from services.docs_ai import DocsAiError
    from services.docs_ai.proposals import decide_from_approval

    error = None
    try:
        await decide_from_approval(a.id, by=by, approve=approve, note=note)
    except DocsAiError as exc:
        if exc.code in ("forbidden", "viewer"):
            raise ApprovalForbidden(str(exc)) from exc
        if exc.code == "conflict":
            raise ApprovalError(str(exc)) from exc
        error = str(exc)
    await board_events.publish(board_events.INVALIDATE)
    async with database.async_session() as session:
        row = await session.get(AiApproval, a.id)
        return {**to_dict(row, name), "error": error}


async def bulk_decide(
    ids: list[str], *, by: str, approve: bool, note: str | None = None
) -> list[dict]:
    """Decide several at once. Only Low and Medium risk; High risk is decided one by one (B1)."""
    out = []
    for approval_id in ids:
        async with database.async_session() as session:
            a = await session.get(AiApproval, approval_id)
        if a is None:
            out.append({"id": approval_id, "result": "skipped", "reason": "Not found."})
            continue
        if a.risk == "high":
            out.append(
                {
                    "id": approval_id,
                    "result": "skipped",
                    "reason": "High risk is decided one by one.",
                }
            )
            continue
        try:
            r = await decide(
                approval_id,
                by=by,
                approve=approve,
                note=note,
                accept_updated=False,
            )
            out.append(
                {
                    "id": approval_id,
                    "result": r["status"],
                    "reason": r.get("error"),
                }
            )
        except ApprovalStale:
            out.append(
                {
                    "id": approval_id,
                    "result": "skipped",
                    "reason": "The ticket changed since the request; open it to approve the updated change.",
                }
            )
        except ApprovalError as exc:
            out.append({"id": approval_id, "result": "skipped", "reason": str(exc)})
    return out


async def request_cap_raise(
    session: AsyncSession, profile: AiMember, hit: dict
) -> bool:
    """At the cap with "Ask an owner first": open one approval to raise today's cap, unless one is pending.
    Returns True when a new one was created."""
    if hit["kind"] != "daily":
        return False
    scope = hit["scope"]
    rows = (
        await session.exec(
            select(AiApproval).where(
                AiApproval.project_id == profile.project_id,
                AiApproval.action == RAISE_CAP,
                AiApproval.status == "pending",
            )
        )
    ).all()
    for r in rows:
        p = loads(r.payload, {}).get("params") or {}
        if p.get("scope") == scope and (scope == "board" or r.member_id == profile.id):
            return False
    settings = await get_settings(session, profile.project_id)
    member = await session.get(Member, profile.id)
    name = member.name if member else "AI member"
    what = "the board's" if scope == "board" else f"{name}'s"
    approval = AiApproval(
        project_id=profile.project_id,
        member_id=profile.id,
        action=RAISE_CAP,
        summary=f"Raise {what} cap for today by ${RAISE_CAP_USD:.2f}",
        payload=json.dumps(
            {
                "tool": "budget",
                "action": RAISE_CAP,
                "params": {"amount": RAISE_CAP_USD, "scope": scope, "day": "today"},
            }
        ),
        reason=hit["reason"],
        risk="medium",
        on_behalf_of=None,
        expires_at=(
            datetime.now(UTC) + timedelta(hours=settings.approval_expiry_hours or 24)
        ).isoformat(),
    )
    session.add(approval)
    await session.commit()
    await session.refresh(approval)
    await safety.notify(
        profile.project_id,
        "approval_requested",
        "Raise cap?",
        f"{name} is at its cap. Raise {what} cap for today by ${RAISE_CAP_USD:.2f}?",
        ref_kind="approval",
        ref_id=approval.id,
        member_id=profile.id,
    )
    return True


async def always_grants(session: AsyncSession, project_id: str) -> list[dict]:
    """ "Always allow" decisions of a project (not tied to a ticket), listed so they can be revoked."""
    rows = (
        await session.exec(
            select(AiGrant).where(
                AiGrant.project_id == project_id,
                AiGrant.kind == "approval",
                col(AiGrant.ticket_id).is_(None),
                col(AiGrant.revoked_at).is_(None),
            )
        )
    ).all()
    names = await _names(session, [g.member_id or "" for g in rows])
    return [
        {
            "id": g.id,
            "member_id": g.member_id,
            "member_name": names.get(g.member_id or ""),
            "action": g.action,
            "created_by": g.created_by,
            "created_at": g.created_at,
        }
        for g in rows
    ]


async def grants_for_ticket(session: AsyncSession, ticket_id: str) -> list[dict]:
    """Remembered approvals on a ticket (listed there, revocable)."""
    rows = (
        await session.exec(
            select(AiGrant).where(
                AiGrant.kind == "approval",
                AiGrant.ticket_id == ticket_id,
                col(AiGrant.revoked_at).is_(None),
            )
        )
    ).all()
    names = await _names(session, [g.member_id or "" for g in rows])
    return [
        {
            "id": g.id,
            "member_id": g.member_id,
            "member_name": names.get(g.member_id or ""),
            "action": g.action,
            "created_by": g.created_by,
            "created_at": g.created_at,
        }
        for g in rows
    ]


# ---------------------------------------------------------------------------
# Revert
# ---------------------------------------------------------------------------


def _same(a, b) -> bool:
    return (a or None) == (b or None) or a == b


async def _revert_entry(session: AsyncSession, entry: AiAudit, by: str) -> dict:
    detail = loads(entry.detail, {})
    before, after = detail.get("before"), detail.get("after")
    if not isinstance(before, dict) or not isinstance(after, dict) or not entry.target:
        return {
            "entry_id": entry.id,
            "result": "skipped",
            "reason": "This change cannot be reverted.",
        }
    if entry.reverted_at:
        return {
            "entry_id": entry.id,
            "result": "skipped",
            "reason": "Already reverted.",
        }
    ticket = await session.get(Ticket, entry.target)
    if ticket is None:
        return {
            "entry_id": entry.id,
            "result": "skipped",
            "reason": f"{entry.target} no longer exists.",
        }
    data: dict = {}
    skipped: list[str] = []
    for field, old in before.items():
        cur = getattr(ticket, field, None)
        if field == "tags":
            cur = loads(cur, [])
        if _same(cur, after.get(field)):
            data[field] = old
        else:
            skipped.append(field)
    if not data:
        return {
            "entry_id": entry.id,
            "result": "skipped",
            "reason": f"{', '.join(skipped)} changed again after the AI; left as it is now.",
            "fields": skipped,
        }
    await svc_tickets.update_ticket(session, ticket.id, TicketUpdate(**data))
    entry.reverted_at = now_iso()
    entry.reverted_by = by
    session.add(entry)
    await session.commit()
    await audit.record(
        entry.project_id,
        entry.action,
        "reverted",
        member_id=entry.member_id,
        member_name=entry.member_name,
        on_behalf_of=by,
        run_id=entry.run_id,
        target=entry.target,
        detail={"reverted_entry": entry.id, "fields": list(data), "skipped": skipped},
    )
    return {
        "entry_id": entry.id,
        "result": "reverted",
        "fields": list(data),
        "skipped": skipped,
    }


async def revert_entries(
    session: AsyncSession, entry_ids: list[str], *, by: str
) -> list[dict]:
    """Revert AI changes, newest first; anything a person changed since is skipped, never forced."""
    rows = (
        await session.exec(select(AiAudit).where(col(AiAudit.id).in_(entry_ids)))
    ).all()
    rows = sorted(rows, key=lambda e: e.seq, reverse=True)
    results = [await _revert_entry(session, e, by) for e in rows]
    await board_events.publish(board_events.INVALIDATE)
    return results


async def revert_preview(session: AsyncSession, run_id: str) -> list[dict]:
    """What “Undo run's changes” would do: one row per change, with conflicts marked."""
    rows = (
        await session.exec(
            select(AiAudit)
            .where(
                AiAudit.run_id == run_id,
                col(AiAudit.result).in_(["allowed", "approved"]),
            )
            .order_by(col(AiAudit.seq).desc())
        )
    ).all()
    out = []
    for e in rows:
        d = loads(e.detail, {})
        before, after = d.get("before"), d.get("after")
        if not isinstance(before, dict) or not isinstance(after, dict) or e.reverted_at:
            continue
        ticket = await session.get(Ticket, e.target) if e.target else None
        for field, old in before.items():
            cur = getattr(ticket, field, None) if ticket else None
            if field == "tags":
                cur = loads(cur, [])
            out.append(
                {
                    "entry_id": e.id,
                    "ticket_id": e.target,
                    "field": field,
                    "from": after.get(field),
                    "to": old,
                    "current": cur,
                    "conflict": not _same(cur, after.get(field)),
                }
            )
    return out


async def revert_run(session: AsyncSession, run_id: str, *, by: str) -> list[dict]:
    """Undo a run's changes (fields and status); comments, run logs and files stay as history."""
    rows = (
        await session.exec(
            select(AiAudit).where(
                AiAudit.run_id == run_id,
                col(AiAudit.result).in_(["allowed", "approved"]),
            )
        )
    ).all()
    ids = [e.id for e in rows if isinstance(loads(e.detail, {}).get("before"), dict)]
    return await revert_entries(session, ids, by=by)


def dumps(value) -> str:
    """json.dumps."""
    return json.dumps(value)
