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
| PATCH | /projects/{id} | `{name?, color?, docs_enabled?, docs_edit_policy?: "everyone"\|"members"\|"admins"}` | ProjectRead | 200/403/404/422 |
| DELETE | /projects/{id} | — | — | 204/404/400 |

ProjectRead shape (after camelCase):
```json
{ "id": "uuid", "name": "string", "prefix": "IAM", "color": "#hex", "ticketCounter": 0, "docsEnabled": true, "docsEditPolicy": "members" }
```

Only project admins (the board owner `user`, or a member with role `admin`) may change `docs_enabled` and `docs_edit_policy` (403 otherwise).

### Docs access
The caller is the `X-Actor` header (see Docs comments). Anyone who is part of the project (the board owner, the agent or a member of any role) reads published pages. Who edits pages (create, save draft, publish, rename, move, duplicate, delete, restore, purge, import) follows the project's `docs_edit_policy`: `everyone` (viewers too), `members` (default: members and admins) or `admins`. A refused write answers `403 read_only`; a name that is not part of the project gets `403 docs_no_access` on every Docs read and write; a disabled space answers `403 docs_disabled` (with the caller's `role`) before either.

| Method | Path | Body | Response | Status |
|---|---|---|---|---|
| GET | /projects/{projectId}/docs/access | — | `{access, role, can_edit, policy, me, admins[]}` | 200/403/404 |
| POST | /projects/{projectId}/docs/access-requests | `{note?}` | `{sent, admins[]}` | 201/404 |

An access request writes a CommentEvent `{kind: "access_request", page_id: null, actor, recipients: ["user", ...admins], snippet: note}`; asking again within ten minutes, or asking while already in the project, sends nothing (`sent: false`).

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

### Diagrams (draw.io)
A diagram is a `.drawio` source plus an SVG preview (the editor exports it on save). Markdown references it as `[label](diagram:dg_xxxxxxxx)`. Limit: 2 MB for the source and 2 MB for the preview (`413 diagram_too_large`). The caller is the `X-Actor` header like Docs comments: viewers read and download, members (and the board owner / agent) add, edit and delete. Errors use the Docs shape `{detail: {code, message, request_id, ...}}`.

| Method | Path | Body | Response | Codes |
|---|---|---|---|---|
| GET | /projects/{projectId}/diagrams | query: `deleted?=true` (Recycle Bin) | Diagram[] | 200/404 |
| POST | /projects/{projectId}/diagrams | `{label, source, svg, summary?, item_kind?: ticket\|comment\|doc, item_id?}` | Diagram | 201/403/404/413/422 |
| GET | /diagrams/{id} | query: `version?`, `source?=true` | Diagram (+ `source`) | 200/404 |
| PUT | /diagrams/{id} | `{base_version, source, svg, label?, summary?}` | Diagram | 200/403/404/409 `diagram_conflict` (`latest_version`, `latest_author`, `latest_at`)/413/422 |
| DELETE | /diagrams/{id} | — | `{id, deleted_at}` (unlinks; kept for Recycle Bin) | 200/403/404 |
| POST | /diagrams/{id}/restore | — | Diagram | 200/403/404 |
| GET | /diagrams/{id}/versions | — | `[{version, author, note, created_at, size_bytes}]` | 200/404 |
| GET | /diagrams/{id}/svg | query: `version?` | `image/svg+xml` (sandboxed headers) | 200/404 |
| GET | /diagrams/{id}/download | query: `format=drawio\|svg`, `version?` | file attachment | 200/404 |
| GET · PUT | /diagrams/settings | `{mode: self-hosted\|public, url?}` (PUT: admin only) | `{mode, url, effective_url, ...}` | 200/403/422 |
- Diagram shape: `{id, project_id, label, summary, suggested_summary, item_kind, item_id, version, shown_version, empty, created_by, created_at, updated_by, updated_at, deleted_at, size_bytes, role, can_edit}`.
- Docs page versions (`GET /docs/pages/{id}/versions/{n}`) carry `diagram_versions: {id: version}`; restoring a page version restores those diagram versions (as new diagram versions) and links unlinked ones again.

### AI members and AI work on tickets
AI members are project members with `kind: "ai"` (`GET /projects/{id}/members` returns `kind: human|ai|ai_removed`) plus an AI profile. People's actions send `X-Actor` (the run acts *on behalf of* that person). An AI run's own board calls go through the MCP server with a per-run bearer token (`Authorization: Bearer kbr_…`); every write is checked by one permission layer (role template → stricter-only overrides → safe mode → kill switch, plus the status ceiling and scope) and audited.

| Method | Path | Body | Response | Codes |
|---|---|---|---|---|
| GET | /ai/providers | — | `{providers, actions[], templates, locks, ceilings, prices}` | 200 |
| POST | /ai/detect | `{provider, cli_path?}` | `{found, path, checked[], version, logged_in, account}` (never a token) | 200/422 |
| POST | /ai/test-run | `{provider, model?, working_dir?, cli_path?}` | `{ok, seconds, reply}` or `{ok:false, error}` | 200 |
| POST | /ai/test-key | `{provider, api_key, base_url?}` (not stored) | `{ok, status, models[]}` or `{ok:false, status, error}` | 200 |
| GET | /projects/{id}/ai/check-name | query `name`, `exclude?` | `{ok, conflict: person\|ai\|null, message, suggestion}` | 200 |
| GET · POST | /projects/{id}/ai/members | POST: `{name, provider, working_dir?, model?, api_key?, base_url?, persona?, max_parallel?, daily_budget?, monthly_cap?, max_runs_per_day?, template?, ceiling?, confirm_done?, permissions?, scope?, config?}` | AiMember[] / AiMember | 200·201/404/422/500 (key store) |
| GET · PATCH | /ai/members/{id} | PATCH: same keys (only those sent change) | AiMember | 200/404/422 |
| POST | /ai/members/{id}/pause · /resume | pause: `{cancel_current?, reason?}` | AiMember | 200/404 |
| POST | /ai/members/{id}/test | `{full?}` | `{ok, health, message, …}` | 200/404 |
| GET · POST | /ai/members/{id}/removal-impact · /remove | remove: `{tickets: reassign\|unassign, reassign_to?, runs: finish\|cancel}` | `{open_tickets, active_runs}` · `{removed, scheduled}` | 200/404/422 |
| GET | /ai/members/{id}/usage · /permissions | — | usage tiles, 14 days, recent runs · matrix, history | 200/404 |
| POST | /ai/members/{id}/permissions/test | `{action, ticket_id?, target_status?}` | `{verdict, reason, checks[]}` (changes nothing) | 200/404 |
| GET | /projects/{id}/ai/overview · /board | — | members, settings, summary · `{runs[], settings}` | 200/404 |
| PATCH | /projects/{id}/ai/settings | `{board_ai_id?, safe_mode?, board_daily_cap?, board_monthly_budget?, max_chain_depth?, runs_per_ticket_per_day?, approval_expiry_hours?}` | settings | 200/422 |
| POST | /projects/{id}/ai/pause-all · /resume-all | `{reason, cancel_running}` · `{reviewed: true, safe_mode, member_ids?}` | `{cancelled, held}` · `{resumed}` | 200/422 |
| GET | /projects/{id}/ai/runs · /tickets/{id}/ai/runs · /ai/runs/{id} | query `member_id?`, `active?` | AiRun[] / AiRun | 200/404 |
| POST | /tickets/{id}/ai/assign | `{member_id, start: now\|queue\|none, include_context?, instruction?}` | `{ticket, run}` | 200/409 held/422 |
| POST | /tickets/{id}/ai/run · /ask | `{member_id?, instruction?}` · `{member_id, question, source?: comment\|test_case, ref?}` | AiRun | 200/409/422 |
| POST | /ai/runs/{id}/cancel · /retry · /answer | `{reason?}` · — · `{text}` | AiRun (retry: a new run #n+1) | 200/409/422 |
| POST | /tickets/{id}/ai/request-changes · /take-over | `{text, continue_session}` · `{member_id?}` | AiRun · Ticket | 200/409/422 |
| GET · POST | /ai/runs/{id}/revert-preview · /revert | — | rows with `conflict` · results (conflicts skipped) | 200 |
| GET | /projects/{id}/ai/approvals | query `status?`, `ticket_id?` | AiApproval[] (pending first) | 200 |
| POST | /ai/approvals/{id}/approve · /deny | `{note?, stop_run?}` | AiApproval (+`error` if the approved action failed) | 200/409 |
| GET | /projects/{id}/ai/audit · /audit/verify · /audit/export | query `member_id?, result?, run_id?, q?, limit?, before_seq?` · — · `format=csv\|json` | `{entries[], counts, total}` · `{ok, broken_at, checked}` · file | 200 |
| POST | /ai/audit/revert | `{entry_ids[]}` | results | 200 |
| POST | /tickets/{id}/comments | adds `ai_intent?: ask\|work\|notify` (default ask) for @mentions of AI members | Ticket | 200 |

- Run states: `queued → starting → running → finished`, `running ⇄ needs_input`, ends `failed | cancelled | timed_out`. One active `work` run per ticket (unique index); `ask` runs never hold the ticket. Retry never reopens a run.
- AiRun shape: `{id, ticket_id, member_id, member_name, number, mode: work|ask, trigger, state, started_by, instruction, queued_at, started_at, ended_at, elapsed_s, ended_reason, exit_code, summary, report{summary, criteria[]}, question{text, options[], to, asked_at}|null, answer, session_id, steps[{at, kind, text}], files[{path, added, removed, new}], tokens_in, tokens_out, cost_usd, metered, status_before, status_changes[], model, waiting_reason, queue_position?}`.
- Comments an AI member posts carry `ai: {kind: answer|summary|failed|move_blocked|comment, run_id, run_number, member_id, …}`; activity entries made by an AI carry `ai: true, on_behalf_of, run_id, member_id`.
- MCP: the `ai_run` tool (`ask`, `report`) works only inside a board-started run; other clients get an error. A blocked call answers `BLOCKED (<code>): …`; an action that needs a person answers `NEEDS_APPROVAL: …` and is applied by the board when approved.

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
