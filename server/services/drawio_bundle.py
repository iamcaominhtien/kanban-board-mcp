"""The draw.io editor shipped with the desktop app, served by the board at ``/drawio``.

The desktop app ships the static draw.io web app (``desktop/scripts/fetch-drawio.sh``, Apache 2.0) and tells the server
where it is with ``KANBAN_DRAWIO_DIR``; a checkout finds ``dist-drawio/`` at the repository root once the script ran.
Served from the board's own address, the editor needs no service of its own and nothing leaves the computer: before
this, the default editor was a self-hosted one at http://localhost:8080 that nobody had started.
"""

from __future__ import annotations

import os
from pathlib import Path

ENV = "KANBAN_DRAWIO_DIR"
PATH = "/drawio"
_LOCAL_HOSTS = ("127.0.0.1", "localhost", "::1")

_origin: str | None = None


def directory() -> Path | None:
    """The folder of the shipped editor (it holds ``index.html``), or None when this install has none."""
    env = os.environ.get(ENV, "").strip()
    candidates = (
        [Path(env)]
        if env
        else [Path(__file__).resolve().parent.parent.parent / "dist-drawio"]
    )
    for candidate in candidates:
        if (candidate / "index.html").is_file():
            return candidate.resolve()
    return None


def available() -> bool:
    """Whether this install ships the editor."""
    return directory() is not None


def version() -> str | None:
    """The shipped draw.io version (``VERSION`` written by the fetch script)."""
    folder = directory()
    if folder is None:
        return None
    try:
        return (folder / "VERSION").read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def set_origin(host: str, port: int | str) -> None:
    """Remember the board's own local address (learned at startup and from requests), for the server's own uses of
    the editor (the exact diagram preview)."""
    global _origin
    if host in _LOCAL_HOSTS:
        _origin = f"http://127.0.0.1:{port}"


def url(origin: str | None = None) -> str | None:
    """The editor's address: on ``origin`` (a request's base URL) or on the board's own local address."""
    base = (origin or _origin or "").rstrip("/")
    return f"{base}{PATH}" if base else None
