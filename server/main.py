from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from mcp.server.fastmcp import FastMCP


@asynccontextmanager
async def lifespan(app: FastAPI):
    from database import init_db

    await init_db()
    yield


app = FastAPI(title="Kanban Board MCP", lifespan=lifespan)

# origins: extend via CORS_ORIGINS env var for production
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

mcp = FastMCP("kanban-mcp", stateless_http=True, streamable_http_path="/")

app.mount("/mcp", mcp.streamable_http_app())


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
