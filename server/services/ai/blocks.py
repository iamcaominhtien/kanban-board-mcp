"""What stopped the AIs (issue #275, task 1): every refused action, denied tool, permission question and "I cannot"
of a project's runs, grouped, with the role and what the AI was trying to do, and what the board does about it now.

Sources, newest first within the window:
- the audit log: board actions refused (`blocked`), asked (`needs_approval`) or denied by a person;
- the tool requests (`use_tool` approvals): what the CLI refused for lack of a rule;
- the runs' steps: errors that are a refusal (the CLI's "permission" errors, the board's `BLOCKED (…)`, a proof path the
  board could not find), and what the AI said it could not do.

Each group carries a verdict: `fixed` (the board no longer stops it), `kept` (on purpose, with the reason), `setting`
(a switch decides; the verdict names it) or `open` (nothing decided yet).
"""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import UTC, datetime, timedelta

from sqlmodel import col, select

from models import AiApproval, AiAudit, AiMember, AiRun, Member

from . import tool_rules
from .permissions import ACTIONS
from .plugins import role_of
from .store import loads

# A step error that is a refusal, and the tool it names
_CLI_DENIED = re.compile(
    r"(?:requested permissions? to use|permission to use|not allowed to use|denied permission to use)\s+([A-Za-z_][\w:.-]*)",
    re.I,
)
_BOARD_CODE = re.compile(r"BLOCKED \(([a-z_]+)\)")
_SAID = re.compile(
    r"\b(I (?:can(?:no|')t|could(?:n't| not)|am unable to|was unable to|don't have (?:the )?permission|do not have "
    r"(?:the )?permission|was (?:not allowed|refused|denied|blocked))[^.\n]{0,160})",
    re.I,
)
AUDITED_CODES = {"blocked", "status_ceiling", "approvals_full", "scope", "autopilot"}
_PROOF = re.compile(
    r"no such file in the working folder|outside the working folder", re.I
)

FIXED_PROOF = (
    "fixed",
    "The board now looks in the ticket's worktree first, then the member's folder, and accepts an absolute path "
    "inside either (3.22.0).",
)


def _since(days: int) -> str:
    return (datetime.now(UTC) - timedelta(days=days)).isoformat()


def _verdict_board(action: str, code: str, reason: str) -> tuple[str, str]:
    if code == "status_ceiling":
        return (
            "kept",
            "A person decides past the status ceiling (Review by default). Raise it per AI on its Permissions tab, or "
            "let the board move to Done after review (Team on its own).",
        )
    if code == "approvals_full":
        return (
            "setting",
            "Too many requests waited. Answering with “remember” stops the same question coming back.",
        )
    if code == "ai_run_only":
        return (
            "fixed",
            "Handing a ticket to a teammate with ai_team(ask, intent='work') inside a run now goes through as "
            "ai_run(handoff); the rest of ai_team stays a person's (3.22.0).",
        )
    if code == "scope":
        return (
            "setting",
            "The AI's scope: widen it on its Permissions tab, or assign it the ticket.",
        )
    if action in ("delete_tickets", "delete_docs"):
        return (
            "kept",
            "Deleting stays with a person by default. The owner may set it to Needs approval, or lift the lock on the AI's Permissions tab (with a warning).",
        )
    if action == "manage_project":
        return ("kept", "Projects and members are managed by people only.")
    if "Safe mode" in reason or "Pause all AI" in reason:
        return ("kept", "Safe mode and Pause all AI stop changes on purpose.")
    if "ask before Docs edits" in reason:
        return (
            "setting",
            "“Ask before Docs edits” (the Careful preset), or remember the answer for the project.",
        )
    return (
        "setting",
        "The AI's permission row. Answer once and remember it for this ticket, the project or the role, or change the "
        "row on its Permissions tab.",
    )


def _verdict_rule(
    rule: str, role: str | None, granted: set[str], web_search: str
) -> tuple[str, str]:
    if rule == "WebSearch":
        if tool_rules.web_search_for(role, web_search):
            return (
                "fixed",
                "Web search is on for this role now (Settings › AI › Safety and limits, Web search).",
            )
        return (
            "setting",
            "Web search: off, by role or on (Settings › AI › Safety and limits).",
        )
    if tool_rules.never_remembered(rule):
        return (
            "kept",
            "Pushing, sudo and forced deletes are asked every time, never remembered.",
        )
    if rule in tool_rules.role_tools(role):
        return (
            "fixed",
            f"Now part of what the {role} role may run without asking (3.22.0).",
        )
    if rule in granted:
        return ("fixed", "A person allowed it and the board remembers.")
    return (
        "setting",
        "Asked once: the answer is kept for this ticket, the project or the role.",
    )


async def collect(session, project_id: str, *, days: int = 30, limit: int = 60) -> dict:
    """The groups of blocks in the last `days` days, most frequent first."""
    since = _since(days)
    profiles = {
        p.id: p
        for p in (
            await session.exec(
                select(AiMember).where(AiMember.project_id == project_id)
            )
        ).all()
    }
    names = {
        m.id: m.name
        for m in (
            await session.exec(select(Member).where(Member.project_id == project_id))
        ).all()
    }
    from . import safety
    from .store import get_settings

    settings = await get_settings(session, project_id)
    web_search = tool_rules.settings_of(settings)["web_search"]

    groups: dict[str, dict] = {}

    def add(
        key: str,
        *,
        kind: str,
        title: str,
        member_id: str | None,
        at: str,
        example: str,
        trying: str = "",
        verdict: tuple[str, str],
        ref: dict | None = None,
    ) -> None:
        g = groups.get(key)
        role = role_of(profiles[member_id]) if member_id in profiles else None
        if g is None:
            g = groups[key] = {
                "key": key,
                "kind": kind,
                "title": title,
                "count": 0,
                "roles": [],
                "members": [],
                "first_at": at,
                "last_at": at,
                "example": example[:300],
                "trying": trying[:200],
                "verdict": verdict[0],
                "verdict_text": verdict[1],
                "refs": [],
            }
        g["count"] += 1
        if role and role not in g["roles"]:
            g["roles"].append(role)
        name = names.get(member_id or "")
        if name and name not in g["members"]:
            g["members"].append(name)
        if at < g["first_at"]:
            g["first_at"] = at
        if at >= g["last_at"]:
            g["last_at"] = at
            g["example"] = example[:300] or g["example"]
            g["trying"] = trying[:200] or g["trying"]
        if ref and len(g["refs"]) < 5:
            g["refs"].append(ref)

    # 1. The board's own refusals and questions
    audits = (
        await session.exec(
            select(AiAudit).where(
                AiAudit.project_id == project_id,
                col(AiAudit.result).in_(["blocked", "needs_approval", "denied"]),
                AiAudit.created_at >= since,
            )
        )
    ).all()
    for e in audits:
        d = loads(e.detail, {}) or {}
        code = d.get("code") or ("asked" if e.result == "needs_approval" else e.result)
        label = ACTIONS.get(e.action, (e.action.replace("_", " ").capitalize(),))[0]
        reason = str(d.get("reason") or "")
        if e.result == "needs_approval":
            title, verdict = (
                f"{label}: asked a person",
                (
                    "setting",
                    "Needs approval for this AI. Remember the answer for the ticket, the project or the role to stop "
                    "the same question.",
                ),
            )
        elif e.result == "denied":
            title, verdict = (
                f"{label}: a person said no",
                ("kept", "A person's decision."),
            )
        else:
            title = f"{label}: refused" + {
                "status_ceiling": " (status ceiling)",
                "scope": " (outside its scope)",
                "approvals_full": " (approvals full)",
                "autopilot": " (Autopilot only decides)",
            }.get(code, "")
            verdict = _verdict_board(e.action, code, reason)
        add(
            f"board:{e.action}:{code}",
            kind="board",
            title=title,
            member_id=e.member_id,
            at=e.created_at,
            example=reason or e.result,
            trying=f"{(d.get('tool') or '').replace('_', ' ')} {d.get('op') or ''} {e.target or ''}".strip(),
            verdict=verdict,
            ref={"run_id": e.run_id, "target": e.target},
        )

    # 2. Tools the CLI refused, asked once
    asks = (
        await session.exec(
            select(AiApproval).where(
                AiApproval.project_id == project_id,
                AiApproval.action == "use_tool",
                AiApproval.requested_at >= since,
            )
        )
    ).all()
    for a in asks:
        p = loads(a.payload, {}).get("params") or {}
        rule = p.get("rule") or "?"
        role = p.get("role") or (
            role_of(profiles[a.member_id]) if a.member_id in profiles else None
        )
        granted = set(
            await safety.granted_rules(
                session,
                project_id=project_id,
                member_id=a.member_id,
                ticket_id=a.ticket_id,
                role=role,
            )
        )
        add(
            f"cli:{rule}",
            kind="cli",
            title=f"CLI refused `{rule}`",
            member_id=a.member_id,
            at=a.requested_at,
            example=f"{a.summary} · {a.status}",
            trying=p.get("call") or "",
            verdict=_verdict_rule(rule, role, granted, web_search),
            ref={"run_id": a.run_id, "target": a.ticket_id, "approval_id": a.id},
        )

    # 3. The runs' own steps: refusals the run hit and what the AI said it could not do
    runs = (
        await session.exec(
            select(AiRun).where(
                AiRun.project_id == project_id,
                AiRun.queued_at >= since,
            )
        )
    ).all()
    for r in runs:
        steps = loads(r.steps, []) or []
        by_id = {
            s.get("tool_id"): s
            for s in steps
            if s.get("tool_id") and s.get("kind") != "error"
        }
        role = role_of(profiles[r.member_id]) if r.member_id in profiles else None
        for s in steps:
            text = str(s.get("text") or "")
            at = s.get("at") or r.queued_at
            ref = {"run_id": r.id, "target": r.ticket_id}
            if s.get("kind") == "error":
                trying = str((by_id.get(s.get("tool_id")) or {}).get("text") or "")
                m = _CLI_DENIED.search(text)
                if m:
                    tool = m.group(1)
                    add(
                        f"cli:{tool}",
                        kind="cli",
                        title=f"CLI refused {tool}",
                        member_id=r.member_id,
                        at=at,
                        example=text,
                        trying=trying,
                        verdict=_verdict_rule(tool, role, set(), web_search)
                        if tool == "WebSearch"
                        else (
                            "setting",
                            "Asked once from 3.22.0: the answer is kept for the ticket, project or role.",
                        ),
                        ref=ref,
                    )
                    continue
                if _PROOF.search(text):
                    add(
                        "board:proof_path",
                        kind="board",
                        title="Evidence file not found in the working folder",
                        member_id=r.member_id,
                        at=at,
                        example=text,
                        trying=trying,
                        verdict=FIXED_PROOF,
                        ref=ref,
                    )
                    continue
                found = _BOARD_CODE.search(text)
                code = found.group(1) if found else None
                if code is None and "An AI run cannot start AIs" in text:
                    code = "ai_run_only"  # the message before 3.22.0 had no code
                # the guard's own refusals are in the audit log already (1.); these are an MCP tool's own checks
                if code and code not in AUDITED_CODES:
                    add(
                        f"board:step:{code}",
                        kind="board",
                        title=f"Board refused ({code.replace('_', ' ')})",
                        member_id=r.member_id,
                        at=at,
                        example=text,
                        trying=trying,
                        verdict=_verdict_board("", code, text),
                        ref=ref,
                    )
            elif s.get("kind") == "say":
                m = _SAID.search(text)
                if m:
                    add(
                        f"said:{role or 'member'}",
                        kind="said",
                        title=f"“I cannot…” ({role or 'no role'})",
                        member_id=r.member_id,
                        at=at,
                        example=m.group(1),
                        verdict=(
                            "open",
                            "Read the run: what it could not do is often a tool the CLI refused.",
                        ),
                        ref=ref,
                    )
        m = _SAID.search(r.summary or "")
        if m:
            add(
                f"said:{role or 'member'}",
                kind="said",
                title=f"“I cannot…” ({role or 'no role'})",
                member_id=r.member_id,
                at=r.ended_at or r.queued_at,
                example=m.group(1),
                verdict=(
                    "open",
                    "Read the run: what it could not do is often a tool the CLI refused.",
                ),
                ref={"run_id": r.id, "target": r.ticket_id},
            )

    ordered = sorted(groups.values(), key=lambda g: g["last_at"], reverse=True)
    ordered.sort(
        key=lambda g: g["count"], reverse=True
    )  # most frequent first, the newest first among equals
    counts: dict[str, int] = defaultdict(int)
    for g in ordered:
        counts[g["verdict"]] += g["count"]
    return {
        "since": since,
        "days": days,
        "total": sum(g["count"] for g in ordered),
        "by_verdict": dict(counts),
        "groups": ordered[:limit],
    }
