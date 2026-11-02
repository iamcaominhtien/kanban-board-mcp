"""Ask once, then remember (issue #275): a tool call the CLI's rules refused becomes a request a person answers once.

A headless run cannot ask mid-call, so the CLI refuses what nothing allows and lists it at the end of the run
(`permission_denials` in its result). The board turns each refused call into an approval request with the narrowest
allow rule that covers it (`tool_rules.rule_for`): "Dev (TDD) wants to run `npm install left-pad`" → `Bash(npm
install:*)`. The person answers for this ticket, this project, or every member with the role; the answer is kept as a
grant and added to the next runs it covers (`safety.granted_rules`), and the run can go on where it stopped.

What is never remembered (`git push`, `sudo`, a forced delete) is still asked, but only for this ticket's next run.
A deny rule a person wrote is never asked about: that was a decision already.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from sqlmodel import select

import database
from models import AiApproval, AiRun

from . import safety, tool_rules
from .store import get_profile, get_settings, loads

USE_TOOL = "use_tool"
SCOPES = ("ticket", "project", "role")
MAX_ASKS_PER_RUN = 5


async def post(run_id: str, denials: list[dict]) -> list[AiApproval]:
    """Requests for the tools a run was refused (one per allow rule; a request that already waits is joined)."""
    if not denials:
        return []
    out: list[AiApproval] = []
    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        if run is None:
            return []
        member, profile = await get_profile(session, run.member_id)
        if profile is None:
            return []
        settings = await get_settings(session, run.project_id)
        if not tool_rules.settings_of(settings)["ask_cli"]:
            return []
        if settings.safe_mode or profile.safe_mode:
            return []  # safe mode refuses on purpose: nothing to ask
        config = loads(profile.config, {}) or {}
        deny_rules = set(config.get("deny_rules") or [])
        from .plugins import role_of

        role = role_of(profile)
        granted = set(
            await safety.granted_rules(
                session,
                project_id=run.project_id,
                member_id=run.member_id,
                ticket_id=run.ticket_id,
                role=role,
            )
        )
        pending = (
            await session.exec(
                select(AiApproval).where(
                    AiApproval.project_id == run.project_id,
                    AiApproval.member_id == run.member_id,
                    AiApproval.action == USE_TOOL,
                    AiApproval.status == "pending",
                )
            )
        ).all()
        waiting = {
            loads(a.payload, {}).get("params", {}).get("rule"): a for a in pending
        }
        seen: set[str] = set()
        name = member.name if member else "An AI"
        hours = settings.approval_expiry_hours or 24
        for d in denials:
            rule = tool_rules.rule_for(d.get("tool", ""), d.get("input"))
            if not rule or rule in seen or rule in granted:
                continue
            seen.add(rule)
            if rule in deny_rules or d.get("tool") in deny_rules:
                continue
            if rule in waiting:
                out.append(waiting[rule])
                continue
            if len(out) >= MAX_ASKS_PER_RUN:
                break
            call = tool_rules.describe_call(d.get("tool", ""), d.get("input"))
            a = AiApproval(
                project_id=run.project_id,
                member_id=run.member_id,
                run_id=run.id,
                ticket_id=run.ticket_id,
                action=USE_TOOL,
                summary=f"Let {name} {call}"[:300],
                payload=json.dumps(
                    {
                        "tool": "cli",
                        "action": USE_TOOL,
                        "params": {
                            "rule": rule,
                            "tool": d.get("tool"),
                            "call": call,
                            "role": role,
                        },
                    }
                ),
                reason="The CLI refused it because no rule allows it, and a run cannot ask in the middle of a call.",
                risk=tool_rules.risk_of_rule(rule),
                on_behalf_of=run.started_by,
                expires_at=(datetime.now(UTC) + timedelta(hours=hours)).isoformat(),
            )
            session.add(a)
            await session.commit()
            await session.refresh(a)
            out.append(a)
            await safety.notify(
                run.project_id,
                "approval_requested",
                "Permission asked",
                f"{name} was stopped: it wanted to {call}. Allow `{rule}` once and it is remembered for this ticket, "
                "the project or the role.",
                ref_kind="approval",
                ref_id=a.id,
                member_id=run.member_id,
                people=[
                    run.started_by,
                    *[x["to"] for x in safety.delegates_of(settings)],
                ],
            )
    return out


def scopes_for(a: AiApproval) -> list[str]:
    """How far an answer to a tool request may reach: what is never remembered goes only to this ticket."""
    rule = loads(a.payload, {}).get("params", {}).get("rule") or ""
    if tool_rules.never_remembered(rule):
        return ["ticket"]
    role = loads(a.payload, {}).get("params", {}).get("role")
    return ["ticket", "project", "role"] if role else ["ticket", "project"]


async def apply(a: AiApproval, by: str, scope: str | None, *, go_on: bool) -> dict:
    """A person allowed the tool: keep the rule for the scope, and let the run go on where it stopped."""
    params = loads(a.payload, {}).get("params") or {}
    rule = params.get("rule")
    if not rule:
        raise ValueError("This request names no tool.")
    allowed = scopes_for(a)
    scope = scope if scope in allowed else "ticket"
    role = params.get("role") if scope == "role" else None
    async with database.async_session() as session:
        await safety.add_grant(
            session,
            project_id=a.project_id,
            kind="tool",
            member_id=a.member_id,
            ticket_id=a.ticket_id if scope == "ticket" else None,
            action=rule,
            created_by=by,
            source_approval_id=a.id,
            role=role,
        )
    continued = None
    if go_on and a.run_id:
        from . import runs

        try:
            run = await runs.continue_run(
                a.run_id,
                by=by,
                note=(
                    f"{by} allowed `{rule}` (you were refused: {params.get('call') or rule}). Do it now and carry "
                    "on from where you stopped."
                ),
            )
            continued = run.id
        except runs.RunError:
            continued = None  # the ticket moved on, or another run holds it: the rule is kept for the next one
    return {"rule": rule, "scope": scope, "continued_run_id": continued}
