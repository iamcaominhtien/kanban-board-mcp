# Talking to the AI team and handing work over: 1:1 with the designs (issue #272)

Read from the design sources themselves (`design/source/*.dc.html`), one table per screen, one row per lettered
section. *Design* is what the source draws, *code today* what `main` (3.32.0) did before this change, *gap* the
difference, *fix* what this change does. Screenshots: `docs/screenshots/272/` (before: the UI of `main` on the same
board; after: this branch).

Where the issue asks for more than a design draws (a handoff note, giving a ticket back, who has it while nobody
runs), the code follows the issue and the design's words and chips; that is said in the row.

## AI work on tickets — `AiTicketWork.dc.html`

| § | Design | Code today | Gap | Fix |
|---|---|---|---|---|
| A1 | Assignee picker with an AI group, live status, reasons for disabled members | `AssigneePicker` has it | none | kept |
| A2 | On assign: Start now / Queue / Assign without running | `AssigneePicker` popover | none | kept |
| A3 | Ticket header after assigning: assignee, run chip, "Held since 12:41", "moved by …" | `HoldChips`, `StatusMovedBy` while a run holds the ticket | When no run holds it, nothing says who has it: a workflow waiting for a person, a stopped workflow, a ticket a person took back all look the same as an idle one | **Who has it** line under the assignee (`WhoHasIt`): "Dev Khoa is working on it · Build", "Waits for a person: Done", "An Nguyen took it back from the AI team · Build", "QA Linh waits for An's answer". `GET /tickets/{id}/ai/holder`, and `held_by` in `get_ticket` |
| A4 | Card footer variants (Assigned, Queued #1 behind…) | `TicketCard` AI footer | none | kept |
| B | @mention an AI: pill, hover card, "what does the mention mean?" | `MentionPill`, `MentionIntent` | none | kept |
| C | Ask an AI a question: Ask shortcut, thread states, regenerate, thumbs | `CommentsSection`, `AiThread` | none | kept |
| D1–D2 | Run lifecycle and the Run panel (steps, files, commands, tests, cost) | `RunPanel`, `RunView`; "Tell the AI" box (`TellBox`, ai-team-process J) | The box exists on screen, not over MCP | `ai_team(tell, run_id, text)` over MCP; a test checks that a message sent while a live run works reaches it and changes its answer ("Got it: Use the cursor.") |
| D3–D5 | Usage, Open in terminal, run history | as drawn | none | kept |
| E1–E3 | The AI asks back: question card, remind, answering resumes the run | `QuestionCard`; `ai_team(answer)` over MCP | `get_ticket` did not say the ticket waits on a person's answer | `held_by` says "… waits for …'s answer"; the scripted MCP session answers the PM's question from `ai_team(runs)` |
| F1 | Review gate: AI summary, Approve, Request changes, **Take over**, Undo | `ReviewGate` with `TakeOverButton` | Take over cancelled the run and reassigned the ticket, but a workflow kept going as if the step had failed, and nothing was written down of what the AI had done | Take over now pauses the workflow at its step ("taken back"), leaves a handoff note of what the AI did so far, and takes an optional *Why* that goes into the note. Wording in the popover says so |
| F2–F4 | Request changes, AI blocked at Done, AI-completed badge | as drawn | none | kept |
| G | Attribution and history, undo | `AiAuditLog`, `RevertChange` | none | kept |
| H1 | One holder, two assigned AIs: "Held by Claude Code · Backend", "Next … waits for the hold"; "A person's Take over takes the hold" | `HoldChips` | Taking the hold had no way back to the AI | **Give back to AI** beside the Who has it line on a ticket taken back: a note in the four fields (Done needed); the workflow goes on from the step it was on, its AI reads the note first. Without a workflow, the AI that had it takes it again. On the workflow strip the step reads *taken back* and a card says the workflow waits for the person, with Give back (the first live recording showed it as "It stopped going round", a red Failed step and a test-first card) |
| H2–H8 | Edits while running, offline AI, budget, depth limit, delete/archive, plan drafts | as drawn | none | kept |

## AI where you work — `AiEverywhere.dc.html` (with ai-team-process J)

| § | Design | Code today | Gap | Fix |
|---|---|---|---|---|
| B | A chat on the ticket, docked; it answers, drafts, posts, or does the work | ticket chat (`assist/TicketChat`) | none | kept |
| C | Calling an AI from a comment: Ask only (default) / Do the work | `MentionIntent` | none | kept |
| D–F | AI in every editor; states; rules ("everything an AI posts is marked with the AI badge and links to its run") | as drawn | A handoff note is an AI comment like any other | The note is an AI comment with its badge and run link, drawn as a card with its four fields ("Handoff note · Shape · BA Bao → Dev") |
| J (process) | A sentence to the AI that is working right now | `TellBox`, Live commentary's reply | none on screen | over MCP: `ai_team(tell)` (above) |

## Story, Flow and Live commentary — `AiStoryFlow.dc.html`

| § | Design | Code today | Gap | Fix |
|---|---|---|---|---|
| B–G | A Story: goal, plan, approval, children on workflows | Story screens; `ai_team(give_story, story, approve_plan, revise_plan)` over MCP | An outside agent had no guide to follow a Story end to end without reading code | `ai_team(guide)` §7 "A session, step by step" (give the goal, `board_wait`, answer, approve); a test plays it over MCP only |
| K | Live commentary: follows the scope, Needs you pinned, reply to the AI that is working | `LiveFeed` with its tell box | none | kept |
| — | (not drawn) The workflow strip on the ticket shows each step's note | the strip printed each run's whole final text (a QA's 30-line message in a 220 px column) | too long to read; the next step needs Done and Left | the strip shows the step's handoff note (Done, Left); the full note is the comment card. A step started from a hand-over says "Started from the handoff note given with it" instead of repeating it |

## Kept on purpose

- The words of the designs: **Take over** (not "Take back") on the button, as AiTicketWork F1 and H1 draw it; the
  MCP action is `take_back` because it reads better in a call.
- The chip style of H1 (`tw-hold`) for the waiting state; an AI holder uses the AI purple, a person grey.
