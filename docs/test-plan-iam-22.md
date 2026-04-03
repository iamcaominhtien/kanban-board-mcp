---
title: "Test Plan: UI Bug & UX Fixes (IAM-22)"
type: test-plan
status: complete
ticket: IAM-22
version: 1.0.0
created: 2026-04-02
updated: 2026-04-02
authors: [qc-agent]
---

# Test Plan: IAM-22 — UI Bug & UX Fixes

## Scope
Verification of 3 fixes: search input behavior, markdown editor focus styles, and modal backdrop interactions.

## Test Cases

| ID | Category | Title | Steps | Expected | Status |
|---|---|---|---|---|---|
| TC-01 | Happy Path | Search input type check | 1. Focus search input. 2. Type "test". 3. Look for native browser X button. | Input type is `text`. No native clear button visible. | ✅ Pass |
| TC-02 | Happy Path | Search state sync | 1. Type "auth" in search. 2. Observe board filtering. 3. Clear via backspace one by one. | Results filter/unfilter correctly in sync with React state. | ✅ Pass |
| TC-03 | Visual/UX | Markdown Editor focus state | 1. Open a ticket modal. 2. Click the description/markdown area. | Editor shows: 2px solid border (#3D0C11) + box-shadow glow (rgba(61,12,17,0.35)). | ✅ Pass |
| TC-04 | Visual/UX | Modal overlay cursor | 1. Open a ticket modal. 2. Hover over the dark backdrop. 3. Hover over the modal panel. | Cursor is `pointer` on backdrop, `default` on panel. | ✅ Pass |
| TC-05 | Happy Path | Modal backdrop click to close | 1. Open a ticket modal. 2. Click anywhere on the dark backdrop outside the modal. | Modal closes successfully. | ✅ Pass |

## Bug Log

| Bug ID | TC | Description | Severity | Ticket |
|---|---|---|---|---|
| BUG-01 | TC-03 | Markdown editor focus state (border/glow) not appearing. Found element has transparent border and no box-shadow even when focused. Screenshot: bug-iam-22-markdown-focus.png | Medium | — |
