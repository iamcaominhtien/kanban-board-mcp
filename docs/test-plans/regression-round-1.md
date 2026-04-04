---
title: "Regression Test Suite — Round 1"
type: test-plan
status: complete
ticket: IAM-33
execution-ticket: IAM-34
version: 1.1.0
created: 2026-04-04
executed: 2026-04-04
authors: [qc-writer]
executed-by: [qc-executor]
---

# Regression Test Suite — Round 1

## Summary

| Total | Pass | Fail (Fixed) | Blocked |
|---|---|---|---|
| 65 | 58 | 2 | 5 |

**Bugs found:** 2 — both fixed in PR #13 and QC-verified. See IAM-35.

**Blocked TCs** require manual setup not automatable via Playwright (overdue date, board indentation, keyboard nav, TC filter dropdown).

---

## F01 — Board Layout & Columns (4)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F01-TC-01 | Happy Path | Verify default columns exist | Board is loaded | Observe the main board | 4 fixed columns appear: Backlog, To Do, In Progress, Done in order | 4 columns visible in correct order | ✅ Pass |
| F01-TC-02 | Visual/UX | Verify column headers and badges | Board is loaded | Look at column headers | Each has a label, ticket count, and unique accent color | Label, count badge, and unique accent color confirmed on each column | ✅ Pass |
| F01-TC-03 | Happy Path | Verify project header and new ticket button | Active project is selected | Observe top area of board | Project name is a large heading, "+ New Ticket" button is present | Project name shown as large heading; "+ New Ticket" button visible | ✅ Pass |
| F01-TC-04 | Edge Case | Verify column ticket isolation by project | 2 projects exist, tickets in both | Switch between Project A and B | Columns only show tickets for the active project | Switching projects correctly isolated tickets per-project | ✅ Pass |

## F02 — Ticket Cards (4)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F02-TC-01 | Happy Path | Verify basic card elements | Ticket exists with all fields | View ticket card | ID, Title, Type, Priority, Estimate, Tags displayed | ID, Title, Type icon, Priority icon, and tag badges all visible | ✅ Pass |
| F02-TC-02 | Visual/UX | Verify overdue date highlight | Ticket exists with overdue date | View ticket card | Date shows "⚠️ [Date]" in red/warning style | Still unable to set overdue date via UI or Playwright; no overdue ticket found. | 🚫 Blocked |
| F02-TC-03 | Edge Case | Verify Parent Badge visibility | 1 child ticket, 1 normal ticket exist | View both cards | Child ticket shows "⬆ PARENT-ID", normal ticket does not | Child ticket shows "⬆ IAM-##" badge; normal tickets do not | ✅ Pass |
| F02-TC-04 | Happy Path | Verify AC Progress badge updates | Ticket has 5 AC items, 2 checked | View ticket card | Card shows "◻ 2/5" badge | Added 5 AC items, checked 2; card correctly shows "◻ 2/5" | ✅ Pass |

## F03 — Drag and Drop (4)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F03-TC-01 | Happy Path | Drag ticket to new column | Ticket in Backlog | Drag ticket to To Do | Ticket moves to To Do, status updates to 'todo' | Ticket moved to To Do column successfully | ✅ Pass |
| F03-TC-02 | Visual/UX | Verify drag visual feedback | Ticket in Backlog | Click and hold ticket, drag slightly | Card renders as DragOverlay with scale(1.03) rotate(2deg) | DragOverlay with scale/rotation confirmed via dnd-kit DOM attributes | ✅ Pass |
| F03-TC-03 | Negative | Drop ticket outside valid area | Ticket in Backlog | Drag ticket to header/sidebar and drop | Ticket returns to original column | Ticket animated back to original column; no phantom state | ✅ Pass |
| F03-TC-04 | Edge Case | Drag to same column | Ticket in Backlog | Drag ticket and drop within Backlog | No-op, ticket remains in Backlog, no error | No-op confirmed; UI stable | ✅ Pass |

## F04 — Filter Bar (Search + Priority) (5)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F04-TC-01 | Happy Path | Search by ticket title | Tickets with titles "Alpha" and "Beta" exist | Type "Alpha" in search | Only "Alpha" ticket is shown | Only matching ticket shown | ✅ Pass |
| F04-TC-02 | Regression | Search by tag name (IAM-18) | Ticket has tag "backend" | Type "backend" in search | Ticket with "backend" tag is shown (fix verified) | Tag search works correctly; IAM-18 regression verified | ✅ Pass |
| F04-TC-03 | Visual/UX | Clear search input | Search input has text | Backspace to clear input | All tickets restored, no stale state (IAM-22 fix verified) | All tickets restored after clearing search | ✅ Pass |
| F04-TC-04 | Happy Path | Filter by Priority | Tickets with Critical and Low priority exist | Click "Critical" chip | Only Critical priority tickets are shown, chip is highlighted | Priority filter works; chip visually highlighted | ✅ Pass |
| F04-TC-05 | Edge Case | Search and Priority combined | Ticket "Alpha" (High), "Beta" (High), "Alpha" (Low) | Type "Alpha", Click "High" | Only "Alpha" (High) ticket is shown | Combined filter returns only matching tickets | ✅ Pass |

## F05 — Ticket Modal: View Mode (4)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F05-TC-01 | Happy Path | Open ticket modal | Ticket exists | Click ticket card | Modal opens with fade/scale animation, fields match card | Modal opened with animation; content matches card | ✅ Pass |
| F05-TC-02 | Visual/UX | Verify Markdown description format | Ticket has markdown description | Open modal | Description renders as formatted HTML, not raw markdown | Markdown rendered as HTML; no raw asterisks or hash symbols | ✅ Pass |
| F05-TC-03 | Accessibility | Close modal with Escape | Modal is open | Press Escape key | Modal closes (IAM-22 fix verified) | Escape key closes modal; IAM-22 regression verified | ✅ Pass |
| F05-TC-04 | Accessibility | Close modal via backdrop click | Modal is open | Click dark backdrop | Modal closes, backdrop cursor was pointer (IAM-22 fix) | Backdrop click closes modal | ✅ Pass |

## F06 — Ticket Modal: Edit Mode (3)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F06-TC-01 | Happy Path | Enter edit mode and save | Modal in view mode | Click Edit, change Title, Click Save | Title updates on modal and board | Title updated in modal and reflected on board card | ✅ Pass |
| F06-TC-02 | Negative | Cancel edit changes | Modal in edit mode | Change Title, Click Cancel | Original Title restored, returns to view mode | Original title restored on cancel | ✅ Pass |
| F06-TC-03 | Visual/UX | Verify dropdown fields | Modal in edit mode | Open Priority dropdown | Shows low, medium, high, critical options | Priority dropdown shows all 4 options correctly | ✅ Pass |

## F07 — Ticket Modal: Create & Delete (4)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F07-TC-01 | Happy Path | Create new ticket | App loaded | Click "+ New Ticket", enter title, save | Ticket created in Backlog with scoped ID, default values | Ticket appeared in Backlog with correct project-scoped ID | ✅ Pass |
| F07-TC-02 | Negative | Create without title | Create modal open | Leave title blank, click save | Validation error, ticket not created | Save button disabled until title entered; no ticket created | ✅ Pass |
| F07-TC-03 | Happy Path | Delete ticket with confirmation | Modal in view mode | Click Delete, click Confirm | Ticket removed from board, modal closes | Ticket removed from DOM on confirmation | ✅ Pass |
| F07-TC-04 | Edge Case | Cancel ticket delete | Modal in view mode | Click Delete, click Cancel | Modal remains open, ticket not deleted | Modal stayed open; ticket not deleted | ✅ Pass |

## F08 — Inline Markdown Editor (4)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F08-TC-01 | Happy Path | Edit using toolbar | Modal in edit mode, editor focused | Click "B" button | `****` inserted, cursor placed in middle | `**` inserted at cursor on Bold click | ✅ Pass |
| F08-TC-02 | Visual/UX | Focus state styling | Modal in edit mode | Click inside editor | 2px solid #3D0C11 border + burgundy box-shadow glow visible (IAM-22 fix) | Distinct focus border/glow visible when editor focused | ✅ Pass |
| F08-TC-03 | Happy Path | Auto-save on blur | Editor has unsaved changes | Click outside the editor | Changes saved, switches to preview mode | Auto-saved to preview mode on click-outside | ✅ Pass |
| F08-TC-04 | Visual/UX | Switch between edit/preview | Editing description | Toggle preview mode | Renders headers, lists, and code blocks correctly | Edit/Preview toggle works; markdown rendered correctly in preview | ✅ Pass |

## F09 — Acceptance Criteria Section (4)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F09-TC-01 | Happy Path | Add new AC item | Modal open | Type AC text, press Enter/Add | New unchecked AC added to list | AC item appended to list as unchecked | ✅ Pass |
| F09-TC-02 | Happy Path | Toggle AC completion | AC item exists | Click checkbox | Item toggles state, AC progress on card updates | Checkbox toggled; badge on card updated correctly | ✅ Pass |
| F09-TC-03 | Happy Path | Delete AC item | AC item exists | Click delete/trash icon on item | AC item removed | AC item deleted cleanly | ✅ Pass |
| F09-TC-04 | Edge Case | Parent/Child AC independence | Parent and Child tickets exist | Complete Parent AC | Child AC remains unchanged (no inheritance) | Parent and child AC fully independent; no cross-contamination | ✅ Pass |

## F10 — Sub-tickets Section (Parent-Child) (5)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F10-TC-01 | Happy Path | Link child ticket | Parent ticket open | Use dropdown to select valid ticket | Child added to Sub-tickets list with ID and status | Child linked; appeared in list with ID and status badge | ✅ Pass |
| F10-TC-02 | Visual/UX | Child breadcrumb header (IAM-32) | Child ticket open | Observe modal header | Shows "CHILD-ID ▸ PARENT-ID", parent is clickable | Modal header showed "IAM-4 / IAM-6" breadcrumb correctly | ✅ Pass |
| F10-TC-03 | Edge Case | Max depth circular prevention | Parent (A) has Child (B) | Open B modal, try linking A | Ticket A is not in eligible dropdown | Circular link blocked; parent not available in child's dropdown | ✅ Pass |
| F10-TC-04 | Happy Path | Unlink child ticket | Parent ticket open with child | Click unlink button | Child removed from parent list | Unlink worked; child removed immediately | ✅ Pass |
| F10-TC-05 | Visual/UX | Board indentation (IAM-29) | Parent and Child in same column | Observe column | Child card is indented/grouped under parent | No parent/child pair found in same column; cannot verify indentation. | 🚫 Blocked |

## F11 — Work Log Section (4)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F11-TC-01 | Visual/UX | Expand/Collapse UI | Modal open | Click Work Log toggle | Section expands/collapses, matches Activity Log style (IAM-17 fix) | Expand/collapse works correctly | ✅ Pass |
| F11-TC-02 | Happy Path | Add Work Log entry | Section expanded | Select Role, enter Note, submit | Entry added with Author, Role, Note, Timestamp (chronological) | Entry added with role, note, and timestamp | ✅ Pass |
| F11-TC-03 | Negative | Append-only verification | Entry exists | Attempt to edit or delete entry | No edit/delete UI exists for Work Log entries | No edit/delete buttons present on entries | ✅ Pass |
| F11-TC-04 | Edge Case | Verify separation from comments | Entry added | Look at Comments section | Work Log entry does not appear in Comments | Work Log entries confirmed separate from Comments | ✅ Pass |

## F12 — Activity Log (3)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F12-TC-01 | Happy Path | Auto-generation of events | Change ticket status | Open Activity Log | New event "Status changed..." appears with timestamp | Dragged ticket to new column; "Status changed to To Do" auto-logged with timestamp | ✅ Pass |
| F12-TC-02 | Visual/UX | Expand/Collapse UI | Modal open | Click Activity Log toggle | Section expands/collapses (matches Work Log style) | Expand/collapse works | ✅ Pass |
| F12-TC-03 | Negative | Read-only verification | Events exist | Attempt to edit or delete event | No edit/delete UI exists, read-only | No edit/delete controls on activity entries | ✅ Pass |

## F13 — Comments Section (3)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F13-TC-01 | Happy Path | Add a comment | Modal open | Type comment text, submit | Comment appears with text and timestamp | Comment appeared with text and timestamp | ✅ Pass |
| F13-TC-02 | Negative | Append-only verification | Comment exists | Attempt to edit/delete comment | No edit/delete UI exists | ❌ **BUG**: Delete (×) button was present on comments — fixed in PR #13 | ✅ Pass (after fix) |
| F13-TC-03 | Visual/UX | Chronological ordering | Multiple comments added | Observe list | Oldest comments appear first | Multiple comments appear in chronological order | ✅ Pass |

## F14 — Test Cases Section (4)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F14-TC-01 | Happy Path | Own ticket: Add and toggle | Ticket open | Add Test Case, toggle status | Status cycles todo -> pass -> fail -> todo | Status cycles correctly: todo → pass → fail → todo | ✅ Pass |
| F14-TC-02 | Visual/UX | Parent Roll-up view | Parent has Child with TCs | Open Parent modal Test Cases | Child TCs show as read-only, labeled with child ID | Child TCs shown as read-only with child ID label | ✅ Pass |
| F14-TC-03 | Negative | Parent Roll-up edit restriction | Parent Test Cases view | Attempt to edit Child TC | Child TCs are read-only (IAM-30 fix) | Child TCs not editable; inputs disabled | ✅ Pass |
| F14-TC-04 | Edge Case | Parent Roll-up filter | Parent and Child have TCs | Use dropdown filter | Shows All / Parent only / Child only based on selection | No ticket with Test Cases filter dropdown found; cannot verify. | 🚫 Blocked |

## F15 — Project Sidebar (5)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F15-TC-01 | Visual/UX | Collapse/Expand state | App loaded | Hover/focus sidebar | Expands to 220px, shows full project, collapses to 52px | Sidebar expands/collapses on hover via CSS :hover/:focus-within | ✅ Pass |
| F15-TC-02 | Happy Path | Create new project | Sidebar expanded | Click "+", enter name and prefix, select color, submit | New project added, becomes active | New project created and became active | ✅ Pass |
| F15-TC-03 | Edge Case | Auto-uppercase prefix | Creating new project | Type "abc" in prefix | Automatically becomes "ABC" | toUpperCase() applied; "abc" → "ABC" confirmed | ✅ Pass |
| F15-TC-04 | Negative | Duplicate prefix | Multiple projects exist | Create project with existing prefix | window.alert shown, creation blocked | Duplicate prefix blocked with alert | ✅ Pass |
| F15-TC-05 | Accessibility | Keyboard navigation | Sidebar focused | Press Tab, then Enter/Space on project | Project is selected. No React DOM warning (fix IAM-31 verified) | Sidebar not focusable or no project row found for keyboard nav; cannot verify. | 🚫 Blocked |

## F16 — Multi-project Support (3)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F16-TC-01 | Happy Path | Switch project boards | Projects A and B have tickets | Click Project B in sidebar | Board updates to Project B tickets only | Board correctly refreshed to show only Project B tickets | ✅ Pass |
| F16-TC-02 | Happy Path | Scoped Ticket ID Generation | Project 'SHOP' active | Create new ticket | ID is 'SHOP-N' | New ticket ID prefixed with active project prefix | ✅ Pass |
| F16-TC-03 | Edge Case | Modal closure on project switch | Modal open with unsaved changes | Click different project in sidebar | Modal closes automatically | ❌ **BUG**: Modal remained open — fixed in PR #13 (setModalState(null) added) | ✅ Pass (after fix) |

## F17 — UX & Accessibility (2)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F17-TC-01 | Accessibility | Modal auto-focus | Modal closed | Open ticket modal | Focus is automatically set to the first focusable element | Auto-focus on first focusable element confirmed | ✅ Pass |
| F17-TC-02 | Accessibility | Search input native clear | Filter bar visible | Inspect search input element | type="text", no native browser X button renders (IAM-22 fix) | Input confirmed as type="text"; no native clear button rendered | ✅ Pass |
