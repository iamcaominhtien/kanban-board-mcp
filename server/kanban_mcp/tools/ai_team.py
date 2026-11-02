"""The AI team tool: look at the board's AI members, runs, cost and approvals; wake an AI; steer a run or a member."""

from typing import Annotated, Any, Literal

from pydantic import Field

from ..operations import ai_team as ops
from ..operations import ai_work as work
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
    "accounts": Op(ops.accounts, (), ("project_id",)),
    "assign_account": Op(ops.assign_account, ("member_id", "account_id")),
    "guide": Op(work.guide, ()),
    "workflows": Op(work.workflows, ("project_id",)),
    "workflow": Op(work.workflow, ("ticket_id",)),
    "start_workflow": Op(work.start_workflow, ("ticket_id", "workflow")),
    "stories": Op(work.stories, ("project_id",)),
    "story": Op(work.story, ("story_id",)),
    "give_story": Op(work.give_story, ("project_id", "text"), ("fields",)),
    "approve_plan": Op(work.approve_plan, ("story_id",)),
    "revise_plan": Op(work.revise_plan, ("story_id", "text")),
    "reject_plan": Op(work.reject_plan, ("story_id",), ("text",)),
    "decisions": Op(work.decisions, ("project_id",), ("story_id", "limit")),
    "override": Op(work.override, ("decision_id",), ("text",)),
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
    "accounts",
    "guide",
    "workflows",
    "workflow",
    "stories",
    "story",
    "decisions",
}
# Allowed inside an AI run when its member's "Resource tools" setting is Control (checked in the operation)
RUN_CONTROL = {"restart", "cancel"}
# Only exist for a member whose "Resource tools" setting is above None: an AI run without it gets "unknown action"
RESOURCE_ONLY = {"resources", "restart"}


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
        "accounts",
        "assign_account",
        "guide",
        "workflows",
        "workflow",
        "start_workflow",
        "stories",
        "story",
        "give_story",
        "approve_plan",
        "revise_plan",
        "reject_plan",
        "decisions",
        "override",
    ],
    project_id: Annotated[
        str | None,
        Field(
            description="members, usage, runs, accounts, approvals, docs_jobs, create_member."
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
    ticket_id: Annotated[
        str | None, Field(description="ask, runs, workflow, start_workflow: IAM-12.")
    ] = None,
    story_id: Annotated[
        str | None, Field(description="story, *_plan, decisions: the Story's key.")
    ] = None,
    workflow: Annotated[
        str | None, Field(description="start_workflow: a key from workflows.")
    ] = None,
    decision_id: Annotated[str | None, Field(description="override.")] = None,
    page_id: Annotated[str | None, Field(description="Docs: ask, docs_jobs.")] = None,
    thread_id: Annotated[str | None, Field(description="ask in Docs.")] = None,
    run_id: Annotated[
        str | None, Field(description="run, cancel, retry, answer.")
    ] = None,
    text: Annotated[
        str | None,
        Field(
            description="ask, answer: message; give_story: the goal; revise_plan: what to change; cancel, pause, "
            "reject_plan, override: why."
        ),
    ] = None,
    intent: Annotated[
        Literal["ask", "work", "notify"] | None,
        Field(
            description="ask: ask (default: answers in a comment, changes nothing), work (assigns the ticket and "
            "does it), notify (comment only, nothing runs)."
        ),
    ] = None,
    range: Annotated[
        Literal["today", "7d", "month"] | None,
        Field(description="usage (default month)."),
    ] = None,
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
            "mcp-client; update: daily_budget, monthly_cap, tokens_per_day, cap_per_run. give_story: title, criteria "
            "(list), approve person|pm, budget_tokens, hand. api: JSON body."
        ),
    ] = None,
) -> dict | list:
    """AI team. Read guide first: when to ask, hand over work, use a workflow or give a Story to the PM. Reads: members
    (with role), runs, usage, approvals, docs_jobs, resources, accounts, workflows, workflow, stories, story,
    decisions. Hand work:
    ask (wakes an AI; an @mention via MCP does not), start_workflow, give_story, approve/revise/reject_plan, override.
    Runs: cancel, restart, retry, answer. Members: pause, resume, create_member, update_member, assign_account (no
    keys, folders, Bypass, ceiling past Review; approvals are a person's, in the board). With "Full control over MCP":
    endpoints, api. Inside an AI run: reads only."""
    from services.ai import guard

    ctx = await guard.resolve()
    if (
        action in RESOURCE_ONLY
        and ctx is not None
        and await ops._resource_level() == "none"
    ):
        # the resource tools do not exist for this member
        valid = sorted(k for k in AI_TEAM_OPS if k not in RESOURCE_ONLY)
        raise ValueError(
            f"Unknown action '{action}'. Valid actions: {', '.join(valid)}."
        )
    if (
        action == "ask"
        and intent == "work"
        and ctx is not None
        and ticket_id
        and member_id
    ):
        # Issue #275, from a real day's log: a run that hands a ticket to a teammate this way was refused, though it
        # may do exactly that with ai_run(handoff). It goes the same way, with the same checks (an assignment)
        from services.ai import runs as ai_runs

        return await ai_runs.record_handoff(ctx, member_id, ticket_id, text or "")
    if action not in READS and ctx is not None:
        # inside an AI run only a member with the Resource tools set to Control may restart or stop runs
        if action not in RUN_CONTROL or await ops._resource_level() != "control":
            raise ValueError(
                "BLOCKED (ai_run_only): an AI run cannot start AIs or change AI members or runs; a person does. "
                "Instead: hand a ticket to a teammate with ai_run(action='handoff', member=<name>, ticket=<key>, "
                "instruction=...), ask a person with ai_run(action='ask'), or name in your report who should do "
                "what next."
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
