# Wave 4: the Low findings, and the rows left for another area's files

Wave 4 follows the same rules as `FIX-BRIEF.md`; read it first. This brief covers only what is different.

Repo: `/home/user/kanban-board-mcp`, branch `claude/wizardly-mccarthy-3n2lsp`.
- **Do not commit, push or switch branches.** The lead commits.
- Edit only the files your brief names. Other agents edit the other folders at the same time.

## What to fix

- **The rows logged `Skipped — Low`** in your area's log, `docs/ui-audit/2026-11-design-audit/fixes/<area>.md`. Each row's design, current state and fix are in the report it came from (`board.md`, `docs.md`, `ai-1.md`, …).
- **The leftover rows named in your brief.** These are rows skipped in wave 3 only because they sat in another area's files.

Still out of scope; leave them skipped:
- accounts;
- dark theme;
- the branch lane graph;
- anything that needs a server or API change or a new stored field;
- the restructures already logged as too large (TP-3, WV-4, RC-4, RC-5).

## The rules learned in wave 3 (an independent review caught these; they are not negotiable)

- **Same clicks, same keys.** An action that took one click still takes one click. Never move an inline button, field or dropdown into a menu, a "more" control or a hover-only place.
- **Same choices.**
  - When a control is redrawn, keep every option, its value, and its default.
  - Keep sort orders and default values. Example: comments are newest first.
- **Same information.**
  - Do not replace live data with fixed text.
  - Do not drop a colour that carries meaning.
  - Do not drop avatars, ids, counts, previews or hints.
  - Folding text into a `<details>` only to save room counts as hiding it.
- **Same input behaviour.** What you type is what gets saved. Enter, blur, Esc and Tab keep doing what they did.
- **Server messages stay.** An error message the server sends stays visible.
- **Nothing faked in localStorage.** If a fix needs a field the server lacks, log it as "needs a server field".
- **When the design would change how something works:** keep the behaviour, match only the look, and say so in the log.
- **Self-review before you report.**
  - Run `git diff origin/main -- <your files>`.
  - For every removed line that was a handler, a control, an option, a condition, a key handler, a label or a piece of information, point to where it went.
  - Report anything you could not keep.

## Check

Use the same commands as FIX-BRIEF:
- prettier, `tsc`, eslint with 0 errors, and the whole vitest suite;
- before/after JPEGs into your scratch folder. Port 5174 is main (wave 3); port 5173 is your work.

Log: update your area's log in place. Change the row's `Skipped — Low` to `Fixed (wave 4) …`, or say why it stays skipped.

Report briefly:
- the counts;
- the files you changed;
- what you could not fix;
- the self-review result;
- the test results;
- the path to your screenshots.
