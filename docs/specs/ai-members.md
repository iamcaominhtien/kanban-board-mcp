# AI members and AI work on tickets — technical notes

Issue #165. Design: `design/screens/ai-members.md`, `design/screens/ai-provider-config.md`,
`design/components/ai-ticket-work.md`, `design/screens/ai-safety-cost.md`.

## Model

- An AI member is a `Member` with `kind = "ai"` (so assignment, @mentions, filters and avatars keep working) plus an
  `ai_member` row (same id): provider, connection (`local` · `api_key` · `inbox`), working folder or base URL, model,
  encrypted key + last 4, persona, limits, role template, stricter-only overrides, status ceiling, scope, config.
  Removing keeps the member as `ai_removed` so closed tickets, comments and activity keep their history.
- `ai_run`: one run of a member on a ticket (`work` or `ask`), numbered per ticket, with state, steps, files, usage,
  question / answer, status changes, the CLI session id and the hash of its MCP token. A partial unique index allows
  one active `work` run per ticket (the hold), even under concurrent requests.
- `ai_approval`, `ai_audit` (append-only, each entry carries the hash of the previous one), `ai_project_settings`
  (Board AI, kill switch, safe mode, board limits).

## Runner (local CLI)

`services/ai/runs.py` + `services/ai/cli.py`. A scheduler loop starts queued runs when the member has a free slot, is
not paused, has budget / runs left and the project is not paused. A run launches:

```
claude -p <ticket + instruction> --output-format stream-json --verbose --permission-mode dontAsk
  --max-turns N --mcp-config {"mcpServers":{"kanban":{"type":"http","url":".../mcp/","headers":{"Authorization":"Bearer kbr_…"}}}}
  --strict-mcp-config --append-system-prompt <board rules + persona + instructions>
  --session-id <uuid> | --resume <uuid>   --model <alias>   --allowedTools … --disallowedTools …
```

in the member's working folder, in its own process group. stdout is parsed into steps (tool calls, files touched,
commands, errors) with secrets redacted; the `result` event gives usage. Idle and wall-clock timeouts end the run as
`timed_out`. Cancel, timeout and board shutdown kill the whole process group (SIGTERM, then SIGKILL after 2 s; Windows:
`taskkill /T /F`). On start-up, runs left `running` by a crash are ended as failed and a leftover process is killed
only if `/proc/<pid>/cmdline` still shows our CLI. Flags that skip permission checks are never passed.

"Needs input": the agent calls the `ai_run` MCP tool (`ask`) and stops; when the process ends the run becomes
`needs_input` and the ticket Pending. The answer is posted as a comment and the same session continues with
`--resume`. With no answer for 24 h the hold is released.

## API-key agent loop

`services/ai/api_agent.py`: Anthropic Messages or OpenAI-compatible chat completions with tool calling. Board tools
(read ticket, list tickets, comment, update, create, test cases, ask_person, report) run through the same guard as MCP
calls. Limits: steps, tokens per run, wall clock, daily budget (checked before every model call), retries with
exponential backoff on 429 / 5xx. 401/403 marks the member "Key invalid", 404 on the model "Model retired".

## Permission guard

`services/ai/guard.py` sits in the MCP tool routing (`dispatch` and `ticket_items`), so every board action of an AI
run — CLI or API loop — goes through `check()`: effective mode = most restrictive of template, override, safe mode and
kill switch; the status ceiling and scope are hard rules (also for approved actions); `manage_project` is never
allowed. Blocked → `BLOCKED (<code>): reason` (audited, and a one-time "Move blocked" comment for the ceiling).
Needs approval → an `ai_approval` row and `NEEDS_APPROVAL: …`; a person's approval makes the board apply the stored
call as the AI, on behalf of the person.

## Threat note: prompt injection and path escape

| Threat | Mitigation | Covered by |
|---|---|---|
| Ticket text, comments or another AI's comment tell the agent to delete tickets, raise permissions, approve itself | Trust by source: member text is passed as such, AI-written and external-agent text is fenced in `<untrusted>` with a rule that it is data. Enforcement does not rely on the model: every action is checked by the guard after the model (delete blocked by default, approvals only by people, project/member management never allowed). | `test_guard_allows_blocks_and_parks_for_approval`, `test_ask_runs_cannot_write_and_ended_tokens_are_dead` |
| Agent acts on tickets it was not given | Scope `assigned` (default): writes only on the run's ticket, its sub-tickets, tickets assigned to the AI or created by the run. | `test_scope_blocks_other_tickets_and_comments_are_attributed` |
| Agent poses as a person in comments | Comment author is forced to the AI member's name and tagged with its run. | same test |
| A stolen / leftover run token is replayed | Tokens are random per run, stored hashed, and accepted only while the run is starting or running; every end (finish, cancel, kill switch) clears them. | `test_ask_runs_cannot_write_and_ended_tokens_are_dead` |
| AI members wake each other in a loop | Chain depth limit, no repeats in a chain, kill switch blocks delivery, runs per ticket per day. | `test_mention_meanings_and_ai_chain_limit` |
| Path escape from ticket text (e.g. "edit ../../etc/passwd") | The runner starts the CLI in the configured working folder; file tools are governed by the CLI's own `--allowedTools` / `--disallowedTools` rules and `dontAsk` (anything not allowed is refused). **Honest limit:** the board cannot sandbox the CLI's own tools; the UI says so (Permissions › Runner-side permissions). Working folders must exist and are chosen by a person. | documented here and in the UI |
| Secrets leak into logs, steps, audit or exports | `secrets.redact` masks `sk-…`, `ghp_…`, Bearer tokens and `*_KEY/TOKEN/SECRET=` values before steps, comments and audit entries are stored; keys are encrypted (Fernet, per-install key file, 0600) and only the last 4 characters are returned. | `test_redaction_masks_keys_tokens_and_env_values`, `test_api_key_member_key_is_encrypted_and_never_returned`, `test_assign_runs_to_review_with_summary_and_attribution` |
| Runaway cost | Daily budget / monthly cap / board cap before each model call and before a run starts, token and step limits, auto-pause after repeated failures, Pause all AI. | `test_budget_stops_new_runs`, `test_api_agent_stops_on_invalid_key_rate_limits_and_step_limit` |

## Test plan

- Unit / API: `server/tests/test_ai.py` (permissions, members API, run lifecycle against a fake CLI including
  cancel without leaked processes, idle timeout, needs input + resume, slots / pause / daily limit, one holder under
  concurrent requests, guard, approvals, mentions, kill switch, removal, API agent loop with a fake provider,
  budgets, audit chain and revert).
- End to end with the real Claude Code CLI (haiku and sonnet): add a member through the stepper (detection, test run),
  assign a bug ticket (the agent edits code, runs pytest, reports, the ticket moves to Review), needs input and
  answer, ask by @mention, status ceiling and approval, Pause all AI and resume.
- Not supported yet: Antigravity runs (no headless mode the board can drive; it is detected and works as inbox),
  "Open in terminal" only shows the `claude --resume` command, synced CLAUDE.md / skills files and the shared library
  (instructions and MCP servers are passed on the command line instead).
