"""The run tool: lets an AI member started by the board ask its person a question, report what it did or hand a ticket
to a teammate AI."""

from typing import Annotated, Literal

from pydantic import Field


async def ai_run(
    action: Literal["ask", "report", "handoff"],
    question: Annotated[str | None, Field(description="ask: the question.")] = None,
    options: Annotated[
        list[str] | None, Field(description="ask: short choices.")
    ] = None,
    summary: Annotated[str | None, Field(description="report: what you did.")] = None,
    criteria: Annotated[
        list[dict] | None, Field(description="report: [{text, met, evidence}].")
    ] = None,
    tests: Annotated[
        dict | None, Field(description="report: {passed, failed}.")
    ] = None,
    member: Annotated[
        str | None, Field(description="handoff: teammate AI's exact name.")
    ] = None,
    ticket: Annotated[
        str | None, Field(description="handoff: ticket key (default this one).")
    ] = None,
    instruction: Annotated[
        str | None, Field(description="handoff: what to do.")
    ] = None,
) -> dict:
    """Only inside a run the board started. ask: question the person you act for, then stop; the board resumes you
    with the answer. report: record your summary before the final message. handoff: assign a ticket to a teammate AI
    and queue their work run."""
    from services.ai import guard, runs

    ctx = await guard.resolve()
    if ctx is None:
        raise ValueError(
            "ai_run only works inside a run the board started for an AI member."
        )
    if action == "ask":
        return await runs.record_question(ctx, question or "", options)
    if action == "handoff":
        return await runs.record_handoff(ctx, member or "", ticket, instruction or "")
    return await runs.record_report(ctx, summary or "", criteria, tests)
