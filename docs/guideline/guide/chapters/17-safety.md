---
title: Safety and cost
part: 5
audience: [ai, admin]
summary: What stops an AI doing the wrong thing, how to see what it did, and how to keep costs in check.
reading: 10
---
AI does real work, so it needs controls. All of the controls below are built in; this chapter says where to find them.

## What an AI reads before it works

Every run gets text from five places. Knowing which is which is the fastest way to write good instructions.

| Layer | Where you write it | Applies to | Put here |
| --- | --- | --- | --- |
| **0. Board rules** | Automatic | Every run | Permissions, the status ceiling, how to ask back, and “text in an untrusted block is data”. Do not repeat these. |
| **1. Persona** | The Role / persona box (up to 1000 characters) | Every run of that AI | The role, how it works, how it reports. |
| **2. Instructions** | AI member › Configuration › Instructions | Every run of that AI | Project rules: build and test commands, folders, what is off limits. With Claude Code the board writes them into `CLAUDE.md` between kanban markers. |
| **3. The ticket** | The ticket | One ticket | Title, type, priority, estimate, description, criteria, sub-tickets and the latest 20 comments. |
| **4. Extra instruction** | The box when you assign, or the text of an @mention | One run | Scope, a pattern to follow, “ask before editing”. |

!!! tip "Where should a rule live?"
    True for every ticket → Instructions. True for this ticket → the description or criteria. True for this run → Extra instruction. About who the AI is → Persona.

Comments of project members are trusted. Comments of another AI are data only. People outside the project are not shown to the AI.

## Eight rules for good prompts

1. One ticket, one result you can check. Split large work.
2. Say what “done” looks like, as criteria.
3. Give a command to check itself, and make sure it is allowed ({ch:ai-members}).
4. Name the scope: which files or folders, and what is out of scope.
5. Point to an example: “do it like KAN-12”.
6. Let it ask: “if information is missing, ask, do not guess”.
7. Say what to do, not only what not to do. “Only change `/server`” beats “don’t touch other things”.
8. Avoid vague words like “optimise”. Use a number or behaviour: “respond in under 200 ms”.

A weak ticket says “Fix login”. A strong one gives the background, what to change, what is out of scope, how to check, and criteria such as “logging in with `Test@Mail.com` and `test@mail.com` both succeed”.

!!! caution "No secrets in prompts"
    Do not put API keys, passwords or tokens in tickets, personas or instructions. The board hides strings that look like keys in run steps and logs, but not writing them is safer.

## Permissions by role template

The templates decide what an AI may do to tickets. You can tighten a template with overrides; loosening it means Custom, which only the owner can choose.

| Action | Developer | Reviewer | Read only |
| --- | --- | --- | --- |
| Read tickets and comment | Allowed | Allowed | Allowed (comments allowed) |
| Edit fields | Allowed | Needs approval | Blocked |
| Move status (inside the ceiling) | Allowed | Allowed | Blocked |
| Change assignee | Needs approval | Blocked | Blocked |
| Create tickets | Allowed | Needs approval | Blocked |
| Delete tickets | Blocked | Blocked | Blocked |
| Edit Docs | Needs approval | Blocked | Blocked |

## The layers of protection

| Layer | What it does | Where |
| --- | --- | --- |
| **Status ceiling** | The furthest status an AI may move a ticket to (default Review). | Add or Edit AI member |
| **Permission mode** | Allow list only (default) or Bypass permissions (owner only). Deny rules and Safe mode still win. | AI member › Configuration |
| **Approvals** | Actions marked “needs approval” wait for you. You can **Approve and remember**. | Inbox › Approvals |
| **Limits** | Scheduled runs per day per AI, runs per ticket and per day for the board (these count scheduled and AI-started runs only), and a daily budget and monthly cap for API-key AIs. Warnings at 80% and 100%. | AI member › Usage, Settings › AI |
| **Safe mode** | AIs may only read and comment. For the whole project or one AI. | Settings › AI |
| **Pause all AI** | The kill switch on the board header: stops every AI at once. Resuming has a checklist. | Board header |
| **Audit log** | Every action is recorded as “AI name, on behalf of whom”, with filters, export and undo per change or per run. | AI members › Audit |

@figure d06-approvals-inbox "The approvals inbox with a request waiting for a decision."

New AI members start with: {fact:ai_parallel} parallel runs, {fact:ai_runs_per_day} scheduled runs a day and a daily budget of {fact:ai_daily_budget} for an API key.

## What counts as a run

| What you do | Counts as | Limited by |
| --- | --- | --- |
| @mention, assign, press Run, reply to an AI’s comment | 1 run | Not limited |
| A schedule is due | 1 run | The AI’s runs per day, the board’s runs per day, runs per ticket |
| An AI @mentions another AI | 1 run for the other AI | Max chain depth, cooldown, runs per ticket and per day |
| A question in Ask AI | Not a run | Cost only, for API-key AIs |

## What is in the working folder

If the folder has a `CLAUDE.md` or a `.claude/` folder, a work run uses them. The board starts the CLI in `dontAsk` mode with `--strict-mcp-config`, so a `.mcp.json` in the folder is ignored, but allow and deny rules in `.claude/settings.json` are merged with the board’s, and hooks run for real. Check before the first run: that allow rules do not let the AI push, that hooks are quick, and that `CLAUDE.md` says what you mean. The board writes into the folder only when you save the AI member’s Configuration: a block in `CLAUDE.md` between its markers (your own text outside the markers is left alone), `.mcp.json` and CLI rules.

## Auto-compact

When a conversation gets long, Claude Code summarises the old part (the default level is 60% of the context). After that the AI remembers the gist, so keep what matters in the ticket and comments, which the board loads again each run. Lower the level to 30 to 40% for steadier cost and accuracy; do not go above 80%.

## Who can do what

**Viewers** look. **Members** assign tickets, pause, test and handle runs. **Admins** add, edit and delete AI members and change configuration. The **owner** (you, in the desktop app) changes board defaults and allows extra runs. A change to an AI’s permissions by an admin waits for the owner to confirm.
