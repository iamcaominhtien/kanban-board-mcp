---
title: "IAM-100 Idea Board — BA Specification Draft"
type: ba-spec-draft
status: draft
created: 2026-04-21
---

# IAM-100: Idea Board — BA Specification

## Problem Statement

A developer managing a personal Kanban board often has raw, unformed ideas that don't belong in the structured main board but still need to be captured somewhere. Currently, the only option is to dump them into Backlog (cluttering it) or keep them in a separate notes app (losing the connection to the project). The result: ideas either pollute the main board or get lost entirely.

## Business Objective

Provide a low-friction, visually engaging space per project where ideas can be captured freely, reviewed at a natural pace, and promoted cleanly into actionable tickets — without contaminating the execution board.

## Why "Why"?

5 Whys applied:
1. Why do ideas clutter the main backlog? → Because there's no other place for them.
2. Why does that matter? → Main backlog becomes noisy and hard to prioritize.
3. Why is that a problem? → Real work gets buried under speculative ideas.
4. Why not just use tags or types? → No visual/cognitive separation — ideas still appear in the same list.
5. Why does separation matter? → Different cognitive modes: brainstorm mode vs execution mode. Mixing them kills both.

**Root insight**: This is not a data organization problem. It is a cognitive mode separation problem.

---

## Actors

| Actor | Role | Primary Goal |
|---|---|---|
| Project Owner (solo dev) | Creates and manages ideas | Capture freely, promote selectively |
| AI Agents (MCP clients) | Create/query idea tickets programmatically | List, create, promote via MCP tools |

---

## User Stories

### Epic: Idea Capture
**US-1**: As a developer, I want to quickly capture an idea on the Idea Board so that I don't lose it and don't clutter the main board.
- AC: Clicking "+ New Idea" shows a minimal form: emoji (optional) + title (required) + description (optional). Submit creates idea in Drafting column. Time to capture < 30 seconds.

**US-2**: As a developer, I want to give my idea a visual identity (emoji + color) so that I can recognize it at a glance.
- AC: Each idea card shows: a colored left-border accent (1 of 5 colors), a large emoji, bold title, description snippet, tags. Default: random color, 💡 emoji.

### Epic: Idea Review
**US-3**: As a developer, I want to move an idea from Drafting to In Review when I'm considering it seriously.
- AC: Dragging a card into "In Review" column or using the modal status change updates idea_status to in_review.

**US-4**: As a developer, I want to approve an idea before promoting it, so I have a deliberate checkpoint.
- AC: "Approve" button visible only when status = in_review. Clicking sets status = approved and locks idea from further edits until promoted or rejected.

### Epic: Promotion
**US-5**: As a developer, I want to promote an approved idea to the main board backlog with one action, so the transition is frictionless.
- AC: "Promote to Board" button visible when status = approved. Clicking shows a preview panel (title, description, destination board). Confirming: creates main ticket in backlog, sets origin_idea_id, transitions idea to promoted. No extra fields required at promotion time.

**US-6**: As a developer, I want to see where a promoted idea came from when viewing the main board ticket.
- AC: Main board ticket modal shows "💡 Origin Idea: [title]" link. Clicking navigates back to Idea Board and opens the source idea card (read-only).

**US-7**: As a developer, I want to drop an idea that isn't going anywhere, so the board stays tidy.
- AC: "Drop Idea" button available for drafting/in_review status. Clicking transitions to dropped status. Dropped ideas remain visible in Dropped column (no hard delete).

### Epic: Board Navigation
**US-8**: As a developer, I want to switch between the main board and the idea board with a single click per project.
- AC: ProjectSidebar shows two tabs per project: "📋 Board" | "💡 Ideas". Selection persists in localStorage per project.

---

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-1 | Each project has exactly 2 boards: main and idea | Must Have |
| FR-2 | Idea board has 4 columns: Drafting, In Review, Approved, Promoted, Dropped | Must Have |
| FR-3 | Idea ticket schema: emoji, color, title, description, tags only | Must Have |
| FR-4 | Drag-and-drop between idea columns (not between idea and main boards) | Must Have |
| FR-5 | 2-stage promote: Approve → Preview → Confirm | Must Have |
| FR-6 | origin_idea_id on promoted main ticket (permanent, read-only) | Must Have |
| FR-7 | Back-link from main ticket to source idea | Should Have |
| FR-8 | Visual distinctiveness: cards look like concept cards, not task cards | Should Have |
| FR-9 | Empty state with inspiring CTA | Should Have |
| FR-10 | Unsaved changes indicator in modal | Could Have |
| FR-11 | MCP tools for all idea board operations | Must Have |
| FR-12 | SSE invalidation for multi-tab sync | Should Have |

## Non-Functional Requirements

| ID | Requirement |
|---|---|
| NFR-1 | Idea schema must NOT grow to include priority, assignee, sprint, or estimate |
| NFR-2 | Main board list_tickets must never return idea tickets by default |
| NFR-3 | Promotion must be idempotent (promoting twice = second call fails gracefully) |
| NFR-4 | DB migration must be safe for existing data (no data loss) |

---

## Process Flows

### Idea Capture Flow
User on Idea Board → clicks "+ New Idea" → minimal form (emoji, title, description) → Submit → idea in Drafting column

### Promotion Flow
Idea card in In Review → open modal → click "Approve" → status=approved, edits locked → click "Promote to Board" → preview panel (title, description, destination) → confirm → main backlog ticket created (with origin_idea_id) → idea card moves to Promoted (with link to new ticket) → success toast with "Open ticket" option

### Drop Flow
Any idea card (drafting or in_review) → open modal → click "Drop Idea" → status=dropped → card moves to Dropped column

---

## Open Questions (Resolved)

| Question | Decision | Rationale |
|---|---|---|
| Shared schema with main? | No — separate minimal schema | Schema creep is the primary risk |
| Who approves? | Self-service (2-stage: approve then promote) | Solo tool — no approver hierarchy needed |
| Promote = copy or move? | Copy (new main ticket) + archive idea | Preserve idea provenance; keep audit trail |
| Hard delete for dropped? | No — keep in Dropped column | Reference value; avoids accidental loss |
| Comments on ideas? | Not in v1 | Adds complexity; ideas are pre-social objects |
