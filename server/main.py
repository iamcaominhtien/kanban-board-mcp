import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from mcp.server.fastmcp import FastMCP

import events as board_events

import mcp_tools as _mcp_tools
from api.projects import router as projects_router
from api.tickets import router as tickets_router
from api.members import router as members_router
from database import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title="Kanban Board MCP", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=[
        "Content-Type",
        "Authorization",
        "Accept",
        "X-Requested-With",
        "Last-Event-ID",
    ],
)

mcp = FastMCP("kanban-mcp", stateless_http=True, streamable_http_path="/")

_mcp_tools.register(mcp)

app.mount("/mcp", mcp.streamable_http_app())

app.include_router(projects_router)
app.include_router(tickets_router)
app.include_router(members_router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/events")
async def sse_events() -> StreamingResponse:
    async def generator():
        q = board_events.subscribe()
        try:
            yield ": connected\n\n"
            while True:
                try:
                    event = await asyncio.wait_for(q.get(), timeout=30.0)
                    yield f"data: {event}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            board_events.unsubscribe(q)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# Static UI serving (used by packaged Electron builds)
# ---------------------------------------------------------------------------

_ui_dist_dir: Path | None = None


def _get_ui_dist() -> Path | None:
    global _ui_dist_dir
    if _ui_dist_dir is not None:
        return _ui_dist_dir

    env_val = os.environ.get("KANBAN_UI_DIST")
    if env_val:
        candidate = Path(env_val)
        if candidate.is_dir():
            _ui_dist_dir = candidate.resolve()
            return _ui_dist_dir

    candidate = Path(__file__).resolve().parent.parent / "ui" / "dist"
    if candidate.is_dir():
        _ui_dist_dir = candidate.resolve()
        return _ui_dist_dir

    return None


@app.get("/")
async def serve_root():
    dist = _get_ui_dist()
    if dist:
        index = dist / "index.html"
        if index.is_file():
            return FileResponse(index, media_type="text/html")
    raise HTTPException(status_code=404, detail="UI not built")


@app.get("/{full_path:path}")
async def serve_spa(full_path: str):
    dist = _get_ui_dist()
    if not dist:
        raise HTTPException(status_code=404, detail="UI not built")

    requested = (dist / full_path).resolve()
    if requested.is_file() and requested.is_relative_to(dist):
        return FileResponse(requested)

    index = dist / "index.html"
    if index.is_file():
        return FileResponse(index, media_type="text/html")

    raise HTTPException(status_code=404, detail="Not found")


if __name__ == "__main__":
    import multiprocessing

    multiprocessing.freeze_support()

    import socket
    import sys

    import uvicorn

    class SignalServer(uvicorn.Server):
        def __init__(self, config, port):
            super().__init__(config)
            self._signal_port = port

        async def startup(self, sockets=None):
            await super().startup(sockets)
            print(f"READY port={self._signal_port}", flush=True)
            sys.stdout.flush()

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]

        config = uvicorn.Config(app, host="127.0.0.1", log_level="warning")
        server = SignalServer(config, port)
        server.run(sockets=[sock])
