title: "Test Plan: Idea Board E2E Re-run 2026-04-25"
type: test
status: stable
version: 1.0.4
created: 2026-04-25
updated: 2026-04-25
authors: [GitHub Copilot]
related:
  - docs/specs/IAM-100-idea-board-spec.md
  - docs/test-plans/idea-board-backend-tests.md
---

# Test Plan: Idea Board E2E Re-run 2026-04-25

## Scope

Final black-box rerun of the live Idea Board UI against:

- UI: `http://127.0.0.1:5173`
- Backend: `http://localhost:8000`

This rerun covered the user-requested eight end-to-end cases for Idea Space load, create, modal access, description persistence, status change, microthought creation, assumption creation, and reload persistence.

## Execution Notes

- Server was restarted before execution so the live run picked up the latest in-memory transition map.
- Entry path used: open the app, select `[TEST] Idea QC Project`, then use the project-row switch labeled `Switch to Idea Space`.
- Initial load rendered the four visible Idea Space columns: `Drafting`, `In Review`, `Promoted`, `Dropped`, with no crash, no visible error banner, and no new error-level console messages on entry.
- Because the project already contained prior `E2E Test Idea` cards, the rerun tracked the newest top card created in this session (`IDEA-15`).
- Creating a new idea incremented the `Drafting` count from `7` to `8` and inserted a new top `E2E Test Idea` card.
- Description `E2E test description` persisted after save and reopen, with a successful `PATCH /api/idea-tickets/IDEA-15` response.
- After adding the required problem statement and clicking `Send to Review`, the UI moved the card from `Drafting` to `In Review` and the browser recorded `PATCH /api/idea-tickets/IDEA-15/status` with `200 OK`.
- Adding microthought `test thought` rendered it immediately with timestamp `just now` and recorded `POST /api/idea-tickets/IDEA-15/microthoughts` with `200 OK`.
- Adding assumption `test assumption` rendered it immediately with the `untested` badge and recorded `POST /api/idea-tickets/IDEA-15/assumptions` with `200 OK`.
- After a full page reload, the app returned to the main board shell; switching back to Idea Space and reopening `IDEA-15` still showed the title, description, microthought, and assumption from this session.

## Test Results

| ID | Result | Notes |
|---|---|---|
| TC-E2E-01 | PASS | Idea Space opened successfully. Four columns rendered, no visible crash occurred, and no error banner appeared on the initial board load. |
| TC-E2E-02 | PASS | Clicking `+ New Idea`, entering `E2E Test Idea`, and submitting created a new top card in `Drafting`. |
| TC-E2E-03 | PASS | Clicking the newly created card opened the modal with title `E2E Test Idea`. |
| TC-E2E-04 | PASS | Description `E2E test description` saved, the modal closed, and reopening the same card showed the description persisted. |
| TC-E2E-05 | PASS | After adding the required problem statement and clicking `Send to Review`, the card moved from `Drafting` to `In Review` and the browser logged `PATCH /api/idea-tickets/IDEA-15/status` with `200 OK`. |
| TC-E2E-06 | PASS | Adding microthought `test thought` showed it immediately in the modal with timestamp `just now`. |
| TC-E2E-07 | PASS | Adding assumption `test assumption` showed it immediately in the modal with the `untested` badge. |
| TC-E2E-08 | PASS | After refresh and returning to Idea Space, reopening the same card showed the title, description, microthought `test thought`, and assumption `test assumption` all persisted. |

## Evidence

- Visible UI evidence during run:
  - `Drafting` count changed from `7` to `8` after create
  - modal title `E2E Test Idea` opened successfully
  - saved card preview showed `E2E test description`
  - card moved into `In Review` and the column count changed from `0` to `1`
  - microthought list showed `test thought` with `just now`
  - assumption list showed `test assumption` with `untested`
  - after refresh, reopening the same modal still showed both `test thought` and `test assumption`
- Reload evidence:
  - switching back to Idea Space after refresh still showed the card in `In Review` with its description preview
  - reopened modal still displayed the newly added microthought and assumption
- Browser/network evidence for the fixed transition path:
  - `200 OK` on `http://127.0.0.1:5173/api/idea-tickets/IDEA-15/status`
  - `200 OK` on `http://127.0.0.1:5173/api/idea-tickets/IDEA-15/microthoughts`
  - `200 OK` on `http://127.0.0.1:5173/api/idea-tickets/IDEA-15/assumptions`

## Summary

- Passed: 8
- Failed: 0

QC conclusion: the final rerun passes all eight requested end-to-end cases on the restarted server. The live flow now covers board load, create, modal open, description persistence, draft-to-review transition, microthought creation, assumption creation, and full reload persistence without visible regressions.