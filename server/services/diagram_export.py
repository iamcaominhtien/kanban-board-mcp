"""Exact SVG previews for diagrams, made by the draw.io editor itself in a hidden browser.

When a diagram is saved without a browser (an AI agent through MCP) the server has nobody to ask the editor for the
picture. This module opens the editor in a headless browser, loads the drawing, and asks it to export an SVG: the same
renderer a person gets when they save, so the picture is the same as in draw.io.

Two ways to get a hidden browser, tried in this order:

1. ``KANBAN_EXPORT_CMD`` (a JSON list, set by the desktop app): the desktop app's own executable, started with
   ``--export-svg``. It uses the Chromium that Electron already ships, so nothing extra is installed.
2. A Chrome / Chromium / Edge found on the machine (or ``KANBAN_CHROME_PATH``), driven over the DevTools protocol.

Anything that goes wrong returns ``None`` and the caller keeps the plain preview. Only the editor's own origin may be
loaded, and nothing is exported when the editor is the public diagrams.net unless the admin switches it on, because the
drawing would be sent out without anybody asking.
"""

import asyncio
import base64
import json
import logging
import os
import shutil
import sys
import tempfile
import urllib.parse
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

EXPORT_TIMEOUT = 60.0
EXPORT_CMD_ENV = "KANBAN_EXPORT_CMD"
CHROME_ENV = "KANBAN_CHROME_PATH"
SWITCH_ENV = "KANBAN_DIAGRAM_EXPORT"  # "off" turns it off, "public" also allows the public editor

# The editor's embed protocol, driven from a page on the editor's own origin: the drawing is loaded into a frame, then
# exported. A frame is needed because the editor only talks to a parent window. Same code runs in Electron.
PAGE_SCRIPT = """
(xml, editorUrl, timeoutMs) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('the editor did not answer')), timeoutMs);
  const frame = document.createElement('iframe');
  frame.style.cssText = 'width:1400px;height:900px;border:0';
  const send = (m) => frame.contentWindow.postMessage(JSON.stringify(m), '*');
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || typeof e.data !== 'string') return;
    let m; try { m = JSON.parse(e.data); } catch (_) { return; }
    if (m.event === 'init') send({ action: 'load', xml });
    else if (m.event === 'load') send({ action: 'export', format: 'svg' });
    else if (m.event === 'export') { clearTimeout(timer); resolve(m.data); }
  });
  frame.src = editorUrl + '/?embed=1&proto=json&spin=0&ui=min&noSaveBtn=1&noExitBtn=1&libraries=0&lang=en';
  document.body.appendChild(frame);
})
"""


def enabled(mode: str) -> bool:
    """Whether exact previews may be made for this editor mode (``self-hosted`` or ``public``)."""
    switch = os.environ.get(SWITCH_ENV, "").strip().lower()
    if switch in ("off", "0", "false", "no"):
        return False
    return mode != "public" or switch == "public"


def _decode(data: str) -> str:
    """The text of the editor's ``data:image/svg+xml`` answer."""
    head, _, body = data.partition(",")
    if ";base64" in head:
        return base64.b64decode(body).decode("utf-8")
    return urllib.parse.unquote(body)


def find_chrome() -> str | None:
    """A Chrome, Chromium or Edge to drive: ``KANBAN_CHROME_PATH`` first, then the usual places."""
    given = os.environ.get(CHROME_ENV, "").strip()
    if given:
        return given if Path(given).is_file() else None
    names = (
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "chrome",
        "msedge",
        "microsoft-edge",
    )
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    candidates: list[str] = []
    if sys.platform == "darwin":
        candidates = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
    elif sys.platform == "win32":
        roots = [
            os.environ.get(k, "")
            for k in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")
        ]
        for root in filter(None, roots):
            candidates += [
                str(Path(root) / "Google" / "Chrome" / "Application" / "chrome.exe"),
                str(Path(root) / "Microsoft" / "Edge" / "Application" / "msedge.exe"),
            ]
    return next((c for c in candidates if Path(c).is_file()), None)


def _same_origin(url: str, editor: str) -> bool:
    if url.startswith(("data:", "blob:", "about:")):
        return True
    a, b = urllib.parse.urlsplit(url), urllib.parse.urlsplit(editor)
    return (a.scheme, a.netloc) == (b.scheme, b.netloc)


# --- a hidden Chrome over the DevTools protocol ---------------------------------------------------


class _Cdp:
    """Just enough of the DevTools protocol over one websocket: commands, events, and a request filter."""

    def __init__(self, ws: Any, editor: str) -> None:
        self.ws, self.editor = ws, editor
        self.next_id = 0
        self.pending: dict[int, asyncio.Future] = {}
        self.waiters: list[tuple[str, asyncio.Future]] = []
        self.blocked: list[str] = []
        self.reader = asyncio.ensure_future(self._read())

    async def _read(self) -> None:
        try:
            async for raw in self.ws:
                msg = json.loads(raw)
                if "id" in msg:
                    fut = self.pending.pop(msg["id"], None)
                    if fut and not fut.done():
                        if "error" in msg:
                            fut.set_exception(
                                RuntimeError(
                                    msg["error"].get("message", "devtools error")
                                )
                            )
                        else:
                            fut.set_result(msg.get("result", {}))
                    continue
                method, params = msg.get("method"), msg.get("params", {})
                if (
                    method == "Fetch.requestPaused"
                ):  # only the editor's own origin may load
                    url = params["request"]["url"]
                    verb = (
                        "continueRequest"
                        if _same_origin(url, self.editor)
                        else "failRequest"
                    )
                    args: dict[str, Any] = {"requestId": params["requestId"]}
                    if verb == "failRequest":
                        args["errorReason"] = "BlockedByClient"
                        self.blocked.append(url)
                    asyncio.ensure_future(
                        self.call(f"Fetch.{verb}", args, msg.get("sessionId"))
                    )
                for pair in list(self.waiters):
                    if pair[0] == method and not pair[1].done():
                        pair[1].set_result(params)
                        self.waiters.remove(pair)
        except Exception:  # the socket closed; whoever waits will time out
            logger.debug("devtools reader stopped", exc_info=True)

    async def call(
        self, method: str, params: dict | None = None, session: str | None = None
    ) -> dict:
        self.next_id += 1
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self.pending[self.next_id] = fut
        msg: dict[str, Any] = {
            "id": self.next_id,
            "method": method,
            "params": params or {},
        }
        if session:
            msg["sessionId"] = session
        await self.ws.send(json.dumps(msg))
        return await fut

    def wait_for(self, method: str) -> asyncio.Future:
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self.waiters.append((method, fut))
        return fut


async def _export_with_chrome(
    chrome: str, source: str, editor: str, timeout: float
) -> str:
    import websockets  # a dependency of the server already (uvicorn[standard]); imported late to keep start-up light

    profile = tempfile.mkdtemp(prefix="kanban-export-")
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
        "--mute-audio",
        "about:blank",
    ]
    if (
        hasattr(os, "geteuid") and os.geteuid() == 0
    ):  # Chrome refuses to start as root without this
        args.insert(1, "--no-sandbox")
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE
    )
    cdp: _Cdp | None = None
    try:

        async def endpoint() -> str:
            assert proc.stderr is not None
            while True:
                line = (await proc.stderr.readline()).decode("utf-8", "ignore")
                if not line:
                    raise RuntimeError("the browser exited before it was ready")
                if "DevTools listening on" in line:
                    return line.split("listening on", 1)[1].strip()

        url = await asyncio.wait_for(endpoint(), 20)
        async with websockets.connect(url, max_size=64 * 1024 * 1024) as ws:
            cdp = _Cdp(ws, editor)
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
            loaded = cdp.wait_for("Page.loadEventFired")
            # a page on the editor's own origin hosts the frame that runs the editor
            nav = await cdp.call(
                "Page.navigate", {"url": f"{editor}/clear.html"}, session
            )
            if nav.get("errorText"):
                raise RuntimeError(
                    f"the editor at {editor} could not be reached ({nav['errorText']})"
                )
            await asyncio.wait_for(loaded, 30)
            expression = f"({PAGE_SCRIPT})({json.dumps(source)}, {json.dumps(editor)}, {int(timeout * 1000)})"
            result = await asyncio.wait_for(
                cdp.call(
                    "Runtime.evaluate",
                    {
                        "expression": expression,
                        "awaitPromise": True,
                        "returnByValue": True,
                    },
                    session,
                ),
                timeout + 5,
            )
            if "exceptionDetails" in result:
                detail = result["exceptionDetails"]
                raise RuntimeError(
                    (detail.get("exception") or {}).get("description")
                    or detail.get("text", "script error")
                )
            return _decode(result["result"]["value"])
    finally:
        if cdp:
            cdp.reader.cancel()
        if proc.returncode is None:
            proc.kill()
        await proc.wait()
        shutil.rmtree(profile, ignore_errors=True)


# --- the desktop app's own Chromium ---------------------------------------------------------------


async def _export_with_command(
    command: list[str], source: str, editor: str, timeout: float
) -> str:
    with tempfile.TemporaryDirectory(prefix="kanban-export-") as tmp:
        src, out = Path(tmp) / "in.drawio", Path(tmp) / "out.svg"
        src.write_text(source, encoding="utf-8")
        proc = await asyncio.create_subprocess_exec(
            *command,
            "--export-svg",
            str(src),
            str(out),
            "--editor-url",
            editor,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, err = await asyncio.wait_for(proc.communicate(), timeout + 15)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise RuntimeError("the export command timed out") from None
        if proc.returncode != 0 or not out.is_file():
            raise RuntimeError(
                f"the export command failed ({proc.returncode}): {err.decode('utf-8', 'ignore')[-300:]}"
            )
        return out.read_text(encoding="utf-8")


def _command() -> list[str] | None:
    raw = os.environ.get(EXPORT_CMD_ENV, "").strip()
    if not raw:
        return None
    try:
        command = json.loads(raw)
    except ValueError:
        return None
    ok = (
        isinstance(command, list)
        and command
        and all(isinstance(c, str) for c in command)
    )
    return command if ok else None


async def export_svg(
    source: str, editor_url: str, *, timeout: float = EXPORT_TIMEOUT
) -> str | None:
    """The editor's own SVG of a drawing, or ``None`` when no hidden browser is available or it failed.

    Args:
        source: ``.drawio`` XML.
        editor_url: The editor's address (its origin is the only one the hidden page may load).
        timeout: Seconds to wait for the editor.
    """
    editor = editor_url.rstrip("/")
    try:
        command = _command()
        if command:
            return await _export_with_command(command, source, editor, timeout)
        chrome = find_chrome()
        if chrome:
            return await _export_with_chrome(chrome, source, editor, timeout)
    except Exception as e:  # never let a preview failure fail a save
        logger.warning("exact diagram preview failed: %s", e)
    return None
