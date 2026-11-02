# Design audit, November 2026 — summary

The running app (3.23.2) compared with every desktop artboard of the design canvas (version `1793629780-1b20`,
81 artboards; the Mobile page and the parked Theme art boards are out of scope). How it was done: [BRIEF.md](BRIEF.md).
Each part has its own report with the design and app screenshots side by side, the file and line that draws each
problem, and a one-line fix.

## Totals

| Part | Report | Critical | High | Medium | Low | Total |
|---|---|---|---|---|---|---|
| AI 1: members, provider, Board AI, safety & cost, schedules, AI where you work | [ai-1.md](ai-1.md) | 1 | 7 | 30 | 15 | 53 |
| AI 2: AI Team, Timeline, AI paused, Resources | [ai-2.md](ai-2.md) | 1 | 2 | 15 | 16 | 34 |
| AI 3: accounts, operations, team process, Board AI wave 3, Story & Flow, repo commands | [ai-3.md](ai-3.md) | 1 | 8 | 27 | 9 | 45 |
| Components 1: theme, ticket card, toast, loading, icons, tags, grouping, drag & drop, status menu | [comp-1.md](comp-1.md) | 0 | 4 | 10 | 16 | 30 |
| Components 2: ticket detail and its tabs, New Ticket, activity, account menu | [comp-2.md](comp-2.md) | 0 | 8 | 17 | 20 | 45 |
| Board: main board, list, timeline, comments, doc refs, reopen, pending, AI work | [board.md](board.md) | 1 | 2 | 12 | 15 | 30 |
| Idea Space and Sketch | [ideas.md](ideas.md) | 0 | 8 | 25 | 23 | 56 |
| Docs and Canvas | [docs.md](docs.md) | 1 | 2 | 15 | 20 | 38 |
| Account, start-up, previews, notifications | [app.md](app.md) | 1 | 5 | 17 | 21 | 44 |
| **All** | | **6** | **46** | **168** | **155** | **375** |

Each part also has a demo video (the walk through the findings, Vietnamese captions under the picture); they were
shared in the session and are not committed (too large).

## What goes wrong most often

1. **Headers that do not fit.** The board header holds about twelve controls; at 1440 px with the sidebar open, or with
   the Ask AI dock open, the title wraps and New Ticket is cut off or hidden (ai-1 AB-1/AB-2, ai-2 AP-1, ai-3 SF-1,
   board MB-1). The Docs page header does the same to its breadcrumb (docs DP-1/DP-2).
2. **Floating layers in the wrong place.** The Ask AI dock covered the board; popovers inside the ticket detail opened
   off by the panel's offset (a transform on the panel); the Idea Space Ask panel covers its header; AI bubbles cover
   a new sketch; two toolbars on one selection.
3. **Native controls where the design draws its own.** About 40 `<select>`s, `datetime-local` and time inputs, and
   checkboxes where the design draws a dropdown, a range button, chips or a switch.
4. **Glyphs and emoji instead of the line icons** (💬 🗀 ⚙ 📄 ➤ ✦ ▾ ⋯ ✓ ×): about 90 in the assistant, 168 in the AI
   screens, more in Idea Space.
5. **Raw internals in the text**: `todo → done`, `None → None`, `::: center`, Markdown source in previews and chips,
   role keys as names ("Ba", "Qa"), wrong plurals.
6. **Missing states**: loading skeletons when switching projects, the "no work in this range" states, empty and
   error states drawn as one grey line instead of the designed card.
7. **Things not built yet**: login / sign-up / password reset (no accounts in the app), dark theme, the account menu,
   the tag picker, the wave popover on sub-tickets, the branch lane graph.

## How it is being fixed

The fixes ship in waves, each one its own pull request with a version bump, tests and a demo video. No feature is
removed; where a finding is a product decision rather than a defect it is listed, not changed.

1. **Wave 1 — broken things and behaviour bugs (3.23.3).** AB-1 dock covers the board · AB-2/SF-1/AP-1 header
   overflow · CM-2 comment action bar never shows · CM-3 `@` and `[[` suggesters open off-screen (cause: a transform
   on the ticket panel, which misplaced every popover inside it) · TG-3/AC-1 Esc saves the tag, Esc does not cancel
   a criterion (cause: closed dialogs in the ticket swallowed every Esc) · BR-2 new branches always start from `main`
   · DM-1 `::: center` shown raw · RC-7 the read step calls an AI · RC-2 a missing package.json called "the command is
   right" · LD-1 another project's cards under this project's name · TV-2 resizing a bar opens the ticket · TV-4 raw
   event text · SC-7 / RS-2 chart axes · TL-1 / AT-2 duplicate Timeline controls · RV-1 "Only 0 runs" · ED-3 Ctrl+K in
   the editor opens the search · DP-2 Docs header · PT-1 uploaded HTML ran with the app's origin (security).
2. **Wave 2 — the same fix everywhere (3.23.4).** One dropdown in the design's style for the native selects, line
   icons for glyphs and emoji, the global focus ring, card height, the `.ai-sub` class clash.
3. **Wave 3 — the remaining high and medium findings, area by area.**
4. **Wave 4 — the low findings.**

## For a decision, not changed

- **Canvas frames run with the app's origin.** By design (README, `server/api/canvases.py`) a canvas frame is an open
  web page with no sandbox, so a mock-up can be clicked through. The same exposure as PT-1 applies: a frame can read
  the app's storage and call its API as the viewer. A sandbox would also stop the size measuring and the PNG/SVG
  capture that read the frame, so it needs its own change and a decision.
- **Accounts** (login, sign-up, reset) and a **dark theme** are new features, not fixes.
