---
title: "Test Plan: IAM-113 Wave 2 CSS Polish"
type: test
status: stable
version: 1.0.1
created: 2026-04-18
updated: 2026-04-18
authors: [GitHub Copilot]
related:
  - docs/test-iam-113-wave-1-css-quick-wins.md
---

# Test Plan: IAM-113 Wave 2 CSS Polish

## 1. Scope
Visual QC for eight CSS fixes merged into the web app and verified against http://127.0.0.1:5174.

In scope:
- Ticket card secondary text legibility
- Hover state lift and shadow quality
- Keyboard focus ring on ticket cards
- Filter bar group separation
- Unassigned badge styling in ticket modal
- Timestamp layout in ticket modal
- Close button alignment in ticket modal
- Column header top divider styling

Out of scope:
- Functional CRUD behavior unrelated to these fixes
- Cross-browser verification
- Responsive/mobile checks unless needed to expose the target styles

## 2. Test Strategy

| Layer | Approach | Tools |
|---|---|---|
| Visual regression | Manual visual verification with saved evidence | Playwright MCP screenshots |
| Interaction | Hover, keyboard focus, modal open | Playwright MCP |
| Sanity | Page load and visible seeded board data | Browser snapshot |

## 3. Test Cases

| ID | Description | Preconditions | Steps | Expected Result | Status |
|---|---|---|---|---|---|
| TC-01 | Secondary ticket text is readable | Board loads with visible tickets | Open board, capture close-up of a ticket card | Due date and sub-task progress use a readable mid-tone, not washed out | ❌ Fail |
| TC-02 | Ticket hover uses lift plus subtle shadow | Board loads with visible tickets | Hover a ticket card and compare to resting state | Card lifts slightly with a soft shadow, without opacity fade or harsh block shadow | ✅ Pass |
| TC-03 | Keyboard focus ring appears on ticket card | Board loads with visible tickets | Use keyboard Tab until a ticket card is focused | Orange focus ring appears clearly around the card | ❌ Fail |
| TC-04 | Filter bar separates priority and assignee chip groups | Filter bar visible | Inspect filter bar | A subtle separator exists between priority chips and assignee chips | ✅ Pass |
| TC-05 | Unassigned value renders as a pill badge | Open a ticket with no assignee | Open target ticket modal | Unassigned appears as a pill badge, not italic gray text | ❌ Fail |
| TC-06 | Created and Updated timestamps stay on one line | Any ticket modal open | Inspect metadata row | Created and Updated timestamps are shown inline on the same row | ✅ Pass |
| TC-07 | Close button icon is centered | Any ticket modal open | Inspect modal close button | The x icon is visually centered within the button hit area | ❌ Fail |
| TC-08 | Column headers show a dark top divider | Board columns visible | Inspect top edge of each column header | A subtle dark line is visible at the top and distinct from the column background | ✅ Pass |

## 4. Edge Cases & Negative Tests
- [ ] Hover state remains subtle when multiple cards are visible
- [ ] Focus ring remains visible against surrounding colors
- [ ] Unassigned badge remains visually distinct from normal body text

## 5. Coverage Goals

| Area | Target |
|---|---|
| Requested CSS fixes | 8 of 8 visually verified |
| Evidence capture | Screenshot for each requested fix |

## 6. Test Data
Relies on existing board data already available at the target URL. No new data created.

## 7. Execution Notes
- Evidence folder: /Users/iamcaominhtien/coder/kanban-board-mcp/docs/ui-audit/qc-wave2/
- Pass/fail is based on visual inspection of the rendered UI, not DOM-only assertions.

## 8. Bug Log
| Bug ID | TC | Description | Severity | Ticket |
|---|---|---|---|---|

## 9. Execution Results

| Fix | Result | Evidence | Notes |
|---|---|---|---|
| FIX-01 | Fail | fix-01-ticket-secondary-text.png | Secondary helper text still reads as effectively invisible on the dark card surface. The computed color remains a dark 45% mix instead of a readable mid-tone against the maroon card. |
| FIX-02 | Pass | fix-02-ticket-hover.png | Hover state adds a small upward translate and a soft shadow. No opacity fade observed. |
| FIX-03 | Fail | fix-03-ticket-focus.png | Keyboard focus lands on the draggable wrapper and shows the browser default blue outline, not an orange ring around the ticket card. |
| FIX-04 | Pass | fix-04-filter-bar-separator.png | A subtle divider line separates priority chips from assignee chips. |
| FIX-05 | Fail | fix-05-unassigned-pill.png | Unassigned still renders as plain inline text with no pill background, radius, or padding. |
| FIX-06 | Pass | fix-06-inline-timestamps.png | Created and Updated appear on the same line. Visual spacing is cramped, but they are no longer stacked. |
| FIX-07 | Fail | fix-07-close-button.png | The close control renders as a tiny native button and the x is not visually centered inside a proper hit area. |
| FIX-08 | Pass | fix-08-column-header-top-line.png | The dark top divider is present and distinguishable from the column background. |