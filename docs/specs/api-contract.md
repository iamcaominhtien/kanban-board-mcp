# API Contract

## Overview
- Backend: FastAPI running at `http://localhost:8000`
- Frontend auto-transforms: responses camelCased via `camelcase-keys`, request bodies snake_cased via `snakecase-keys`
- Dates: ISO 8601 UTC strings (`2026-04-04T12:00:00+00:00`)
- All JSON list fields (`tags`, `comments`, `activityLog`, etc.) default to `[]`

## Schema sync rule
Any change to `server/models.py` → update `ui/src/types/ticket.ts` in the same commit.

## Sub-entity shapes (as received by frontend, after camelCase transform)

### Comment
```json
{ "id": "uuid", "text": "string", "author": "string", "at": "ISO datetime" }
```

### AcceptanceCriterion
```json
{ "id": "uuid", "text": "string", "done": false }
```

### ActivityEntry
```json
{ "field": "status", "from": "backlog", "to": "in-progress", "at": "ISO datetime" }
```
Note: auto-appended by server on changes to title, status, priority, type, estimate, dueDate.

### WorkLogEntry
```json
{ "id": "uuid", "author": "string", "role": "PM|Developer|BA|Tester|Designer|Other", "note": "string", "at": "ISO datetime" }
```

### TestCase
```json
{ "id": "uuid", "title": "string", "status": "pending|pass|fail", "proof": "string|null", "note": "string|null" }
```

## Endpoints

### Projects
| Method | Path | Body | Response | Status |
|---|---|---|---|---|
| GET | /projects | — | ProjectRead[] | 200 |
| POST | /projects | `{name, prefix, color}` | ProjectRead | 201 |
| GET | /projects/{id} | — | ProjectRead | 200/404 |
| PATCH | /projects/{id} | `{name?, color?}` | ProjectRead | 200/404 |
| DELETE | /projects/{id} | — | — | 204/404/400 |

ProjectRead shape (after camelCase):
```json
{ "id": "uuid", "name": "string", "prefix": "IAM", "color": "#hex", "ticketCounter": 0 }
```

### Tickets
| Method | Path | Body | Response | Status |
|---|---|---|---|---|
| GET | /projects/{projectId}/tickets | query: status?, priority?, q? | TicketRead[] | 200 |
| POST | /projects/{projectId}/tickets | TicketCreateBody | TicketRead | 201 |
| GET | /tickets/{id} | — | TicketRead | 200/404 |
| PATCH | /tickets/{id} | TicketUpdate | TicketRead | 200/404 |
| DELETE | /tickets/{id} | — | — | 204/404 |
| PATCH | /tickets/{id}/status | `{status}` | TicketRead | 200/404 |

### Sub-entity endpoints
| Method | Path | Body | Response |
|---|---|---|---|
| POST | /tickets/{id}/comments | `{text, author}` | TicketRead |
| DELETE | /tickets/{id}/comments/{commentId} | — | TicketRead |
| POST | /tickets/{id}/acceptance-criteria | `{text}` | TicketRead |
| PATCH | /tickets/{id}/acceptance-criteria/{criterionId}/toggle | — | TicketRead |
| DELETE | /tickets/{id}/acceptance-criteria/{criterionId} | — | TicketRead |
| POST | /tickets/{id}/work-log | `{author, role, note}` | TicketRead |
| DELETE | /tickets/{id}/work-log/{logId} | — | TicketRead |
| POST | /tickets/{id}/test-cases | `{title, status?, proof?, note?}` | TicketRead |
| PATCH | /tickets/{id}/test-cases/{tcId} | `{status, proof?, note?}` | TicketRead |
| DELETE | /tickets/{id}/test-cases/{tcId} | — | TicketRead |

## TicketRead shape (as received by frontend, after camelCase)
```json
{
  "id": "IAM-1",
  "projectId": "uuid",
  "title": "string",
  "description": "markdown string",
  "type": "bug|feature|task|chore",
  "status": "backlog|todo|in-progress|done",
  "priority": "low|medium|high|critical",
  "estimate": null,
  "dueDate": null,
  "tags": [],
  "parentId": null,
  "comments": [],
  "acceptanceCriteria": [],
  "activityLog": [],
  "workLog": [],
  "testCases": [],
  "createdAt": "ISO datetime",
  "updatedAt": "ISO datetime"
}
```

## Known limitations / follow-up items
- `list_tickets` query params (`status`, `priority`) have no Literal validation (returns empty list for invalid values)
- `update_test_case` with non-existent `tcId` silently no-ops (returns 200)
- `list_projects` has no pagination (unbounded SELECT *)
