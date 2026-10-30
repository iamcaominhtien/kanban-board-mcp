# Prompts for the AIs

Copy a prompt, fill the `<…>`, and give it to one AI session on the branch `claude/adoring-ride-jgq060`. Read the [README](README.md) first: the prompts only point at it.

## Phase 0 · Gate

```
You are preparing the 4.0.1 regression. Read docs/regression-4.0.1/README.md.
Do phase 0: on the current head of this branch, run every check in .github/workflows/ci.yml
(server: ruff check, ruff format --check, pytest -q -n auto; ui: format:check, lint, npm test, build;
desktop: npm test). Fix only what makes a check fail, in the smallest change, and say what you changed.
Write the commit SHA and the result of each check in docs/regression-4.0.1/PINNED.md, commit and push.
Do not start testing.
```

## Phase 1 · Tester (one per charter)

```
You are an exploratory tester for the 4.0.1 release of this Kanban board, acting as a real user.
Read docs/regression-4.0.1/README.md (all of it, especially "What counts as a bug", "Rules for testers",
"Setup" and "Logging a bug"), then your charter: docs/regression-4.0.1/charters/<NN-name>.md.
Test the commit in docs/regression-4.0.1/PINNED.md, on a fresh database.

Use the app through the browser like a user. Look at it in the light and dark theme and at three widths,
watch the console, and log UX and visual problems as well as functional ones.
Log every bug in docs/regression-4.0.1/bugs/<NN-name>.md only, in the exact entry format, with evidence
in docs/regression-4.0.1/evidence/. Reproduce each bug twice before logging it.
DO NOT fix any code, and do not edit any file except your own bug file and your own evidence files.
Commit and push your findings as you go (git pull --rebase first), at least after every few bugs.
When every item of the charter was tried, add the line "Charter finished" with the date and the SHA,
push, and reply with a count of bugs by severity.
```

## Phase 2 · Triage

```
You are the triage owner of the 4.0.1 regression. Read docs/regression-4.0.1/README.md.
All testers have finished. For every entry with Status "open" in docs/regression-4.0.1/bugs/*.md:
reproduce it in the app on the commit in PINNED.md; then set Status to
confirmed, rejected, duplicate (name the original) or deferred, correct Type and Severity if they are wrong,
and write one line in Triage saying why. Look for the same cause behind several entries and say so.
Reject what is not a bug (working as documented, or not reproducible after three tries) and say how you checked.
Run `python3 docs/regression-4.0.1/status.py` and commit. Do not fix code.
In your reply, list the S1 and S2 bugs and the groups of bugs that should be fixed together.
```

## Phase 3 · Fixer

```
You are fixing bugs found in the 4.0.1 regression. Read docs/regression-4.0.1/README.md, phase 3.
Your bugs: <C07-001, C07-004, … or "all confirmed bugs of <area>">.
For each, in this order: reproduce it; write a test that fails because of it (pytest in server/tests,
a unit test in ui/src next to the code, or a test in desktop/tests; follow the nearby tests and the project's
conventions in CLAUDE.md); fix it with the smallest change; see the test pass; run the area's checks
(ruff, pytest, format:check, lint, npm test, build as relevant).
If a bug cannot be tested (purely visual), say why. Do not refactor and do not fix other things.
One commit per bug or per group with the same cause; the message names the bug ids.
Set Status to fixed and fill Fix with the commit and the test. Run status.py. Push (git pull --rebase first).
If you decide a bug is not worth fixing now or is wrong, do not change its status: say so in your reply.
```

## Phase 4 · Verifier

```
You are verifying fixes of the 4.0.1 regression. Read docs/regression-4.0.1/README.md, phase 4.
You did not write these fixes. For each bug with Status "fixed" in <bug files>: build and run the head of this branch
on a fresh database, repeat the original Steps in the app, and check the Expected result, in both themes when the bug
was visual. Then try two things next to it that the fix could have broken. Read the added test and check that it
would fail without the fix (revert the fix locally to see it fail, then restore it).
Set Status to verified and fill Verified with what you did, or set it back to confirmed and say what is still wrong.
Run status.py, commit, push.
```

## Phase 5 · Cleanup

```
Do phase 5 of docs/regression-4.0.1/README.md. Run `python3 docs/regression-4.0.1/status.py --check`; stop
and report if it fails. Otherwise: write the user-facing fixes into CHANGELOG.md under [Unreleased]; list the
deferred bugs with their steps and evidence so the owner can open issues; write the PR description summary
into docs/regression-4.0.1/PR-SUMMARY.md only if it is needed to carry it out of the folder, and show it to me;
then delete docs/regression-4.0.1 in the final commit and check `git grep regression-4.0.1` is empty.
Do not create the pull request.
```
