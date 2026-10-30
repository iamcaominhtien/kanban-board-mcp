---
title: Self-hosting and configuration
part: 7
audience: [admin, developer]
summary: Run the server yourself, and the environment variables that change how it behaves.
reading: 6
standalone: self-hosting
---
## Run the server

You need Python 3.12 or newer and [uv](https://docs.astral.sh/uv/).

```bash
cd server
uv sync
uv run uvicorn main:app --port 8000
```

The database is created and migrated on first start. Open the interface (built with `npm run build` in `ui/`, or `npm run dev` for development) and connect an agent to `http://localhost:8000/mcp/`. The trailing slash is required.

## Environment variables

Set these before starting the server. The guide checks every variable below against the code when it is built.

| Variable | What it does |
| --- | --- |
| `KANBAN_DB_PATH` | Where the database file is. |
| `KANBAN_UPLOADS_DIR` | Where attachments, workspace folders and sketches are stored. |
| `KANBAN_LOG_DIR` | Where the log files are written (default `~/.kanban-board/logs`). |
| `KANBAN_AI_ROOTS` | The folders an AI member may be given as its working folder, in addition to your home folder. |
| `KANBAN_MCP_IDEA_TOOLS` | Set to `1` to show the {fact:idea_tool_count} Idea Space tools to MCP agents. |
| `KANBAN_MIN_UI_VERSION` | Makes an interface older than this version show the update-required screen. |
| `KANBAN_SECRET_STORE` | Where AI API keys are kept. The desktop app uses `keychain`. |
| `KANBAN_AI_KEY_FILE` | A file holding the key that encrypts AI API keys, when no keychain is used. |
| `KANBAN_CHROME_PATH` | A Chrome, Chromium or Edge to draw diagram previews with. |
| `KANBAN_DIAGRAM_EXPORT` | `off` switches diagram preview drawing off; `public` allows diagrams.net. |
| `KANBAN_BOARD_URL` | The address the board is reached at, used in links an AI run writes. |

## The AI working-folder rule

An AI working folder must be inside your home folder (not the home folder itself) or inside a folder listed in `KANBAN_AI_ROOTS`. This applies when an AI member is saved, not only when it runs.

## Upgrading

Stop the server, take an export ({ch:data}), update the code, run `uv sync`, and start again. The database migrates on start.
