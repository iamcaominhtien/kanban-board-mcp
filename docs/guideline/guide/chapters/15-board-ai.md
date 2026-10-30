---
title: Board AI and chat on tickets
part: 5
audience: [ai]
summary: Ask questions about your board, draft tickets and pages, and use AI in every editor.
reading: 10
---
The **Board AI** answers questions and drafts things for you. It does not change data by itself: it proposes, and you apply.

## Choose the Board AI

Open {menu:Settings › AI} and look at the **Board AI** card. Press **Change** and choose an AI member that is online. The first AI member of a project becomes its Board AI. “Currently not chosen” means the project has none; the Change button is greyed until the project has an AI member. Without a choice, Ask AI still answers using a Claude Code AI of the project and says it is a stand-in.

@figure t01-settings-ai "Settings › AI with the Board AI card."

Give it a working folder with nothing in it: the Board AI runs without tools and ignores the folder’s settings, but an empty folder makes sure.

## Ask AI

Press ++Mod+J++ (or the **Ask AI** button) to open the dock. Choose its scope: project, ticket, doc or all projects. The answer shows its sources and cost, with a thumbs button to rate it. Examples:

| Scope | Question |
| --- | --- |
| Project | Which tickets are blocked and who are they waiting for? |
| Project | Summarise progress for tomorrow’s meeting: done, in progress, risks. |
| Ticket | Explain this ticket to a new person: goal, related files, what is left. |
| Ticket | Are the acceptance criteria complete? Which edge cases are missing? |
| Docs page | Summarise this page in 5 bullets and name decisions that are still open. |

@figure g04-answer "An answer in the Ask AI dock."

## Drafts you apply

| Feature | Where | Tip |
| --- | --- | --- |
| **Draft with AI** | New Ticket | Describe the idea roughly. You get a title, description, criteria and priority, and similar tickets to avoid duplicates. |
| **Improve description** | On a ticket | Say what you want (“shorter”, “add how to test”). See the diff and accept each part. |
| **Split with AI** | On a parent ticket | Say whether to split by layer or by step. Sub-tickets come with blocked-by links. |
| **Suggest test cases** | Test Cases | Write clear criteria first. Cases are tied to each criterion. |
| **Board health** | A chip on the board and a daily digest | No prompt. Set the time, “stuck” days and WIP limit in Settings. |
| **Docs AI** | The AI menu on a Docs page | Select text to summarise, rewrite or ask. |

@figure h03-draft "A draft ticket from Draft with AI, with a decision for each part."

## Board assistant settings

{menu:Settings › Board assistant} has a switch for each feature: Chatbot, Ticket drafting, Sub-task split, Test case suggestions, Board health and digest, Docs AI. It also sets the answer language, tone, a **Style guide** that is added to answers, a **Data scope** (what the Board AI may read in each project) and **Excluded docs**, which are never sent.

@figure t02-settings-assistant "Settings › Board assistant."

## Chat on a ticket

The ticket page has a chat docked on the right, about that ticket. Choose **Ask only** (answers, nothing changes) or **Do the work**. An answer can be posted as a comment. It can also draft acceptance criteria. The cost is shown before you send.

The `@` list says what each AI can do and what the mention means is written under the box. **Viewers** can read the chat, and only members can ask.

## AI in every editor

In the description, comments, Docs pages and ideas:

- Type `/ai` or press ++Mod+J++ in an editor for a menu.
- Select text for a bar with **Improve**, **Shorten**, **Fix spelling**, **Explain** and **Ask…**.
- The result is a **draft over the text** with the changes marked. Accept it, discard it or try again; Ctrl+Z takes an accepted draft back.
- **What will be sent** shows exactly what leaves the editor ({ch:privacy}).
- Activity records “edited with AI by …”.

One switch per project turns AI in editors on or off.

@figure s04-editor "AI in an editor: a draft with the changes marked."

!!! ai
    An AI member that edits Docs pages can work directly, propose an edit for a person to approve, or write a draft, depending on the project’s Docs AI settings ({ch:docs}).
