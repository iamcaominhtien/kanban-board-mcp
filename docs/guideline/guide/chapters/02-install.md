---
title: Install and first run
part: 1
audience: [everyone, admin]
summary: Install the desktop app, or run the board from source, and create your first project.
reading: 5
---
Kanban Board runs as a desktop app (Windows and macOS installers) or as a local web server you start yourself. Both keep your data on your computer.

## Install the desktop app

The installers are on the project’s Releases page, `github.com/iamcaominhtien/kanban-board-mcp/releases`. The app can also open that page for you: {menu:Help › Check for Updates…}.

1. Download the installer for your system: a `.dmg` on macOS (one for Apple silicon, one for Intel) or a `Setup .exe` on Windows.
2. **macOS:** open the disk image and drag **Kanban Board** to Applications. **Windows:** run the installer.
3. Start **Kanban Board**. A splash screen shows while the local server starts.

!!! note "macOS and Linux"
    The macOS app is not notarized. The first time, right-click it and choose **Open**. There is no Linux installer yet; on Linux run the board from source (next section).

!!! note "Updates"
    The app checks for a newer release a few seconds after it starts and every 6 hours. A card appears in the corner only when a newer version exists. {Ch:desktop} describes the update flow.

## Run it from source

Use this to develop the app or to run it on a server. It needs Python 3.12 or newer with [uv](https://docs.astral.sh/uv/), and Node.js for the interface.

```bash
cd server
uv sync
uv run uvicorn main:app --port 8000

cd ../ui
npm install
npm run dev        # http://localhost:5173
```

The database is created and migrated on first start. {Ch:self-hosting} lists the settings you can change with environment variables.

## Your first project

On a fresh install the app asks you to **Create your first project**. Give it a name (for example “Kanban Redesign”) and a short key (for example `KAN`). The key becomes the start of every ticket number, such as `KAN-12`.

!!! tip "Not sure where to start?"
    {Ch:quick-start} is a one-page quick start. It takes you from an empty project to a board with a ticket on it.

## If it does not start

The desktop app shows a **Connecting…** screen while the local server starts. If it never opens, press **Try again** on that screen, then see {ch:troubleshooting}. The logs folder is under {menu:Help › Open Logs Folder}.
