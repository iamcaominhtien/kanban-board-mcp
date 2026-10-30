---
title: Privacy and data
part: 7
audience: [everyone, admin]
summary: What stays on your computer, what an AI feature sends, and how to turn it off.
reading: 5
status: to-confirm
standalone: privacy
---
Kanban Board is local-first. Your projects live on your computer. Nothing leaves it unless you use a feature that talks to an AI provider.

## Where your data goes

| On your computer | Only when you use AI |
| --- | --- |
| The database (tickets, Docs, ideas), attachments and workspace folders, logs, and settings. API keys are kept in the system keychain in the desktop app. | The text of the question you ask, to the AI you chose: an API provider (Anthropic, OpenAI, Gemini or your own endpoint), or the signed-in CLI on your computer (for example Claude Code). |

The app has no account of its own and no telemetry in the guide’s scope. A feature that sends something shows **What will be sent** first (editor AI, Docs AI, Sketch AI), together with the cost.

{confirm: List here, from the code, every kind of request the app can make to the network: AI providers, the update check against GitHub, the draw.io editor address, and anything else. Check `ui/src` and `server/` for outgoing requests before release.}

## What an AI feature receives

{confirm: State exactly what is put in a prompt for each feature: the Board AI chat, AI member runs, editor AI, Docs AI, Idea Space helpers and Sketch AI. The design lists the text asked about, the comments and linked pages needed to answer, and the instructions for that AI member, and says it does not include other projects, API keys or the data folder. Verify each line in `server/services/ai/` before release.}

Facts that are already visible in the app and the code:

- A page marked **Hide from AI** is skipped by every AI feature ({ch:references}). **Excluded docs** in Settings › Board assistant are never sent.
- An AI run uses the AI member’s own permissions and the project’s data scope.
- The desktop app never reads or stores the CLI’s sign-in; it only shows the account name the CLI reports.
- Reports sent from Help › Report an Issue… are made by you, in your browser. The app sends nothing ({ch:desktop}).

## Turn it off

AI help can be turned off per project in Settings (Board assistant, Docs AI, AI in editors, Idea Space and Sketch AI have their own switches), and **Pause all AI** stops every AI member at once. With the AI switches off, the app makes no request to an AI provider. {confirm: Confirm that nothing else in the app contacts an AI provider when every switch is off.}
