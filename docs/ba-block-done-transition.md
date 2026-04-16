---
title: "Block Done Transition Based on ACs / TCs"
type: ba
status: draft
version: 1.0.0
created: 2026-04-16
updated: 2026-04-16
authors: [GitHub Copilot]
---

# BA Spec: Block Done Transition Based on ACs / TCs

**Ticket:** 266e30b2-620c-4b1b-ac9e-7f39217cbca2  
**Date:** 2026-04-16  
**Status:** Ready for Development

## Problem Statement
Currently, a ticket can be moved to "Done" regardless of whether its Acceptance Criteria (ACs) or Test Cases (TCs) have been completed. This risks shipping incomplete or untested work silently.

## Solution
Add two optional toggle fields per ticket:
- `block_done_if_acs_incomplete` — blocks the Done transition if any AC has `done=false`
- `block_done_if_tcs_incomplete` — blocks the Done transition if no TCs exist, or any TC has `status != 'pass'`

Both toggles default to `false` (opt-in).

## Data Model Changes

### server/models.py — Ticket
Add two new boolean fields:
```python
block_done_if_acs_incomplete: bool = False
block_done_if_tcs_incomplete: bool = False
```

## Backend Logic Changes

### server/services/tickets.py — update_ticket()
When `status` is being changed to `"done"`, validate:
1. If `block_done_if_acs_incomplete` is `True`:
   - Parse `acceptance_criteria` JSON
   - If any entry has `done=False` → raise `ValueError("Cannot move to Done: not all Acceptance Criteria are passed.")`
2. If `block_done_if_tcs_incomplete` is `True`:
   - Parse `test_cases` JSON
   - If list is empty OR any entry has `status != "pass"` → raise `ValueError("Cannot move to Done: Test Cases are missing or not all passed.")`

## API Changes
The two new fields must be readable/writable via the existing `PATCH /tickets/{id}` endpoint (no new endpoints needed).

## Frontend Changes

### ui/src/types/ticket.ts
Add to Ticket interface:
```typescript
blockDoneIfAcsIncomplete: boolean;
blockDoneIfTcsIncomplete: boolean;
```

### UI — Ticket Detail View
In the ticket detail view (near ACs and TCs sections), add two toggle switches:
- "Block Done if ACs not all passed"
- "Block Done if TCs missing or not all passed"

### UI — Status Change Error Handling
When a status update to "done" fails with a 422/400 error, display a user-friendly inline message explaining why (e.g., "Cannot move to Done: not all ACs passed").

## Acceptance Criteria
- [ ] New fields exist on Ticket model and are persisted correctly
- [ ] Status change to "done" is blocked when toggle is on and condition is not met
- [ ] Clear error message shown in UI when blocked
- [ ] Toggle switches visible in ticket detail view
- [ ] When toggle is off, no validation is applied (backward compatible)
- [ ] Production build passes (`npm run build`)
