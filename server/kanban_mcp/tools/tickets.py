"""The ticket tool: create, change, relate and delete tickets."""

from .routing import Op, dispatch, params_of
from pydantic import Field
from typing import Annotated, Literal
from .. import operations as ops
from ..common import Priority, RelationType, Status, TicketType


TicketAction = Literal[
    "create",
    "update",
    "delete",
    "workspace",
    "block",
    "unblock",
    "link",
    "unlink",
    "link_doc",
    "unlink_doc",
]

_TICKET_FIELDS = (
    "title",
    "description",
    "type",
    "priority",
    "status",
    "estimate",
    "due_date",
    "start_date",
    "parent_id",
    "tags",
    "assignee",
)

TICKET_OPS = {
    "create": Op(
        ops.create_ticket,
        ("project_id", "title"),
        tuple(f for f in _TICKET_FIELDS if f != "title"),
    ),
    "update": Op(
        ops.update_ticket,
        ("ticket_id",),
        _TICKET_FIELDS
        + (
            "repo_path",
            "wont_do_reason",
            "block_done_if_acs_incomplete",
            "block_done_if_tcs_incomplete",
            "clear_fields",
        ),
    ),
    "delete": Op(ops.delete_ticket, ("ticket_id",)),
    "workspace": Op(ops.get_ticket_workspace_path, ("ticket_id",)),
    "block": Op(
        ops.block_ticket,
        ("ticket_id", "target_id"),
        rename={"ticket_id": "blocked_id", "target_id": "blocker_id"},
    ),
    "unblock": Op(
        ops.unblock_ticket,
        ("ticket_id", "target_id"),
        rename={"ticket_id": "blocked_id", "target_id": "blocker_id"},
    ),
    "link": Op(ops.link_tickets, ("ticket_id", "target_id", "relation_type")),
    "unlink": Op(ops.unlink_tickets, ("ticket_id", "link_id")),
    "link_doc": Op(ops.link_ticket_doc, ("ticket_id", "page_id")),
    "unlink_doc": Op(ops.unlink_ticket_doc, ("ticket_id", "page_id")),
}


async def manage_ticket(
    action: Annotated[
        TicketAction, Field(description="What to do; see the tool description.")
    ],
    project_id: Annotated[
        str | None, Field(description="create: project UUID from get_projects.")
    ] = None,
    ticket_id: Annotated[
        str | None,
        Field(
            description="Ticket ID such as 'IAM-12' (not a UUID). Every action except create."
        ),
    ] = None,
    title: Annotated[
        str | None, Field(description="Short title (max 300 chars).")
    ] = None,
    description: Annotated[
        str | None,
        Field(
            description="Markdown: context, steps to reproduce, scope. On update it REPLACES the whole text: read it with get_ticket first if you only want to append."
        ),
    ] = None,
    type: Annotated[
        TicketType | None, Field(description="Kind of work (default 'task').")
    ] = None,
    priority: Annotated[Priority | None, Field(description="Default 'medium'.")] = None,
    status: Annotated[
        Status | None,
        Field(
            description="create: starting column (default 'backlog', not 'wont_do'). update: the move; 'done' is refused while the ticket's Done-requires guards are not met."
        ),
    ] = None,
    estimate: Annotated[
        float | None, Field(description="Story points, 0-100000.")
    ] = None,
    due_date: Annotated[str | None, Field(description="ISO date 'YYYY-MM-DD'.")] = None,
    start_date: Annotated[
        str | None,
        Field(description="ISO date 'YYYY-MM-DD'; must not be after due_date."),
    ] = None,
    parent_id: Annotated[
        str | None,
        Field(
            description="Make this a sub-ticket of this ticket ID (same project, one level deep: the parent must not itself be a child)."
        ),
    ] = None,
    tags: Annotated[
        list[str] | None,
        Field(
            description="Free-form labels (max 30, each up to 50 chars). On update it REPLACES the whole list."
        ),
    ] = None,
    assignee: Annotated[
        str | None,
        Field(
            description="Member id (UUID) of a member of the ticket's project; see get_projects(project_id)."
        ),
    ] = None,
    repo_path: Annotated[
        str | None,
        Field(
            description="update: absolute path of a git repo to use for THIS ticket's branches instead of the project's."
        ),
    ] = None,
    wont_do_reason: Annotated[
        str | None,
        Field(
            description="update: why it will not be done; required together with status='wont_do'."
        ),
    ] = None,
    block_done_if_acs_incomplete: Annotated[
        bool | None,
        Field(
            description="update: true refuses status 'done' until every acceptance criterion is checked."
        ),
    ] = None,
    block_done_if_tcs_incomplete: Annotated[
        bool | None,
        Field(
            description="update: true refuses status 'done' until there is a test case and all pass."
        ),
    ] = None,
    clear_fields: Annotated[
        list[
            Literal[
                "estimate",
                "due_date",
                "start_date",
                "parent_id",
                "assignee",
                "repo_path",
                "wont_do_reason",
            ]
        ]
        | None,
        Field(
            description="update: fields to EMPTY (e.g. unassign). Needed because omitting a field means 'leave unchanged'."
        ),
    ] = None,
    target_id: Annotated[
        str | None,
        Field(
            description="The other ticket's ID (same project): block/unblock: the ticket that must be finished first; link: the ticket to relate to."
        ),
    ] = None,
    relation_type: Annotated[
        RelationType | None,
        Field(
            description="link: how `ticket_id` relates to `target_id`; the inverse is added on the target automatically."
        ),
    ] = None,
    link_id: Annotated[
        str | None,
        Field(
            description="unlink: link id returned by `link` or listed in the `links` of get_ticket. A link has a different id on each of its two tickets: pass it with the ticket it belongs to."
        ),
    ] = None,
    page_id: Annotated[
        str | None,
        Field(
            description="link_doc / unlink_doc: Docs page id (UUID) from docs_read(action='list')."
        ),
    ] = None,
) -> dict:
    """Create, change, relate or delete a ticket (a ticket's checklists, comments, work log and branches have their own
    tools). `action`:
    - create: project_id, title [, description, type, priority, status, parent_id, estimate, due_date, start_date, tags, assignee]. The ID comes from the project prefix ('IAM-5'). With parent_id it is a sub-ticket. Returns the ticket.
    - update: ticket_id plus any fields to change; omitted fields are untouched, so a plain status move is just (ticket_id, status). To empty a nullable field name it in clear_fields. 'wont_do' needs wont_do_reason and is not allowed for sub-tickets. Also takes repo_path, block_done_if_acs_incomplete, block_done_if_tcs_incomplete. Returns the ticket.
    - delete: ticket_id. PERMANENT. Sub-tickets are detached and kept; block/link references to it are removed; its workspace folder is deleted. To retire a ticket but keep its history use update with status='wont_do'.
    - workspace: ticket_id. Gets (and creates if missing) the ticket's local scratch folder: {enabled, path, exists}. Read and write files there with your own file tools (logs, repro scripts, drafts); nothing goes through MCP. If `enabled` is false, do not use it.
    - block / unblock: ticket_id, target_id. ticket_id cannot proceed until target_id is done (it shows a lock on the board); same project, no circular chains, statuses do not change. Returns {blocker, blocked}.
    - link: ticket_id, target_id, relation_type. A non-blocking relation (use block for dependencies). Returns {id, target_id, relation_type}; keep `id` for unlink.
    - unlink: ticket_id, link_id. Removes the relation and its inverse. Returns {"removed": link_id}.
    - link_doc / unlink_doc: ticket_id, page_id. Manually link a Docs page to the ticket ('Linked docs')."""
    return await dispatch("manage_ticket", TICKET_OPS, action, params_of(locals()))
