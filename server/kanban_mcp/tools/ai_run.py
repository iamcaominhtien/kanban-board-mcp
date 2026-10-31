"""The run tool: lets an AI member started by the board ask its person a question or report what it did."""

from typing import Annotated, Literal

from pydantic import Field

_CRITERION = {
    "type": "object",
    "properties": {
        "text": {"type": "string", "description": "The acceptance criterion."},
        "met": {"type": "boolean", "description": "Whether you met it."},
        "evidence": {"type": "string", "description": "What shows it."},
    },
    "required": ["text", "met"],
    "additionalProperties": True,
}
_TESTS = {
    "type": "object",
    "properties": {"passed": {"type": "integer"}, "failed": {"type": "integer"}},
    "additionalProperties": True,
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
    action: Literal["ask", "report"],
    question: Annotated[str | None, Field(description="ask: the question.")] = None,
    options: Annotated[
        list[str] | None, Field(description="ask: short choices.")
    ] = None,
    summary: Annotated[str | None, Field(description="report: what you did.")] = None,
    criteria: Annotated[
        list[dict] | None,
        Field(
            description="report: one {text, met, evidence} per acceptance criterion.",
            json_schema_extra=_criteria_schema,
        ),
    ] = None,
    tests: Annotated[
        dict | None,
        Field(
            description="report: {passed, failed} counts.",
            json_schema_extra=_tests_schema,
        ),
    ] = None,
    ticket_id: Annotated[
        str | None,
        Field(description="Not needed: the run's own ticket is used. Ignored."),
    ] = None,
) -> dict:
    """Only inside a run the board started for an AI member. ask: question the person you act for, then stop;
    the board resumes you with the answer. report: record your summary before the final message. Takes no ticket:
    it always acts on the ticket of the run."""
    from services.ai import guard, runs

    ctx = await guard.resolve()
    if ctx is None:
        raise ValueError(
            "ai_run only works inside a run the board started for an AI member."
        )
    if action == "ask":
        return await runs.record_question(ctx, question or "", options)
    return await runs.record_report(ctx, summary or "", criteria, tests)
