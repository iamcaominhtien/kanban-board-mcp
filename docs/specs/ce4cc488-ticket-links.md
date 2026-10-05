# BA Spec: Ticket Links — Extended Relationship Types

**Ticket:** ce4cc488-fa3d-4a8c-bc99-f653be80e37a  
**Date:** 2026-04-16  
**Status:** Ready for Development

## Problem Statement
Currently tickets can only express a "blocks / blocked_by" relationship. Engineers need richer relationship vocabulary: causal links (bug causing improvement), duplication detection, and general "relates to" associations.

## Solution
Add a generic `links` JSON field to the Ticket model that stores typed relationships. Each link has a unique ID, a target ticket ID, and a relation type. Bidirectionality is enforced server-side. The existing `blocks`/`blocked_by` fields remain untouched (backward compatibility).

## Relationship Types

| Type sent by client | Inverse stored on target |
|---|---|
| `relates_to` | `relates_to` (symmetric) |
| `causes` | `caused_by` |
| `caused_by` | `causes` |
| `duplicates` | `duplicated_by` |
| `duplicated_by` | `duplicates` |

## Data Model Changes

### server/models.py — Ticket
Add new field:
```python
links: str = Field(default="[]")  # JSON array of TicketLink objects
```

TicketLink object schema (not a DB table, just stored as JSON):
```json
{
  "id": "<uuid>",
  "target_id": "<ticket_id>",
  "relation_type": "relates_to | causes | caused_by | duplicates | duplicated_by"
}
```

## API Changes

### New endpoints:
- `POST /tickets/{ticket_id}/links` — body: `{ target_id, relation_type }` → creates bidirectional link, returns link object
- `DELETE /tickets/{ticket_id}/links/{link_id}` — removes link from both sides

### Validation:
- Self-linking not allowed
- Duplicate links (same target + same relation_type) ignored silently
- `target_id` must refer to an existing ticket in the same project
- `relation_type` must be one of the 5 valid values

## Frontend Changes

### ui/src/types/ticket.ts
Add to Ticket interface:
```typescript
interface TicketLink {
  id: string;
  targetId: string;
  relationType: 'relates_to' | 'causes' | 'caused_by' | 'duplicates' | 'duplicated_by';
}

// In Ticket interface:
links: TicketLink[];
```

### ui/src/components/RelationsSection.tsx
Extend the existing component to show the new link types alongside blocks/blocked_by:
- Group links by relation_type
- Display human-readable labels: "Relates to", "Causes", "Caused by", "Duplicates", "Duplicated by"
- Dropdown picker: allow selecting relation type + target ticket
- Remove button on each link (calls DELETE /tickets/{id}/links/{link_id})

## Acceptance Criteria
- [ ] New `links` field persisted correctly on Ticket
- [ ] POST endpoint creates bidirectional links
- [ ] DELETE endpoint removes from both sides
- [ ] All 5 relation types supported
- [ ] Self-link and duplicate link validation
- [ ] UI shows all link types grouped with human-readable labels
- [ ] Dropdown allows selecting relation type and target ticket
- [ ] Remove button works for each link
- [ ] Production build passes
