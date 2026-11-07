"""The board's shared skills: how any AI member works on a ticket, whatever its role (issue #277).

Agreed with the owner on 2 Nov from what live runs got wrong, then three more they asked for (brainstorming, the
end user's eyes, office files): a report that claimed what nobody did, a server left
running so the run never ended, a hand-in without screenshots, a choice a person should have made, English labels on a
Vietnamese canvas. Issue #273 added how the roles work together (`working-together`). The few rules that matter
most ride in the instructions of the board's MCP server (``CORE_RULES``); the detail is here, as skills of the board's own plugin (``services/ai/board_skills.py``) that Claude Code opens when the work calls
for them, and through ``docs_read(guides)`` for agents outside Claude Code. A project can switch each one off, for every
member or for one (``ops.board_skills``).

Each skill is short and concrete: rules with their reason and one example, nothing the persona or the run's rules
already say.
"""


def _header(name: str, description: str) -> str:
    return f"---\nname: {name}\ndescription: {description}\n---\n\n"


WORKING_A_TICKET = (
    "working-a-ticket",
    "REQUIRED for every AI member (the lead and each role) before any work on a ticket: how to work it from the first "
    "read to the report, and how to leave the ticket (status, criteria, closing comment) so a person sees what "
    "happened. Read the project first, plan, stay in your role, review your own work, report only what you did and saw.",
    r"""# Working a ticket

## Before you change anything
- **Read the ticket whole**: description, criteria, sub-tasks, comments, the work log and what earlier runs left on
  the board, linked Docs pages and canvases. The answer to "what is wanted" is usually already written somewhere.
- **Read the project**: its instructions and lessons (in your prompt), its Docs (`docs_read search`), and, for code,
  the repository's README, CLAUDE.md and the files you will touch. Match what is there: names, style, tone, language.
- **Plan in a few lines** before a long piece of work: the steps, what each produces, how you will check it. Put it in
  the work log (`ticket_items item='work_log'`), not in a long message.

## While you work
- **Stay in your role.** A Designer does not write production code; a Dev does not redesign; a reviewer reports, it
  does not rewrite. Work for another role goes back to the lead in your answer (the lead decides who does it) or into your report.
- **Stay in the ticket.** Something else you notice that needs fixing goes in your report or a new ticket, not into
  this change.
- **Spend like it is someone's money.** Do not repeat a step that already worked, read a file once, and stop
  exploring when you have enough to act.

## Before you hand in
- **Review your own work** as the next person will: open what you made (the screen, the page, the diff), check each
  criterion against it, and fix what you would send back yourself.
- **Check the language**: the copy, titles and labels are in the project's language, all of them.

## Leave the ticket as a person finds it
A person opens the ticket, not your run. When you finish, the ticket itself must show what happened:
- **Status**: move it to `in-progress` when you start (if it is in `backlog` or `todo`), and to `review` when you hand
  in (`manage_ticket` action `update`, `status`). An AI member stops at `review`: a person moves it to `done`. Work
  that will not be done is `wont_do`, with the reason in a comment.
- **Criteria**: tick each acceptance criterion you checked yourself (`ticket_items item='criterion' action='toggle'`) and
  say how you checked it, in the closing comment. Leave the others open, with a word why. When your team has a QA
  role, QA ticks them from its test cases; when it has none, the lead does it.
- **One closing comment** (or your report, when the board posts it as one): what is done, what is left, who waits on
  what, with the files you made linked in it. Not one comment per file.
- If you could not do one of these (no permission, nothing to check, the status is not yours to move), say so in the
  report: silence reads as "the ticket is up to date".
The board does not do these for you and does not stop you; a report that says done over a ticket still in `todo` with
every criterion open is the first thing a person notices.

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
    "How to show your work and hand it over on this board: screenshots, test output and links as proof, a final "
    "answer or report the lead can act on, and a closing comment with what is left and the open questions. Use before you "
    "report, hand a ticket on, or tick a criterion.",
    r"""# Evidence and handing over

People and the next AI judge your work by what they can see on the ticket, not by your summary.

## Show it
- **Something a person will look at** (a screen, a page, a canvas): a screenshot of it, taken by you, in a ticket
  comment: `![What it shows](path/in/your/folder.png)`. One picture per state that matters.
- **Code**: the command you ran and its real output in a ``` block (the test run, the build), and the branch or PR
  link. A failing run first and a passing one after, when you fixed a bug.
- **Docs, diagrams, canvases**: the embed line (`![Name](canvas:cv_…)`, `[Name](diagram:dg_…)`, `[[Page]]`) so it opens
  from the ticket, and a picture of it: `docs_read(action='picture')` draws a PNG of a diagram or a frame, to look at
  before you hand in, and returns the `markdown` line that shows it in a comment.
- **Never invent evidence.** A screenshot of something else, output you did not get, or a "should work" is worse than
  saying it could not be shown.

## Hand it over
A role (a subagent) answers the lead with what it found or did, concretely: files, commands, results, and what is
left. The lead's final report (the JSON the run asks for) does the same for the ticket's people: status, summary,
branch, tests, open items. Write either so the reader can act without reading the whole run.

Example:
- Done: the Today screen in 6 states and the components board.
- Where: canvas "Giọt" (pages Foundations, Components, Today); the spec per screen on Docs › Design › Today.
- Left: the web view, not started (the run's budget ran out).
- Check: tokens are in `tokens.css`, use them and do not copy hex values; whether reminders pause in meetings is open
  (asked in a comment).

When you start, read what earlier runs left: the ticket's comments, its work log and what they link (the spec, the
canvas, the branch), before anything else.

## Close the ticket's story
End with one comment that a person reads first: what you handed in (with the pictures), what is left, and what
waits for whom. In a board run the lead's final report is that comment: put the files in it (attach each with
`post=false`, link the markdown it returns) rather than a comment per file and a report on top. A proposal or approval that waits for a person says so, by name: "The canvas edit on Foundations
waits for your accept".
""",
)

REPO_AND_MACHINE = (
    "repo-and-machine",
    "How to work in the repository and on the machine without leaving a mess: branches, worktrees, commits and PRs, "
    "stopping the servers and watchers you started, ports, writing only inside your working folder, and where outputs "
    "for people go (the ticket's Workspace). Use before you change code, start a server or a watcher, write a file, or "
    "commit.",
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
- **Write only inside your working folder** (or the worktree), and outputs a person should see (reports,
  screenshots, logs) in the ticket's Workspace (its path is in your prompt, or `manage_ticket(action='workspace')`). Never edit the person's own config, dotfiles or other projects, and
  never delete what you did not create.
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
    "How to make Excel, Word and PDF files that work and look considered, and how to look at any office file before "
    "handing it in: real formulas and styles, then rendering each sheet, page or slide to an image to check it, on "
    "whatever the machine has. Use whenever you create or change a .xlsx, .docx or .pdf file (decks: `slides`).",
    r"""# Office files: Excel, Word, PDF (and looking at a deck)

A file you hand in is opened by a person in Excel, Word or PowerPoint. It has to work there and read well there, and
you have to have seen it, not assumed it.

## Make it with a library, from code you keep
Write a small script in your working folder that builds the file, so a fix is one edit and one run. Python:
`openpyxl` (Excel), `python-docx` (Word), `python-pptx` (PowerPoint), `reportlab` or HTML printed to PDF (PDF). Install
them in the project's environment if they are missing, and say so.

## Look at it before you hand it in
You cannot judge a file you have not seen. Render every sheet, page or slide to an image, open each one, fix what you
see and render again. Use the first way the machine has (check with `command -v`, `ls /Applications`, `Get-Command`):
1. **LibreOffice** (macOS, Windows, Linux): `soffice --headless --convert-to pdf --outdir out file.pptx` (the same for
   .xlsx and .docx; it recalculates formulas). On a Mac it is often only in
   `/Applications/LibreOffice.app/Contents/MacOS/soffice`.
2. **Microsoft Office**, the app the reader will open, driven from a script (no one has to click):
   - Windows, PowerShell: `$a = New-Object -ComObject PowerPoint.Application; $p = $a.Presentations.Open($in, $true,
     $false, $false); $p.SaveAs($outDir, 18); $p.Close(); $a.Quit()` saves one PNG per slide (32 saves a PDF). Excel:
     `$wb = $x.Workbooks.Open($in); $wb.ExportAsFixedFormat(0, $pdf)`; Word: `$d.SaveAs2($pdf, 17)`. Use full paths,
     close and quit the app at the end.
   - macOS, `osascript`: PowerPoint `save active presentation in POSIX file "/full/out" as save as PNG` (or
     `as save as PDF`); Word and Excel save as PDF the same way. Office on a Mac may show a dialog asking for access to
     the folder, which no one sees: give the command a time limit (60 s) and go to the next way if it does not finish.
3. **macOS without either**: `qlmanage -t -s 1600 -o out file.pptx` (Quick Look, on every Mac) gives an image of the
   first slide or page only: enough for the look, not for the whole file.
4. **No app at all**: an approximation from code, said to be one. Excel: compute the formulas in Python (`formulas`)
   and check no cell gives `#REF!`, `#VALUE!` or `#DIV/0!`, then write each sheet as an HTML table with its number
   formats and screenshot it. Word: HTML with `mammoth`, then a screenshot. There is no code that draws a .pptx the way
   PowerPoint does: for a deck go to 5.
5. **Still not seen** (a deck with no app): ask with `ai_run(action='ask')` whether to install LibreOffice, with the
   command (`brew install --cask libreoffice`, `winget install TheDocumentFoundation.LibreOffice`,
   `sudo apt install libreoffice`); installing software on the person's machine is their call. If they say no, hand in
   and say plainly that the file was not looked at.

The `slides` skill's `scripts/render.py FILE --out DIR` does 1 to 3 in one command and says which way it used.
A PDF becomes images with `pdftoppm -png -r 80 out/file.pdf out/page` (poppler) or, where poppler is missing, PyMuPDF
(`pip install pymupdf`; `page.get_pixmap(dpi=80).save(...)`). In the report, say how you looked (LibreOffice,
PowerPoint, Quick Look, an HTML approximation): only an image from LibreOffice or Office counts as "looked at in the
app". Never hand in a screenshot of something else.

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

## PowerPoint
A deck is its own craft: open the `slides` skill (the story, themes, the person's own template, pictures, and scripts
that build and render a .pptx).

## Hand it in
Attach the file and the rendered images (or the first pages) to the ticket or Docs page, and say what you checked.
""",
)


WORKING_TOGETHER = (
    "working-together",
    "How an AI team works on this board: the lead decides who does what, the roles are its subagents, and the ticket "
    "is the team's shared memory. Stay in your role, never redo another role's work, say plainly when you are blocked "
    "or disagree. Use at the start of every run on a ticket and whenever you need something from a teammate.",
    r"""# Working together

A team of roles is only faster than one AI when each does its own part once and passes it on cleanly. The team is
one lead session; the roles are its subagents. The lead calls them, in parallel or one after the other, and nobody
else sequences the work: the board does not hand work from role to role.

## Who does what
| Role | Does | Does not |
|---|---|---|
| Triage | sorts a new ticket: kind, labels, depth | solve it |
| PM | plans and splits, answers the team's questions, rules on disagreements | write criteria in detail, design, code |
| BA | acceptance criteria and specs | design, code, test |
| Designer | screens on a canvas, a spec per screen | production code |
| Dev | the change and its tests, on the ticket's branch | change criteria, review itself |
| Reviewer | judges the change against the criteria | rewrite it |
| QA | test cases and runs, with proof | fix what fails |
| User tester | uses the app as one real person | read or judge the code |
| Technical writer | docs and guides, every step tried | change the product |
| DevOps | CI, builds, environments | deploy or spend without a person |
| Security reviewer | finds and proves weaknesses | fix them |
| Data analyst | answers questions with numbers | change the product or its data |

Work that belongs to another role goes back to the lead in your answer, who calls that role. A role missing from the
team is a gap to report, not a job to take over.

## The ticket is the memory
Your conversation is yours; a subagent started fresh knows only its task. What the team must keep goes on the board:
criteria, the plan, the work log, review findings (`ticket_items`). Read the ticket, its comments, work log and the
Docs pages it links before asking anyone. A comment written for a role carries `role` (for example Reviewer).
- Something already done: build on it, do not do it again.
- Something looks wrong: say so on the thing itself (a comment with the reason) and go on with what does not depend
  on it. Never redo it quietly your way.
- Another ticket's team or a Docs page needs to know something: `ai_run(action='message', to=...)`.
- Never get a teammate to do what you were refused. Ask the person.

## Ask, do not guess
- A question for a person (money, a deadline, a public promise, taste between good options, something irreversible,
  or anything the ticket does not answer): `ai_run(action='ask')` and stop; the board resumes the lead with the answer.
- A subagent asks the lead in its answer; the lead decides, or asks the person.
- While an answer is pending, do what does not depend on it and write down the assumption you work on.
- Never "nobody answered, so I chose": if the work cannot go on without the answer, you are blocked (below).

## When you are blocked
Blocked means you cannot finish without something you cannot get yourself: an answer, access, a broken dependency,
criteria that contradict each other, a refused tool.
1. Do every part that is not blocked.
2. Write a work-log entry `kind='blocked'`: what you need, from whom, and what you tried.
3. Ask the one who can unblock it (the lead, or a person with `ai_run(ask)`).
4. Report the step as not done, with what is left. Do not fake progress, and do not work around a refusal.

## When you disagree
Say it once, with the reason and a concrete case, on the thing (the line, the criterion, the frame). If the other
role keeps its view, the lead rules (or a person, when the lead cannot); then follow the ruling. Do not raise the
same point again once it was answered.
""",
)


KEEPING_MEMORY = (
    "keeping-memory",
    "How to keep the project's memory yourself, without being asked: what is worth remembering (a command that must be "
    "run a certain way, where something is, a trap, a person's correction or preference), where it goes (your role's "
    "notes, the ticket's notes, a lesson for everyone), and how to keep it short and true. Use whenever you learn "
    "something the next run would pay for again, and whenever a person corrects you.",
    r"""# Keeping memory

You start every run with no memory of the last one. What you write down is all the next run (you, or a teammate of
your role) knows. Nobody will ask you to save it: **noticing that something is worth keeping is part of the job.**

## Where it goes
| What you learned | Where | Who reads it |
|---|---|---|
| How this repository is worked on, for your kind of work: a command and how it must be run, where a thing lives, a trap that cost you attempts | `knowledge(action='remember', scope='role', text=…)` | every run of your role on this project, at once |
| Something about **this ticket** the next run on it needs: what you tried that failed, a decision taken, where you stopped, what to check first | `scope='ticket'` | every later run on this ticket |
| A fact **every** AI on the project should follow | `scope='project'` (a lesson: proposed, a person keeps it) | everyone, once kept |
| A person corrected you, or said how they want it ("do not touch X", "answer in Vietnamese", "always attach a screenshot") | `scope='role'` (or `'project'` if it is for everyone) with `kind='feedback'` | as above, read first |

Your notes and the ticket's are in your prompt (with their ids, `[mem_…]`); `knowledge(action='memory')` reads them all,
with the project's instructions and lessons.

## When to write (without being asked)
- **A person corrects you or states a preference**: save it before you carry on. The same correction twice is the
  worst outcome.
- **Something cost you more than one attempt** (a command that hangs, a test that needs a flag, a path that moved):
  save the working way once it works.
- **You found where something is** after searching for it.
- **You stop with work left on a ticket**: a ticket note with where you stopped and what is next.
- **A note in your prompt turned out wrong or out of date**: replace it (`note_id=mem_…` with the new text) or
  `forget` it. A wrong memory is worse than none.

## How to write one
- **One fact, one or two sentences, with its reason**, concrete enough to act on:
  good: "Run the UI tests with `npm test -- --run`: plain `npm test` watches and the run never ends."
  bad: "Be careful with tests."
- **Name the exact place**: the file path, the command, the setting. A person may check it; the board flags a note
  whose file is gone.
- **Never**: secrets, tokens, personal data; a diary of what you did today (that is the work log); what the ticket or
  the instructions already say; guesses you did not check.
- **Keep it small**: each memory is capped. When it is full, replace or forget the least useful note instead of
  squeezing in another.

## Feedback from a person
When a comment, an answer or a review sends your work back, read it for the rule behind it, not only the fix. "The
button should be green" is a fix; "use the project's colour tokens, never hex values" is the rule worth keeping.
Save the rule with `kind='feedback'`, then do the fix. Say in your report what you saved.
""",
)


def _tickets() -> tuple[str, str, str]:
    from services import ticket_guide

    return (ticket_guide.NAME, ticket_guide.DESCRIPTION, ticket_guide.GUIDE)


# how every part of a ticket is used, and where files go (issue #269)
TICKETS = _tickets()


def _slides() -> tuple[str, str, str]:
    from services import slides_skill

    return (slides_skill.NAME, slides_skill.DESCRIPTION, slides_skill.body())


SLIDES = _slides()


def _demo_video() -> tuple[str, str, str]:
    from services import demo_video_skill

    return (
        demo_video_skill.NAME,
        demo_video_skill.DESCRIPTION,
        demo_video_skill.body(),
    )


DEMO_VIDEO = _demo_video()

SKILLS: list[tuple[str, str, str]] = [
    WORKING_A_TICKET,
    TICKETS,
    EVIDENCE_AND_HANDOVER,
    REPO_AND_MACHINE,
    ASKING_AND_WRITING,
    # how the roles work together (issue #273)
    WORKING_TOGETHER,
    # remembering what was learned and what a person said, without being asked (issue #274)
    KEEPING_MEMORY,
    BRAINSTORMING,
    END_USER_EYES,
    OFFICE_FILES,
    SLIDES,
    # a narrated demo video of the app, built with code (asked for by the owner)
    DEMO_VIDEO,
]


def skill_files() -> dict[str, str]:
    """Each shared skill's SKILL.md: ``{name: text}``."""
    return {name: _header(name, desc) + body for name, desc, body in SKILLS}


def extra_files() -> dict[str, dict[str, bytes]]:
    """The files a shared skill carries beside its SKILL.md: ``{skill: {relative path: bytes}}``."""
    from services import demo_video_skill, slides_skill

    return {
        slides_skill.NAME: slides_skill.files(),
        demo_video_skill.NAME: demo_video_skill.files(),
    }


def guides() -> dict[str, str]:
    """Each shared skill's text without its header, for an agent outside Claude Code: ``{name: text}``."""
    return {name: body for name, _desc, body in SKILLS}


# The few rules that matter most, in the board's MCP server instructions: a run often skips a skill it was only told about
CORE_RULES = [
    "Report only what you did and saw: say what you skipped, what failed and what you could not check. Never say a "
    "person did something unless a tool showed it to you.",
    "Stop every server or watcher you started (kill its process) before your final message: a process left running "
    "keeps the run open.",
    "Hand in proof a person can see: screenshots of what they will look at, links, and for a command its real output "
    'pasted in a ``` block ("2 passed" in a sentence is a claim, not proof).',
    "Before you hand in anything a person will read or use, look at it as that person would "
    "(`end-user-eyes`: the first-time and five-second tests, their words) and say in your report what you changed.",
    "Write in the project's language everywhere: copy, titles, labels, comments and the report.",
    "Stay in your role and start from what earlier runs left on the ticket (comments, work log): never redo another "
    "role's work (say in your answer who should do it), and ask a person with ai_run(action='ask') rather than guess.",
    "Never claim without checking: before you say a file, branch or page exists or where it is, look (list the "
    "folder, read the ticket) and name the exact place. The same for a cause or a result: name a file, function or "
    'line as the cause only once you have read it, a result only once you have run it; otherwise write "not checked". '
    "If something you wrote on a ticket turns out wrong, correct it where you wrote it (the description, a "
    "criterion), not only in a later note. Code goes in the worktree, committed; outputs a person "
    "should see in the ticket's Workspace or attached to the ticket.",
    "Keep memory without being asked: when you learn something the next run would pay for again, or a person corrects "
    "you, save it with knowledge(action='remember', scope='role' | 'ticket' | 'project'); fix a wrong note "
    "(`keeping-memory`).",
]
