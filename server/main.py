import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from mcp.server.fastmcp import FastMCP

import events as board_events

import kanban_mcp
from api.projects import router as projects_router
from api.tickets import router as tickets_router
from api.members import router as members_router
from api.settings import router as settings_router
from api.data import router as data_router
from api.idea_tickets import router as idea_tickets_router
from api.workspace import router as workspace_router
from api.docs import docs_error_handler, router as docs_router
from services.docs_text import DocsError
import database
from version import version_info
from database import init_db
from services import activity as svc_activity
from services import workspace as svc_workspace
from uploads import (
    MIME_BY_EXTENSION,
    SUPPORTED_IMAGE_EXTENSIONS,
    VIEWABLE_INLINE_EXTENSIONS,
    resolve_upload_path,
)


mcp = FastMCP(
    "kanban-mcp",
    instructions=kanban_mcp.MCP_INSTRUCTIONS,
    stateless_http=True,
    streamable_http_path="/",
)

kanban_mcp.register(mcp)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # `mcp.streamable_http_app()` (mounted below) carries its own lifespan that
    # starts its session manager's task group, but FastAPI/Starlette does not
    # propagate a mounted sub-app's lifespan from the parent's `Mount` - so it
    # must be started explicitly here, or every /mcp request raises
    # "RuntimeError: Task group is not initialized. Make sure to use run()."
    """Run the MCP session manager, DB init and background sweeper for the app's lifetime."""
    async with mcp.session_manager.run():
        await init_db()
        sweeper = asyncio.create_task(
            svc_workspace.sweep_loop(lambda: database.async_session())
        )
        try:
            yield
        finally:
            sweeper.cancel()
            try:
                await sweeper
            except asyncio.CancelledError:
                pass


app = FastAPI(title="Kanban Board MCP", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "*"
    ],  # Wildcard is safe: the server binds to 127.0.0.1 (loopback only), so it is not reachable from external networks.
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    expose_headers=["x-request-id"],
    allow_headers=[
        "Content-Type",
        "Authorization",
        "Accept",
        "X-Requested-With",
        "Last-Event-ID",
        "X-Request-Id",
    ],
)


@app.middleware("http")
async def record_activity_actor(request: Request, call_next):
    """Attribute REST calls to the board user, or to `X-Actor` when the header is sent.

    Args:
        request: Incoming request.
        call_next: Next handler in the middleware chain.

    Returns:
        The downstream response.
    """
    header = (request.headers.get("x-actor") or "").strip()[:80]
    token = svc_activity.set_actor(header or svc_activity.HUMAN_ACTOR)
    try:
        return await call_next(request)
    finally:
        svc_activity.reset_actor(token)


app.mount("/mcp", mcp.streamable_http_app())

app.include_router(projects_router)
app.include_router(tickets_router)
app.include_router(members_router)
app.include_router(settings_router)
app.include_router(data_router)
app.include_router(idea_tickets_router)
app.include_router(workspace_router)
app.include_router(docs_router)
app.add_exception_handler(DocsError, docs_error_handler)


@app.get("/health")
async def health() -> dict[str, str]:
    """Report liveness."""
    return {"status": "ok"}


@app.get("/version")
async def version() -> dict[str, str]:
    """Server version and the oldest UI build it supports (no auth, like /health)."""
    return version_info()


@app.get("/uploads/{file_path:path}")
async def serve_upload(
    file_path: str,
    name: str | None = None,
    download: bool = False,
    inline: bool = False,
    view: bool = False,
):
    """Serve an uploaded file inline (images, viewable types) or as a download.

    Args:
        file_path: Path inside the uploads folder.
        name: File name to suggest for a download.
        download: Force a download.
        inline: Show viewable types in the browser.
        view: Alias of `inline`.

    Raises:
        HTTPException: 400 for an invalid path; 404 if the file does not exist.
    """
    resolved = resolve_upload_path(file_path)
    if resolved is None:
        raise HTTPException(status_code=400, detail="Invalid path")
    if not resolved.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    headers = {
        "X-Content-Type-Options": "nosniff",
        "X-File-Path": str(resolved.resolve()),
        "Access-Control-Expose-Headers": "X-File-Path, Content-Disposition",
    }
    ext = resolved.suffix.lower()
    media_type = MIME_BY_EXTENSION.get(ext, "application/octet-stream")

    download_name = Path((name or "").replace("\\", "/")).name
    download_name = (
        "".join(ch for ch in download_name if ch.isprintable())[:200] or resolved.name
    )

    is_image = ext in SUPPORTED_IMAGE_EXTENSIONS
    wants_inline = (
        (inline or view) and ext in VIEWABLE_INLINE_EXTENSIONS and ext != ".html"
    )

    if not download and (is_image or wants_inline):
        return FileResponse(
            resolved,
            media_type=media_type,
            headers=headers,
        )

    return FileResponse(
        resolved,
        media_type="application/octet-stream",
        filename=download_name,
        headers=headers,
        content_disposition_type="attachment",
    )


@app.get("/events")
async def sse_events() -> StreamingResponse:
    """Stream board events to the client as Server-Sent Events."""

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
    """Serve the built UI's index page.

    Raises:
        HTTPException: 404 if the UI is not built.
    """
    dist = _get_ui_dist()
    if dist:
        index = dist / "index.html"
        if index.is_file():
            return FileResponse(index, media_type="text/html")
    raise HTTPException(status_code=404, detail="UI not built")


@app.get("/{full_path:path}")
async def serve_spa(full_path: str):
    """Serve a built UI asset, falling back to the SPA index for client routes.

    Args:
        full_path: Requested path.

    Raises:
        HTTPException: 400 for an invalid path; 404 if the UI is not built or the path is reserved.
    """
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
        """Uvicorn server that prints a READY line once it is listening."""

        async def startup(self, sockets=None):
            """Start up, then tell the parent process the port is ready."""
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
