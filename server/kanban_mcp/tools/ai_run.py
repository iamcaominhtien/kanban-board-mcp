"""The run tool: lets an AI member started by the board ask its person a question, report what it did or hand a ticket
to a teammate AI."""

from typing import Annotated, Literal

from pydantic import Field

_CRITERION = {
    "type": "object",
    "properties": {
        "text": {"type": "string"},
        "met": {"type": "boolean"},
        "evidence": {"type": "string"},
    },
    "required": ["text", "met"],
}
_TESTS = {
    "type": "object",
    "properties": {"passed": {"type": "integer"}, "failed": {"type": "integer"}},
}


def _spell_out(schema: dict, shape: dict, *, array: bool) -> None:
    """Put the fields of an object in the tool's JSON schema. A bare "object" gives some CLIs (Antigravity) nothing to
    build, and they send nulls instead."""
    for branch in schema.get("anyOf", [schema]):
        if array and branch.get("type") == "array":
            branch["items"] = shape
        elif not array and branch.get("type") == "object":
            branch.update(shape)


def _criteria_schema(schema: dict) -> None:
    _spell_out(schema, _CRITERION, array=True)


def _tests_schema(schema: dict) -> None:
    _spell_out(schema, _TESTS, array=False)


async def ai_run(
    action: Literal["ask", "report", "handoff", "decide", "answer"],
    question: Annotated[str | None, Field(description="ask: the question.")] = None,
    options: Annotated[
        list[str] | None, Field(description="ask: short choices.")
    ] = None,
    summary: Annotated[str | None, Field(description="report: what you did.")] = None,
    criteria: Annotated[
        list[dict] | None,
        Field(
            description="report: one per acceptance criterion.",
            json_schema_extra=_criteria_schema,
        ),
    ] = None,
    tests: Annotated[
        dict | None,
        Field(
            description="report: test counts.",
            json_schema_extra=_tests_schema,
        ),
    ] = None,
    ticket_id: Annotated[
        str | None,
        Field(description="Ignored: the run's ticket is used."),
    ] = None,
    member: Annotated[
        str | None, Field(description="handoff: teammate AI's exact name.")
    ] = None,
    ticket: Annotated[
        str | None, Field(description="handoff: ticket key (default this one).")
    ] = None,
    instruction: Annotated[
        str | None,
        Field(description="handoff: what to do. decide: reason. answer: the answer."),
    ] = None,
    request: Annotated[
        str | None, Field(description="decide/answer: the id given in your brief.")
    ] = None,
    approve: Annotated[bool | None, Field(description="decide: yes or no.")] = None,
) -> dict:
    """Only inside a run the board started. ask: question the person you act for, then stop; the board resumes you
    with the answer. report: record your summary before the final message. handoff: assign a ticket to a teammate AI
    and queue their work run. decide/answer: only in an Autopilot brief, for the person's pending requests."""
    from services.ai import guard, runs

    ctx = await guard.resolve()
    if ctx is None:
        raise ValueError(
            "ai_run only works inside a run the board started for an AI member."
        )
    if action == "ask":
        return await runs.record_question(ctx, question or "", options)
    if action in ("decide", "answer"):
        from services.ai import autopilot

        try:
            if action == "decide":
                return await autopilot.decide(
                    ctx, request or "", bool(approve), instruction
                )
            return await autopilot.answer(ctx, request or "", instruction or "")
        except autopilot.AutopilotError as exc:
            raise ValueError(str(exc)) from exc
    if action == "handoff":
        return await runs.record_handoff(ctx, member or "", ticket, instruction or "")
    return await runs.record_report(ctx, summary or "", criteria, tests)
