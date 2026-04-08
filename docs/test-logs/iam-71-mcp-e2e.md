---
title: "Test Plan: IAM-71 MCP End-to-End Verification"
type: test
status: stable
version: 1.1.0
created: 2026-04-09
updated: 2026-04-09
authors: [qc-agent]
related:
  - docs/ba-kanban-ui-spec.md
ticket: IAM-71
---

# Test Plan: IAM-71 MCP End-to-End Verification

## Scope

Verify the Kanban MCP server end to end through its stdio tool surface and confirm the React UI reflects the resulting state changes. The run starts from zero by creating a brand new project through MCP and then exercises all 15 exposed tools at least once.

In scope:
- MCP stdio connectivity and successful execution of all 15 tools
- Project creation and discovery
- Member creation, listing, and removal rules
- Ticket creation, listing, retrieval, field updates, status updates, and parent/child creation
- Ticket annotations: comments, work log entries, and test case lifecycle
- UI reflection of MCP-driven changes in the project sidebar, board, members panel, ticket modal, comments, work log, test cases, and child ticket areas

Out of scope:
- Non-MCP REST calls as a primary test mechanism
- Browser compatibility beyond the local Playwright run
- Performance, load, and concurrency testing
- Destructive cleanup after the run, because the available MCP surface for this ticket does not include delete-project or delete-ticket tools

## Test Strategy

| Layer | Goal | Tools |
|---|---|---|
| MCP functional | Verify each stdio tool accepts valid input and returns the expected state | kanban MCP via `mcp_stdio.py` |
| Data integrity | Verify later tools operate on data created by earlier tools in one isolated project | kanban MCP |
| UI reflection | Verify UI reads and renders MCP-created data correctly without manual UI data entry | Playwright MCP |

## Environment

| Item | Value |
|---|---|
| UI URL | `http://localhost:5173` |
| MCP transport | stdio via `mcp_stdio.py` |
| Project isolation rule | Create a new project at the start of the run; do not reuse existing projects or tickets |
| Evidence for Phase 2 | Snapshot after each major UI checkpoint; screenshot on any failure |

## Test Data

Use unique values with a `[TEST][IAM-71]` prefix so the run is isolated and easy to identify.

| Entity | Planned Value |
|---|---|
| Project name | `[TEST][IAM-71] MCP E2E Project` |
| Project prefix | `M71` |
| Project color | `#0ea5e9` |
| Member A | `[TEST][IAM-71] Alice QC` |
| Member B | `[TEST][IAM-71] Bob Dev` |
| Root ticket | `[TEST][IAM-71] Root ticket` |
| Second root ticket | `[TEST][IAM-71] Searchable 50% ticket` |
| Child ticket | `[TEST][IAM-71] Child ticket` |
| Root ticket updated title | `[TEST][IAM-71] Root ticket updated` |
| Root ticket tags | `mcp`, `e2e`, `ui-sync` |
| Comment text | `[TEST][IAM-71] Comment added via MCP` |
| Work log note | `[TEST][IAM-71] Work log added via MCP` |
| Test case title | `[TEST][IAM-71] Test case added via MCP` |
| Test case proof | `playwright://iam-71-proof.png` |
| Test case note | `[TEST][IAM-71] Test case updated via MCP` |

## Execution Order

1. Projects
2. Members
3. Tickets
4. Annotations
5. UI verification

This order is intentional. Each later section depends on IDs and state produced by earlier sections.

## Preconditions

1. Kanban MCP is connected through `mcp_stdio.py` and the 15 tools are discoverable.
2. The local UI is reachable at `http://localhost:5173`.
3. The UI is pointed at the same backend data source the MCP server updates.
4. No test data for prefix `M71` exists before the run. If it does, choose a new unique prefix and update the data table before execution.

## Test Cases

### Projects

| ID | Tool Under Test | Category | Preconditions | Steps | Expected Result | Status |
|---|---|---|---|---|---|---|
| IAM-71-TC-001 | `list_projects` | Baseline | MCP connected | 1. Call `list_projects` before creating new data. 2. Inspect returned list shape. | Tool returns an array without error. Each project item exposes `id`, `name`, `prefix`, `color`, and `ticket_counter`. | ✅ Pass |
| IAM-71-TC-002 | `create_project` | Happy Path | TC-001 passed | 1. Call `create_project` with project name, prefix `M71`, and color `#0ea5e9`. 2. Save returned `project_id`. | Tool returns a created project object with a non-empty `id`, `name` matching the input, uppercase prefix `M71`, color `#0ea5e9`, and `ticket_counter` equal to `0`. | ✅ Pass |
| IAM-71-TC-003 | `list_projects` | Persistence | TC-002 passed | 1. Call `list_projects` again. 2. Find the newly created project by `id` and prefix. | The new project is present exactly once in the list, with the same `id`, `name`, prefix, color, and `ticket_counter` still at `0`. | ✅ Pass |

### Members

| ID | Tool Under Test | Category | Preconditions | Steps | Expected Result | Status |
|---|---|---|---|---|---|---|
| IAM-71-TC-004 | `list_members` | Baseline | Project created | 1. Call `list_members(project_id)`. 2. Record the default members returned. | Tool returns an array without error for the new project. If a default member exists, each item includes `id`, `name`, `color`, `project_id`, and `created_at`. | ✅ Pass |
| IAM-71-TC-005 | `add_member` | Happy Path | Project created | 1. Call `add_member(project_id, Member A, color A)`. 2. Save returned `member_a_id`. 3. Call `add_member(project_id, Member B, color B)`. 4. Save returned `member_b_id`. | Each call returns a member object with a non-empty `id`, correct `name`, correct `project_id`, and a visible color value. | ✅ Pass |
| IAM-71-TC-006 | `list_members` | Persistence | TC-005 passed | 1. Call `list_members(project_id)` again. 2. Locate Member A and Member B by ID. | The list includes both newly added members and preserves their names and colors. | ✅ Pass |
| IAM-71-TC-007 | `remove_member` | Happy Path | TC-006 passed; Member B exists and is not creator of any ticket | 1. Call `remove_member(project_id, member_b_id)`. 2. Inspect the returned result. 3. Call `list_members(project_id)` again. | `remove_member` returns `{ "ok": true }`. Member B no longer appears in `list_members`. Member A remains available. | ✅ Pass |

### Tickets

| ID | Tool Under Test | Category | Preconditions | Steps | Expected Result | Status |
|---|---|---|---|---|---|---|
| IAM-71-TC-008 | `create_ticket` | Happy Path | Project created | 1. Call `create_ticket` for the root ticket with `type=feature`, `priority=high`, `status=backlog`, markdown description, estimate `5`, due date, and tags `mcp`, `e2e`. 2. Save returned `root_ticket_id`. | Tool returns a ticket with ID format `M71-N`, correct project ID, title, type, priority, status, description, estimate, due date, tags, and `parent_id = null`. | ✅ Pass |
| IAM-71-TC-009 | `create_ticket` | Searchability | Project created | 1. Call `create_ticket` for the second root ticket titled `[TEST][IAM-71] Searchable 50% ticket`. 2. Save returned `search_ticket_id`. | Tool returns a second root ticket with a unique ID in the same project and title containing the literal `%` character. | ✅ Pass |
| IAM-71-TC-010 | `list_tickets` | Baseline List | TC-008 and TC-009 passed | 1. Call `list_tickets(project_id)`. 2. Locate both root tickets by ID. | The returned list contains both created tickets with full ticket objects, including annotations arrays and parent-child fields where applicable. | ✅ Pass |
| IAM-71-TC-011 | `list_tickets` | Filter | TC-008 and TC-009 passed | 1. Call `list_tickets(project_id, status="backlog")`. 2. Optionally call `list_tickets(project_id, q="50%")`. | Status-filtered results include only backlog tickets. Search using `q="50%"` returns the searchable ticket and does not behave like a wildcard match. | ✅ Pass |
| IAM-71-TC-012 | `get_ticket` | Detail Retrieval | Root ticket exists | 1. Call `get_ticket(root_ticket_id)`. 2. Inspect the returned payload. | Tool returns the full root ticket object with matching ID and full detail fields including `comments`, `work_log`, `test_cases`, `tags`, `parent_id`, and any member fields present in the schema. | ✅ Pass |
| IAM-71-TC-013 | `update_ticket` | Field Update | Root ticket exists | 1. Call `update_ticket(root_ticket_id, ...)` to change the title, description, type to `task`, priority to `critical`, status to `todo`, tags to `mcp`, `e2e`, `ui-sync`, and due date to a new value. 2. Call `get_ticket(root_ticket_id)` again. | The returned ticket reflects all provided changes. A follow-up `get_ticket` returns the same updated values. Fields not supplied remain unchanged. | ✅ Pass |
| IAM-71-TC-014 | `update_ticket_status` | Status Transition | Root ticket exists | 1. Call `update_ticket_status(root_ticket_id, "in-progress")`. 2. Call `get_ticket(root_ticket_id)` again. | Tool returns the updated ticket with `status = in-progress`. The follow-up read confirms the status persisted independently of the prior general update. | ✅ Pass |
| IAM-71-TC-015 | `create_child_ticket` | Parent/Child | Root ticket exists and has no parent | 1. Call `create_child_ticket(parent_ticket_id=root_ticket_id, title=Child ticket, type=bug, priority=medium, description=child description)`. 2. Save returned `child_ticket_id`. 3. Call `get_ticket(child_ticket_id)`. | Tool returns a new child ticket in the same project with a unique `M71-N` ID and `parent_id` equal to the root ticket ID. The follow-up read confirms the parent-child relationship. | ✅ Pass |
| IAM-71-TC-016 | `list_tickets` | Parent/Child Visibility | TC-015 passed | 1. Call `list_tickets(project_id)` again. 2. Locate the child ticket and root ticket. | The child ticket appears in the project list with the expected `parent_id`; the root ticket remains present and unchanged aside from prior updates. | ✅ Pass |

### Annotations

| ID | Tool Under Test | Category | Preconditions | Steps | Expected Result | Status |
|---|---|---|---|---|---|---|
| IAM-71-TC-017 | `add_comment` | Happy Path | Root ticket exists | 1. Call `add_comment(root_ticket_id, comment text, author="qc-agent")`. 2. Inspect returned `comments`. | Tool returns the updated ticket. `comments` includes a new entry with the exact text and author. | ✅ Pass |
| IAM-71-TC-018 | `add_work_log` | Happy Path | Root ticket exists | 1. Call `add_work_log(root_ticket_id, author="qc-agent", role="Tester", note=work log note)`. 2. Inspect returned `work_log`. | Tool returns the updated ticket. `work_log` includes a new entry with the exact author, role, and note. | ✅ Pass |
| IAM-71-TC-019 | `add_test_case` | Happy Path | Root ticket exists | 1. Call `add_test_case(root_ticket_id, title=test case title, status="pending", proof=null, note="created in IAM-71")`. 2. Save returned `test_case_id` from the new item. | Tool returns the updated ticket. `test_cases` includes a new test case with a non-empty `id`, correct title, and `status = pending`. | ✅ Pass |
| IAM-71-TC-020 | `update_test_case` | Happy Path | TC-019 passed | 1. Call `update_test_case(root_ticket_id, test_case_id, status="pass", proof=proof value, note=updated note)`. 2. Inspect returned `test_cases`. 3. Call `get_ticket(root_ticket_id)` as a read-back check. | The targeted test case is updated in place with `status = pass`, the supplied proof, and the supplied note. The follow-up `get_ticket` returns the same updated values. | ✅ Pass |

### UI Verification

The UI section verifies read-side synchronization only. Data setup must come from MCP, not from creating or editing equivalent entities in the browser.

| ID | Tool Under Test | Category | Preconditions | Steps | Expected Result | Status |
|---|---|---|---|---|---|---|
| IAM-71-TC-021 | `create_project`, `list_projects` | UI Sync | Project created through MCP | 1. Open `http://localhost:5173`. 2. Refresh if needed after project creation. 3. Inspect the project sidebar. | The new `[TEST][IAM-71] MCP E2E Project` appears in the sidebar with prefix `M71` and can be selected as the active project. | ✅ Pass |
| IAM-71-TC-022 | `list_members`, `add_member`, `remove_member` | UI Sync | Member A remains; Member B has been removed | 1. With project `M71` selected, open the Members panel. 2. Inspect the list of project members. | The panel shows Member A and any system-default members. Member B is absent after the MCP removal. Member colors render correctly. | ✅ Pass |
| IAM-71-TC-023 | `create_ticket`, `update_ticket_status`, `list_tickets` | UI Sync | Root and searchable root tickets exist | 1. Inspect the board columns for project `M71`. 2. Locate the updated root ticket and the searchable ticket. 3. Verify the root ticket is rendered in the `In Progress` column after the MCP status change. | Both tickets are visible on the board. The updated root ticket shows its latest title and appears in the correct status column. The searchable ticket remains in backlog unless changed later in the run. | ✅ Pass |
| IAM-71-TC-024 | `update_ticket` | UI Sync | Root ticket updated via MCP | 1. Open the root ticket from the board. 2. Inspect the modal header, metadata, description, priority, tags, estimate, and due date. | The modal reflects all MCP updates: updated title, updated markdown description, `critical` priority, `in-progress` status, updated due date, estimate, and the full tag set. | ✅ Pass |
| IAM-71-TC-025 | `create_child_ticket` | UI Sync | Child ticket created through MCP | 1. While viewing the root ticket, inspect the child/sub-ticket section. 2. Open the child ticket from the relation list if the UI provides a link. | The child ticket is listed under the root ticket with the correct child ID and title. Opening it shows `parent_id` linkage back to the root ticket. | ✅ Pass |
| IAM-71-TC-026 | `add_comment` | UI Sync | Comment added through MCP | 1. In the root ticket modal, inspect the Comments section. | The new MCP-created comment appears with the correct text and author. No manual page edit is required to make it visible after refresh or reopen. | ✅ Pass |
| IAM-71-TC-027 | `add_work_log` | UI Sync | Work log added through MCP | 1. In the root ticket modal, inspect the Work Log section. | The new MCP-created work log entry appears with the correct author, role `Tester`, and note text. | ✅ Pass |
| IAM-71-TC-028 | `add_test_case`, `update_test_case` | UI Sync | Test case created and updated through MCP | 1. In the root ticket modal, inspect the Test Cases section. 2. Find the MCP-created test case by title. | The test case appears exactly once with status `pass`, the expected proof value, and the updated note value. | ❌ Fail |
| IAM-71-TC-029 | `list_tickets` | UI Search/Filter Sync | Searchable ticket exists | 1. Use the UI search or filter controls to search for `50%`. 2. Observe the visible ticket list. | The searchable ticket is returned by the UI search flow, demonstrating that `%` in the title is displayed and searchable without breaking filtering. | ✅ Pass |

## Exit Criteria

The IAM-71 run is considered complete when all conditions below are true:

1. Every one of the 15 MCP tools has been executed at least once.
2. All MCP-created entities are visible in the UI sections that should reflect them.
3. No silent UI desynchronization is observed between MCP state and rendered state after refresh or reopen.
4. Any failures have reproduction steps, exact actual vs expected behavior, and supporting snapshot or screenshot evidence.

## Risks and Focus Areas

- UI caching or stale-query behavior may delay visibility of MCP-created changes until refresh.
- Member data may include a default member created server-side; the plan must record that baseline rather than assuming a completely empty member list.
- `remove_member` has business-rule behavior tied to ticket creators and assignees, so removal must be executed before the removed member is used by later ticket flows.
- `update_ticket` does not clear nullable fields when passed `None`; this run should verify mutation, not field-clearing semantics.
- There is no cleanup tool in scope for deleting the test project or tickets, so isolation depends on unique naming and prefixing.

## Bug Log

| Bug ID | TC | Description | Severity | Ticket |
|---|---|---|---|---|
| TBA | IAM-71-TC-028 | Test Cases section renders the MCP-created row and PASS status, but does not show the updated proof or note values anywhere in the visible UI. | Medium | Not created |

## Execution Notes for Phase 2

- Save all IDs returned by MCP immediately: `project_id`, `member_a_id`, `member_b_id`, `root_ticket_id`, `search_ticket_id`, `child_ticket_id`, and `test_case_id`.
- During UI verification, prefer a fresh reload after MCP mutations if the screen does not live-update automatically.
- Capture a Playwright snapshot at the start of each UI verification test case and a screenshot only when validating visual placement or documenting a failure.
- Delete any screenshots created during execution before closing the IAM-71 task.

## Phase 2 Results

### Saved IDs

| Key | Value |
|---|---|
| `project_id` | `24dbd5e1-1617-4f71-9687-aba1fbec9f7a` |
| `member_a_id` | `d9654d93-f13c-46b2-b495-307539a641ed` |
| `member_b_id` | `c239c17c-1c79-4426-aa58-f8158caa0476` |
| `root_ticket_id` | `M71-1` |
| `search_ticket_id` | `M71-2` |
| `child_ticket_id` | `M71-3` |
| `test_case_id` | `061813ef-b5e1-405c-8f3d-fb545238d143` |

### Outcome

- 28 of 29 test cases passed.
- 1 of 29 test cases failed: `IAM-71-TC-028`.
- All 15 MCP tools were exercised successfully during the run.
- UI synchronization was confirmed for project discovery, member updates, board placement, ticket detail updates, child-ticket navigation, comments, work log rendering, and literal `%` search.

### Failure Detail

| TC | Actual | Expected |
|---|---|---|
| `IAM-71-TC-028` | The Test Cases section showed the row exactly once and displayed `PASS`, but the UI did not render `playwright://iam-71-proof.png` or `[TEST][IAM-71] Test case updated via MCP` anywhere in the visible modal after expansion and row interaction. | The visible Test Cases UI should render the updated proof value and updated note value for the MCP-created test case. |