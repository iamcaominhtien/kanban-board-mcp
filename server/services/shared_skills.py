"""The board's shared skills: how any AI member works on a ticket, whatever its role (issue #277).

Agreed with the owner on 2 Nov from what live runs got wrong, then three more they asked for (brainstorming, the
end user's eyes, office files): a report that claimed what nobody did, a server left
running so the run never ended, a hand-in without screenshots, a choice a person should have made, English labels on a
Vietnamese canvas. The few rules that matter most ride in every run's prompt (``context.rules_block``); the detail is
here, as skills of the board's own plugin (``services/ai/board_skills.py``) that Claude Code opens when the work calls
for them, and through ``docs_read(guides)`` for agents outside Claude Code. A project can switch each one off, for every
member or for one (``ops.board_skills``).

Each skill is short and concrete: rules with their reason and one example, nothing the persona or the run's rules
already say.
"""


def _header(name: str, description: str) -> str:
    return f"---\nname: {name}\ndescription: {description}\n---\n\n"


WORKING_A_TICKET = (
    "working-a-ticket",
    "How to work a ticket on this board from the first read to the report: read the project first, plan, stay in your "
    "role, review your own work, and report only what you did and saw. Use at the start of any ticket and before your "
    "report.",
    r"""# Working a ticket

## Before you change anything
- **Read the ticket whole**: description, criteria, sub-tasks, comments, the handoff note of the step before you,
  linked Docs pages and canvases. The answer to "what is wanted" is usually already written somewhere.
- **Read the project**: its instructions and lessons (in your prompt), its Docs (`docs_read search`), and, for code,
  the repository's README, CLAUDE.md and the files you will touch. Match what is there: names, style, tone, language.
- **Plan in a few lines** before a long piece of work: the steps, what each produces, how you will check it. Put it in
  the work log (`ticket_items item='work_log'`), not in a long message.

## While you work
- **Stay in your role.** A Designer does not write production code; a Dev does not redesign; a reviewer reports, it
  does not rewrite. Work for another role goes to that role (`ai_run handoff`) or into your report.
- **Stay in the ticket.** Something else you notice that needs fixing goes in your report or a new ticket, not into
  this change.
- **Spend like it is someone's money.** Do not repeat a step that already worked, read a file once, and stop
  exploring when you have enough to act.

## Before you hand in
- **Review your own work** as the next person will: open what you made (the screen, the page, the diff), check each
  criterion against it, and fix what you would send back yourself.
- **Check the language**: the copy, titles and labels are in the project's language, all of them.

## The report: only what is true
Your report and final message are read as fact. Write only what you did and what you saw yourself.
- Say what you **skipped**, what **failed** and what you **could not check**, plainly. "Tests not run: no test
  command" is useful; silence reads as "done".
- Do not claim what you did not see. Never write that a person did something unless a tool showed it to you.
- A ticked sub-task or criterion means it is done. Leave it open, with a word why, when it is not.

Example, good: "Built Today in 6 states and the components board. Not done: the web view (ran out of the step's
budget). The contrast of the muted text is 4.4:1 on the card, under 4.5: left as an open question."
Bad: "Everything is done and polished." (when the web view is missing)
""",
)

EVIDENCE_AND_HANDOVER = (
    "evidence-and-handover",
    "How to show your work and hand it over on this board: screenshots, test output and links as proof, a handoff "
    "note the next role can act on, and a closing comment with what is left and the open questions. Use before you "
    "report, hand a ticket on, or tick a criterion.",
    r"""# Evidence and handing over

People and the next AI judge your work by what they can see on the ticket, not by your summary.

## Show it
- **Something a person will look at** (a screen, a page, a canvas): a screenshot of it, taken by you, in a ticket
  comment: `![What it shows](path/in/your/folder.png)`. One picture per state that matters.
- **Code**: the command you ran and its real output in a ``` block (the test run, the build), and the branch or PR
  link. A failing run first and a passing one after, when you fixed a bug.
- **Docs, diagrams, canvases**: the embed line (`![Name](canvas:cv_…)`, `[Name](diagram:dg_…)`, `[[Page]]`) so it opens
  from the ticket.
- **Never invent evidence.** A screenshot of something else, output you did not get, or a "should work" is worse than
  saying it could not be shown.

## Hand it over
When the next step is another role or a person, leave a **handoff note** they can act on without reading your whole
run (in the work log, or the `instruction` of `ai_run handoff`):
- what is done and where it is (links);
- what is not, and why;
- the decisions you took that they must follow;
- the open questions, each with who decides.

Example: "Design is on the canvas (Foundations, Components, 6 screens) and the spec per screen is on Docs. Dev: tokens
are in `tokens.css`, use them, do not copy hex values. Open: whether reminders pause in meetings (asked the PO in a
comment)."

## Close the ticket's story
End with one comment that a person reads first: what you handed in (with the pictures), what is left, and what
waits for whom. A proposal or approval that waits for a person says so, by name: "The canvas edit on Foundations
waits for your accept".
""",
)

REPO_AND_MACHINE = (
    "repo-and-machine",
    "How to work in the repository and on the machine without leaving a mess: branches, worktrees, commits and PRs, "
    "stopping the servers and watchers you started, ports, and writing only inside your working folder. Use before you "
    "change code, start a server or a watcher, or commit.",
    r"""# The repository and the machine

## Git
- **Work on the ticket's branch** (or the worktree the board gave you). Never commit to the default branch, and never
  rewrite history that others have: no force-push, no amend of pushed commits.
- **Small commits that say why**: one change each, a message that a reviewer understands without the diff.
- **Run the project's own checks before you hand in** (its test, lint and build commands, in your prompt or the
  README). Report their real result.
- **A PR**: a title that says what changes, a body with what and why, how it was checked, and screenshots for anything
  visible.

## What you start, you stop
Your run is not over until everything you started is stopped. A server or watcher left running keeps the run open,
holds a port and uses the machine after you are gone.
- Start a server you only need for a while in the background, note its process id, and **stop it before your final
  message** (`kill <pid>`). Example: `python3 -m http.server 8765 --bind 127.0.0.1 &` to look at frames, then `kill %1`
  when the screenshots are taken.
- **Ports**: the board gives each worktree its own (in your prompt); otherwise pick a free one and check it is free
  first. Bind to `127.0.0.1`, not to every interface.
- Temporary files go in your working folder's own scratch place, not in the user's home or `/tmp` of another tool.

## Files
- **Write only inside your working folder** (or the worktree). Never edit the person's own config, dotfiles or other
  projects, and never delete what you did not create.
- Do not commit generated files, build output, secrets or large binaries; check `git status` before each commit.
""",
)

ASKING_AND_WRITING = (
    "asking-and-writing",
    "When to ask a person and how, when to decide yourself and say so, and how to write copy, comments and reports in "
    "the project's language (Vietnamese or English) so they read naturally. Use before you ask a question, choose "
    "between options for someone, or write text people will read.",
    r"""# Asking and writing

## Ask, or decide?
- **Ask** when the choice is a person's: what the product should do, a trade-off with a cost (money, scope, time, risk),
  taste between options that are all fine, anything they cannot easily undo. Call `ai_run(action='ask')` and stop: the
  board resumes you with the answer.
- **Decide yourself** when the ticket, the project's Docs, its lessons or the code already answer it, or it is easy to
  change later. Then **say so** in your report: "Chose A (the cup) over B and C: it reads at thumbnail size. Easy to
  switch: the screens use one component."
- Never guess silently on a person's call, and never write "no one was there to answer, so I chose": ask, and let the
  board wait.

## A good question
- One question, with **2 to 4 options** and your **recommendation** first, each with what it costs.
- Enough context to answer it without opening the run: what you found, what depends on the answer.

Example: "Reminders during meetings? A) Pause when the calendar says busy (recommended: no noise in meetings; needs
calendar access). B) Always remind. C) Let the user choose in Settings (one more setting)."

## Writing
- **The project's language, everywhere**: copy, titles, labels, page names, captions, comments, reports. A Vietnamese
  product gets Vietnamese on every screen and every board, not English headings with Vietnamese text.
- **Write like a person of that language**, not a translation: Vietnamese with its diacritics, natural word order, and
  the register the product uses (friendly "bạn", no stiff calques). English plain and direct.
- **Short and specific**: say what happened and what to do next ("Plan for 4 tickets is waiting for your approval"),
  numbers and names over adjectives, no filler, no blame.
- **Copy carries the state**: an empty state says what to do next; an error says what went wrong and how to fix it.
""",
)

BRAINSTORMING = (
    "brainstorming",
    "How to work out with a person what to build before building it, and how to lay out options for yourself when "
    "nobody needs to be asked: questions in rounds, approaches with their trade-offs, an agreed list written down. Use "
    "when a ticket is vague or has several ways to go: a new feature, a Story to split, a scope to settle, a design "
    "direction, a solution to pick.",
    r"""# Brainstorming

You build what you believe the person wants, and that belief is usually thinner than it feels. This is for finding
out what they want, and why, before the work starts. (After obra/superpowers' brainstorming skill, MIT.)

## First: what do you already know?
- **The ticket says it all** ("rename the button to Save"): do it, no brainstorm.
- **Something that would change the result is missing**: brainstorm. Read first (the ticket, its comments, the
  project's Docs and lessons, the code or screens it touches), so you never ask what is already written.

## With a person
A question reaches the person through `ai_run(action='ask')`, and the run stops until they answer, so each round
counts.
- **Round 1, what and why.** Say back in two or three sentences what you understood (what, for whom, why), add what
  you found that bears on it (a constraint, a conflict, a cheaper path), then ask the one question whose answer would
  change the result most.
- **Round 2, how.** Lay out **2 or 3 approaches** that differ on something that matters, each with what it costs and
  what it gives up, your recommendation first. Ask them to pick, or to change one.
- Two rounds are usually enough; a third only for a point that would make the work wrong.
- Their words beat your options: when they describe what they want, use their terms.

Example question: "Xuất CSV: chủ yếu để gửi bác sĩ (một file gọn, đúng định dạng ngày Việt Nam) hay để tự phân tích
(mọi cột, mọi lần uống)? A) Gửi bác sĩ, một file mỗi tháng (đề xuất: ít việc, đúng nhu cầu đã nêu). B) Tự phân tích,
xuất mọi thứ. C) Cả hai, chọn khi xuất (thêm một màn)."

## On your own
When the choice is yours (easy to change, or the ticket says you decide): still lay out 2 or 3 approaches, score
them against what the ticket asks, keep the best and say why in one line. Do not stop at the first idea.

## Write it down
End with the agreed list where the next person looks: a ticket comment, the Story's description or a Docs page.
What was decided, what was left out and why, the open questions and who decides them. Then do the work from that
list, not from memory.
""",
)

END_USER_EYES = (
    "end-user-eyes",
    "How to look at your work the way its real user will before you hand it in: the first-time test, the five-second "
    "test, jargon and translated-sounding words, walking one real task, and the machine-made look. Use before handing "
    "in anything a person will read or use: screen copy, an error message, a Docs page, a report, a slide, a screen.",
    r"""# Through the end user's eyes

What you make is judged by someone who did not see you make it, is in a hurry and does not know the words you used
while working. Before you hand in, become that person for a few minutes.

## Who is it for?
Name the reader or user in one line: who they are, what they came to do, what they already know. "An office worker in
Hanoi, on the phone between meetings, wants to log a glass in one tap." Judge everything against that person.

## The tests
1. **First time.** Read it as someone who has never seen the product. Every word and icon understood without
   explanation? Anything you would have to explain in person is a fix.
2. **Five seconds.** Look for five seconds, then look away: what is this, and what do I do next? If either answer is
   unclear, the hierarchy is wrong (one main thing, one main action).
3. **Their words.** Replace jargon, internal names (ticket keys, field names, "sync", "payload", "entity") and words
   that sound translated. Vietnamese reads like a Vietnamese person wrote it: natural word order, the product's
   register, full diacritics. Numbers in the user's format (1.250 ml, 14:05, 02/11).
4. **One real task.** Walk one thing a user came to do from start to end. Count the steps and the places you had to
   guess. Every guess is a fix.
5. **States they will hit.** Empty, loading, error, offline, too long, too many: each says what happened and what to
   do now, in a sentence a person would say.
6. **The machine-made look.** Would this look the same in any other app? The tells: white rounded cards on a tinted
   ground, icons in pale circles, a row of equal buttons, filler text, a gradient for no reason, every sentence the
   same length. For screens, `kanban-board:canvas-design` and its `craft.md` say what to do instead.

## Fix, then say what you checked
Fix what the tests found, look again, and in your report name the tests you ran and what changed: "First-time test:
renamed 'Sync pending' to 'Chưa gửi lên máy chủ'; the empty History now says how to log the first glass."
""",
)

OFFICE_FILES = (
    "office-files",
    "How to make Excel, Word, PowerPoint and PDF files that work and look considered, and how to look at them before "
    "handing in: real formulas, styles and layouts, content with a point, then rendering each sheet, page or slide to "
    "an image to check it. Use whenever you create or change a .xlsx, .docx, .pptx or .pdf file.",
    r"""# Office files: Excel, Word, PowerPoint, PDF

A file you hand in is opened by a person in Excel, Word or PowerPoint. It has to work there and read well there, and
you have to have seen it, not assumed it.

## Make it with a library, from code you keep
Write a small script in your working folder that builds the file, so a fix is one edit and one run. Python:
`openpyxl` (Excel), `python-docx` (Word), `python-pptx` (PowerPoint), `reportlab` or HTML printed to PDF (PDF). Install
them in the project's environment if they are missing, and say so.

## Look at it before you hand it in
You cannot judge a file you have not seen. Render it to images and look at every one:
1. `soffice --headless --convert-to pdf --outdir out file.xlsx` (the same for .docx and .pptx; LibreOffice).
2. `pdftoppm -png -r 80 out/file.pdf out/page` (poppler), then open the PNGs.
3. Fix what you see, render again.
If `soffice` or `pdftoppm` is not on the machine, do not guess: say in your report that the file was not looked at, and
how to install them (LibreOffice; poppler-utils). Never hand in a screenshot of something else.

## Excel
- **Formulas, not typed results**: `=SUM(B2:B31)`, so the sheet still works when a number changes. Recalculate it
  before you look (LibreOffice recalculates on conversion) and check no cell shows `#REF!`, `#VALUE!` or `#DIV/0!`.
- Numbers as numbers with a format (thousands separator, decimals, dates, %), never as text, in the reader's
  format: for a Vietnamese reader `1.250` and `3,5` and `02/11/2026`, on the sheet, on chart axes and in the slides alike.
- A header row that is bold and frozen, columns wide enough for their content, one table per sheet, sheet names that
  say what is in them. Inputs, calculations and outputs kept apart, inputs marked.
- A chart only when it answers a question; its title says the answer.

## Word and PDF
- Real styles (Title, Heading 1, 2, Normal), not bold text made to look like a heading, so the outline and the table
  of contents work.
- Tables with a header row, numbers right-aligned, page numbers, margins that leave room.

## PowerPoint: a point, then a look
Most bad decks fail on content before design.
- **Story first.** Write the slide titles alone, in order: read together they must tell the whole argument. Each title
  is a sentence that states the point ("Reminders tripled the glasses logged after 3 pm"), not a label ("Results").
- **One idea per slide**, the evidence for it (a number, a chart, a picture), and little text. No walls of bullets,
  no filler, no invented numbers: a missing fact is a visible placeholder.
- **A look chosen for the subject**, not the default template: one or two typefaces, a small palette, generous
  margins, the same grid on every slide, real images or drawn diagrams instead of clip-art. No gradients, no shadows on
  everything, no stock icons in circles.
- **Critique pass**: render the deck, look at the slides as thumbnails side by side, and fix the three slides that
  look most like a template or say least.

## Hand it in
Attach the file and the rendered images (or the first pages) to the ticket or Docs page, and say what you checked.
""",
)

SKILLS: list[tuple[str, str, str]] = [
    WORKING_A_TICKET,
    EVIDENCE_AND_HANDOVER,
    REPO_AND_MACHINE,
    ASKING_AND_WRITING,
    BRAINSTORMING,
    END_USER_EYES,
    OFFICE_FILES,
]


def skill_files() -> dict[str, str]:
    """Each shared skill's SKILL.md: ``{name: text}``."""
    return {name: _header(name, desc) + body for name, desc, body in SKILLS}


def guides() -> dict[str, str]:
    """Each shared skill's text without its header, for an agent outside Claude Code: ``{name: text}``."""
    return {name: body for name, _desc, body in SKILLS}


# The few rules that matter most, in every run's prompt: a run often skips a skill it was only told about
CORE_RULES = [
    "Report only what you did and saw: say what you skipped, what failed and what you could not check. Never say a "
    "person did something unless a tool showed it to you.",
    "Stop every server or watcher you started (kill its process) before your final message: a process left running "
    "keeps the run open.",
    "Hand in proof a person can see: screenshots of what they will look at, links, and for a command its real output "
    "pasted in a ``` block (\"2 passed\" in a sentence is a claim, not proof).",
    "Before you hand in anything a person will read or use, look at it as that person would "
    "(`end-user-eyes`: the first-time and five-second tests, their words) and say in your report what you changed.",
    "Write in the project's language everywhere: copy, titles, labels, comments and the report.",
]  # then where the detail is, which depends on the member (context._core_rules)
