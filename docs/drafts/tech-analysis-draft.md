---
title: "Idea Board Feature — Comprehensive Technical Analysis"
type: technical-analysis
status: draft
version: 1.0.0
created: 2026-04-21
---

# Idea Board Feature — Technical Analysis

## Executive Summary

Thorough codebase analysis reveals a well-structured, production-ready system for Idea Board integration. Most patterns can be directly reused; only data model and MCP tool registration require new implementations.

**Estimated Effort: 14–20 hours**

---

## 1. Ticket Model Analysis

### Fields to Reuse
- title, description, tags, comments
- created_at, updated_at, project_id

### Fields to ADD (Required)
1. `board` (Enum: 'main' | 'idea') — default 'main', indexed
2. `idea_status` (Enum: 'drafting' | 'in_review' | 'approved' | 'promoted' | 'dropped')
3. `idea_emoji` (String, nullable) — single emoji char
4. `idea_color` (Enum: yellow|orange|pink|lime|blue) — nullable
5. `origin_idea_id` (FK to Ticket, nullable) — tracks promoted source

### Migration Pattern (SAFE)
Use batch_alter_table. All columns nullable/have defaults so existing data is unaffected.

---

## 2. Database Layer

- ORM: SQLModel (async SQLAlchemy)
- DB: SQLite + aiosqlite
- Migrations: Alembic
- Transaction Mode: WAL enabled

For Idea Board: no changes to core architecture. Add migration using existing batch_alter_table pattern. Filter queries by board='main' or board='idea'.

---

## 3. MCP Tools — 5 New Tools Needed

| Tool | Signature | Notes |
|---|---|---|
| list_idea_tickets | (project_id, status?) | NEW |
| create_idea_ticket | (project_id, title, description?, tags?, emoji?, color?) | NEW |
| update_idea_ticket | (ticket_id, title?, desc?, tags?, emoji?, color?, status?) | NEW |
| promote_idea_ticket | (ticket_id) — validates status='approved' | NEW |
| drop_idea_ticket | (ticket_id) | NEW |

All idea tools must reject non-idea fields (no priority, estimate, assignee).
Promote validates status='approved' (2-stage: approve first, then promote).

---

## 4. SSE Events

Current: broadcast "invalidate" on all mutations.

New event types to add (no architecture change):
- "idea_ticket_created"
- "idea_ticket_updated"
- "idea_ticket_promoted" — must invalidate BOTH idea + main board caches
- "idea_ticket_dropped"

---

## 5. React Query Hooks (ui/src/api/ideaTickets.ts)

New hooks needed:
- useIdeaTickets(projectId, status?)
- useCreateIdeaTicket(projectId)
- useUpdateIdeaTicket()
- usePromoteIdeaTicket()
- useDropIdeaTicket()

Cache keys:
- ['idea-tickets', projectId]
- ['idea-tickets', projectId, status]

CRITICAL: Keep completely separate from ['tickets', projectId] cache keys.

On promote: invalidate both ['idea-tickets', projectId] AND ['tickets', projectId].

---

## 6. Board Components

New components:
- IdeaBoard.tsx — main container (same @dnd-kit pattern as Board.tsx)
- IdeaColumn.tsx — column per idea status
- IdeaCard.tsx — left-border accent + centered emoji + title + description + tags
- IdeaTicketModal.tsx — simplified modal (emoji picker, color picker, title, description, tags, 2-stage approve/promote flow)
- EmojiPicker.tsx — lightweight inline emoji grid (no heavy library)
- ColorAccentPicker.tsx — 5 swatches
- BoardSwitcher.tsx — pill tabs (📋 Board | 💡 Ideas) in ProjectSidebar

Columns: drafting → in_review → approved → promoted (terminal) | dropped (terminal)
Drag-drop: separate @dnd-kit context from main Board; no cross-board drag.

---

## 7. ProjectSidebar

Add BoardSwitcher below project name. Persist current board ('main' | 'idea') to localStorage per project.

---

## 8. TicketModal vs IdeaTicketModal

IdeaTicketModal is a simplified fresh component. Reuse: modal shell/backdrop, tag input pattern, rich text approach.
Omit entirely: assignee, priority, estimate, sprint, dates, AC, work log, test cases, parent/child.
New: emoji picker, color swatches, 2-stage approve → promote buttons, "Origin: idea" link on main tickets.

---

## 9. CSS Tokens

Reuse existing:
- --color-yellow, --color-orange, --color-pink, --color-lime, --color-blue

Consider adding:
- --idea-card-border-radius: 12px (vs regular cards)
- --idea-accent-width: 4px (left border bar)

---

## 10. Risk Flags

HIGH:
- Cache key collision: ['idea-tickets'] vs ['tickets'] must stay separate or silent data bugs occur
- Status field overload: 'status' used for both main and idea statuses — validation at tool layer is critical
- 2-stage promote: approve_idea_ticket must lock the ticket from edits before promote_idea_ticket runs

MEDIUM:
- origin_idea_id orphans: no DB cascade if idea is ever hard-deleted — add app-level guard
- Missing indexes: add (board) and (board, idea_status) composite index for query perf
- TypeScript type safety: use discriminated union (MainTicket | IdeaTicket) to avoid runtime errors

LOW:
- Emoji validation: trim to 1 emoji char on save
- localStorage validation: handle corrupted/stale board selection on load

---

## Implementation Sequence

1. Schema Migration (1–2h) — columns + indexes
2. Models + enums (1h)
3. MCP Tools (2–3h) — 5 new tools
4. SSE events (0.5h)
5. React Query hooks (1–2h)
6. UI Components (4–6h) — 7 new components
7. Integration (1–2h) — routing, SSE invalidation, App.tsx

Total: 14–20 hours
