---
title: "IAM-100: Idea Board — Implementation & Testing Plan"
type: spec
status: draft
version: 1.0.0
created: 2026-04-21
updated: 2026-04-21
authors: [Development Team]
related:
  - docs/design/idea-board-design.md
  - docs/arch/arch-idea-board-technical.md
---

# IAM-100: Idea Board — Implementation & Testing Plan

## Overview

**Parent ticket:** IAM-100 — Add Idea Board per project

**Design doc:** [docs/design/idea-board-design.md](../design/idea-board-design.md)

**Technical doc:** [docs/arch/arch-idea-board-technical.md](../arch/arch-idea-board-technical.md)

**Baseline branch:** `baseline/IAM-100-idea-board` (PR open, merges into `main` only when all subtasks done)

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
