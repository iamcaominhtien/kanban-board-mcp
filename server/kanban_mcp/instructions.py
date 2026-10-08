"""The usage instructions the server sends to the agent on connect."""

from .settings import ideas_enabled


_INSTRUCTIONS_HEAD = """\
Kanban board for software projects. Typical flow: get_projects -> list_tickets -> get_ticket -> \
manage_ticket(update, status='in-progress') -> keep ticket_items (work_log = debug journal, comment) updated while you work -> \
ticket_items (test_case, criterion) -> manage_ticket(update, status='done').

Tools: each write tool covers one area and takes an `action` (ticket_items also an `item`); its description lists the \
parameters every action takes, and a wrong call is answered with what that action accepts.
- get_projects, list_tickets, get_ticket, docs_read: read only.
- manage_project (projects, members), manage_ticket (tickets, blocks, links, workspace), ticket_items (comments, work log, \
acceptance criteria, sub-tasks, test cases), ticket_branches (git branches), docs_write.

Concepts
- Project: has a UUID `id` and a `prefix`. Ticket: id 'PREFIX-N' (e.g. 'IAM-12'); statuses backlog, todo, in-progress, \
review, testing, done, wont_do. A ticket owns acceptance criteria, sub-tasks (checklist steps), test cases, comments, a work log, branches and \
relations (blocks / links); sub-items are addressed by the UUIDs (or test-case code / branch name) shown in get_ticket.
"""
_INSTRUCTIONS_IDEAS = """\
- Idea Space is separate: ideas have ids 'IDEA-N' and can be promoted to a ticket once approved.
"""
_INSTRUCTIONS_TAIL = """\
- Docs: each project has a page tree of Markdown pages: read with docs_read (list, get, search, versions, ...), write with \
docs_write (create, update, move, ...). Send the `version` you read as base_version when updating; a stale one is rejected, \
so re-read and retry. Link pages with [[Title#Section]] and tickets by key (IAM-12).
- Each ticket has a scratch folder: manage_ticket(action='workspace'), then use your own file tools there.

Conventions
- Failures come back as tool errors whose message says how to fix the call; read it and retry.
- Tools that change a ticket return it without its activity log; get_ticket returns the 10 most recent activity entries (activity_limit / activity_since narrow or widen that; activity_limit=-1 gives all).
- Omitted optional arguments mean "unchanged". To empty a field use manage_ticket's clear_fields{ideas_null}.
- Text fields are Markdown. Dates are ISO 'YYYY-MM-DD'.
- File attachments and images use standard root-relative path '/uploads/{{filename}}' (e.g. '[report.pdf](/uploads/report.pdf)' or '![screenshot](/uploads/screenshot.png)'). Optional image width: '![screenshot|640px](/uploads/screenshot.png)'.
- Everything you change is attributed to the AI agent in the board's Activity tab; humans watch it live.
- Every `delete` is permanent; prefer status 'wont_do'{ideas_drop} to retire tickets.
"""


def build_instructions(include_ideas: bool | None = None) -> str:
    """The server instructions sent on connect (they only mention the Idea Space when its tools are exposed)."""
    if include_ideas is None:
        include_ideas = ideas_enabled()
    tail = _INSTRUCTIONS_TAIL.format(
        ideas_null=" (idea tools: explicit null)" if include_ideas else "",
        ideas_drop=" / idea status 'dropped'" if include_ideas else "",
    )
    return _INSTRUCTIONS_HEAD + (_INSTRUCTIONS_IDEAS if include_ideas else "") + tail


MCP_INSTRUCTIONS = build_instructions()
