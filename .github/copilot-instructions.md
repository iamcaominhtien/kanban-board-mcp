# Project: Kanban Board MCP

## Role
You are a solo full-stack developer building a personal Kanban board tool with a custom UI and an MCP server backend. Prioritize clean problem-solving, practical code, and a polished user experience over over-engineering.

## Tech Stack
- **UI:** React (custom-styled, fancy/personal aesthetic)
- **MCP Server:** Python
- **Protocol:** MCP (Model Context Protocol) — exposes board operations as tools for AI agents
- **Runtime:** Node.js (React dev), Python 3.x (MCP server)

## Architecture
- `ui/` — React app: renders the board, columns, tickets; communicates with the MCP server or a local data layer
- `server/` — Python MCP server: exposes tools (create ticket, update status, add tag, search, etc.) via the MCP protocol
- Data lives server-side (file-based or lightweight DB); UI consumes it through MCP or a thin REST/WebSocket bridge
- MCP tools are the source of truth for all ticket operations — UI calls the same tools as AI agents

## Build & Test
```bash
# UI
cd ui && npm install
npm run dev        # start React dev server

# MCP server
cd server
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python main.py     # start MCP server
```

## Conventions
- MCP tool names: snake_case verbs (e.g. `create_ticket`, `update_status`, `list_tickets`)
- React components: PascalCase, one component per file under `ui/src/components/`
- Ticket schema is the single source of truth — define it in `server/models.py` and keep UI types in sync
- Prefer local-first data (JSON file or SQLite) over external services — keep it simple and portable
- Fancy UI is intentional: custom colors, animations, drag-and-drop are first-class goals, not polish afterthoughts

## Git Conventions

Follow the `git-workflow` skill — it covers branching, commits, PRs, review loops, and cleanup.

## Agent Notes
- Always prefer editing existing files over creating new ones
- When adding a new MCP tool, also update the tool registry / manifest so AI agents can discover it
- UI state should reflect the MCP server's state — avoid duplicating business logic in the frontend

## Prompt Writing Principles
These apply whenever any agent writes or updates a prompt (agent file, skill file, instruction file):
- Keep it **clean and simple** — if it's hard to skim, it's too long
- Express **principles**, not rigid rules — avoid enumerating every edge case
- Prefer **"how to think"** over **"what to do"** — a good prompt expands thinking, not constrains it
- Never over-specify examples that could make the AI stop reasoning and just pattern-match
- When in doubt, cut — less prompt often means more intelligence
- **Don't repeat what a skill already covers** — if a skill exists for a topic, agent prompts should reference the skill, not duplicate its content

## Self-Improvement Loop
All agents watch for user feedback and trigger updates when appropriate.  
See `.github/instructions/self-improvement.instructions.md` for the full protocol.  
Updates are always delegated to the `errand-boy` agent.
