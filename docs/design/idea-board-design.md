---
title: "Idea Board — Design Document"
type: arch
status: draft
version: 1.0.0
created: 2026-04-21
updated: 2026-04-21
authors: [Design Team]
related:
  - docs/arch-kanban-board.md
---

# Idea Board — Design Document

## 1. Overview & Goals

Each project in the Kanban app currently has one main board (Backlog → Todo → In Progress → Done → Won't Do). This feature adds a second board per project: the **Idea Board**.

**Goals:**
- Provide a low-friction, visually engaging space for capturing raw ideas, notes, and concepts
- Keep idea capture separate from execution (main board) to reduce noise
- Enable clean promotion of approved ideas into the main board backlog
- Make the idea board *fun to look at* — it should feel like a creative sketchpad, not another task list

**Non-goals:**
- The idea board is NOT a planning tool — no sprints, no estimates, no assignees
- The idea schema must NOT grow to match the main board schema (schema creep is the primary risk)

---

## 2. Design Principles

| Principle | Description |
|---|---|
| **Low friction at entry** | Capturing an idea takes 3 fields: emoji + title + description. Nothing else required. |
| **Visually distinct from main board** | Idea cards look like colorful sticky notes / concept cards, not regular task cards |
| **Structured enough to promote** | When ready, one click promotes to main backlog — no form filling |
| **Provenance preserved** | Every promoted ticket retains a link back to its source idea |
| **Schema stays minimal** | Idea tickets have: emoji, color, title, description, tags only. This is a design constraint, not a limitation. |

---

## 3. UX Flows

### 3.1 Switching Between Boards

The ProjectSidebar will show two tabs below each project name:
- **📋 Board** — the existing main board
- **💡 Ideas** — the new idea board

Selecting a tab switches the main content area. The selected board is remembered per project (stored in local state / URL param).

### 3.2 Idea Capture Flow

1. User is on the Idea Board
2. Clicks "+ New Idea" in any column (or a top-level "+ Add Idea" button)
3. A lightweight creation form appears: emoji picker | title field | description (optional)
4. Submit → idea card appears in "Drafting" column
5. Total time: < 30 seconds

### 3.3 Review & Promote Flow

1. User moves an idea card to "In Review" column (drag & drop, same as main board)
2. Opens the idea card modal
3. Reviews title, description, optionally adds tags
4. Clicks **"✅ Approve & Promote to Board"** button
5. System:
   - Creates a new ticket on the main board in "Backlog" status
   - Copies: title + description
   - Sets `origin_idea_id` on the new ticket (permanent, read-only)
   - Transitions idea ticket to "Promoted" status (archived)
6. User is shown a confirmation with a link to the new main board ticket

### 3.4 Drop Flow

1. User opens an idea card modal
2. Clicks **"🗑️ Drop Idea"** (subtle secondary button)
3. Idea transitions to "Dropped" column
4. No deletion — ideas are kept for reference

---

## 4. Idea Board Columns

| Column | Status Key | Emoji | Description |
|---|---|---|---|
| Drafting | `drafting` | 🌱 | Raw captures — no commitment, no judgment |
| In Review | `in_review` | 🔍 | Being actively considered for promotion |
| Promoted | `promoted` | ✅ | Promoted to main board — shows link to ticket |
| Dropped | `dropped` | 🗑️ | Not moving forward — kept for reference |

---

## 5. Idea Card Visual Design

Idea cards are intentionally visually richer than regular task cards:

| Element | Description |
|---|---|
| **Color accent bar** | Colored top-bar (user-selected or random from palette). Colors: pink, blue, yellow, lime, orange |
| **Large emoji** | Top-left, ~24px. Represents the idea visually at a glance |
| **Bold title** | Larger font than regular cards |
| **Description snippet** | 2-line preview (truncated) |
| **Tag chips** | Small, colorful chips at the bottom. Each tag has its own color |
| **Shape** | More rounded corners, subtle elevation/shadow — "sticky note" feel |

**Color palette for card accents:**
- 🟡 `--color-yellow` (#F5C518 or similar)
- 🔵 `--color-blue`
- 🩷 `--color-pink`
- 🟢 `--color-lime`
- 🟠 `--color-orange`

---

## 6. Idea Ticket Modal

The idea modal is a simplified version of the main ticket modal:

**Fields shown:**
- Emoji picker (large, prominent)
- Color accent picker (5 color swatches)
- Title (editable, large font)
- Description (rich text: bold, bullets, highlights via existing react-markdown setup)
- Tags (multi-select chips)

**Fields intentionally omitted:** assignee, priority, sprint, estimate, due date, start date, acceptance criteria, work log, test cases, parent_id

**Actions:**
- **"✅ Approve & Promote to Board"** — prominent, colored button (bottom of modal). Only shown when status = `in_review`.
- **"🗑️ Drop Idea"** — subtle secondary button. Shown for `drafting` and `in_review` statuses.
- **"↩️ Back to Drafting"** — ghost button. Shown when status = `in_review`.
- For `promoted` cards: show read-only link "→ Main ticket: [ticket-id]"

---

## 7. Design References

- Wireframes: [idea-board-wireframes.excalidraw](./idea-board-wireframes.excalidraw)
- Kanban ticket: IAM-100
- Existing color tokens: ui/src/index.css

---

## 8. Open Questions (resolved)

| Question | Decision |
|---|---|
| Separate board or triage column? | Separate board |
| Who approves? | Self-service — user decides when their own idea is ready |
| Schema shared with main board? | No — separate minimal schema |
| Promote = copy or move? | Copy (create new main ticket) — idea ticket archived, link preserved |
| What happens to dropped ideas? | Stay in Dropped column — no hard delete |
