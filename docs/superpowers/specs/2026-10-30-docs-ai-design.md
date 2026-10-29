# Docs AI — implementation design

Issue #209 (design: PR #208, `design/screens/docs-ai.md`, `design/screens/docs-ai-care.md`). This PR is stacked on
the design branch and carries the code. The owner asked for three more things, which this design covers as well:
AI conversations that keep their memory and compact, @AI in Docs comment threads, and MCP access to the AI team.

## Intent

Put AI into the Docs space as a whole (ask, write, read, edit, keep pages true) on top of what exists: AI members,
budgets, approvals, audit and the Board AI assist services. Nothing here is a new kind of AI, and **AI never edits a
published page**: output is a dashed block, a private draft, a proposal or a list to review.

## Goals / non-goals

Goals: everything in issue #209 sections 1–10; no AI conversation that silently starts from zero when it should
continue; one MCP tool to work with the AI team.
Non-goals: mobile layout, AI auto-publishing or auto-resolving threads, a second AI stack, new MCP tools per verb.
Anti-goals: a page hidden from AI read by any AI (including runs/MCP/Board AI chat); page text obeyed as
instructions; an AI answer that cites a ticket or page that does not exist.

## What exists (verified in code) and what is wrong with it

| Finding | Where | Fix in this PR |
|---|---|---|
| `Docs AI` switch is board-wide and **on** by default | `assist/settings.py` `FEATURES["docs"]` | New per-project `docs_ai_settings.enabled` (off by default) gates everything Docs-side. The board-wide switch stays as the master "allowed at all" switch. |
| API-key Board AI chat is stateless: last 14 rows pasted as text, 1500 chars each, older turns dropped, the question appears twice | `assist/chat.py` | Rolling **summary** kept on `ai_chat` (compaction), question de-duplicated, "Earlier conversation was summarised" notice. Claude Code keeps `--resume`. |
| "Ask this page", selection Ask, Ticket AI always open a **new** chat (`fresh:true`) | `AssistContext.tsx`, `DocsAi.tsx` | Docs asks continue the owner's last chat for that page; "New chat" is an explicit button. |
| API-key agents get no "Activity since your last run" block and restart from the full prompt after Answer | `api_prompt.py`, `api_agent.py` | `activity_block` added to the API prompt (own earlier runs included). |
| @AI in a Docs thread only notifies (nothing starts a run) | `docs_comments.py`, `api/docs.py` | `docs_ai_job` + per-thread session; the AI answers in the thread. |
| @mention over MCP does nothing (delivery lives in the REST handler) | `api/tickets.py` | New MCP tool `ai_team` with `ask`/`work` actions, plus an instructions line. |
| No MCP view of AI members, runs, usage | `kanban_mcp/tools/*` | `ai_team` (below). |

## Data (one migration, `a1d0c5a1b2c3_docs_ai`)

- `docs_page.ai_hidden`, `docs_page.ai_guidance` (bool).
- `docs_draft.ai_source` (JSON: `{kind, from, member_id, gaps[], sources[]}`), `docs_version.with_ai` (bool).
- `docs_comment.ai` (JSON: `{member_id, job_id, cost, sources[], can_suggest}`), set only on AI replies.
- `docs_ai_settings` (per project): `enabled`, `member_id`, `read_scope` (`all|except_hidden|picked`), `picked_pages`,
  `style_page_id`, `edits_mode` (`proposal|draft`), `proposal_days` (7), `freshness_on`, `guidance_limit` (8000),
  `digest_on`.
- `docs_ai_job` — one row per Docs AI call (ask, thread reply, check, translate, explain, summary, history summary,
  publish note, tickets, write, freshness, thread summary): who asked, which AI, state, pages read, steps, result,
  tokens, cost, session id. It is the "run" of Docs AI: usage, progress and the Activity view read it.
- `docs_ai_proposal` — a change set an AI member proposes for a page (`changes` JSON with per-change status, `stale`).
- `docs_ai_check` — freshness result per page (reasons name what was compared, "still correct" until, dismissals).
- `docs_ai_health` — one JSON row per project: missing docs, broken links, overlaps, last run.
- `ai_chat.summary`, `ai_chat.summary_upto`, `ai_chat.compactions` (rolling compaction).

## Server layout

`services/docs_ai/`
- `access.py` — **the one place** that decides what an AI may read: `ai_can_read(session, page)`,
  `readable_pages(session, project_id)`, `guidance_pages(...)`. Used by chat context, Ask, jobs, runs
  (`ai/context.py`), the MCP `docs_read` for AI runs and freshness checks.
- `settings.py` — get/update/describe, `require_enabled`, `answering_member`.
- `engine.py` — `call(...)`: budget/pause checks for the answering member, `llm.complete` (with a CLI session when
  the member is local Claude Code), usage record, `verify_refs` (strip unknown ticket keys / `[[links]]`), fencing.
- `jobs.py` — create / run / cancel a job; handlers register in `HANDLERS[kind]`.
- one module per feature (`ask`, `reader`, `check`, `write`, `history`, `proposals`, `freshness`, `tickets`, `threads`).

`api/docs_ai/` — a package; `__init__` assembles one router from `settings.py`, `ask.py`, `page.py`, `write.py`,
`proposals.py`, `threads.py`, `health.py`, `tickets.py`. Registered once in `main.py`. Errors use `DocsAiError`
(`{detail, code}`) mapped like `AssistError`.

## Rules every slice follows

1. Gate with `settings.require_enabled(project)`; when off nothing is shown and endpoints answer 409 `docs_ai_off`.
2. Read pages only through `access.py`. A hidden page is invisible to every AI.
3. Page / comment / ticket text goes into the prompt inside `ctxb.fence(...)` (data, not instructions).
4. Cost is shown before drafts and on every answer; every call is metered (`record_usage`, feature `docs`) and
   written to `docs_ai_job`.
5. Anything that writes is a draft/proposal. Only `POST …/publish` (existing, person only) publishes.
6. AI text is checked with `verify_refs` before it is shown.

## Conversation memory

- Docs thread: the thread *is* the conversation. Prompt = page (fenced) + all thread comments (older ones summarised
  when over budget) + the new question. Local Claude Code members also resume a session keyed by (thread, member).
- Board AI chat / Ask the docs "Open as chat": rolling summary for API providers; CLI session for Claude Code;
  `compacted` surfaced as a step.
- Ticket runs: unchanged for Claude Code (per ticket); API agents get the activity block.

## MCP: one tool, `ai_team`

The server keeps 11 tools grouped by noun (`action`); a twelfth, `ai_team`, covers the AI team with actions:
`members`, `member` (detail + 14-day usage), `usage`, `ask` (ticket or Docs thread/page; intent `ask|work`),
`runs` (list/progress, filters), `run` (steps, files, question, cost), `cancel`, `retry`, `answer`, `approvals`
(read only), `create_member`, `update_member`, `pause`, `resume`. Rejected inside an AI run except the read actions.
Approving requests stays human-only (UI). Tool-list size is kept inside the existing character cap by short
descriptions. Rejected alternatives: one tool per verb (tool-list bloat), extending `manage_project` (it is
forbidden to AI runs and its enum is already large), delivering @mentions from every comment (surprise cost).

## Approaches considered

1. **Reuse `AiRun` for Docs** (ticket_id optional). Rejected: ticket id is assumed by the hold index, scheduler,
   prompt builder, cancel/limit paths; too invasive.
2. **Separate `docs_ai_job` + shared `engine`** (chosen). Reuses the member profile, budget, audit, `llm.complete`;
   no ticket coupling; gives MCP/Activity one place to read.
3. Make everything stateless drafts like today. Rejected: it is the "every tag is new" problem.

## Left to the builders

Prompt wording, exact UI spacing (follow the design boards), copy. Each slice has server tests and, for UI, pure
logic in `*Rules.ts` modules.
