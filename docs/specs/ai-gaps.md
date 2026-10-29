# AI features: gaps against the full design

Checklist of what the AI designs ask for and the first implementation (3.7.0, issue #165) did not build.
Source docs: `design/screens/ai-members.md` (M), `design/screens/ai-provider-config.md` (P),
`design/components/ai-ticket-work.md` (T), `design/screens/ai-safety-cost.md` (S),
`design/screens/ai-board-assistant.md` (B), `design/screens/ai-schedules.md` (SC).
Size: S < ½ day, M 1–2 days, L 3+ days. Ticked items are done; "limit" marks what is built as far as the
platform allows, with the reason.

## 1. Bugs found while comparing

- [x] Won't Do through `PATCH /tickets/{id}` and the MCP update/delete paths do not cancel the AI run (T H6)
- [x] Reassigning a ticket to a person keeps the AI run and its hold (T D1)
- [x] `resume_all` does not un-pause an agent that was paused before; over-budget exclusion only in the UI (S D3)
- [x] `board_monthly_budget` is never enforced (S C4)
- [x] Over budget mid-run stops the run; the design lets the running one finish (M E8, S C5)
- [x] Read permission is never checked or audited (S A1)
- [x] Pause all with "let them finish" blocks every write of the running runs (S D2)
- [x] `context.sub_tickets` is never sent to the AI (P D5, T H7)
- [x] MCP server `env`/headers keys are mangled by the camel/snake case conversion (P B3)
- [x] A failed or timed-out Ask run posts no comment (T C2)
- [x] Status shows Online for a monthly-capped or board-capped agent (M B, S C5)
- [x] Safe mode cannot be turned off in the UI once Resume set it (S D5)
- [x] Adding a person never checks for a name taken by a person or an AI member (M A2, F1)

## 2. AI members (M)

- [x] Members modal: Board AI "Change" opens the picker; "+N more" opens the AI page; AI tab loading state (S)
- [x] Board AI card copy and "Assistant settings" button (S)
- [x] Status sub-lines: "Last call 2 min ago", "Paused by user · Paused Oct 20", "401 from provider" (S)
- [x] Elapsed time ticks every second (S)
- [x] Row menu Edit opens Configuration; list error state (S)
- [x] Board AI picker refuses paused / retired members (server) (S)
- [x] Stepper: "Signed in as", latest CLI version, Installation guide link, Antigravity install text (S)
- [x] Stepper: avatar colour and glyph pickers, rendered everywhere the AI avatar shows (M)
- [x] Stepper: budget unit (USD only, as all prices and limits are USD), client validation, "Assign a ticket" and Close on the Done step, key prefix in the notice (S)
- [x] Rename after creation in Configuration (S)
- [x] Profile: running ticket title and status, "View on board", effective approvals list, "Full usage & audit log",
      recent-run rows (time words, summary, in/out, cost, failure reason), usage error state (S)
- [x] Connection-state card with one action per state and its explanation (E1–E10) (M)
- [x] Rate-limited runs re-queue and retry after the wait, with "Retry now" (M)
- [x] Model retired detection for Gemini/custom; periodic re-detect of a missing runner or sign-in (S)
- [x] Remove dialog: "Reassign to a person" preselected, error handling, toast (S)
- [x] Assignee dropdown: offline / key invalid labels right-aligned, missing runner greyed (S)
- [x] Runner host line ("this computer · desktop app x.y"), web build notice and stepper gating (M)
- [x] Projects it can work in (one AI member in several projects) (L) — a linked copy per project, settings kept in step, one budget
- [x] OS keychain for keys on desktop, with the 5b failure state (M)
- [x] "Today" resets at local midnight everywhere, month from local month start (S)
- [ ] limit: Antigravity runs (no verified headless mode)

## 3. Provider configuration (P)

- [x] Configuration tab renders only the groups the adapter declares; capability data per A2 (M)
- [x] Toolbar: "declares N of 9", Import JSON, Save button, config version and last sync (M)
- [x] Synced / Documented per item, "I've done this" tick (who, when, cleared on change) (L)
- [x] Other MCP client: endpoint and masked access token only (S)
- [x] Claude Code instructions written into CLAUDE.md between kanban markers; user scope documented; token estimate (L)
- [x] Skills: `.claude/skills/<name>/SKILL.md`, add / attach / toggle, Add skill modal (write, library, import) (L)
- [x] MCP servers: locked kanban-board row, status probe, enabled toggle, env/headers editing, `.mcp.json` (M)
- [x] Subagents (`.claude/agents/*.md`) and Hooks (`.claude/settings.json`, typed confirmation) (L)
- [x] Permissions written to `.claude/settings.json`; duplicate and syntax checks (S)
- [x] Effort and Extra CLI flags fields; model list from provider; validation on create (S)
- [x] Sync preview (files, diffs, Write now), conflict on hand edits with keep / overwrite and backups (L)
- [x] Antigravity: reduced option set, rules setup steps with tick, Documented counts, experimental MCP sync (M)
- [x] API agent system prompt: variables `{{ticket}}` `{{project}}` `{{docs}}` `{{comments}}`, preview, token budget,
      unknown-variable error (M)
- [x] API agent tools: Docs read / Docs write groups, search, Read/Writes chips (M)
- [x] API agent custom HTTP tools with schema editor, validation, test call, secret headers (L)
- [x] API agent remote MCP servers (HTTP) (L)
- [x] API agent context: linked docs, sub-tickets, token estimates (M)
- [x] API agent limits: backoff fields, units, server validation (S)
- [x] Output rules: steps and tokens in the comment, move back on failure, comment format (S)
- [x] Dry run with simulated side effects, trace table and cost estimate (L)
- [x] Shared library (skills, snippets, MCP servers, tools) with versions and update prompt (L)
- [x] States: unsaved count, inline validation, sync failed, runner offline pending, wrong-adapter item,
      reset dialog with undo, loading skeleton, empty states (M)
- [ ] limit: Other MCP client shows the endpoint only; the board has no per-client access token yet
- [ ] limit: dry run always simulates writes; Antigravity MCP sync path is unverified and off by default

## 4. AI work on tickets (T)

- [x] Picker: "you" tag, "Starts in a few seconds", queue "behind KAN-142"; Queue really queues (S)
- [x] Sidebar: "moved by <AI>" under Status, "Held since" chip (S)
- [x] Run button starts a run from ticket detail; card progress hint; "step 9 of ~14"; Starting label;
      "tests passed" on the summary chip (S)
- [x] Drag confirm as a designed dialog (S)
- [x] @mention in descriptions and test-case notes (People and AI), with Ask / Notify on test cases (M) — a mention in a description is saved but notifies nobody, as for people
- [x] Autocomplete groups People / AI with status; unavailable AI greyed (M)
- [x] AI-coloured mention pill with hover card (Now, Last run, ceiling, Ask, Assign here, Profile) (M)
- [x] Composer: "1 AI mentioned", Send ▾, Ask split button, context chips, Ctrl+Shift+Enter (M)
- [x] Ask thread: "Asked <AI>" label, Thinking / Streaming placeholders with Stop, run link, Regenerate,
      Edit and re-run, error reply with Retry, reply asks again, thumbs with reasons (L)
- [x] Per-run Pause / Resume (L)
- [x] Queued: Start now; failed / cancelled / timed out: Take over, Undo, Raise limit (S)
- [x] Run view: step estimate, expandable step output, exit codes, test results, usage card with budget bar,
      history notes and per-row Undo, cancel recorded in status changes (M)
- [x] Question: option descriptions and recommended, Answer later, Ask someone else, toast Answer action,
      reminders at 15 min / 2 h / 6 h, answer comment chip and transition lines (M)
- [x] Review gate: test summary, "What changed", unverified count, Take over picks a person, F2 preview,
      blocked-Done toast, AI-completed badge in header and Activity (S)
- [x] Activity: "AI on behalf of person", AI bubble, filters All / People / AI / agent, Revert with dialog (M)
- [x] Undo dialog with checkboxes, branch and file rows, "edited by a person" box (M) — file and branch rows are informational
- [x] Two AIs on a ticket: holder and next in line, Held by chip (L)
- [x] Context refresh while a person edits a ticket the AI works on (L) — API agents get it at their next step, CLI runs with their next board tool call (`board_notice`)
- [x] Parent ticket plan: draft sub-tickets, accept, badge, undo (L) — shares the Board AI split drafts
- [x] Budget stop state with Continue at 00:00 / Raise budget; offline banner; archive toast and chip (M)
- [ ] limit: Open terminal attaches only by copying the command
- [ ] limit: no reminder dot on the sidebar Board item (the card shows it; from 6 h admins get a notification)

## 5. Safety and cost (S)

- [x] Permissions tab: Preview as this AI, owner-enabled delete with approval, provenance column, run-tools row,
      template card text, tester status and scope, project checkboxes (with multi-project), wider scope confirm (M)
- [x] Allowing Done: owner confirmation (M)
- [x] Permission history with per-action diffs, roles, Open in audit log (S)
- [x] Inbox with Approvals / Mentions / Questions; filters; bulk approve/deny for low and medium risk (M)
- [x] Approval card: run waiting line, before → after diff, AI's reason, trigger source, Approve & remember (M)
- [x] Who can approve by risk, delegates (M)
- [x] Needs approval run state: the tool call waits for the decision (L)
- [x] Approval rules UI: expiry, on expiry skip/tell or stop the run (S)
- [x] Approval toast with Review / Deny; stale-change check when opened later (M)
- [x] Usage dashboard: range, CSV, today vs cap, forecast, stacked chart with cap line, % of monthly cap,
      most expensive runs, spend by ticket, price table (M)
- [x] Edit budget dialog: tokens/day, cap per run, warn at 50/80/100, at-cap policy, board note (M)
- [x] Budget alerts at 80% / 100% (M)
- [x] Limits table for agents and board; board tokens/day, parallel, runs/day (M)
- [x] At the cap: pause new runs (default) / stop now / ask an owner with "Raise cap" approval (M)
- [x] Kill switch: counts in banner, View audit log, safe-mode chip, card chips, revoke MCP tokens,
      Resume "actions in the last 10 min" and budget comparison (S)
- [x] Safe mode switch; safe mode applies to CLI tools; per-agent safe mode (S)
- [x] Auto-trip rules: spend spike, repeated denials, loop, many agents tripped; edit thresholds; banner + toast (L)
- [x] Audit log: action and date filters, Run and Cost columns, pagination, drawer (result chip, redaction count,
      approval line, prompt-source trace, Revert run), bulk revert preview dialog, retention, filtered export (M)
- [x] Injection: detection chip, why popover, hide comment from AI, blocked banner on ticket (M)
- [x] Trust by source table; outbound requests need approval; allowed domains (M)
- [x] Keys and tokens: rotated date and reminder, per-member MCP token with last used and revoke (M)
- [x] Loops: cooldown between AI mentions, chain display on ticket, run-limit box with Allow 3 more,
      settings UI for chain depth / repeats / runs per ticket (M)
- [x] Roles: owner / admin / member / viewer checks on AI endpoints; owner confirmation of permission changes (L)
- [x] Notification settings (in-app / desktop) per event and daily digest (M) — limit: no email
- [x] Why was this blocked card, approval overflow box, project limit of 25, run-ended approvals,
      workspace defaults layer and editor, first-time checklist, Clear filters (M)
- [x] Step 4 of Add AI member: delete wording, Backlog and Testing ceilings (S)
- [ ] limit: a local runner cannot pause mid-call for an outbound approval; web fetch is limited to allowed domains instead

## 6. Board AI assistant (B)

- [x] Dock: header button with ⌘J, sidebar Ask AI with unseen-insight badge, 420 px dock that shrinks the board,
      scope tabs and chips, welcome with suggestions (A1, B1)
- [x] Entry points: Draft with AI strip, ticket AI menu, Suggest cases, Docs toolbar and selection, no-Board-AI prompt (A3–A7)
- [x] Chat: answers with tables and ticket pills, context line, cost chip, suggested actions as drafts,
      draft preview with Apply / Edit / Discard, result line with Undo (B1, B2, B10)
- [x] Chat history per person (search, groups, 30-day retention, monthly total) and New chat (B3)
- [x] Thinking steps, streaming with Stop, error, rate-limited countdown, scope switch with token sizes,
      over budget (B4–B9)
- [x] Draft with AI in New Ticket: similar tickets with match %, per-field accept / reject / edit, regenerate,
      new labels on accept, suggested assignee with reasons, loading, error (C1–C3, C5)
- [x] Improve description: diff and side-by-side, per-hunk accept, undo (C4)
- [x] Split with AI: checkboxes, order, blocked-by, inline titles, estimate mismatch, ask for changes,
      7-day expiry, dependency preview, badge and undo (D)
- [x] Suggest test cases tied to criteria, coverage matrix, suggest from description (E)
- [x] Board health: digest, six insight kinds, act / snooze / dismiss, schedule and noise controls,
      toast and badge, insight chip on cards (F)
- [x] Docs AI: summary draft, section from a ticket, link suggestions, ask this page, selection Summarise /
      Rewrite / Ask (G)
- [x] Settings → AI: feature toggles with monthly cost, language, tone, style guide, data scope per project,
      excluded docs, disclosure, cost limits (H)
- [x] States: offline / key invalid, over budget, slow, partial result, invalid field, conflict, viewer,
      empty board, truncated context, injection, private doc, feature off (I)
- [x] Thumbs up / down on answers are kept on the server with a reason
- [ ] limit: similar tickets use a local word match, not embeddings

## 7. AI schedules (SC, issue #153)

- [x] Schedules tab with next-24 h count; Run ▾ and assign popover "Schedule…" (A)
- [x] List view with filters and status; week view per AI with overlaps and offline risk (B)
- [x] Create / edit layer: once or repeat, time zone, ends, window, AI and backup, done-when checks,
      AI review with fix rounds, limits, catch-up policy, notifications, summary, next runs, checks, dry run (C)
- [x] Schedule detail with stats and run history per check (D)
- [x] Schedule block on the ticket, card footer states, Activity entries, notifications (E)
- [x] Problems: runner offline, over budget, ticket changed, slot busy, same reviewer, time passed,
      auto-pause after 3 failures, no permission, empty tab (F)
- [x] Rules: guarded starts, no double run, never past Review, creator owns, pause on lost permission (G)
