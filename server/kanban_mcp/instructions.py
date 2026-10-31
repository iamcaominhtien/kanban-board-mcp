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
acceptance criteria, sub-tasks, test cases), ticket_branches (git branches), docs_write, ai_team (AI members and runs), ai_schedules.

Concepts
- Project: has a UUID `id` and a `prefix`. Ticket: id 'PREFIX-N' (e.g. 'IAM-12'); statuses backlog, todo, in-progress, \
review, testing, done, wont_do. A ticket owns acceptance criteria, sub-tasks (checklist steps), test cases, comments, a work log, branches and \
relations (blocks / links); sub-items are addressed by the UUIDs (or test-case code / branch name) shown in get_ticket.
"""
_INSTRUCTIONS_IDEAS = """\
- Idea Space is separate: ideas have ids 'IDEA-N'. You can read ideas and their assumptions, and suggest a new one with create_idea_ticket (it lands in the Inbox for a person to sort); you cannot move, edit or promote ideas.
"""
_INSTRUCTIONS_TAIL = """\
- Docs: each project has a page tree of Markdown pages: read with docs_read (list, get, search, versions, ...), write with \
docs_write (create, update, move, ...). Send the `version` you read as base_version when updating; a stale one is rejected, \
so re-read and retry. Link pages with [[Title#Section]] and tickets by key (IAM-12). People comment on pages too: \
docs_read(comments) lists the threads, docs_write(comment, reply, resolve, ...) answers them.
- Diagrams: a draw.io drawing shows in any text (ticket description, comment, Docs page) as one line `[Name](diagram:dg_xxxxxxxx)`. \
Edit it as a file: docs_read(diagram) writes the .drawio XML to a path, change it with your own file tools, docs_write(diagram_save) \
stores it (with the `version` you got as base_version). docs_write(diagram_create) makes a new one from a file; put the returned \
`markdown` line on its own line in the text.
- Sketches: a freehand drawing shows in a text as one line `![Name](sketch:sk_xxxxxxxx)`; keep that line as it is when you edit the text. \
Work on one as files: docs_read(sketch) writes its PNG and editable .sketch.json (layers, at most 4096 px, 10 layers, 10 MB), \
docs_write(sketch_save) stores a new PNG (+ source) with the `version` you read as base_version; docs_write(sketch_create) makes a new one \
for a ticket or Docs page from a PNG (put the returned `markdown` line on its own line in the text).
- AI team: ai_team looks at the board's AI members (members, member, usage, runs, run, approvals, docs_jobs, resources: RAM and CPU of the running AIs and the machine) and acts on them \
(ask, cancel, restart (a run's CLI starts again in the same run), retry, answer, pause, resume, create_member, update_member). An @mention in a comment posted through MCP does NOT wake \
an AI: use ai_team(action='ask', member_id, text, ticket_id) (intent 'work' to assign it the ticket). Approvals are decided by a person \
in the board, never over MCP; inside an AI run only the read actions work (resources needs the member's Resource tools set to View; restart and cancel need Control).
- Each ticket has a scratch folder: manage_ticket(action='workspace'), then use your own file tools there.

Conventions
- Failures come back as tool errors whose message says how to fix the call; read it and retry.
- Tools that change a ticket return it without its activity log; get_ticket returns the 10 most recent activity entries (activity_limit / activity_since narrow or widen that; activity_limit=-1 gives all).
- Omitted optional arguments mean "unchanged". To empty a field use manage_ticket's clear_fields.
- Text fields are Markdown. Dates are ISO 'YYYY-MM-DD'.
- File attachments and images use standard root-relative path '/uploads/{{filename}}' (e.g. '[report.pdf](/uploads/report.pdf)' or '![screenshot](/uploads/screenshot.png)'). Optional image width: '![screenshot|640px](/uploads/screenshot.png)'.
- Everything you change is attributed to the AI agent in the board's Activity tab; humans watch it live.
- Every `delete` is permanent; prefer status 'wont_do' to retire tickets.
"""


def build_instructions(include_ideas: bool | None = None) -> str:
    """The server instructions sent on connect (they only mention the Idea Space when its tools are exposed)."""
    if include_ideas is None:
        include_ideas = ideas_enabled()
    tail = _INSTRUCTIONS_TAIL.format(
        ideas_null="",
    )
    return _INSTRUCTIONS_HEAD + (_INSTRUCTIONS_IDEAS if include_ideas else "") + tail


MCP_INSTRUCTIONS = build_instructions()
