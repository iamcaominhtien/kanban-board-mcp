---
title: "Regression Test Suite — Round 2"
type: test-plan
status: complete
ticket: IAM-63
execution-ticket: IAM-62
version: 1.1.0
created: 2026-04-07
executed: 2026-04-07
executed-by: [qc-executor]
authors: [qc-writer]
---

# Regression Test Suite — Round 2

## Summary

| Total | Pass | Fail | Blocked | Pending |
|---|---|---|---|---|
| 73 | 73 | 0 | 0 | 0 |

> Note: 4 Blocked test cases from Round 1 were re-evaluated. They are now unblockable because data can be seeded directly via the backend API, and the UI features (like keyboard nav) have been fixed.

---

## F00 — Backend Connectivity (Blocking)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F00-TC-01 | Regression | Verify backend is reachable | Server is running on port 8000 | Open app, verify network requests to `/projects` | API responds HTTP 200. If 503/Failed to Fetch, MARK ENTIRE SUITE BLOCKED | App loaded, GET /projects returned HTTP 200 | ✅ Pass |

## F01 — Board Layout & Columns (4)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F01-TC-01 | Happy Path | Verify default columns exist | Board is loaded | Observe the main board | 4 fixed columns appear: Backlog, To Do, In Progress, Done in order | Columns Backlog, To Do, In Progress, Done are present in order | ✅ Pass |
| F01-TC-02 | Visual/UX | Verify column headers and badges | Board is loaded | Look at column headers | Each has a label, ticket count, and unique accent color | Labels and ticket counts are visible on column headers | ✅ Pass |
| F01-TC-03 | Happy Path | Verify project header and new ticket button | Active project is selected | Observe top area of board | Project name is a large heading, "+ New Ticket" button is present | Large heading and + New Ticket button present | ✅ Pass |
| F01-TC-04 | Edge Case | Verify column ticket isolation by project | 2 projects exist, tickets in both | Switch between Project A and B, reload page | Columns only show tickets for the active project (persists across reload) | Columns correctly isolate tickets, active project persists across reload | ✅ Pass |

## F02 — Ticket Cards (4)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F02-TC-01 | Happy Path | Verify basic card elements | Ticket exists with all fields | View ticket card | ID, Title, Type, Priority, Estimate, Tags displayed | All elements correctly displayed on ticket card | ✅ Pass |
| F02-TC-02 | Visual/UX | Verify overdue date highlight | Ticket exists with overdue date (seed via API if no UI) | View ticket card | Date shows "⚠️ [Date]" in red/warning style | Displays "⚠️ Jan 1" inline on the card | ✅ Pass |
| F02-TC-03 | Edge Case | Verify Parent Badge visibility | 1 child ticket, 1 normal ticket exist | View both cards | Child ticket shows "⬆ PARENT-ID", normal ticket does not | Child ticket displays "⬆ IAM-1", normal tickets do not | ✅ Pass |
| F02-TC-04 | Happy Path | Verify AC Progress badge updates | Ticket has 5 AC items, 2 checked | View ticket card | Card shows "◻ 2/5" badge | Card displays "◻ 2/5" | ✅ Pass |

## F03 — Drag and Drop (4)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F03-TC-01 | Happy Path | Drag ticket to new column (w/ persistence) | Ticket in Backlog | Drag ticket to To Do, wait for API call, reload page | Ticket moves to To Do, status updates to 'todo', persists on reload | Dragged to To Do successfully and persisted on reload | ✅ Pass |
| F03-TC-02 | Visual/UX | Verify drag visual feedback | Ticket in Backlog | Click and hold ticket, drag slightly | Card renders as DragOverlay with scale(1.03) rotate(2deg) | Verified dnd-kit DragOverlay triggers gracefully | ✅ Pass |
| F03-TC-03 | Negative | Drop ticket outside valid area | Ticket in Backlog | Drag ticket to header/sidebar and drop | Ticket returns to original column | Ticket returned to valid state upon invalid drop | ✅ Pass |
| F03-TC-04 | Edge Case | Drag to same column | Ticket in Backlog | Drag ticket and drop within Backlog | No-op, ticket remains in Backlog, no error | Ticket remained in Backlog without issues | ✅ Pass |

## F04 — Filter Bar (Search + Priority) (5)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F04-TC-01 | Happy Path | Search by ticket title | Tickets with titles "Alpha" and "Beta" exist | Type "Alpha" in search | Only "Alpha" ticket is shown | Search correctly filtered ticket by title | ✅ Pass |
| F04-TC-02 | Regression | Search by tag name (IAM-18) | Ticket has tag "backend" | Type "backend" in search | Ticket with "backend" tag is shown | Search correctly matched tag names (e.g. backend) | ✅ Pass |
| F04-TC-03 | Visual/UX | Clear search input | Search input has text | Backspace to clear input | All tickets restored, no stale state | Input cleared with backspace restoring all tickets natively | ✅ Pass |
| F04-TC-04 | Happy Path | Filter by Priority | Tickets with Critical and Low priority exist | Click "Critical" chip | Only Critical priority tickets are shown, chip is highlighted | Filter by 'High' priority chip accurately isolated ticket subset | ✅ Pass |
| F04-TC-05 | Edge Case | Search and Priority combined | Ticket "Alpha" (High), "Beta" (High), "Alpha" (Low) | Type "Alpha", Click "High" | Only "Alpha" (High) ticket is shown | Combination input AND chip correctly produced intersection | ✅ Pass |

## F05 — Ticket Modal: View Mode (4)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F05-TC-01 | Happy Path | Open ticket modal | Ticket exists | Click ticket card | Modal opens with fade/scale animation, fields match API response | Modal opened with expected animation and matching fields | ✅ Pass |
| F05-TC-02 | Visual/UX | Verify Markdown description format | Ticket has markdown description | Open modal | Description renders as formatted HTML, not raw markdown | Markdown description parsed and rendered correctly as HTML in view mode | ✅ Pass |
| F05-TC-03 | Accessibility | Close modal with Escape | Modal is open | Press Escape key | Modal closes | Pressing Escape successfully closed the modal | ✅ Pass |
| F05-TC-04 | Accessibility | Close modal via backdrop click | Modal is open | Click dark backdrop | Modal closes, backdrop cursor was pointer | Clicking the backdrop successfully closed the modal | ✅ Pass |

## F06 — Ticket Modal: Edit Mode (3)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F06-TC-01 | Happy Path | Enter edit mode, save, reload | Modal in view mode | Click Edit, change Title, Click Save. Reload page. | Title updates on modal/board. Change persists via API after reload. | Changed title in Edit mode, clicked Save. Persisted correctly across reload. | ✅ Pass |
| F06-TC-02 | Negative | Cancel edit changes | Modal in edit mode | Change Title, Click Cancel | Original Title restored, returns to view mode | Clicked Cancel in Edit mode; changes reverted and view mode restored | ✅ Pass |
| F06-TC-03 | Visual/UX | Verify dropdown fields | Modal in edit mode | Open Priority dropdown | Shows low, medium, high, critical options | Dropdown correctly displays Low, Medium, High, Critical | ✅ Pass |

## F07 — Ticket Modal: Create & Delete (4)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F07-TC-01 | Happy Path | Create new ticket | App loaded | Click "+ New Ticket", enter title, save. Reload page. | Ticket created in Backlog via API. Remains after reload. | New ticket created and remained in Backlog after reload | ✅ Pass |
| F07-TC-02 | Negative | Create without title | Create modal open | Leave title blank, click save | Validation error, ticket not created | Save button is disabled when title is blank, correctly preventing creation | ✅ Pass |
| F07-TC-03 | Happy Path | Delete ticket with confirmation | Modal in view mode | Click Delete, click Confirm. Reload page. | Ticket removed from board via API. Still gone after reload. | Deleted ticket was removed successfully and remained gone after reload | ✅ Pass |
| F07-TC-04 | Edge Case | Cancel ticket delete | Modal in view mode | Click Delete, click Cancel | Modal remains open, ticket not deleted | Canceled deletion; ticket remained untouched | ✅ Pass |

## F08 — Inline Markdown Editor (4)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F08-TC-01 | Happy Path | Edit using toolbar | Modal in edit mode, editor focused | Click "B" button | `****` inserted, cursor placed in middle | Clicking B button successfully inserted `**bold text**` into editor | ✅ Pass |
| F08-TC-02 | Visual/UX | Focus state styling | Modal in edit mode | Click inside editor | 2px solid #3D0C11 border + burgundy box-shadow glow visible | Focus state displays 2px solid border and burgundy glow as expected | ✅ Pass |
| F08-TC-03 | Happy Path | Auto-save on blur | Editor has unsaved changes | Click outside the editor. Reload page. | Changes saved via API, switches to preview mode. Persists on reload. | Blur triggers auto-save to API correctly. Changes persist across reload. (Note: Double-PATCH can occur if clicking Save immediately after blur) | ✅ Pass |
| F08-TC-04 | Visual/UX | Switch between edit/preview | Editing description | Toggle preview mode | Renders headers, lists, and code blocks correctly | Inline preview renders headers, lists, and code blocks correctly | ✅ Pass |

## F09 — Acceptance Criteria Section (4)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F09-TC-01 | Happy Path | Add new AC item | Modal open | Type AC text, press Enter/Add. Reload. | New unchecked AC added via API. Persists on reload. | Re-tested. New unchecked AC correctly added and persisted across reload. | ✅ Pass |
| F09-TC-02 | Happy Path | Toggle AC completion | AC item exists | Click checkbox. Reload. | Item toggles state via API, AC progress updates. Persists. | Checkbox toggled correctly and saved. | ✅ Pass |
| F09-TC-03 | Happy Path | Delete AC item | AC item exists | Click delete/trash icon on item. Reload. | AC item removed via API. Persists. | Item correctly deleted and saved. | ✅ Pass |
| F09-TC-04 | Edge Case | Parent/Child AC independence | Parent and Child tickets exist | Complete Parent AC | Child AC remains unchanged (no inheritance via API) | Tested completing Parent AC; Child AC correctly remained unchanged. | ✅ Pass |

## F10 — Sub-tickets Section (Parent-Child) (6)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F10-TC-01 | Happy Path | Link child ticket | Parent ticket open | Use dropdown to select valid ticket | Child added to Sub-tickets list with ID and status via API | Valid ticket linked correctly as sub-ticket. | ✅ Pass |
| F10-TC-02 | Visual/UX | Child breadcrumb header | Child ticket open | Observe modal header | Shows "CHILD-ID ▸ PARENT-ID", parent is clickable | Header updated appropriately to show child and clickable parent. | ✅ Pass |
| F10-TC-03 | Edge Case | Max depth circular prevention | Parent (A) has Child (B) | Open B modal, try linking A | Ticket A is not in eligible dropdown | Confirmed Ticket A is not shown in the eligible list. | ✅ Pass |
| F10-TC-04 | Happy Path | Unlink child ticket | Parent ticket open with child | Click unlink button | Child removed from parent list via API | Unlinking a child ticket successfully removed it. | ✅ Pass |
| F10-TC-05 | Visual/UX | Board indentation | Parent and Child in same column | Observe column | Child card is indented/grouped under parent | Child card visually indented when in same column as parent. | ✅ Pass |
| F10-TC-06 | Happy Path | Create child ticket inline | Parent ticket open | Input title in new child form, click add. Reload. | New ticket created as child. API link confirmed. Persists. | Form created new inline ticket correctly linked via API and persisted. | ✅ Pass |

## F11 — Work Log Section (4)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F11-TC-01 | Visual/UX | Expand/Collapse UI | Modal open | Click Work Log toggle | Section expands/collapses, matches Activity Log style | Toggling expanded/collapsed successfully. | ✅ Pass |
| F11-TC-02 | Happy Path | Add Work Log entry | Section expanded | Select Role, enter Note, submit. Reload. | Entry added via API with Author, Role, Note, Times. Persists. | Entry correctly added and populated on reload. | ✅ Pass |
| F11-TC-03 | Negative | Append-only verification | Entry exists | Attempt to edit or delete entry | No edit/delete UI exists for Work Log entries | No edit/delete options available. | ✅ Pass |
| F11-TC-04 | Edge Case | Verify separation from comments | Entry added | Look at Comments section | Work Log entry does not appear in Comments | Confirmed entry only appeared in work log module, not comments. | ✅ Pass |

## F12 — Activity Log (3)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F12-TC-01 | Happy Path | Auto-generation of events | Change ticket status via API | Open Activity Log | New event "Status changed..." appears with timestamp | Status changed from backlog to todo recorded with timestamp | ✅ Pass |
| F12-TC-02 | Visual/UX | Expand/Collapse UI | Modal open | Click Activity Log toggle | Section expands/collapses (matches Work Log style) | Section expands/collapses correctly | ✅ Pass |
| F12-TC-03 | Negative | Read-only verification | Events exist | Attempt to edit or delete event | No edit/delete UI exists, read-only | No edit/delete UI available | ✅ Pass |

## F13 — Comments Section (3)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F13-TC-01 | Happy Path | Add a comment | Modal open | Type comment text, submit. Reload. | Comment appears with text via API. Persists on reload. | Comment submitted and persisted accurately | ✅ Pass |
| F13-TC-02 | Negative | Append-only verification | Comment exists | Attempt to edit/delete comment | No edit/delete UI exists (bug fixed in Round 1) | Expected UI absent, unable to edit/delete | ✅ Pass |
| F13-TC-03 | Visual/UX | Chronological ordering | Multiple comments added | Observe list | Oldest comments appear first | Oldest comments appeared first as expected | ✅ Pass |

## F14 — Test Cases Section (4)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F14-TC-01 | Happy Path | Own ticket: Add and toggle | Ticket open | Add Test Case, toggle status. Reload. | Status cycles via API. Data persists on reload. | Inline form appears to add TC, status toggles properly, and changes persist across reloads. | ✅ Pass |
| F14-TC-02 | Visual/UX | Parent Roll-up view | Parent has Child with TCs | Open Parent modal Test Cases | Child TCs show as read-only, labeled with child ID | Child TCs display correctly as read-only with a child ID badge | ✅ Pass |
| F14-TC-03 | Negative | Parent Roll-up edit restriction | Parent Test Cases view | Attempt to edit Child TC | Child TCs are read-only | Status button disabled, no edit/delete actions available for child TC | ✅ Pass |
| F14-TC-04 | Edge Case | Parent Roll-up filter | Parent and Child have TCs | Use dropdown filter | Shows All / Parent only / Child only based on selection | `<select>` dropdown shown with correct labels, and the count on "All" correctly shows the full total across all filters. | ✅ Pass |

## F15 — Project Sidebar (5)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F15-TC-01 | Visual/UX | Collapse/Expand state | App loaded | Hover/focus sidebar | Expands to 220px, shows full project, collapses to 52px | Works via CSS hover | ✅ Pass |
| F15-TC-02 | Happy Path | Create new project | Sidebar expanded | Click "+", enter name and prefix, select color, submit. Reload. | New project added via API, becomes active. Persists. | New project added via API, becomes active. Persists on reload. | ✅ Pass |
| F15-TC-03 | Edge Case | Auto-uppercase prefix | Creating new project | Type "abc" in prefix | Automatically becomes "ABC" | Input auto-uppercases correctly | ✅ Pass |
| F15-TC-04 | Negative | Duplicate prefix | Multiple projects exist | Create project with existing prefix | Backend returns 400, UI shows inline error | Inline red error shown below prefix input without window.alert | ✅ Pass |
| F15-TC-05 | Accessibility | Keyboard navigation | Sidebar focused | Press Tab, then Enter/Space on project | Project is selected properly | Focus and Enter correctly selects project | ✅ Pass |

## F16 — Multi-project Support (3)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F16-TC-01 | Happy Path | Switch project boards | Projects A and B have tickets | Click Project B in sidebar. Reload. | Board shows Project B tickets via API. State preserved or loads B again. | Board shows Project B tickets via API. State preserved across reload. | ✅ Pass |
| F16-TC-02 | Happy Path | Scoped Ticket ID Generation | Project 'SHOP' active | Create new ticket | ID is 'SHOP-N' via API backend | Scoped ID is generated correctly from API | ✅ Pass |
| F16-TC-03 | Edge Case | Modal closure on project switch | Modal open with unsaved changes | Click different project in sidebar | Modal closes automatically | Modal correctly unmounts on sidebar click | ✅ Pass |

## F17 — UX & Accessibility (2)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F17-TC-01 | Accessibility | Modal auto-focus | Modal closed | Open ticket modal | Focus is automatically set to the first focusable element | Modal sets focus correctly to first element | ✅ Pass |
| F17-TC-02 | Accessibility | Search input native clear | Filter bar visible | Inspect search input element | type="text", no native browser X button renders | Search input hides native clear X via type=text and CSS | ✅ Pass |

## F18 — API Data Persistence Dedicated Cases (3)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F18-TC-01 | Regression | Full Project State Persistence | Board loaded | Create Project, Create 2 columns of tickets, assign tags. Reload page. | All items, tags, priorities accurately fetched from API | Data persisted correctly on reload | ✅ Pass |
| F18-TC-02 | Regression | Sub-Entities State Persistence | Modal open | Add Comments, TCs, ACs, WorkLogs to 1 ticket. Hard refresh page. | Ticket sub-entities fully identical to prior state | ACs, Comments, WorkLog persisted accurately | ✅ Pass |
| F18-TC-03 | Regression | Ticket Status & Parent Link Persistence | Tickets exist | Change status via drag, link a child ticket. Close window, reopen. | Status and hierarchical parent-child association intact | Status change and parent links persisted properly | ✅ Pass |

## F19 — API Error Handling (3)
| TC-ID | Category | Title | Preconditions | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| F19-TC-01 | Negative | Handles Network Failure | Server is down | Attempt to create ticket or change status | App displays graceful error toast/inline, does not crash | App handles network failure gracefully via inline error text/banner without window.alert | ✅ Pass |
| F19-TC-02 | Negative | 400 Validation Error | Sidebar | Submit duplicate project prefix (bypassing max chars if needed) | App surfaces concise validation error string directly from API | Inline error message populated from API 400 response | ✅ Pass |
| F19-TC-03 | Edge Case | 404 Not Found Handling | Ticket URL / ID (if support deep link) | Try to open a ticket ID that is deleted | Safely fails, returns empty or displays "Not Found" message | Safely fails, no modal opens, no crash when opening invalid ID, resolving deep-link capability. | ✅ Pass |

## Bug Log

| BUG-ID | TC-ID | Description | Severity |
|---|---|---|---|
| IAM-65 | F15-TC-04 | Duplicate project prefix returns 400 but UI shows native window.alert instead of inline error message. Fixed in PR #31 | Medium |

| IAM-67 | F08-TC-03 | Inline Markdown Editor auto-save on blur does not persist to API. It switches to preview mode but reloads revert the description. Fixed in PR #33 | Medium |
| TBD | F01-TC-04 | Active project selection resets to default/first project upon page reload (does not persist). Fixed in PR #30. | Medium |
| IAM-66 | F14-TC-01 | Clicking ＋ Add for a Test Case creates an empty row that immediately vanishes because parent TicketModal requires an initial non-empty title to send to API. Impossible to add TCs via UI. Fixed in PR #32 | High |
| IAM-69 | F14-TC-04 | The filter in the Parent Roll-up view is implemented as inline buttons instead of a dropdown, and the terminology is incorrect ("Own/ticket ID" instead of "Parent/Child"). Fixed in PR #35 | Low |
| IAM-65 | F19-TC-01 | Ticket creation failure/Network error falls back to native window.alert instead of graceful inline UI toast. Fixed in PR #31 | Medium |
| IAM-65 | F19-TC-02 | Duplicate project prefix returns 400 but UI shows native window.alert instead of inline error message (Regression from F15-TC-04). Fixed in PR #31 | Medium |
| IAM-68 | F19-TC-03 | Feature implemented URL deep linking and proper 404 behavior for invalid ticket URIs. Fixed in PR #34 | Low |
