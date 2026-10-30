"""The one permission check every AI action goes through (MCP tools of a run and the API agent loop alike).

A run's tool calls carry its bearer token (`Authorization: Bearer kbr_…`). The guard resolves the token to the run,
decides the effective mode of the action (permissions.py), enforces the status ceiling and the scope, posts an
approval when one is needed, and writes the audit entry. The model never sees or controls any of this.
"""

import asyncio
import hashlib
import json
from contextvars import ContextVar, Token
from datetime import UTC, datetime, timedelta

from sqlmodel import select

import database
import services.activity as svc_activity
from models import AiApproval, AiRun, Ticket

from . import audit, safety
from .context import STATUS_LABELS, RunContext
from .permissions import ACTIONS, APPROVAL, BLOCKED, check_status_move, effective
from .store import get_profile, get_settings, loads, now_iso

_ctx: ContextVar[RunContext | None] = ContextVar("ai_run_context", default=None)
# Set while the board applies an action a person approved: the mode check is skipped (the ceiling is not).
_approved: ContextVar[str | None] = ContextVar("ai_approved", default=None)

MAX_PENDING_PER_AGENT = 10
# A tool call that needs approval waits this long for the decision, then the request stays parked (S, run states)
APPROVAL_WAIT_S = 600
APPROVAL_POLL_S = 1.0
MAX_PENDING_PER_PROJECT = 25
_FIELD_ACTIONS = {"status": "change_status", "assignee": "change_assignee"}
_REVERTABLE = (
    "title",
    "description",
    "type",
    "priority",
    "status",
    "estimate",
    "due_date",
    "start_date",
    "tags",
    "assignee",
)


class AiActionError(ValueError):
    """An AI action was refused; the message is what the agent reads (and it says why)."""


def token_hash(token: str) -> str:
    """How a run token is stored."""
    return hashlib.sha256(token.encode()).hexdigest()


def current() -> RunContext | None:
    """The run the current task acts for."""
    return _ctx.get()


def enter(ctx: RunContext) -> tuple[Token, Token, Token]:
    """Act as `ctx` until `leave()`: AI attribution on activity entries and the AI's name as actor."""
    info = {**ctx.activity(), "member_name": ctx.member_name}
    return (
        _ctx.set(ctx),
        svc_activity.set_ai(info),
        svc_activity.set_actor(ctx.member_name),
    )


def leave(tokens: tuple[Token, Token, Token]) -> None:
    """Undo `enter`."""
    _ctx.reset(tokens[0])
    svc_activity.reset_ai(tokens[1])
    svc_activity.reset_actor(tokens[2])


def _request_token() -> str | None:
    try:
        from mcp.server.lowlevel.server import request_ctx

        rc = request_ctx.get()
    except (LookupError, ImportError):
        return None
    request = getattr(rc, "request", None)
    headers = getattr(request, "headers", None)
    if not headers:
        return None
    auth = headers.get("authorization") or ""
    if auth.lower().startswith("bearer kbr_"):
        return auth.split(None, 1)[1].strip()
    return None


async def context_for_token(token: str) -> RunContext:
    """The live run a token belongs to.

    Raises:
        AiActionError: When the run ended (cancelled, finished, paused by the kill switch): its token is dead.
    """
    async with database.async_session() as session:
        run = (
            await session.exec(
                select(AiRun).where(AiRun.token_hash == token_hash(token))
            )
        ).first()
        if run is None or run.state not in ("starting", "running"):
            raise AiActionError(
                "This AI run has ended (finished, cancelled or stopped by a person); the board no longer accepts its calls. Stop now."
            )
        member, profile = await get_profile(session, run.member_id)
        if profile is not None and profile.token_revoked_at:
            raise AiActionError(
                f"This AI member's token was revoked by {profile.token_revoked_by or 'a person'}; the board no "
                "longer accepts its calls. Stop now."
            )
        if profile is not None:
            profile.mcp_last_used_at = now_iso()
            session.add(profile)
            await session.commit()
        return RunContext(
            run_id=run.id,
            member_id=run.member_id,
            member_name=member.name if member else "AI member",
            project_id=run.project_id,
            ticket_id=run.ticket_id,
            on_behalf_of=run.started_by,
            mode=run.mode,
            chain=loads(run.chain, []),
        )


async def resolve() -> RunContext | None:
    """The run of the current MCP request (from its bearer token), or the one already entered."""
    ctx = current()
    if ctx is not None:
        return ctx
    token = _request_token()
    if token is None:
        return None
    return await context_for_token(token)


def classify(tool: str, action: str, params: dict) -> list[str]:
    """Permission actions a tool call needs (empty: a read)."""
    if tool == "manage_project":
        return ["manage_project"]
    if tool == "docs_write":
        return ["edit_docs"]
    if tool == "ticket_branches":
        return ["create_branches"]
    if tool == "ticket_items":
        item = action.split(".", 1)[0]
        return {
            "comment": ["comment"],
            "test_case": ["manage_test_cases"],
        }.get(item, ["edit_fields"])
    if tool == "manage_ticket":
        if action == "create":
            needs = ["create_tickets"]
            if params.get("assignee"):
                needs.append("change_assignee")
            return needs
        if action == "delete":
            return ["delete_tickets"]
        if action == "workspace":
            return []
        if action in ("reopen",):
            return ["change_status"]
        if action == "update":
            needs = []
            for field in params:
                if field in ("ticket_id",):
                    continue
                if field == "clear_fields":
                    for f in params[field] or []:
                        needs.append(_FIELD_ACTIONS.get(f, "edit_fields"))
                    continue
                needs.append(_FIELD_ACTIONS.get(field, "edit_fields"))
            return list(dict.fromkeys(needs)) or ["edit_fields"]
        return ["edit_fields"]
    return []


def _target(tool: str, params: dict) -> str | None:
    return (
        params.get("ticket_id")
        or params.get("parent_id")
        or params.get("page_id")
        or params.get("project_id")
    )


async def _named(session, params: dict) -> dict:
    """Params with member ids shown as names (for the approval's one-line summary)."""
    from models import Member

    out = dict(params)
    if out.get("assignee"):
        member = await session.get(Member, out["assignee"])
        if member is not None:
            out["assignee"] = member.name
    return out


def _describe(tool: str, action: str, params: dict) -> str:
    target = _target(tool, params) or ""
    if tool == "manage_ticket" and action == "update":
        parts = [f"{k} → {v}" for k, v in params.items() if k != "ticket_id"]
        return f"Update {target}: " + ", ".join(parts)[:200]
    if tool == "manage_ticket" and action == "create":
        return f"Create ticket “{params.get('title', '')}”"
    if tool == "manage_ticket" and action == "delete":
        return f"Delete {target}"
    return f"{tool}.{action} {target}".strip()


async def _in_scope(session, ctx: RunContext, profile, ticket_id: str | None) -> bool:
    if not ticket_id or profile.scope == "project" or ticket_id == ctx.ticket_id:
        return True
    ticket = await session.get(Ticket, ticket_id)
    if ticket is None:
        return True  # the call fails on its own with a clear "not found"
    if ticket.project_id != ctx.project_id:
        return False
    if ticket.assignee == ctx.member_id or ticket.parent_id == ctx.ticket_id:
        return True
    # tickets this run created
    for e in loads(ticket.activity_log, [])[:1]:
        if e.get("run_id") == ctx.run_id:
            return True
    return False


async def _settings_for(session, ctx: RunContext):
    """Project AI settings as they apply to this run. A run that was already going when Pause all AI chose
    "let them finish" may finish: the pause layer does not block it."""
    from models import AiRun

    settings = await get_settings(session, ctx.project_id)
    if settings.paused_all and settings.paused_at:
        run = await session.get(AiRun, ctx.run_id)
        if run is not None and run.started_at and run.started_at < settings.paused_at:
            return settings.model_copy(update={"paused_all": False})
    return settings


async def check(ctx: RunContext, tool: str, action: str, params: dict) -> dict:
    """Decide whether the call may run. Returns the audit detail to complete after the call.

    Raises:
        AiActionError: Blocked, denied, or parked for a person's approval (the message says which and why).
    """
    needs = classify(tool, action, params)
    detail: dict = {"tool": tool, "op": action, "request": params}
    if not needs:
        if tool == "ai_run" or (tool == "manage_ticket" and action == "workspace"):
            return detail
        # A read: the "Read tickets" row can be tightened too; a read cannot wait for approval
        async with database.async_session() as session:
            _, profile = await get_profile(session, ctx.member_id)
            settings = await _settings_for(session, ctx)
        if profile is not None:
            mode = effective(profile, "read", settings).mode
            if mode != "allowed":
                raise await _refuse(
                    ctx,
                    "read",
                    _target(tool, params),
                    detail,
                    "Reading tickets is "
                    + ("blocked" if mode == "blocked" else "set to Needs approval")
                    + " for this AI member, so nothing was read.",
                )
        return detail
    approved_id = _approved.get()
    parked: tuple[str, str, str]
    async with database.async_session() as session:
        _, profile = await get_profile(session, ctx.member_id)
        settings = await _settings_for(session, ctx)
        target = _target(tool, params)
        perm = needs[0]
        if profile is None:
            raise await _refuse(
                ctx, perm, target, detail, "This AI member was removed."
            )
        if ctx.mode == "ask" and not approved_id:
            raise await _refuse(
                ctx,
                perm,
                target,
                detail,
                "Ask runs only read and answer; the board posts your reply. Nothing was changed.",
            )
        ticket = (
            await session.get(Ticket, params["ticket_id"])
            if params.get("ticket_id")
            else None
        )
        if tool != "docs_write" and not await _in_scope(
            session, ctx, profile, params.get("ticket_id")
        ):
            raise await _refuse(
                ctx,
                perm,
                target,
                detail,
                f"{params.get('ticket_id')} is outside this AI member's scope (only tickets assigned to it or this run's ticket).",
            )
        # Status ceiling: a hard rule, also for approved actions
        new_status = params.get("status") if tool == "manage_ticket" else None
        if new_status and ticket is not None and new_status != ticket.status:
            why = check_status_move(profile, ticket.status, new_status)
            if why:
                await _post_move_blocked(ctx, ticket, new_status, profile.ceiling)
                raise await _refuse(
                    ctx, "change_status", target, detail, why, code="status_ceiling"
                )
        if tool == "manage_ticket" and action == "create" and params.get("status"):
            why = check_status_move(profile, "backlog", params["status"])
            if why:
                raise await _refuse(
                    ctx, "change_status", target, detail, why, code="status_ceiling"
                )
        if ticket is not None and tool == "manage_ticket" and action == "update":
            detail["before"] = {
                k: _field_value(ticket, k)
                for k in list(params) + list(params.get("clear_fields") or [])
                if k in _REVERTABLE
            }
        if approved_id:
            detail["approval_id"] = approved_id
            return detail
        decisions = [effective(profile, p, settings) for p in needs]
        worst = max(
            decisions, key=lambda d: {"allowed": 0, "approval": 1, "blocked": 2}[d.mode]
        )
        if worst.mode == BLOCKED:
            raise await _refuse(ctx, worst.action, target, detail, worst.reason)
        if worst.mode == APPROVAL:
            asking = [d.action for d in decisions if d.mode == APPROVAL]
            grants = await safety.remembered(
                session, ctx.member_id, params.get("ticket_id") or ctx.ticket_id, asking
            )
            if grants:
                # A person said "approve & remember" for this action on this ticket until it is Done
                detail["approval_id"] = f"remembered:{grants[0].id}"
                detail["remembered"] = True
                return detail
            approval = await _request_approval(
                session, ctx, settings, worst.action, tool, action, params, target
            )
            await audit.record(
                ctx.project_id,
                worst.action,
                "needs_approval",
                member_id=ctx.member_id,
                member_name=ctx.member_name,
                on_behalf_of=ctx.on_behalf_of,
                run_id=ctx.run_id,
                target=target,
                detail={**detail, "approval_id": approval.id},
            )
            parked = (approval.id, worst.action, approval.summary)
        else:
            detail["permission"] = needs
            return detail
    # The tool call waits for the decision (S "Needs approval" run state), outside any DB session
    approval_id, perm_action, summary = parked
    status, note, who = await _wait_for_decision(ctx, approval_id, summary)
    label = ACTIONS[perm_action][0]
    if status == "approved":
        raise AiActionError(
            f"APPROVED_AND_APPLIED: {who} approved “{summary}” and the board applied it for you. "
            "Do not repeat it; continue with the rest of the work."
        )
    if status == "denied":
        raise AiActionError(
            f"DENIED: {who} denied “{summary}”{f' ({note})' if note else ''}. Do not retry it; continue without it "
            "or finish and say what is missing."
        )
    if status == "failed":
        raise AiActionError(
            f"APPROVED_BUT_FAILED: {note or 'the change could not be applied'}. Do not retry it."
        )
    if status == "cancelled":
        raise AiActionError("The run was stopped while it waited for approval.")
    raise AiActionError(
        f"NEEDS_APPROVAL: {label} needs a person's approval. Request {approval_id} was "
        f"posted on {target or 'the board'}; no decision came within {APPROVAL_WAIT_S // 60} min, so the board "
        f"applies it later if {ctx.on_behalf_of} approves. Do not retry it; continue with the rest of the work or finish."
    )


async def _wait_for_decision(
    ctx: RunContext, approval_id: str, summary: str
) -> tuple[str, str | None, str]:
    """Hold the tool call until a person decides, the run is stopped, or the wait runs out: (status, note, who)."""
    from . import runs

    runs.RT.waiting_approval[ctx.run_id] = {
        "approval_id": approval_id,
        "summary": summary,
        "since": now_iso(),
    }
    await runs._publish(force=True)
    deadline = asyncio.get_running_loop().time() + APPROVAL_WAIT_S
    try:
        while True:
            async with database.async_session() as session:
                a = await session.get(AiApproval, approval_id)
            if a is None:
                return "cancelled", None, ""
            if a.status != "pending":
                return a.status, a.decision_note, a.decided_by or "A person"
            if ctx.run_id in runs.RT.cancelled:
                return "cancelled", None, ""
            if asyncio.get_running_loop().time() >= deadline:
                return "pending", None, ""
            await asyncio.sleep(APPROVAL_POLL_S)
    finally:
        runs.RT.waiting_approval.pop(ctx.run_id, None)
        await runs._publish(force=True)


def _field_value(ticket: Ticket, field: str):
    value = getattr(ticket, field, None)
    if field == "tags":
        return loads(value, [])
    return value


async def _injection_source(ctx: RunContext) -> dict | None:
    """The flagged text this run read, when it read any: a blocked action then carries it as its source."""
    from models import AiAudit

    async with database.async_session() as session:
        row = (
            await session.exec(
                select(AiAudit)
                .where(
                    AiAudit.run_id == ctx.run_id, AiAudit.action == "injection_detected"
                )
                .order_by(AiAudit.seq.desc())
                .limit(1)
            )
        ).first()
    return loads(row.detail, None) if row else None


async def _refuse(
    ctx: RunContext, perm: str, target, detail: dict, reason: str, code: str = "blocked"
) -> AiActionError:
    source = await _injection_source(ctx)
    if source:
        detail = {**detail, "source": source}
    await audit.record(
        ctx.project_id,
        perm,
        "blocked",
        member_id=ctx.member_id,
        member_name=ctx.member_name,
        on_behalf_of=ctx.on_behalf_of,
        run_id=ctx.run_id,
        target=target,
        detail={**detail, "reason": reason, "code": code},
    )
    await safety.notify(
        ctx.project_id,
        "blocked",
        "AI action blocked",
        f"{ctx.member_name} could not {ACTIONS.get(perm, (perm,))[0].lower()} on {target or 'the board'}: {reason}",
        ref_kind="ticket" if target else None,
        ref_id=target,
        member_id=ctx.member_id,
        people=[ctx.on_behalf_of],
    )
    return AiActionError(f"BLOCKED ({code}): {reason}")


async def _post_move_blocked(
    ctx: RunContext, ticket: Ticket, target: str, ceiling: str
) -> None:
    """Tell the people on the ticket, once per run, that a move above the ceiling was stopped."""
    import services.tickets as svc_tickets

    from . import runs

    marker = f"move-blocked:{ctx.run_id}"
    if any(
        (c.get("ai") or {}).get("marker") == marker for c in loads(ticket.comments, [])
    ):
        return
    await runs.mark_blocked_move(ctx.run_id, target)  # the board toasts the assigner
    text = (
        f"I tried to move this ticket to {STATUS_LABELS.get(target, target)}, but my permission stops at "
        f"{STATUS_LABELS.get(ceiling, ceiling)}. The ticket stays in {STATUS_LABELS.get(ticket.status, ticket.status)}. Over to you."
    )
    async with database.async_session() as session:
        await svc_tickets.add_comment(
            session,
            ticket.id,
            text,
            author=ctx.member_name,
            meta={
                "ai": {
                    "kind": "move_blocked",
                    "run_id": ctx.run_id,
                    "member_id": ctx.member_id,
                    "marker": marker,
                }
            },
        )


async def _request_approval(
    session, ctx, settings, perm, tool, action, params, target
) -> AiApproval:
    project_pending = (
        await session.exec(
            select(AiApproval).where(
                AiApproval.project_id == ctx.project_id, AiApproval.status == "pending"
            )
        )
    ).all()
    pending = [a for a in project_pending if a.member_id == ctx.member_id]
    if (
        len(pending) >= MAX_PENDING_PER_AGENT
        or len(project_pending) >= MAX_PENDING_PER_PROJECT
    ):
        full = (
            f"{len(pending)} requests of this AI member"
            if len(pending) >= MAX_PENDING_PER_AGENT
            else f"{len(project_pending)} requests in this project"
        )
        raise await _refuse(
            ctx,
            perm,
            target,
            {"tool": tool, "op": action, "request": params},
            f"Approvals full: {full} already wait for a person. Nothing was changed.",
            code="approvals_full",
        )
    ticket_id = params.get("ticket_id") or ctx.ticket_id
    ticket = await session.get(Ticket, ticket_id) if ticket_id else None
    snapshot: dict = {}
    if ticket is not None and tool == "manage_ticket" and action == "update":
        snapshot = {
            k: _field_value(ticket, k)
            for k in list(params) + list(params.get("clear_fields") or [])
            if k in _REVERTABLE
        }
    expires = datetime.now(UTC) + timedelta(hours=settings.approval_expiry_hours or 24)
    approval = AiApproval(
        project_id=ctx.project_id,
        member_id=ctx.member_id,
        run_id=ctx.run_id,
        ticket_id=params.get("ticket_id") or ctx.ticket_id,
        action=perm,
        summary=_describe(tool, action, await _named(session, params)),
        payload=json.dumps({"tool": tool, "action": action, "params": params}),
        reason=params.pop("_reason", None),
        risk=ACTIONS[perm][2],
        on_behalf_of=ctx.on_behalf_of,
        before=json.dumps(snapshot),
        expires_at=expires.isoformat(),
    )
    session.add(approval)
    await session.commit()
    await session.refresh(approval)
    hours = settings.approval_expiry_hours or 24
    expires_text = "3 days" if hours >= 72 else f"{hours} h"
    await safety.notify(
        ctx.project_id,
        "approval_requested",
        "Approval needed",
        f"{ctx.member_name} wants to {ACTIONS[perm][0].lower()} on {target or 'the board'}. "
        f"Expires in {expires_text}.",
        ref_kind="approval",
        ref_id=approval.id,
        member_id=ctx.member_id,
        people=[ctx.on_behalf_of, *[d["to"] for d in safety.delegates_of(settings)]],
    )
    return approval


async def after(ctx: RunContext, detail: dict, result) -> None:
    """Audit a call that went through (with before/after for revertable field changes)."""
    needs = classify(
        detail.get("tool", ""), detail.get("op", ""), detail.get("request") or {}
    )
    if not needs:
        return
    if "before" in detail and isinstance(result, dict):
        detail["after"] = {k: result.get(k) for k in detail["before"]}
    await audit.record(
        ctx.project_id,
        needs[0],
        "approved" if detail.get("approval_id") else "allowed",
        member_id=ctx.member_id,
        member_name=ctx.member_name,
        on_behalf_of=ctx.on_behalf_of,
        run_id=ctx.run_id,
        target=_target(detail.get("tool", ""), detail.get("request") or {}),
        detail=detail,
    )


def approved_scope(approval_id: str) -> Token:
    """Apply an approved action: the mode check is skipped for the calls made inside."""
    return _approved.set(approval_id)


def reset_approved(token: Token) -> None:
    """Undo `approved_scope`."""
    _approved.reset(token)


async def guarded(tool: str, action: str, given: dict, call):
    """Run `call(given)` for an MCP tool, checked and audited when it comes from an AI run."""
    ctx = await resolve()
    if ctx is None:
        return await call(given)
    # Omitted optional arguments arrive as None and mean "unchanged": they never count as a change
    given = {k: v for k, v in given.items() if v is not None}
    tokens = enter(ctx) if current() is None else None
    try:
        if tool == "ticket_items" and action == "comment.add":
            given = {**given, "author": ctx.member_name}
        if tool == "docs_write" and _approved.get() is None:
            # Docs AI on: a page edit becomes a proposal (or a private draft); the published page is never touched
            from services.docs_ai import proposals as docs_proposals

            redirected = await docs_proposals.intercept(ctx, action, given)
            if redirected is not None:
                return redirected
        detail = await check(ctx, tool, action, given)
        result = await call(given)
        if (
            tool == "docs_read"
            and action == "get"
            and isinstance(result, dict)
            and result.get("id")
        ):
            # The AI member sees what happened to its proposals for this page (a rejection and its reason)
            from services.docs_ai import proposals as docs_proposals

            notes = await docs_proposals.notes_for_read(ctx, result["id"])
            if notes:
                result = {**result, "your_proposals": notes}
        await after(ctx, detail, result)
        if isinstance(result, dict) and ctx.mode == "work":
            # A person edited the ticket during the run: a CLI run hears it on its next board call (T, context refresh)
            from . import runs

            notice = await runs.take_context_notes(ctx.run_id)
            if notice:
                result = {**result, "board_notice": notice}
        if (
            tool == "ticket_items"
            and action == "comment.add"
            and isinstance(result, dict)
        ):
            await _after_ai_comment(ctx, result)
        return result
    finally:
        if tokens is not None:
            leave(tokens)


async def _after_ai_comment(ctx: RunContext, ticket: dict) -> None:
    """Tag the AI's comment with its run, and deliver its @mentions of other AI members (one chain hop each)."""
    comments = ticket.get("comments") or []
    if not comments:
        return
    last = comments[-1]
    from . import mentions, runs

    await runs.tag_comment(
        ctx.ticket_id if ticket.get("id") is None else ticket["id"],
        last.get("id"),
        {
            "kind": "comment",
            "run_id": ctx.run_id,
            "member_id": ctx.member_id,
        },
    )
    await mentions.from_ai_comment(ctx, ticket["id"], last)


def at_least_now() -> str:
    """Now, ISO."""
    return now_iso()
