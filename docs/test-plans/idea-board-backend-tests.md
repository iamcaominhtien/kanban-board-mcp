---
title: "Idea Board Backend — Test Plan"
type: test
status: draft
version: 1.0.0
created: 2026-04-25
updated: 2026-04-25
authors: [GitHub Copilot]
related:
  - docs/ba/idea-board-backend.md
  - server/tests/test_tickets.py
  - server/tests/test_mcp_tools.py
  - server/models.py
---

# Idea Board Backend — Test Plan

## Overview

This test plan defines the pre-implementation TDD test suite for Idea Board backend integration. The source of truth is the BA document at `/Users/iamcaominhtien/coder/kanban-board-mcp/docs/ba/idea-board-backend.md`, with test style aligned to the existing async pytest patterns in the current backend test suite.

The plan covers six delivery scopes plus regression coverage:

- Core `IdeaTicket` model behavior and CRUD operations
- Status transition validation and promotion into main-board tickets
- Nested JSON behaviors for microthoughts and assumptions
- Auto-managed activity trail behavior
- Frontend-to-backend integration through REST + SSE
- Regression protection for the existing main Kanban board

This plan is intentionally black-box at the behavior level even where unit tests are proposed. Assertions focus on contract, validation, persistence, and side effects defined by the BA spec rather than internal implementation details.

## Test Environment

- **Backend unit/integration framework**: `pytest` with async tests
- **HTTP API test client pattern**: `httpx.AsyncClient` with `ASGITransport(app=app)`
- **Persistence pattern**: in-memory SQLite via `sqlite+aiosqlite:///:memory:`
- **ORM/model stack**: `SQLModel` + async `AsyncSession`
- **MCP tool test pattern**: monkeypatch `mcp_tools.async_session` to test session factory
- **API integration pattern**: dependency override for `get_session`
- **Frontend E2E runner**: Playwright against local UI + backend bridge
- **Eventing**: SSE subscription to `/events`, asserting `invalidate` re-fetch behavior after idea mutations
- **Seed data**:
  - At least one project per test module
  - Separate project prefixes for main-board and idea-board isolation checks
  - TDD fixtures must avoid shared state across tests
- **Non-functional expectations to verify where relevant**:
  - IDs are deterministic by namespace pattern, not by absolute number
  - ISO timestamps are present and updated on mutation
  - Nested JSON arrays serialize and deserialize cleanly across model, MCP, and API layers

## Scope 1 — Core IdeaTicket Model + CRUD

### Unit Tests

### TC-S1-1: Create idea ticket with required fields only
- **Type**: Unit
- **Precondition**: A valid project exists and the idea ticket store is empty for that project.
- **Steps**:
  1. Call `create_idea_ticket` with `project_id` and `title` only.
  2. Inspect the returned record.
- **Expected Result**: A new idea ticket is returned with an auto-generated ID matching `IDEA-N`, `idea_status="raw"`, default ICE scores of 3, empty/default optional fields, and project linkage preserved.
- **Status**: Not Run

### TC-S1-2: Create idea ticket with all optional fields
- **Type**: Unit
- **Precondition**: A valid project exists.
- **Steps**:
  1. Call `create_idea_ticket` with title plus description, color, emoji, energy, tags, and problem statement.
  2. Inspect all persisted fields in the returned record.
- **Expected Result**: All optional fields are stored exactly as supplied, defaults are retained for unspecified fields, and nested arrays initialize as empty arrays.
- **Status**: Not Run

### TC-S1-4: list_idea_tickets filters by idea_status
- **Type**: Unit
- **Precondition**: The same project contains idea tickets in at least `raw`, `brewing`, and `validated` states.
- **Steps**:
  1. Call `list_idea_tickets(project_id=<project>, idea_status="brewing")`.
  2. Inspect the returned collection.
- **Expected Result**: Only idea tickets with `idea_status="brewing"` are returned, and no tickets from other projects or states appear.
- **Status**: Not Run

### TC-S1-5: list_idea_tickets with search query q
- **Type**: Unit
- **Precondition**: The project contains ideas where the query string appears in title for one record and description for another, plus at least one non-match.
- **Steps**:
  1. Call `list_idea_tickets(project_id=<project>, q=<query>)`.
  2. Inspect matched result titles and descriptions.
- **Expected Result**: The result set includes records whose title or description contains the query substring and excludes non-matching records.
- **Status**: Not Run

### TC-S1-7: update_idea_ticket clamps ice_impact/effort/confidence to 1–5
- **Type**: Unit
- **Precondition**: An idea ticket exists with default ICE values.
- **Steps**:
  1. Call `update_idea_ticket` with `ice_impact=0`, `ice_effort=9`, and `ice_confidence=-3`.
  2. Inspect the updated record.
- **Expected Result**: ICE values are clamped to `1`, `5`, and `1` respectively, and the record remains otherwise valid.
- **Status**: Not Run

### Integration Tests (API endpoint)

### TC-S1-3: get_idea_ticket returns correct data
- **Type**: Integration
- **Precondition**: An idea ticket exists in the database with non-default fields and nested arrays.
- **Steps**:
  1. Send `GET /api/idea-tickets/:id` for the known idea ticket.
  2. Compare the response payload with the seeded record.
- **Expected Result**: The API returns HTTP success and the full idea ticket payload, including nested arrays and timestamps, with no field loss or casing mismatch.
- **Status**: Not Run

### TC-S1-6: update_idea_ticket updates fields and appends activity trail entry
- **Type**: Integration
- **Precondition**: An idea ticket exists with known title, description, and empty or known activity trail baseline.
- **Steps**:
  1. Send `PATCH /api/idea-tickets/:id` with a subset of fields to change.
  2. Retrieve the updated ticket.
  3. Inspect the latest activity trail entry.
- **Expected Result**: The supplied fields are updated, `last_touched_at` changes, and the activity trail includes a new `Fields updated: ...` entry listing only changed fields.
- **Status**: Not Run

### TC-S1-8: delete_idea_ticket removes the record
- **Type**: Integration
- **Precondition**: An idea ticket exists and is retrievable.
- **Steps**:
  1. Send `DELETE /api/idea-tickets/:id`.
  2. Attempt to retrieve the same ticket again.
  3. List idea tickets for the project.
- **Expected Result**: The delete operation reports success, the deleted record is no longer retrievable, and it no longer appears in project listings.
- **Status**: Not Run

## Scope 2 — Status Transitions + Promote to Ticket

### Unit Tests

### TC-S2-1: Valid transition raw → brewing succeeds
- **Type**: Unit
- **Precondition**: An idea ticket exists in `raw` status.
- **Steps**:
  1. Call `update_idea_status(ticket_id=<id>, new_status="brewing")`.
  2. Inspect the returned record.
- **Expected Result**: The transition succeeds, the ticket now has `idea_status="brewing"`, and `last_touched_at` updates.
- **Status**: Not Run

### TC-S2-2: Valid transition brewing → validated succeeds
- **Type**: Unit
- **Precondition**: An idea ticket exists in `brewing` status.
- **Steps**:
  1. Call `update_idea_status(..., new_status="validated")`.
  2. Inspect the returned record.
- **Expected Result**: The transition succeeds and the returned record reflects `validated` status with an updated timestamp.
- **Status**: Not Run

### TC-S2-3: Valid transition validated → approved succeeds
- **Type**: Unit
- **Precondition**: An idea ticket exists in `validated` status and includes a non-empty problem statement.
- **Steps**:
  1. Call `update_idea_status(..., new_status="approved")`.
  2. Inspect the returned record.
- **Expected Result**: The transition succeeds and the idea is now eligible for promotion.
- **Status**: Not Run

### TC-S2-4: Invalid transition raw → approved raises ValueError
- **Type**: Unit
- **Precondition**: An idea ticket exists in `raw` status.
- **Steps**:
  1. Call `update_idea_status(..., new_status="approved")`.
  2. Capture the failure.
- **Expected Result**: The call raises `ValueError` with an invalid transition message and does not mutate the record.
- **Status**: Not Run

### TC-S2-5: dropped → raw revival works
- **Type**: Unit
- **Precondition**: An idea ticket exists in `dropped` status.
- **Steps**:
  1. Call `update_idea_status(..., new_status="raw")`.
  2. Inspect the returned record.
- **Expected Result**: The revival succeeds and the idea returns to `raw` without losing prior non-status data.
- **Status**: Not Run

### TC-S2-7: Promote non-approved idea raises ValueError
- **Type**: Unit
- **Precondition**: An idea ticket exists in a non-approved status with a valid project and problem statement.
- **Steps**:
  1. Call `promote_idea_to_ticket` for the idea.
  2. Capture the failure.
- **Expected Result**: The call raises `ValueError` indicating the idea must be approved to promote, and no main-board ticket is created.
- **Status**: Not Run

### TC-S2-8: Promote without problem_statement raises ValueError
- **Type**: Unit
- **Precondition**: An idea ticket exists in `approved` status with `problem_statement` null or blank.
- **Steps**:
  1. Call `promote_idea_to_ticket` for the idea.
  2. Capture the failure.
- **Expected Result**: The call raises `ValueError` stating that problem statement is required and no new main-board ticket is created.
- **Status**: Not Run

### Integration Tests (API endpoint)

### TC-S2-6: promote_idea_to_ticket creates real Ticket and sets promotedToTicketId
- **Type**: Integration
- **Precondition**: An approved idea ticket exists with a non-empty problem statement, and the target project exists.
- **Steps**:
  1. Send `POST /api/idea-tickets/:id/promote`.
  2. Retrieve the returned main-board ticket.
  3. Retrieve the source idea ticket.
- **Expected Result**: A real main-board ticket is created in the target project, the idea stores `promoted_to_ticket_id` and `promoted_at`, and the ticket description includes the idea description plus problem statement per BA contract.
- **Status**: Not Run

## Scope 3 — Microthoughts

### Unit Tests

### TC-S3-1: add_microthought appends entry with uuid id and timestamp
- **Type**: Unit
- **Precondition**: An idea ticket exists with an empty microthoughts array.
- **Steps**:
  1. Call `add_microthought(ticket_id=<id>, text=<markdown>)`.
  2. Inspect the latest microthought entry.
- **Expected Result**: A new microthought is appended with a generated UUID-like `id`, the submitted text, and a non-empty ISO timestamp.
- **Status**: Not Run

### TC-S3-2: add_microthought updates last_touched_at
- **Type**: Unit
- **Precondition**: An idea ticket exists with a captured baseline `last_touched_at` value.
- **Steps**:
  1. Call `add_microthought`.
  2. Compare `last_touched_at` before and after the call.
- **Expected Result**: `last_touched_at` is advanced to a newer timestamp.
- **Status**: Not Run

### Integration Tests (API endpoint)

### TC-S3-3: delete_microthought removes correct entry
- **Type**: Integration
- **Precondition**: An idea ticket exists with at least two microthoughts.
- **Steps**:
  1. Send `DELETE /api/idea-tickets/:id/microthoughts/:mid` for one known microthought.
  2. Retrieve the idea ticket.
- **Expected Result**: Only the targeted microthought is removed; all other microthoughts remain intact and ordered consistently.
- **Status**: Not Run

### TC-S3-4: delete_microthought with unknown id raises ValueError
- **Type**: Integration
- **Precondition**: An idea ticket exists and the supplied microthought ID does not belong to it.
- **Steps**:
  1. Send `DELETE /api/idea-tickets/:id/microthoughts/:unknown_id`.
  2. Inspect the error response.
- **Expected Result**: The request fails with an error mapped from `ValueError`, no microthought is removed, and the ticket remains unchanged.
- **Status**: Not Run

## Scope 4 — Assumptions

### Unit Tests

### TC-S4-1: add_assumption creates entry with status untested
- **Type**: Unit
- **Precondition**: An idea ticket exists with an empty assumptions array.
- **Steps**:
  1. Call `add_assumption(ticket_id=<id>, text=<markdown>)`.
  2. Inspect the created assumption entry.
- **Expected Result**: A new assumption is appended with generated ID, supplied text, and status `untested`.
- **Status**: Not Run

### TC-S4-2: update_assumption_status to validated
- **Type**: Unit
- **Precondition**: An idea ticket exists with one assumption in `untested` state.
- **Steps**:
  1. Call `update_assumption_status(..., status="validated")`.
  2. Inspect the updated assumption.
- **Expected Result**: The target assumption status changes to `validated` and the rest of the assumption fields remain intact.
- **Status**: Not Run

### TC-S4-3: update_assumption_status to invalidated
- **Type**: Unit
- **Precondition**: An idea ticket exists with one assumption in `untested` or `validated` state.
- **Steps**:
  1. Call `update_assumption_status(..., status="invalidated")`.
  2. Inspect the updated assumption.
- **Expected Result**: The target assumption status changes to `invalidated` and `last_touched_at` updates.
- **Status**: Not Run

### TC-S4-4: update_assumption_status to invalid value raises ValueError
- **Type**: Unit
- **Precondition**: An idea ticket exists with a valid assumption.
- **Steps**:
  1. Call `update_assumption_status(..., status="maybe")`.
  2. Capture the failure.
- **Expected Result**: The call raises `ValueError` for invalid status and the stored assumption status does not change.
- **Status**: Not Run

### Integration Tests (API endpoint)

### TC-S4-5: delete_assumption removes correct entry
- **Type**: Integration
- **Precondition**: An idea ticket exists with at least two assumptions.
- **Steps**:
  1. Send `DELETE /api/idea-tickets/:id/assumptions/:aid` for one known assumption.
  2. Retrieve the idea ticket.
- **Expected Result**: The targeted assumption is removed, the non-targeted assumption remains, and the mutation updates `last_touched_at`.
- **Status**: Not Run

### TC-S4-6: delete_assumption with unknown id raises ValueError
- **Type**: Integration
- **Precondition**: An idea ticket exists and the supplied assumption ID is not present.
- **Steps**:
  1. Send `DELETE /api/idea-tickets/:id/assumptions/:unknown_id`.
  2. Inspect the error response.
- **Expected Result**: The request fails with the mapped error, no assumption is removed, and the record remains unchanged.
- **Status**: Not Run

## Scope 5 — Activity Trail

### Unit Tests

### TC-S5-1: create_idea_ticket adds Idea created activity entry
- **Type**: Unit
- **Precondition**: A valid project exists.
- **Steps**:
  1. Call `create_idea_ticket`.
  2. Inspect `activity_trail` on the returned record.
- **Expected Result**: The trail contains a new entry labeled `Idea created` with generated ID and timestamp.
- **Status**: Not Run

### TC-S5-2: update_idea_ticket adds Fields updated entry listing changed fields
- **Type**: Unit
- **Precondition**: An idea ticket exists with a known baseline activity trail.
- **Steps**:
  1. Call `update_idea_ticket` with multiple changed fields.
  2. Inspect the newest activity entry.
- **Expected Result**: The newest activity label is `Fields updated: ...` and lists only the fields changed in that request.
- **Status**: Not Run

### TC-S5-4: add_microthought adds Microthought added activity entry
- **Type**: Unit
- **Precondition**: An idea ticket exists.
- **Steps**:
  1. Call `add_microthought`.
  2. Inspect the newest activity entry.
- **Expected Result**: The activity trail includes `Microthought added` with a fresh timestamp.
- **Status**: Not Run

### Integration Tests (API endpoint)

### TC-S5-3: update_idea_status adds Status changed X → Y entry
- **Type**: Integration
- **Precondition**: An idea ticket exists in `raw` or `brewing` state.
- **Steps**:
  1. Send `PATCH /api/idea-tickets/:id/status` with a valid target status.
  2. Retrieve the updated idea ticket.
- **Expected Result**: The activity trail contains a new entry in the exact format `Status changed: X → Y` and the status mutation persists.
- **Status**: Not Run

### TC-S5-5: promote_idea_to_ticket adds Promoted to ticket entry
- **Type**: Integration
- **Precondition**: An approved idea ticket with problem statement exists and can be promoted.
- **Steps**:
  1. Send `POST /api/idea-tickets/:id/promote`.
  2. Retrieve the idea ticket after promotion.
  3. Inspect the newest activity entry.
- **Expected Result**: The activity trail contains `Promoted to ticket <ticket-id>` and the ticket ID matches the created main-board ticket.
- **Status**: Not Run

## Scope 6 — Frontend Integration

### E2E Tests (Playwright)

### TC-S6-1: Opening Idea Board for a project loads real tickets from API
- **Type**: E2E
- **Precondition**: Backend is running with at least two idea tickets for the selected project and the frontend is configured to use the real API.
- **Steps**:
  1. Open the Idea Board for the target project.
  2. Wait for the initial board load.
  3. Verify the rendered cards match backend-seeded ticket titles.
  4. Refresh the page and verify the same records reappear.
- **Expected Result**: The board displays backend-backed idea tickets, no mock-only records appear, and refresh preserves the same dataset.
- **Status**: Not Run

### TC-S6-2: Creating a new idea via UI persists to backend and appears after refresh
- **Type**: E2E
- **Precondition**: Backend and frontend are running, and the user is on a project Idea Board page.
- **Steps**:
  1. Create a new idea from the UI with a unique `[TEST]` title.
  2. Confirm the idea appears in the `raw` column.
  3. Refresh the page.
  4. Search or scan for the same idea.
- **Expected Result**: The new idea persists to the backend and still appears after refresh with the same title and namespace ID.
- **Status**: Not Run

### TC-S6-3: Dragging an idea to a new column updates status via API
- **Type**: E2E
- **Precondition**: A movable idea exists in a source column with a valid next-state target.
- **Steps**:
  1. Drag the idea card from its current column to a valid target column.
  2. Wait for the UI to settle.
  3. Refresh the page or reopen the board.
- **Expected Result**: The idea remains in the destination column after refresh, proving the status update persisted through the backend.
- **Status**: Not Run

### TC-S6-4: Editing description in modal and saving calls PATCH and updates last_touched_at
- **Type**: E2E
- **Precondition**: An existing idea ticket is visible in the UI and its detail modal can be opened.
- **Steps**:
  1. Open the idea detail modal.
  2. Change the description content.
  3. Save the change.
  4. Reopen or refresh the idea detail view.
- **Expected Result**: The new description persists after reload and the displayed metadata or fetched record reflects a newer `last_touched_at` value.
- **Status**: Not Run

### TC-S6-5: After promotion, promotion banner shows real ticket ID from backend
- **Type**: E2E
- **Precondition**: An approved idea with a non-empty problem statement exists and the promote action is available in the UI.
- **Steps**:
  1. Open the approved idea.
  2. Trigger promotion.
  3. Wait for success feedback.
  4. Inspect the banner or toast and reopen the idea if needed.
- **Expected Result**: The UI displays the actual created main-board ticket ID returned by the backend and the idea shows promoted state consistently after reload.
- **Status**: Not Run

## Regression Suite

### TC-REG-1: list_tickets main board still works after idea_ticket table is added
- **Type**: Integration
- **Precondition**: A project exists with at least one normal Kanban ticket and the idea_ticket schema is present.
- **Steps**:
  1. Send the existing main-board list tickets request.
  2. Inspect the response shape and contents.
- **Expected Result**: `list_tickets` returns the expected main-board tickets with unchanged contract and no idea-ticket leakage.
- **Status**: Not Run

### TC-REG-2: create_ticket main board still works
- **Type**: Integration
- **Precondition**: A project exists for normal ticket creation.
- **Steps**:
  1. Create a standard main-board ticket through the existing endpoint or MCP tool.
  2. Retrieve the created ticket.
- **Expected Result**: Normal ticket creation still succeeds with the existing ID namespace and default behaviors unaffected.
- **Status**: Not Run

### TC-REG-3: update_ticket_status main board still works
- **Type**: Integration
- **Precondition**: A standard main-board ticket exists.
- **Steps**:
  1. Update the ticket status using the existing main-board status path.
  2. Retrieve the ticket.
- **Expected Result**: The main-board ticket status changes successfully and activity logging remains intact.
- **Status**: Not Run

### TC-REG-4: Creating an idea ticket does not create a main board ticket
- **Type**: Integration
- **Precondition**: A project exists with a known baseline main-board ticket count.
- **Steps**:
  1. Create a new idea ticket.
  2. List main-board tickets for the same project.
- **Expected Result**: The idea ticket is created only in the idea domain and the main-board ticket count is unchanged.
- **Status**: Not Run

### TC-REG-5: Promoting idea to main board ticket keeps IDs in different namespaces
- **Type**: Integration
- **Precondition**: An approved idea exists and can be promoted.
- **Steps**:
  1. Promote the idea to a main-board ticket.
  2. Compare the source idea ID and created ticket ID.
- **Expected Result**: The idea keeps its `IDEA-N` ID, the new ticket uses the project prefix namespace, and no namespace collision occurs.
- **Status**: Not Run

### TC-REG-6: Deleting an idea ticket does not delete any main board ticket
- **Type**: Integration
- **Precondition**: A project contains at least one normal ticket and one separate idea ticket.
- **Steps**:
  1. Delete the idea ticket.
  2. Retrieve or list the main-board tickets.
- **Expected Result**: The idea ticket is removed while existing main-board tickets remain unchanged and retrievable.
- **Status**: Not Run

### TC-REG-7: Project deletion cascade removes idea tickets for that project
- **Type**: Integration
- **Precondition**: A project exists with one or more idea tickets associated to it.
- **Steps**:
  1. Delete the project through the existing project deletion path.
  2. Attempt to list or retrieve the project’s idea tickets.
- **Expected Result**: Idea tickets linked to the deleted project are removed or become inaccessible in line with cascade rules, with no orphaned idea records remaining.
- **Status**: Not Run

### TC-REG-8: SSE invalidate event fires after each idea ticket mutation
- **Type**: Integration
- **Precondition**: An SSE client is subscribed to `/events` and an idea ticket exists for mutation scenarios.
- **Steps**:
  1. Perform representative idea mutations: create, update, status change, microthought add, assumption add, and delete.
  2. Observe emitted SSE events after each mutation.
- **Expected Result**: Each idea mutation emits an `invalidate` event so the frontend can re-fetch and stay synchronized.
- **Status**: Not Run