"""The `ai_run` tool (AI v2): what a run started by the board does with the board beyond the ticket tools: ask a
person, send a note to another ticket's team or a Docs page, read its own team, record a report."""

from typing import Annotated, Any, Literal

from pydantic import Field


async def ai_run(
    action: Annotated[
        Literal["ask", "message", "team", "runs", "report"],
        Field(
            description="ask: a question for the person you work for (then stop). message: a note to a ticket's AI team or a Docs page. team: your team and its roles. runs: your team's runs. report: record a report early (the final JSON report is the usual way)."
        ),
    ],
    question: Annotated[
        str | None, Field(description="ask: the question, one paragraph.")
    ] = None,
    options: Annotated[
        list[Any] | None,
        Field(
            description="ask: up to 6 choices, strings or {label, description, recommended}."
        ),
    ] = None,
    to: Annotated[
        str | None,
        Field(description="message: a ticket key (IAM-12) or docs:<page id>."),
    ] = None,
    text: Annotated[
        str | None, Field(description="message: the note, Markdown.")
    ] = None,
    report: Annotated[
        dict[str, Any] | None,
        Field(
            description="report: {summary, status, branch, tests, open_items, lessons}."
        ),
    ] = None,
) -> dict:
    """Only inside an AI run the board started (its bearer token says which). ask parks the run until a person
    answers: say what you need and stop. message reaches a ticket's team live when its lead is running, else as its
    next turn; a Docs page's assistant answers in the page's thread."""
    from services.ai import guard, runs

    ctx = await guard.resolve()
    if ctx is None:
        raise ValueError(
            "ai_run is for a run the board started; you are not in one. Use the ticket tools directly."
        )
    if action == "ask":
        return await runs.record_question(ctx, question or "", options)
    if action == "message":
        target = (to or "").strip()
        body = (text or "").strip()
        if not target or not body:
            raise ValueError(
                "ai_run(action='message') needs `to` (a ticket key or docs:<page id>) and `text`."
            )
        if target.startswith("docs:"):
            from services.ai import messaging

            return await messaging.deliver_to_page(target[5:], body, by=ctx.member_name)
        if target == ctx.ticket_id:
            raise ValueError(
                "That is your own ticket: write a comment with ticket_items instead."
            )
        return await runs.deliver_to_ticket(target, body, by=ctx.member_name)
    if action == "team":
        from services.ai import teams

        async with __import__("database").async_session() as session:
            member, profile = await teams.get_profile(session, ctx.member_id)
            if member is None or profile is None:
                raise ValueError("Your team was not found.")
            desc = await teams.describe(session, member, profile)
        return {
            k: desc[k]
            for k in ("id", "name", "pack_key", "roles", "model", "effort", "status")
        }
    if action == "runs":
        import database
        from services.ai.store import active_runs

        async with database.async_session() as session:
            rows = await active_runs(session, member_id=ctx.member_id)
        return {
            "runs": [
                {
                    "id": r.id,
                    "ticket_id": r.ticket_id,
                    "state": r.state,
                    "number": r.number,
                }
                for r in rows
            ]
        }
    if action == "report":
        if not isinstance(report, dict):
            raise ValueError("ai_run(action='report') needs `report`.")
        return await runs.record_report(ctx, report)
    raise ValueError(f"Unknown action {action!r}.")
