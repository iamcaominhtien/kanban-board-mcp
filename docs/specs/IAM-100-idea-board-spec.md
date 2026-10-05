---
title: "IAM-100: Idea Board — Implementation & Testing Plan"
type: spec
status: stable
version: 1.0.0
created: 2026-04-21
updated: 2026-04-21
authors: ["GitHub Copilot"]
related:
  - docs/design/idea-board-design.md
  - docs/arch/arch-idea-board-technical.md
---

# IAM-100: Idea Board — Implementation & Testing Plan

## Feature Overview

**Ticket**: IAM-100 — Add Idea Board per project

**Baseline branch**: `baseline/IAM-100-idea-board` (all subtasks merge here; final PR merges to `main`)

**Design reference**: [docs/design/idea-board-design.md](../design/idea-board-design.md) — UX workflows, columns, card design

**Technical reference**: [docs/arch/arch-idea-board-technical.md](../arch/arch-idea-board-technical.md) — data model, MCP tools, components

**Estimated total effort**: 14–20 hours (across backend, frontend, testing)

---

## Implementation Subtasks

### Subtask 1: [BE] Data Model & DB Migration

**Duration**: 1–2 hours | **Complexity**: Low

**Goal**: Add 5 new columns to tickets table; define enums; write safe, idempotent migration.

**Files to change**:
- `server/models.py` — add BoardType, IdeaStatus, IdeaColor enums; extend Ticket class
- `server/migrations/add_idea_board_fields.py` — new migration (ALTER TABLE with defaults)
- `server/db.py` — ensure migration runs on startup

**Detailed Acceptance Criteria**:
- [ ] New columns exist in SQLite: `board` (VARCHAR, default 'main'), `idea_status` (VARCHAR, nullable), `idea_emoji` (VARCHAR, nullable), `idea_color` (VARCHAR, nullable), `origin_idea_id` (VARCHAR, nullable)
- [ ] Migration uses batch_alter_table pattern (idempotent)
- [ ] Indexes created: idx_tickets_board, idx_tickets_board_status (board, idea_status), idx_tickets_origin_idea
- [ ] All new columns have sensible defaults/nullability (no existing data lost)
- [ ] SQLModel Ticket class reflects new fields with proper type hints
- [ ] Enums (BoardType, IdeaStatus, IdeaColor) defined and exported in models.py
- [ ] Migration passes on fresh DB and existing DB with data
- [ ] Running migration twice is safe (no errors)

---

### Subtask 2: [BE] MCP Tools for Idea Board

**Duration**: 2–3 hours | **Complexity**: Medium

**Goal**: Implement 5 new MCP tools + update existing list_tickets tool. All tools have strict validation.

**Files to change**:
- `server/mcp_tools.py` — add tools: list_idea_tickets, create_idea_ticket, update_idea_ticket, promote_idea_ticket, drop_idea_ticket; update list_tickets signature
- `server/events.py` — add SSE event types for idea board mutations

**Detailed Acceptance Criteria**:

**list_idea_tickets(project_id, status?)**:
- [ ] Returns only tickets where board='idea'
- [ ] If status param provided, filters by idea_status
- [ ] Validation: project_id exists

**create_idea_ticket(project_id, title, description?, tags?, idea_emoji?, idea_color?)**:
- [ ] Creates ticket with board='idea', idea_status='drafting'
- [ ] title is required and non-empty
- [ ] idea_emoji trimmed to 1 character; defaults to 💡
- [ ] idea_color defaults to random from [yellow, orange, pink, lime, blue]
- [ ] **Schema guard**: Rejects any non-idea fields (priority, assignee, sprint, estimate, due_date, etc.)

**update_idea_ticket(ticket_id, title?, description?, tags?, idea_emoji?, idea_color?, idea_status?)**:
- [ ] Updates provided fields; ignores unprovided fields
- [ ] **Lock enforcement**: If idea_status='approved', rejects edits to title/description/tags with error message
- [ ] idea_emoji trimmed to 1 character
- [ ] Allows valid status transitions (drafting → in_review, in_review → approved, etc.)
- [ ] **Schema guard**: Rejects non-idea fields

**promote_idea_ticket(ticket_id)**:
- [ ] Validates ticket exists and board='idea'
- [ ] **Rejects** if idea_status != 'approved' (must be approved first)
- [ ] **Atomic operation** (single transaction):
  - Creates main-board ticket with: title, description, tags from idea; status='backlog'; origin_idea_id=idea.id
  - Updates idea: idea_status='promoted'
  - Broadcasts SSE event: idea_ticket_promoted
- [ ] Returns: {promoted_ticket_id, idea_ticket_id, promoted_ticket}
- [ ] **Idempotency**: Calling promote twice on same idea fails gracefully (second call: status is 'promoted', not 'approved')
- [ ] **Rollback guarantee**: If any step fails, entire operation rolls back (no orphaned main tickets)

**drop_idea_ticket(ticket_id)**:
- [ ] Sets idea_status='dropped'
- [ ] Validates ticket not already promoted (cannot drop promoted idea)
- [ ] Broadcasts SSE event: idea_ticket_dropped
- [ ] No hard delete; idea remains in DB

**list_tickets(project_id, board?, status?) — UPDATED**:
- [ ] New param: board (optional, defaults to BoardType.MAIN for backward compatibility)
- [ ] If board='main': returns only main-board tickets
- [ ] If board='idea': returns only idea-board tickets
- [ ] Status filter applies to appropriate status enum (main statuses vs idea statuses)

---

### Subtask 3: [FE] BoardSwitcher & Routing

**Duration**: 0.5–1 hour | **Complexity**: Low

**Goal**: Add pill-tab board switcher to ProjectSidebar; wire routing to show correct board.

**Files to change**:
- `ui/src/components/ProjectSidebar.tsx` — import BoardSwitcher, render below project name
- `ui/src/components/BoardSwitcher.tsx` — new component (pill tabs)
- `ui/src/components/BoardSwitcher.module.css` — new styles
- `ui/src/App.tsx` or router — conditional render IdeaBoard vs Board
- `ui/src/hooks/useBoardSelection.ts` — custom hook to manage per-project board state (localStorage + React state)

**Detailed Acceptance Criteria**:
- [ ] ProjectSidebar renders two tabs per project: "📋 Board" (emoji + text) and "💡 Ideas"
- [ ] Tabs styled as pill buttons; active tab has darker background and white text
- [ ] Clicking "💡 Ideas" tab switches main content area to IdeaBoard placeholder
- [ ] Clicking "📋 Board" tab switches back to main Board
- [ ] Board selection **persists per project** in localStorage (key: `selectedBoard_${projectId}`)
- [ ] Refreshing page while "Ideas" tab is active returns to Ideas view
- [ ] Switching to different project defaults to Board tab (idea board is project-specific)
- [ ] Keyboard accessible (tab navigation, Enter/Space to activate)

---

### Subtask 4: [FE] IdeaBoard Layout & Drag-Drop

**Duration**: 1–2 hours | **Complexity**: Medium

**Goal**: Build 5-column Idea Board layout using @dnd-kit; render idea cards; connect to API.

**Files to change**:
- `ui/src/components/IdeaBoard.tsx` — new (main container, DnD context)
- `ui/src/components/IdeaColumn.tsx` — new (droppable column)
- `ui/src/components/IdeaBoard.module.css`, `IdeaColumn.module.css` — new styles
- `ui/src/api/useIdeaTickets.ts` — new (all idea-related hooks)

**Detailed Acceptance Criteria**:
- [ ] IdeaBoard renders 5 columns: Drafting, In Review, Approved, Promoted, Dropped (left to right)
- [ ] Each column shows header with column name, emoji, count of cards
- [ ] Ideas from API render in correct columns based on idea_status
- [ ] Columns have visual separation (gap, border, or background)
- [ ] Each column is a @dnd-kit droppable zone
- [ ] Dragging a card from Drafting to In Review calls useUpdateIdeaTicket with new status
- [ ] On successful update, card moves to new column
- [ ] On failed update, card animates back to origin column with error toast
- [ ] Terminal columns (Promoted, Dropped): cards cannot be dragged out (immobile)
- [ ] "+ New Idea" button in Drafting column (or top of board) opens quick-create modal
- [ ] Quick-create modal: title (required), description (optional), emoji (optional), color (optional); submit creates idea
- [ ] Empty state per column: "No ideas yet — create one!" with CTA
- [ ] Loading state while fetching: spinner or skeleton cards

---

### Subtask 5: [FE] IdeaCard Visual Component

**Duration**: 1–1.5 hours | **Complexity**: Medium

**Goal**: Design and build visually rich IdeaCard with emoji, color accent, metadata.

**Files to change**:
- `ui/src/components/IdeaCard.tsx` — new
- `ui/src/components/IdeaCard.module.css` — new (left-border accent, emoji layout, tags)

**Detailed Acceptance Criteria**:
- [ ] Card layout (top to bottom): drag handle | emoji (centered, large ~32px) | title (bold, 2-line truncate) | description snippet (1 line) | tags (chips)
- [ ] Left border: 4px solid, color mapped to idea_color (yellow/orange/pink/lime/blue)
- [ ] Border radius: 12px
- [ ] Background: white with subtle drop shadow
- [ ] Hover effect: slight lift, shadow enhancement
- [ ] State-specific styling:
  - Drafting/In Review: full opacity, active drag handle
  - Approved: opacity ~0.85, "🔒 Locked" badge
  - Promoted: opacity ~0.7, "✓ Promoted" badge with link
  - Dropped: opacity ~0.6, "✗ Dropped" badge, no drag handle
- [ ] All 5 accent colors render correctly (no missing/broken colors)
- [ ] Tags overflow shows "+N more" chip
- [ ] Clicking card opens IdeaTicketModal
- [ ] Card visually distinct from main TicketCard (different styling, not mistakable)

---

### Subtask 6: [FE] IdeaTicketModal

**Duration**: 2–3 hours | **Complexity**: Medium-High

**Goal**: Build modal for viewing/editing ideas with 2-stage promote flow, emoji picker, color picker.

**Files to change**:
- `ui/src/components/IdeaTicketModal.tsx` — new
- `ui/src/components/EmojiPicker.tsx` — new (lightweight ~50-emoji grid)
- `ui/src/components/ColorAccentPicker.tsx` — new (5-swatch selector)
- `ui/src/components/IdeaTicketModal.module.css` — new

**Detailed Acceptance Criteria**:

**Modal structure**:
- [ ] Header: idea title, close (X) button, status pill (Drafting | In Review | Approved | Promoted | Dropped)
- [ ] Body sections: Metadata (emoji, color, title, description, tags) | Timestamps | Origin Link (if promoted)
- [ ] Fields shown: emoji picker, color swatches, title (text), description (textarea), tags (chip input)
- [ ] Fields **NOT shown**: assignee, priority, sprint, estimate, due date, start date, AC, work log, test cases, parent_id

**Editing & state machine**:
- [ ] Drafting: title/description/tags/emoji/color editable
  - Buttons: Save, "Move to Review", Drop
- [ ] In Review: title/description/tags/emoji/color editable
  - Buttons: Approve, "Move to Drafting", Drop
- [ ] Approved: all fields read-only; "🔒 Locked" visual cue
  - Buttons: "Promote to Board", Drop, Cancel
- [ ] Promoted: all fields read-only
  - Buttons: "View Ticket" (link to main ticket), Close
- [ ] Dropped: all fields read-only
  - Buttons: Close

**Promotion flow (2-stage)**:
- [ ] "Promote to Board" button (visible only in Approved state)
- [ ] Clicking opens preview panel (inline in modal or overlay):
  - Shows idea title, description, tags (read-only)
  - Shows destination: "Kanban Board — Backlog column"
  - Shows: "This idea will be linked in the new ticket."
- [ ] Buttons in preview: "Confirm Promotion", "Cancel"
- [ ] On confirm:
  - Calls usePromoteIdeaTicket API
  - Main ticket created in backlog with origin_idea_id
  - Idea transitions to Promoted
  - Toast: "✓ Promoted to [Ticket #N]" with link to main ticket
- [ ] On error: error toast, idea remains in Approved

**Emoji picker**:
- [ ] Click emoji in modal → popover appears
- [ ] Grid of ~50 common emojis (💡, 🚀, 🎨, 🐛, 📝, ✅, etc.) in ~7x8 grid
- [ ] Click emoji → selected emoji appears in modal, popover closes
- [ ] Default (no selection): 💡 emoji

**Color swatches**:
- [ ] 5 colored squares in row: yellow, orange, pink, lime, blue
- [ ] Selected swatch has checkmark or thin border highlight
- [ ] Click swatch → card accent updates immediately
- [ ] Default: random color

**Additional**:
- [ ] Unsaved changes indicator (optional): subtle dot on Save button
- [ ] Drop confirmation dialog: "Drop this idea? It will move to Dropped and stay available for reference."
- [ ] Origin link (if origin_idea_id): "💡 Origin Idea: [title]" clickable; navigates to source idea in read-only mode

---

### Subtask 7: [FE] SSE Invalidation for Idea Board

**Duration**: 0.5–1 hour | **Complexity**: Low

**Goal**: Extend SSE invalidation to handle idea-board events; sync across multiple tabs.

**Files to change**:
- `ui/src/hooks/useSSEInvalidation.ts` — add handlers for new event types

**Detailed Acceptance Criteria**:
- [ ] New event handlers added:
  - `idea_ticket_created`: invalidate ['idea-tickets', projectId]
  - `idea_ticket_updated`: invalidate ['idea-tickets', projectId], ['idea-tickets', ticketId]
  - `idea_ticket_promoted`: invalidate ['idea-tickets', projectId] AND ['tickets', projectId] (both boards)
  - `idea_ticket_dropped`: invalidate ['idea-tickets', projectId]
- [ ] Events scoped by project_id (no cross-project leaking)
- [ ] Creating idea in Tab A immediately shows in Tab B (no refresh)
- [ ] Promoting idea in Tab A updates both idea board and main board in Tab B
- [ ] Dropping idea in Tab A removes from active columns in Tab B
- [ ] SSE reconnect logic works (recover state on reconnect)

---

## Implementation Summary

| # | Subtask | Layer | Duration | Complexity | Status |
|---|---|---|---|---|---|
| 1 | Data model & DB migration | BE | 1–2h | Low | Ready |
| 2 | MCP tools for idea board | BE | 2–3h | Medium | Ready |
| 3 | BoardSwitcher + routing | FE | 0.5–1h | Low | Ready |
| 4 | IdeaBoard layout + DnD | FE | 1–2h | Medium | Ready |
| 5 | IdeaCard visual design | FE | 1–1.5h | Medium | Ready |
| 6 | IdeaTicketModal + emoji/color pickers | FE | 2–3h | Medium-High | Ready |
| 7 | SSE invalidation | FE | 0.5–1h | Low | Ready |
| | **TOTAL** | **All** | **14–20h** | **—** | **Ready** |

**Merge order**: Subtask 1 → 2 → 3 → 4 → 5 → 6 → 7 (each into baseline/IAM-100-idea-board)

---

## Testing Plan

### Recommended Test Stack

| Layer | Framework | Purpose |
|---|---|---|
| Backend Python | pytest, pytest-cov | Schema, migration, MCP tool contracts, state transitions |
| Frontend React | Vitest + React Testing Library | Component rendering, form validation, state updates |
| E2E & Integration | Playwright | Full workflows: capture → promote, multi-tab sync, backlinks |
| SSE & Concurrency | Playwright multi-page | Event invalidation, reconnect recovery |

### Per-Subtask Test Cases

#### Subtask 1: Data Model (4 test cases)

| ID | Priority | Scenario | Expected |
|---|---|---|---|
| T1.1 | P0 | Run migration on fresh database | All 5 new columns created with correct types and defaults |
| T1.2 | P0 | Run migration on existing DB with main-board tickets | Existing tickets unaffected; board='main' for all; idea_status=null |
| T1.3 | P1 | Run migration twice (idempotent check) | Second run completes safely (no errors, no duplicates) |
| T1.4 | P0 | Create main ticket via ORM, verify board default | board='main', all idea_* fields null or default |

#### Subtask 2: MCP Tools (11 test cases)

| ID | Priority | Scenario | Expected |
|---|---|---|---|
| T2.1 | P0 | create_idea_ticket(project_id, "My Idea") | Returns Ticket with board='idea', idea_status='drafting', random color |
| T2.2 | P0 | create_idea_ticket with emoji, color, tags | All fields saved and returned |
| T2.3 | P0 | create_idea_ticket with priority="high" | Priority field rejected/ignored; no ticket created or ticket created without priority |
| T2.4 | P0 | list_idea_tickets(project_id) | Returns only idea-board tickets for that project; no main-board tickets |
| T2.5 | P0 | list_idea_tickets(project_id, status='approved') | Returns only approved ideas |
| T2.6 | P0 | update_idea_ticket(ticket_id, title="New Title") | Title updated; reflects in next fetch |
| T2.7 | P0 | update_idea_ticket on approved idea (title=...) | Rejected with "locked" error; no update applied |
| T2.8 | P0 | promote_idea_ticket(approved_idea_id) | Main ticket created, idea_status='promoted', origin_idea_id set |
| T2.9 | P0 | promote_idea_ticket(drafting_idea_id) | Error: "Idea must be approved"; no main ticket created |
| T2.10 | P0 | promote_idea_ticket twice on same idea | First succeeds, second fails (idea already promoted) |
| T2.11 | P0 | drop_idea_ticket(idea_id) | idea_status='dropped'; idea still queryable (not deleted) |

#### Subtask 3: BoardSwitcher (5 test cases)

| ID | Priority | Scenario | Expected |
|---|---|---|---|
| T3.1 | P0 | Open project, check ProjectSidebar | Two tabs visible: "📋 Board" and "💡 Ideas" |
| T3.2 | P0 | Click "💡 Ideas" tab | Main content switches to IdeaBoard (placeholder ok) |
| T3.3 | P0 | Refresh page while "💡 Ideas" tab is active | Page reloads; Ideas tab still active (localStorage persisted) |
| T3.4 | P0 | Switch to Project A, select Ideas; switch to Project B | Project B defaults to Board tab (project-scoped) |
| T3.5 | P1 | Tab navigation via keyboard (Tab key, Enter to activate) | Focus moves to tab; Enter activates tab |

#### Subtask 4: IdeaBoard Layout (6 test cases)

| ID | Priority | Scenario | Expected |
|---|---|---|---|
| T4.1 | P0 | IdeaBoard renders with sample ideas | 5 columns visible; ideas distributed by idea_status |
| T4.2 | P0 | Drag idea from Drafting to In Review | Card moves; API call sends idea_status='in_review' |
| T4.3 | P0 | Drag into Promoted or Dropped column | Card enters column (or drag blocked if terminal columns are receive-only) |
| T4.4 | P0 | Drag fails (API error) | Card animates back to origin; error toast shown |
| T4.5 | P0 | Click "+ New Idea" button | Quick-create modal appears |
| T4.6 | P0 | Submit quick-create with title | New idea appears in Drafting column |

#### Subtask 5: IdeaCard (7 test cases)

| ID | Priority | Scenario | Expected |
|---|---|---|---|
| T5.1 | P0 | Render idea card with all metadata | Emoji, color accent, title, description, tags all visible |
| T5.2 | P0 | Render each of 5 accent colors | All 5 colors render correctly using CSS vars |
| T5.3 | P0 | Render approved idea | Card shows "🔒 Locked" badge; dimmed opacity |
| T5.4 | P0 | Render promoted idea | Card shows "✓ Promoted" badge with link to main ticket |
| T5.5 | P0 | Render dropped idea | Card shows "✗" badge; no drag handle; dimmed |
| T5.6 | P0 | Long title & description | Text truncates cleanly; no layout break |
| T5.7 | P0 | Click card | IdeaTicketModal opens with correct data |

#### Subtask 6: IdeaTicketModal (12 test cases)

| ID | Priority | Scenario | Expected |
|---|---|---|---|
| T6.1 | P0 | Open modal for drafting idea | title, description, tags editable; no assignee/priority/estimate fields |
| T6.2 | P0 | Edit title and save | Title persists; card updates immediately |
| T6.3 | P0 | Click emoji in modal | Emoji picker popover appears |
| T6.4 | P0 | Select emoji from picker | Emoji updates on card immediately |
| T6.5 | P0 | Select color swatch | Card accent color updates immediately |
| T6.6 | P0 | Move idea from Drafting to In Review | Click "Move to Review" → idea_status='in_review' |
| T6.7 | P0 | Approve idea from In Review | "Approve" button visible; clicking locks idea (read-only fields) |
| T6.8 | P0 | Promote from Approved | "Promote to Board" shows preview panel → confirm creates main ticket |
| T6.9 | P0 | Double-click Promote (rapid clicks) | Only one main ticket created (debounced or disabled) |
| T6.10 | P0 | Drop idea | Confirmation dialog; idea moves to Dropped; modal closes |
| T6.11 | P0 | View promoted idea | Shows "View Ticket" link; clicking opens main ticket modal |
| T6.12 | P1 | Close modal without saving | Warn if edits pending (optional) |

#### Subtask 7: SSE Invalidation (3 test cases)

| ID | Priority | Scenario | Expected |
|---|---|---|---|
| T7.1 | P0 | Create idea in Tab A while Tab B shows idea board | Tab B updates immediately (no refresh needed) |
| T7.2 | P0 | Promote idea in Tab A while Tab B shows main board | Main board tab shows new ticket; idea board tab archives idea |
| T7.3 | P0 | Disconnect SSE, reconnect while ideas are changing | After reconnect, both tabs show latest state (no ghost cards) |

---

### Regression Test Suite (Run After All Subtasks Merged)

**Goal**: Verify end-to-end feature AND verify main board unaffected.

| ID | Priority | Test | Scope | Expected |
|---|---|---|---|---|
| R1.1 | P0 | Full idea lifecycle | E2E | Idea: create (drafting) → review (in_review) → approve (approved) → promote (promoted); main ticket in backlog with origin_idea_id |
| R1.2 | P0 | Full drop lifecycle | E2E | Idea: create (drafting) → drop (dropped) |
| R1.3 | P0 | Main board isolation | E2E | list_tickets returns no idea cards; promote adds main ticket correctly |
| R1.4 | P0 | Board switcher across projects | E2E | Each project tracks board selection independently |
| R1.5 | P0 | Backlink on promoted main ticket | E2E | Main ticket shows "💡 Origin Idea: [title]" link; click navigates back |
| R1.6 | P0 | Multi-tab sync: promote flow | E2E | Tab A promotes idea; Tab B (main board and idea board) both update via SSE |
| R1.7 | P0 | Schema guard (non-idea fields) | E2E | Attempt to create idea with priority/assignee; tool rejects; ticket not created |
| R1.8 | P0 | Drag & drop state transitions | E2E | All valid transitions work (drafting→review, review→approved, approved can→dropped) |
| R1.9 | P1 | Duplicate promotion defense | E2E | Rapid promotes or concurrent requests; only one main ticket created |
| R1.10 | P1 | Legacy data smoke test | Regression | Pre-migration main tickets still work normally |

---

## Test Data & Fixtures

**Backend fixtures** (pytest):
- Project with pre-existing main-board tickets (legacy data)
- Project A with ideas in all states: drafting, in_review, approved, promoted (with linked main ticket), dropped
- Project B (isolation testing)

**Frontend fixtures** (E2E):
- Sample ideas with various emoji/color/tag combinations
- User session with two browser tabs (sync testing)

---

## Open Ambiguities (Resolved)

| Question | Decision | Rationale |
|---|---|---|
| Can approved (but not promoted) ideas be dropped? | **Yes** | Approved ideas haven't crossed the promotion gate. If circumstances change, users should be able to drop. Test: T4.5 / R1.8 should verify this. |
| What's the default emoji if not specified? | **💡** | Semantically matches "idea board." Random color still applies. |
| Can ideas be edited after promotion? | **No** | Promoted ideas transition to terminal state (read-only). Edits must happen before promotion. |
| Is hard delete ever needed for ideas? | **No** | No hard delete in v1. Dropped ideas stay for reference. |

---

## Exit Criteria

✓ All subtask acceptance criteria met
✓ All P0 test cases pass (per-subtask + regression)
✓ No data loss on migration (legacy tickets unaffected)
✓ Multi-tab sync works (SSE invalidation verified)
✓ Schema guards prevent idea field pollution
✓ Promotion is atomic (no orphaned tickets)
✓ Board switcher persists per project

---

## Last Updated

2026-04-21, synthesized from agent drafts (BA spec, tech analysis, testing plan, wireframes)

---

## Implementation Plan

> Subtasks should be implemented in order. Each subtask gets its own branch (`feat/IAM-100-<n>-<slug>`), PR, and merges into `baseline/IAM-100-idea-board` (not main).

### Subtask 1 — [BE] Data model & DB migration

**Scope:** Add `board`, `origin_idea_id`, `idea_emoji`, `idea_color` columns to the tickets table. Update `models.py` with new enums. Write migration script.

**Files to change:**
- `server/models.py` — add BoardType, IdeaColor, IdeaStatus enums; add new fields to Ticket model
- `server/migrations/add_idea_board_fields.py` — migration script (ALTER TABLE)
- `server/db.py` — run migration on startup if columns missing

**Acceptance Criteria:**
- [ ] New columns exist in DB after migration
- [ ] Existing tickets unaffected (board defaults to 'main')
- [ ] SQLModel model reflects new schema
- [ ] Migration is idempotent (safe to run multiple times)

---

### Subtask 2 — [BE] MCP tools for Idea Board

**Scope:** Implement all 5 new MCP tools + update `list_tickets` to filter by board.

**Files to change:**
- `server/mcp_tools.py` — add: `list_idea_tickets`, `create_idea_ticket`, `update_idea_ticket`, `promote_idea_ticket`, `drop_idea_ticket`; update `list_tickets` to accept optional `board` param (default: `main`)

**Acceptance Criteria:**
- [ ] `create_idea_ticket` creates ticket with board=idea, status=drafting
- [ ] `list_idea_tickets` returns only idea board tickets for given project
- [ ] `update_idea_ticket` updates only idea-specific fields (rejects assignee/priority/estimate)
- [ ] `promote_idea_ticket` (from in_review): creates main backlog ticket, sets origin_idea_id, archives idea → promoted
- [ ] `promote_idea_ticket` rejects if status != in_review
- [ ] `drop_idea_ticket` moves idea to dropped status
- [ ] `list_tickets` (existing) returns only board=main tickets by default

---

### Subtask 3 — [FE] BoardSwitcher + routing

**Scope:** Add tab switcher to ProjectSidebar. Wire up routing/state to render IdeaBoard vs Board.

**Files to change:**
- `ui/src/components/ProjectSidebar.tsx` — add BoardSwitcher tabs per project
- `ui/src/components/BoardSwitcher.tsx` — new component (tabs: 📋 Board | 💡 Ideas)
- `ui/src/App.tsx` or router — conditional render of IdeaBoard vs Board based on board type
- `ui/src/components/BoardSwitcher.module.css` — styles

**Acceptance Criteria:**
- [ ] Two tabs visible in sidebar for each project: "📋 Board" and "💡 Ideas"
- [ ] Clicking "💡 Ideas" tab switches main content area to IdeaBoard (placeholder ok for now)
- [ ] Selected tab is visually highlighted
- [ ] Board selection persists while navigating same project (local state)

---

### Subtask 4 — [FE] IdeaBoard layout + IdeaColumn

**Scope:** Implement the Idea Board with 4 columns using @dnd-kit. Connect to API hooks.

**Files to change:**
- `ui/src/components/IdeaBoard.tsx` — new (DnD context, 4 columns)
- `ui/src/components/IdeaColumn.tsx` — new (droppable column)
- `ui/src/components/IdeaBoard.module.css`
- `ui/src/components/IdeaColumn.module.css`
- `ui/src/api/useIdeaTickets.ts` — new (all idea board hooks)

**Acceptance Criteria:**
- [ ] Idea Board shows 4 columns: Drafting, In Review, Promoted, Dropped
- [ ] Tickets from API render as placeholder cards in correct columns
- [ ] Drag-and-drop between idea columns works and updates status via API
- [ ] Promoted and Dropped columns are receive-only (cards can be dragged in, not out)
- [ ] "+ New Idea" button in Drafting column opens quick-create form

---

### Subtask 5 — [FE] IdeaCard visual design

**Scope:** Implement the visually rich IdeaCard component.

**Files to change:**
- `ui/src/components/IdeaCard.tsx` — new
- `ui/src/components/IdeaCard.module.css` — color accent bar, emoji, tags, rounded corners, elevation

**Acceptance Criteria:**
- [ ] Card shows: colored top-bar accent, large emoji, bold title, 2-line description preview, tag chips
- [ ] Each of 5 accent colors renders correctly using CSS vars
- [ ] Tags show as colorful chips
- [ ] Card hover state shows subtle lift/shadow effect
- [ ] Cards look visually distinct from main board TicketCard (different shape, colors, feel)
- [ ] Clicking card opens IdeaTicketModal

---

### Subtask 6 — [FE] IdeaTicketModal

**Scope:** Implement the simplified idea ticket modal with emoji picker, color picker, promote/drop actions.

**Files to change:**
- `ui/src/components/IdeaTicketModal.tsx` — new
- `ui/src/components/EmojiPicker.tsx` — new (lightweight, no heavy library)
- `ui/src/components/ColorAccentPicker.tsx` — new (5 swatches)
- `ui/src/components/IdeaTicketModal.module.css`

**Acceptance Criteria:**
- [ ] Modal shows: emoji picker, color picker, title (editable), description (rich text), tags
- [ ] Modal does NOT show: assignee, priority, estimate, sprint, dates, AC, work log, test cases
- [ ] "✅ Approve & Promote to Board" button visible only when status = in_review; calls promote API
- [ ] After promote: shows confirmation with link to new main ticket; idea card shows "Promoted ✅"
- [ ] "🗑️ Drop Idea" button visible for drafting/in_review; calls drop API
- [ ] "↩️ Back to Drafting" button visible when status = in_review
- [ ] For promoted cards: shows read-only "→ Promoted to: [ticket-id]" link
- [ ] Emoji and color changes save on blur / auto-save

---

### Subtask 7 — [FE] SSE invalidation for idea board events

**Scope:** Extend SSE event handler to invalidate React Query caches for idea board mutations.

**Files to change:**
- `ui/src/hooks/useSSEInvalidation.ts` — add handlers for: idea_ticket_created, idea_ticket_updated, idea_ticket_promoted

**Acceptance Criteria:**
- [ ] Creating an idea in one tab reflects immediately in another (via SSE)
- [ ] Promoting an idea in one tab updates both idea board and main board in another tab
- [ ] No stale cache after any idea board mutation across tabs

---

### Summary Table

| # | Subtask | Layer | Est. Complexity |
|---|---|---|---|
| 1 | Data model & DB migration | BE | Low |
| 2 | MCP tools for idea board | BE | Medium |
| 3 | BoardSwitcher + routing | FE | Low |
| 4 | IdeaBoard layout + columns + DnD | FE | Medium |
| 5 | IdeaCard visual design | FE | Medium |
| 6 | IdeaTicketModal | FE | Medium-High |
| 7 | SSE invalidation | FE | Low |

**Merge order:** 1 → 2 → 3 → 4 → 5 → 6 → 7 (each into baseline branch)

---

## Testing Plan

### Per-Subtask Test Cases

#### Subtask 1 — Data Model

| # | Test | Type | Expected |
|---|---|---|---|
| T1.1 | Run migration on fresh DB | Integration | All 4 columns created |
| T1.2 | Run migration on existing DB with data | Integration | Existing tickets unaffected, board='main' |
| T1.3 | Run migration twice | Integration | No error (idempotent) |
| T1.4 | Create ticket via ORM, check board default | Unit | board='main', origin_idea_id=None |

#### Subtask 2 — MCP Tools

| # | Test | Type | Expected |
|---|---|---|---|
| T2.1 | create_idea_ticket with title only | MCP call | Returns ticket with board=idea, status=drafting |
| T2.2 | create_idea_ticket with all fields | MCP call | All idea fields set correctly |
| T2.3 | list_idea_tickets for project | MCP call | Returns only board=idea tickets |
| T2.4 | list_tickets (existing tool) | MCP call | Returns only board=main tickets |
| T2.5 | update_idea_ticket: change title, emoji, color | MCP call | Fields updated |
| T2.6 | update_idea_ticket: try to set priority | MCP call | Field ignored or error returned |
| T2.7 | update_idea_ticket: move status drafting→in_review | MCP call | Status updated |
| T2.8 | promote_idea_ticket from in_review | MCP call | Main ticket created with origin_idea_id; idea→promoted |
| T2.9 | promote_idea_ticket from drafting | MCP call | Error: must be in_review |
| T2.10 | promote_idea_ticket: verify new main ticket fields | MCP call | title, description copied; status=backlog |
| T2.11 | drop_idea_ticket | MCP call | Idea ticket status=dropped |

#### Subtask 3 — BoardSwitcher

| # | Test | Type | Expected |
|---|---|---|---|
| T3.1 | Sidebar renders two tabs per project | UI | "📋 Board" and "💡 Ideas" visible |
| T3.2 | Click Ideas tab | UI | Main content switches to Idea Board placeholder |
| T3.3 | Click Board tab | UI | Main content returns to main board |
| T3.4 | Tab selection persists on same project | UI | Switching projects and back retains tab |
| T3.5 | Active tab has visual highlight | UI | Highlighted tab style applies |

#### Subtask 4 — IdeaBoard Layout

| # | Test | Type | Expected |
|---|---|---|---|
| T4.1 | Idea Board renders 4 columns | UI | Drafting, In Review, Promoted, Dropped visible |
| T4.2 | Tickets appear in correct columns | UI | Cards grouped by status |
| T4.3 | Drag card from Drafting to In Review | UI + API | Status updated to in_review |
| T4.4 | Drag card into Promoted column | UI | Card enters column (via promote action, not drag — or block drag into Promoted) |
| T4.5 | "+ New Idea" button | UI | Quick-create form appears |
| T4.6 | Create idea from quick form | UI + API | New card appears in Drafting |

#### Subtask 5 — IdeaCard

| # | Test | Type | Expected |
|---|---|---|---|
| T5.1 | Card renders emoji, title, description | UI | All elements visible |
| T5.2 | Card renders color accent bar | UI | Correct color from --color-* vars |
| T5.3 | All 5 accent colors render | UI | No broken/missing colors |
| T5.4 | Tags render as chips | UI | Chips with distinct colors |
| T5.5 | Card hover state | UI | Elevation/shadow effect applied |
| T5.6 | Click card opens IdeaTicketModal | UI | Modal opens with correct data |
| T5.7 | Card visually distinct from main TicketCard | Visual | Different shape/color scheme obvious |

#### Subtask 6 — IdeaTicketModal

| # | Test | Type | Expected |
|---|---|---|---|
| T6.1 | Modal shows only idea fields | UI | No assignee/priority/estimate/dates visible |
| T6.2 | Edit title, auto-save | UI + API | Title updates in card |
| T6.3 | Select emoji from picker | UI + API | Emoji updates on card immediately |
| T6.4 | Select color from swatches | UI + API | Card accent color updates |
| T6.5 | "Approve & Promote" only shown for in_review | UI | Button hidden for drafting/promoted/dropped |
| T6.6 | Click Approve & Promote | UI + API | Confirmation shown; idea→promoted; main ticket created |
| T6.7 | Promoted card shows link to main ticket | UI | "→ Promoted to: IAM-X" link visible and correct |
| T6.8 | Click link → opens main ticket | UI | Main ticket modal opens |
| T6.9 | Drop Idea button | UI + API | Idea moves to Dropped |
| T6.10 | Back to Drafting button (from in_review) | UI + API | Status reverts to drafting |
| T6.11 | Rich text in description | UI | Bold, bullets render correctly |

#### Subtask 7 — SSE Invalidation

| # | Test | Type | Expected |
|---|---|---|---|
| T7.1 | Create idea in Tab A → Tab B updates | Integration | New card appears in Tab B without refresh |
| T7.2 | Promote idea in Tab A → Tab B main board updates | Integration | New main ticket appears in Tab B backlog |
| T7.3 | Drop idea in Tab A → Tab B idea board updates | Integration | Card moves to Dropped in Tab B |

---

### Regression Test Suite (Run after all subtasks merged to baseline)

**Goal:** Verify the feature end-to-end AND verify existing main board is unaffected.

| # | Test | Scope | Expected |
|---|---|---|---|
| R1 | Full idea lifecycle: create → review → promote | E2E | Idea created in drafting, moved to in_review, promoted, main ticket in backlog with origin_idea_id |
| R2 | Full idea lifecycle: create → drop | E2E | Idea in drafting, dropped |
| R3 | Main board unaffected: list_tickets returns no idea tickets | E2E | Existing main board tickets only |
| R4 | Board switcher works across multiple projects | E2E | Each project independently switches boards |
| R5 | Promoted ticket on main board has correct origin_idea_id | E2E | link visible in main ticket modal |
| R6 | Create idea with all optional fields | E2E | emoji, color, tags all saved and displayed |
| R7 | Drag & drop within idea board | E2E | All valid status transitions work via DnD |
| R8 | Schema guard: cannot set priority/assignee on idea ticket | E2E | MCP tool rejects or ignores forbidden fields |
| R9 | Multi-tab sync: promote in one tab, both boards update | E2E | SSE invalidation works for promote event |
| R10 | Existing main board features unaffected | Regression | Existing tickets, drag-drop, modals, comments, work log all work normally |
