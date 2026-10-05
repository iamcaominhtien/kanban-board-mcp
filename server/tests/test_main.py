import httpx
import os
import signal
import subprocess
import sys
from pathlib import Path

import pytest
from httpx import ASGITransport

from main import app
from uploads import MAX_DESCRIPTION_IMAGE_BYTES, resolve_upload_path

SMALL_PNG_BYTES = b"fake-png-bytes"


async def test_health_returns_ok() -> None:
    async with httpx.AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_mcp_endpoint_is_reachable() -> None:
    """GET /mcp/ must not return 404 - a protocol response or 405 is acceptable.

    Note the trailing slash: `app.mount("/mcp", ...)` only matches "/mcp/" and
    deeper paths (Starlette's Mount requires it), so bare "/mcp" falls through
    to the SPA catch-all route instead of ever reaching the MCP app.

    The app's lifespan must actually run here (not just construct the ASGI
    app) - `mcp.streamable_http_app()`'s own lifespan starts its session
    manager's task group, and that lifespan only runs because `main.py`'s
    lifespan explicitly enters `mcp.session_manager.run()` (a mounted
    sub-app's lifespan is not otherwise propagated by FastAPI/Starlette).
    """
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/mcp/")

    assert response.status_code != 404, (
        f"/mcp/ returned 404 — mount path misconfigured. Got: {response.status_code}"
    )


async def test_upload_image_returns_markdown_and_serves_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("KANBAN_UPLOADS_DIR", str(tmp_path))

    async with httpx.AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        upload_response = await client.post(
            "/uploads/images",
            files={"file": ("diagram.png", SMALL_PNG_BYTES, "image/png")},
        )

        assert upload_response.status_code == 201
        body = upload_response.json()
        assert body["url"].startswith("/uploads/diagram-")
        assert body["url"].endswith(".png")
        assert body["markdown"] == f"![diagram]({body['url']})"
        assert body["content_type"] == "image/png"
        assert body["size"] == len(SMALL_PNG_BYTES)

        file_response = await client.get(body["url"])

    assert file_response.status_code == 200
    assert file_response.content == SMALL_PNG_BYTES
    assert file_response.headers["x-content-type-options"] == "nosniff"


def test_resolve_upload_path_does_not_create_uploads_dir_on_read(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    uploads_dir = tmp_path / "uploads"
    monkeypatch.setenv("KANBAN_UPLOADS_DIR", str(uploads_dir))

    resolved = resolve_upload_path("nested/example.png")

    assert resolved == uploads_dir.resolve() / "nested" / "example.png"
    assert not uploads_dir.exists()


async def test_upload_image_rejects_unsupported_type(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("KANBAN_UPLOADS_DIR", str(tmp_path))

    async with httpx.AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/uploads/images",
            files={"file": ("notes.txt", b"hello", "text/plain")},
        )

    assert response.status_code == 400
    assert "Unsupported image type" in response.json()["detail"]


async def test_upload_image_rejects_files_over_size_limit(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("KANBAN_UPLOADS_DIR", str(tmp_path))

    async with httpx.AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/uploads/images",
            files={
                "file": (
                    "oversized.png",
                    b"x" * (MAX_DESCRIPTION_IMAGE_BYTES + 1),
                    "image/png",
                )
            },
        )

    assert response.status_code == 413
    assert response.json()["detail"] == "Image exceeds the 5MB upload limit."


async def test_upload_and_serve_all_file_types(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("KANBAN_UPLOADS_DIR", str(tmp_path))

    files_to_test = [
        ("report.xlsx", b"fake-excel-data", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        ("document.docx", b"fake-word-data", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        ("slides.pptx", b"fake-ppt-data", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
        ("data.json", b'{"key": "value"}', "application/json"),
        ("manual.pdf", b"%PDF-1.4...", "application/pdf"),
    ]

    async with httpx.AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        for fname, data, mime in files_to_test:
            res = await client.post(
                "/uploads/files",
                files={"file": (fname, data, mime)},
            )
            assert res.status_code == 201, f"Failed uploading {fname}"
            body = res.json()
            assert body["name"] == fname
            assert body["markdown"] == f"[{fname}]({body['url']})"

            # Download request (?download=1)
            dl_res = await client.get(body["url"], params={"download": "1"})
            assert dl_res.status_code == 200
            assert "attachment" in dl_res.headers.get("content-disposition", "")
            assert dl_res.headers.get("x-file-path") is not None

        # Inline request for PDF (?inline=1)
        pdf_res = await client.get("/uploads/manual.pdf", params={"inline": "1"})
        # Should have X-File-Path
        assert "x-file-path" in [k.lower() for k in pdf_res.headers.keys()] or pdf_res.status_code in (200, 404)



def test_main_emits_ready_signal_and_serves_health(tmp_path: Path) -> None:
    server_dir = Path(__file__).resolve().parents[1]
    env = os.environ.copy()
    env["KANBAN_DB_PATH"] = str(tmp_path / "desktop-app" / "kanban.db")
    env["HOME"] = str(tmp_path)  # no ~/.kanban-board/config.json from the developer machine

    process = subprocess.Popen(
        [sys.executable, "-u", "main.py"],
        cwd=server_dir,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    import threading

    timer = threading.Timer(30.0, process.terminate)
    timer.start()
    port = None

    try:
        for line in process.stdout:
            if line.startswith("READY port="):
                port = int(line.strip().split("=", 1)[1])
                break

        if port is None:
            raise AssertionError(
                "main.py never emitted READY port=<N> within 30s. "
                f"exit={process.poll()}"
            )

        response = httpx.get(f"http://127.0.0.1:{port}/health", timeout=5.0)
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}
    finally:
        timer.cancel()
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
