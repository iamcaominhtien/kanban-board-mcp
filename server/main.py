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
from api.settings import router as settings_router
from api.data import router as data_router
from api.idea_tickets import router as idea_tickets_router
from database import init_db
from uploads import resolve_upload_path


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title="Kanban Board MCP", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "*"
    ],  # Wildcard is safe: the server binds to 127.0.0.1 (loopback only), so it is not reachable from external networks.
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
app.include_router(settings_router)
app.include_router(data_router)
app.include_router(idea_tickets_router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/uploads/{file_path:path}")
async def serve_upload(file_path: str):
    resolved = resolve_upload_path(file_path)
    if resolved is None:
        raise HTTPException(status_code=400, detail="Invalid path")
    if not resolved.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(
        resolved,
        headers={"X-Content-Type-Options": "nosniff"},
    )


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

    # Canonicalize and enforce that requested path stays within the UI dist directory
    dist_resolved = dist.resolve()

    path_obj = Path(full_path)
    if path_obj.is_absolute():
        raise HTTPException(status_code=400, detail="Invalid path")

    safe_parts = [part for part in path_obj.parts if part not in ("", ".")]
    if any(part == ".." for part in safe_parts):
        raise HTTPException(status_code=400, detail="Invalid path")

    requested = dist_resolved.joinpath(*safe_parts).resolve()

    try:
        requested.relative_to(dist_resolved)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid path")

    if requested.is_file():
        return FileResponse(requested)

    index = dist / "index.html"
    if index.is_file():
        return FileResponse(index, media_type="text/html")

    raise HTTPException(status_code=404, detail="Not found")


if __name__ == "__main__":
    import multiprocessing
    import time as _time

    _t0 = _time.monotonic()

    def _startup_mark(stage: str) -> None:
        elapsed_ms = int((_time.monotonic() - _t0) * 1000)
        print(f"[startup] {stage} +{elapsed_ms}ms", flush=True)

    multiprocessing.freeze_support()
    _startup_mark("freeze-support-done")

    import socket

    import uvicorn

    _startup_mark("uvicorn-imported")

    class SignalServer(uvicorn.Server):
        async def startup(self, sockets=None):
            await super().startup(sockets)
            _startup_mark("uvicorn-startup-done")
            print(f"READY port={self.config.port}", flush=True)

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        _startup_mark(f"socket-bound-port={port}")

        config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
        server = SignalServer(config)
        server.run(sockets=[sock])
