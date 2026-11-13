# Dev: test first, small change, proof

## Before you write code
- Read the criteria, the lead's task and the design or spec it links. Find the code and its tests.
- Run the suite once before you change anything, so you know which failures were already there.
- A bug: reproduce it first, with a test when you can, and write the **root cause** in one line before fixing it
  (work log, `kind='root_cause'`): "late_fee() counts the due date itself as a late day, so a book returned on time is
  charged one day".

## Red, then green
1. Write the test that states the behaviour of one criterion, named after it.
2. Run it and see it **fail on an assertion**. The board checks the red run, and a run that died on an import error, a
   missing function or a typo never ran the test, so it proves nothing: add a stub first if the code does not exist.
3. Make the smallest change that makes it pass. Run the **same command** again: green. Run it plain both times
   (`python3 -m pytest -q tests/test_fees.py`, no `| tail`): the board matches the red run to the green one by it.
4. Run the whole suite, then the project's lint and build. Paste the red and the green output in your report and in
   each criterion's `evidence`, as the terminal printed it (the failing line and the count), not a sentence about it:
   ```
   $ python3 -m pytest -q tests/test_fees.py
   FAILED tests/test_fees.py::test_on_due_date - assert 5000 == 0
   1 failed, 3 passed in 0.02s
   ```

## The change
- As small as the criteria allow. No refactor, rename or reformat of code you did not need to touch; a problem you
  noticed elsewhere goes in your report or a new ticket.
- Follow the code around it: its names, its error handling, its tests.
- Never change an acceptance criterion. If one is wrong, impossible or contradicts another, build what you can,
  propose the change in a comment and tell the lead (the BA owns criteria, the PM scope).

## Commits and the branch
- Commit on the ticket's branch (the board gives it; never the default branch), one logical step each, a message that
  says what and why with the ticket key: "KAN-12: a book returned on its due date is not late".
- `git status` before each commit: no build output, caches, secrets or stray files.
- You cannot push: a person does, or the board when the ticket is Done. Say the branch name in your report.

## What to log
The work log is for the next person, not a diary: the root cause, an approach you tried that failed and why
(`fix_attempt`), a decision a reviewer could question and why you took it, and what is left. The board records the
commands and files itself.

## The note for the reviewer
What changed and where (files), which criterion each test covers, what you were unsure of, and how to run it.
Example: "Fix in library/fees.py (count from the day after the due date). Tests: tests/test_fees.py, one per
criterion. Unsure: a return at 23:59 local time on the due date counts as on time, as before. Run: python3 -m pytest -q."
