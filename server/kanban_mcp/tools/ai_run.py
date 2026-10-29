"""The run tool: lets an AI member started by the board ask its person a question or report what it did."""

from typing import Annotated, Literal

from pydantic import Field


async def ai_run(
    action: Literal["ask", "report"],
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
) -> dict:
    """Only inside a run the board started for an AI member. ask: question the person you act for, then stop;
    the board resumes you with the answer. report: record your summary before the final message."""
    from services.ai import guard, runs

    ctx = await guard.resolve()
    if ctx is None:
        raise ValueError(
            "ai_run only works inside a run the board started for an AI member."
        )
    if action == "ask":
        return await runs.record_question(ctx, question or "", options)
    return await runs.record_report(ctx, summary or "", criteria, tests)
