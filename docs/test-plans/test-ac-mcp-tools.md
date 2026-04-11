---
title: "Test Plan: Acceptance Criteria MCP Tools"
type: test
status: stable
version: 1.1.0
created: 2026-04-09
updated: 2026-04-09
authors: [GitHub Copilot (QC Agent)]
related:
  - docs/specs/api-contract.md
---

# Test Plan: Acceptance Criteria MCP Tools

## Scope
This plan covers Phase 1 test design for the three new MCP tools in `server/mcp_tools.py`:

- `add_acceptance_criterion(ticket_id, description)`
- `toggle_acceptance_criterion(ticket_id, criterion_id)`
- `delete_acceptance_criterion(ticket_id, criterion_id)`

In scope: happy paths, invalid `ticket_id`, invalid `criterion_id` for toggle/delete, empty description handling, and response structure verification.

Out of scope: concurrency and authorization behavior beyond the currently running local stack.

## Common Verification Points
For every non-`None` response, verify the tool returns a full ticket dictionary consistent with the `TicketRead` shape, including at minimum:

- Ticket-level fields such as `id`, `project_id`, `title`, `description`, `type`, `status`, `priority`, `tags`, `parent_id`, `created_at`, and `updated_at`
- Collection fields including `comments`, `acceptance_criteria`, `activity_log`, `work_log`, `test_cases`, `blocks`, and `blocked_by`
- `acceptance_criteria` as a list of objects shaped like `{ id: string, text: string, done: boolean }`
- The returned ticket reflecting the post-operation state for the specific tool under test

For invalid `ticket_id`, verify the tool returns `None`.

## Test Cases

| Test ID | Tool | Scenario | Steps | Expected Result |
|---|---|---|---|---|
| AC-MCP-001 | `add_acceptance_criterion` | Happy path: add a new acceptance criterion to a valid ticket | 1. Create or identify a valid ticket with `acceptance_criteria = []`. <br>2. Call `add_acceptance_criterion(ticket_id, "User can mark a task done")`. <br>3. Capture the returned ticket. | Tool returns a full ticket dict. `acceptance_criteria` now contains exactly 1 item. New item has a non-empty string `id`, `text = "User can mark a task done"`, and `done = false`. All unrelated ticket fields remain intact. |
| AC-MCP-002 | `add_acceptance_criterion` | Edge case: empty description is accepted and stored | 1. Create or identify a valid ticket with known baseline `acceptance_criteria`. <br>2. Call `add_acceptance_criterion(ticket_id, "")`. <br>3. Capture the returned ticket. | Tool returns a full ticket dict. `acceptance_criteria` count increases by 1. Newly added item has a generated `id`, `text = ""`, and `done = false`. No exception is raised. |
| AC-MCP-003 | `add_acceptance_criterion` | Edge case: invalid `ticket_id` | 1. Call `add_acceptance_criterion("INVALID-999", "Should not be added")`. | Tool returns `None`. No ticket is created or modified. |
| AC-MCP-004 | `toggle_acceptance_criterion` | Happy path: toggle an existing criterion from not done to done | 1. Create or identify a valid ticket with 1 acceptance criterion whose `done = false`. <br>2. Save that criterion's `id`. <br>3. Call `toggle_acceptance_criterion(ticket_id, criterion_id)`. <br>4. Capture the returned ticket. | Tool returns a full ticket dict. Target criterion remains present, keeps the same `id` and `text`, and `done` changes from `false` to `true`. Other acceptance criteria, if any, remain unchanged. |
| AC-MCP-005 | `toggle_acceptance_criterion` | Edge case: invalid `criterion_id` is a silent no-op | 1. Create or identify a valid ticket with a known `acceptance_criteria` list. <br>2. Save a full baseline snapshot of the ticket response. <br>3. Call `toggle_acceptance_criterion(ticket_id, "missing-criterion-id")`. <br>4. Compare the returned ticket to the baseline. | Tool returns a full ticket dict. `acceptance_criteria` is unchanged: same item count, same IDs, same texts, same `done` values. No exception is raised. |
| AC-MCP-006 | `toggle_acceptance_criterion` | Edge case: invalid `ticket_id` | 1. Call `toggle_acceptance_criterion("INVALID-999", "any-id")`. | Tool returns `None`. No ticket is modified. |
| AC-MCP-007 | `toggle_acceptance_criterion` | Structure check: toggled response still matches ticket schema | 1. Create or identify a valid ticket with at least 1 acceptance criterion. <br>2. Call `toggle_acceptance_criterion(ticket_id, criterion_id)`. <br>3. Inspect the response payload shape. | Response remains a full ticket dict, not a partial AC payload. `acceptance_criteria` stays a list of `{ id, text, done }` objects, and all required ticket-level fields are still present. |
| AC-MCP-008 | `delete_acceptance_criterion` | Happy path: delete an existing criterion from a valid ticket | 1. Create or identify a valid ticket with at least 1 acceptance criterion. <br>2. Save the target criterion's `id` and the baseline count. <br>3. Call `delete_acceptance_criterion(ticket_id, criterion_id)`. <br>4. Capture the returned ticket. | Tool returns a full ticket dict. `acceptance_criteria` count decreases by 1. The deleted criterion ID is absent from the returned list. Remaining criteria, if any, are preserved without mutation. |
| AC-MCP-009 | `delete_acceptance_criterion` | Edge case: invalid `criterion_id` is a silent no-op | 1. Create or identify a valid ticket with a known `acceptance_criteria` list. <br>2. Save a full baseline snapshot of the ticket response. <br>3. Call `delete_acceptance_criterion(ticket_id, "missing-criterion-id")`. <br>4. Compare the returned ticket to the baseline. | Tool returns a full ticket dict. `acceptance_criteria` is unchanged: same item count and same item content. No exception is raised. |
| AC-MCP-010 | `delete_acceptance_criterion` | Edge case: invalid `ticket_id` | 1. Call `delete_acceptance_criterion("INVALID-999", "any-id")`. | Tool returns `None`. No ticket is modified. |
| AC-MCP-011 | `delete_acceptance_criterion` | Structure check: delete response still matches ticket schema | 1. Create or identify a valid ticket with at least 1 acceptance criterion. <br>2. Call `delete_acceptance_criterion(ticket_id, criterion_id)`. <br>3. Inspect the response payload shape. | Response remains a full ticket dict, not a boolean or partial deletion result. `acceptance_criteria` stays a list of `{ id, text, done }` objects, and all required ticket-level fields are still present after deletion. |

## Notes for Execution
- Use test data prefixed with `[TEST]` where ticket titles or related records are created for execution.
- For silent no-op cases, compare the returned ticket against a baseline snapshot to confirm no unintended change in the acceptance criteria list.
- UI was used where the feature was exposed (`AC-MCP-001`, `AC-MCP-004`, `AC-MCP-008`); direct MCP tool invocation via `server/mcp_tools.py` was used for the edge and payload-shape checks.

## Execution Summary

- Execution date: 2026-04-09
- Environment: UI at `http://127.0.0.1:5173`, API/MCP server at `http://127.0.0.1:8000`, direct MCP checks executed with `server/.venv/bin/python`
- Result: 11 passed, 0 failed
- Bugs found: None

## Results

| Test ID | Execution Method | Actual Result | Status | Bugs / Notes |
|---|---|---|---|---|
| AC-MCP-001 | UI + ticket verification | Added 1 criterion on `TACQC-1`; persisted item ID `e48dfd4f-3d8f-403f-b8a6-0375beb4d16f`, text `User can mark a task done`, `done = false`; returned ticket shape remained complete. | PASS | None |
| AC-MCP-002 | Direct MCP | `add_acceptance_criterion` on `TACQC-5` returned a full ticket and appended criterion ID `c540102b-f4ac-4ea6-bbcf-290338fc3c2d` with `text = ""` and `done = false`. | PASS | Tool accepts empty text as designed. |
| AC-MCP-003 | Direct MCP | `add_acceptance_criterion("INVALID-999", ...)` returned `None`. | PASS | None |
| AC-MCP-004 | UI + ticket verification | Toggled the existing criterion on `TACQC-2`; criterion ID `bac30df3-40d8-43e1-9d4e-5cf865afa5ae` kept the same text and flipped to `done = true`; returned ticket shape remained complete. | PASS | None |
| AC-MCP-005 | Direct MCP | `toggle_acceptance_criterion("TACQC-4", "missing-criterion-id")` returned a full ticket; `acceptance_criteria` stayed unchanged with the same single item and `done = false`. | PASS | Silent no-op behavior confirmed. |
| AC-MCP-006 | Direct MCP | `toggle_acceptance_criterion("INVALID-999", "any-id")` returned `None`. | PASS | None |
| AC-MCP-007 | Direct MCP | Real toggle on `TACQC-4` returned a full ticket; acceptance criterion object keys stayed exactly `id`, `text`, `done`, and the targeted item flipped to `done = true`. | PASS | Schema remained correct after mutation. |
| AC-MCP-008 | UI + ticket verification | Deleted the seeded criterion from `TACQC-3`; persisted `acceptance_criteria = []`; returned ticket shape remained complete. | PASS | None |
| AC-MCP-009 | Direct MCP | `delete_acceptance_criterion("TACQC-1", "missing-criterion-id")` returned a full ticket; `acceptance_criteria` stayed unchanged with the same single item. | PASS | Silent no-op behavior confirmed. |
| AC-MCP-010 | Direct MCP | `delete_acceptance_criterion("INVALID-999", "any-id")` returned `None`. | PASS | None |
| AC-MCP-011 | Direct MCP | Real delete on `TACQC-1` returned a full ticket; `acceptance_criteria = []`; required ticket-level fields remained present after deletion. | PASS | Schema remained correct after deletion. |

## Bug Log

No bugs were found while executing these 11 acceptance tests.