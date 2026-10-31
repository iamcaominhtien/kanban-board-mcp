"""The AI team over MCP: look at the board's AI members, their runs, cost and approvals, wake one with `ask`, steer
a run, pause a member, add or tune a member. Everything goes through the same services as the REST API so the limits,
audit and permissions are the same; what only a person may do (keys, folders, Bypass permissions, a ceiling above
Review, deciding approvals) is not available here."""

import json
import re
from typing import Any

import config as app_config
import events as board_events
import services.activity as svc_activity
import services.tickets as svc_tickets
from models import AiMember, AiRun, Member, Project, Ticket, TicketUpdate
from services.ai import accounts as svc_accounts
from services.ai import approvals as svc_approvals
from services.ai import audit, budget, guard
from services.ai import resources as svc_resources
from services.ai import members as svc_members
from services.ai import runs as svc_runs
from services.ai import usage as svc_usage
from services.ai.assist import member_drafts as drafts
from services.ai.secrets import redact_obj
from services.ai.permissions import full_rights_member
from services.ai.store import active_runs, get_profile, get_settings, loads
from sqlmodel import col, select

from .. import common

RUN_STEPS = 15
PROVIDERS_OK = ("claude-code", "antigravity", "mcp-client")
CREATE_KEYS = {
    "name",
    "provider",
    "description",
    "persona",
    "template",
    "ceiling",
    "max_parallel",
    "max_runs_per_day",
    "model",
    "read_only_cli",
}
UPDATE_KEYS = (CREATE_KEYS - {"provider", "read_only_cli"}) | {
    "daily_budget",
    "monthly_cap",
    "tokens_per_day",
    "cap_per_run",
}
ONLY_A_PERSON = "{keys} cannot be set over MCP: a person does that in the Add AI member / member settings dialog."


def _by() -> str:
    return svc_activity.current_actor() or "user"


def _short(text: Any, n: int) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= n else text[: n - 1] + "…"


def _in_run_project(project_id: str) -> None:
    """Inside an AI run the read actions stay in the run's own project."""
    ctx = guard.current()
    if ctx is not None and project_id != ctx.project_id:
        raise ValueError("An AI run can only look at its own project's AI team.")


async def _project(session, project_id: str) -> None:
    if await session.get(Project, project_id) is None:
        raise ValueError(
            f"Project '{project_id}' not found. Use get_projects to see project ids."
        )
    _in_run_project(project_id)


async def _ai(session, member_id: str) -> tuple[Member, AiMember]:
    member, profile = await get_profile(session, member_id)
    if member is None or profile is None or member.kind != "ai":
        raise ValueError(
            f"AI member '{member_id}' not found. ai_team(action='members', project_id=...) lists them."
        )
    return member, profile


async def _run_row(session, run_id: str) -> AiRun:
    run = await session.get(AiRun, run_id)
    if run is None:
        raise ValueError(
            f"Run '{run_id}' not found. ai_team(action='runs', ...) lists run ids."
        )
    _in_run_project(run.project_id)
    return run


# ---------------------------------------------------------------------------
# Shapes
# ---------------------------------------------------------------------------


def _member_row(d: dict) -> dict:
    use = d["usage"]
    return {
        "id": d["id"],
        "name": d["name"],
        "provider": d["provider"],
        "model": d["model"],
        "connection": d["connection"],
        "status": d["status"]["code"],
        "status_detail": d["status"].get("detail"),
        "paused": d["paused"],
        "ceiling": d["ceiling"],
        "scope": d["scope"],
        "template": d["template"],
        "spend_today": use["cost_today"],
        "spend_month": use["cost_month"],
        "tokens_today": use["tokens_in_today"] + use["tokens_out_today"],
        "runs_today": use["runs_today"],
        "running": d["slots_in_use"],
        "queued": d["queued"],
        "is_board_ai": d["is_board_ai"],
    }


def _run_row_dict(d: dict) -> dict:
    steps = d.get("steps") or []
    last = steps[-1] if steps else None
    return {
        "id": d["id"],
        "ticket_id": d["ticket_id"],
        "number": d["number"],
        "member_id": d["member_id"],
        "member": d["member_name"],
        "mode": d["mode"],
        "trigger": d["trigger"],
        "state": d["state"],
        "started_by": d["started_by"],
        "queued_at": d["queued_at"],
        "ended_at": d["ended_at"],
        "summary": _short(d["summary"], 200) or None,
        "cost_usd": d["cost_usd"],
        "waiting": d.get("waiting_reason"),
        "question": _short((d.get("question") or {}).get("text"), 200) or None
        if d["state"] == "needs_input"
        else None,
        "last_step": _short(last.get("text"), 120) if last else None,
    }


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


async def members(project_id: str) -> list[dict]:
    """The project's AI members with status, limits in use and today's / this month's spend."""
    async with common.async_session() as session:
        await _project(session, project_id)
        rows = await svc_members.list_members(session, project_id)
    return [_member_row(d) for d in rows]


async def member(member_id: str) -> dict:
    """One AI member in full: status, limits, permissions summary, 14-day usage, running and assigned work."""
    async with common.async_session() as session:
        m, profile = await _ai(session, member_id)
        _in_run_project(m.project_id)
        d = await svc_members.describe(session, m, profile)
        days = (await svc_members.usage(session, member_id))["days"]
    return {
        **_member_row(d),
        "project_id": d["project_id"],
        "description": d["description"],
        "persona": d["persona"],
        "health": d["health"],
        "health_detail": d["health_detail"],
        "paused_reason": d["paused_reason"],
        "limits": {
            k: d[k]
            for k in (
                "max_parallel",
                "daily_budget",
                "monthly_cap",
                "max_runs_per_day",
                "tokens_per_day",
                "cap_per_run",
                "warn_at",
            )
        },
        "permissions": {
            "template": d["template"],
            "needs_approval": [a["label"] for a in d["approvals"]],
            "overrides": d["permissions"],
            "pending_change": d["pending_change"],
        },
        "usage": d["usage"],
        "usage_14_days": days,
        "running": d["running"],
        "assigned": d["assigned"][:20],
        "last_run": d["last_run"],
    }


async def usage(project_id: str, span: str = "month") -> dict:
    """Spend and tokens of the project's AI: totals, by member, most expensive tickets and the limits in use."""
    async with common.async_session() as session:
        await _project(session, project_id)
        data = await svc_usage.dashboard(session, project_id, span)
        limits = await svc_usage.limits(session, project_id)
    return {
        "range": data["range"],
        "totals": data["tiles"],
        "by_member": [
            {
                k: a.get(k)
                for k in (
                    "member_id",
                    "name",
                    "runs",
                    "tokens",
                    "cost_usd",
                    "monthly_cap",
                    "pct_of_cap",
                )
            }
            for a in data["agents"]
        ],
        "top_tickets": data["tickets"],
        "limits": limits,
    }


async def runs(
    project_id: str | None = None,
    ticket_id: str | None = None,
    member_id: str | None = None,
    active_only: bool = False,
    limit: int = 20,
) -> list[dict]:
    """Recent runs (newest first) of a project, a ticket or one member, as compact rows."""
    if not (project_id or ticket_id or member_id):
        raise ValueError("runs needs project_id, ticket_id or member_id.")
    async with common.async_session() as session:
        if ticket_id:
            ticket = await session.get(Ticket, ticket_id)
            if ticket is None:
                raise ValueError(f"Ticket '{ticket_id}' not found.")
            _in_run_project(ticket.project_id)
        if project_id:
            await _project(session, project_id)
        if member_id:
            m, _ = await _ai(session, member_id)
            _in_run_project(m.project_id)
        rows = await svc_runs.list_runs(
            session,
            project_id=project_id,
            ticket_id=ticket_id,
            member_id=member_id,
            active_only=active_only,
            limit=max(1, min(limit, 100)),
        )
        dicts = await svc_runs.runs_to_dicts(session, rows)
    return redact_obj([_run_row_dict(d) for d in dicts])


async def run(run_id: str, limit: int = RUN_STEPS) -> dict:
    """One run: state, queue position, the last steps, files, question and answer, report, cost, status changes."""
    async with common.async_session() as session:
        row = await _run_row(session, run_id)
        d = (await svc_runs.runs_to_dicts(session, [row]))[0]
    steps = d["steps"]
    keep = max(1, min(limit, 100))
    return redact_obj(
        {
            **_run_row_dict(d),
            "project_id": d["project_id"],
            "instruction": _short(d["instruction"], 600),
            "model": d["model"],
            "started_at": d["started_at"],
            "elapsed_s": d["elapsed_s"],
            "ended_reason": d["ended_reason"],
            "queue_position": d.get("queue_position"),
            "behind_ticket_id": d.get("behind_ticket_id"),
            "step_count": len(steps),
            "steps": [
                {
                    "at": s.get("at"),
                    "kind": s.get("kind"),
                    "text": _short(s.get("text"), 200),
                }
                for s in steps[-keep:]
            ],
            "files": d["files"],
            "question": d["question"],
            "answer": d["answer"],
            "report": d["report"],
            "tests": d["tests"],
            "tokens_in": d["tokens_in"],
            "tokens_out": d["tokens_out"],
            "metered": d["metered"],
            "status_before": d["status_before"],
            "status_changes": d["status_changes"],
        }
    )


async def approvals(
    project_id: str, status: str | None = None, limit: int = 20
) -> list[dict]:
    """Approvals of the project's AI, pending first. Read only: a person decides them in the board."""
    async with common.async_session() as session:
        await _project(session, project_id)
        rows = await svc_approvals.list_approvals(
            session, project_id, status=status, actor=_by()
        )
    keys = (
        "id",
        "member_name",
        "ticket_id",
        "action",
        "summary",
        "reason",
        "risk",
        "status",
        "on_behalf_of",
        "requested_at",
        "expires_at",
        "decided_by",
        "decided_at",
    )
    return redact_obj(
        [{k: a.get(k) for k in keys} for a in rows[: max(1, min(limit, 100))]]
    )


async def docs_jobs(
    project_id: str, page_id: str | None = None, limit: int = 20
) -> list[dict]:
    """Recent Docs AI jobs (ask, thread replies, checks...): kind, state, pages read, cost."""
    from services.docs_ai import access, jobs

    async with common.async_session() as session:
        await _project(session, project_id)
        rows = await jobs.list_jobs(
            session, project_id, page_id=page_id, limit=max(1, min(limit, 100))
        )
        hidden = (
            await access.hidden_page_ids(session, project_id)
            if guard.current() is not None
            else set()
        )
    out = []
    for j in rows:
        if j.page_id in hidden:
            continue
        d = jobs.to_dict(j)
        out.append(
            {
                "id": d["id"],
                "kind": d["kind"],
                "state": d["state"],
                "page_id": d["page_id"],
                "thread_id": d["thread_id"],
                "member_id": d["member_id"],
                "started_by": d["started_by"],
                "instruction": _short(d["instruction"], 150),
                "pages_read": len(d["reads"]),
                "cost_usd": d["cost"],
                "tokens_in": d["tokens_in"],
                "tokens_out": d["tokens_out"],
                "error": (d["error"] or {}).get("message"),
                "queued_at": d["queued_at"],
                "ended_at": d["ended_at"],
            }
        )
    return redact_obj(out)


# ---------------------------------------------------------------------------
# Acts
# ---------------------------------------------------------------------------


async def _wait_note(
    session, name: str, profile: AiMember, project_id: str
) -> str | None:
    """Why a run queued for this member will not start at once (paused, over budget), or None."""
    if profile.paused:
        return f"{name} is paused: the run waits until it is resumed."
    settings = await get_settings(session, project_id)
    hit = await budget.blocked(session, profile, settings)
    return (
        f"{name} is over budget ({hit[0]}: {hit[1]}): the run waits." if hit else None
    )


def _need_text(text: str | None) -> str:
    text = (text or "").strip()
    if not text:
        raise ValueError("Write the text first.")
    return text


async def ask(
    member_id: str,
    text: str,
    ticket_id: str | None = None,
    page_id: str | None = None,
    thread_id: str | None = None,
    intent: str = "ask",
) -> dict:
    """Wake an AI member the way the board's Ask AI does: post `@Name text` as a comment on the ticket (or in a Docs
    thread on the page) and start the run. intent: ask (answer in a comment), work (assign the ticket and start a
    work run), notify (comment only, nothing runs)."""
    text = _need_text(text)
    if intent not in ("ask", "work", "notify"):
        raise ValueError("intent must be ask, work or notify.")
    if bool(ticket_id) == bool(page_id):
        raise ValueError(
            "ask needs ticket_id, or page_id (with an optional thread_id)."
        )
    if thread_id and not page_id:
        raise ValueError("thread_id goes with page_id.")
    if page_id:
        return await _ask_in_docs(member_id, text, page_id, thread_id, intent)
    by = _by()
    async with common.async_session() as session:
        ticket = await session.get(Ticket, ticket_id)
        if ticket is None:
            raise ValueError(
                f"Ticket '{ticket_id}' not found (use the key such as 'IAM-12')."
            )
        member, profile = await _ai(session, member_id)
        if member.project_id != ticket.project_id:
            raise ValueError("Pick an AI member of this ticket's project.")
        if intent != "notify":
            settings = await get_settings(session, ticket.project_id)
            if settings.paused_all:
                raise ValueError(
                    "AI is paused for this project (kill switch): nothing was sent. A person resumes it in the board."
                )
            if profile.connection == "inbox":
                raise ValueError(
                    f"{member.name} is an MCP client with an inbox only: the board cannot start it."
                )
            if profile.remove_after_run:
                raise ValueError(
                    f"{member.name} is being removed; it takes no new runs."
                )
            if intent == "work":
                held = [
                    r
                    for r in await active_runs(session, ticket_id=ticket_id)
                    if r.mode == "work" and not r.behind_run_id
                ]
                if held:
                    raise ValueError(
                        f"{ticket_id} is held by another AI run (#{held[0].number}). "
                        "Wait for it to end, or cancel it first."
                    )
        mention = f"@[{member.name}](member:{member.id}) {text}"
        updated = await svc_tickets.add_comment(
            session, ticket_id, mention, author=by, meta={"asked_ai": member.id}
        )
        comment_id = loads(updated.comments, [])[-1]["id"]
        result: dict = {"ticket_id": ticket_id, "comment_id": comment_id, "run": None}
        if intent == "notify":
            await board_events.publish("invalidate")
            return result
        if intent == "work" and ticket.assignee != member.id:
            await svc_tickets.update_ticket(
                session, ticket_id, TicketUpdate(assignee=member.id)
            )
        try:
            row = await svc_runs.create_run(
                session,
                ticket_id=ticket_id,
                member_id=member.id,
                mode="work" if intent == "work" else "ask",
                trigger="mention" if intent == "work" else "ask",
                started_by=by,
                instruction=text,
                source_comment_id=comment_id,
            )
        except svc_runs.RunError as exc:
            raise ValueError(f"{exc} (The comment was posted.)") from exc
        result["run"] = _run_row_dict((await svc_runs.runs_to_dicts(session, [row]))[0])
        note = await _wait_note(session, member.name, profile, ticket.project_id)
        if note:
            result["note"] = note
    await board_events.publish("invalidate")
    return result


async def _ask_in_docs(
    member_id: str, text: str, page_id: str, thread_id: str | None, intent: str
) -> dict:
    """Ask in a Docs comment thread: a page comment (or a reply) that mentions the AI, delivered by Docs AI."""
    if intent == "work":
        raise ValueError(
            "In Docs an AI can be asked or notified; 'work' is for tickets."
        )
    from services import docs_comments

    try:
        from services.docs_ai import threads
    except ImportError:
        threads = None
    deliver = getattr(threads, "deliver", None)
    if deliver is None:
        raise ValueError("Asking an AI in a Docs thread is not available yet")
    by = _by()
    async with common.async_session() as session:
        member, _ = await _ai(session, member_id)
        body = f"@[{member.name}](member:{member.id}) {text}"
        try:
            if thread_id:
                thread = await docs_comments.add_reply(session, thread_id, body)
            else:
                thread = await docs_comments.create_thread(
                    session, page_id, kind="page", body=body
                )
        except docs_comments.DocsError as exc:
            raise ValueError(str(exc)) from exc
        comment_id = thread["comments"][-1]["id"]
        from services.docs_ai.errors import DocsAiError

        try:
            delivered = await deliver(
                session,
                thread_id=thread["id"],
                comment_id=comment_id,
                by=by,
                intent=intent,
            )
        except DocsAiError as exc:
            raise ValueError(f"{exc} (The comment was posted.)") from exc
    await board_events.publish("invalidate")
    return {
        "page_id": page_id,
        "thread_id": thread["id"],
        "comment_id": comment_id,
        "delivered": _plain(delivered),
    }


def _plain(value: Any) -> Any:
    if isinstance(value, (dict, list, str, int, float, bool)) or value is None:
        return value
    to_dict = getattr(value, "to_dict", None)
    if callable(to_dict):
        return to_dict()
    try:
        return json.loads(json.dumps(value, default=str))
    except (TypeError, ValueError):
        return str(value)


async def _fresh(run_id: str) -> dict:
    async with common.async_session() as session:
        row = await session.get(AiRun, run_id)
        return _run_row_dict((await svc_runs.runs_to_dicts(session, [row]))[0])


async def _resource_level() -> str:
    """none | view | control for the caller. A person, or an AI outside the board's runs, acts with their own rights
    (control); an AI run gets what its member's "Resource tools" setting says, and the Autopilot delegate (which has
    the owner's rights) gets control."""
    ctx = guard.current()
    if ctx is None:
        return "control"
    async with common.async_session() as session:
        _, profile = await get_profile(session, ctx.member_id)
        settings = await get_settings(session, ctx.project_id)
    if profile is None:
        return "none"
    if full_rights_member(settings) == profile.id:
        return "control"
    return svc_resources.access_of(profile)


async def _need_resource_level(wanted: str) -> None:
    """Refuse an AI run that was not given the resource tools (view) or the right to act on runs (control)."""
    have = await _resource_level()
    order = svc_resources.ACCESS_LEVELS
    if order.index(have) < order.index(wanted):
        raise ValueError(
            "The resource tools are not turned on for this AI member."
            if have == "none"
            else "This AI member may look at the resources but not stop or restart runs."
        )


async def resources(project_id: str) -> dict:
    """RAM and CPU of the running AIs (the CLI process, what it started, peak, restarts) and of the machine."""
    await _need_resource_level("view")
    async with common.async_session() as session:
        await _project(session, project_id)
    snap = await svc_resources.snapshot(project_id)
    for row in snap["runs"]:
        row.pop("history", None)
    return snap


async def _ask_for_run_control(
    run_id: str, what: str, reason: str | None = None
) -> dict | None:
    """An AI run (not the Autopilot delegate, which has the owner's rights) acting on another AI's run only asks;
    returns the "pending approval" answer, or None when the caller may act now."""
    ctx = guard.current()
    if ctx is None:
        return None
    async with common.async_session() as session:
        run = await _run_row(session, run_id)
        settings = await get_settings(session, ctx.project_id)
        _, profile = await get_profile(session, ctx.member_id)
        if profile is None or run.member_id == ctx.member_id:
            return None
        if full_rights_member(settings) == profile.id:
            return None
        approval = await svc_approvals.request_run_control(
            session, profile, ctx, run, what, reason
        )
    return {
        "pending_approval": approval.id,
        "message": f"Asked a person to approve this ({what} run {run_id}). Carry on with your work meanwhile.",
    }


async def restart(run_id: str) -> dict:
    """Start a running run's CLI again inside the same run: it resumes its conversation and its memory is released."""
    await _need_resource_level("control")
    asked = await _ask_for_run_control(run_id, "restart")
    if asked:
        return asked
    async with common.async_session() as session:
        await _run_row(session, run_id)
    try:
        await svc_runs.restart_run(run_id, by=_by())
    except svc_runs.RunError as exc:
        raise ValueError(str(exc)) from exc
    return {"restarting": True, "run_id": run_id}


async def cancel(run_id: str, text: str | None = None) -> dict:
    """Cancel an active run (text: the reason). Returns the run."""
    ctx = guard.current()
    if ctx is not None:
        await _need_resource_level("control")
        if ctx.run_id == run_id:
            raise ValueError("An AI cannot stop its own run.")
        asked = await _ask_for_run_control(run_id, "stop", (text or "").strip() or None)
        if asked:
            return asked
    async with common.async_session() as session:
        await _run_row(session, run_id)
    row = await svc_runs.cancel(run_id, by=_by(), reason=(text or "").strip() or None)
    await board_events.publish("invalidate")
    return await _fresh(row.id)


async def retry(run_id: str) -> dict:
    """Retry an ended run: a new run #n+1 for the same member and ticket."""
    async with common.async_session() as session:
        await _run_row(session, run_id)
    row = await svc_runs.retry(run_id, by=_by())
    return await _fresh(row.id)


async def answer(run_id: str, text: str) -> dict:
    """Answer the question of a run that is waiting for input; it resumes."""
    text = _need_text(text)
    async with common.async_session() as session:
        await _run_row(session, run_id)
    row = await svc_runs.answer(run_id, by=_by(), text=text)
    return await _fresh(row.id)


async def _described(session, member_id: str) -> dict:
    m, profile = await _ai(session, member_id)
    return _member_row(await svc_members.describe(session, m, profile))


async def pause(member_id: str, text: str | None = None) -> dict:
    """Pause an AI member: new work queues, a run in progress finishes. text: the reason."""
    async with common.async_session() as session:
        await _ai(session, member_id)
        await svc_members.set_paused(
            session, member_id, True, by=_by(), reason=(text or "").strip() or None
        )
        out = await _described(session, member_id)
    await board_events.publish("invalidate")
    return out


async def resume(member_id: str) -> dict:
    """Resume a paused AI member."""
    async with common.async_session() as session:
        await _ai(session, member_id)
        await svc_members.set_paused(session, member_id, False, by=_by())
        out = await _described(session, member_id)
    await board_events.publish("invalidate")
    return out


def _check_fields(fields: dict | None, allowed: set[str]) -> dict:
    """Refuse what only a person may set, and anything unknown, with a message that says what is accepted."""
    fields = dict(fields or {})
    forbidden = [
        k
        for k in fields
        if k in drafts.FORBIDDEN_KEYS
        and not (k == "provider" and "provider" in allowed)
    ]
    if forbidden or any(k in fields for k in ("folder", "working_dir", "cwd")):
        keys = forbidden + [k for k in ("folder", "cwd") if k in fields]
        raise ValueError(ONLY_A_PERSON.format(keys=", ".join(keys)))
    unknown = [k for k in fields if k not in allowed]
    if unknown:
        raise ValueError(
            f"Unknown field(s): {', '.join(unknown)}. Accepted: {', '.join(sorted(allowed))}."
        )
    if "template" in fields and fields["template"] not in drafts.TEMPLATES_OK:
        raise ValueError(f"template must be one of {', '.join(drafts.TEMPLATES_OK)}.")
    if "ceiling" in fields:
        ceiling = str(fields["ceiling"]).strip().lower().replace(" ", "-")
        ceiling = {"to-do": "todo", "in_progress": "in-progress"}.get(ceiling, ceiling)
        if ceiling not in drafts.CEILINGS_OK:
            raise ValueError(
                f"ceiling must be one of {', '.join(drafts.CEILINGS_OK)}. Moving tickets past Review needs "
                "an owner's confirmation in the board."
            )
        fields["ceiling"] = ceiling
    return fields


async def _base_member(session, project_id: str, provider: str) -> AiMember | None:
    """An existing member of the project with this provider, whose folder and CLI path a new one reuses."""
    settings = await get_settings(session, project_id)
    rows = (
        await session.exec(
            select(AiMember)
            .where(AiMember.project_id == project_id, AiMember.provider == provider)
            .order_by(col(AiMember.created_at))
        )
    ).all()
    boss = [p for p in rows if p.id == settings.board_ai_id]
    return (boss or rows or [None])[0]


async def create_member(project_id: str, fields: dict) -> dict:
    """Add an AI member without a key: a local runner (claude-code, antigravity) or an MCP client. A new local
    member reuses the folder and CLI path of an existing one with the same provider."""
    fields = _check_fields(fields, CREATE_KEYS)
    provider = fields.get("provider") or "claude-code"
    if provider not in PROVIDERS_OK:
        raise ValueError(
            f"provider must be one of {', '.join(PROVIDERS_OK)}. A member that needs an API key is "
            "added by a person in the Add AI member dialog."
        )
    by = _by()
    async with common.async_session() as session:
        await _project(session, project_id)
        if not str(fields.get("name") or "").strip():
            raise ValueError("fields.name is required.")
        verdict = await svc_members.check_name(session, project_id, fields["name"])
        if not verdict["ok"]:
            raise ValueError(verdict["message"])
        specs, _ = drafts.check_ai_members(
            [fields], await drafts.taken_names(session, project_id)
        )
        spec = specs[0]
        base = await _base_member(session, project_id, provider)
        body = {
            "name": spec["name"],
            "provider": provider,
            "description": spec["description"],
            "persona": spec["persona"],
            "max_parallel": spec["max_parallel"],
            "max_runs_per_day": spec["max_runs_per_day"],
            "ceiling": spec["ceiling"],
            "template": spec["template"],
            "permissions": {},
            "model": spec["model"] or None,
        }
        if base is not None and provider != "mcp-client":
            body["working_dir"] = base.working_dir
            body["cli_path"] = base.cli_path or None
            body["model"] = body["model"] or base.model
        if provider == "claude-code" and spec["read_only_cli"]:
            body["config"] = {
                "allow_rules": drafts.REVIEW_ALLOW
                if spec["template"] == "reviewer"
                else drafts.READ_ONLY_ALLOW
            }
        body = {k: v for k, v in body.items() if v is not None}
        created = await svc_members.create(session, project_id, body, by=by)
        await audit.record(
            project_id,
            "ai_member_created_via_mcp",
            "info",
            member_id=created.id,
            member_name=created.name,
            on_behalf_of=by,
            detail={"provider": provider},
        )
        out = await _described(session, created.id)
    await board_events.publish("invalidate")
    if provider == "claude-code" and base is None:
        out["note"] = (
            "No working folder yet: a person sets it in the member's settings."
        )
    return out


async def update_member(member_id: str, fields: dict) -> dict:
    """Change an AI member's name, role text, template, ceiling (up to Review), limits or model."""
    fields = _check_fields(fields, UPDATE_KEYS)
    if not fields:
        raise ValueError(
            f"fields is empty. Accepted: {', '.join(sorted(UPDATE_KEYS))}."
        )
    by = _by()
    async with common.async_session() as session:
        await _ai(session, member_id)
        await svc_members.update(session, member_id, fields, by=by)
        out = await _described(session, member_id)
    await board_events.publish("invalidate")
    return out


# --------------------------------------------------------------------------- full control (Settings > Integrations)

# Only the AI team's endpoints: AI members, runs, approvals, safety, audit, schedules, role library.
FULL_CONTROL_PATH = re.compile(
    r"^/(ai/|projects/[^/?#]+/ai/|tickets/[^/?#]+/ai/)[^?#]*(\?[^#]*)?$"
)
FULL_CONTROL_OFF = (
    "Full control over MCP is off. A person turns it on in Settings > Integrations > MCP integrations; "
    "until then use the other ai_team actions."
)
BODY_LIMIT = 60_000


def _need_full_control() -> None:
    if not app_config.get_flag(app_config.MCP_FULL_CONTROL):
        raise ValueError(FULL_CONTROL_OFF)


async def endpoints(text: str | None = None) -> list[str]:
    """The AI-team endpoints `api` can call (METHOD path: what it does), optionally only those containing `text`."""
    _need_full_control()
    from main import app

    rows = []
    for route in app.routes:
        path = getattr(route, "path", "")
        if not FULL_CONTROL_PATH.match(path):
            continue
        doc = (getattr(route.endpoint, "__doc__", "") or "").strip().split("\n")[0]
        for method in sorted(getattr(route, "methods", None) or ()):
            if method in ("HEAD", "OPTIONS"):
                continue
            rows.append(f"{method} {path}" + (f": {_short(doc, 90)}" if doc else ""))
    needle = (text or "").strip().lower()
    return sorted(r for r in rows if needle in r.lower())


async def api(path: str, body: dict | None = None) -> Any:
    """Call one AI-team endpoint of the board as the person (the same rights and checks as the app, the same
    audit). `path` is "METHOD /path"; only paths under /ai/, /projects/<id>/ai/ and /tickets/<id>/ai/."""
    _need_full_control()
    import httpx

    method, _, path = (path or "").strip().partition(" ")
    method = method.upper()
    if method not in ("GET", "POST", "PUT", "PATCH", "DELETE"):
        raise ValueError(
            "path is 'METHOD /endpoint', the method being GET, POST, PUT, PATCH or DELETE."
        )
    path = (path or "").strip()
    if ".." in path or not FULL_CONTROL_PATH.match(path):
        raise ValueError(
            "The endpoint must be an AI-team one: /ai/..., /projects/<id>/ai/... or /tickets/<id>/ai/... "
            "(see action 'endpoints')."
        )
    from main import app

    # the board remembers the address a request came in on to hand it to CLI runs; this one is not a real address
    seen_url = svc_runs.RT.board_url
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url=seen_url or "http://127.0.0.1",
            timeout=120,
        ) as client:
            reply = await client.request(
                method,
                path,
                json=body if method in ("POST", "PUT", "PATCH") else None,
                headers={"X-Actor": _by(), "X-Origin": "mcp"},
            )
    finally:
        svc_runs.RT.board_url = seen_url
    try:
        data: Any = reply.json()
    except ValueError:
        data = reply.text
    if reply.status_code >= 400:
        detail = data.get("detail") if isinstance(data, dict) else data
        raise ValueError(f"{method} {path} -> {reply.status_code}: {detail}")
    data = redact_obj(data)
    if len(json.dumps(data, default=str)) > BODY_LIMIT:
        return {
            "status": reply.status_code,
            "truncated": True,
            "body": json.dumps(data, default=str)[:BODY_LIMIT],
        }
    return data


async def accounts(project_id: str | None = None) -> list[dict]:
    """The AI accounts on this computer (separate logins of one CLI): who is signed in and which members use each.
    Only a person can sign in, in the app; the login is never shown."""
    async with common.async_session() as session:
        if project_id:
            await _project(session, project_id)
        rows = await svc_accounts.list_all(session)
        users = await svc_accounts.counts(session, project_id)
    out = []
    for a in rows:
        mine = users.get(a.id) or {"here": [], "elsewhere": []}
        out.append(
            {
                "id": a.id,
                "name": a.name,
                "cli": a.cli,
                "status": a.status,
                "signed_in_as": a.email,
                "plan": a.plan,
                "method": a.method,
                "checked_at": a.checked_at,
                "members": [m["name"] for m in mine["here"]],
                "members_elsewhere": len(mine["elsewhere"]),
                **(
                    {"note": "Signed out. Only a person can sign in, in the app."}
                    if a.status == "needs_sign_in"
                    else {}
                ),
            }
        )
    return out


async def assign_account(member_id: str, account_id: str) -> dict:
    """Make an AI member run as an account (`none`: the login already on this computer). Members of other CLIs are refused."""
    async with common.async_session() as session:
        await _ai(session, member_id)
        try:
            await svc_accounts.assign(
                session, member_id, None if account_id == "none" else account_id
            )
        except svc_accounts.AccountError as exc:
            raise ValueError(
                f"{exc} ai_team(action='accounts') lists the accounts."
            ) from exc
        out = await _described(session, member_id)
    await board_events.publish("invalidate")
    return out
