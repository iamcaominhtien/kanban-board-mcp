# Regression 4.0.1

A temporary workspace for the 4.0.1 release regression. AI testers use the app like real users and log every bug in `bugs/`. The bugs are triaged, fixed (each with a test) and verified. Then this whole folder is deleted, in the last commit of the same PR.

This folder is scaffolding, not documentation. It does not reach `main`: the final commit removes it (see [Cleanup](#cleanup)).

## What counts as a bug

Anything a real user would report, not only a wrong result:

| Type | Meaning |
| --- | --- |
| `functional` | It does not do what it should, or errors. |
| `logic` | It works but the rule is wrong or contradicts the design, the guide or another screen. |
| `ux` | It works as designed but is confusing, slow to use, easy to misuse, or gives no feedback. |
| `visual` | Broken layout, clipping, overlap, wrong colour or contrast, misaligned or inconsistent. |
| `a11y` | Not reachable by keyboard, no focus ring, no label, trap, unreadable at small size. |
| `perf` | Visible lag, jank, a long wait with no loading state. |
| `data-loss` | Something the user made is lost, overwritten or silently changed. |
| `console` | Errors or warnings in the browser console, or failed requests, with no visible symptom. |

If you hesitate whether something is a bug, log it as `ux`. Triage decides.

Severity: **S1** blocks the release (data loss, crash, migration failure, a main feature unusable), **S2** major (a feature works badly or has no workaround), **S3** minor (small, has a workaround), **S4** polish.

## The pipeline

Ready-made prompts for each phase are in [`PROMPTS.md`](PROMPTS.md).

```
0 gate → 1 test (logs only) → 2 triage → 3 fix + test → 4 verify → 5 cleanup
```

Every phase works on files in `bugs/` and the `Status` field of each entry.

| Phase | Who | What | Status after |
| --- | --- | --- | --- |
| 0 Gate | one AI | Pin the commit under test. Run `ruff`, `pytest`, `npm run format:check`, `npm run lint`, `npm test`, `npm run build` and `npm test` in `desktop/`, as in `.github/workflows/ci.yml`. Fix nothing here except a failing gate. Record the pinned SHA in [`PINNED.md`](PINNED.md). | |
| 1 Test | one AI per charter, in parallel | Follow its charter in [`charters/`](charters/README.md). Log bugs only in its own file in `bugs/`. **Do not fix code.** Do not edit another charter's file. | `open` |
| 2 Triage | one AI, after all testers finish | Read every entry, reproduce it, merge duplicates, reject what is not a bug, set the real severity and type, decide `fix` or `deferred`. | `confirmed`, `rejected`, `duplicate`, `deferred` |
| 3 Fix | AIs, grouped by area | Fix each `confirmed` bug in the smallest change. **Add a test that fails before the fix and passes after** (pytest, vitest, desktop test). If it cannot be tested (purely visual), say why in `Fix`. Link bugs to commits. | `fixed` |
| 4 Verify | a different AI than the fixer | Re-run the original steps in the app on the fixed build. Look next to the fix too: did it break the neighbours? | `verified` or back to `confirmed` |
| 5 Cleanup | one AI | Run `python3 docs/regression-4.0.1/status.py --check`. Write the summary, delete the folder. | |

`deferred` means "real, but not for 4.0.1". Copy each one into a GitHub issue before cleanup so it is not lost.

Release rule: **no `S1` and no `S2` may be left in `open`, `confirmed` or `fixed`.** Every `S1` and `S2` must be `verified`, `rejected` or `deferred` with a reason the owner accepts.

## Rules for testers

1. **Test the pinned commit.** Code must not change under the testers. Fixes start only after phase 2.
2. **Use the app as a user.** Click, type, drag, press keys. Use the API or the database only to set up data or to check a result. Do not report bugs seen only by calling the API.
3. **For every feature, go beyond the happy path:** wrong or empty input, very long input, Vietnamese text with diacritics and emoji, cancel and Esc, undo, doing it twice quickly, reload in the middle, two tabs on the same data, the server stopped and restarted.
4. **Look at it, don't only check it.** Take a screenshot of each screen in the light and the dark theme, and at about 1440, 1024 and 390 px wide. Name what a first-time user would not understand, even when it is "as designed".
5. **Watch the console and the network.** Any error, unhandled rejection or failed request is a `console` bug at least.
6. **Reproduce twice** before logging. If it does not reproduce, log it as `flaky` in the title and say how often.
7. **One bug per entry.** Do not bundle. Check the existing entries of your own file first.
8. **The spec is the spec.** Each charter lists the guide chapter and the design files for its area. Behaviour that contradicts them is a `logic` bug, even if it looks reasonable.
9. **Do not touch the real data.** Always run on a fresh database ([setup](#setup)).
10. **Stay in scope.** A bug found outside your charter still goes in your file, with the area in the title. Do not spend time on it.

## Setup

Use a clean profile and a fresh data folder. A data folder chosen in Settings overrides `KANBAN_DB_PATH`, so do not run on a machine that has one.

```bash
git checkout <the SHA in docs/regression-4.0.1/PINNED.md>
export KANBAN_DB_PATH="$PWD/.regression-data/kanban.db"
export KANBAN_UPLOADS_DIR="$PWD/.regression-data/uploads"

cd server && uv sync && uv run alembic upgrade head
uv run uvicorn main:app --port 8000 &

cd ../ui && npm ci && npm run dev      # http://localhost:5173
```

Browser: Chromium and Playwright are preinstalled in the cloud container; use `require('playwright')` and `chromium.launch()` with no options. The Vite dev server proxies to port 8000, so run one tester per machine or container.

Features that need a real AI (Claude Code CLI or an API key) cannot run in the container. Test their screens, settings, empty states, error states and what happens when no AI is configured. Test the runs themselves only when the charter says an AI is available.

## Logging a bug

Add an entry to the end of your own file in `bugs/`. The id is the charter number and the next free number, for example `C07-004`. Copy this and fill it in:

```markdown
### C07-004 · Short title in the user's words
- **Status:** open
- **Type:** ux
- **Severity:** S3
- **Found on:** <sha> · Chromium · 1440×900 · dark theme
- **Area:** Docs › version history
- **Steps:**
  1. ...
  2. ...
- **Expected:** ...
- **Actual:** ...
- **Evidence:** `evidence/C07-004-diff.png`; console: `TypeError: ...`
- **Triage:**
- **Fix:**
- **Verified:**
```

The fields `Status`, `Type`, `Severity` and `Area` must be present and spelled like this: `status.py` reads them. Put screenshots in `evidence/` named after the bug id.

Testers commit only their own `bugs/` file and their own `evidence/` files, with `git pull --rebase` before every push so parallel testers do not collide:

```bash
git add docs/regression-4.0.1/bugs/07-docs.md docs/regression-4.0.1/evidence/C07-*
git commit -m "test(4.0.1): C07 docs findings"
git pull --rebase origin claude/adoring-ride-jgq060 && git push origin HEAD:claude/adoring-ride-jgq060
```

## Status

`python3 docs/regression-4.0.1/status.py` rewrites [`STATUS.md`](STATUS.md) from the bug files: counts per charter and status, and the list of everything not yet `verified`. `--check` exits with an error when the release rule is not met or an entry is malformed.

## Cleanup

Do this last, when `status.py --check` passes:

1. Add the user-visible fixes to `CHANGELOG.md` under `[Unreleased] › Fixed` (and `Changed` if behaviour changed). Write for users, not for this log.
2. Open a GitHub issue for each `deferred` bug, with its steps and evidence.
3. Put the summary in the PR description: bugs by type and severity, what was fixed, the tests that were added, and the issue numbers of the deferred ones.
4. Delete this folder in the final commit: `git rm -r docs/regression-4.0.1` (including `evidence/`). The tests added in phase 3 stay.
5. Check that nothing outside the folder links to it: `git grep regression-4.0.1`.

The release also needs a human smoke pass of about 30 minutes on the final build, which no AI replaces.
