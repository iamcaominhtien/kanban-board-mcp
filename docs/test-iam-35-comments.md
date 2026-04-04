---
title: "Test Plan: Comments Cleanup (IAM-35)"
type: test
status: stable
version: 1.0.1
created: 2026-04-04
updated: 2026-04-04
authors: [qc-agent]
related: []
ticket: IAM-35
---

# Test Plan: Comments Cleanup (IAM-35)

## Scope
Verify the Comments Section after removing the obsolete `onDelete` prop.
Ensure comments still load, can be appended, have no delete button, and produce no console errors.

## Test Cases

| ID | Category | Description | Steps | Expected | Status |
|---|---|---|---|---|---|
| TC-001 | Happy Path | Comments are displayed | 1. Open a ticket modal with existing comments | Existing comments are shown | ✅ Pass |
| TC-002 | Happy Path | Add a comment | 1. Type a new comment 2. Click submit | New comment appears at the bottom | ✅ Pass |
| TC-003 | Boundary | No delete button visible | 1. Inspect any comment | No delete/remove button/icon exists | ✅ Pass |
| TC-004 | Negative | No JS errors in console | 1. Open console 2. Perform TC-001 & TC-002 | Console is free of errors/warnings related to CommentsSection | ✅ Pass |

## Bug Log
| Bug ID | TC | Description | Severity | Ticket |
|---|---|---|---|---|
