title: "Test Plan: Won't Do Status and Recycle Bin (IAM-38)"
type: test
status: stable
version: 1.1.0
created: 2026-04-08
updated: 2026-04-08
authors: [qc-agent]
related: []
ticket: IAM-38
---

# Test Plan: Won't Do Status and Recycle Bin (IAM-38)

## Scope
Verify the new `wont_do` workflow from both the backend contract and the UI:
- `wont_do` status and `wont_do_reason` field availability in the ticket payload
- required reason validation when setting a root ticket to `wont_do`
- hiding `wont_do` tickets from the main board and list view
- Recycle Bin entry point, listing, reason display, and restore behavior
- prevention of setting a child ticket to `wont_do`

Out of scope:
- unrelated ticket editing flows
- project deletion and non-`wont_do` status transitions
- a timeline view, which is not present in this branch/repo

## Test Data
- Project: `[TEST] IAM-38 QC`
- Root ticket: `[TEST] IAM-38 root ticket`
- Child ticket: `[TEST] IAM-38 child ticket`
- Reason text: `Out of scope for current release`

## Test Cases

| ID | Category | Description | Steps | Expected | Status |
|---|---|---|---|---|---|
| TC-001 | Integration | Ticket payload exposes `status: wont_do` and `wont_do_reason` | 1. Create a test ticket 2. Mark it `wont_do` with a reason 3. Read the ticket payload from the API | Ticket payload contains `status: "wont_do"` and `wont_do_reason` with the saved reason | ✅ Pass |
| TC-002 | Negative | Setting `wont_do` requires a non-empty reason | 1. Open a root ticket in edit mode 2. Select `Không làm` 3. Leave reason empty or whitespace-only 4. Try to save | Save is blocked or an inline error is shown; ticket is not moved to `wont_do` | ✅ Pass |
| TC-003 | Happy Path | Root ticket can be marked `wont_do` with a valid reason | 1. Open a root ticket in edit mode 2. Select `Không làm` 3. Enter a valid reason 4. Save | Ticket is saved successfully as `wont_do` | ✅ Pass |
| TC-004 | Happy Path | `wont_do` tickets are hidden from board and list views | 1. Mark a root ticket as `wont_do` 2. Observe board 3. Switch to list view 4. Search for the ticket ID/title | Ticket is absent from both board and list view results | ✅ Pass |
| TC-005 | Happy Path | Recycle Bin entry point and panel show `wont_do` tickets with reasons | 1. Mark a root ticket as `wont_do` with a valid reason 2. Open the sidebar immediately without reloading the page 3. Open Recycle Bin 4. Inspect the test ticket row | Sidebar shows a Recycle Bin button; panel lists the `wont_do` ticket immediately and displays its reason | ✅ Pass |
| TC-006 | Happy Path | Restore returns ticket to backlog and clears `wont_do_reason` | 1. In Recycle Bin click Restore 2. Re-open the restored ticket from the board 3. Read the ticket payload from the API | Ticket returns to backlog, reappears in main views, and API shows `wont_do_reason: null` | ✅ Pass |
| TC-007 | Negative | Child tickets cannot be individually set to `wont_do` | 1. Open a child ticket in edit mode 2. Inspect the status options 3. Attempt to set `wont_do` if possible | UI does not offer `Không làm` for child tickets, preventing the invalid action | ✅ Pass |

## Bug Log
| Bug ID | TC | Description | Severity | Ticket |
|---|---|---|---|---|
| BUG-IAM-38-01 | TC-005 | Original repro on 2026-04-08: after marking a ticket `wont_do`, the Recycle Bin stayed empty until the page was reloaded. Retest after invalidating `['wont_do_tickets', projectId]` in the update hooks passed; the issue is no longer reproducible. | Medium | Not created; fix verified in QC |