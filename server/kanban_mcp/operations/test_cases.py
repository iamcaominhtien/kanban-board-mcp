"""Ticket test cases."""

import services.tickets as svc_tickets
from pydantic import Field
from typing import Annotated
from ..common import (
    TestCaseRef,
    TestCaseStatus,
    TicketId,
    _edit_ticket,
    notify_on_success,
)


@notify_on_success
async def add_test_case(
    ticket_id: TicketId,
    title: Annotated[str, Field(description="What is being verified (max 300 chars).")],
    status: Annotated[
        TestCaseStatus, Field(description="pending (not run), running, pass or fail.")
    ] = "pending",
    description: Annotated[
        str | None, Field(description="Markdown: steps / setup.")
    ] = None,
    expected_result: Annotated[
        str | None, Field(description="Markdown: what should happen.")
    ] = None,
    notes: Annotated[str | None, Field(description="Markdown: observations.")] = None,
    proof: Annotated[
        str | None,
        Field(description="Evidence such as a log excerpt, URL or file path."),
    ] = None,
    note: Annotated[
        str | None, Field(description="Deprecated alias of `notes`; use `notes`.")
    ] = None,
    assignee: Annotated[
        str | None, Field(description="Member id (UUID) who runs it; see list_members.")
    ] = None,
) -> dict:
    """Add a test case to a ticket to track verification. It gets a code 'TC-<n>' (shown in the returned `test_cases`).
    With the ticket's "Done requires: all test cases passed" guard on, the ticket cannot move to 'done' until every
    test case has status 'pass'. Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s: svc_tickets.add_test_case(
            s,
            ticket_id,
            title=title,
            status=status,
            proof=proof,
            note=note,
            description=description,
            expected_result=expected_result,
            notes=notes,
            assignee=assignee,
        ),
    )


@notify_on_success
async def update_test_case(
    ticket_id: TicketId,
    test_case_id: TestCaseRef,
    title: str | None = None,
    status: Annotated[
        TestCaseStatus | None,
        Field(
            description="Set to 'pass' or 'fail' after running it; 'running' starts its timer."
        ),
    ] = None,
    description: str | None = None,
    expected_result: str | None = None,
    notes: str | None = None,
    proof: Annotated[
        str | None,
        Field(description="Evidence such as a log excerpt, URL or file path."),
    ] = None,
    note: Annotated[
        str | None, Field(description="Deprecated alias of `notes`; use `notes`.")
    ] = None,
    assignee: Annotated[str | None, Field(description="Member id (UUID).")] = None,
) -> dict:
    """Update a test case, typically its `status` after running it (and `proof`). Omitted fields are unchanged.
    Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s, tid: svc_tickets.update_test_case(
            s,
            ticket_id,
            tid,
            title=title,
            status=status,
            proof=proof,
            note=note,
            description=description,
            expected_result=expected_result,
            notes=notes,
            assignee=assignee,
        ),
        ("test_case", test_case_id),
    )


@notify_on_success
async def delete_test_case(ticket_id: TicketId, test_case_id: TestCaseRef) -> dict:
    """Delete a test case permanently (its work-log links are not changed). Returns the updated ticket."""
    return await _edit_ticket(
        ticket_id,
        lambda s, tid: svc_tickets.delete_test_case(s, ticket_id, tid),
        ("test_case", test_case_id),
    )
