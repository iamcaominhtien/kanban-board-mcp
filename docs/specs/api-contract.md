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

### Docs comments
Comments belong to a Docs page (not a version) and follow it through history and restore; a page in the Recycle Bin hides its comments, and purging it deletes them. The caller is the `X-Actor` header (default `user`, the board owner = admin; `agent` = member; any other name is looked up among the project's members by name, and an unknown name is read-only).

| Method | Path | Body | Response | Status |
|---|---|---|---|---|
| GET | /docs/pages/{pageId}/comments | query: `state?=all\|open\|resolved`, `kind?=inline\|page` | `{threads, counts, role, me, members}` | 200/404/410/422 |
| POST | /docs/pages/{pageId}/comments | `{kind: "inline"\|"page", body, anchor?: {quote, prefix, suffix, section}}` | Thread | 201/403/422 |
| POST | /docs/pages/{pageId}/comments/anchor-preview | `{markdown}` | `{count, orphaned: [{id, quote}]}` | 200 |
| POST | /docs/comments/threads/{threadId}/replies | `{body}` | Thread | 201/403/404/422 |
| POST | /docs/comments/threads/{threadId}/resolve · /reopen | — | Thread | 200/403/422 |
| POST | /docs/comments/threads/{threadId}/reattach | `{quote, prefix, suffix, section}` | Thread | 200/403/422 |
| POST | /docs/comments/threads/{threadId}/read | — | Thread | 200 |
| PATCH | /docs/comments/{commentId} | `{body}` | Thread | 200/403/404 |
| DELETE | /docs/comments/{commentId} | — | `{deleted: "comment"\|"thread", thread_id}` | 200/403/404 |
| GET | /projects/{projectId}/docs/comment-events | query: `recipient?`, `limit?` | CommentEvent[] (Activity, newest first) | 200 |
| PATCH | /projects/{projectId}/members/{memberId} | `{role: "viewer"\|"member"\|"admin"}` | MemberRead | 200/404/422 |

Rules:
- **Permissions**: viewer reads; member comments, replies, resolves and reopens; the author edits and deletes their own comments; an admin deletes any. Errors use `{detail: {code, message}}`: `read_only` (viewer writes), `not_author`.
- Deleting the first comment of a thread deletes the whole thread; deleting a reply removes only that reply. Page comments cannot be resolved.
- **Anchors**: `{quote, prefix, suffix, section}` are plain text of one block (paragraph, list item, table cell, code block); the page Markdown is never changed. On every publish/restore the anchors are re-matched against the new text: an exact hit (best by prefix/suffix/section) or a close fuzzy hit keeps the thread attached and refreshes its quote and position; no hit sets `anchor.state = "orphaned"` (and `number = null`). An orphaned thread whose exact text returns is attached again.
- **Numbers**: `number` is set only on open, attached inline threads, in page order.
- **Mentions**: `@Name` or the picker's `@[Name](member:id)`; only project members are recognised (`comment.mentions`).
- **Notifications / Activity**: each comment, reply, resolve and reopen writes a `CommentEvent` `{kind: comment|reply|resolved|reopened, actor, mentioned[], recipients[], page_title, snippet, created_at}`. `recipients` = people mentioned, plus (replies, resolve, reopen) the thread starter and everyone who replied — never the actor.
- Thread shape: `{id, page_id, kind, status, number, anchor{quote,prefix,suffix,section,state,pos}|null, created_by, created_at, resolved_by, resolved_at, unread, can_reply, can_resolve, comments[{id, author, body, mentions[{id,name}], created_at, edited_at, can_edit, can_delete}]}`.

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
