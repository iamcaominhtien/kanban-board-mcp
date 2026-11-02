# Story, Flow by scope and Live commentary: implementation

The design is `design/screens/ai-story-flow.md` and its source `design/source/AiStoryFlow.dc.html` (sections A to S).
Build the UI from the HTML source: its spacing, colours, wording and states, not only from the PNGs. This file is the
contract between the server and the UI. JSON keys are snake_case on the wire; the UI's axios layer camel-cases them, so
never key a dict by a ticket id or a name (send lists).

## Model (done)

- `Ticket.type` gains `"story"` (server literals and `kanban_mcp/common.py`; the UI `IssueType` must follow).
- `story` table (`models.Story`), one row per Story ticket: `state` draft | planning | in_progress | review | done |
  dropped, `approve` person | pm (who approves the plan), `budget_tokens` (0 none), `pm_id`, `plan` (JSON),
  `paused`, `review_note`, `history` (JSON `[{at, state, by}]`), `meta`, `created_by`, `created_at`, `handed_at`,
  `started_at`, `closed_at`.
- The children of a Story are the tickets whose `parent_id` is the Story. What waits for what in the plan is kept in
  the plan items (`after`) and mirrored to the tickets' `blocked_by`.
- `ai_decision` table (`models.AiDecision`): a decision the PM took in a person's place.
- Migration `d8e0f2a4b6c8`.

The Story ticket's `status` follows its state and is never dragged: draft → backlog, planning → todo, in_progress →
in-progress (also while children are in Testing), review → review, done → done, dropped → wont_do. Blocked is not
stored: it is worked out on read (no child can run and something waits for a person, the budget or a quota).

## Story API (server: `api/stories.py`, `services/stories.py`)

`StoryView`:

```
{ id, project_id, title, goal, state, blocked: {kind, text, ticket_id} | null, plan_waiting: bool,
  approve: "person" | "pm", paused: bool,
  pm: {id, name, color} | null,
  criteria: [{id, text, done, ticket_id | null, state: "met" | "in_progress" | "not_started"}],
  plan: { version, by, at, approved_by, approved_at, note,
          items: [{order, ticket_id, title, status, held_by: {id, name, role} | null, step: str | null,
                   after: [ticket_id], covers: [int], started_at, ended_at}],
          changes: [{at, text}] } | null,
  progress: {done, total, building, waiting},
  tokens: {used, budget}, cost_usd,
  interventions: {count, needed, avoidable, by_rule},
  handed_at, started_at, closed_at, created_at }
```

`blocked.kind` is one of approval | question | budget | quota | stopped | plan. `goal` is the Story ticket's
description; `criteria` are its acceptance criteria, each matched to the child that covers it.

- `GET /projects/{pid}/stories` → `[StoryView]` (the board, the picker, the clusters).
- `GET /stories/{id}` → `StoryView` plus `decisions: [Decision]` (newest first) and `children: [ticket id]`.
- `POST /projects/{pid}/stories` `{title, goal, criteria: [str], approve, budget_tokens, hand: bool}` → `StoryView`.
  `hand: false` makes a Draft. `approve` defaults to the project's `autonomy.approve`.
- `POST /stories/{id}/hand` `{approve?, budget_tokens?}` → planning: the PM writes the plan.
- `POST /tickets/{id}/make-story` → a ticket with or without children becomes a Story (children kept, in order).
- `POST /stories/{id}/plan/approve` · `POST /stories/{id}/plan/reject` (`{note?}`: the plan's tickets go to Won't
  do, the Story back to Draft) · `POST /stories/{id}/plan/revise` `{note}` (the PM writes the next version) ·
  `PATCH /stories/{id}/plan` `{items: [{ticket_id, after: [ticket_id]}]}` (order and waits, edited in place).
- `POST /stories/{id}/pause` · `POST /stories/{id}/resume` · `POST /stories/{id}/reopen` · `POST /stories/{id}/drop`.
- `PATCH /stories/{id}` `{budget_tokens?, approve?}`.
- Errors are `{detail}` with 404, 409 (wrong state) or 422.

## Decisions API (server: `services/ai/decisions.py`, routes in `api/stories.py`)

```
Decision = { id, at, kind, title, why, ticket_id, story_id, story_title,
             member: {id, name} | null, state: "in_effect" | "overridden",
             can_override: bool, why_not: str | null, result: str,
             overridden_by, overridden_at, override_note }
```

`kind`: approve_design | send_back | split | retry | answer | permission | approve_plan.

- `GET /projects/{pid}/ai/decisions?story=&kind=&overridden=&since=&limit=` →
  `{items: [Decision], totals: {decided, in_effect, overridable, overridden, final}, kinds: [{kind, count}]}`.
- `POST /ai/decisions/{id}/override` `{note?}` → `Decision`. 409 with `{detail}` when it can no longer be overridden.

## Flow by scope (server: `services/ai/flow_view.py`, `timeline.py`, `api/ai.py`)

- `GET /projects/{pid}/ai/team/flow?range=&story=&ticket=`: the same shape as today, narrowed to the scope, plus
  - `scope: {level: "project" | "story" | "ticket", story: {id, title, state} | null, ticket: {id, title} | null}`
  - `clusters: [{story_id | null, title, state, done, total, tickets, handoffs, edges: [{from, to, kind, count}]}]`
    (project level: one per Story with AI work in the range, then one with `story_id: null` for the rest)
  - story level: each node gains `tickets: [ticket_id]` and `live_ticket`, and edges from the PM carry
    `kind: "plan"` (the board started the step from the PM's plan).
  - `folded: {count, edges: [...]}`: the small hand-offs folded into "+N smaller hand-offs" when the map is busy.
- `GET /projects/{pid}/ai/team/timeline?...&story=`: rows are the Story's tickets (`rows: [{ticket_id, title,
  status}]`, the PM first), each bar keeps `member_id`; `decisions: [{at, kind, title, ticket_id}]` for the diamonds.
- The ticket scope is `GET /projects/{pid}/ai/team/flow/{ticket_id}` as today, plus `workflow` (the steps of its
  workflow as `GET /tickets/{id}/ai/workflow` gives them) and `story: {id, title} | null`.

## Live commentary (server: `services/ai/live_feed.py`, `api/ai_live_feed.py`)

- `GET /projects/{pid}/ai/live-feed?after=&limit=&story=&ticket=`: the lines in the scope. Each line gains
  `highlight: bool` (a step finished, work sent back, a PM decision, a pull request opened, anything that needs
  you) and `story_id`. The answer gains `needs_you: [...]` (the rows of the Now tab's Needs you list, in the scope).

## While you were away (server: `services/ai/away.py`)

- `GET /projects/{pid}/ai/away?since=ISO` → `{since, until, ran: bool, paused_all, stories: [{id, title, from,
  to}], finished: [{ticket_id, title, story_id}], needed: [{at, ticket_id, text, open: bool}],
  decided: {count, overridable}, spent: {usd, tokens, by_story: [{story_id, title, usd, tokens}]},
  failed: [{run_id, ticket_id, text, retried: bool}], waiting: int}`.

## Autonomy by Story (server: `services/ai/health.py`)

- The Health answer gains `stories: [{id, title, state, tickets_done, tickets_total, touches: {needed, avoidable,
  by_rule}, reasons: [str]}]`.

## Evidence, limits, packs, plugins, Keep awake (done, server and desktop)

- N: `POST /tickets/{id}/ai/evidence/accept` `{reason}` (a testing step with outcome `no_evidence` becomes
  `accepted`; who, when and why are in the step's `result.accepted`). `POST /tickets/{id}/ai/tdd/accept` takes
  `{rule_off, reason}`; the reason lands in the Dev step's note and `result.accepted`.
- O: `POST /tickets/{id}/ai/workflow/resume` takes an optional `{cap}`: a higher token cap for this ticket (counted
  from the start of its workflow); 409 when the cap is not above what it used. "Stop the ticket" is the existing
  `DELETE /tickets/{id}/ai/workflow`.
- Q1: `GET /ai/members/{id}/pack` gains `edited` (the person changed the instructions the pack wrote) and `history:
  [{version, at, by}]` (versions it can go back to, 30 days). `GET /ai/members/{id}/pack/diff` → `{key, name,
  version, latest, to, changes: [{field, label, before, after}], kept: [str]}`. `POST /ai/members/{id}/pack/revert`.
- Q2: `GET /projects/{pid}/ai/own-plugins` → `{on, plugins: [{name, scope, skills, path, loaded, reason, roles}]}`
  (`roles` null: every role). The narrowing is the project setting `own_claude_roles: [{plugin, roles}]`
  (PATCH `/projects/{pid}/ai/ops`); `own_claude` is the switch.
- Q3: a pack's `permission_mode` is part of the pack (`PUT /projects/{pid}/ai/packs/{key}` with the pack body);
  members made from it follow it after an update.
- R2: the desktop preload has `window.electronAPI.getKeepAwake()` and `setKeepAwake(on)` (the View menu's switch);
  the number of runs keeping it awake is `GET /ai/power` (`{active}`).

## Order of work

1. Server: Story, decisions, the manager driving Stories (me).
2. In parallel: server scope for Flow, Timeline, the feed, away and autonomy (agent); UI Flow by scope and the feed
   (agent); UI Story card, board, page, dialog and plan (agent).
3. Then: Decided for you and While you were away; Team on its own, the workflow picker, Keep awake, packs and
   plugins; Evidence, limits and pause, AI-to-AI comments.
