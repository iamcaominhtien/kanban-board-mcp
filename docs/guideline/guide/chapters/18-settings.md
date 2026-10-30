---
title: Settings
part: 6
audience: [everyone, admin]
summary: Where each setting lives, and which ones are for the project and which for the whole app.
reading: 5
---
Open **Settings** from the sidebar (++Mod+,++ in the desktop app). Pages are grouped into **project** settings (they apply to the project you are in) and **app** settings (they apply to the whole installation). Press `/` to search the settings.

## The pages

| Page | Scope | What it holds |
| --- | --- | --- |
| **Repositories** | Project | The git repository and worktree defaults ({ch:branches}). |
| **Docs** | Project | Who can edit pages, and Docs AI: who answers, what AI may read, the style guide page, freshness checks, how AI edits are handled ({ch:docs}). |
| **AI** | Project | The Board AI, AI members, Safe mode, limits ({ch:safety}). |
| **Board assistant** | Project | Switches and prompts for the Board AI ({ch:board-ai}). |
| **Idea Space** | Project | Idea AI helpers and their daily cap ({ch:ideas}). |
| **Appearance** | App | Theme. |
| **Storage & backup** | App | The data folder, the workspace folder, export and import ({ch:data}). |
| **Integrations** | App | MCP integrations for Claude Code and Antigravity, and the draw.io editor ({ch:mcp}). |
| **Updates** | App, desktop only | The installed version, the last check and a **Check for updates** button ({ch:desktop}). |
| **Diagnostics** | App | Application logs, with **Export logs**. |

The list above is read from the code when the guide is built: {fact:settings_pages}.

## Open a page from the menu

In the desktop app, the Help menu opens the right page directly: **Set Up AI…** (Settings › AI), **Set Up MCP…** (Settings › Integrations) and **Export Logs…** (Settings › Diagnostics).
