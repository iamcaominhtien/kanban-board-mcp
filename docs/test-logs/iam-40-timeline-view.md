---
title: "Test Plan: Project Timeline View (IAM-40)"
type: test
status: review
version: 1.0.2
created: 2026-04-08
updated: 2026-04-08
authors: [qc-agent]
related:
  - docs/ba-kanban-ui-spec.md
ticket: IAM-40
---

# Test Plan: Project Timeline View (IAM-40)

## Scope
Verify the timeline feature adds editable start dates to tickets, exposes a third Timeline mode in the board header, renders Gantt bars from ticket date ranges, visually marks overdue bars, opens tickets from Gantt interactions, and shows a project-wide event timeline grouped by date.

Out of scope: non-timeline board behavior, backend schema migrations beyond observable UI behavior, and historical activity correctness outside the tested project data.

## Test Cases

| ID | Category | Description | Steps | Expected | Status |
|---|---|---|---|---|---|
| TC-001 | Happy Path | Ticket modal exposes editable `start_date` / Start Date and persists it | 1. Open ticket `IAM-1` 2. Switch to edit mode 3. Set Start Date to `2026-04-12` and save 4. Reopen the ticket 5. Verify the saved value is shown | Pass on retest: the Start Date field saved successfully, and reopening the modal showed `Start Date: Apr 12, 2026` | ✅ Pass |
| TC-002 | Happy Path | Board header exposes a third Timeline view and the Gantt subview renders ticket bars from start/due dates | 1. Open the board header view switcher 2. Select Timeline 3. Stay on the default Gantt subview 4. Confirm tickets with start or due dates render bars on a horizontal time axis | Pass: the header shows Board, List, and Timeline; Timeline opens; Gantt is the default subview; the dated ticket `IAM-6` renders as a horizontal bar in the timeline area | ✅ Pass |
| TC-003 | Visual | Overdue tickets are highlighted distinctly in Gantt | 1. Open Timeline > Gantt 2. Inspect overdue ticket `IAM-6` | Pass: the overdue bar is rendered with the overdue orange color (`rgb(232, 68, 26)`), distinct from the normal blue legend state | ✅ Pass |
| TC-004 | Happy Path | Clicking a Gantt bar opens the matching ticket modal | 1. In Gantt, click the visible `IAM-6` bar 2. Observe the modal header and title | Pass: clicking the Gantt bar opens the `IAM-6` ticket modal with title `Overdue Test` | ✅ Pass |
| TC-005 | Happy Path | Event Timeline shows a chronological cross-ticket activity feed grouped by date | 1. Switch Timeline subview from Gantt to Event Timeline 2. Wait for activity to load 3. Review date groups and entries | Pass on retest: the feed loaded successfully, grouped by date (`April 8, 2026`, `April 7, 2026`, `April 4, 2026`) and showed mixed ticket events including created, status changed, and commented activity; `GET /projects/1d6c29ae-a520-4f46-a665-905e6a853094/activities` returned `200 OK` | ✅ Pass |
| TC-006 | Happy Path | Event Timeline ticket links open the related ticket modal | 1. In Event Timeline, click a ticket ID link inside an activity item | Fail: no activity items or ticket links are rendered because the Event Timeline request fails with `404 Not Found` | ❌ Fail |

## Bug Log
| Bug ID | TC | Description | Severity | Ticket |
|---|---|---|---|---|
| QC-IAM-40-01 | TC-001 | Initial failure was not reproduced on retest after backend restart and migrations; Start Date persisted correctly | High | Not created |
| QC-IAM-40-02 | TC-005, TC-006 | Initial Event Timeline load failure was not reproduced for TC-005 on retest; the activities endpoint returned `200 OK` and the feed rendered | High | Not created |