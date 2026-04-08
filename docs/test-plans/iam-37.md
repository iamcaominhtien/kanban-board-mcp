---
title: "IAM-37 Test Plan — Grouped List View"
type: test
status: stable
ticket: IAM-37
version: 1.1.5
created: 2026-04-08
updated: 2026-04-08
authors: [qc-agent]
---

# IAM-37 Test Plan — Grouped List View

## Scope

This test plan covers the new List view added beside the existing Board view, including grouping, sorting, group collapse behavior, click-to-open ticket modal, and shared Filter Bar behavior.

## Out of Scope

- Drag-and-drop behavior in Board view
- Ticket create/edit/delete flows not initiated from List view
- Backend API contract validation outside what is visible through the UI

## Execution Summary

- Executed on 2026-04-08 against `http://localhost:5173` using Playwright MCP.
- The requested origin `http://127.0.0.1:5173` was not usable for UI testing because the backend at `http://localhost:8000` rejected requests with a CORS error from the `127.0.0.1` origin.
- Seeded a disposable `[TEST] IAM-37 Data` project (`T37`) to cover status, priority, tag, search, and sort scenarios; used existing empty project `Proj F15 / ABC` for the zero-ticket case.
- Deleted the temporary `T37` project and its 7 tickets after execution.
- Re-ran `IAM-37-TC-14` and `IAM-37-TC-15` on 2026-04-08 using disposable tickets `TS2-3`, `TS2-4`, and `TS2-5` in `Test Proj 2 / TS2`, then deleted those tickets after execution.
- Re-ran `IAM-37-TC-24` on 2026-04-08 with existing ticket `TS2-6` (`title: ttttttttt`) and tag `qc-tag-only`; searching `qc-tag-only` returned only `TS2-6`, confirming tag-only matching without title or description overlap.
- Re-ran `IAM-37-TC-24` again on 2026-04-08 after the backend CORS restart. Ticket `TS2-6` was verified with tag `verified-fix`; searching `verified-fix` in List view returned only `TS2-6`, and the title still did not contain the search term.
- Final verification on 2026-04-08 restarted the backend cleanly with `uvicorn main:app --host 0.0.0.0 --port 8000`; `GET /health` returned `{"status":"ok"}` and the UI loaded without browser console errors.
- Final resolution note: the end-to-end tag-save issue is resolved after the backend fixes for the `http://localhost:5173` CORS origin and the absolute database path, so browser saves and subsequent reads hit the same project data source.
- Final verification used existing ticket `IAM-1` (`[TEST] QC Ticket`). In Edit mode, added tag `cors-fixed`, clicked `Save`, reopened the same ticket, and confirmed the modal sidebar showed both `test` and `cors-fixed` under `Tags`.
- Final `IAM-37-TC-24` re-run used the same persisted tag. In List view, searching `cors-fixed` returned only `IAM-1`, and the row title remained `[TEST] QC Ticket`, confirming tag-only matching rather than title matching.
- Result: historical suite 29 passed, 0 failed; final verification rerun 2 passed checks.

## Final Verification — 2026-04-08

| Check | Steps | Result | Evidence |
|---|---|---|---|
| Tag persistence after edit/save/reopen | 1. Restart backend with updated `main.py` via `uvicorn main:app`.<br>2. Open `http://localhost:5173`.<br>3. Open ticket `IAM-1`, click `Edit`, add tag `cors-fixed`, click `Save`, reopen the same ticket. | PASS | `/health` returned `{"status":"ok"}`. After save, the board card updated to include `cors-fixed`; reopening `IAM-1` showed sidebar text `TAGS test cors-fixed`, confirming persistence through the API read path. |
| TC-24 proper re-run in List view using `cors-fixed` | 1. Switch to `List` view.<br>2. Search for `cors-fixed`.<br>3. Verify only the tagged ticket appears and its title does not contain `cors-fixed`. | PASS | List view filtered to a single visible row: `IAM-1 [TEST] QC Ticket`. The row title did not include `cors-fixed`, so the match came from the saved tag only. |

## Test Data Requirements

Use or seed a project with enough ticket variety to cover all group types and empty states.

| Data Need | Minimum Setup |
|---|---|
| Status coverage | At least 1 ticket each in Backlog, To Do, In Progress, Done |
| Priority coverage | At least 1 ticket each in Critical, High, Medium, Low |
| Tag coverage | Tickets with tags such as `frontend`, `backend`, `api`; at least 1 ticket with no tags |
| Search coverage | Distinct titles such as `Alpha`, `Beta`, `Gamma` |
| Sort coverage | Mixed `dueDate` values and different `createdAt` timestamps |
| Multi-tag edge case | At least 1 ticket with 2+ tags, e.g. `["frontend", "api"]` |

## Test Cases

### Access, Navigation, and View Switching

| TC ID | Description | Steps | Expected Result | Status | Notes |
|---|---|---|---|---|---|
| IAM-37-TC-01 | Verify the header exposes both Board and List view options | 1. Open the app at `http://127.0.0.1:5173`.<br>2. Observe the header area above the board content. | A view switcher is visible with exactly 2 options: `Board` and `List`. | Pass | Header rendered exactly 2 view buttons: `Board` and `List`. |
| IAM-37-TC-02 | Verify user can switch from Board view to List view | 1. Start on the default board screen.<br>2. Click `List`. | List view renders in place of the kanban columns. The List button appears active, and the List toolbar is visible. | Pass | List toolbar appeared with `Group by`, sort controls, and `Collapse All`. |
| IAM-37-TC-03 | Verify user can switch back from List view to Board view | 1. Enter List view.<br>2. Click `Board`. | Kanban columns render again, Board becomes the active view, and the List-specific toolbar is no longer shown. | Pass | Board columns returned and List-only controls were hidden. |
| IAM-37-TC-04 | Verify current filters carry into List view when switching views | 1. In Board view, enter a search query and/or select a priority chip.<br>2. Click `List`. | The List view reflects the already active search and priority filters instead of resetting them. | Pass | Search `Alpha` plus `Critical` filter carried across; only `T37-1 [TEST] Alpha API` stayed visible. |

### Grouping Behavior

| TC ID | Description | Steps | Expected Result | Status | Notes |
|---|---|---|---|---|---|
| IAM-37-TC-05 | Verify List view defaults to grouping by Status | 1. Open List view.<br>2. Observe the Group by dropdown and rendered group headers. | Dropdown defaults to `By Status`. Tickets are grouped under status headings such as Backlog, To Do, In Progress, and Done. | Pass | Default `Group by` value was `status`; groups rendered for Backlog, To Do, In Progress, and Done. |
| IAM-37-TC-06 | Verify user can change grouping to Priority | 1. Open List view.<br>2. Change Group by from `By Status` to `By Priority`. | The list re-renders into priority-based groups: Critical, High, Medium, Low. | Pass | Priority groups rendered correctly for Critical, High, Medium, and Low. |
| IAM-37-TC-07 | Verify user can change grouping to Tag | 1. Open List view.<br>2. Change Group by from current value to `By Tag`. | The list re-renders into tag-based groups. Group labels use tag names from the ticket data. | Pass | Tag grouping rendered `api`, `backend`, `frontend`, and `Untagged`. |
| IAM-37-TC-08 | Verify status grouping hides empty groups | 1. Use a project or filters where at least 1 status has no matching tickets.<br>2. Open List view grouped by Status. | Only groups with at least 1 matching ticket are rendered. Empty status groups are not shown with zero rows. | Pass | Filtering to `Delta` left only the populated `To Do` group; empty status groups were not rendered. |
| IAM-37-TC-09 | Verify priority grouping hides empty groups | 1. Use filters so at least 1 priority has no matching tickets.<br>2. Open List view grouped by Priority. | Only populated priority groups are shown. Empty priority groups are not rendered. | Pass | Filtering to `Alpha` left only the populated `Critical` group; empty priority groups were not rendered. |
| IAM-37-TC-10 | Verify tag grouping creates an Untagged group when matching tickets have no tags | 1. Ensure at least 1 visible ticket has an empty tags array.<br>2. Group by `By Tag`. | An `Untagged` group appears and contains the tickets that have no tags. | Pass | `Untagged` rendered and included the untagged tickets. |
| IAM-37-TC-11 | Verify tag grouping does not render groups for tags with no matching tickets | 1. Group by `By Tag`.<br>2. Compare visible group labels against tags present on currently visible tickets only. | No empty tag group is rendered for a tag that is not present on the currently visible ticket set. | Pass | Filtering to `Gamma` left only the `Untagged` group; no empty tag groups appeared. |
| IAM-37-TC-12 | Verify a multi-tag ticket appears only once in Tag grouping | 1. Ensure 1 ticket has multiple tags, for example `frontend` and `api`.<br>2. Group by `By Tag`.<br>3. Locate that ticket across all tag groups. | The ticket appears in exactly 1 tag group and is not duplicated across multiple groups. | Pass | `[TEST] Epsilon Multi` appeared once across the tag-grouped view. |

### Sorting and Group Collapse

| TC ID | Description | Steps | Expected Result | Status | Notes |
|---|---|---|---|---|---|
| IAM-37-TC-13 | Verify sort toggle defaults to Due Date | 1. Open List view.<br>2. Observe the sort controls. | `Due Date` is the active sort option by default. | Pass | `Due Date` rendered with the active button style by default. |
| IAM-37-TC-14 | Verify Due Date sort orders tickets with earliest due dates first and undated tickets last | 1. Prepare 3+ tickets in the same visible group with mixed due dates, including 1 ticket without a due date.<br>2. Keep sort on `Due Date`.<br>3. Inspect row order within that group. | Rows are ordered by ascending due date. Tickets with no due date appear after tickets that have one. | Pass | Re-run with `TS2-3`, `TS2-4`, and `TS2-5` produced `TS2-5 -> TS2-3 -> TS2-4`, which is ascending by due date with the null due date last. |
| IAM-37-TC-15 | Verify Created sort changes row ordering within groups | 1. Open List view.<br>2. Click `Created`.<br>3. Inspect row order within a group that contains tickets with different creation timestamps. | The group remains the same, but row order updates to created-time order instead of due-date order. | Pass | Re-run with the same dataset produced `TS2-3 -> TS2-4 -> TS2-5`, confirming the `Created` toggle changes row order independently of due date. |
| IAM-37-TC-16 | Verify user can collapse and expand an individual group | 1. Open List view with multiple visible groups.<br>2. Click a group header.<br>3. Click the same group header again. | First click collapses that group and hides its rows. Second click expands it and restores the rows. | Pass | Backlog collapsed on first click and restored on second click. |
| IAM-37-TC-17 | Verify Collapse All collapses every visible group | 1. Open List view with at least 2 groups visible.<br>2. Click `Collapse All`. | All visible groups become collapsed and no ticket rows remain visible until expanded. | Pass | `Collapse All` reduced visible list rows to 0. |
| IAM-37-TC-18 | Verify Expand All restores all currently visible groups | 1. Collapse all visible groups.<br>2. Click `Expand All`. | All currently visible groups expand and their rows are shown again. | Pass | `Expand All` restored all rows after a full collapse. |
| IAM-37-TC-19 | Verify changing Group by resets prior collapsed state | 1. Group by Status and collapse 1 or more groups.<br>2. Change Group by to Priority or Tag. | The newly rendered groups start expanded instead of inheriting the previous grouping's collapsed keys. | Pass | After collapsing a Status group and switching to Priority, the new groups started expanded. |

### Row Behavior and Modal Launch

| TC ID | Description | Steps | Expected Result | Status | Notes |
|---|---|---|---|---|---|
| IAM-37-TC-20 | Verify clicking a List row opens the ticket modal | 1. Open List view.<br>2. Click any ticket row. | The ticket modal opens for the clicked ticket. | Pass | Clicking `T37-4 [TEST] Delta Backend` opened the ticket modal. |
| IAM-37-TC-21 | Verify the modal opened from List view shows the correct ticket details | 1. From List view, click a specific row with a known ID and title.<br>2. Inspect the modal header/content. | Modal content matches the clicked row's ticket ID and ticket title. | Pass | Modal showed `T37-4` and `[TEST] Delta Backend`, matching the clicked row. |
| IAM-37-TC-22 | Verify closing the modal returns the user to the List view without resetting grouping/filter state | 1. From List view, set a non-default grouping and filter state.<br>2. Open a ticket row.<br>3. Close the modal. | The user returns to List view, and the previously selected grouping, sort, and active filters remain intact. | Pass | Closing the modal returned to List view with the prior list state intact. |

### Shared Filter Bar Behavior in List View

| TC ID | Description | Steps | Expected Result | Status | Notes |
|---|---|---|---|---|---|
| IAM-37-TC-23 | Verify search by title applies to List view | 1. Open List view.<br>2. Type a unique ticket title keyword such as `Alpha` into the search field. | Only rows whose ticket titles match the query remain visible in the grouped list. | Pass | Searching `Alpha` left only `[TEST] Alpha API` visible. |
| IAM-37-TC-24 | Verify search by tag applies to List view | 1. Open List view.<br>2. Type a tag value such as `backend` into the search field. | Tickets whose tags match the query remain visible even if the title does not contain that text. | Pass | Final re-run used `IAM-1` with persisted tag `cors-fixed`; searching `cors-fixed` returned only `IAM-1`, and the search term was absent from the title `[TEST] QC Ticket`. |
| IAM-37-TC-25 | Verify priority chip filtering applies to List view | 1. Open List view.<br>2. Click a priority chip such as `Critical`. | Only tickets with the selected priority remain visible across the rendered groups. | Pass | Applying `Critical` left only `[TEST] Alpha API`. |
| IAM-37-TC-26 | Verify search and priority filter intersect in List view | 1. Enter a search query that matches more than 1 ticket.<br>2. Click a priority chip that matches only a subset of those tickets. | The list shows only tickets that satisfy both the search query and the selected priority. | Pass | Searching `[TEST]` plus filtering `High` returned only the two high-priority tickets. |
| IAM-37-TC-27 | Verify clearing filters restores the full grouped list | 1. Apply a search query and a priority filter in List view.<br>2. Clear the search input.<br>3. Click the `All` priority chip. | Full ticket visibility is restored and the grouped list repopulates with all currently available tickets. | Pass | Clearing the search and returning to `All` restored the full list for the seeded dataset. |
| IAM-37-TC-28 | Verify List view shows the empty-state message when filters remove all matching tickets | 1. Open List view.<br>2. Apply search and/or priority filters so no ticket matches. | No groups are rendered. The page shows the empty-state message `No tickets match the current filters.` | Pass | With a no-match search, no groups rendered and the expected empty-state message appeared. |
| IAM-37-TC-29 | Verify List view shows the empty-state message when the active project has no tickets | 1. Switch to a project with zero tickets.<br>2. Open List view. | No groups are rendered. The empty-state message is shown without errors or placeholder zero-count groups. | Pass | The empty project `Proj F15 / ABC` showed the expected empty-state with no zero-count placeholder groups. |

## Bug Log

No new bug ticket was created during this run. The earlier sorting failures for `IAM-37-TC-14` and `IAM-37-TC-15` were not reproducible on re-run.

The earlier final-verification blocker is resolved: after the backend fixes for the `http://localhost:5173` CORS origin and absolute DB path, project loading, tag save, reopen, and tag-only search all passed end-to-end.

## Execution Notes

- The feature was functionally testable only from `http://localhost:5173`; requests from `http://127.0.0.1:5173` were blocked by backend CORS against `http://localhost:8000`.
- The final verification restart was executed against `http://localhost:5173` exactly as requested and completed cleanly.
- No screenshot files were created during this final run; Playwright snapshots and DOM text were used for evidence, so there was no screenshot cleanup required.