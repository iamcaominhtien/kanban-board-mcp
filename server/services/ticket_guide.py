"""The ticket guide: what a good ticket is and how every part of one is used, for any AI on the board (issue #269).

AIs used status and comments and little else: no criteria a tester could check, sub-tasks where a sub-ticket was
meant, no work log, evidence named in a sentence, and a PM that told a person a QA's files were "in the Workspace" that
had never been made. This guide is the `working-with-tickets` skill of the board's own plugin
(``services/ai/board_skills.py``, through ``services/shared_skills.py``) for Claude Code runs, and
``docs_read(action='ticket_guide')`` for any other agent: one text, a test checks both are the same.

``ON_TICKET`` is what each ready-made role leaves on a ticket; the line for a member's role rides in its run's prompt
(``services/ai/context.py``), the table is in the guide.
"""

NAME = "working-with-tickets"

DESCRIPTION = (
    "How to use every part of a ticket on this board: a title, description and acceptance criteria a person can "
    "check, when to use a sub-task, a sub-ticket, a Story, a block or a link, how to keep the work log, a comment read "
    "in ten seconds, test cases and attachments as evidence, where files go (the worktree for code, the Workspace for "
    "outputs), and what each role writes. Use when you create, split, update, hand over or close a ticket."
)

# What each ready-made role writes on a ticket (packs' keys, services/ai/packs.py)
ON_TICKET: dict[str, str] = {
    "triage": "the type, labels, workflow and review depth, and one comment saying why",
    "pm": "the split (sub-tickets with their criteria, blocks between them), the plan in a comment, your rulings "
    "as comments; before you tell a person where a file, branch or page is, open it and name the exact place",
    "ba": "acceptance criteria a tester can check (one per condition), a spec page linked with link_doc when design, "
    "build or test work from it, and the open questions in a comment",
    "designer": "the canvas line in the description or a comment, a spec per screen, and a picture of each screen",
    "dev": "the work log (plan, root cause, what you tried), the red and then green test run pasted in the work "
    "log, which criterion each part of the change meets, and a note for the reviewer",
    "reviewer": "findings, one per comment (must fix or suggestion, file:line, a concrete case), and the VERDICT line",
    "qa": "test cases from the criteria, each run with its status and proof (output or screenshot attached), each "
    "criterion ticked once its cases passed (ticket_items item='criterion' action='toggle'), a failure as steps "
    "anyone can repeat; your outputs in the Workspace, not the worktree",
    "user_tester": "one comment with the person's story, the steps and the screenshots in it, each problem as a "
    "test case or a comment",
    "tech_writer": "the page or file linked on the ticket and a note of which steps you tried",
    "devops": "what changed in CI or the environment, the command output that proves it, and what a person must "
    "switch on",
    "security": "each finding with its severity and proof (a local test, not committed), and the VERDICT line",
    "data_analyst": "the answer with its numbers in a comment, the chart attached, the script (committed, or in the "
    "Workspace) and the caveats",
}

_ROLE_TITLES = {
    "triage": "Triage",
    "pm": "PM",
    "ba": "BA",
    "designer": "Designer",
    "dev": "Dev",
    "reviewer": "Reviewer",
    "qa": "QA",
    "user_tester": "User tester",
    "tech_writer": "Technical writer",
    "devops": "DevOps",
    "security": "Security reviewer",
    "data_analyst": "Data analyst",
}


def _roles_table() -> str:
    rows = "\n".join(f"| {_ROLE_TITLES[k]} | {v} |" for k, v in ON_TICKET.items())
    return "| Role | Leaves on the ticket |\n|---|---|\n" + rows


GUIDE = (
    r"""# Working with tickets

A person judges a ticket in a glance: the title, the criteria ticked or not, the last comment, the pictures. Write
every part for that glance. The tools: `manage_ticket` (the ticket, its relations, its Workspace), `ticket_items`
(comments, work log, criteria, sub-tasks, test cases, attachments), `ticket_branches`, `get_ticket`.

## A good ticket
- **Title**: what changes, seen from outside, in the project's language, under about 70 characters. "Login: a wrong
  password shows no message", "Nhắc uống nước mỗi giờ". Not "Fix bug", not "Update file.py".
- **Description**: the first two lines say why (the problem, for whom) and what. Then what is in and what is out,
  and for a bug the steps, what happens and what should. Links to pages and tickets. Short paragraphs.
- **Acceptance criteria**: one condition each that a tester can check from outside, with the exact number or text
  when it matters. Good: "A wrong password shows «Sai mật khẩu» under the field and keeps the email". Bad: "Login
  works well". Give them when you create the ticket (`acceptance_criteria=[...]`): the AI team may take a new ticket at
  once. Usually 3 to 8; past 8, split.
- **Type and priority** say what it is (bug, feature, task, chore) and how urgent; tags only from the project's own.

## Sub-task, sub-ticket, Story, block or link?
| You have | Use | Why |
|---|---|---|
| Steps of one piece of work, one person, one go | sub-task (`ticket_items item='sub_task'`) | a checklist inside the ticket |
| A part someone else can do, or that ships and is tested on its own | sub-ticket (`manage_ticket create parent_id=`) | its own status, assignee and criteria; one level deep |
| A goal bigger than a few tickets | a Story (`type='story'`, then `ai_team(give_story)`) | the PM plans it and the board runs it |
| This cannot start or finish before another is done | block (`manage_ticket block`: `ticket_id` waits for `target_id`) | the board shows the lock and the waiting order |
| Related, same cause, or a duplicate | link (`relates_to`, `causes`, `duplicates`) | no lock |
| A Docs page that explains it | `manage_ticket link_doc` | shows on the ticket and on the page |

Split by outcome, not by layer: "export one month as CSV" is a sub-ticket, "the database part" is not. A blocked
ticket stays where it is until its blocker is done; the board does not refuse the move, so do not make it.

## The work log (Debug Space)
The ticket's journal for the next person and the next session: `ticket_items item='work_log'`.
- Log what matters: the plan (a few lines, before a long piece of work), what you looked at, what you tried
  (`fix_attempt`), the cause (`root_cause`), what blocks you (`blocked`: what you need, from whom), the fix
  (`resolved`). Not every command.
- Link the branch (`linked_branch`) and the test case (`linked_test_case`) an entry is about; pin the one to read
  first.
- `role`: PM, Developer, BA, Tester (QA, user tester), Designer, Other (reviewer, security, writer, DevOps, analyst).

## A comment a person reads in ten seconds
- **First line: the news.** Done, blocked, a question or a finding, with the one fact that matters.
- Then two to five bullets, then the links and pictures. Logs go in an attachment, not the comment.
- A question: `@Name`, one question, two to four options with your recommendation first.
- The project's language.

Good: "Done: reminders every hour 8:00–18:00, silent once the goal is met. TC-1 and TC-2 pass (output below). Left:
the notification permission, blocked by GIOT-4." Bad: "I have completed the implementation of the feature as
requested and all tests are passing."

## Evidence
- **Test cases** come from the criteria (`ticket_items item='test_case'`). After each run: its status and its proof,
  the command and its real output in a ``` block, or a screenshot; "Not provable: <why>" when it cannot be shown.
- **Attachments**: `ticket_items(item='attachment', path=..., text='what it shows')` posts the file in a comment, so
  it shows in the ticket's Attachments. In a board run, `path` is a path in your working folder; outside one, the
  file's absolute path. The result's `attached.markdown` puts the same file in a proof or the description. A picture
  or a document named that way in a comment, work log, proof or Docs page is attached too.
- **Tick a criterion** (`ticket_items item='criterion' action='toggle'`) only when it was checked, and say how. In a
  team the QA ticks them, once the cases that prove each one passed: a claim in a report ticks nothing on the ticket.

## Where files go
| What | Where |
|---|---|
| Code, tests, docs that ship | the worktree (or the repository), committed on the ticket's branch |
| Outputs a person should see: reports, screenshots, logs, exports, recordings | the ticket's **Workspace**, and the ones that prove a result also attached to the ticket |
| Scratch you will not need | delete it before you finish |

Two folders, often mixed up:
- The **Workspace** is a plain scratch folder per ticket (`~/kanban-workspace/<KEY>`), shown on the ticket's
  Workspace tab. It exists only once something makes it: a person opening it, `manage_ticket(action='workspace')`, or
  the board when a run starts (its path is then in the run's prompt).
- The **worktree** is the AI team's git checkout for the ticket (`<repo>.worktrees/<KEY>`, branch
  `ai/<KEY>-<slug>`), shared by Dev, Reviewer and QA one after another. It is removed only when nothing in it is
  uncommitted, so leave nothing loose there. When a run ends, the board moves the outputs it finds there to the
  Workspace (`from-worktree/<date>/`) and says so in the work log.

## Never claim without checking
Before you say a file, folder, branch, page or comment exists or is somewhere, look: list the folder, read
`get_ticket` (its `workspace`, `worktree`, `branches`, `files`), open the page. Then name the exact path or link.
"The report is in the Workspace" when the Workspace was never made is the mistake this rule is for. If you did not
look, say "not checked".

The same goes for a cause or a result, wherever you write it (a new ticket's description is the usual place): name
a file, function or line as the cause only after you have read it, and a result only after you have run it. If you
later find that something you wrote on the ticket is wrong, correct it there (the description, a criterion, a test
case), not only in a later work log or comment: the next person reads the description first.

## Closing a ticket
Done means: each criterion ticked (and how it was checked), the test cases passed with proof, the branch pushed or the
pull request open, and one closing comment (what is done, what is left, who waits on what). An AI member stops at
Review: a person moves it to Done. Work that will not be done: status `wont_do` with the reason.

Before you move a ticket to Review, say where the change is, so the next person can find it: the branch and commit
(`ticket_branches` links a branch), or, when you were asked not to commit, "not committed, in <folder> on this
machine". A reviewer in another checkout who finds nothing otherwise concludes the work was never done.

## What each role writes on a ticket
"""
    + _roles_table()
    + "\n"
)


def role_line(role: str | None, skill: bool = True) -> str | None:
    """The one line of a run's prompt that says what this role leaves on a ticket (`skill`: the member has the
    board's skills; otherwise it reads the guide with docs_read)."""
    what = ON_TICKET.get(role or "")
    if not what:
        return None
    where = (
        f"the skill `kanban-board:{NAME}`"
        if skill
        else "docs_read(action='ticket_guide')"
    )
    return f"On the ticket, as {_ROLE_TITLES[role]}, you leave: {what}. How each part is used: {where}."
