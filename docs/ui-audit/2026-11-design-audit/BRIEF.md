# Design audit — how each part is done

Goal: list every place where the running UI does not match the design, so it can be fixed. This is an
**audit only**: do not change any source file, do not commit, do not push.

## Sources of truth

- Design docs: `design/screens/*.md`, `design/components/*.md`, `design/foundations/*.md`. Each doc has the
  verbatim text of the artboard and 2x PNG renders under `design/images/<doc-name>/` (open them with Read: it
  shows images).
- Exact values (colours, sizes, radii, spacing, copy): the artboard source `design/source/<Name>.dc.html`.
  It is large; grep for the block or text you need instead of reading it whole.
- The design is the canvas version `1793629780-1b20`; the local copies are that version.
- Where a later design doc says it *extends* or *replaces* an earlier one (the doc header says so), the later one
  wins; note it in your report.

## The running app

- UI: http://localhost:5173 (Vite dev server, live code). API: http://localhost:8000. Both are already running.
  Do not stop or restart them.
- Data (a throwaway database): project **Kanban Board (KAN)**, id `82019e8d-89b9-4855-a6c8-bb86cdef62d0`, with
  people An Nguyen, Hoa Mai, Tuan Vo, tickets KAN-1…KAN-9, seven Docs pages, and an AI member **Reviewer**
  (Claude Code, haiku) set as the Board AI. Projects MOB, MKT, EVAL also exist.
- You may add data through the API (`curl`, header `X-Actor: An Nguyen`) to reach a state: tickets, comments,
  pages, members, sub-tickets, test cases, ideas, sketches… Add, do not delete or rename what is already there.
- **Never start a real AI run** (no "work on this", no chat message sent to an AI, no schedule run now): it spends
  real money and minutes. States that need a run (streaming, a run in progress, a finished run) are audited from
  the code instead and marked as such.
- Playwright: `NODE_PATH=$(npm root -g) node your-script.cjs` (Chromium is pre-installed; never run
  `playwright install`). Viewport 1440×900 unless the design frame is another size. Put scripts in your own
  folder under the scratchpad given in your brief, never in the repo.

## What to compare, per artboard

1. Read the design doc and look at every image. For each frame (A1, A2, B1…) decide: reachable in the app with
   the data (or data you add), or only in code.
2. Reachable: take a screenshot of the same state and compare it with the design image side by side: layout and
   order, sizes and spacing, colours, type (size, weight), icons (line icons vs emoji/unicode), copy (exact words),
   states (hover, empty, error, loading, disabled), what is missing and what is extra.
3. Not reachable: read the component that draws it (find it with grep / `.claude/scripts/codegraph.sh`) and compare
   its markup, styles and copy with the design source.
4. Something the design draws that the app does not have at all: a finding (category `missing`).
5. Something the app has that the design does not draw: note it only if it breaks the design (crowds a header,
   overlaps, contradicts it); new features the design never covered are not findings.

## Severity

- **Critical**: broken or unusable: overlaps that hide content or controls, cut-off actions, unreadable text,
  a control that does nothing.
- **High**: clearly not the design at a glance: wrong layout or structure, missing section or state, wrong
  component (native select where the design draws a custom one, checkbox for a switch), emoji instead of icons
  across a screen.
- **Medium**: visible detail: spacing, sizes, colours, weights, radius, icon choice, copy that differs in meaning.
- **Low**: small polish: a few pixels, a word, a missing hover.

## Output

Write **one** Markdown file, `docs/ui-audit/2026-11-design-audit/<your-part>.md`, and screenshots under
`docs/ui-audit/2026-11-design-audit/shots/<your-part>/`. Screenshots are **JPEG, quality 75**, at most 1440 px
wide (crop to the area that matters when you can); name them `<artboard>-<frame>.jpg`. Link design images with
relative paths (`../../../design/images/...`).

File layout:

```markdown
# <Part name> — design audit

Summary: N findings (C critical, H high, M medium, L low). Two or three sentences on the main patterns.

## <Artboard title> (`design/screens/<doc>.md`)

Coverage: frames checked in the app: A1, A2…; from code only: B5 (needs a running AI)…; not built: …

| # | Frame | Severity | Category | Design | Now | Where | Fix |
|---|---|---|---|---|---|---|---|
| AB-1 | A1 | High | layout | Title on one line, tabs beside it, Ask AI + New Ticket on the right | Title wraps to 2 lines; New Ticket and the Docs tab are pushed off when the dock is open | `ui/src/App.tsx:1040` | Let the header shrink: … |

Images: [design A1](../../../design/images/…) · [now A1](shots/<part>/<file>.jpg)
```

- `#`: a short prefix for the artboard (2–4 letters) plus a number, unique in your file.
- Category: `layout`, `spacing`, `color`, `type`, `icon`, `copy`, `component`, `state`, `missing`, `behavior`.
- `Where`: the file and line that draws it (best effort, but try).
- `Fix`: one concrete line (the design value to use, the component to swap).
- One row per distinct problem. Group the same problem repeated across a screen into one row and say where.
- Keep a short **Patterns** list at the end of the file: problems seen across several artboards (for example
  "emoji used as icons in 6 places").

## Report back

A short message: the file path, counts by severity, the five worst findings in one line each, and anything you
could not check and why. No raw dumps.
