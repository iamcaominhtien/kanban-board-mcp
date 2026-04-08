---
title: "Test Plan: Assignee, Created By, and Project Members (IAM-39)"
type: test
status: stable
version: 1.0.1
created: 2026-04-08
updated: 2026-04-08
authors: [qc-agent]
related: []
ticket: IAM-39
---

# Test Plan: Assignee, Created By, and Project Members (IAM-39)

## Scope
Verify the IAM-39 member model, project member management UI, default member creation, ticket created-by behavior, assignee selection, member avatar rendering, and assignee-based filtering.

Out of scope: non-member project settings, non-assignee filters, and backend authorization behavior.

## Test Cases

| ID | Category | Description | Steps | Expected | Status |
|---|---|---|---|---|---|
| TC-001 | Contract | Member data shape includes `id`, `projectId`, `name`, and `color` in the UI/backend contract used by the feature | 1. Review the UI type definition and live members payload usage 2. Confirm the feature reads member identity, project ownership, display name, and color | Member model is defined and consumed with the required fields | ✅ Pass |
| TC-002 | Happy Path | Members panel can open and add a project member | 1. Open the Members panel for a test project 2. Add a new member with a custom color | New member appears in the project members list with the chosen name and color | ✅ Pass |
| TC-003 | Happy Path | Members panel can remove a project member | 1. From the Members panel, remove the member created in TC-002 | Member disappears from the list and the project stays usable | ✅ Pass |
| TC-004 | Happy Path | New project auto-creates the default `Quản trị viên` member | 1. Create a new test project 2. Open its Members panel | The new project contains a default `Quản trị viên` member without manual setup | ✅ Pass |
| TC-005 | Happy Path | Ticket creation auto-sets `created_by` and exposes it as read-only in the modal | 1. In the new test project, create a ticket 2. Open the ticket modal in view mode 3. Inspect the sidebar metadata | The ticket shows a `Created by` member chip automatically, and there is no editable `Created by` input in edit/create mode | ✅ Pass |
| TC-006 | Happy Path | Ticket assignee dropdown lists project members plus `Unassigned`, and saves changes | 1. Add another project member 2. Edit the ticket 3. Set assignee to the new member 4. Save 5. Reopen edit mode and set it back to `Unassigned` | The dropdown includes `Unassigned` and all project members, assigned value persists, and unassigning persists | ✅ Pass |
| TC-007 | Happy Path | Member avatar is shown on the ticket card and in the modal | 1. Assign the ticket to a member 2. View the ticket on the board and in the modal | Avatar initials and member color are visible in both places | ✅ Pass |
| TC-008 | Happy Path | Filter bar supports assignee filtering, including `Unassigned` | 1. Create or keep one assigned ticket and one unassigned ticket 2. Use the assignee filter chips in the filter bar | Filtering by a specific member shows only that member's tickets; `Unassigned` shows only unassigned tickets; `All Assignees` resets the list | ✅ Pass |

## Bug Log
| Bug ID | TC | Description | Severity | Ticket |
|---|---|---|---|---|