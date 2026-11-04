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
_HANDOFF = {
    "type": "object",
    "properties": {
        "done": {"type": "string"},
        "where": {"type": "string"},
        "left": {"type": "string"},
        "check": {"type": "string"},
    },
}
_LEARNED = {
    "type": "object",
    "properties": {
        "text": {"type": "string"},
        "scope": {"type": "string", "enum": ["role", "ticket"]},
        "kind": {"type": "string", "enum": ["learned", "feedback"]},
    },
    "required": ["text"],
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


def _learned_schema(schema: dict) -> None:
    _spell_out(schema, _LEARNED, array=True)


def _tests_schema(schema: dict) -> None:
    _spell_out(schema, _TESTS, array=False)


def _handoff_schema(schema: dict) -> None:
    _spell_out(schema, _HANDOFF, array=False)


async def ai_run(
    action: Literal["ask", "report", "handoff", "contact", "team", "decide", "answer"],
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
    handoff: Annotated[
        dict | None,
        Field(
            description="report, handoff: your handoff note; the next role reads it first.",
            json_schema_extra=_handoff_schema,
        ),
    ] = None,
    learned: Annotated[
        list[dict] | None,
        Field(
            description="report: what the next run must not pay for again; kept as notes.",
            json_schema_extra=_learned_schema,
        ),
    ] = None,
    ticket_id: Annotated[
        str | None,
        Field(description="Ignored: the run's ticket is used."),
    ] = None,
    member: Annotated[
        str | None, Field(description="handoff, contact: teammate AI's exact name.")
    ] = None,
    ticket: Annotated[
        str | None,
        Field(description="handoff, contact, team: ticket key (default this one)."),
    ] = None,
    instruction: Annotated[
        str | None,
        Field(
            description="handoff: what to do. contact: your question. decide: reason. answer: the answer."
        ),
    ] = None,
    request: Annotated[
        str | None, Field(description="decide/answer: the id given in your brief.")
    ] = None,
    approve: Annotated[bool | None, Field(description="decide: yes or no.")] = None,
) -> dict:
    """Only inside a run the board started. ask: question the person you act for, then stop; the board resumes you
    with the answer. report: record your summary and your handoff note before the final message. handoff: assign a
    ticket to a teammate AI and queue their work run, with your handoff note. contact: ask a teammate AI; the answer
    comes back. team: who does what now. decide/answer: only in an Autopilot brief, for the person's pending requests."""
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
    if action in ("contact", "team"):
        from services.ai import awareness

        if action == "team":
            return await awareness.team_for_run(ctx, ticket)
        return await awareness.contact(ctx, member or "", ticket, instruction or "")
    if action == "handoff":
        return await runs.record_handoff(
            ctx, member or "", ticket, instruction or "", note=handoff
        )
    return await runs.record_report(
        ctx, summary or "", criteria, tests, learned, handoff=handoff
    )
