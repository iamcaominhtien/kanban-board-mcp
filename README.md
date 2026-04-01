# Kanban Board MCP

A personal Kanban board tool featuring a custom React UI and a Python-based MCP (Model Context Protocol) server backend for AI agent integration.

## Architecture

The project is split into two main components:
- **`ui/`**: A React 18 frontend built with Vite and TypeScript, featuring a Bento Grid-inspired design.
- **`server/`**: A Python MCP server that exposes board operations (searching, creating, updating tickets) as tools for AI agents.

## Tech Stack

| Component | Technologies |
|---|---|
| **Frontend** | React 18, Vite, TypeScript, Tailwind CSS, @dnd-kit |
| **Backend** | Python 3.x, MCP (Model Context Protocol) |
| **Storage** | Local-first (File-based / SQLite) |

## Quick Start

### UI (Frontend)
```bash
cd ui
npm install
npm run dev        # Starts React dev server on http://localhost:5173
```

### MCP Server (Backend)
```bash
cd server
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
pip install -r requirements.txt
python main.py
```

## Detailed Documentation
- [UI Readme](ui/README.md)
- [Server Readme](server/README.md)
