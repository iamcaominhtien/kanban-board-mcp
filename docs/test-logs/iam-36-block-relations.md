---
title: "Test Plan: IAM-36 Block / Blocked-by Relationships"
type: test
status: in-progress
version: 1.0.1
created: 2026-04-08
updated: 2026-04-08
authors: [GitHub Copilot]
related:
  - docs/ba-kanban-ui-spec.md
---

# Test Plan: IAM-36 Block / Blocked-by Relationships

## 1. Scope

Validate the merged IAM-36 feature across the backend model, API, and React UI.

In scope:
- `blocks` and `blocked_by` exposure on ticket payloads
- `POST /tickets/{id}/blocks/{target_id}` link behavior
- `DELETE /tickets/{id}/blocks/{target_id}` unlink behavior
- `RelationsSection` behavior in `TicketModal`
- Blocked-state lock badge on board cards
- Drag-warning banner when a blocked ticket is moved to In Progress
- Negative constraints: self-blocking and parent/child blocking

Out of scope:
- Unrelated ticket CRUD behavior
- Cross-browser coverage beyond the local Playwright run

## 2. Test Strategy

| Layer | Approach | Tools |
|---|---|---|
| Code review | Inspect merged backend and UI logic for invariant enforcement and obvious regressions | file review |
| API verification | Create isolated tickets and call link/unlink endpoints directly | browser network checks / HTTP |
| E2E | Exercise modal, board badge, and drag-warning flows in the browser | Playwright |

## 3. Test Data

Use isolated data created during execution:

| Item | Planned value |
|---|---|
| Project prefix | `Q36` |
| Root blocker ticket | `[TEST] IAM-36 blocker A` |
| Root blocked ticket | `[TEST] IAM-36 blocked B` |
| Extra root ticket | `[TEST] IAM-36 extra C` |
| Child ticket | `[TEST] IAM-36 child of A` |

## 4. Test Cases

| ID | Category | Description | Preconditions | Steps | Expected Result | Status |
|---|---|---|---|---|---|---|
| TC-01 | Code Review | Ticket schema exposes both relation fields | Main branch merged | Inspect backend model and read model serialization | `blocks` and `blocked_by` exist in storage and API read model | ⬜ Pending |
| TC-02 | Code Review | API link endpoint guards invalid relations | Main branch merged | Inspect service/router logic for self-block and parent/child constraints | Invalid relations are rejected with `400` | ⬜ Pending |
| TC-03 | E2E | Link blocker from Relations section | Test project and root tickets exist | Open blocker ticket, add blocked ticket from `Blocks` picker | Relation appears in blocker and blocked ticket views | ⬜ Pending |
| TC-04 | E2E | Unlink blocker from Relations section | Existing block relation exists | Remove relation from modal | Relation disappears from both sides | ⬜ Pending |
| TC-05 | E2E | Blocked ticket card shows lock badge | Existing block relation exists | Return to board and inspect blocked ticket card | `🔒` badge is visible on blocked ticket | ⬜ Pending |
| TC-06 | E2E | Dragging blocked ticket to In Progress warns first | Existing blocked ticket in Backlog or To Do | Drag blocked ticket into In Progress | Warning banner appears instead of immediate move | ⬜ Pending |
| TC-07 | E2E | Cancel from drag warning keeps original status | Warning banner visible | Click `Cancel` | Ticket stays in original column | ⬜ Pending |
| TC-08 | E2E | Move Anyway from drag warning overrides block warning | Warning banner visible | Click `Move Anyway` | Ticket moves to In Progress | ⬜ Pending |
| TC-09 | Negative | Self-blocking is prevented | Root ticket exists | Attempt to link ticket to itself via API and verify UI picker excludes self | API rejects self-link; UI does not offer self as selectable option | ⬜ Pending |
| TC-10 | Negative | Parent/child blocking is prevented | Parent and child ticket exist | Try to create parent/child block relation through UI and direct API | Both UI and API prevent parent-child blocking in either direction | ⬜ Pending |

## 5. Findings

| ID | Severity | Summary | Evidence | Status |
|---|---|---|---|---|
| — | — | No findings recorded yet | — | Open |

## 6. Execution Notes

- 2026-04-08: QC run started against local UI and API. Existing test plan reused and expanded with live verification.
- Execute against the merged `main` branch.
- Capture a screenshot after each major UI assertion.
- Delete all screenshot artifacts before finishing the task.