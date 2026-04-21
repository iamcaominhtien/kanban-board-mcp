---
title: "Idea Board Design"
type: design
status: stable
version: 1.0.0
created: 2026-04-21
updated: 2026-04-21
authors: ["GitHub Copilot"]
related:
  - docs/arch/arch-idea-board-technical.md
  - docs/specs/IAM-100-idea-board-spec.md
---

# Idea Board Design

## Problem Statement

A developer managing a personal Kanban board often has raw, unformed ideas that don't belong in the structured main board but still need to be captured somewhere. Currently, the only option is to dump them into Backlog (cluttering it) or keep them in a separate notes app (losing the connection to the project). The result: ideas either pollute the main board or get lost entirely.

## Root Insight: Cognitive Mode Separation

The core problem is **not** a data organization issue — it's a **cognitive mode separation** problem. The executive mindset (planning, prioritization, execution) and the creative mindset (brainstorming, exploring, capturing freely) use different neural patterns and require different environmental cues. Mixing them damages both:

- **Execution mode** gets noisy: real work gets buried under speculative ideas.
- **Brainstorm mode** gets constrained: ideas get evaluated before they're fully formed.

The solution: **separate visual spaces with distinct affordances** — allowing ideas to flow freely without polluting the main board, and providing a natural checkpoint (approval + promotion) before ideas become committed tasks.

---

## Design Principles

| Principle | How | Why |
|---|---|---|
| **Cognitive Clarity** | Idea Board is visually and navigationally distinct from Main Board. Columns and card styling signal "brainstorm space," not "execution space." | Users must instantly know which mode they're in. Ambiguity = context thrashing. |
| **Low Friction Capture** | "+ New Idea" form is minimal (emoji, title, description optional). Time to capture < 30 seconds. | Ideas are ephemeral. If capture feels slow or heavy, users won't use the tool. |
| **Deliberate Promotion** | 2-stage gating (approve → promote) before ideas enter the main board. No accidental promotion. | Promotion is irreversible (origin_idea_id is permanent). Friction here is intentional. |
| **Visual Distinctiveness** | Idea cards use left-border color accent, centered emoji, simple font. Not task-like. | Users should never confuse an idea with a main-board ticket. |
| **Auditability** | Promoted main tickets retain origin_idea_id and visible backling. Never lose the idea genealogy. | Helps users understand where a task came from. Supports reflection on idea quality over time. |
| **No Schema Creep** | Idea tickets **never** include priority, assignee, sprint, or estimates. Minimal, intentional schema. | Schema creep kills simplicity. Constraints force clarity. |

---

## User Workflows

### Workflow 1: Idea Capture

**Goal**: Record an idea without friction.

**Steps**:
1. On Idea Board, click **"+ New Idea"** button (top-left of Drafting column).
2. Modal appears with minimal form:
   - **Emoji**: optional, press to open emoji picker (random default)
   - **Title**: required, text input
   - **Description**: optional, single-line or short multiline
   - **Tags**: optional, chips input (reuse main board tag picker)
3. Hit **"Create"** button.
4. Idea appears in **Drafting** column with matching emoji, color, title.
5. Toast confirms: "✓ Idea saved" with 3-second auto-dismiss.

**Time to capture**: < 30 seconds on average.

---

### Workflow 2: Idea Review and Approval

**Goal**: Deliberately consider an idea before committing to promotion.

**Steps**:
1. Idea is in **Drafting** column.
2. Drag it into **In Review** column, or:
   - Click card → modal opens → click "Move to Review" button → modal updates.
3. Idea is now in **In Review** column. Card styling remains editable; buttons show review affordances.
4. Open the card modal.
5. Inside modal:
   - Click **"Approve"** button (shown only for In Review ideas).
   - Idea transitions to **Approved** state.
   - Card styling changes slightly to signal lock (e.g., opacity shift, "🔒 Locked" badge).
   - Edit buttons fade/disable; only "Promote to Board," "Drop," and back options remain.

**Key constraint**: Once approved, idea fields become read-only until the idea is promoted or rejected (dropped).

---

### Workflow 3: 2-Stage Promotion Flow

**Goal**: Promote an approved idea to the main board with a clear preview and confirmation step.

**Steps**:
1. Idea is in **Approved** state (locked).
2. Open card modal.
3. Click **"Promote to Board"** button.
4. **Preview Panel** appears (inline in modal or new overlay):
   - Shows: Idea title, description, tags.
   - Shows: Destination board (default: main project backlog).
   - Shows: Origin link back to this idea.
   - User reviews, then clicks **"Confirm Promotion"** button.
5. On confirm:
   - Backend creates one main-board ticket with:
     - `title`, `description`, `tags` copied from idea.
     - `board = 'main'`
     - `origin_idea_id = [source idea ID]` (permanent, read-only).
   - Source idea transitions to **Promoted** state.
   - Idea card moves to **Promoted** column (terminal).
   - Card now shows: "✓ Promoted to [ticket ID]" badge with link.
   - Main ticket appears in main board backlog (users can see it there immediately).
   - Toast confirms: "✓ Promoted to [ticket #N]" with link to new ticket.

**Key guarantee**: Promotion is atomic. Either it fully succeeds or fully rolls back; no split-brain states.

---

### Workflow 4: Idea Drop

**Goal**: Archive an idea that isn't going anywhere.

**Steps**:
1. Idea is in **Drafting** or **In Review** state.
2. Open card modal.
3. Click **"Drop Idea"** button.
4. Confirmation dialog: "Drop this idea? You can still view it in the Dropped column."
5. Click **"Drop"** to confirm.
6. Idea transitions to **Dropped** state.
7. Card moves to **Dropped** column.
8. **No hard delete** — idea remains queryable and recoverable for reference.

**Constraint**: Dropped ideas are not promoted. If an idea is already promoted, it cannot be dropped (promotion is terminal).

---

### Workflow 5: Board Navigation

**Goal**: Switch between Main Board and Idea Board.

**Steps**:
1. In the **ProjectSidebar**, below the project name, there is a **Board Switcher**: two pill tabs.
   - Left tab: **"📋 Board"** (main board)
   - Right tab: **"💡 Ideas"** (idea board)
2. Click the desired tab.
3. View switches to that board's layout immediately.
4. Selected tab is visually highlighted (darker background, white text).
5. **State persistence**: Board selection is stored in localStorage per project. Refreshing the page or returning to the project remembers which board was last viewed.

**Key constraint**: Board switching is per-project. Changing projects resets the board memory to the default (main board).

---

### Workflow 6: Backlink from Main Ticket

**Goal**: Track where a promoted idea came from.

**Steps**:
1. Open a main-board ticket that was promoted from an idea.
2. In the ticket modal, look for the **"Origin Idea"** section (e.g., at the top, below the title).
3. See: **"💡 Origin Idea: [idea title]"** as a clickable link.
4. Click the link.
5. UI navigates to the Idea Board and opens the source idea card (read-only view).
6. Origin idea card displays all its original fields but with no edit or drag affordances (read-only inspection only).

**Key constraint**: Backlinks only appear on main tickets with a non-null `origin_idea_id`.

---

## Idea Board Layout

### Columns

The Idea Board uses a **Kanban-style column layout** with 5 distinct columns. Drag-and-drop moves ideas between columns (except terminal states).

| Column | Status | Description | Transitions |
|---|---|---|---|
| **Drafting** | `drafting` | Raw captured ideas, not yet considered. Editable. | → In Review, → Dropped |
| **In Review** | `in_review` | Ideas under deliberate consideration. Editable. | → Approved, → Dropped |
| **Approved** | `approved` | Ideas that passed review and are ready to promote. **Locked** (read-only). | → Promoted (via button), → Dropped |
| **Promoted** | `promoted` | Ideas successfully promoted to main-board tickets. **Terminal state**. | (read-only) |
| **Dropped** | `dropped` | Ideas rejected or abandoned. **Terminal state**. Recoverable for reference. | (read-only) |

**Column ordering** (left to right): Drafting → In Review → Approved → Promoted | Dropped

**Terminal columns** (Promoted, Dropped) sit on the right, separated visually, to signal finality.

---

## Idea Card Visual Design

### Card Container

- **Border radius**: 12px (softer than main-board task cards)
- **Left border**: 4px solid colored accent (one of 5 colors: yellow, orange, pink, lime, blue)
- **Background**: White or light gray (matches main board cards for consistency)
- **Shadow**: Subtle drop shadow, same as main cards
- **Drag handle**: Small icon on left (inherited from main board DnD pattern)

### Card Content

**Layout** (top to bottom):
1. **Emoji** (centered, large): Single emoji character, font-size ~32px, vertically centered
2. **Title**: Bold, truncate to 2 lines, font-size 16px
3. **Description snippet**: Secondary text, 1 line truncated, font-size 13px, gray text
4. **Tags**: Colored chips below description, overflow wraps or shows "+N more"
5. **Status badge** (conditional):
   - **Approved**: "🔒 Locked" badge, muted color
   - **Promoted**: "✓ Promoted" badge with link to main ticket
   - **Dropped**: "✗ Dropped" badge, light gray

### Color Accent Mapping

| Color Name | Hex | Use Case |
|---|---|---|
| Yellow | #F5C518 | Feature idea, planning |
| Orange | #FF9500 | Enhancement, workflow |
| Pink | #FF6B9D | UI/UX improvement |
| Lime | #7FBC00 | Optimization, performance |
| Blue | #0078D7 | Tech debt, refactor |

**Default selection**: Random (not round-robin) from the 5 supported colors.

### State Styling

| State | Card Styling | Affordances |
|---|---|---|
| **Drafting** | Full opacity, white background, active drag handle | Drag, click to edit, delete, drop |
| **In Review** | Full opacity, white background, active drag handle | Drag, click to edit, approve/move, drop |
| **Approved** | Slightly dimmed (opacity ~0.85), "🔒 Locked" badge | Click to view (modal read-only), promote button visible, drop button visible |
| **Promoted** | Dimmed (opacity ~0.7), "✓" badge with link | Click to view source idea, click badge to open main ticket, no edits |
| **Dropped** | Dimmed (opacity ~0.6), "✗" badge, no drag handle | Click to view (read-only), no edits, permanently archived |

---

## Idea Ticket Modal

### Structure

Modal is opened when user clicks an idea card. Title: dynamic based on idea state.

#### Modal Header
- **Title**: "{idea title}" (or "New Idea" if create mode)
- **Close button**: X (top-right)
- **Status indicator**: Colored pill showing current state (Drafting | In Review | Approved | Promoted | Dropped)

#### Modal Body
**Section 1: Metadata**
- **Emoji picker** (editable in Drafting/In Review, read-only in Approved/Promoted/Dropped)
  - Click emoji → popover with grid of ~50 common emojis (no full library for simplicity)
  - Selected emoji shown large in the picker
- **Color swatches** (editable in Drafting/In Review, read-only in Approved/Promoted/Dropped)
  - 5 swatches (yellow, orange, pink, lime, blue) in a row
  - Selected color has a checkmark or border highlight
- **Title field** (text input, required, editable except when Approved/Promoted/Dropped)
- **Description field** (textarea, optional, editable except when Approved/Promoted/Dropped)
- **Tags field** (chip input, editable except when Approved/Promoted/Dropped)

**Section 2: Timestamps** (read-only)
- Created: "2026-04-21 14:30"
- Updated: "2026-04-21 15:45" (or not shown if never edited)

**Section 3: Origin Link** (conditional, visible only if origin_idea_id exists)
- Text: "💡 Origin Idea: [source idea title]" (clickable link, blue underline)
- Clicking navigates to the Idea Board and opens the source idea card in read-only mode

#### Modal Footer: Action Buttons

| State | Buttons Shown | Behavior |
|---|---|---|
| **Drafting** | Save, Move to Review, Drop | Save: commits edits; Move to Review: changes status to `in_review`; Drop: moves to Dropped |
| **In Review** | Approve, Move to Drafting, Drop | Approve: locks idea, transitions to Approved; Move to Drafting: resets status; Drop: moves to Dropped |
| **Approved** | Promote to Board, Drop, Cancel | Promote: opens preview panel; Drop: moves to Dropped; Cancel: closes modal |
| **Promoted** | View Ticket (link), Close | View Ticket: navigates to the created main-board ticket |
| **Dropped** | Close | No further actions; read-only inspection only |

**Unsaved Changes Indicator** (if implemented):
- Subtle dot or badge on Save button (gray) when modal has uncommitted changes
- Visual cue: "You have unsaved changes" on blur or focus loss
- On modal close without save: confirm dialog "Discard changes?"

#### Promotion Preview Panel

**Triggered by**: Clicking "Promote to Board" when idea is in Approved state

**Layout**:
- **Title**: "Preview Promotion"
- **Content**:
  - Read-only display of idea title, description, tags
  - **Destination board**: "Kanban Board (Main) — Backlog column"
  - **Origin tracking**: "This idea will be linked as the origin of the new ticket."
- **Buttons**:
  - **"Confirm Promotion"**: Creates main ticket, transitions idea to Promoted
  - **"Cancel"**: Dismisses preview, returns to main modal view

---

## Design Specifications — Supporting Concepts

### Emoji Picker

**Trigger**: Click emoji in modal or card creation form

**Behavior**:
- Opens a popover grid (e.g., 7 columns × 8 rows)
- Shows ~50 common emojis: 💡, 🚀, 🎨, 🐛, 📝, ✅, ⚡, 🎯, 🔧, 📊, 💰, 🌟, 🔔, 🎭, 📚, 🧠, 💻, 📱, ⏱️, 📈, 🎪, 🌈, 🎁, 🎪, 🎯, etc.
- Click to select; popover closes automatically
- Selected emoji appears large in the modal

**Design note**: Avoid third-party emoji libraries for now. Inline set of curated common emojis keeps bundle size small.

### Color Swatches

**Trigger**: Visible in modal body, above title field

**Behavior**:
- 5 colored squares in a row (yellow, orange, pink, lime, blue)
- Currently selected swatch shows a checkmark or thin border
- Click to change color
- Change applies to card's left-border accent immediately
- Default: random color on creation

### Drag-and-Drop

**Constraints**:
- Drag-drop works **only between idea columns** (Drafting ↔ In Review ↔ Approved ↔ Promoted ↔ Dropped)
- **No cross-board dragging**: Ideas cannot be dragged onto the Main Board or vice versa
- **Terminal state lock**: Ideas in Promoted or Dropped columns cannot be dragged (immobile)
- **Approved lock semantics**: Approved ideas can still be dragged into Dropped (product decision: approved ideas are droppable). If the product wants approved ideas immobile, clarify separately.

**Visual feedback**:
- Drag preview shows the card with reduced opacity
- Drop target (column) highlights with a dashed border
- Rollback on failed drop (card returns to origin column)

---

## Reference: Wireframes

Detailed wireframes are maintained in `docs/drafts/idea-board-wireframes-draft.excalidraw`. Frames include:

1. **Board Switcher**: Pill tabs (📋 Board | 💡 Ideas) in ProjectSidebar
2. **Idea Board Layout**: 5-column Kanban with empty states
3. **Idea Card Variants**: Drafting, In Review, Approved, Promoted, Dropped card states
4. **Idea Ticket Modal**: Full modal with emoji picker, color swatches, title, description, tags, buttons
5. **2-Stage Promote Flow**: Preview panel within modal, confirmation step
6. **Drag State**: Visual feedback during drag-and-drop
7. **Backlink Frame**: Main ticket with origin idea link and navigation

---

## Open Questions — Resolved

| Question | Decision | Rationale |
|---|---|---|
| Should idea schema be shared with main tickets? | **No** — separate minimal schema | Schema creep is the highest risk. Isolation ensures clarity and prevents feature bloat. |
| Who approves ideas? | **Self-service 2-stage** (approve → promote) | Solo developer tool. No approver hierarchy. Approval is a personal deliberation checkpoint. |
| Is promotion copy or move? | **Copy** (create new main ticket, archive idea) | Preserves idea genealogy via `origin_idea_id`. Allows reflection on idea quality. Hard delete is never done. |
| Should dropped ideas be hard-deleted? | **No** — keep in Dropped column | Reference value. Prevents accidental loss. Aligns with "no hard delete" philosophy. |
| Should approved ideas be droppable? | **Yes, drop is allowed** | Approved ideas haven't been promoted yet. If circumstances change, user should be able to drop without promoting first. |
| Should ideas support comments in v1? | **No** — defer to v2 | Adds significant complexity. Ideas are pre-social objects intended for solo capture. |
| How does schema protect against feature creep? | **Validation at tool layer rejects non-idea fields** | Priority, assignee, sprint, estimates are explicitly forbidden on idea tools. Type system enforces this. |

---

## Success Metrics (Non-Binding Signals)

- User captures ≥3 ideas per week per project (signals low-friction capture works)
- >70% of captured ideas make it through to approve/promote or deliberate drop (signals the 2-stage process feels natural, not tedious)
- 0 accidental main-board promotions (schema isolation prevents misclassification)
- Multi-tab sync is sub-500ms (SSE invalidation is responsive)
- Drag-and-drop has <100ms perceptual latency (DnD UX feels snappy)

---

## Last Updated

2026-04-21, synthesized from agent drafts (BA spec, tech analysis, wireframes, testing plan)
