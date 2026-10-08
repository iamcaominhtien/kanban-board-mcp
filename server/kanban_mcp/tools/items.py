"""The tool for the lists inside a ticket: comments, work log, acceptance criteria, sub-tasks, test cases."""

from .routing import Op, params_of, route
from pydantic import Field
from typing import Annotated, Literal
from .. import operations as ops
from ..common import TestCaseStatus, TicketId, WorkLogKind, WorkLogRole


ItemId = Annotated[
    str | None,
    Field(
        description="Id of the existing sub-item: comment / work log entry / criterion / sub-task id (UUID) or test case "
        "id or code 'TC-2', all listed in get_ticket."
    ),
]

ItemKind = Literal["comment", "work_log", "criterion", "sub_task", "test_case"]
ItemAction = Literal["add", "update", "delete", "toggle", "restore"]

_TEST_CASE_FIELDS = (
    "status",
    "description",
    "expected_result",
    "notes",
    "proof",
    "assignee",
)

ITEM_OPS: dict[tuple[str, str], Op] = {
    ("comment", "add"): Op(ops.add_comment, ("ticket_id", "text", "author")),
    ("comment", "update"): Op(
        ops.update_comment,
        ("ticket_id", "item_id", "text"),
        rename={"item_id": "comment_id"},
    ),
    ("comment", "delete"): Op(
        ops.delete_comment, ("ticket_id", "item_id"), rename={"item_id": "comment_id"}
    ),
    ("comment", "restore"): Op(
        ops.restore_comment, ("ticket_id", "item_id"), rename={"item_id": "comment_id"}
    ),
    ("work_log", "add"): Op(
        ops.add_work_log,
        ("ticket_id", "author", "role", "note"),
        ("log_kind", "pinned", "linked_branch", "linked_test_case"),
        rename={"log_kind": "kind"},
    ),
    ("work_log", "update"): Op(
        ops.update_work_log,
        ("ticket_id", "item_id"),
        ("note", "log_kind", "pinned", "linked_branch", "linked_test_case"),
        rename={"item_id": "log_id", "log_kind": "kind"},
    ),
    ("work_log", "delete"): Op(
        ops.delete_work_log, ("ticket_id", "item_id"), rename={"item_id": "log_id"}
    ),
    ("criterion", "add"): Op(
        ops.add_acceptance_criterion,
        ("ticket_id", "text"),
        rename={"text": "description"},
    ),
    ("criterion", "toggle"): Op(
        ops.toggle_acceptance_criterion,
        ("ticket_id", "item_id"),
        rename={"item_id": "criterion_id"},
    ),
    ("criterion", "delete"): Op(
        ops.delete_acceptance_criterion,
        ("ticket_id", "item_id"),
        rename={"item_id": "criterion_id"},
    ),
    ("sub_task", "add"): Op(ops.add_sub_task, ("ticket_id", "text")),
    ("sub_task", "toggle"): Op(
        ops.toggle_sub_task, ("ticket_id", "item_id"), rename={"item_id": "sub_task_id"}
    ),
    ("sub_task", "delete"): Op(
        ops.delete_sub_task, ("ticket_id", "item_id"), rename={"item_id": "sub_task_id"}
    ),
    ("test_case", "add"): Op(
        ops.add_test_case, ("ticket_id", "title"), _TEST_CASE_FIELDS
    ),
    ("test_case", "update"): Op(
        ops.update_test_case,
        ("ticket_id", "item_id"),
        ("title",) + _TEST_CASE_FIELDS,
        rename={"item_id": "test_case_id"},
    ),
    ("test_case", "delete"): Op(
        ops.delete_test_case,
        ("ticket_id", "item_id"),
        rename={"item_id": "test_case_id"},
    ),
}


def _item_op(item: str, action: str) -> Op:
    op = ITEM_OPS.get((item, action))
    if op is None:
        valid = ", ".join(a for (i, a) in ITEM_OPS if i == item)
        raise ValueError(
            f"ticket_items: a {item} cannot be '{action}'. Valid actions for {item}: {valid}."
        )
    return op


async def ticket_items(
    ticket_id: TicketId,
    item: Annotated[
        ItemKind, Field(description="Which list of the ticket to work on.")
    ],
    action: Annotated[
        ItemAction,
        Field(
            description="add, update, delete, toggle (criterion, sub_task) or restore (comment)."
        ),
    ],
    item_id: ItemId = None,
    text: Annotated[
        str | None,
        Field(
            description="comment: Markdown, max 50,000 chars. criterion: one checkable condition, max 1,000 chars (e.g. 'Login fails with a clear message on a wrong password'). sub_task: one small step, max 500 chars."
        ),
    ] = None,
    author: Annotated[
        str | None,
        Field(
            description="comment, work_log (add): who wrote it; use your agent name (e.g. 'Claude')."
        ),
    ] = None,
    role: Annotated[
        WorkLogRole | None,
        Field(description="work_log add: the author's role on this work."),
    ] = None,
    note: Annotated[
        str | None,
        Field(
            description="work_log: Markdown, max 20,000 chars. On update it replaces the old note."
        ),
    ] = None,
    log_kind: Annotated[
        WorkLogKind | None,
        Field(
            description="work_log: investigation (default; what you looked at), fix_attempt (something you tried), root_cause (the cause you found), blocked (stuck; shows a red dot), resolved (the problem is fixed)."
        ),
    ] = None,
    pinned: Annotated[
        bool | None,
        Field(description="work_log: keep this entry at the top of the list."),
    ] = None,
    linked_branch: Annotated[
        str | None,
        Field(
            description="work_log: NAME of an existing branch of this ticket; on update '' removes the link."
        ),
    ] = None,
    linked_test_case: Annotated[
        str | None,
        Field(
            description="work_log: code ('TC-2') or id of an existing test case; on update '' removes the link."
        ),
    ] = None,
    title: Annotated[
        str | None,
        Field(description="test_case: what is being verified (max 300 chars)."),
    ] = None,
    status: Annotated[
        TestCaseStatus | None,
        Field(
            description="test_case: pending (default, not run), running (starts its timer), pass or fail. Set pass/fail after running it."
        ),
    ] = None,
    description: Annotated[
        str | None, Field(description="test_case: Markdown steps / setup.")
    ] = None,
    expected_result: Annotated[
        str | None, Field(description="test_case: Markdown, what should happen.")
    ] = None,
    notes: Annotated[
        str | None, Field(description="test_case: Markdown observations.")
    ] = None,
    proof: Annotated[
        str | None,
        Field(
            description="test_case: evidence such as a log excerpt, URL or file path."
        ),
    ] = None,
    assignee: Annotated[
        str | None,
        Field(
            description="test_case: member id (UUID) who runs it; see get_projects(project_id)."
        ),
    ] = None,
) -> dict:
    """Work on the lists inside a ticket. Pick `item`, then `action`; each combination takes only the parameters shown.
    Returns the updated ticket (without its activity log); new sub-item ids are in its lists.
    - comment: add (text, author): progress reports, findings, questions for the humans | update (item_id, text) | delete (item_id; hidden everywhere) | restore (item_id; brings a deleted one back).
    - work_log, the ticket's debug journal (Debug Space tab): keep a running record of what you investigated, tried and found so humans and later sessions can follow. add (author, role, note [, log_kind, pinned, linked_branch, linked_test_case]) | update (item_id [, note, log_kind, pinned, linked_branch, linked_test_case]; to record a fix add a new 'resolved' entry rather than editing an old one) | delete (item_id, permanent).
    - criterion, acceptance criteria (the ticket's definition of done): add (text) | toggle (item_id; flips done/not done, see `acceptance_criteria[].done` in the result) | delete (item_id).
    - sub_task, small checklist steps inside the ticket (not tickets; for real child tickets use manage_ticket with parent_id): add (text) | toggle (item_id) | delete (item_id).
    - test_case: add (title [, status, description, expected_result, notes, proof, assignee]) gets a code 'TC-<n>' | update (item_id [, same fields + title]; typically status and proof after running it) | delete (item_id). With the ticket's 'Done requires: all test cases passed' guard on, it cannot move to 'done' until every test case is 'pass'."""
    given = params_of(locals())
    op = _item_op(item, action)
    return await route(f"ticket_items(item='{item}', action='{action}')", op, given)
