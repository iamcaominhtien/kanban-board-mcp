"""The AI team tool: look at the board's AI members, runs, cost and approvals; wake an AI; steer a run or a member."""

from typing import Annotated, Any, Literal

from pydantic import Field

from ..operations import ai_team as ops
from .routing import Op, dispatch, params_of

AI_TEAM_OPS: dict[str, Op] = {
    "members": Op(ops.members, ("project_id",)),
    "member": Op(ops.member, ("member_id",)),
    "usage": Op(ops.usage, ("project_id",), ("range",), {"range": "span"}),
    "runs": Op(
        ops.runs,
        (),
        ("project_id", "ticket_id", "member_id", "active_only", "limit"),
    ),
    "run": Op(ops.run, ("run_id",), ("limit",)),
    "approvals": Op(ops.approvals, ("project_id",), ("status", "limit")),
    "docs_jobs": Op(ops.docs_jobs, ("project_id",), ("page_id", "limit")),
    "ask": Op(
        ops.ask,
        ("member_id", "text"),
        ("ticket_id", "page_id", "thread_id", "intent"),
    ),
    "resources": Op(ops.resources, ("project_id",)),
    "restart": Op(ops.restart, ("run_id",)),
    "cancel": Op(ops.cancel, ("run_id",), ("text",)),
    "retry": Op(ops.retry, ("run_id",)),
    "answer": Op(ops.answer, ("run_id", "text")),
    "pause": Op(ops.pause, ("member_id",), ("text",)),
    "resume": Op(ops.resume, ("member_id",)),
    "create_member": Op(ops.create_member, ("project_id", "fields")),
    "update_member": Op(ops.update_member, ("member_id", "fields")),
    "endpoints": Op(ops.endpoints, (), ("text",)),
    "api": Op(ops.api, ("path",), ("fields",), {"fields": "body"}),
}
READS = {
    "members",
    "member",
    "usage",
    "runs",
    "run",
    "approvals",
    "docs_jobs",
    "resources",
}
# Allowed inside an AI run when its member's "Resource tools" setting is Control (checked in the operation)
RUN_CONTROL = {"restart", "cancel"}


async def ai_team(
    action: Literal[
        "members",
        "member",
        "usage",
        "runs",
        "run",
        "approvals",
        "docs_jobs",
        "resources",
        "ask",
        "restart",
        "cancel",
        "retry",
        "answer",
        "pause",
        "resume",
        "create_member",
        "update_member",
        "endpoints",
        "api",
    ],
    project_id: Annotated[
        str | None,
        Field(description="members, usage, runs, approvals, create_member."),
    ] = None,
    member_id: Annotated[
        str | None,
        Field(description="member, ask, pause, resume, update_member."),
    ] = None,
    ticket_id: Annotated[str | None, Field(description="ask, runs: IAM-12.")] = None,
    page_id: Annotated[str | None, Field(description="Docs: ask, docs_jobs.")] = None,
    thread_id: Annotated[str | None, Field(description="ask in Docs.")] = None,
    run_id: Annotated[
        str | None, Field(description="run, cancel, retry, answer.")
    ] = None,
    text: Annotated[
        str | None,
        Field(description="ask, answer: message; cancel, pause: reason."),
    ] = None,
    intent: Annotated[
        Literal["ask", "work", "notify"] | None,
        Field(description="ask, work (assign + work), notify (comment)."),
    ] = None,
    range: Literal["today", "7d", "month"] | None = None,
    status: Annotated[
        str | None, Field(description="approvals: pending|approved|denied.")
    ] = None,
    active_only: Annotated[
        bool | None, Field(description="runs: queued or running.")
    ] = None,
    limit: Annotated[
        int | None,
        Field(ge=1, le=100, description="Rows."),
    ] = None,
    path: Annotated[
        str | None,
        Field(description="api: 'POST /ai/runs/<id>/cancel'."),
    ] = None,
    fields: Annotated[
        dict[str, Any] | None,
        Field(
            description="create/update_member: name, description, persona, template developer|reviewer|read_only, "
            "ceiling none..review, max_parallel, max_runs_per_day, model; create: provider claude-code|antigravity|"
            "mcp-client; update: daily_budget, monthly_cap, tokens_per_day, cap_per_run. api: JSON body."
        ),
    ] = None,
) -> dict | list:
    """AI team: read members, runs, usage, approvals, resources; ask wakes an AI (an @mention via MCP does
    not); cancel, restart, retry, answer runs; pause, resume, create_member, update_member (no keys, folders, Bypass, ceiling
    past Review; approvals: in the board). With "Full control over MCP" on in Settings: endpoints lists
    and api calls AI endpoints as the person. Not in AI runs."""
    from services.ai import guard

    if action not in READS and await guard.resolve() is not None:
        # inside an AI run only a member with the Resource tools set to Control may restart or stop runs
        if action not in RUN_CONTROL or await ops._resource_level() != "control":
            raise ValueError(
                "An AI run cannot start AIs or change AI members or runs; a person does."
            )
    given = params_of({k: v for k, v in locals().items() if k != "guard"})
    return await dispatch("ai_team", AI_TEAM_OPS, action, given)
