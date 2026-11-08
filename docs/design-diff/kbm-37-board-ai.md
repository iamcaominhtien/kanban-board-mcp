# KBM-37: design vs code, frame by frame

Working table written **before** coding (canvas `1794110641-1323`; source files `design/source/AiBoardAssistant.dc.html`, `AiBoardWave3.dc.html`, `AiEverywhere.dc.html`; the PNGs and the docs were read next to them). "Code now" is branch `claude/ai-team-architecture-7a1efc` at `6f6dd69`.

## AiBoardAssistant

| Frame | Design | Code now | What changes |
|---|---|---|---|
| A1 dock, welcome | "I read tickets, comments and docs you can see. I do what can be undone at once and tell you what I did; for anything hard to undo I ask you a question." | "…propose changes as drafts. I never change anything until you press Apply." (`AssistDock.tsx`) | New text |
| A1 dock, footer | "Changes it can undo are made at once and listed. Answers can be wrong." + context meter | "AI proposes · you apply. Answers can be wrong." | New text (docs scope keeps "Only this page and linked tickets are sent.") |
| A1 try asking | Who's blocked this week? / Summarise doc "…" / What changed since Monday? | third is "What should I pick up next?" | Doc suggestion when the project has a page |
| A5 / G1 Claude Code missing | Title "Claude Code was not found", text "Claude Code was not found on this computer. Install it, or add an AI team in Members." | "Board AI isn't set up … API key or local runner", "Open Settings → AI / Manage AI members" (`NoBoardAi`); the server's own message never reaches the UI | Show the title and the server message; the state API carries it; one button "Open AI Team" |
| B1 conversation | Answer, table, pills, "Based on N tickets · N docs" | Built | – |
| B2 It does it, then says so | Receipt "Done — 2 changes · Undo all 2", one line per change, "Recorded as … (through the Board AI)" | `DoneReceipt.tsx` exists but the **server never sends a receipt** (`chat.detail` returns `drafts: []`; the undo route answers 410) | Server: collect what the turn changed (Activity entries of the turn's run id), keep it on the answer, `POST /ai/assist/messages/{id}/undo`; UI: show it |
| B3 Undo all | "Undone — 2 put back", lines struck through, skipped ones named | UI exists, no server | Same as B2 |
| B4 Hard to undo | Question card with options and "Answer and resume" | No assistant path to a question card (a team's `ai_run ask` parks a run; an assistant turn has none) | **Not built as a card**: the Board AI asks in its answer (skill `board-ask`, already so) and the person answers in the box. Written in the PR as a question to the lead |
| B5 History | Rows: title, scope chip, time. No `$` | Row shows `$cost`; footer "N chats · $x this month" | Remove both (not metered) |
| B6 Scope | Three options with sizes, "~5× cost" chip | Built | – |
| B7 Thinking | "Thinking… / Reading the board / Waiting for an answer… Stop" | Same plus "Tokens used so far are still charged." | Remove the charged line |
| B8 Error | "Claude Code did not answer after 4 s. Nothing was changed. Your message is kept." Try again / Copy error details | "{message} Nothing was changed and nothing was charged." | Reword |
| B9 Context bar | Green, amber from 60 %, red from 85 % | Built (`ContextMeter`) | – |
| I7 Viewer | "I can look this up but I cannot change it — your role is Viewer" | Dock/ticket chat: "You can read, not ask" | Check what the server allows before rewording |
| A-161 | "Rate-limited": the Claude account window; no money cap | "Rate-limited by {provider} … Too many requests on this API key" | Reword |
| B9/I2 over budget | Not drawn (owner decision 2) | `AnswerBlock` "AI is paused until tomorrow", "Monthly cap reached", dock "Chat is paused / Over budget"; the server sends `over_budget: false` always | Delete the branches |
| C1–C5 ticket chat with a team | Header team name + state, Chat / Runs N, Reading chips, "Lead answered", Post as comment / Copy, + menu, Start over, History, `/` commands (six) | Built (KBM-26 / earlier) | Check each frame on the board |
| C6 ticket with no team | Header "Board AI · Backend team (Claude Code) · online", "I read KAN-154 and what is listed above. I do what can be undone at once and ask you about the rest." | Welcome says "I propose changes as drafts and never change anything until you press Add or Apply." (`ScopedChat.tsx:~620`); member header "Local runner · online" style text | New text |
| E No team yet | "Add a team to use these helpers" … "Open AI Team" | "Choose an AI to use these helpers … Open AI members" | New text |
| ScopedChat over budget tile | Not drawn | "AI is paused until tomorrow" (also `AnswerBlock` prefix) | Delete |
| D Board health | Panel with six kinds, Snooze, Dismiss, "AI summary", "Not metered · N tickets"; no act button; no "Offer a draft comment" row (A-163, A-164) | Row "Offer a draft comment on the ticket…" in the noise controls | Delete the row |
| F Settings › AI | Board AI = the first team; features Ask AI, Drafting in editors, Board health, Docs AI, Sketch AI; "What is sent to Claude Code"; no caps, no audit link | `AssistSettings.tsx`: "local runner" and cap fields, "Style guide for ticket drafts" | Match F |
| G3 Slow | "Usually a few seconds. Claude Code is busy." | "The provider is busy" | Reword |
| G5 Empty board | "Ask for a first ticket" / "Skip" | "Draft first ticket with AI" | Rename |
| G8 Private doc | "Not sent to Claude Code and not citable…" | "Not sent to the provider…" | Reword |
| E Docs AI (frames E1–E4) | Docs editor | `assist/DocsAi.tsx` | **Not touched**: KBM-38 owns Docs AI |

## AiBoardWave3

| Frame | Design | Code now | What changes |
|---|---|---|---|
| A What it does / asks | Information board | – | Nothing to build; the skill already says it |
| B Receipt + question | Receipt "Done — 4 changes · Undo all 4", "Needs input" card, no buttons | See B2 / B4 | Same as above |
| C What it can reach | Information board (tools of `board-ask`) | – | Nothing to build |
| D Knowledge base | Panel with "This project / Shared", sentence about the light model | `ai/knowledge/*` (KBM-34 merged) | Compare on the board; fix only if different |
| E1 red CI | Card, chip "Opened by the board", only "Open the run on GitHub" | Built | – |
| E3 The team has it | "The board gave the failing check to Backend team: a new run, started by the board (red CI)." | "The board gave the failing check to the team {ago}." | Name the team, say "a new run, started by the board (red CI)" |
| E4 Review comments | "2 review comments on KAN-203", "From a person", the same line with "(review comments)", button "I will answer them" | Card and button built, no "gave to the team" line | Add the line |
| E5 / E6 GitHub states | Unreachable (old state, not a green light), watching off | Built | – |
| F Events | Merge conflict row; "Runs wait for the next usage window" | `notifications.py` | KBM-38 |
| G States | Seven: undo too late, half done, viewer, KB empty, unreadable file, GitHub unreachable, Board AI off | Half done and skipped: built in the receipt; others: see the PR | Add "undo too late" naming what overwrote it |

## AiEverywhere

| Frame | Design | Code now | What changes |
|---|---|---|---|
| A / B chat on the ticket, Runs tab | Chat + "Runs N", Post as comment, Copy, Private to you | Built | Check on the board |
| B2 no team | Board AI answers | v1 welcome | See C6 |
| C @ picker, Send to {team} | `comments/Composer.tsx` | Merged earlier | Not touched |
| D Editors | `/ai`, selection bar | `ai/editor/*` (KBM-38) | Not touched |
| E States | "No team yet" | See E above | – |
