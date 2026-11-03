# AI memory (#274): why it felt absent, and the screens 1:1 with the design

Design source: `design/source/AiOperations.dc.html`, blocks **H. What the project knows, and what the AIs learned** and
**G. One run: what it was given** (row "Project memory"). Screenshots: `screenshots/`. Demo video:
`docs/demo/ai-memory-274/ai-memory-274-demo.mp4`.

## 1. Why the memory felt absent

Read from the code on `main` (3.32.0). I could not open the owner's own database from here, so the numbers on their
projects are not checked; every cause below is in the code and holds for any project.

| # | Cause | Where | Effect |
|---|---|---|---|
| 1 | **No AI could write memory.** The only writers were a light model reading *one* run when a ticket reaches Done, a diagnosis, and a person. A run had no tool to keep anything, and nothing told it to. | `knowledge.py`, `kanban_mcp/tools/knowledge.py` (read only) | What a run learned (a command, a trap, a person's correction) was gone when it ended. |
| 2 | **Few proposals are ever made.** Once per ticket, only at Done, only from the last work run, only for a Claude Code member on a subscription (`connection != api_key`) with the `claude` CLI found, and the prompt says "if nothing like that happened, propose nothing". A ticket that never reaches Done (Won't do, still open, a Q&A run) is never read. | `knowledge.propose_from_ticket` | On most projects the Memory list stays empty. |
| 3 | **Proposals are hard to see.** They wait only in Settings › AI › Knowledge and code › Project knowledge, on the second tab (the page opens on Instructions); the "waiting for you" text was faint and the tab count mixed kept and proposed lessons. A diagnosis's proposal sent no notification at all. | `KnowledgeSection.tsx`, `knowledge.propose_from_diagnosis` | Nobody keeps them, so nothing reaches a prompt. |
| 4 | **API-key members never got the instructions or lessons.** Their prompt is built by `api_prompt.compose`, which never called `knowledge.prompt_block`. | `api_prompt.py` | For an API-key member there was no project memory at all. |
| 5 | **Nobody could see a lesson being used.** Only a `uses` counter on the lesson; a run did not say what it was given. | `runs.py`, `RunDetail.tsx` | Even when it worked, it looked like it did not. |
| 6 | The kept lessons that fit the cap were picked oldest first among equally used ones (the comment said newest). | `knowledge._fits` | A fresh lesson was the one left out when the cap was reached. |

## 2. What changed

- **Memory a run writes itself** (`services/ai/memory.py`, table `ai_memory_note`): `knowledge(action='remember')` keeps a
  note in the run's **role** memory (every member of the role reads it; a member without a role keeps its own), on its
  **ticket** (every later run on the ticket reads it), or proposes a **project** lesson (a person keeps it). Notes are
  live at once, shown to people, editable, deduplicated, capped (30 per role or member, 15 per ticket; a full memory
  refuses a write and names the least used notes to replace), and a person's feedback is marked and read first.
  *Decided*: per role, not per project (a project-wide fact is a lesson a person keeps) and not per member (two Devs
  learn the same repository); per member only for a member without a role; and per ticket.
- **Without being asked**: a shared skill `keeping-memory` for every role (what is worth keeping, where it goes, how to
  write it, what never to keep, how to read a person's feedback for the rule behind it), in the board's plugin and in
  `docs_read(guides)`; one line of it rides in every run's prompt and in the MCP instructions (`CORE_RULES`).
- **Visible**: AI Team › **Memory** (new tab) and Settings › Project knowledge open on Memory while something waits,
  with "N waiting for you"; role and ticket notes listed by owner with "2 of 30"; each run records what its prompt
  carried (`ai_run.memory_used`) and "What it was given" says **"Used 2 lessons and 2 notes, 90 tokens · show which"**;
  saving a note is a step of the run.
- **Over MCP** for an outside agent: `knowledge(action='memory')` reads instructions, lessons and notes;
  `remember` proposes a lesson or leaves a ticket note; `forget` removes a note.
- **Hygiene**: a lesson or note naming a file none of the project's checkouts has is flagged "Out of date?"; a newer one
  that says something close is flagged, as a possible contradiction when one of them negates. A person decides.
- Fixes: API-key members get the memory; a diagnosis's proposal notifies; newest-first among equally used lessons.

## 3. Design H, 1:1

| Design (H) | Code before | Gap | Fix / decision |
|---|---|---|---|
| Header "2,490 tokens in every prompt · 31% of 8k" | `TokenMeter` | none | kept |
| Tabs Instructions · Memory **6** · Knowledge base | Memory count = kept + proposed | count mixed proposals with kept | count = kept lessons + notes; "N waiting for you" pill beside it (issue task 2, beyond the design); opens on Memory while anything waits |
| Instructions panel, Edit, History | same | none | kept |
| "Memory — what the AIs learned · 310 tokens · Add a lesson" | same | none | kept |
| Lesson row "Written after KAN-218 · 31 Oct · used in 4 runs since · Delete" | same (+ Edit, "never used") | none | kept; plus hygiene flags under the lesson |
| Proposal card: quote, "From the run that finished KAN-211 at 09:41. Proposed by a light model reading the run, not by the Dev itself.", Keep it · Edit and keep · No | same | the AI itself never proposed | an AI's own proposal says "Proposed by Dev An while it worked"; a "N lessons waiting for you" line above the cards |
| "Lessons are capped at 2,000 tokens…" | same | none | kept |
| "Where a lesson comes from": end of ticket, diagnosis, a person | end of ticket, diagnosis (silent), a person | the AI and outside agents could not | plus the AI in a run and an outside agent over MCP; the diagnosis notifies |
| "Nothing is added to the prompt without you keeping it" | true for lessons | — | still true for **lessons**. **Notes** (not in the design) are live at once by the owner's request ("tự chủ động update memory mà tôi ko cần phải yêu cầu tường minh"), shown and editable, and can be switched off: Settings › "Let the AIs keep their own notes" |
| Layer table (instructions / memory / KB / persona) | explanatory, not a screen | — | not built (it is the design's explanation) |
| — | — | — | **Notes the AIs keep themselves** (new): grouped by role / member / ticket, "a person said" mark, Edit, Delete, "2 of 30", flags |

## 4. Design G, the run's "Project memory" row

| Design (G) | Code before | Gap | Fix |
|---|---|---|---|
| "Project memory · 6 lessons, 310 tokens · among them “run the dev server in the background” Section H" | no row | missing | "Used 2 lessons and 2 notes, 90 tokens · show which" lists each lesson and note; "not recorded" for runs before 3.34.0 |

## 5. Checked

- Tests: `server/tests/test_ai_memory.py` (10), `ui/src/components/ai/knowledge/memory274.test.tsx` (4), and the
  related suites (knowledge, MCP tool quality, shared skills, run context, workflow, notifications…).
- **Internal run** (the demo): a Claude Code member whose CLI is scripted (no model) but whose MCP calls are real: run 1
  on SHOP-1 keeps two Dev notes and a ticket note and proposes a lesson; run 2 on SHOP-2 gets them in its system prompt
  and, in its transcript, runs `npm test -- --run` first time and writes in Vietnamese.
- **Outside agent**, MCP only: `docs/demo/ai-memory-274/external_agent.py` reads the memory and proposes a lesson.
- **Live, with real models** (scenarios left to us by the owner; `docs/demo/ai-memory-274/live_check.py`, sonnet for
  the Devs, haiku for the outside agent, about $0.40 a round). A small repository whose `./test.sh` watches unless run
  with `--once`; SHOP-1 for Dev An with a comment from An asking for Vietnamese; then SHOP-2 (no comment) for Dev Binh,
  another member of the Dev role.

  | Round | Dev An on SHOP-1 kept | Dev Binh on SHOP-2 was given | Dev Binh did |
  |---|---|---|---|
  | 1 (3.34.0) | **nothing**, though the rule was in its prompt, the `keeping-memory` skill loaded and `knowledge` listed | nothing | wrote in **English**, ran the same refused commands |
  | 2 (`learned` on the report) | 1 note (pytest missing, `python3 -m unittest` refused); not the request for Vietnamese | that note | Vietnamese, but it cannot be told from the note's language; still tried `unittest` |
  | 3 (the board's pass after every run) | 2 notes itself; the board added 3: **An's request for Vietnamese (feedback)**, the refused `git checkout`, the values `ticket_items` takes | 4 role notes, listed in What it was given | wrote in **Vietnamese** on a ticket with no comment from An, and **did not run pytest** (the note says it is missing) where Dev An had |
  | 4 (3.34.2: the prompt names `./test.sh`, the Dev may `git switch`) | ran `./test.sh` (watch mode, gave up), then `./test.sh --once`, and kept that; switched to its branch and committed. The board kept the request for Vietnamese | that note and the feedback | ran **`./test.sh --once` the first time**, wrote in Vietnamese, made its branch and committed |

  So a model does not keep memory on its own initiative, even told to: the report's `learned` and the board's pass
  after the run are what make it reliable (3.34.1). Round 4 met the trap the check was built around: Dev An paid for
  `./test.sh` once and kept the fix, and Dev Binh, on another ticket, did not pay for it again (3.34.2 named the
  project's test command in the prompt and let a Dev without a worktree reach its branch; before, neither Dev ran the
  repository's tests or left `main`). Dev Binh made its branch from Dev An's, where the checkout stood: the prompt now
  says to branch from the base. The outside agent (haiku) read the memory and the notes each time and wrote good
  lessons, but asked before proposing them on the board, even after the tool said a project lesson is only a
  proposal; the MCP write path itself is covered by the tests and the demo.
