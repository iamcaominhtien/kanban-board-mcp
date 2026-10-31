"""A stdio MCP server that forwards to the board's HTTP MCP endpoint with the run's token.

Antigravity keeps its MCP servers in its account's own config file, which has no place for a token that belongs to
one run. That file names this bridge instead (``mcp_stdio.py --bridge``); Antigravity starts it for the run with the
run's environment, and the bridge reads ``KANBAN_MCP_URL`` and ``KANBAN_RUN_TOKEN`` from it. Standard library only:
it starts fast and runs in the packaged stdio binary without the database.

Each line on stdin is one JSON-RPC message. It is posted to the board, and every message in the answer (plain JSON
or a server-sent-event stream) is written to stdout. A request that cannot be delivered gets a JSON-RPC error, so the
client never waits for an answer that will not come. Requests are handled in parallel: a board tool may wait for a
person's approval while the client keeps talking.
"""

import json
import os
import sys
import threading
import urllib.error
import urllib.request

URL_ENV = "KANBAN_MCP_URL"
TOKEN_ENV = "KANBAN_RUN_TOKEN"
DEFAULT_URL = "http://127.0.0.1:8000/mcp/"
TIMEOUT_S = 20 * 60  # a board tool may wait for an approval

_out_lock = threading.Lock()


def _write(message: dict) -> None:
    with _out_lock:
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()


def _messages(body: str, content_type: str) -> list[dict]:
    """The JSON-RPC messages in an HTTP answer."""
    found: list[dict] = []
    if "text/event-stream" in content_type:
        for raw in body.splitlines():
            if raw.startswith("data:"):
                try:
                    data = json.loads(raw[5:].strip())
                except ValueError:
                    continue
                found.extend(data if isinstance(data, list) else [data])
    elif body.strip():
        try:
            data = json.loads(body)
        except ValueError:
            return []
        found.extend(data if isinstance(data, list) else [data])
    return found


def forward(message: dict, url: str, token: str) -> None:
    """Deliver one message and write what comes back."""
    request = urllib.request.Request(
        url,
        data=json.dumps(message).encode(),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": f"Bearer {token}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            body = response.read().decode("utf-8", "replace")
            for reply in _messages(body, response.headers.get("content-type", "")):
                _write(reply)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        if "id" in message:
            _write(
                {
                    "jsonrpc": "2.0",
                    "id": message["id"],
                    "error": {
                        "code": -32000,
                        "message": f"The board did not answer: {exc}",
                    },
                }
            )


def main() -> None:
    """Read messages from stdin until it closes."""
    url = os.environ.get(URL_ENV) or DEFAULT_URL
    token = os.environ.get(TOKEN_ENV, "")
    if not token:
        sys.stderr.write(
            f"{TOKEN_ENV} is not set: this bridge only works inside a board run\n"
        )
        sys.exit(1)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue
        threading.Thread(
            target=forward, args=(message, url, token), daemon=True
        ).start()
    # stdin closed: let answers that are still on their way finish
    for thread in threading.enumerate():
        if thread is not threading.current_thread():
            thread.join(timeout=5)


if __name__ == "__main__":
    main()
