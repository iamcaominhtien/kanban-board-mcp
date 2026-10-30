# Code navigation

This repo has a CodeGraph index (symbols, calls, imports for the Python server and the TS/React UI), exposed as the `codegraph` MCP server (`.mcp.json`, `.vscode/mcp.json`).

- To find callers, callees, or the blast radius of a symbol, or to explore an unfamiliar area, use `codegraph_explore` before reading files or grepping.
- Several symbols share names (for example `_clean_title` exists in both `server/services/tickets.py` and `server/services/docs.py`); the results list each definition separately, so check the file before editing.
- If the MCP tool is not available, use the same index from the shell: `.claude/scripts/codegraph.sh run callers <symbol>` (also `callees`, `impact`, `query`, `node`, `context`).
- The index is local (`.codegraph/`, git-ignored) and is synced by `.claude/scripts/codegraph.sh`; the CLI version is pinned there.
