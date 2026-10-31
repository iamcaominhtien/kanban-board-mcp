---
title: AI members
part: 5
audience: [ai, admin]
summary: Add AI members next to people on your board, give each one a role, and assign them tickets.
reading: 14
---
An AI member is a member of a project that happens to be an AI. You assign it tickets, @mention it in comments, and it works through a real **run** with live steps. It stops at Review. Every action goes through permissions, approvals, budgets, a kill switch and an audit log ({ch:safety}).

!!! ai
    There are three AI features: **AI members** (do the work), the **Board AI** (answers and drafts, {ch:board-ai}) and **AI schedules** (work at set times, {ch:schedules}). They share one set-up.

## What you need

- **Claude Code CLI**, signed in, if you want an AI to change code on your computer. Install Node.js, then `npm install -g @anthropic-ai/claude-code`, run `claude` once and sign in. Check with `claude auth status`. Restart the app so it sees the new PATH. The app starts the CLI as you would by hand; it does not read or store the CLI’s sign-in.
- **Or an API key** (Anthropic, OpenAI, Gemini, or an OpenAI-compatible endpoint). These AIs work inside the board, with its tools (read and edit tickets, comments, Docs). They do not edit files on your computer. They suit triage, rewriting descriptions, reviews and the Board AI.
- A **working folder** for a Claude Code AI: usually the root of a git repository. Commit or stash unfinished work first.

!!! warning "Where the working folder may be"
    For safety the folder must be inside your home folder (not the home folder itself), or inside a folder listed in `KANBAN_AI_ROOTS` ({ch:self-hosting}).

## A team of four

Different jobs need different permissions, so use separate members. This team works for most small and medium projects.

| AI | Does | Model | Template | Moves tickets up to |
| --- | --- | --- | --- | --- |
| **PM** | Gets tickets ready: clarify, add criteria, estimate, split. Never edits code. | Sonnet | Developer, with file editing removed | To Do |
| **Dev** | Takes a ready ticket: changes code, runs tests, reports. | Sonnet | Developer | Review |
| **Reviewer** | Checks tickets in Review against the criteria. Edits nothing. | Sonnet | Reviewer | Review |
| **General** | Answers questions and drafts. Usually the Board AI. | Haiku | Read-only | None |

Tickets flow: rough ticket → PM prepares → you assign Dev → Dev finishes in Review → you @mention Reviewer (ask) → you Approve or Request changes. AIs never assign work to each other: text written by another AI is only data.

Start small: General, Dev and Reviewer first; add PM when the backlog needs tidying. Keep names short (PM, Dev) so @mentions are quick.

## Add an AI member

Open **Members**, choose the **AI** tab, then **Add AI member**. A four-step window asks for:

1. **Type**: Claude Code, an API-key provider or another MCP client.
2. **Connect**: the app finds the CLI, its version and the account. Fill in the **Working folder** and **Model** (Sonnet or Haiku for Claude Code), then press **Run test** and wait for “Connection OK”.
3. **Identity and limits**: a **Name** (not used by anyone else in the project), a short description, a **Role / persona** (up to 1000 characters), **Max parallel runs** (default {fact:ai_parallel}) and **Scheduled runs per day** (default {fact:ai_runs_per_day}; only scheduled runs count). The row **Start from** fills all of this with PM, Dev or Reviewer.
4. **Permissions and review**: **May move tickets up to** (None, Backlog, To Do, In Progress or Review; Testing and Done need an extra confirmation) and the switches **Ask a person first before it can…** (delete a ticket, change an assignee, create tickets, edit docs).

@figure a05-add-step2-connect "Step 2 of the Add AI member window: the CLI is found, the working folder and model are chosen, and the connection is tested."

@figure a06-add-step3-identity "Step 3: name, description, persona and run limits."

The window has no template choice: a new AI always starts with the Developer template and you change it on the **Permissions** tab afterwards.

### The built-in roles

The roles in **Start from** come from one file in the app, so the text below is what the app offers.

**PM**

@preset pm persona

**Dev**

@preset dev persona

**Reviewer**

@preset reviewer persona

## After you create it

Open the AI member and the **Permissions** tab. The **Role template** card offers Developer, Reviewer, Read-only and Custom (Custom needs the owner). Set Reviewer to Reviewer and General to Read-only.

@figure u03-role-template "The Role template card and the table of what the AI may do."

Role templates control what an AI may do to **tickets**. What it may do to **files** is set by the CLI rules in {menu:Configuration › Permissions}. By default a Claude Code AI may read, search, edit and write files, run `git status`, `git diff`, `git log`, `pytest`, `npm test` and `npm run lint`, and it may not run `rm -rf` or the like. To let it run your own test command add a rule such as `Bash(go test:*)` or `Bash(cargo test:*)`. Do not add `git push`, `rm` or `Bash(*)`.

!!! caution "Bypass permissions"
    The Permission mode **Bypass permissions** (owner only, with a typed confirmation and an audit entry) lets a Claude Code AI run tools that are not on the allow list. Deny rules, the status ceiling, board approvals and Safe mode still apply, and it only affects work runs. Use it only in a folder you can restore with git.

## Assign work

There are two ways.

**Assignee.** Pick the AI in a ticket’s Assignee. A box asks how to start: **Start now**, **Queue** (run after the current work) or **Assign without running** (press Run later).

@figure b03-how-to-start "The “How to start” box after assigning a ticket to an AI member."

**@mention in a comment.** Type `@` and choose the AI. Then choose what the mention means:

| Intent | What the AI does |
| --- | --- |
| **Ask** | Answers with a comment. Changes no file, field or status. |
| **Do the work** | Takes the job and starts a run. |
| **Just notify** | Is told, and does not run. |

Examples: “@Reviewer does `apply_discount` handle negative quantities? Only answer, change nothing.” and “@Dev please finish the pagination described above and run the tests.”

## Watch a run

A ticket has a **Run** tab that shows each step live: files read and changed, commands run, status changes, tokens and cost. **Stop** is always there. On the board the card shows a Running or Queued chip.

@figure b05-run-panel-live "The Run tab while an AI is working."

When the AI needs a decision it stops at **Needs input** and shows a question card with choices (one is recommended). Your answer resumes the same session. If the question is not answered, the app reminds you after 15 minutes, and again later; an admin is told after 6 hours.

@figure c06-question-card "A question card from an AI."

## Review the result

When done, the AI moves the ticket to **Review** and leaves a **summary**: what it did, which files changed, and each acceptance criterion with evidence. Only a person moves a ticket to Done.

| Button | Meaning |
| --- | --- |
| **Approve** | Accept. The ticket goes to Done. |
| **Request changes** | Write a note; the AI redoes the work with it. |
| **Take over** | You continue; the AI lets go. |
| **Undo run’s changes** | Reverts the ticket data the run changed. |

@figure b08-ai-summary-review-gate "The review gate with the AI summary and the four buttons."

!!! warning "Code changes are undone with git"
    **Undo** only reverts ticket data. For files use `git diff` to look and `git restore .` to drop changes. This is why you assign work when the repository is committed.

## What an AI remembers

A Claude Code AI keeps one conversation per ticket. When you @mention it again, press Run again or Request changes, it continues that conversation. To let the PM know what Dev did, each run is given an **Activity since your last run** block listing other AIs’ runs on the ticket. Two runs of the same AI on the same ticket never run at once. An API-key AI starts fresh every run. Put what matters in the ticket and its comments: the board loads them on every run.

## One AI in several projects

Create the AI once, then tick more projects on its Permissions tab (**Scope**). Its identity, connection, persona, permissions and limits are shared; the working folder, the Board AI choice and runs are per project. After adding a project, open the copy there and set its Working folder.

## Where to go next

The Board AI and chat on tickets: {ch:board-ai}. Safety and cost: {ch:safety}.
