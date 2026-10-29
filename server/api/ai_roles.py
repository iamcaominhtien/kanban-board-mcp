"""Who may configure and operate AI members (design/screens/ai-safety-cost.md, H1). One table maps each AI write
endpoint to the least project role it needs; the middleware resolves the project from the path and refuses the
request with 403 before the handler runs. Finer rules stay with their services: approvals by risk, owner-only
widening of an AI, owner confirmation of an admin's permission change, schedule ownership.

Roles: owner (the board's own user, or the first admin) > admin > member > viewer (`safety.role_name`)."""

import re

from fastapi import Request
from fastapi.responses import JSONResponse

import database
from models import AiMember, AiRun, AiSchedule, AiScheduleRun, Ticket
from services import activity as svc_activity
from services.ai import safety

ADMIN, OWNER, MEMBER = "admin", "owner", "member"
_MID = r"/ai/members/[^/]+"

# (methods, path pattern, least role, what the person tried to do)
RULES: list[tuple[set[str], re.Pattern, str, str]] = [
    (
        {"PUT"},
        re.compile(r"^/projects/[^/]+/ai/workspace-defaults$"),
        OWNER,
        "change workspace defaults",
    ),
    (
        {"POST"},
        re.compile(r"^/tickets/[^/]+/ai/allow-more-runs$"),
        OWNER,
        "allow more runs",
    ),
    ({"POST"}, re.compile(r"^/projects/[^/]+/ai/members$"), ADMIN, "add AI members"),
    ({"POST"}, re.compile(rf"^{_MID}/remove$"), ADMIN, "remove AI members"),
    ({"PATCH"}, re.compile(rf"^{_MID}$"), ADMIN, "change AI members"),
    (
        {"PUT"},
        re.compile(rf"^{_MID}/projects$"),
        ADMIN,
        "change the projects of AI members",
    ),
    (
        {"POST"},
        re.compile(
            rf"^{_MID}/(config/(write|reset|restore|undo-reset)|library/(attach|detach|update)"
            r"|reconnect|revoke-token|resume|retry-now)$"
        ),
        ADMIN,
        "change or resume AI members",
    ),
    (
        {"POST"},
        re.compile(r"^/projects/[^/]+/ai/resume-all$"),
        ADMIN,
        "resume AI",
    ),
    (
        {"PATCH"},
        re.compile(r"^/projects/[^/]+/ai/settings$"),
        MEMBER,  # members may only switch safe mode on; the handler refuses the rest
        "change AI settings",
    ),
    (
        {"POST"},
        re.compile(r"^/projects/[^/]+/ai/library$"),
        ADMIN,
        "change the shared library",
    ),
    # Members may pause (never resume), test and operate runs; viewers only look
    (
        {"POST"},
        re.compile(
            rf"^{_MID}/(pause|test|dry-run|mcp/probe|tools/test|prompt/preview|permissions/test"
            r"|config/(preview|validate|export|import-preview|tick))$"
        ),
        MEMBER,
        "use AI members",
    ),
    (
        {"POST"},
        re.compile(r"^/projects/[^/]+/ai/pause-all$"),
        MEMBER,
        "pause AI",
    ),
    ({"POST"}, re.compile(r"^/ai/runs/[^/]+/.+$"), MEMBER, "operate AI runs"),
    (
        {"POST"},
        re.compile(r"^/tickets/[^/]+/ai/.+$"),
        MEMBER,
        "work with AI on tickets",
    ),
    (
        {"POST"},
        re.compile(r"^/projects/[^/]+/ai/schedules$"),
        MEMBER,
        "schedule AI runs",
    ),
    (
        {"POST", "PATCH", "DELETE"},
        re.compile(r"^/ai/schedules/[^/]+(/.+)?$"),
        MEMBER,
        "change AI schedules",
    ),
    (
        {"POST"},
        re.compile(r"^/ai/schedule-runs/[^/]+/.+$"),
        MEMBER,
        "answer a scheduled run",
    ),
]

_PATHS = [
    (re.compile(r"^/projects/([^/]+)/"), None),
    (re.compile(r"^/ai/members/([^/]+)"), AiMember),
    (re.compile(r"^/ai/runs/([^/]+)"), AiRun),
    (re.compile(r"^/tickets/([^/]+)/"), Ticket),
    (re.compile(r"^/ai/schedules/([^/]+)"), AiSchedule),
    (re.compile(r"^/ai/schedule-runs/([^/]+)"), AiScheduleRun),
]


def rule_for(method: str, path: str) -> tuple[str, str] | None:
    """(least role, action) for a request, or None when the table does not cover it."""
    for methods, pattern, role, action in RULES:
        if method in methods and pattern.match(path):
            return role, action
    return None


async def _project_of(path: str) -> str | None:
    for pattern, model in _PATHS:
        m = pattern.match(path)
        if not m:
            continue
        if model is None:
            return m.group(1)
        async with database.async_session() as session:
            row = await session.get(model, m.group(1))
        return getattr(row, "project_id", None) if row else None
    return None


async def enforce(request: Request, call_next):
    """Refuse an AI request the person's role does not allow (403 with `code: forbidden`)."""
    rule = rule_for(request.method, request.url.path)
    if rule is None:
        return await call_next(request)
    project_id = await _project_of(request.url.path)
    if project_id is None:
        return await call_next(request)  # unknown id: the handler answers 404
    person = (request.headers.get("x-actor") or "").strip()[
        :80
    ] or svc_activity.HUMAN_ACTOR
    async with database.async_session() as session:
        role = await safety.role_name(session, project_id, person)
    need, action = rule
    if safety.ROLE_RANK[role] < safety.ROLE_RANK[need]:
        who = {
            "owner": "the project owner",
            "admin": "an admin or the owner",
            "member": "a member",
        }[need]
        return JSONResponse(
            status_code=403,
            content={
                "detail": f"Only {who} can {action}. You are a{'n' if role in ('admin', 'owner') else ''} {role} here.",
                "code": "forbidden",
                "role": role,
                "needs": need,
            },
        )
    return await call_next(request)
