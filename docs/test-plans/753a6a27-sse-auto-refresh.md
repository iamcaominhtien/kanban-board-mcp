---
title: "Test Plan: SSE Auto-Refresh for MCP Mutations (753a6a27)"
type: test
status: stable
version: 1.3.0
created: 2026-04-11
updated: 2026-04-11
authors: [GitHub Copilot (QC Agent)]
related:
  - docs/specs/api-contract.md
---

# Test Plan: SSE Auto-Refresh for MCP Mutations (753a6a27)

## Scope
This plan covers Phase 1 test design for the SSE-driven UI auto-refresh flow that invalidates React Query data after MCP-driven board mutations.

In scope:
- `GET /events` SSE connection behavior from the FastAPI backend
- UI refresh behavior after server-side create, update, and delete mutations
- Reconnection and stale-data recovery after the SSE stream is interrupted
- Cross-tab propagation of the same server-side invalidation event
- Guarding against accidental full page reloads during auto-refresh

Out of scope:
- Exhaustive validation of all 14 decorated MCP mutation tools individually
- Browser compatibility beyond the local development stack
- Performance/load testing with high-frequency event bursts or hundreds of concurrent subscribers
- Exact visual styling of refreshed UI elements beyond correctness of rendered board state

## Implementation Notes Under Test
- Backend SSE endpoint: `GET /events` in `server/main.py`
- Event bus: `server/events.py`
- Mutation notification mechanism: `@notify_on_success` in `server/mcp_tools.py`
- Frontend invalidation hook: `ui/src/hooks/useSSEInvalidation.ts`
- Hook mount point: `ui/src/App.tsx`

Observed implementation behavior that affects expected results:
- The client invalidates all React Query queries immediately on initial SSE connect.
- Each incoming SSE message also invalidates all queries.
- On SSE error, the client closes the connection and retries after 3000 ms.
- Catch-up after disconnect relies on query invalidation/refetch on reconnect, not on replaying missed SSE messages.

## Environment
- UI: `http://127.0.0.1:5173`
- Backend: `http://localhost:8000`
- SSE URL under test: `http://localhost:8000/events`

## Preconditions
1. UI dev server is running and reachable.
2. Backend server is running and reachable.
3. A test project exists, or one can be created through the API for this run.
4. At least one browser profile is available with DevTools Network and Console access.
5. Test-created records are prefixed with `[TEST] 753a6a27` for cleanup and traceability.

## Test Data
- Test project: `[TEST] 753a6a27 SSE Refresh`
- Seed ticket A: `[TEST] 753a6a27 Seed A`
- Seed ticket B: `[TEST] 753a6a27 Seed B`
- Create payload example:

```json
{
  "title": "[TEST] 753a6a27 Created via API",
  "type": "task",
  "priority": "medium",
  "status": "backlog",
  "description": "Created to verify SSE invalidation",
  "tags": ["test", "sse"]
}
```

- Status update payload example:

```json
{
  "status": "done"
}
```

## Coverage Goals
- Confirm the backend exposes a valid SSE stream with the expected content type and persistent connection semantics.
- Confirm the UI updates automatically after server-side mutations without any manual refresh action.
- Confirm temporary SSE interruption does not leave the board permanently stale.
- Confirm reconnect behavior matches the implemented 3-second retry logic.
- Confirm refresh happens through data invalidation/refetch rather than page navigation or hard reload.

## Test Cases

| ID | Category | Description | Steps | Expected | Status |
|---|---|---|---|---|---|
| SSE-001 | Happy Path | SSE connection establishment | 1. Start UI and backend.<br>2. Open the board UI in a browser tab for a project with visible tickets.<br>3. In DevTools Network, inspect the request to `GET /events`.<br>4. Verify response status, response headers, and that the request remains open.<br>5. Observe the initial stream payload and any keepalive comments. | `GET /events` returns `200 OK` with `Content-Type` including `text/event-stream`.<br>Connection remains open rather than closing after the first chunk.<br>Initial stream contains the connection comment (`: connected`) and later keepalive comments (`: ping`) when idle.<br>No CORS error appears in the browser console. | ✅ Pass |
| SSE-002 | Happy Path | Create ticket via API triggers automatic UI refresh | 1. Open the board UI and note the current visible ticket count in the target project.<br>2. Without using the UI create flow, call `POST /projects/{projectId}/tickets` with the `[TEST] 753a6a27 Created via API` payload.<br>3. Keep the board tab focused and do not reload the page.<br>4. Observe the board and related network activity. | The new ticket appears on the board in the correct column without manual reload.<br>A query refetch occurs after the SSE invalidation event.<br>No duplicate ticket is rendered.<br>The board updates within one refresh cycle after the mutation completes. | ✅ Pass |
| SSE-003 | Happy Path | Status update via API is reflected automatically in the UI | 1. Identify a visible existing ticket, preferably Seed A, in a non-`done` column.<br>2. Call `PATCH /tickets/{ticketId}/status` with `{ "status": "done" }` or another target status that changes columns.<br>3. Do not interact with the page beyond observing the board.<br>4. Watch the ticket move or re-render in its new status grouping. | The updated ticket moves to the correct column or list grouping automatically.<br>The old column no longer shows the ticket in its previous status position.<br>Visible ticket metadata remains consistent after refresh.<br>No manual page reload or route change is required. | ✅ Pass |
| SSE-004 | Happy Path | Delete ticket via API removes it from the board automatically | 1. Identify a visible test ticket, preferably Seed B, that is safe to remove.<br>2. Call `DELETE /tickets/{ticketId}` through the API.<br>3. Keep the UI open with no manual refresh.<br>4. Observe the board, any open modal for that ticket, and the network panel. | The deleted ticket disappears from the active board automatically after invalidation/refetch.<br>The ticket is no longer present in the visible list/column for the project.<br>If the ticket modal was open, the UI should not show stale ticket content after the refetch cycle.<br>No browser reload is triggered. | ⬜ Pending |
| SSE-005 | Resilience | SSE reconnects about 3 seconds after server interruption | 1. Open the board and confirm an active `GET /events` connection.<br>2. Interrupt the backend SSE stream by stopping the backend server, restarting it, or otherwise forcing the `EventSource` connection to error.<br>3. Measure the time from `EventSource` error/disconnect to the next reconnect attempt.<br>4. Confirm a fresh `GET /events` request is issued after recovery. | The original SSE connection errors and closes cleanly.<br>The frontend attempts reconnection after approximately 3 seconds, consistent with `setTimeout(connect, 3000)`.<br>A new `GET /events` request is visible after the server is back.<br>The app resumes live refresh behavior after reconnect. | ⬜ Pending |
| SSE-006 | Resilience / Catch-up | Stale data during disconnect is reconciled after reconnect | 1. Open the board and confirm the current state for at least one known ticket.<br>2. Force the SSE connection offline by stopping the backend or blocking the SSE endpoint.<br>3. While disconnected, perform one or more server-side mutations directly through the API or MCP path, such as create a new ticket and update another ticket's status.<br>4. Restore backend availability and allow the client to reconnect.<br>5. Observe whether the board catches up without manual reload. | After reconnect, the UI refetches and reflects all mutations performed during the disconnect window.<br>The board does not require replay of individual missed SSE messages to become correct.<br>Created tickets appear and updated tickets show their latest status once the reconnect-driven invalidation completes.<br>No stale pre-disconnect state remains visible after the refetch finishes. | ⬜ Pending |
| SSE-007 | Multi-client | Multiple browser tabs receive the same update | 1. Open the same project in two separate browser tabs or windows.<br>2. Confirm each tab establishes its own `GET /events` connection.<br>3. From outside the UI, create or update a ticket through the API.<br>4. Observe both tabs without reloading either one. | Both tabs update automatically from the shared server-side event publication.<br>Neither tab requires manual refresh to show the change.<br>Rendered board state is consistent across tabs after the refetch cycle.<br>No tab becomes stuck on stale data after the event. | ⬜ Pending |
| SSE-008 | Regression / UX | Auto-refresh does not trigger a full page reload | 1. Open the board and set temporary non-persisted UI state that would be lost on full reload, such as an open ticket modal, unsaved filter/search text, or a scrolled position that is not part of navigation state.<br>2. Trigger a server-side mutation through the API that should cause SSE invalidation.<br>3. Observe whether the page navigates, reloads, or only re-renders data-bound content.<br>4. Inspect DevTools for navigation entries, `beforeunload`/reload symptoms, and console/network behavior. | The board data refreshes without a browser-level page reload.<br>The current page URL remains unchanged except for intentional app state already present before the mutation.<br>No new document navigation request is made to the app shell.<br>Transient UI state that should survive a React Query refetch remains intact unless the updated data logically invalidates it. | ⬜ Pending |

## Risks and Watch Points for Phase 2
- Because the hook invalidates all queries on every connect and message, noisy reconnect loops could create extra fetch traffic; execution should watch for repeated refetch storms.
- Catch-up depends on successful refetch after reconnect. If refetch fails or is cached incorrectly, the board can remain stale even if SSE reconnects successfully.
- The backend event bus drops subscriber queues that fill up. Under normal manual QC this is unlikely, but it is a risk under prolonged disconnects or event bursts.
- Delete behavior should be checked both from the main board and, if relevant, with any open ticket detail view to make sure stale UI references are cleared.

## Execution Notes for Phase 2
- Capture a screenshot of the board before and after each visually verified mutation-driven refresh.
- Preserve DevTools Network logs for `/events` and ticket query refetches during reconnect scenarios.
- For the no-reload test, prefer evidence that distinguishes React data refetch from document navigation, such as absence of a new HTML document request and preservation of transient UI state.

## Phase 2 Execution Results

Execution date: 2026-04-11

Test environment used:
- Backend: `uvicorn main:app --host 0.0.0.0 --port 8000 --reload`
- UI: `npm run dev -- --host 127.0.0.1`
- Test project: `[TEST] 753a6a27 SSE Refresh` (`d7ade027-d91d-4274-a0ba-00d3f1f6edde`)
- Seed tickets at start of browser verification: `T753-1` backlog, `T753-2` todo, `T753-3` backlog

Requested test case outcomes:

| Requested TC | Result | Evidence |
|---|---|---|
| TC-001 SSE endpoint | ✅ Pass | Raw curl stream produced `: connected` immediately and repeated `: ping` keepalives. Browser-side fetch to `http://localhost:8000/events` returned `200` with `content-type: text/event-stream; charset=utf-8` and `cache-control: no-cache`. |
| TC-002 Publish on mutation | ❌ Fail | With a live curl subscription open, REST `POST /projects/{projectId}/tickets` created ticket `T753-3`, but the SSE stream never emitted `data: invalidate`; only keepalive comments were observed. |
| TC-003 Open UI and establish baseline | ✅ Pass | Playwright loaded `http://127.0.0.1:5173`, selected the `T753` project, and rendered the baseline board state without console errors. |
| TC-004 UI auto-refresh after API create | ❌ Fail | While the board stayed open, REST create added `T753-4` on the backend, confirmed by direct fetch showing 4 tickets (`T753-1` through `T753-4`). After waiting 3 seconds, the board still showed only `T753-1`, `T753-2`, and `T753-3`, with no visible refetch. |
| TC-005 UI auto-refresh after API status update | ❌ Fail | REST `PATCH /tickets/T753-2/status` changed the backend status to `done`, confirmed by `GET /tickets/T753-2`. After waiting 3 seconds, the UI still rendered `T753-2` in `To Do` and `Done` remained `0`. |
| TC-006 Browser EventSource connection | ✅ Pass | Playwright request tracing on reload captured `GET http://localhost:8000/events` with `resourceType: eventsource`. Network logs showed repeated `200 OK` responses for `/events`; console remained free of errors. |

Observed behavior summary:
- The SSE endpoint itself is healthy.
- The frontend establishes an `EventSource` connection successfully.
- REST ticket mutations do not publish the `invalidate` SSE message expected by the frontend auto-refresh design.
- Manual page reload reconciles the board to backend truth, which indicates the stale state is caused by missing invalidation rather than rendering failure.

## Regression Re-Execution Results

Execution date: 2026-04-11

Re-execution scope:
- Re-ran the previously failing cases after adding `await board_events.publish("invalidate")` to the REST routes in `server/api/tickets.py`, `server/api/projects.py`, and `server/api/members.py`
- Used a fresh project: `[TEST] 753a6a27 SSE Refresh Rerun` (`3e3d54c9-5925-4e65-ab7e-e998d0c0e1b0`)
- Seeded `T75R-1` in `Backlog`, then validated create and status-update behavior from REST while the board stayed open at `http://127.0.0.1:5173`

Requested rerun outcomes:

| Requested TC | Result | Evidence |
|---|---|---|
| TC-002 Does REST mutation publish SSE event? | ✅ Pass | Live `curl -N -H "Accept: text/event-stream" http://localhost:8000/events` subscription emitted `data: invalidate` after REST mutations. The rerun stream showed three invalidate messages total: one after seed setup, one after `POST /projects/{projectId}/tickets`, and one after `PATCH /tickets/T75R-1/status`. |
| TC-004 UI auto-updates when ticket created via API | ✅ Pass | Baseline board showed only `T75R-1` in `Backlog`. After REST create, backend `GET /projects/3e3d54c9-5925-4e65-ab7e-e998d0c0e1b0/tickets` returned `T75R-1` and `T75R-2`, and Playwright observed `[TEST] 753a6a27 Created via API` appear on the open board within 5 seconds with no manual reload. |
| TC-005 UI auto-updates when ticket status changed via API | ✅ Pass | Backend `GET /tickets/T75R-1` returned `status: done` after the REST patch, and the open board moved `T75R-1` from `Backlog` to `Done` within 5 seconds. The page URL stayed `http://127.0.0.1:5173/` and `performance.getEntriesByType("navigation").length` remained `1`, indicating no page reload. |

Observed rerun summary:
- REST routes now publish the invalidation event expected by the UI.
- The browser `EventSource` connection stays active and reacts to REST mutations.
- React Query data refresh happens without document navigation or manual reload.
- The previously reported failures are resolved by the REST-route publish fix.

## Bug Log

| Bug ID | TC | Description | Severity | Ticket |
|---|---|---|---|---|
| None | TC-002 / TC-004 / TC-005 | The earlier REST-mutation invalidation failures were verified resolved during the 2026-04-11 regression rerun after adding `await board_events.publish("invalidate")` to the REST routes. | Resolved | Not filed |

## MCP Tool Mutation Tests

Execution date: 2026-04-11

Execution scope:
- Requested MCP-only checks for `update_ticket`, `add_acceptance_criterion`, `add_test_case`, `add_work_log`, and `add_comment`
- Browser verification performed on `http://127.0.0.1:5173` because the separate Vite task had moved to `5174`, which is not allowed by the backend CORS configuration
- Test target was a dedicated project `[TEST] 753a6a27 MCP SSE` with ticket `T7MCP-1`

Observed blocker before the functional checks:
- `POST http://localhost:8000/mcp/` returned `500 Internal Server Error` for both `initialize` and `tools/call`
- In-process reproduction against the mounted app raised `RuntimeError: Task group is not initialized. Make sure to use run().` from `mcp.server.streamable_http_manager`
- Because the failure occurs inside the mounted FastMCP HTTP transport, the requested MCP mutations do not reach the tool functions and therefore cannot publish SSE invalidation events

Supporting evidence gathered during the run:
- Live `curl -N http://localhost:8000/events` subscription showed `: connected` followed only by `: ping` keepalives; no `data: invalidate` was emitted during the MCP mutation attempts
- Playwright kept the ticket modal for `T7MCP-1` open on `http://127.0.0.1:5173/?ticket=T7MCP-1`
- `performance.getEntriesByType("navigation").length` was `1` before and after the MCP attempts, so no page reload occurred
- Browser console for the clean `5173` session had `0` errors during the MCP test window
- The rendered modal text was unchanged before and after the attempts: description stayed `Baseline ticket for MCP SSE QC`, comments remained `0`, work log remained `0`, test cases remained collapsed with no entries, and acceptance criteria still showed `No acceptance criteria yet.`

Requested MCP test case outcomes:

| Requested TC | Result | Evidence |
|---|---|---|
| TC-MCP-001 `update_ticket` description change triggers UI refresh | ❌ Fail | `initialize` returned `500`, and the subsequent `tools/call` for `update_ticket` also returned `500 Internal Server Error`. The SSE stream emitted no `data: invalidate`, the modal description stayed unchanged after a 5-second wait, navigation entry count remained `1`, and console errors on the clean `5173` run remained `0`. |
| TC-MCP-002 `add_acceptance_criterion` triggers UI refresh | ❌ Fail | Blocked by the same mounted MCP transport failure. The root-cause traceback shows the HTTP app fails before tool execution with `Task group is not initialized. Make sure to use run().` The modal still showed `No acceptance criteria yet.` and the SSE stream showed only keepalive pings. |
| TC-MCP-003 `add_test_case` triggers UI refresh | ❌ Fail | Blocked by the same MCP HTTP `500` transport failure before tool execution. The UI still showed `Test Cases` with no entries after observation, there was no invalidate event on the SSE stream, navigation entry count stayed `1`, and the clean browser session had `0` console errors. |
| TC-MCP-004 `add_work_log` triggers UI refresh | ❌ Fail | Blocked by the same MCP HTTP `500` transport failure before tool execution. The UI still showed `Work Log (0)` after observation, the SSE stream showed no invalidate message, navigation entry count stayed `1`, and the clean browser session had `0` console errors. |
| TC-MCP-005 `add_comment` triggers UI refresh | ❌ Fail | Blocked by the same MCP HTTP `500` transport failure before tool execution. The UI still showed `Comments (0)` and `No comments yet.` after observation, the SSE stream showed no invalidate message, navigation entry count stayed `1`, and the clean browser session had `0` console errors. |

Conclusion:
- The SSE auto-refresh path for MCP tool mutations is not currently testable end-to-end on this branch because the mounted StreamableHTTP MCP endpoint fails before dispatching any tool call.
- The frontend SSE client and open board remained stable during the run, but there was no mutation event to consume because the MCP transport never executed the requested tools.