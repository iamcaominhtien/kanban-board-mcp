---
title: "Test Plan: IAM-97 UI improvements: ticket ordering & terminology"
type: test
status: stable
ticket: IAM-97
version: 1.0.1
created: 2026-04-16
updated: 2026-04-16
authors: [GitHub Copilot (QC Agent)]
related:
  - ui/src/components/Column.tsx
  - server/services/projects.py
  - ui/src/components/ProjectSidebar.tsx
  - ui/src/components/MembersPanel.tsx
---

# Test Plan: IAM-97 UI improvements: ticket ordering & terminology

## Scope

Verify the user-facing behavior requested in IAM-97:

- New projects create a default member named `Admin`
- Board columns render root tickets newest-first
- Parent-child grouping is preserved so a child renders after its parent in the same column

Out of scope:

- Member CRUD beyond the default-member seed
- Ticket ordering in list or timeline views
- Cross-column ordering behavior after drag-and-drop

## Test Approach

- UI execution in the browser via Playwright against the local Vite app
- API-assisted setup where it reduces noise and keeps the ordering checks deterministic
- Visual verification of the board layout and member list

## Test Data Strategy

- Create one isolated project named `[TEST] IAM-97 Ordering`
- Create tickets with distinct titles so card order can be asserted visually
- Keep all test data in a single project to avoid polluting existing user data

## Test Cases

| ID | Acceptance Criteria | Category | Description | Steps | Expected Result | Status |
|---|---|---|---|---|---|---|
| TC-01 | AC1 | Happy Path | New project seeds `Admin` as the default member | 1. Open the app. 2. Create a new project named `[TEST] IAM-97 Ordering`. 3. Open the Members panel for that project. | Exactly one default member is present on creation and its displayed name is `Admin`. The legacy label `Quản trị viên` is not shown. | ✅ Pass |
| TC-02 | AC2 | Happy Path | Root tickets in one column are ordered newest-first | 1. In the test project, create three root tickets in the same status column with short pauses between creations: `Root oldest`, `Root middle`, `Root newest`. 2. View the board column that contains them. | The cards appear from top to bottom as `Root newest`, `Root middle`, `Root oldest`. | ✅ Pass |
| TC-03 | AC3 | Hierarchy | Child ticket renders after its parent while root ordering remains intact | 1. Using the same project, create a child ticket under `Root oldest`. 2. Refresh or wait for the board to update. 3. Inspect the column order. | The child card appears immediately after `Root oldest`, not above it. Other root tickets remain ahead of the older parent according to newest-first ordering. | ✅ Pass |

## Execution Results

Run date: 2026-04-16
Execution mode: Playwright browser validation against `http://127.0.0.1:5173`
Overall result: PASS

### Observed Results

- TC-01: PASS. A fresh project showed `Admin` in both the assignee filter row and the Members panel. The legacy string `Quản trị viên` was not present for the new project.
- TC-02: PASS. After creating three root backlog tickets in sequence, the backlog column rendered them as `T97A-3 [TEST] Root newest`, `T97A-2 [TEST] Root middle`, `T97A-1 [TEST] Root oldest`.
- TC-03: PASS. After linking `T97A-4 [TEST] Child of Root oldest` to parent `T97A-1`, the backlog column rendered `T97A-4` immediately after `T97A-1`, while newer root tickets `T97A-3` and `T97A-2` stayed above the older parent.

### Evidence

- Members-panel snapshot showed one default member row: `Admin`.
- Board snapshot showed backlog order: `T97A-3`, `T97A-2`, `T97A-1`, `T97A-4` with the child badge `⬆ T97A-1` on `T97A-4`.
- Browser console error check returned no console errors during execution.

### Cleanup

- Deleted test tickets `T97A-1` through `T97A-4` after verification.
- Deleted test project `[TEST] IAM-97 Ordering` after verification.

## Bug Log

| Bug ID | TC | Description | Severity | Ticket |
|---|---|---|---|---|
| None | - | No bugs recorded yet. | - | - |

## Execution Notes

- Browser target: `http://localhost:5173`
- Backend target: local API proxied by Vite
- Evidence to capture during execution: one board screenshot and one members-panel screenshot