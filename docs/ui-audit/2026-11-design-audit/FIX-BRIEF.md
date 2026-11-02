# Wave 3 — fixing the remaining findings, area by area

Repo `/home/user/kanban-board-mcp`, branch `claude/wizardly-mccarthy-3n2lsp`. **Do not commit, push or switch
branches**; the lead commits. Other agents edit other folders at the same time: edit only the folders named in your
brief. Shared files are read-only for you: `ui/src/index.css`, `ui/src/components/ui/*` (LineIcon, MenuSelect),
`ui/src/App.tsx` (unless your brief names it), `package.json`, the server. If a fix needs one of them, skip it and say
so in your log.

## What to fix

The Critical, High and Medium findings of your report(s) in `docs/ui-audit/2026-11-design-audit/` that are not fixed
yet. Each row says what the design draws, what the app does, where and how to fix. The design itself is in
`design/` (docs, PNGs under `design/images/`, exact values in `design/source/*.dc.html`): follow it, not the
report, when they differ.

Already fixed, skip: AB-1 AB-2 AB-4 SF-1 AP-1 MB-1 CM-2 CM-3 TG-3 AC-1 BR-2 DM-1 RC-7 RC-2 LD-1 TV-2 TV-4 SC-7 RS-2
TL-1 AT-2 RV-1 ED-3 DP-2 PT-1 TC-1 TP-1; and every "glyph instead of icon", "native select looks like the OS",
"double focus ring" row (done app-wide in wave 2: selects are drawn as the design's field, icons are line icons).

Do not build, skip and list: accounts (login, sign up, password reset, the account menu), a dark theme, the branch
lane graph (comp-2 BR-1), anything that needs a server or API change.

## How

- **Never lose a feature.** Same data, same actions, same keyboard paths, same `data-testid`s. Moving a control is
  fine; removing one is not. When the design drops something the app has, keep it and place it where it fits.
- Where the design draws a custom dropdown (a chip, a range button, options with a second line or an avatar), use
  `MenuSelect` from `ui/src/components/ui/MenuSelect.tsx` (read it first). Where it draws a plain field, keep the
  native `<select>` (already styled). Icons: `LineIcon` from `ui/src/components/ui/LineIcon.tsx`.
- Values (colours, sizes, radius, copy) from the design source, not guessed.
- Small missing pieces the design draws for data the app already has (a popover, a field, a state card) may be
  built, UI only.
- Tests: keep every assertion about behaviour; when markup changes, update how the test finds things. Add a test for
  new behaviour (a popover that opens, a new field that saves).

## Check

From `ui/`: `npx prettier --write <files>`, `npx tsc --noEmit -p .`, `npx eslint <files>` (0 errors), `npx vitest run`
(the whole suite; failures in other agents' folders may be their work in progress: report, do not fix). In the
browser: the app with your changes is http://localhost:5173, the same app before wave 3 is http://localhost:5174
(API http://localhost:8000, project "Kanban Board", id `82019e8d-89b9-4855-a6c8-bb86cdef62d0`; open a URL with
`?proj=<id>` so a fresh browser opens that project, and `?settings=<page>` for Settings). Take a before (5174) and
after (5173) screenshot of every finding you fixed, JPEG, into your scratch folder. Never start a real AI run. Only add
data, never delete or change existing data.

## Log

Write `docs/ui-audit/2026-11-design-audit/fixes/<your-area>.md`: one line per finding of your report(s) —
`ID · Fixed` (what changed, file), `ID · Skipped` (why), or `ID · Already fixed`. Then report back briefly: counts,
the files you changed, anything you could not fix, test results, and the path of your before/after screenshots.
