---
title: "Idea Board — Technical Architecture"
type: arch
status: draft
version: 1.0.0
created: 2026-04-21
updated: 2026-04-21
authors: [Development Team]
related:
  - docs/ba-idea-board.md
---

# Idea Board — Technical Architecture

## 1. Data Model Changes

### 1.1 Ticket Table Extensions

Add two new columns to the existing `tickets` table:

| Column | Type | Default | Description |
|---|---|---|---|
| `board` | Enum: `main` \| `idea` | `main` | Which board this ticket belongs to |
| `origin_idea_id` | String (nullable) | null | For promoted tickets: the source idea ticket ID |

### 1.2 New Idea-specific Fields

Add to ticket model (only populated for `board = idea`):

| Column | Type | Default | Description |
|---|---|---|---|
| `idea_emoji` | String (nullable) | null | Single emoji character for the idea card |
| `idea_color` | Enum (nullable) | null | Card accent color: yellow/blue/pink/lime/orange |

### 1.3 Idea Board Statuses

New status values (only valid when `board = idea`):

| Status | Description |
|---|---|
| `drafting` | Raw capture — default status for new idea tickets |
| `in_review` | Being considered for promotion |
| `promoted` | Promoted to main board — terminal state (archived) |
| `dropped` | Discarded — terminal state (kept for reference) |

Main board statuses (unchanged): `backlog`, `todo`, `in-progress`, `done`, `wont_do`

### 1.4 DB Migration

Add migration script at `server/migrations/add_idea_board_fields.py`:
- ALTER TABLE tickets ADD COLUMN board VARCHAR DEFAULT 'main'
- ALTER TABLE tickets ADD COLUMN origin_idea_id VARCHAR NULL
- ALTER TABLE tickets ADD COLUMN idea_emoji VARCHAR NULL
- ALTER TABLE tickets ADD COLUMN idea_color VARCHAR NULL
- Update sqlmodel model class in server/models.py accordingly

---

## 2. Server-side Changes

### 2.1 models.py Updates

```python
from enum import Enum

class BoardType(str, Enum):
    MAIN = "main"
    IDEA = "idea"

class IdeaColor(str, Enum):
    YELLOW = "yellow"
    BLUE = "blue"
    PINK = "pink"
    LIME = "lime"
    ORANGE = "orange"

class IdeaStatus(str, Enum):
    DRAFTING = "drafting"
    IN_REVIEW = "in_review"
    PROMOTED = "promoted"
    DROPPED = "dropped"

# In Ticket model, add:
# board: BoardType = Field(default=BoardType.MAIN)
# origin_idea_id: Optional[str] = Field(default=None)
# idea_emoji: Optional[str] = Field(default=None)
# idea_color: Optional[IdeaColor] = Field(default=None)
```

### 2.2 New MCP Tools

Add to `server/mcp_tools.py`:

| Tool | Parameters | Description |
|---|---|---|
| `list_idea_tickets` | `project_id`, `status?` | List idea tickets for a project |
| `create_idea_ticket` | `project_id`, `title`, `description?`, `tags?`, `idea_emoji?`, `idea_color?` | Create new idea (status=drafting) |
| `update_idea_ticket` | `ticket_id`, `title?`, `description?`, `tags?`, `idea_emoji?`, `idea_color?`, `status?` | Update idea fields + move between idea statuses |
| `promote_idea_ticket` | `ticket_id` | Promote idea → creates main backlog ticket, archives idea, sets origin_idea_id |
| `drop_idea_ticket` | `ticket_id` | Move idea to dropped status |

### 2.3 promote_idea_ticket Logic

```
1. Fetch idea ticket by id — validate board=idea, status=in_review
2. Create new Ticket:
   - board = "main"
   - project_id = same as idea
   - title = idea.title
   - description = idea.description
   - status = "backlog"
   - origin_idea_id = idea.id
3. Update idea ticket:
   - status = "promoted"
4. Return: { promoted_ticket_id, idea_ticket_id }
```

### 2.4 list_tickets Update

Existing `list_tickets` tool: add optional `board` filter param (default: `main`) so it doesn't mix idea and main tickets.

---

## 3. Frontend Architecture

### 3.1 New Components

| Component | Path | Description |
|---|---|---|
| `BoardSwitcher` | ui/src/components/BoardSwitcher.tsx | Tabs: "📋 Board" / "💡 Ideas" — shown in ProjectSidebar per project |
| `IdeaBoard` | ui/src/components/IdeaBoard.tsx | Main idea board layout (wraps IdeaColumns) |
| `IdeaColumn` | ui/src/components/IdeaColumn.tsx | Single column (Drafting/In Review/Promoted/Dropped) |
| `IdeaCard` | ui/src/components/IdeaCard.tsx | Visually rich card with emoji, color bar, tags |
| `IdeaTicketModal` | ui/src/components/IdeaTicketModal.tsx | Simplified modal: emoji+color picker, title, description, tags, promote/drop actions |
| `EmojiPicker` | ui/src/components/EmojiPicker.tsx | Lightweight inline emoji selection (no heavy library) |
| `ColorAccentPicker` | ui/src/components/ColorAccentPicker.tsx | 5-swatch color selector |

### 3.2 Modified Components

| Component | Change |
|---|---|
| `ProjectSidebar.tsx` | Add `BoardSwitcher` below project name |
| `App.tsx` / main router | Conditionally render `IdeaBoard` vs `Board` based on selected board type |
| `api/useTickets.ts` | Add `board` param support; add `useIdeaTickets` hook |

### 3.3 New API Hooks (ui/src/api/)

| Hook | File | Description |
|---|---|---|
| `useIdeaTickets` | useIdeaTickets.ts | Fetch idea tickets, filter by status |
| `useCreateIdeaTicket` | useIdeaTickets.ts | Mutation: create idea |
| `useUpdateIdeaTicket` | useIdeaTickets.ts | Mutation: update idea fields/status |
| `usePromoteIdeaTicket` | useIdeaTickets.ts | Mutation: promote → invalidates both idea + main board queries |
| `useDropIdeaTicket` | useIdeaTickets.ts | Mutation: drop idea |

### 3.4 React Query Cache Keys

```
['idea-tickets', projectId]           — all idea tickets for project
['idea-tickets', projectId, status]   — filtered by status
['tickets', projectId]                — existing main board cache (unchanged)
```

On promote: invalidate both `['idea-tickets', projectId]` and `['tickets', projectId]`

### 3.5 Drag & Drop

Idea board uses `@dnd-kit` same as main board. Dragging across idea columns updates status via `useUpdateIdeaTicket`. No drag between idea board and main board (promotion is intentional action, not drag).

---

## 4. CSS Module Structure

New CSS modules:
- `IdeaBoard.module.css` — board layout
- `IdeaColumn.module.css` — column styles
- `IdeaCard.module.css` — card with color accent bar, emoji, tags
- `IdeaTicketModal.module.css` — modal with emoji/color pickers, promote button

Color accent mapping (using existing CSS vars):
```css
[data-color="yellow"] { --card-accent: var(--color-yellow); }
[data-color="blue"]   { --card-accent: var(--color-blue); }
[data-color="pink"]   { --card-accent: var(--color-pink); }
[data-color="lime"]   { --card-accent: var(--color-lime); }
[data-color="orange"] { --card-accent: var(--color-orange); }
```

---

## 5. SSE Invalidation

The existing `useSSEInvalidation.ts` hook listens for server-sent events and invalidates React Query cache. Add handlers for new event types:
- `idea_ticket_created` → invalidate `['idea-tickets', projectId]`
- `idea_ticket_updated` → invalidate `['idea-tickets', projectId]`
- `idea_ticket_promoted` → invalidate `['idea-tickets', projectId]` + `['tickets', projectId]`

---

## 6. Constraints & Design Guards

| Constraint | Enforcement |
|---|---|
| Idea ticket schema is minimal | `create_idea_ticket` and `update_idea_ticket` MCP tools only accept idea-specific fields — no assignee, priority, sprint, estimate |
| Main board list_tickets excludes ideas | `list_tickets` defaults `board=main`, never returns idea tickets unless explicitly requested |
| Promote only from in_review | `promote_idea_ticket` rejects tickets not in `in_review` status |
| origin_idea_id is immutable | Backend: once set on a promoted ticket, `update_ticket` ignores updates to `origin_idea_id` |
| No cross-board drag | DnD context for IdeaBoard is separate from main Board context |
