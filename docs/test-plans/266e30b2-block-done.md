---
title: "Test Plan: IAM-99 Block Done Transition"
type: test
status: stable
ticket: IAM-99
version: 1.0.2
created: 2026-04-17
updated: 2026-04-17
authors: [GitHub Copilot (QC Agent)]
related:
  - docs/ba-block-done-transition.md
  - server/services/tickets.py
  - server/api/tickets.py
  - ui/src/components/TicketModal.tsx
  - ui/src/App.tsx
---

# Test Plan: IAM-99 Block Done Transition

## Scope

Validate the Block Done Transition feature for IAM-99 / 266e30b2 across the main board UI and the ticket PATCH API.

In scope:

- Per-ticket AC and TC guard toggles
- Status changes to Done from the ticket modal
- Drag-to-Done behavior from the board
- Persistence of original status after blocked transitions
- Combined PATCH behavior when enabling a guard and moving to Done in one request

Out of scope:

- Non-Done status transitions
- Wont-do validation behavior
- AC or TC CRUD beyond what is needed to set up test data

## Test Approach

- UI execution through Playwright against the local Vite app at http://127.0.0.1:5174
- API-assisted setup and verification where it reduces UI noise and keeps state deterministic
- Direct API verification for the combined PATCH bypass attempt

## Test Data Strategy

- Use one isolated project named [TEST] IAM-99 Block Done
- Use dedicated tickets prefixed with [TEST] IAM-99
- Reset ticket data between scenarios so each case has an unambiguous starting state
- Clean up all created test data after execution unless blocked by an app issue

## Test Cases

| ID | Acceptance Criteria | Category | Description | Preconditions | Steps | Expected Result | Status |
|---|---|---|---|---|---|---|---|
| TC-01 | AC Guard | Happy Path | AC guard allows Done when every AC is passed | A ticket exists in To Do with `block_done_if_acs_incomplete=true` and two ACs marked done | 1. Open the ticket. 2. Switch to edit mode. 3. Change Status to Done. 4. Save. | Ticket saves successfully, modal closes, and the card appears in Done. | ✅ Pass |
| TC-02 | AC Guard | Negative | AC guard blocks Done when at least one AC is not passed | A ticket exists in To Do with `block_done_if_acs_incomplete=true` and at least one AC with `done=false` | 1. Open the ticket. 2. Switch to edit mode. 3. Change Status to Done. 4. Save. | Transition is rejected, UI shows an error message, and the ticket does not move to Done. | ✅ Pass |
| TC-03 | AC Guard | Boundary | AC guard blocks Done when no ACs exist | A ticket exists in To Do with `block_done_if_acs_incomplete=true` and an empty AC list | 1. Open the ticket. 2. Switch to edit mode. 3. Change Status to Done. 4. Save. | Transition is rejected and the ticket remains outside Done. | ✅ Pass |
| TC-04 | AC Guard | Backward Compatibility | AC guard OFF permits Done even when ACs are incomplete | A ticket exists in To Do with `block_done_if_acs_incomplete=false` and at least one incomplete AC | 1. Open the ticket. 2. Switch to edit mode. 3. Change Status to Done. 4. Save. | Transition succeeds and the card moves to Done. | ✅ Pass |
| TC-05 | TC Guard | Happy Path | TC guard allows Done when all test cases pass | A ticket exists in To Do with `block_done_if_tcs_incomplete=true` and all TCs set to `pass` | 1. Open the ticket. 2. Switch to edit mode. 3. Change Status to Done. 4. Save. | Ticket saves successfully and the card appears in Done. | ✅ Pass |
| TC-06 | TC Guard | Negative | TC guard blocks Done when at least one TC does not pass | A ticket exists in To Do with `block_done_if_tcs_incomplete=true` and one TC with status `pending` or `fail` | 1. Open the ticket. 2. Switch to edit mode. 3. Change Status to Done. 4. Save. | Transition is rejected, UI shows an error message, and the ticket does not move to Done. | ✅ Pass |
| TC-07 | TC Guard | Boundary | TC guard blocks Done when no test cases exist | A ticket exists in To Do with `block_done_if_tcs_incomplete=true` and an empty TC list | 1. Open the ticket. 2. Switch to edit mode. 3. Change Status to Done. 4. Save. | Transition is rejected and the ticket remains outside Done. | ✅ Pass |
| TC-08 | TC Guard | Backward Compatibility | TC guard OFF permits Done even when test cases are incomplete | A ticket exists in To Do with `block_done_if_tcs_incomplete=false` and at least one non-pass TC | 1. Open the ticket. 2. Switch to edit mode. 3. Change Status to Done. 4. Save. | Transition succeeds and the card moves to Done. | ✅ Pass |
| TC-09 | Both Guards | Negative | Both guards ON block Done when both AC and TC requirements fail | A ticket exists in To Do with both toggles ON, one incomplete AC, and no passing TC set that satisfies the guard | 1. Open the ticket. 2. Switch to edit mode. 3. Change Status to Done. 4. Save. | Transition is rejected and the UI shows either both validation reasons or a combined message that makes both causes clear. | ✅ Pass |
| TC-10 | PATCH Guard | API | Combined PATCH cannot bypass validation by enabling the guard and setting Done in one request | A ticket exists in To Do with incomplete ACs and both guard fields currently false | 1. Send `PATCH /tickets/{id}` with `{ "status": "done", "block_done_if_acs_incomplete": true }`. 2. Observe the HTTP response and persisted ticket state. | API returns HTTP 400 with the AC guard error. Ticket status remains unchanged and the guard value is evaluated as enabled for that request. | ✅ Pass |
| TC-11 | Drag to Done | Negative | Dragging a guarded ticket to Done is blocked when conditions are unmet | A ticket exists outside Done with at least one guard ON and unmet conditions | 1. Drag the card into the Done column. | UI shows the backend error, the card snaps back or remains outside Done, and no silent state drift occurs. | ✅ Pass |
| TC-12 | State Consistency | Regression | Ticket status remains unchanged after any blocked Done attempt | A ticket exists in To Do with a guard ON and unmet conditions | 1. Attempt a blocked Done transition via edit or drag. 2. Re-open or refresh the board. | Ticket still shows its original status and no partial update is persisted. | ✅ Pass |

## API Verification Notes

- TC-10 should be verified with a direct PATCH request against `/tickets/{id}`.
- The response body should be checked for the backend `detail` value.
- A follow-up GET for the same ticket should confirm the status was not changed to Done.

## Execution Results

Run date: 2026-04-17
Execution mode: Playwright browser validation against `http://127.0.0.1:5174` with API-assisted setup and verification
Scope of rerun: TC-02, TC-06, TC-09
Overall result: PASS

### Observed Results

- TC-02 passed on rerun. With the AC guard enabled and one incomplete AC, the modal showed `Cannot move to Done: not all Acceptance Criteria are passed.` and the ticket remained in `todo`.
- TC-06 passed on rerun. With the TC guard enabled and one non-passing test case, the modal showed `Cannot move to Done: Test Cases are missing or not all passed.` and the ticket remained in `todo`.
- TC-09 passed on rerun. With both guards enabled and both conditions unmet, the modal showed `Cannot move to Done: not all Acceptance Criteria are passed and Test Cases are missing or not all passed.` and the ticket remained in `todo`.
- No new issues were observed in the rerun scope.

### Evidence

- Rerun used the isolated project `[TEST] IAM-99 Retest 2026-04-17` with target tickets `T99R2-1`, `T99R2-2`, and `T99R2-3`.
- `T99R2-1` displayed `Cannot move to Done: not all Acceptance Criteria are passed.` in the modal and stayed in `todo`.
- `T99R2-2` displayed `Cannot move to Done: Test Cases are missing or not all passed.` in the modal and stayed in `todo`.
- `T99R2-3` displayed `Cannot move to Done: not all Acceptance Criteria are passed and Test Cases are missing or not all passed.` in the modal and stayed in `todo`.

### Cleanup

- Test project and tickets were created under `[TEST] IAM-99 Retest 2026-04-17` for isolated execution.
- Test project, tickets, and screenshot files were deleted after the rerun and documentation update.

## Bug Log

| Bug ID | TC | Description | Severity | Ticket |
|---|---|---|---|---|
| None | TC-02, TC-06, TC-09 | No new bugs found during the targeted regression rerun. | — | — |

## Execution Notes

- Browser target: http://127.0.0.1:5174
- Backend target: http://127.0.0.1:8000 via Vite proxy
- Evidence to capture during execution: ticket modal snapshots for blocked and successful saves, plus one board screenshot for drag-to-Done behavior