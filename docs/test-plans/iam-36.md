---
title: "Test Plan: IAM-36 Block / Blocked-by Relationships"
type: test
status: stable
ticket: IAM-36
version: 1.1.0
created: 2026-04-08
updated: 2026-04-08
executed: 2026-04-08
authors: [GitHub Copilot]
related:
  - docs/ba-kanban-ui-spec.md
---

# Test Plan: IAM-36 Block / Blocked-by Relationships

## Scope

Validate the IAM-36 block relationship feature across the backend API and the React UI.

In scope:
- Ticket schema exposure of `blocks` and `blocked_by`
- Link and unlink behavior through API and modal UI
- Board blocked badge rendering
- Warning flow when dragging a blocked ticket into In Progress
- Root-ticket-only visibility for the Relations section

Out of scope:
- Broader ticket CRUD not directly involved in block relations
- Cross-browser compatibility beyond the local Playwright run

## Summary

| Total | Pass | Fail | Blocked |
|---|---|---|---|
| 13 | 13 | 0 | 0 |

IAM-36 feature behavior passed across backend and UI.

One environment issue was found outside the feature logic: the requested UI origin `http://127.0.0.1:5173` cannot talk to the backend because the frontend calls `http://localhost:8000` and the backend CORS policy does not allow the `127.0.0.1:5173` origin. UI execution was completed at `http://localhost:5173` as a workaround.

## Environment

- UI target requested: `http://127.0.0.1:5173`
- UI execution workaround: `http://localhost:5173`
- API target: `http://localhost:8000`

## Test Data

Planned isolated data set:
- Project prefix: `Q36`
- Root tickets: `[TEST] IAM-36 blocker A`, `[TEST] IAM-36 blocked B`, `[TEST] IAM-36 extra C`
- Child ticket under A: `[TEST] IAM-36 child of A`

## Test Cases

| ID | Category | Description | Steps | Expected | Actual | Status |
|---|---|---|---|---|---|---|
| TC1 | Backend API | POST block link updates both sides | Create A and B, `POST /tickets/A/blocks/B`, then `GET` both tickets | `A.blocks` includes B and `B.blocked_by` includes A | `200 OK`; `Q36-1.blocks = ["Q36-2"]`, `Q36-2.blocked_by = ["Q36-1"]` | ✅ Pass |
| TC2 | Backend API | DELETE block link clears both sides | Start from linked A -> B, `DELETE /tickets/A/blocks/B`, then `GET` both tickets | Neither side contains the other | `200 OK`; both arrays became empty on follow-up `GET` | ✅ Pass |
| TC3 | Backend API | Self-block is rejected | `POST /tickets/A/blocks/A` | `400` with self-block validation message | `400` with detail `A ticket cannot block itself` | ✅ Pass |
| TC4 | Backend API | PATCH ticket cannot mutate reverse block state | Link A -> B, `PATCH /tickets/A` with `{"blocks":["B"]}` | Request is ignored or rejected; no unintended mutation to reverse state | `200 OK`; `Q36-2.blocked_by` remained `["Q36-1"]`, so reverse state was not mutated by the PATCH payload | ✅ Pass |
| TC5 | Backend API | Duplicate link is idempotent | `POST /tickets/A/blocks/B` twice, then `GET` both tickets | Each relation appears only once | Second `POST` returned `200`; `Q36-1.blocks` and `Q36-2.blocked_by` each still contained one entry only | ✅ Pass |
| TC6 | UI | Root ticket shows Relations section | Open root ticket modal | Relations section is visible | Root modal for `Q36-1` displayed `Relations`, `Blocks`, and `Blocked by` controls | ✅ Pass |
| TC7 | UI | Sub-ticket hides Relations section | Open child ticket modal | Relations section is absent | Child modal for `Q36-4` showed no Relations section; only child-safe sections were rendered | ✅ Pass |
| TC8 | UI | Add blocking relation from modal updates both tickets | In root ticket modal, add relation A blocks B | A shows B in Blocks and B shows A in Blocked by | Added `Q36-2` in `Q36-1` modal; opening `Q36-2` then showed `Blocked by Q36-1` | ✅ Pass |
| TC9 | UI | Remove blocking relation from modal updates both tickets | Remove relation A blocks B | Both ticket views show relation removed | Removed relation from `Q36-2`; `Q36-2` showed `Blocked by None`, reopening `Q36-1` showed `Blocks None` | ✅ Pass |
| TC10 | UI | Blocked ticket card shows lock badge | Ensure B is blocked by A, view board card | B card shows `🔒` badge | Board card for `Q36-2` rendered with visible `🔒` badge while blocked | ✅ Pass |
| TC11 | UI | Dragging blocked ticket to In Progress shows warning | Drag blocked B from Backlog or To Do to In Progress | Warning banner appears instead of immediate move | Dragging `Q36-2` to In Progress produced banner: `This ticket is blocked. Move to In Progress anyway?` | ✅ Pass |
| TC12 | UI | Cancel from warning keeps original status | From warning state, click Cancel | Ticket remains in original column | After Cancel, Backlog count stayed `4`, In Progress count stayed `0`, and `Q36-2` remained in Backlog | ✅ Pass |
| TC13 | UI | Move Anyway bypasses warning and moves ticket | From warning state, click Move Anyway | Ticket moves to In Progress | After Move Anyway, Backlog count dropped to `3`, In Progress count became `1`, and `Q36-2` moved to In Progress | ✅ Pass |

## Findings

| ID | Severity | Summary | Evidence | Status |
|---|---|---|---|---|
| ENV-01 | Medium | `http://127.0.0.1:5173` cannot load data because the UI calls `http://localhost:8000` and backend CORS does not allow the `127.0.0.1:5173` origin. | Playwright at `127.0.0.1:5173` showed `Loading projects…` plus console `Access to XMLHttpRequest at 'http://localhost:8000/projects' ... blocked by CORS policy` and failed network requests to `/projects` | Open |