"""The usage instructions the server sends to the agent on connect."""

from .settings import ideas_enabled


_INSTRUCTIONS_HEAD = """\
Kanban board for software projects. Typical flow: get_projects -> list_tickets -> get_ticket -> \
manage_ticket(update, status='in-progress') -> keep ticket_items (work_log = debug journal, comment) updated while you work -> \
ticket_items (test_case, criterion) -> manage_ticket(update, status='done'). To have the board's AI team do the work \
instead, see "AI team" below.

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
- Which drawing: how a screen or page looks (its states, a click-through) goes on a Canvas; boxes and arrows a team will edit \
(a user flow's steps and decisions, who does what, a sequence, states, architecture, a data model, a plan) is a draw.io Diagram in the \
Docs page or ticket it explains; a Sketch is a person's hand drawing: read it, never draw one. "The sign-up flow and its screens" is both: \
the flow as a Diagram, the screens on a Canvas. Draw when words alone are hard to follow; a picture sits beside the words, never instead.
- Diagrams show in any text as one line `[Name](diagram:dg_xxxxxxxx)`. docs_read(diagram) reads one as a model (shapes, links, \
labels, boxes, problems); with `path` it also writes the .drawio XML to edit with your own file tools; docs_write(diagram_save) stores it \
(the `version` you read as base_version), docs_write(diagram_create) makes one from a file: put the returned `markdown` line on its own line \
in the text. Before you draw or change one, load the `drawio-diagrams` skill in Claude Code, else docs_read(diagram_guide).
- Sketches show as `![Name](sketch:sk_xxxxxxxx)`; keep that line as it is. docs_read(sketch) writes its PNG and layers (.sketch.json); \
what to do with one: the `sketches` skill, else docs_read(diagram_guide).
- Look before you hand in: docs_read(picture) writes a PNG of a diagram, a frame (canvas_id + board_id) or a local .drawio, .html or \
frame folder, and returns `markdown` (a copy on the board) for a comment.
- Canvases: boards (HTML pages, pictures, Sketches, Diagrams) with notes and comments on one plane show in a text as one line `![Name](canvas:cv_xxxxxxxx)`; keep that line as it is. \
docs_read(canvases) lists them, docs_read(canvas, canvas_id) reads frames, notes, arrows and comments (add board_id for a frame's source). \
docs_write(canvas_create) makes a canvas from a folder of web pages (a sub-folder with an index.html per frame, optional frame.json for name and size) \
or adds frames to one, and returns the `markdown` line to put in the text; frames are open web pages (scripts, CDN links and fonts run). \
Write frames responsive: a canvas switches a frame between Desktop (1280), Tablet (820) and Phone (390) by redrawing the same page at that width, \
so use `<meta name="viewport" content="width=device-width, initial-scale=1">`, fluid widths (%, flex, grid, max-width) and media queries \
(`@media (max-width: 820px)`), not fixed pixel layouts; set frame.json size to the width the frame is mainly for. Before you design or change a frame, load the whole design guide: the `canvas-design` skill in Claude Code, \
else docs_read(design_guide); follow it. \
You never change an existing frame directly: docs_write(canvas_comment) comments under your own name and docs_write(canvas_propose) offers a changed HTML frame \
from a folder; a person sees before and after and accepts or rejects. You never take the lock on a frame a person is editing.
- AI team. Outside an AI run you act for the person: before you hand work over, read ai_team(action='guide'). ai_team(members) shows each AI's role (pm, ba, designer, dev, qa, user_tester, reviewer, triage) and state. Pick by what you want: an answer or a review, nothing changed: ai_team(ask, member_id, text, ticket_id) (it answers in a comment); one AI to do one ticket: the same with intent='work' (it takes the ticket; one work run per ticket); a heads-up, no run: intent='notify'; several roles on one ticket: ai_team(start_workflow, ticket_id, workflow); a goal bigger than one ticket: ai_team(give_story): the PM plans it and the board runs it. Do not chain asks and assignments yourself for that. An @mention you write in a comment does NOT wake an AI. Inside an AI run it is the other way round: ai_team allows only its reads there, an @mention of another AI in a comment you post does wake it (one question, within the board's chain limits), and ai_run(action='handoff') passes the work on. An AI's question to the person: ai_team(answer). Permission requests are decided by a person in the board, never over MCP (resources needs the member's Resource tools set to View; restart and cancel need Control).
- Each ticket has a scratch folder: manage_ticket(action='workspace'), then use your own file tools there.
- Before you work on a ticket, read docs_read(guides) once: how to work a ticket here (report only what is true, show proof, ask, brainstorm, check as the user would, office files).

Working a ticket (the same rules every AI on the board follows)
{core_rules}

Conventions
- Failures come back as tool errors whose message says how to fix the call; read it and retry. A refusal starts with BLOCKED and ends with `Instead:`: do that, never retry it; docs_read(permissions_guide) says what you may do and what needs a person.
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
    from services import shared_skills

    # an outside agent skipped a mention of the guides three times, even one in get_ticket's result: the few rules
    # that matter most ride here, as they ride in every board run's prompt (issue #277)
    tail = _INSTRUCTIONS_TAIL.format(
        ideas_null="",
        core_rules="\n".join(f"- {r}" for r in shared_skills.CORE_RULES),
    )
    # The canvas design guide is too long to ride here (Claude Code keeps the first 10,000 characters of a server's
    # instructions and drops the rest): it is the canvas-design skill in every Claude Code run, and docs_read
    # (design_guide) for any other agent.
    return _INSTRUCTIONS_HEAD + (_INSTRUCTIONS_IDEAS if include_ideas else "") + tail


MCP_INSTRUCTIONS = build_instructions()
