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

(The sections below are filled in as the work lands.)
