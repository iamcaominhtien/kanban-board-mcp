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
    "cancel": Op(ops.cancel, ("run_id",), ("text",)),
    "retry": Op(ops.retry, ("run_id",)),
    "answer": Op(ops.answer, ("run_id", "text")),
    "pause": Op(ops.pause, ("member_id",), ("text",)),
    "resume": Op(ops.resume, ("member_id",)),
    "create_member": Op(ops.create_member, ("project_id", "fields")),
    "update_member": Op(ops.update_member, ("member_id", "fields")),
    "accounts": Op(ops.accounts, (), ("project_id",)),
    "assign_account": Op(ops.assign_account, ("member_id", "account_id")),
}
READS = {
    "members",
    "member",
    "usage",
    "runs",
    "run",
    "approvals",
    "docs_jobs",
    "accounts",
}


async def ai_team(
    action: Literal[
        "members",
        "member",
        "usage",
        "runs",
        "run",
        "approvals",
        "docs_jobs",
        "ask",
        "cancel",
        "retry",
        "answer",
        "pause",
        "resume",
        "create_member",
        "update_member",
        "accounts",
        "assign_account",
    ],
    project_id: Annotated[
        str | None,
        Field(
            description="members, usage, accounts, approvals, docs_jobs, create_member."
        ),
    ] = None,
    member_id: Annotated[
        str | None,
        Field(
            description="AI member: member, ask, pause, resume, update_member, assign_account."
        ),
    ] = None,
    account_id: Annotated[
        str | None,
        Field(description="assign_account: id, or none."),
    ] = None,
    ticket_id: Annotated[str | None, Field(description="ask, runs: IAM-12.")] = None,
    page_id: Annotated[str | None, Field(description="ask in Docs, docs_jobs.")] = None,
    thread_id: Annotated[
        str | None, Field(description="ask in Docs: a thread.")
    ] = None,
    run_id: Annotated[
        str | None, Field(description="run, cancel, retry, answer.")
    ] = None,
    text: Annotated[
        str | None,
        Field(description="ask, answer: the message; cancel, pause: a reason."),
    ] = None,
    intent: Annotated[
        Literal["ask", "work", "notify"] | None,
        Field(description="ask: ask (default), work, notify."),
    ] = None,
    range: Annotated[
        Literal["today", "7d", "month"] | None,
        Field(description="usage (default month)."),
    ] = None,
    status: Annotated[
        str | None, Field(description="approvals: pending, approved, denied.")
    ] = None,
    active_only: Annotated[
        bool | None, Field(description="runs: only queued or running.")
    ] = None,
    limit: Annotated[
        int | None,
        Field(ge=1, le=100, description="Rows (run: steps)."),
    ] = None,
    fields: Annotated[
        dict[str, Any] | None,
        Field(
            description="create/update_member: name, description, persona, template, ceiling none..review, "
            "max_parallel, max_runs_per_day, model; create: provider; update: daily_budget, monthly_cap, "
            "tokens_per_day, cap_per_run."
        ),
    ] = None,
) -> dict | list:
    """The board's AI team. Read: members, member, usage, runs, run, approvals, docs_jobs, accounts (separate logins;
    only a person signs in). Act: assign_account; ask wakes an AI (an @mention in a posted comment does not);
    cancel, retry, answer a run; pause, resume a member; create_member, update_member (never keys, folders or
    Bypass). Refused inside an AI run."""
    from services.ai import guard

    ctx = await guard.resolve()
    if action not in READS and ctx is not None:
        raise ValueError(
            "An AI run cannot start AIs or change AI members or runs; a person does."
        )
    op = AI_TEAM_OPS.get(action)
    if (
        project_id is None
        and ctx is not None
        and op is not None
        and "project_id" in (*op.required, *op.optional)
    ):
        project_id = ctx.project_id  # inside a run the project is known
    given = params_of(
        {k: v for k, v in locals().items() if k not in ("guard", "ctx", "op")}
    )
    return await dispatch("ai_team", AI_TEAM_OPS, action, given)
