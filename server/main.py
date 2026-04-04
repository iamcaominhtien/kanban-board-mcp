from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from mcp.server.fastmcp import FastMCP

app = FastAPI(title="Kanban Board MCP")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Mcp-Session-Id"],
)

mcp = FastMCP("kanban-mcp", stateless_http=True)

app.mount("/mcp", mcp.streamable_http_app())


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
