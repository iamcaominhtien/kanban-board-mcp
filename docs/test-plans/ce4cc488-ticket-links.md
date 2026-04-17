---
title: "Test Plan: IAM-98 Ticket Links - Extended Relationship Types"
type: test
status: stable
ticket: IAM-98
version: 1.1.0
created: 2026-04-17
updated: 2026-04-17
executed: 2026-04-17
authors: [GitHub Copilot]
related:
  - docs/test-plans/iam-36.md
  - docs/specs/api-contract.md
---

# Test Plan: IAM-98 Ticket Links - Extended Relationship Types

## Scope

Validate the extended ticket-link feature across backend API behavior and the Relations UI in the ticket modal.

In scope:
- Ticket `links` field serialization in ticket payloads
- Bidirectional creation behavior for `relates_to`, `causes` and `caused_by`, `duplicates` and `duplicated_by`
- Bidirectional removal behavior for extended links
- UI grouping and human-readable labels in RelationsSection
- Validation behavior for self-link, duplicate link, invalid relation type, and cross-project linking
- Regression coverage for existing `blocks` and `blocked_by` rendering alongside new link groups

Out of scope:
- Broader ticket CRUD unrelated to relationships
- Browser coverage beyond the local Playwright run

## Summary

| Total | Pass | Fail | Blocked |
|---|---|---|---|
| 12 | 12 | 0 | 0 |

IAM-98 feature behavior passed across API and UI rendering.

One environment issue was found outside the feature logic: the branch's normal backend startup path fails during `init_db()` because Alembic currently has multiple heads and startup calls `upgrade("head")`. To complete QC, execution used an isolated local server at `http://127.0.0.1:8013` with the current SQLModel schema created directly in a temporary SQLite database.

## Environment

- UI target used for execution: `http://127.0.0.1:8013`
- API target used for execution: `http://127.0.0.1:8013`
- Execution method:
  - UI cases: Playwright against the local React app
  - API cases: direct HTTP requests with `curl`

## Test Data

Executed isolated fixtures:
- Project A: `[TEST] IAM-98 Project A` (`Q98A`)
- Project B: `[TEST] IAM-98 Project B` (`Q98B`)
- Tickets in Project A:
  - `Q98A-1` — `[TEST] IAM-98 A source`
  - `Q98A-2` — `[TEST] IAM-98 B target`
  - `Q98A-3` — `[TEST] IAM-98 C extra`
- Ticket in Project B:
  - `Q98B-1` — `[TEST] IAM-98 X cross-project`

## Test Cases

| ID | Category | Description | Steps | Expected | Actual | Status |
|---|---|---|---|---|---|---|
| TC1 | UI + API | Add `relates_to` link | Create A and B in same project, add A -> B as `relates_to`, inspect both tickets in UI and API | A shows `Relates to B`; B shows `Relates to A`; both payloads contain inverse `relates_to` links | Playwright added the link in the `Relates to` group on `Q98A-1`; `Q98A-2` rendered the inverse `Relates to` group and API returned `relates_to` on both tickets | ✅ Pass |
| TC2 | UI + API | Add `causes` link | Add A -> B as `causes`, inspect both tickets | A shows `Causes B`; B shows `Caused by A`; inverse relation stored correctly | Playwright added `Causes` on `Q98A-1`; `Q98A-2` rendered `Caused by`; API returned `causes` on A and `caused_by` on B | ✅ Pass |
| TC3 | UI + API | Add `caused_by` link | Add A -> B as `caused_by`, inspect both tickets | A shows `Caused by B`; B shows `Causes A`; inverse relation stored correctly | Playwright added `Caused by` on `Q98A-1`; `Q98A-2` rendered `Causes`; API returned `caused_by` on A and `causes` on B | ✅ Pass |
| TC4 | UI + API | Add `duplicates` link | Add A -> B as `duplicates`, inspect both tickets | A shows `Duplicates B`; B shows `Duplicated by A`; inverse relation stored correctly | Playwright added `Duplicates` on `Q98A-1`; `Q98A-2` rendered `Duplicated by`; API returned `duplicates` on A and `duplicated_by` on B | ✅ Pass |
| TC5 | UI + API | Add `duplicated_by` link | Add A -> B as `duplicated_by`, inspect both tickets | A shows `Duplicated by B`; B shows `Duplicates A`; inverse relation stored correctly | Playwright added `Duplicated by` on `Q98A-1`; `Q98A-2` rendered `Duplicates`; API returned `duplicated_by` on A and `duplicates` on B | ✅ Pass |
| TC6 | UI + API | Remove link from one side | Create one extended link, remove it from the source ticket UI, inspect both tickets | Link disappears from both tickets and both payloads | Playwright removed the `Duplicates` row from `Q98A-1`; follow-up API reads returned empty `links` arrays for both A and B | ✅ Pass |
| TC7 | API Negative | Self-link is blocked | `POST /tickets/{id}/links` with identical `ticket_id` and `target_id` | Request rejected with `400` and self-link validation message | `400 Bad Request` with detail `A ticket cannot link to itself` | ✅ Pass |
| TC8 | API Negative | Duplicate link is ignored | Add same A -> B relation twice, then inspect A and B payloads | API returns existing link or idempotent success and only one matching relation exists per side | First and second `POST` both returned the same link id; follow-up `GET` showed exactly one `relates_to` entry on each side | ✅ Pass |
| TC9 | API Negative | Invalid relation type is rejected | Submit relation type outside the allowed enum via HTTP | HTTP `422` validation error | `422 Unprocessable Entity` from FastAPI validation with the allowed literal values in the error payload | ✅ Pass |
| TC10 | API Negative | Cross-project link is blocked | Create A in Project A and X in Project B, try to link A -> X | HTTP `400` with cross-project validation message | `400 Bad Request` with detail `Cannot link tickets across different projects.` | ✅ Pass |
| TC11 | UI | RelationsSection shows all groups and labels | Open a root ticket modal after creating representative links | `Relations` header is visible and groups render with `Blocks`, `Blocked by`, `Relates to`, `Causes`, `Caused by`, `Duplicates`, `Duplicated by` | Modal text included `RELATIONS` plus all seven group labels; `Relates to` rendered `Q98A-2` as expected | ✅ Pass |
| TC12 | UI Regression | Existing blocks/blocked_by remain correct with new groups present | Create a classic block relationship and extended links on the same ticket, inspect modal | Existing block groups still render correctly and coexist with new link groups without label or layout regressions | `Q98A-1` rendered `Blocks -> Q98A-3` alongside `Relates to -> Q98A-2`; opening `Q98A-3` showed `Blocked by -> Q98A-1` | ✅ Pass |

## API Execution Approach

For TC7-TC10, use direct HTTP requests against `http://127.0.0.1:8000`:

- Self-link:
  - `curl -i -X POST /tickets/{id}/links -d '{"target_id":"{id}","relation_type":"relates_to"}'`
- Duplicate link:
  - issue the same valid `POST` twice, then `GET /tickets/{id}` to verify no duplicate entry exists
- Invalid relation type:
  - `curl -i -X POST /tickets/{id}/links -d '{"target_id":"{target}","relation_type":"invalid"}'`
- Cross-project link:
  - create tickets in two different projects, then `POST /tickets/{id}/links` across project boundaries

## Findings

| ID | Severity | Summary | Evidence | Status |
|---|---|---|---|---|
| ENV-01 | High | Normal backend startup on this branch fails because `server/database.py` calls Alembic `upgrade("head")` while the repo currently has multiple heads. | Direct `uv run python` / `uvicorn` startup produced `alembic.util.exc.CommandError: Multiple head revisions are present for given argument 'head'` during `init_db()` and blocked port `8000` startup for the QC run. | Open |

## Execution Notes

- All QC-created tickets and projects used `[TEST]` prefixes.
- UI verification used Playwright against the isolated local server on port `8013`.
- API negatives were verified with direct HTTP requests from the same Playwright session.
- No feature-specific functional bugs were found in IAM-98 itself.