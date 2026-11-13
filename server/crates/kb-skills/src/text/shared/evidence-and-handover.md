# Evidence and handing over

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
`post=false`, link the markdown it returns) rather than a comment per file and a report on top. What waits for a person says so, by name: "The canvas on Foundations waits for your answer to my comment".
