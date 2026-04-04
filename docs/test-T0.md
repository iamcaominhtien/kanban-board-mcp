---
title: "Test Plan: Kanban Board MCP Server (T0)"
type: test
status: draft
version: 1.0.0
created: 2026-04-04
updated: 2026-04-04
authors: [qc-agent]
related: []
---

# Test Plan: Kanban Board MCP Server (T0)

## Scope
Testing the basic health and MCP endpoints of the Kanban Board Python backend server (Ticket T0).

## Test Cases

| ID | Category | Description | Steps | Expected | Status |
|---|---|---|---|---|---|
| TC-001 | Happy Path | Verify `/health` endpoint | `curl http://localhost:8000/health` | HTTP 200, body `{"status": "ok"}` | ✅ Pass |
| TC-002 | Happy Path | Verify `/docs` endpoint | `curl http://localhost:8000/docs` | HTTP 200 (FastAPI docs) | ✅ Pass |
| TC-003 | Happy Path | Verify `/mcp` GET | `curl http://localhost:8000/mcp` | Endpoint exists (e.g., handles SSE or 405 Method Not Allowed/426 Upgrade Required, but not 404) | ❌ Fail |
| TC-004 | Boundary | Verify `/mcp` POST | `curl -X POST http://localhost:8000/mcp` | Endpoint exists (e.g., returns JSON-RPC failure or 405/422, but not 404) | ❌ Fail |

## Bug Log
| Bug ID | TC | Description | Severity | Ticket |
|---|---|---|---|---|
| TBD | TC-003, TC-004 | `/mcp` and `/mcp/` endpoints return 404 Not Found | High | T0 |
