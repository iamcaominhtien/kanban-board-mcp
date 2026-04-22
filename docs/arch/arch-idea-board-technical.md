---
title: "IAM-100: Idea Board — Technical Architecture"
type: arch
status: stable
version: 1.0.0
created: 2026-04-21
updated: 2026-04-21
authors: ["GitHub Copilot"]
related:
  - docs/design/idea-board-design.md
  - docs/specs/IAM-100-idea-board-spec.md
---

# IAM-100: Idea Board — Technical Architecture

## 1. Data Model Changes

### New Enums

```python
from enum import Enum

class BoardType(str, Enum):
    """Which board a ticket belongs to."""
    MAIN = "main"
    IDEA = "idea"

class IdeaStatus(str, Enum):
    """Lifecycle states for idea-board tickets."""
    DRAFTING = "drafting"
    IN_REVIEW = "in_review"
    APPROVED = "approved"
    PROMOTED = "promoted"
    DROPPED = "dropped"

class IdeaColor(str, Enum):
    """Accent colors for idea cards."""
    YELLOW = "yellow"
    ORANGE = "orange"
    PINK = "pink"
    LIME = "lime"
    BLUE = "blue"
```

### Extended Ticket Model

**File**: `server/models.py`

Add 5 new fields to the Ticket class:

| Field | Type | Default | Nullable | Constraints |
|---|---|---|---|---|
| `board` | BoardType (Enum) | "main" | No | Immutable after creation |
| `idea_status` | IdeaStatus (Enum) | NULL | Yes | Only set when board='idea' |
| `idea_emoji` | String | NULL | Yes | 1 character max; defaults to 💡 on creation |
| `idea_color` | IdeaColor (Enum) | NULL | Yes | One of 5 predefined colors; randomized on creation |
| `origin_idea_id` | VARCHAR (FK) | NULL | Yes | Foreign key to Ticket.id; only set on promoted tickets |

### Database Schema

**Migration file**: `server/migrations/add_idea_board_fields.py`

```sql
-- Add new columns to tickets table
ALTER TABLE tickets ADD COLUMN board VARCHAR DEFAULT 'main' NOT NULL;
ALTER TABLE tickets ADD COLUMN idea_status VARCHAR NULL;
ALTER TABLE tickets ADD COLUMN idea_emoji VARCHAR NULL;
ALTER TABLE tickets ADD COLUMN idea_color VARCHAR NULL;
ALTER TABLE tickets ADD COLUMN origin_idea_id VARCHAR NULL;

-- Create indexes for query performance
CREATE INDEX idx_tickets_board ON tickets(board);
CREATE INDEX idx_tickets_board_status ON tickets(board, idea_status);
CREATE INDEX idx_tickets_origin_idea ON tickets(origin_idea_id);
```

**Migration pattern**: Use Alembic's `batch_alter_table()` for SQLite compatibility. Migration is idempotent:
- Checks if columns already exist before adding
- Safe on fresh DB and existing DB with data
- Can run twice without error

---

## 2. MCP Tool Contracts

All MCP tools live in `server/mcp_tools.py`. Each tool enforces strict input validation.

### Tool 1: `list_idea_tickets`

**Signature**:
```python
def list_idea_tickets(
    project_id: str,
    status: Optional[IdeaStatus] = None
) -> List[Ticket]:
```

**Validation**:
- `project_id`: Must exist in DB (raise ValueError if not)
- `status`: Optional filter (if provided, must be valid IdeaStatus)

**Returns**: List of Ticket objects where `board='idea'` and (if status provided) `idea_status=status`

**Use case**: Query all ideas, optionally filtered by lifecycle state

---

### Tool 2: `create_idea_ticket`

**Signature**:
```python
def create_idea_ticket(
    project_id: str,
    title: str,
    description: Optional[str] = None,
    tags: Optional[List[str]] = None,
    idea_emoji: Optional[str] = None,
    idea_color: Optional[IdeaColor] = None
) -> Ticket:
```

**Validation**:
- `project_id`: Must exist (ValueError if not)
- `title`: Required, non-empty, ≤ 255 characters
- `description`: Optional, any length
- `tags`: Optional list of strings
- `idea_emoji`: Optional, must be single character; defaults to 💡
- `idea_color`: Optional, must be valid IdeaColor; randomized if not provided

**Schema guard**: Reject with error if client attempts to pass priority, assignee, sprint, estimate, due_date, start_date, AC, work log, or test cases

**Returns**: Created Ticket with:
- `board='idea'`
- `idea_status='drafting'`
- All provided fields set
- Timestamps (created_at, updated_at) auto-set

**Use case**: Capture quick ideas without cognitive overhead

---

### Tool 3: `update_idea_ticket`

**Signature**:
```python
def update_idea_ticket(
    ticket_id: str,
    title: Optional[str] = None,
    description: Optional[str] = None,
    tags: Optional[List[str]] = None,
    idea_emoji: Optional[str] = None,
    idea_color: Optional[IdeaColor] = None,
    idea_status: Optional[IdeaStatus] = None
) -> Ticket:
```

**Validation**:
- `ticket_id`: Must exist and board='idea'
- All other fields: Optional; only update provided fields
- `idea_emoji`: Must be single character (if provided)
- `idea_color`: Must be valid IdeaColor (if provided)
- `idea_status`: Must be valid IdeaStatus; valid transitions: drafting→in_review, in_review→{approved, drafting}, approved→{promoted, dropped}, promoted/dropped→(terminal, no changes)

**Lock enforcement** (HIGH RISK):
- If current `idea_status='approved'`, **reject all edits to title/description/tags** with error: "This idea is approved and locked. Promote it to the main board or move it back to review to edit."
- Emoji and color changes are allowed on approved ideas (metadata-only)

**Schema guard**: Reject non-idea fields (priority, assignee, etc.)

**Returns**: Updated Ticket

**Use case**: Move ideas through workflow; edit in drafting/review states

---

### Tool 4: `promote_idea_ticket`

**Signature**:
```python
def promote_idea_ticket(ticket_id: str) -> Dict[str, Any]:
```

**Validation**:
- `ticket_id`: Must exist, board='idea', idea_status='approved'
- Rejects if already promoted or dropped (error: "Idea must be in approved state")

**Atomic 3-step transaction** (CRITICAL):
1. **Create main ticket**:
   - Set board='main', status='backlog'
   - Copy title, description, tags from idea
   - Set origin_idea_id=ticket_id
   - Auto-generate ID (UUID)
2. **Update idea**:
   - Set idea_status='promoted'
   - Update updated_at timestamp
3. **Broadcast SSE event**:
   - Event type: `idea_ticket_promoted`
   - Payload: {idea_id, main_ticket_id, main_ticket}

**Rollback guarantee**: If any step fails, entire transaction rolls back (database, no orphaned main tickets)

**Returns**:
```json
{
  "promoted_ticket_id": "<main_ticket_uuid>",
  "idea_ticket_id": "<idea_ticket_uuid>",
  "promoted_ticket": {<full Ticket object>}
}
```

**Idempotency**: Calling promote twice on same idea fails gracefully (second call sees idea_status='promoted', not 'approved', so validation rejects it)

**Use case**: Move approved idea to main board as backlog ticket

---

### Tool 5: `drop_idea_ticket`

**Signature**:
```python
def drop_idea_ticket(ticket_id: str) -> Ticket:
```

**Validation**:
- `ticket_id`: Must exist and board='idea'
- Rejects if idea_status='promoted' (cannot drop promoted idea)

**Actions**:
- Set idea_status='dropped'
- Update updated_at timestamp
- Broadcast SSE event: `idea_ticket_dropped` with payload {ticket_id, idea_status}
- **No hard delete**: Idea remains in DB for audit trail

**Returns**: Updated Ticket with idea_status='dropped'

**Use case**: Archive ideas without deletion

---

### Updated Tool: `list_tickets`

**New signature** (BACKWARD COMPATIBLE):
```python
def list_tickets(
    project_id: str,
    board: Optional[BoardType] = BoardType.MAIN,
    status: Optional[str] = None
) -> List[Ticket]:
```

**Changes**:
- New param: `board` (default BoardType.MAIN for backward compatibility)
- If board=BoardType.MAIN: filter by board='main'
- If board=BoardType.IDEA: filter by board='idea'
- `status` filter applies to appropriate enum (TicketStatus for main, IdeaStatus for idea)

**Impact**: Existing calls to list_tickets() (without board param) still work and return main-board tickets only

---

## 3. Server-Side Events (SSE)

**File**: `server/events.py`

Add 4 new SSE event types:

| Event Type | Payload | Broadcast Trigger |
|---|---|---|
| `idea_ticket_created` | {project_id, idea_ticket} | After create_idea_ticket |
| `idea_ticket_updated` | {project_id, idea_ticket} | After update_idea_ticket |
| `idea_ticket_promoted` | {project_id, idea_ticket_id, main_ticket} | After promote_idea_ticket (step 3) |
| `idea_ticket_dropped` | {project_id, idea_ticket_id, idea_status} | After drop_idea_ticket |

All events include `project_id` for scoped invalidation on the frontend.

---

## 4. Frontend Architecture

### New Components

All components use TypeScript + React. Styling via CSS modules (Tailwind compatible).

#### 4.1 BoardSwitcher

**File**: `ui/src/components/BoardSwitcher.tsx`

**Purpose**: Pill-tab selector to switch between main board and idea board

**Props**:
```typescript
interface BoardSwitcherProps {
  projectId: string;
  onBoardChange: (board: 'main' | 'idea') => void;
}
```

**State**: 
- Current board selection stored in custom hook `useBoardSelection(projectId)` which uses localStorage

**Rendering**:
- Two pill tabs: "📋 Board" and "💡 Ideas"
- Active tab: darker bg, white text
- Click → call onBoardChange

**Styling**: `ui/src/components/BoardSwitcher.module.css`

---

#### 4.2 IdeaBoard

**File**: `ui/src/components/IdeaBoard.tsx`

**Purpose**: Main container for the 5-column Kanban idea board

**Props**:
```typescript
interface IdeaBoardProps {
  projectId: string;
}
```

**State**:
- Fetches ideas via `useIdeaTickets(projectId)` (React Query)
- Manages DnD context (@dnd-kit/core, @dnd-kit/utilities)
- Manages quick-create modal (open/close)

**Rendering**:
- Header: "💡 Idea Board" title, "+" button for new idea
- 5 IdeaColumn children (one per status)
- DnD context wraps all columns

**Drag-drop logic**:
- Source: any column (Drafting, In Review, Approved)
- Target: Drafting, In Review, Approved (Promoted and Dropped are terminal, receive-only or immobile)
- On drop: call `useUpdateIdeaTicket(ticketId, {idea_status: newStatus})`
- Optimistic update: move card immediately; rollback on error

---

#### 4.3 IdeaColumn

**File**: `ui/src/components/IdeaColumn.tsx`

**Purpose**: Droppable zone for one status column

**Props**:
```typescript
interface IdeaColumnProps {
  status: IdeaStatus;
  ideas: Ticket[];
  onDrop: (idea: Ticket, newStatus: IdeaStatus) => void;
}
```

**Rendering**:
- Header: column name, emoji, count of ideas
- Droppable container (@dnd-kit)
- IdeaCard components for each idea
- Empty state: "No ideas yet — create one!"

**Styling**: `ui/src/components/IdeaColumn.module.css`

---

#### 4.4 IdeaCard

**File**: `ui/src/components/IdeaCard.tsx`

**Purpose**: Visual card for a single idea with emoji, color accent, metadata

**Props**:
```typescript
interface IdeaCardProps {
  idea: Ticket;
  onOpenModal: (idea: Ticket) => void;
}
```

**Rendering** (top to bottom):
1. Drag handle (6-dot icon, @dnd-kit/utilities)
2. Emoji (centered, ~32px, monospace font)
3. Title (bold, 2-line truncate)
4. Description snippet (1 line, gray text)
5. Tags (chip components, overflow shows "+N more")

**Left border**: 4px solid, color mapped to `idea_color` (CSS var: `--idea-color-{yellow|orange|pink|lime|blue}`)

**State-specific styling**:
- Drafting/In Review: full opacity, visible drag handle
- Approved: opacity 0.85, "🔒 Locked" badge (top-right)
- Promoted: opacity 0.7, "✓" badge with link icon
- Dropped: opacity 0.6, "✗" badge, no drag handle (visibility: hidden)

**Hover effect**: Slight lift (transform: scale/translateY), shadow enhancement

**Click**: Opens IdeaTicketModal with this idea

**Styling**: `ui/src/components/IdeaCard.module.css`

---

#### 4.5 IdeaTicketModal

**File**: `ui/src/components/IdeaTicketModal.tsx`

**Purpose**: Modal for viewing/editing ideas with 2-stage promotion flow

**Props**:
```typescript
interface IdeaTicketModalProps {
  idea: Ticket;
  isOpen: boolean;
  onClose: () => void;
  onSave: (idea: Ticket) => void;
}
```

**Sections**:
- Header: title, close (X), status pill
- Metadata: emoji picker, color swatches, title input, description textarea, tags input
- Timestamps: "Created [date]", "Updated [date]"
- Origin link (if promoted): "💡 Origin Idea: [title]" clickable

**Fields shown**: emoji, color, title, description, tags
**Fields NOT shown**: assignee, priority, sprint, estimate, due_date, start_date, AC, work log, test cases

**State machine**:
- **Drafting**: All fields editable
  - Buttons: Save, "Move to Review", Drop, Close
- **In Review**: All fields editable
  - Buttons: "Move to Drafting", "Move to Approved", Drop, Close
- **Approved**: All fields read-only (visual cue: "🔒 Locked", inputs disabled)
  - Buttons: "Promote to Board", Drop, Close
- **Promoted**: All fields read-only
  - Buttons: "View Ticket" (link to main ticket), Close
- **Dropped**: All fields read-only
  - Buttons: Close

**Promotion flow (2-stage)**:
1. User clicks "Promote to Board" button (visible only in Approved)
2. Preview panel appears (inline or overlay):
   - Shows idea title, description, tags (read-only)
   - Shows destination: "Kanban Board — Backlog column"
   - Shows message: "This idea will be linked in the new ticket."
3. Buttons: "Confirm Promotion", "Cancel"
4. On confirm:
   - Call usePromoteIdeaTicket API
   - Toast: "✓ Promoted to [Ticket #N]" with link
   - Modal closes
5. On error: error toast, modal stays open

**Emoji picker integration**: Click emoji field → EmojiPicker popover opens

**Color picker integration**: Click color swatches → ColorAccentPicker renders inline

**Drop flow**:
- Click "Drop" button
- Confirmation dialog: "Drop this idea? It will move to Dropped and stay available for reference."
- On confirm: call useDropIdeaTicket, toast, modal closes
- On cancel: dialog closes

**Styling**: `ui/src/components/IdeaTicketModal.module.css`

---

#### 4.6 EmojiPicker

**File**: `ui/src/components/EmojiPicker.tsx`

**Purpose**: Lightweight inline emoji selector (~50 common emojis, no heavy library)

**Props**:
```typescript
interface EmojiPickerProps {
  selectedEmoji: string | null;
  onSelect: (emoji: string) => void;
}
```

**Emoji list** (~50 common ones):
💡, 🚀, 🎨, 🐛, 📝, ✅, ❌, 🤔, 📊, 🔍, 🎯, 🎭, 🎪, 🎬, 🎸, 🎹, 🎺, 📚, 🏆, 🎁, 🎉, 🎊, 🎈, 🌟, ⭐, 🔥, 💎, 🏅, 🎖️, 👑, 💪, 👍, 👏, 🙌, ✋, 🤝, 💼, 👔, 🕵️, 🧑‍💼, 🧑‍💻, 🚗, 🚁, 🚂, ✈️, 🚢, 🏰, 🏠, 🏖️, 🌳

**Rendering**:
- 7x8 grid of emoji buttons (or similar density)
- Each emoji is a button (click to select)
- Selected emoji has checkmark or highlight border
- Popover; click outside to close

**Styling**: `ui/src/components/EmojiPicker.module.css`

---

#### 4.7 ColorAccentPicker

**File**: `ui/src/components/ColorAccentPicker.tsx`

**Purpose**: 5-swatch color selector for idea card accent

**Props**:
```typescript
interface ColorAccentPickerProps {
  selectedColor: IdeaColor | null;
  onSelect: (color: IdeaColor) => void;
}
```

**Rendering**:
- 5 colored squares in a row (yellow, orange, pink, lime, blue)
- Each square is a button with preview of accent color
- Selected swatch: thin border highlight or checkmark
- CSS uses predefined color vars (--idea-color-yellow, etc.)

**Styling**: `ui/src/components/ColorAccentPicker.module.css`

---

### Modified Components

#### ProjectSidebar.tsx
- Import BoardSwitcher
- Render below project name (or in its own row)
- Pass projectId and onBoardChange handler

#### App.tsx or Router
- Add conditional route/render: if board='main', show Board; if board='idea', show IdeaBoard
- Use board selection state from useBoardSelection hook

---

### React Query Hooks

**File**: `ui/src/api/useIdeaTickets.ts`

```typescript
// Fetch all ideas for a project
export function useIdeaTickets(projectId: string) {
  return useQuery({
    queryKey: ['idea-tickets', projectId],  // ← STRICT KEY ISOLATION
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/ideas`);
      return res.json();
    }
  });
}

// Create new idea
export function useCreateIdeaTicket() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data) => {
      const res = await fetch('/api/ideas', { method: 'POST', body: JSON.stringify(data) });
      return res.json();
    },
    onSuccess: (newIdea) => {
      queryClient.invalidateQueries(['idea-tickets', newIdea.project_id]);
    }
  });
}

// Update idea
export function useUpdateIdeaTicket() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data) => {
      const res = await fetch(`/api/ideas/${data.id}`, { method: 'PATCH', body: JSON.stringify(data) });
      return res.json();
    },
    onSuccess: (updatedIdea) => {
      queryClient.invalidateQueries(['idea-tickets', updatedIdea.project_id]);
    }
  });
}

// Promote idea to main board
export function usePromoteIdeaTicket() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ideaId: string) => {
      const res = await fetch(`/api/ideas/${ideaId}/promote`, { method: 'POST' });
      return res.json();
    },
    onSuccess: (result) => {
      // Invalidate both idea-tickets and main tickets
      queryClient.invalidateQueries(['idea-tickets', result.idea_ticket.project_id]);
      queryClient.invalidateQueries(['tickets', result.main_ticket.project_id]);
    }
  });
}

// Drop idea
export function useDropIdeaTicket() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ideaId: string) => {
      const res = await fetch(`/api/ideas/${ideaId}/drop`, { method: 'POST' });
      return res.json();
    },
    onSuccess: (droppedIdea) => {
      queryClient.invalidateQueries(['idea-tickets', droppedIdea.project_id]);
    }
  });
}
```

**Cache key strategy**:
- Ideas: `['idea-tickets', projectId]` (never mix with main board)
- Main tickets: `['tickets', projectId]`
- When promoting: invalidate BOTH keys to keep boards in sync

---

### Styling

All components use CSS modules with Tailwind utility support.

**Color variables** (`IdeaCard.module.css` or global theme):
```css
:root {
  --idea-color-yellow: #fbbf24;
  --idea-color-orange: #f97316;
  --idea-color-pink: #ec4899;
  --idea-color-lime: #84cc16;
  --idea-color-blue: #3b82f6;
}
```

**IdeaCard border**:
```css
.card {
  border-left: 4px solid var(--idea-color-yellow); /* mapped from idea_color */
  border-radius: 12px;
  background: white;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}

.card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 6px rgba(0,0,0,0.1);
}

.card.approved {
  opacity: 0.85;
}

.card.promoted {
  opacity: 0.7;
}

.card.dropped {
  opacity: 0.6;
}
```

---

## 5. SSE Integration

**File**: `ui/src/hooks/useSSEInvalidation.ts`

Extend existing SSE handler to include idea-board events:

```typescript
export function useSSEInvalidation() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const eventSource = new EventSource('/api/sse');

    eventSource.addEventListener('idea_ticket_created', (event) => {
      const { project_id } = JSON.parse(event.data);
      queryClient.invalidateQueries(['idea-tickets', project_id]);
    });

    eventSource.addEventListener('idea_ticket_updated', (event) => {
      const { project_id } = JSON.parse(event.data);
      queryClient.invalidateQueries(['idea-tickets', project_id]);
    });

    eventSource.addEventListener('idea_ticket_promoted', (event) => {
      const { project_id } = JSON.parse(event.data);
      // Invalidate both boards
      queryClient.invalidateQueries(['idea-tickets', project_id]);
      queryClient.invalidateQueries(['tickets', project_id]);
    });

    eventSource.addEventListener('idea_ticket_dropped', (event) => {
      const { project_id } = JSON.parse(event.data);
      queryClient.invalidateQueries(['idea-tickets', project_id]);
    });

    return () => eventSource.close();
  }, [queryClient]);
}
```

---

## 6. Risk Management

### HIGH-RISK Scenarios

| Risk | Root Cause | Mitigation | Testing |
|---|---|---|---|
| **Cache contamination** | React Query key collision (idea vs main) | Strict cache key isolation: `['idea-tickets', projectId]` vs `['tickets', projectId]` | T7.1–T7.3 |
| **Non-atomic promotion** | Network failure mid-transaction | Use DB transaction; rollback on any error; idempotent retries | T2.8–T2.10 |
| **Approved lock bypass** | Logic error in update_idea_ticket | Validation check before each edit: if idea_status='approved' AND (title OR description OR tags changed), reject | T2.7 |
| **Multi-tab desync** | SSE events not broadcast or lost | Ensure SSE sent for all 4 event types; verify event.data includes project_id | T7.1–T7.3 |

### MEDIUM-RISK Scenarios

| Risk | Mitigation | Testing |
|---|---|---|
| **Orphaned ideas on promotion failure** | Atomic transaction ensures no orphans | T2.8, T2.9 (retry logic) |
| **Missing DB indexes** | Create idx_tickets_board, idx_tickets_board_status, idx_tickets_origin_idea | T1.1–T1.3 |
| **Type confusion** (string vs enum) | Use strict Python Enums in models; validate on input | T2.1–T2.7 |

### LOW-RISK Scenarios

| Risk | Mitigation |
|---|---|
| **localStorage corruption** | Graceful fallback to default board='main' |
| **Empty state UX** | Provide helpful empty state messages ("No ideas yet — create one!") |

---

## 7. Implementation Sequence

**Recommended merge order** (each into `baseline/IAM-100-idea-board`):

1. **Phase 1–2** (1–2h): Data model + migration
2. **Phase 3–4** (2–3h): MCP tools (all 5)
3. **Phase 5–6** (0.5–1h): BoardSwitcher + routing
4. **Phase 7–9** (1–2h): IdeaBoard layout + DnD
5. **Phase 10** (1–1.5h): IdeaCard visual component
6. **Phase 11** (2–3h): IdeaTicketModal + emoji/color pickers
7. **Phase 12** (0.5–1h): SSE invalidation + testing

**Total estimate**: 14–20 hours (depending on complexity of drag-drop and modal)

---

## Last Updated

2026-04-21, synthesized from agent drafts (BA spec, tech analysis, testing plan, wireframes)
