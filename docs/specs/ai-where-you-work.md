# AI where you work: ticket chat, @ in a comment, AI in every editor

Issue #203, step 8. Design: `design/screens/ai-where-you-work.md` (PNGs in `design/images/ai-where-you-work/`, source
`design/source/AiEverywhere.dc.html`). Related: `docs/specs/ai-members.md`, `docs/specs/ai-gaps.md`,
`design/screens/ai-members.md`, `ai-safety-cost.md`, `ai-board-assistant.md`, `ai-schedules.md`.

Nothing here is a new kind of AI. Every request goes through the AI members, permissions, per-member and board caps,
safe mode, kill switch and audit log that already exist.

## 1. What already existed, and what this step adds (gap list)

The audit compared the design board (sections A to F) with the code on `main` before this step.

### Already built (kept, reused)

| Area | What existed |
|---|---|
| Chat | The Board AI dock (`AssistDock`, Ctrl+J, 420 px, board shrinks) with chats private to the person, 30-day retention, scope tabs (this ticket / project / all projects / this page), thinking steps, streaming, Stop, rate limit countdown, partial answers, thumbs with a reason, "see what was sent", private docs left out, injection chips, drafts with Apply / Edit / Discard / Undo, viewer and conflict states (`server/services/ai/assist/chat.py`, `drafts.py`, `ui/src/components/assist/`). |
| Ticket header | An "AI" menu: Improve description, Split with AI, Suggest test cases, "Ask about this ticket" which opened the **global** dock with the ticket scope. |
| @ in a comment | People and AI members in the `@` list with status words and greyed-out members that cannot be used; AI pills with hover cards; "What does the mention mean?" dialog (Ask / Do the work / Just notify); the Send split button and the Ask button; "Context sent" chips; ask runs with Thinking / Streaming placeholders, Stop, error card with Retry, the answer as a comment with the AI badge, run link, cost, thumbs, Regenerate, Edit and re-run, Reply asks again. |
| Safety | Context fenced as `<untrusted>` data, injection detection, guard on every board action, approvals decided by people, chain depth / cooldown / no repeats between AI members, a mention written by an AI is always an Ask, per-member daily budget, monthly cap, board daily cap, safe mode, kill switch, audit log. |
| Editors | Docs only: a toolbar "Ask AI" menu, a selection menu (Summarise / Rewrite / Ask AI...) whose results are dashed blocks **outside** the page, and the "Improve description" modal with per-hunk accept. |

### Gaps this step closes

**B. A chat on the ticket**

- The chat is the global dock, not docked in the ticket page; there is no AI button that opens it beside the ticket.
- No "Reading: Description, 2 comments, 1 linked Doc, branch ..." line; the scope tab only said "This ticket".
- The conversation is per project and found through history; it is not tied to the ticket and picked up again when the
  ticket is reopened.
- No Ask only / Do the work choice in the chat. A chat could never start a run.
- No "Post as comment" (share an answer as a comment with the AI badge), no Copy on every answer.
- No acceptance-criteria draft with "Add both / Edit / Dismiss".
- No cost before sending ("About $0.01 per answer"), no "Private to you" note, no Runs tab for the ticket.
- The chat answered only as the Board AI; the header could not say which AI member answers.
- The dock and its server code only knew `ticket`, `project`, `all` and `doc`; an idea page needs the same chat with
  its own starting points and draft kinds.

**C. Calling an AI from a comment**

- The `@` list did not say what each AI can do ("Local runner - online - can edit code").
- Choosing what a mention means was a modal dialog at send time, not a plain statement under the box with the
  default **Ask only** and an estimated cost.
- The thread showed "Thinking" for ask runs only. It had no queued / reading / needs your OK / review / did not start
  states for the comment, and no Try again for a run that never started.
- The "Helpful" control was an unlabelled thumb.
- A viewer's mention was silently accepted; AI off for the project had no switch.

**D. AI in every editor**

- Only the Docs editor had AI, and its result lived outside the page. No `/ai` command, no Ctrl+J in an editor, no
  selection bar of Improve / Shorten / Fix spelling / Explain / Ask..., no draft over the text with the changes marked.
- Not available in the ticket description, comments, acceptance criteria, test case notes, Debug notes or ideas.
- No "What will be sent" list before sending, no cost before generating.
- No "edited with AI by <person>" in Activity.
- No conflict state ("the text changed while it was drafting"), no "answer cut short -> Continue" for editor drafts.

**E and F. States and rules**

- No per-project switch for AI ("AI turned off for this project": no AI button, no AI in the @ list, no /ai, old
  mentions are plain text).
- No single "Only members can ask" rule for viewers across chat, editor and mentions.
- One-shot calls (chat, drafts) counted toward the member's daily budget but not the board's daily cap.
- An AI name could be passed as the person who approves a request; only the roles of people were checked.

## 2. What was built

One chat panel, one editor layer and one @ flow, all on the AI members, permissions, caps and audit log that already
existed. Nothing here is a new kind of AI, and nothing writes without a person pressing a button.

### 2.1 Chat about one thing: scopes (B)

`server/services/ai/assist/scopes.py` keeps a registry of **scope providers**. A scope says what a chat is about,
what the model reads, which starting points and draft kinds it has, and (optionally) its own switch and cap. The panel,
the saved conversation, the "Reading" chips, the cost line, the states of design E and the access rules are the same for
every scope and live in `scoped.py` and `chat.py`.

| Scope | Provider | Reads | Drafts it can propose | Do the work |
|---|---|---|---|---|
| `ticket` | `TicketScope` | description, comments (newest first), acceptance criteria, test cases, sub-tickets, linked Docs (private ones left out), branch | the board's own kinds (status, priority, assignee, due date, estimate, title, comment, acceptance criteria) | yes |
| `doc` | `DocScope` | the page (unless private) and the tickets it names | the board's own kinds | no |
| `idea` | `IdeaScope` in `idea_scope.py` | the idea page, assumptions with their evidence, the last 15 comments, the last 15 research log entries | **only** `idea_assumption` and `idea_page_text` | no |

- A chat is saved per **person and thing** (`ai_chat.scope`, `ai_chat.scope_id`), is private to the asker, and is picked
  up again when the thing is reopened. "New chat" (`fresh`) starts another. Chats are kept 30 days.
- The panel (`ui/src/components/assist/ScopedChat.tsx`) shows the AI member that answers and its status, a "Reading"
  line built from what the thing really has, starting points, **Ask only / Do the work** (Do the work only where the scope
  allows it), "Private to you", the cost before sending and Enter / Ctrl+J. On a ticket it also has Post as comment, Copy
  and a Runs tab (`TicketChat.tsx`).
- **Post as comment** writes the answer as an ordinary comment under the AI member's name with the AI badge and says who
  asked; mentions inside it are plain words, so posting can never wake an AI or notify people.
- **Do the work** (`mode: "work"`) is refused for every scope but a ticket. On a ticket it assigns the AI member and
  creates a run with the same limits, permissions and approvals as an assignment (stops at Review).
- A draft of acceptance criteria is a card with **Add both / Edit / Dismiss**; an applied draft has **Undo**.
- A scope may set `feature` (the usage label and feature switch of its chats), `core_ops` (False: the board's own draft
  kinds are refused in this scope) and `check_available()` (its own switch and cap, checked after the board's).

### 2.2 @ in a comment (C)

`POST /tickets/{id}/comments` takes `ai_intent`: `ask` (default, answers in a comment, changes nothing), `work` (starts a
run) or `notify` (plain mention). `GET /tickets/{id}/ai/estimate?member_id&mode` says before sending what the mention
will do: whether the member can start, what it would read, what it may do (`can_edit_code`, `stops_at`) and about what it
costs. The comment box shows it under the text; the thread shows queued / reading / needs your OK / review / did not start
(Try again) states under the comment; the answer is a comment with the AI badge, the run link and the cost. A mention
written by an AI is always an Ask. A viewer's mention, a project with AI off, a paused member and a kill switch start
nothing (the text stays a plain comment).

### 2.3 AI in every editor (D)

`server/services/ai/assist/editor.py` + `ui/src/components/ai/editor/useEditorAi.tsx`. The person selects text or types
`/ai` (or presses Ctrl+J); the result is a **draft over the text** (changed words marked), accepted with Tab, discarded
with Esc, retried, or taken back with Ctrl+Z. "What will be sent" lists the pieces before anything is sent. A draft cut
short at the length limit keeps what it wrote and offers Continue. If the text changed while the AI was writing, the
draft is shown but not applied ("The paragraph changed").

The editor layer talks to an editor through an **adapter** (`adapters.ts`): `textareaAdapter` (comment box, Debug notes,
acceptance criteria), `contentEditableAdapter` (the ticket description) and `tiptapAdapter` (Docs pages and idea pages).

| Surface (`EditorSurface`) | Where | /ai menu | Selection bar |
|---|---|---|---|
| `ticket_description` | `MarkdownEditor` in the ticket | Ask AI, Continue, Summarise, Draft acceptance criteria, Translate | Improve, Shorten, Fix spelling, Explain, Ask |
| `acceptance_criteria` | `AcceptanceCriteriaSection` | Improve, Split, Draft more | Improve, Split |
| `comment` | comments `Composer` | Improve, Translate, Summarise | all five |
| `test_case` | `TestCasesSection` notes | Ask AI, Continue, Summarise, Translate | all five |
| `debug_note` | `DebugSpaceSection` | Improve, Summarise, Translate | Improve, Summarise, Translate |
| `doc` | `DocsEditor` on a Docs page | Ask AI, Continue, Summarise, Draw a diagram, Translate | all five |
| `idea` | `DocsEditor` on an idea page | the same as `doc` | all five |

The server table (`SURFACES` in `editor.py`) is the single source: the client shows what `GET .../ai/editor/state`
returns, and a request for an action the surface does not offer is refused (422).

**Docs and idea pages** (`DocsEditor`, prop `inlineAi={{ surface, projectId }}`):

- Ctrl+J in the editor opens the /ai menu (the editor is marked `data-ai-editor`, so the board-wide Ctrl+J leaves the key
  to it);
- typing `/ai` in the slash menu offers **Ask AI…** first (the slash menu ranks items whose name starts with the query
  first); choosing it removes the `/ai` and opens the AI menu at the cursor;
- a selection shows the AI selection bar under it; the old bubble buttons Summarise / Rewrite / Ask AI… are left out
  while the AI layer is available (they would say the same thing twice). The toolbar **Ask AI** menu, the "Ask AI" about a
  selection through the Board AI dock and the Docs AI panel are unchanged;
- Draw a diagram opens draw.io with the diagram the AI drew and puts the saved diagram on its own line;
- accepting records "edited with AI by <person>" (see 2.5).

### 2.4 The idea page (new in this step)

**Ask AI** (`ui/src/components/ideas/IdeaChat.tsx`, button in the idea page header and Ctrl+J) docks the shared chat on
the right, scoped to the idea. It is drawn only when the Idea Space AI is not off for the project
(`useIdeaAiStatus`); with no AI member, a reached cap or a viewer it opens and says why it cannot answer. It shares the
right edge with **Shape with AI** (`IdeaAiPanel`, unchanged): opening one closes the other.

What the model reads (all fenced as `<untrusted>` data, checked for wording that reads like instructions, which is
flagged on the answer and never obeyed): the title, the page (`body`, else the description; first 7,000 characters), each
assumption with its impact, status, test ticket and evidence (note text and link addresses; files and tickets are only
named), the last 15 comments and the last 15 research log entries. Docs and tickets are not read.

Drafts, as a card with a checkbox per item and **Add / Edit / Dismiss / Undo**:

| Draft | Applies as |
|---|---|
| `idea_assumption` (text, impact) | a new assumption marked **AI** until a person edits it; Activity credits the person |
| `idea_page_text` (one paragraph) | appended to the end of the page body; Activity says "Page text edited with AI" |

The AI **never** moves an idea to another stage, merges, archives, promotes, renames or edits existing text. The two kinds
above are the only ones the scope validates; every other `op` the model writes (including `stage`, `merge`, `promote`
and the board's own `status`, `comment`, `title`) is dropped and listed under "Left out" on the draft. Undo removes the
assumption or the paragraph, but leaves it when a person edited it since.

An idea with **no project** works: the chat is booked on the first project of the *caller* that has an AI member ready
(a project where they are a member before one where they are a viewer; the board's own user is an admin everywhere), and
the caller's role in that project decides whether they can ask. A person who belongs to no project gets "forbidden".

### 2.5 Switches, caps and who may do what (E and F)

| Rule | Where it is enforced |
|---|---|
| **AI off for the project** (`ai_enabled`): no chat, no editor draft, no run, no mention starts; old mentions stay plain text | `settings.guard_request` (chat, scope state, editor, drafts), `mentions` |
| **Only members can ask**; a viewer reads (state `viewer`, no composer) | `guard_request(require_member=True)` for scoped chats and editors; `role_of` on apply, accept and Post as comment |
| **People outside the project** cannot open its chats | `scopes.ensure_access` (`forbidden`) |
| **Kill switch / Pause all, paused member, key invalid, model retired** | the AI member's status (`members.describe`) is not "ready", so `guard_request` answers `unavailable` |
| **Per-member daily budget, board daily cap, monthly cap** | one-shot calls (chat, drafts, editor) are metered by `record_usage`; `over_budget` keeps the thread readable and sends nothing |
| **Idea Space's own switch and daily cap** (Settings, Idea Space) | `IdeaScope.check_available` for the chat and `_check_idea` for the idea page editor; usage is booked as `idea_chat` and `idea_editor`, which the Idea Space cap counts together with its other helpers |
| **A question never starts a run** | `mode` defaults to `ask`; `work` is refused outside a ticket |
| **AI text is always a draft** | drafts are applied by `POST .../apply` or `.../accept` as the person; the text of an editor draft is inserted by the editor as one undoable step |
| **Everything an AI posts is marked** | AI badge on comments, `suggested_by` on applied drafts, the AI chip on added assumptions |
| **Edited with AI is recorded** | tickets: an `ai_edit` entry in Activity; idea pages: "Page edited with AI by <person>" in the idea's Activity; Docs pages: the audit log (`editor_help`) |
| **An AI cannot approve itself or widen its rights** | approvals take a person's name only; an AI-written mention is an Ask; chain depth, cooldown and no repeats between AI members |
| **Private Docs are never sent** | `excluded_docs` is applied by the ticket and doc scopes and the editor's "This page" |

### 2.6 AI in the Sketch editor and on an embedded sketch

`server/services/ai/assist/sketch_ai.py`, `server/api/ai_sketch.py`, `ui/src/components/sketch/SketchAiPanel.tsx`. Full
description, the ops format and the MCP actions are in [`sketch-tool.md`](sketch-tool.md) ("AI help in the editor" and "AI
agents over MCP"); this section says how it plugs into the rules above.

* **One more draft kind, `sketch`**, on the same draft engine as the editor drafts: written in the background, polled
  with `GET /ai/assist/drafts/{id}`, metered by `record_usage`, audited, discarded with the existing route. Modes `ask`
  and `ideas` return text (`result.kind` `answer` / `ideas`); `draw` returns validated vector **ops** that the editor puts
  on a **new "AI" layer** as one undoable step after the person presses Accept. The server never writes pixels or a
  sketch: only a person's save stores the drawing.
* **The model sees the picture.** The LLM layer had no image input; `llm.complete(..., images=[png_bytes])` now sends an
  Anthropic `image` block, an OpenAI-compatible `image_url`, or (Claude Code) a file in a private temporary folder read with
  the `Read` tool only. A call without `images` is byte-for-byte the old request, so the other helpers are unchanged.
* **The same gates as everything else** (`sketch_ai.book` and `guard`): the person belongs to the project of the owner
  (`403 forbidden` for a stranger), only members ask (`403 viewer`), the project's AI switch (`ai_off`), a new **Sketch AI**
  feature switch in Settings → AI (`feature_off`), the AI member's readiness and the kill switch (`unavailable`), the
  member's daily budget, the board's daily cap and monthly cap (`over_budget`). A sketch in an idea also follows the Idea
  Space's switch and daily cap, and an idea with no project is booked on a project of the caller.
* **Cost and what is sent are shown first**: "About $0.01 per answer" from the picture size plus a typical answer length
  (`cost.estimate`, kind `sketch_draw` for a drawing), and a "What will be sent" list (question, title, flattened picture,
  canvas size; never the layers, the owner's text, other sketches or attachments). Usage is booked as `sketch_chat` /
  `sketch_draw` (`idea_sketch_chat` / `idea_sketch_draw` for a sketch in an idea, counted by the Idea Space cap).
* **Untrusted data**: the title, the question and the earlier exchanges are fenced as `<untrusted>`, checked for
  instruction-like wording (flagged on the answer) and the system prompt says text inside the picture is data.
* **Only editors see the button**: the sketch editor and the **Ask AI** button of an embedded sketch ask
  `GET /ai/sketch/state`; a viewer, a stranger and a project with AI off get no button. Everything else about sketches
  works with AI off.
* **Audit**: `sketch_help` when an answer is written (mode, whether a picture was sent, number of ops, cost) and
  `sketch_edit` when a person accepts shapes.

## 3. API

Errors from the assistant answer `{"detail": message, "code": …}`; the codes the panels map to states are `ai_off`,
`viewer`, `forbidden`, `not_configured`, `unavailable`, `over_budget` (with `daily`, `resets`), `feature_off`,
`not_shared`, `conflict`, `apply_failed`, `run_refused`, `invalid`, `not_found`.

| Route | Does |
|---|---|
| `GET /ai/scopes/{kind}/{id}` | The panel's state: scope info (reading chips, starting points, draft kinds, `work`), `availability`, the AI members that can answer, the chosen one, the cost of an answer and of a run, the saved chat id. `kind` is `ticket`, `doc` or `idea`. Sends nothing. |
| `POST /ai/scopes/{kind}/{id}/chat` | The person's saved chat about the thing (or a new one with `{"fresh": true}`), with its messages |
| `POST /ai/assist/chats/{id}/messages` | Ask (`text`, `mode` ask/work, `draft`, `member_id`); the answer streams into the message row |
| `GET /ai/assist/messages/{id}`, `POST …/stop`, `…/retry`, `…/feedback`, `…/post-comment` | Poll, stop and keep the partial text, retry or Continue, thumbs with a reason, share a ticket answer as a comment |
| `POST /ai/assist/drafts/{id}/apply`, `…/undo`, `…/discard`, `PATCH …/{id}` | Apply the drafts of a chat (as the person), take them back, dismiss, edit a draft's text first |
| `GET /tickets/{id}/ai/estimate?member_id&mode` | What an @mention will do and cost, before the comment is sent |
| `GET /projects/{p}/ai/editor/state?surface&ticket_id&idea_id` | What the editor may offer (menu, selection bar), `availability`, cost of a draft. For the `idea` surface the Idea Space switch and cap are part of `availability`. |
| `POST /projects/{p}/ai/editor/preview` | "What will be sent": the pieces, their sizes, what is never sent, the cost |
| `POST /projects/{p}/ai/editor/drafts` | Ask for a draft (written in the background, poll `GET /ai/assist/drafts/{id}`); the text is not touched |
| `POST /ai/editor/drafts/{id}/accept`, `…/continue` | Record an accepted draft (and add accepted criteria to the ticket); go on with a draft cut short |
| `GET /ai/sketch/state`, `POST /ai/sketch/preview` | The Sketch editor's AI state (never an error: `availability.code`) and "What will be sent" for a request. Send nothing. |
| `POST /ai/sketch/drafts` (multipart), `POST /ai/sketch/drafts/{id}/accept` | Ask, ideas or draw with the flattened picture (poll the draft); record accepted shapes. See `sketch-tool.md`. |

`{p}` is the project the request is booked on. For an idea of a project it is that project; for an idea with no project
the client gets it from `GET /ai/scopes/idea/{id}` (`scope.project_id`).

New scope providers are added with `scopes.register(provider)`; `ScopedChat` needs no change (`renderDraft` is for a
scope's own draft card, as `IdeaChat` does).

## 4. Tests

`server/tests/test_ai_where_you_work.py` (ticket chat, mentions, caps, safety, criteria drafts, Continue, the scope
extension point), `test_ai_editor.py` (editor actions, preview, accept, conflicts) and `test_ai_idea_scope.py` (the idea
scope: what it reads and fences, the two draft kinds with Add and Undo, nothing that moves an idea, permissions of
members, viewers and strangers, the Idea Space switch and cap, ideas with no project, the idea page editor) and
`test_sketch_ai.py` (the Sketch editor's AI: ops validation, permissions, switches and caps, usage labels, the picture
reaching each provider). The model is a fake in all of them.

## 5. Not built, or simplified

- **Viewers cannot ask.** The board's rule (design E, "Only members can ask") is applied to the idea chat as well; a
  viewer reads. Asking without being allowed to add drafts is not offered.
- **No browser test of the UI.** The screens were checked by type-check and lint; the repository has no component or
  end-to-end tests for them. The server behaviour behind them is tested.
- **`/ai` in the Docs editor is a slash-menu item**, not a command that opens the menu at once: type `/ai`, press Enter.
  In the ticket description, the comment box, Debug notes and criteria the menu opens as soon as `/ai` is typed.
- **The Docs bubble buttons Summarise / Rewrite / Ask AI… are hidden** while the AI layer is available, because the
  selection bar replaces them. Their results (dashed blocks outside the page) are still reachable from the toolbar
  **Ask AI** menu.
- **Idea chat reads the idea only.** It does not read linked Docs, the promoted ticket, the activity trail, files or
  sketches, and not more than 15 comments and 15 log entries. It cannot start a run (an idea has none).
- **No conflict check for idea drafts.** Assumptions and paragraphs are appended, so they cannot overwrite anything;
  Undo refuses to remove a thing a person changed since. A closed (archived or shipped) idea takes no drafts.
- **An idea with no project is booked on one of the caller's projects**, so the "members of the project" line in the prompt
  and the project's daily member budget are that project's. The Idea Space cap for such ideas is the workspace one.
- **Mentions in idea comments do not wake an AI member.** @ calls an AI from ticket comments only.
- **Docs pages have no activity trail**, so "edited with AI by <person>" for a Docs page is in the audit log only.
- **The cost before sending is an estimate** from the size of what is sent, a typical answer length and the sample price
  table (`assist/cost.py`); the answer shows the metered cost. A local runner is not metered.
- **Safe mode** is a rule of runs (what a member may write). Chat answers and editor drafts only produce text that a
  person applies, so safe mode has nothing extra to stop there; the kill switch and pauses do stop them.
- **Sketch AI (2.6) is a one-shot panel, not a saved chat.** The Ask tab's conversation lives in the open editor; it is not
  stored per person and thing like the ticket and idea chats, and it has no Post as comment. Ask only ever answers: Do the
  work does not exist for sketches.
- **Sketch AI reads the picture and the title only**, not the text of the ticket, page or idea the sketch sits in, so it
  cannot answer from that context unless the person says it in the question.
- **Image input is new and thin**: one PNG per request, scaled to 1280 px; a Claude Code member reads it from a temporary
  folder with the `Read` tool (not tried against a real `claude` binary in the tests); a local runner is not metered.
- **Not part of this step:** sharing a chat with the team (a chat is private; only an answer shared as a comment is
  visible to others).
