"""PNG pictures of what an AI drew (a diagram, a canvas frame, a local page), so it can look before it hands in (#267).

An AI that only has the board's MCP server cannot open a browser itself, and Playwright is often not set up. The
server draws the picture for it, in this order:

1. ``KANBAN_EXPORT_CMD`` (the desktop app's own executable, set by the app) started with ``--export-png``: the
   Chromium that Electron ships, nothing to install.
2. A Chrome / Chromium / Edge on the machine (``KANBAN_CHROME_PATH`` first), driven headless over DevTools.
3. Neither: a wireframe made without a browser (``canvas_png``), honest about being one.

A page is served from a throwaway HTTP server on 127.0.0.1 that only serves its own folder (no ``file://``, so the page
cannot read other files of the machine), and the hidden browser may load only that server and public http(s) hosts
(fonts and CDN libraries), never another port of this machine or the private network.
"""

import asyncio
import base64
import functools
import ipaddress
import json
import logging
import os
import shutil
import tempfile
import threading
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from services import diagram_export

logger = logging.getLogger(__name__)

TIMEOUT = 45.0
MAX_HEIGHT = 8000
MAX_WIDTH = 4000
# fonts and late scripts get this long after the load event before the picture is taken
SETTLE_SECONDS = 0.8


class _OneFolder(SimpleHTTPRequestHandler):
    """Serves one folder and nothing outside it (a link that leads out is refused), quietly."""

    def translate_path(self, path: str) -> str:
        """The file for a URL path, or a path that does not exist when it would leave the folder."""
        full = super().translate_path(path)
        root = os.path.realpath(self.directory)
        real = os.path.realpath(full)
        if real != root and not real.startswith(root + os.sep):
            return os.path.join(root, "__outside__")
        return full

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        """Say nothing: these requests are the hidden browser's own."""


class _Serve:
    """A throwaway HTTP server on 127.0.0.1 for one folder (a context manager)."""

    def __init__(self, folder: Path) -> None:
        """Serve ``folder``."""
        handler = functools.partial(_OneFolder, directory=str(folder))
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.origin = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self) -> "_Serve":
        """Start serving."""
        self.thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        """Stop serving."""
        self.httpd.shutdown()
        self.httpd.server_close()


def allowed(url: str, origin: str) -> bool:
    """Whether the hidden browser may load ``url``: the page's own server, inline data, and public http(s) hosts."""
    if url.startswith(("data:", "blob:", "about:")):
        return True
    parts = urllib.parse.urlsplit(url)
    if f"{parts.scheme}://{parts.netloc}" == origin:
        return True
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return False
    host = parts.hostname
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        return False
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return True  # a public name; what it resolves to is the browser's business, as for a person's browser
    return ip.is_global


class _Filter(diagram_export._Cdp):  # noqa: SLF001
    """The DevTools connection, with the request filter of ``allowed``."""

    def __init__(self, ws: Any, origin: str) -> None:
        """Connect over ``ws``; only what ``allowed`` lets through loads."""
        super().__init__(ws, origin)

    async def _read(self) -> None:
        """Answer paused requests by ``allowed``; everything else as the base class does."""
        try:
            async for raw in self.ws:
                msg = json.loads(raw)
                if msg.get("method") == "Fetch.requestPaused":
                    params = msg["params"]
                    ok = allowed(params["request"]["url"], self.editor)
                    args: dict[str, Any] = {"requestId": params["requestId"]}
                    if not ok:
                        args["errorReason"] = "BlockedByClient"
                        self.blocked.append(params["request"]["url"])
                    reply = asyncio.ensure_future(
                        self.call(
                            "Fetch.continueRequest" if ok else "Fetch.failRequest",
                            args,
                            msg.get("sessionId"),
                        )
                    )
                    self.replies.add(reply)
                    reply.add_done_callback(self.replies.discard)
                    continue
                self._dispatch(msg)
        except Exception:  # the socket closed; whoever waits will time out
            logger.debug("devtools reader stopped", exc_info=True)

    def _dispatch(self, msg: dict) -> None:
        if "id" in msg:
            fut = self.pending.pop(msg["id"], None)
            if fut and not fut.done():
                if "error" in msg:
                    fut.set_exception(
                        RuntimeError(msg["error"].get("message", "devtools error"))
                    )
                else:
                    fut.set_result(msg.get("result", {}))
            return
        for pair in list(self.waiters):
            if pair[0] == msg.get("method") and not pair[1].done():
                pair[1].set_result(msg.get("params", {}))
                self.waiters.remove(pair)


async def _with_chrome(
    chrome: str, url: str, origin: str, width: int, height: int | None
) -> bytes:
    import websockets  # a dependency of the server already; imported late to keep start-up light

    profile = tempfile.mkdtemp(prefix="kanban-shot-")
    args = [
        chrome,
        "--headless=new",
        "--remote-debugging-port=0",
        f"--user-data-dir={profile}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--hide-scrollbars",
        "--mute-audio",
        "about:blank",
    ]
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        args.insert(1, "--no-sandbox")
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE
    )
    cdp: _Filter | None = None
    try:

        async def endpoint() -> str:
            assert proc.stderr is not None
            while True:
                line = (await proc.stderr.readline()).decode("utf-8", "ignore")
                if not line:
                    raise RuntimeError("the browser exited before it was ready")
                if "DevTools listening on" in line:
                    return line.split("listening on", 1)[1].strip()

        ws_url = await asyncio.wait_for(endpoint(), 20)
        async with websockets.connect(ws_url, max_size=128 * 1024 * 1024) as ws:
            cdp = _Filter(ws, origin)
            target = (await cdp.call("Target.createTarget", {"url": "about:blank"}))[
                "targetId"
            ]
            session = (
                await cdp.call(
                    "Target.attachToTarget", {"targetId": target, "flatten": True}
                )
            )["sessionId"]
            await cdp.call("Page.enable", {}, session)
            await cdp.call("Fetch.enable", {"patterns": [{"urlPattern": "*"}]}, session)
            view = {"deviceScaleFactor": 1, "mobile": width <= 500}
            await cdp.call(
                "Emulation.setDeviceMetricsOverride",
                {**view, "width": width, "height": height or 800},
                session,
            )
            loaded = cdp.wait_for("Page.loadEventFired")
            await cdp.call("Page.navigate", {"url": url}, session)
            await asyncio.wait_for(loaded, 30)
            await cdp.call(
                "Runtime.evaluate",
                {
                    "expression": "document.fonts ? document.fonts.ready.then(() => 1) : 1",
                    "awaitPromise": True,
                },
                session,
            )
            await asyncio.sleep(SETTLE_SECONDS)
            if height is None:
                measured = await cdp.call(
                    "Runtime.evaluate",
                    {
                        "expression": "Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)",
                        "returnByValue": True,
                    },
                    session,
                )
                height = int((measured.get("result") or {}).get("value") or 800)
                height = max(100, min(MAX_HEIGHT, height))
                await cdp.call(
                    "Emulation.setDeviceMetricsOverride",
                    {**view, "width": width, "height": height},
                    session,
                )
                await asyncio.sleep(0.2)
            shot = await cdp.call(
                "Page.captureScreenshot",
                {
                    "format": "png",
                    "clip": {
                        "x": 0,
                        "y": 0,
                        "width": width,
                        "height": height,
                        "scale": 1,
                    },
                },
                session,
            )
            return base64.b64decode(shot["data"])
    finally:
        if cdp:
            cdp.reader.cancel()
        if proc.returncode is None:
            proc.kill()
        await proc.wait()
        shutil.rmtree(profile, ignore_errors=True)


async def _with_command(
    command: list[str], url: str, width: int, height: int | None
) -> bytes:
    with tempfile.TemporaryDirectory(prefix="kanban-shot-") as tmp:
        out = Path(tmp) / "out.png"
        args = [*command, "--export-png", url, str(out), "--width", str(width)]
        if height:
            args += ["--height", str(height)]
        proc = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE
        )
        try:
            _, err = await asyncio.wait_for(proc.communicate(), TIMEOUT + 15)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise RuntimeError("the export command timed out") from None
        if proc.returncode != 0 or not out.is_file():
            raise RuntimeError(
                f"the export command failed ({proc.returncode}): {diagram_export._why(err)}"  # noqa: SLF001
            )
        return out.read_bytes()


def available() -> str | None:
    """What would draw a real picture on this machine: ``"desktop"``, ``"browser"`` or None."""
    if diagram_export._command():  # noqa: SLF001
        return "desktop"
    return "browser" if diagram_export.find_chrome() else None


async def page_png(
    folder: Path, entry: str, width: int, height: int | None = None
) -> bytes | None:
    """A screenshot of ``folder/entry`` drawn at ``width`` (and ``height``; None: the whole page, up to 8000 px), or
    None when no browser is available or it failed."""
    width = max(200, min(MAX_WIDTH, int(width)))
    if height is not None:
        height = max(100, min(MAX_HEIGHT, int(height)))
    command = diagram_export._command()  # noqa: SLF001
    chrome = None if command else diagram_export.find_chrome()
    if not (command or chrome):
        return None
    try:
        with _Serve(folder) as served:
            url = f"{served.origin}/{urllib.parse.quote(entry)}"
            if command:
                return await asyncio.wait_for(
                    _with_command(command, url, width, height), TIMEOUT + 20
                )
            return await asyncio.wait_for(
                _with_chrome(chrome, url, served.origin, width, height), TIMEOUT
            )
    except Exception as e:  # a picture that cannot be drawn never fails the call; the caller falls back
        logger.warning("screenshot failed: %s", e)
    return None


async def svg_png(svg: str, width: int | None = None) -> bytes | None:
    """A PNG of an SVG drawing at its own size (or ``width``), on white, or None without a browser."""
    with tempfile.TemporaryDirectory(prefix="kanban-svg-") as tmp:
        w, h = _svg_size(svg)
        if width:
            h, w = int(h * width / max(w, 1)), width
        # the viewport line matters: a drawing under 500 px is drawn as a phone would, and without it a phone lays the
        # page out 980 px wide, so a live run saw only the top left corner of its diagram, twice as large (#267)
        page = (
            "<!doctype html><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'>"
            "<style>html,body{margin:0;background:#fff}"
            "img{display:block;width:100%;height:auto}</style>"
            "<img src='drawing.svg' alt=''>"
        )
        Path(tmp, "drawing.svg").write_text(svg, encoding="utf-8")
        Path(tmp, "index.html").write_text(page, encoding="utf-8")
        return await page_png(Path(tmp), "index.html", w, h)


def _svg_size(svg: str) -> tuple[int, int]:
    """The drawn size of an SVG from its width/height or viewBox (draw.io writes both), else 800 x 600."""
    import re

    head = svg[:2000]

    def num(name: str) -> float | None:
        m = re.search(rf'\b{name}="([\d.]+)(px)?"', head)
        return float(m.group(1)) if m else None

    w, h = num("width"), num("height")
    if not (w and h):
        m = re.search(r'viewBox="[\d.\-]+ [\d.\-]+ ([\d.]+) ([\d.]+)"', head)
        if m:
            w, h = float(m.group(1)), float(m.group(2))
    w, h = w or 800, h or 600
    return max(1, int(round(w))), max(1, int(round(h)))
