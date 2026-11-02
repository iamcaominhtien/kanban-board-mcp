# Notifications

[#253](https://github.com/iamcaominhtien/kanban-board-mcp/issues/253). Design:
[`design/screens/notifications.md`](../../design/screens/notifications.md) (source
`design/source/Notifications.dc.html`).

One notification centre for the whole app: a bell and a panel, an All notifications page, two kinds of notification,
grouping, rows that close themselves, quieter toasts, a desktop notifier in the Electron main process, following and
muting, Settings › Notifications and a card that sums up the day. It replaces six features that each toasted on
their own (`useAiRunNotifications`, `useScheduleNotifications`, `useDocsNotifications`, `useCommentNotifications`,
`useAccountNotifications`, `useAiSafetyNotifications`) and the 09:00 AI safety digest.

## The five questions of section N, answered

| Question | Decision |
|---|---|
| **The name "Needs you"** | Kept for the panel tab **and** the AI Team section. The same things appear in both, and resolving in either closes both (the row follows the run, the approval, the account). |
| **Who may see a notification** | Each person sees **their own rows**. Owners and admins of a project (and the board's own user) are made recipients of **every AI safety event**, so nothing they saw before is lost. |
| **How long the log is kept** | The **same setting** as the rows (90 days). A cursor older than the oldest kept event gets `cursor_too_old: true` and the current `head` ("start from now"), never silence. |
| **The day card** | Weekdays at **18:00** (time and days are settings). Retention **90 days**. |
| **Settings** | **Settings › Notifications**, a page of its own under App settings. |

## The model

Two tables carry everything (migration `a1b2c3d4e5f7`). `AiNotification` was not widened: it stays as the AI safety
record that the Safety screens read (`/ai/notifications`, `/ai/alerts`); `safety.notify()` writes it **and** an
event in the log, so its eight events keep working.

### `notify_event`: the log

One append-only row per thing that happened. `id` is an `INTEGER PRIMARY KEY AUTOINCREMENT`, so ids only increase
and are never reused, even after retention deletes old rows.

| Column | Meaning |
|---|---|
| `id` | increasing integer: the cursor |
| `project_id` | the project, or null for an app-wide thing (an AI account used in several projects) |
| `kind` | one of the kinds below |
| `op` | `new` (it happened), `resolve` (the thing no longer needs anyone) or `wake` (a snooze ran out: the row is back) |
| `needs` | Needs you, or for information |
| `target_kind`, `target_id` | what it points at: `run`, `approval`, `account`, `ticket`, `page`, `thread`, `schedule_run`, `member`, `day` |
| `ticket_id`, `page_id`, `member_id` | where it came from (the AI member it is about) |
| `actor` | who caused it |
| `title`, `body`, `data` | the facts (JSON in `data`) |
| `recipients` | the recipient keys rows were written for |

### `notification`: one row per recipient

Built from the log, one per recipient per event (or per group of events). A **recipient** is a person or an AI
member: a person's key is the name in lower case (`user` for the board's own user, the `X-Actor` default), an AI
member's is `ai:<member id>`. Read, done and why, snoozed until and cleared are kept per row, so per recipient.

| Column | Meaning |
|---|---|
| `event_id`, `last_event_id` | the first event of the row and the newest one merged in |
| `group_key`, `count`, `items` | grouping (below); `items` keeps the last 50 events of a group |
| `inapp`, `desktop` | the recipient's switches when it was written; `inapp = false` is a **quiet** row |
| `read_at` | read (opening the panel row or the thing it points at) — not done |
| `done_at`, `done_reason`, `done_by` | resolved, why (`{who} answered in AI Team`), by whom |
| `snoozed_until` | hidden until then; never clears the work |
| `cleared_at` | the x on an update: it leaves the panel and stays on the page under Cleared |

### `notify_follow`: follow and mute

Per recipient: `scope` (`ticket`, `page`, `space`, `project`, `kind`), `scope_id`, `level` (`follow`, `everything`,
`mentions`, `mute`), `until` (Mute for 1 hour), `project_id` (a kind muted in one project only). The old
`docs_follow` table was moved into it (scope `space`, scope id = the project) and dropped; the Docs space Follow
button and `/projects/{id}/docs/follow` keep working on top of it.

### `notify_prefs`: Settings › Notifications

One JSON row per recipient: `events` ({kind: {inapp, desktop}}), `desktop_on` (the master Desktop notifications
switch: off writes every row with `desktop = false`, each kind keeps its own choice), `quiet` ({on, start, end}),
`dnd`, `sound` (on by default) and `sound_name` (`chime`, `drop` or `bell`), `remind_after_min` (0 = never, default 15),
`day_card` ({on, time, days}). The row `*` holds the app-wide `retention_days` and `pruned_through` (the newest
event id retention deleted). The per-project `AiProjectSettings.notify` switches were dropped; an explicit desktop
choice of the board's own user is carried over by the migration. `AiProjectSettings.digest` and
`AiNotification.digest` were dropped with the 09:00 digest.

## Kinds

**Needs you** may interrupt (toast, bell, desktop). Its **In app** switch is locked on: the server refuses to switch
it off (422), and muting a ticket or project never makes it quiet.

| Kind | Event | Closes itself when | Dismiss |
|---|---|---|---|
| `question` | An AI asked and its run paused | the run is answered anywhere (ticket, AI Team, the panel, a toast, MCP), or ends; passed to someone else ("Ask someone else"), it closes for whoever is no longer asked ("Passed to Hoa Mai") | no |
| `approval` | An approval request | approved, denied, expired, or its run ended | no |
| `run_failed` | A run failed or timed out; a scheduled slot failed | a new run starts on the ticket (Retry) | yes |
| `blocked` | An AI was blocked by a permission (a guard block, a move past its ceiling, Ask owner for access) | — | yes |
| `account_signed_out` | An AI account was found signed out (one per account, not per member) | the account is confirmed signed in again (a missing CLI does not close it) | no |
| `mention` | Someone mentioned you in a Docs thread | you reply in the thread | yes, your own row only |
| `run_stopped_memory` | A run was stopped for memory | a new run starts on the ticket | yes |
| `budget` | A cap was reached (100 %) | the day rolls over, or the cap is raised | yes |
| `page_proposal` | An AI proposed a change to a page | accepted, rejected or expired (its approval) | no |
| `auto_trip` | An AI member auto-tripped, or Pause all AI | the member or the project is resumed | yes |
| `offline` | An AI member's MCP token was revoked | — | yes |

Dismiss closes the thing for every recipient of the same group (a failed run is shared work), except a `mention`,
which is each person's own: dismissing yours leaves the others' mentions in the thread open.

**For information** never interrupts: bell only, and only a blue dot.

**A toast's one button is the safe way in**, never the decision: an approval offers Review (not Approve), a failed run
Open run log (not Retry), a blocked move Change permission; a question keeps Answer, a signed-out account Sign in
again. Approve, Deny, Retry and Dismiss are never a toast's only button. Feedback with nothing to do ("Saved") is the
quiet line for 2 s; feedback that carries an Undo or an Open stays a toast for its own duration.

A row of another project opens there: Review, Sign in again, Change permission and a page switch to the row's project
first, as a ticket does.

A **skipped** schedule slot is information (`schedule`), never `run_failed`.

| Kind | Event |
|---|---|
| `ai_finished` | An AI finished work (grouped; a scheduled run is told by its schedule instead) |
| `schedule` | A scheduled run finished, partly finished or was skipped |
| `page_published` | A page was published in a space or on a page you follow |
| `comment` | A new comment, resolve or reopen in a thread you follow |
| `run_restarted` | A run was restarted for memory (several restarts of one run are one row) |
| `run_cancelled` | A run was cancelled because its ticket was archived |
| `budget_warning` | A budget passed 50 % or 80 %, or a key is due for rotation |
| `access_request` | Someone asked for access to Docs |
| `day_card` | The day in one card |

A row whose target is gone (the ticket was deleted, the run removed) is marked `gone` with a reason
("KAN-215 was deleted, so this cannot be answered.") and offers only Dismiss; it is never closed quietly.

## Who gets one

| Event | Recipients |
|---|---|
| AI safety events (`safety.notify`) | the project's owners and admins, the board's own user, and the `people` the event names |
| A question | the person (or AI) it was asked of, and the person the run acts for (owners and admins when neither is a person); passed to someone else, the new person gets a row and the rows of those no longer asked close |
| A run that finished, failed, was archived; a blocked move | the person the run acts for, the ticket's human assignee, the ticket's followers; owners and admins too when an AI started it (so a person always hears) |
| An AI waiting on a run (`report_back`) | that AI member (`ai:<id>`) when the run finishes |
| A schedule event | the schedule's creator and its extra people |
| A page published | the followers of its space and of the page, except the author |
| A Docs comment event | the event's recipients; a mention of you is `mention`, the rest `comment` |
| An account signed out | the board's own user and the owners and admins of the projects that use it |
| The day card | every person with settings or rows |

The person who caused an information event is not told about it.

## Grouping

- Information events of one kind and one project inside **10 minutes** (from the group's first event) are one row.
  The row keeps counting while the window is open, comes back to the top and is unread again: "8 AI finished work",
  with "Rin, Dev Gem, Dev An, QA Quy and 1 more · AGT-13 to AGT-20". Above 20 the title says **20+**.
- Needs you rows group only when they are the same request: a question asked again, and the failures of one ticket
  (Retry answers them all). A **reminder** is one more event on a row but not one more item: the row comes back to the
  top, unread, and notifies again, still one request. Every Needs you row that stays open and unread for the person's
  `remind_after_min` after its newest event is reminded once (`remind_unanswered`, in the loop every 30 s; not in
  quiet hours; the row remembers `reminded_at` until a new event arrives). A question then repeats every 2 h as before.
- A group is read as a whole.

## Delivery

- After every append, resolve and row change the server publishes on `/events`:
  `{"type": "invalidate", "topics": ["notifications"], "head": N}`. The window refetches only the `notifications`
  queries and asks the feed for what it has not seen, so a dropped message costs nothing. A poll every 30 s is the
  fallback.
- **Resolving from elsewhere.** A loop in the server process (`services/notifications.py`, started with the app)
  checks the open Needs you rows whenever anything is published (and every 15 s): an answered run, a decided
  approval, a signed-in account, a reply, a new run on a failed ticket, a deleted ticket. Changes made by another
  process (the stdio MCP server) reach it through the database watcher, which publishes too. A row closes for every
  recipient within about a second, and every open window greys it. Rows already marked gone are not checked again,
  and rows that only their target going away can change (`blocked`, `offline`, a mention of an AI member) are checked
  together in one query per table.
- **A snooze that runs out** writes a `wake` event: the row points at it, is unread again and comes back in the
  panel, the count, a toast and the desktop notifier.
- **The desktop notifier** (`desktop/notifier.js`) follows the same feed from the Electron main process. When the
  backend exits it stops at once (no request goes to the old port, which another process could take, with the
  window secret) and clears the badge; it follows the new port once the backend is ready again.
- **After the upgrade**, the first start writes the rows of what was already waiting (pending approvals, runs waiting
  for an answer, accounts signed out), since the old toast hooks are gone and nothing else would.
- Synchronous code (the schedules' feed) and Docs comment events (added before their transaction commits) are queued
  and written by the loop within a second.

## API

All under `/notifications`, as the person of the request (`X-Actor`, or the board's own user).

| Route | What |
|---|---|
| `GET /notifications?view=panel&tab=needs\|updates` | The bell panel: 30 days, no quiet, cleared or snoozed rows. Needs you: open rows oldest first, then today's done rows. Updates: newest activity first, with `day_card` (the latest card) beside the rows. |
| `GET /notifications?view=page&filter=all\|unread\|needs\|snoozed\|done\|cleared&q=&project_id=&kind=&family=ai\|people\|schedules\|info&days=` | All notifications, every project, everything still kept. |
| `GET /notifications/counts` | `needs` (the red number), `updates_unread` (the blue dot), `snoozed`, `unread`, `head`, `oldest_needs_at`. |
| `GET /notifications/feed?since=N` | Rows new or merged since log id N and rows closed since (`resolved`), plus `quiet` (in quiet hours now), `dnd`, `sound`, `sound_name`. Without `since`: only `head`. `cursor_too_old` when N was pruned. |
| `GET /notifications/log?since=N&project_id=` | The raw log, oldest first (for the planned `wait` tool and `kanban wait`). The board's own user reads every event; anyone else reads the events told to them (an AI member as `X-Actor: ai:<id>`, or by its name with `project_id`) and every event of the projects they own or administer. |
| `POST /notifications/read` | `{ids}` or `{all: true, tab}`; with `all` and any of the page's filters (`filter`, `q`, `project_id`, `kind`, `family`, `days`, as in `view=page`) only the rows that page lists are read (422 for an unknown `filter`). Reading is not resolving. |
| `POST /notifications/opened` | `{target_kind, target_id}`: the person opened a ticket, page or run; its rows are read. |
| `POST /notifications/{id}/dismiss` | Resolves the thing for every recipient ("Dismissed by you"); a mention only for the caller. 409 for a kind that closes only when the work is done. |
| `POST /notifications/{id}/snooze` | `{until}` (ISO), or `{until: null}` to bring it back. |
| `POST /notifications/{id}/clear` | `{on}`; 409 for an open Needs you row. `POST /notifications/clear-read` clears every read update. |
| `GET/PATCH /notifications/settings` | The event table (`inapp_locked` for Needs you), `desktop_on`, `quiet`, `dnd`, `sound`, `sound_name`, `remind_after_min`, `day_card`, `retention_days` (`retention_editable`: whether the caller may change it; 403 otherwise), `muted`. |
| `GET/PUT /notifications/follow`, `DELETE /notifications/follow/{id}` | The bell on a ticket, page, space; mutes from a row; the Muted list. |
| `GET /notifications/day-card` (`?preview=true`), `POST /notifications/day-card` | The latest card; today so far; write it now. |

A row as the API returns it:

```json
{
  "id": "nt_…", "kind": "question", "kind_label": "A question from an AI", "needs": true,
  "project_id": "…", "title": "BA Bao asks a question", "body": "“Should the export include archived tickets?”",
  "target_kind": "run", "target_id": "run_…", "ticket_id": "KAN-215", "page_id": null,
  "member_id": "…", "member_name": "BA Bao", "actor": "BA Bao",
  "count": 1, "items": [{ "event_id": 41, "title": "…", "ticket_id": "KAN-215", "actor": "BA Bao", "at": "…" }],
  "data": { "to": "user", "options": [] }, "inapp": true, "desktop": true,
  "read": false, "done": false, "done_text": null, "gone": false, "snoozed": false, "cleared": false,
  "created_at": "…", "updated_at": "…", "event_id": 41, "last_event_id": 41,
  "actions": [{ "id": "answer", "label": "Answer" }, { "id": "open_ticket", "label": "Open ticket" }],
  "dismissable": false
}
```

Actions by kind: `answer`, `open_ticket` (question); `approve`, `deny`, `review` (approval); `review` (page
proposal); `retry`, `open_run_log` (failed, stopped for memory); `sign_in` (account); `reply`, `open` (mention);
`open_ticket`, `change_permission` (blocked); `open_ai` (budget, auto-trip, offline); `expand` ("Show all 8") on a
group; `open` otherwise; only `dismiss` when the target is gone.

## Retention

One setting, `retention_days` (90 by default), is the only thing that deletes. It is app-wide and deletes everyone's
history, so only the board's own user or an owner or admin of a project changes it (anyone else gets 403). It deletes
rows (by last activity) and log events older than it, checked once a minute. The newest deleted event id is kept as `pruned_through`; a cursor below it gets
`cursor_too_old`. The panel's 30 days is a view; clearing is a state. The audit log keeps its own retention.

## The day card

At the card time (weekdays 18:00 by default) the loop writes one `day_card` event and row per person, counted from
the log and the runs since the previous card (nothing is asked of an AI): runs finished, failed (with the reason and
whether they were retried), what still waits for you (the oldest first), spend, a line per project, Docs published
and proposals unanswered, what is still snoozed, and tomorrow's scheduled runs. A quiet day says so in one line. If
the app was closed at the card time, the card is written the next time the loop runs that day. "Sum up today" writes
a card of its own for this moment: the scheduled card of the day is still written once, and counts from the previous
scheduled card (or midnight), not from a card asked for now. It is never Needs you,
and the panel shows it as its first row until the next one. Board health keeps its own 09:00 digest.

The 09:00 AI safety digest is gone: `safety.release_digest`, `AiNotification.digest` and `AiProjectSettings.digest`
were removed, and quiet safety events are ordinary Updates rows when they happen.
