---
title: "Test Plan: Create Child Ticket Inline Form (IAM-55)"
type: test
status: stable
version: 1.2.0
created: 2026-04-07
updated: 2026-04-07
authors: [GitHub Copilot (QC Agent)]
related: []
---

# Test Plan: Create Child Ticket Inline Form (IAM-55)

## Scope
Testing the "Create new child ticket" inline form within the `SubTicketsSection` React component. 

*In-scope:* Button visibility, inline form toggle, input handling, API submission (creating child ticket with proper `parentId` and `projectId`), inline error states, loading states, and UI updates without page reload.
*Out-of-scope:* Editing or deleting existing child tickets, drag-and-drop functionality within the sub-ticket list.

## Test Cases

| ID | Category | Description | Steps | Expected | Status |
|---|---|---|---|---|---|
| TC-001 | Happy Path | Check button visibility and form toggle | 1. Open TicketModal for a root ticket. <br>2. Verify "New child ticket" button is visible. <br>3. Click the button. | Inline form (input + confirm/cancel buttons) appears. (Psychological expectation: input should automatically receive focus). | ✅ Pass |
| TC-002 | Happy Path | Successfully create a child ticket | 1. Open inline form. <br>2. Enter `[TEST] Child Ticket`. <br>3. Click confirm. | 1. Loading state shown on button. <br>2. Ticket created via API. <br>3. New child ticket appears in the list instantly (no reload). <br>4. Form disappears and input is cleared for next use. | ✅ Pass |
| TC-003 | Boundary | Empty or whitespace-only title submission | 1. Open inline form. <br>2. Enter empty string or `   `. <br>3. Submit. | Submission is blocked. No API call made. (Optionally, confirm button is disabled). | ✅ Pass |
| TC-004 | Boundary | Submit via Enter key | 1. Open inline form. <br>2. Enter `[TEST] Submit via Enter`. <br>3. Press `Enter` key. | Submission proceeds identically to clicking confirm. | ✅ Pass |
| TC-005 | Negative / Error | Cancel dismisses and clears state | 1. Open inline form. <br>2. Type `[TEST] Canceled Input`. <br>3. Click Cancel. <br>4. Re-open form. | Form dismisses. Reopening shows an empty input (state was cleared). | ✅ Pass |
| TC-006 | Negative / Error | API fail shows inline error | 1. Open inline form. <br>2. Mock POST `/projects/{id}/tickets` API to return 500 error. <br>3. Submit form. | No `window.alert()`. Inline error text is displayed. Form remains open securely holding user's typed input. | ✅ Pass |
| TC-007 | Exploratory | Loading state blocks rapid double-submission | 1. Open inline form. <br>2. Enter `[TEST] Double Click`. <br>3. Double-click submit rapidly. | Form immediately enters loading state. Only 1 API request is sent; exactly 1 ticket is created. | ✅ Pass |
| TC-008 | Exploratory | Cancel via Escape key | 1. Open inline form. <br>2. Focus input. <br>3. Press `Escape` key. | Form correctly dismisses and clears without submission. | ✅ Pass |

## Bug Log

| Bug ID | TC | Description | Severity | Ticket |
|---|---|---|---|---|
| BUG-001 | TC-008 | Pressing Escape inside the "Create child ticket" input closes the entire TicketModal instead of just dismissing the inline form. | Medium | Resolved |
