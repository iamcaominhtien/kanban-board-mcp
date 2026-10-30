# C11 · Settings, data and integrations

**Bug file:** `bugs/11-settings-and-data.md` · **Bug ids:** `C11-001`, `C11-002`, …

**Persona:** An administrator looking after the installation.

**Goal:** Every Settings page and everything about where the data lives.

## Read first

The spec for this area. Behaviour that contradicts it is a `logic` bug.

- `docs/guideline/guide/chapters/18-settings.md`
- `docs/guideline/guide/chapters/21-data.md`
- `docs/guideline/guide/chapters/22-self-hosting.md`
- `docs/guideline/guide/chapters/23-mcp.md`
- `design/screens/settings-pages.md`
- `design/screens/settings-structure.md`
- `design/screens/settings-mcp.md`

## Setup

A project with data in every area, and a second empty folder for the data move.

Follow the setup in the [README](../README.md#setup).

## Try

Do these like a user would, then go beyond them: wrong input, cancel, undo, twice quickly, reload in the middle, two tabs. Tick them off as you go; add what you find on the way.

- [ ] Open every page in Settings (Repositories, Docs, AI, Board assistant, Idea Space, Appearance, Storage & backup, Integrations, Updates on desktop, Diagnostics); the `/` search in Settings; a deep link to a page; a project setting versus an app setting.
- [ ] Appearance: light, dark and the system theme, and whether every screen of the app follows it (hard-coded colours, images, the sketch editor, the diagram editor).
- [ ] Storage and backup: change the data folder, the workspace folder, export, import (a good file, an old one, a corrupt one, a huge one); after each, is everything there?
- [ ] Integrations: MCP set-up for Claude Code and Antigravity, the draw.io editor.
- [ ] MCP server over stdio and HTTP: the 12 tools, an error message that tells how to fix the call, a change made through MCP appears in the UI.
- [ ] Diagnostics: logs, Export logs (no private text in it).
- [ ] Keyboard Shortcuts window (Ctrl/⌘+/): each listed key does what it says (`shortcuts.json` is the list).

## Ask yourself

- Could an administrator undo every change on these pages?
- Would anything here make a careful user stop and doubt the app?

## Done when

- Every item above was tried, or its entry in the bug file says why it could not be.
- Each screen was seen in the light and the dark theme.
- The bug file is committed and pushed, and the last line of it says `Charter finished` with the date and the SHA tested.
