"""Ticket test cases."""

from typing import Annotated

import services.proofs as svc_proofs
import services.tickets as svc_tickets
from pydantic import Field
from .. import common
from ..common import (
    TestCaseRef,
    TestCaseStatus,
    TicketId,
    _edit_ticket,
    notify_on_success,
)

_PROOF_HELP = (
    "Markdown evidence for the result: a screenshot as ![what it shows](qa/evidence/TC-1.png) (a path from the "
    "working folder, the file must exist; the board keeps a copy and shows it on the ticket), the command you ran "
    "and its output in a ``` block, links. If it cannot be shown, write 'Not provable: <why>' instead of inventing one."
)


async def _localized(
    proof: str | None, notes: str | None
) -> tuple[str | None, str | None]:
    """proof and notes with the pictures named by a path copied into the board (services/proofs.py)."""
    if "](" not in (proof or "") + (notes or ""):
        return proof, notes
    folder = await common.run_folder()
    return svc_proofs.localize(proof, folder), svc_proofs.localize(notes, folder)


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
    proof: Annotated[str | None, Field(description=_PROOF_HELP)] = None,
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
    proof, notes = await _localized(proof, notes)
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
    proof: Annotated[str | None, Field(description=_PROOF_HELP)] = None,
    note: Annotated[
        str | None, Field(description="Deprecated alias of `notes`; use `notes`.")
    ] = None,
    assignee: Annotated[str | None, Field(description="Member id (UUID).")] = None,
) -> dict:
    """Update a test case, typically its `status` after running it (and `proof`). Omitted fields are unchanged.
    Returns the updated ticket."""
    proof, notes = await _localized(proof, notes)
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
