# Idea Space (issue #203)

What shipped for the Idea Space redesign. The design is in [`design/screens/idea-*.md`](../../design/screens/); this page says how it was built, what the API looks like, and where the implementation differs from the boards.

## Model

| Thing | Where | Notes |
|---|---|---|
| Idea | `idea_ticket` (`IdeaTicket`) | Belongs to a project or to none (`project_id` nullable). `stage` is the source of truth: inbox, exploring, ready, building, parked, shipped, archived. |
| Page body | `idea_ticket.body` | Markdown, edited with the Docs editor. Built from the problem statement and description when an old idea was converted. |
| Assumption | `idea_assumption` | Text, impact (low / medium / high), status (untested / testing / validated / disproved), optional test ticket, `ai` mark. |
| Evidence | `idea_evidence` | Link, file, ticket, note, sketch, diagram or comment, attached to one or more assumptions. |
| Votes | `idea_vote` | One per person ("I want this"). |
| Comments | `idea_comment` | The old "microthoughts" were converted into comments. |
| Research log | `idea_log_entry` | Note, research, interview, experiment, finding, decision; pin; "Use as evidence". |
| Activity | `idea_ticket.activity_trail` (JSON) | Every entry has an author, a kind and, for page edits, a short before/after. |
| Ticket links | `ticket.from_idea_id`, `ticket.tests_assumption_id` | The lightbulb, the "From an idea" filter, the "Started as an idea" block and the test-ticket question read these. |
| AI | `idea_ai_settings`, `idea_advice`, `idea_digest` | Per-project switches (all off), advice with a reason and confidence, weekly digests. |

Readiness is computed, never stored (`models.idea_readiness`): only high-impact assumptions decide it; with none, every assumption must be validated; no assumptions is "Not started", never "Ready".

### The conversion of existing ideas

Migration `e8f9a0b1c2d3` converts the old ideas once, after saving a copy of the database next to it (`kanban.before-idea-space-<date>.db`, only when there are ideas). See [the migration table](../../design/screens/idea-promote-migration.md) and its "As shipped" notes. Nothing is deleted: the old columns stay.

## Rules (kept from the design)

- AI only suggests. It never moves, edits, merges, archives or promotes an idea; text it writes is a draft a person adds. MCP gives AI members five tools: read ideas, read assumptions, read the activity, and add to the Inbox.
- A promoted idea is an ordinary ticket with a small lightbulb. An idea that is Building cannot be archived; ticket Done moves it to Shipped; "Won't do" returns it to Exploring (link cleared, promote again later); deleting the ticket returns it to Ready.
- Parking needs a date; a parked idea whose date has come returns to the Inbox once. Archiving needs a reason from a short list. Merge can be undone for 10 minutes. Every stage move can be undone (Z in triage).
- Viewers can add ideas, vote and comment; only members and admins move or edit ideas (`can_edit` on every idea).
- Everything works with AI off.

## REST API

`/api/idea-tickets` (basic CRUD, kept for the old board), and the new routes (see `server/api/idea_space.py`):

| Route | Does |
|---|---|
| `GET /space?scope=project\|all\|none&project_id&stage&active&q&source&tag&sort` | The list, stages and matrix views |
| `GET /counts`, `GET /similar`, `GET /tag-suggestions`, `GET /by-ticket/{ticket}` | Switcher and badge counts, local duplicate search (no model), the ticket side |
| `POST /{id}/stage`, `/undo`, `/merge`, `/undo-merge`, `/vote`, `/outcome`; `POST /park-many` | Keep, Park, Archive, Restore, Merge, undo, votes |
| `PATCH /{id}/page`, `PUT /{id}/project` | Page body, details, title, tags, owner, effort guess, workspace retention; project |
| `…/assumption-records[/{id}]`, `/test-ticket`, `/resolve`; `…/evidence`; `…/comments`; `…/log`; `…/activity` | Assumptions, tests, evidence, comments, research log, activity |
| `GET /{id}/promote/preview`, `POST /{id}/promote` | The promote preview and Create (a person must press it) |

Rule errors answer `409 {detail: {code, message, …}}` (for example `not_ready`, `building_locked`, `park_needs_date`). The workspace folder of an idea uses the ticket workspace routes with the idea's key (`/tickets/IDEA-14/workspace`).

AI helpers (`server/api/idea_ai.py`, `/api/idea-ai`): `status`, `settings`, `advice` (+ `/state`), `shape`, `ask`, `prepare-ticket`, `digest` (+ `/run`).

## AI helpers

They use the project's Board AI member, so its limits, permissions and cost display apply, plus a daily cap of its own (Settings › Idea Space). Each call is metered (`idea_*` usage features) and written to the audit log. The ideas, comments and questions the model reads are fenced as data. Triage advice says nothing when the AI is not sure, and a merge target the local search did not offer is dropped. The effort guess reads file names of the linked repository only, never contents, and is refused for an idea with no project. The weekly digest is computed locally (stale, similar, tests with no owner, parked due, waiting); when grooming is on the AI adds one sentence. Mondays from 9:00, once a week.

## Where it differs from the boards

- **Shape with AI** is its own docked panel on the idea page (drafts with Add buttons, an AI chip until a person edits), not the shared ticket chat dock.
- **Matrix**: the vertical axis is the impact; the horizontal axis is a simple strength from the status plus a little for each piece of evidence (`evidenceStrength`).
- **Promote** carries evidence into the description as an "Attachments from the idea" list (pictures show, links link, sketches and diagrams keep their own markdown line) rather than as separate attachment records.
- **Weekly grooming** is not a ticket schedule: AI Schedules run an AI member on a ticket, so the digest has its own hourly check instead; it still shows in the Idea Space home and the Inbox, and nobody is notified.
- **Open questions** of the design: Quick add is `Alt+N`; "Ready" needs every high-impact assumption validated; the workspace folder follows the retention you pick (default: while open, then 30 days after it is closed); costs shown for AI actions are examples until the first real call, then the metered cost.
