"""A secret only the board's own window knows, so a program on the computer cannot change the board by calling its
REST API as the owner.

Without it the REST API trusts any caller on the loopback address, and an AI run with a shell (Bypass, or a broad
Bash rule) could `curl` it: approve its own requests, switch Safe mode off, lift the limits. When the desktop app
starts the server it writes a random secret to the server's standard input (not to its environment, which `ps` shows
to every program of the same user) and hands the same secret to its window only. The server then refuses every
request that changes something (POST, PUT, PATCH, DELETE) without it, except the MCP endpoint (a run's own token) and
the client log.

Without the app (a developer starting the server by hand, the tests) there is no secret and nothing is checked.
"""

import hmac
import os
import sys

HEADER = "X-Kanban-Secret"
FLAG = "KANBAN_API_SECRET_STDIN"
UNCHECKED_PREFIXES = ("/mcp", "/logs/client", "/ai/hooks", "/internal/ai/")
CHANGING = ("POST", "PUT", "PATCH", "DELETE")


def _read() -> str:
    """The secret the desktop app wrote to standard input, or "" when there is none."""
    if os.environ.pop(FLAG, "") != "1":
        return ""
    try:
        return sys.stdin.readline().strip()
    except (OSError, ValueError):
        return ""


SECRET = _read()


# What an AI that reached for the REST API (curl, a browser on the board) should use instead: the 403 says so, or it
# tries again another way (seen in a log: uploads by curl, Docs links checked in a browser)
_INSTEAD = (
    (
        ("/uploads/", "/workspace/files"),
        "To attach a picture or a file, write it as a path in your working folder inside the Markdown of the MCP "
        "call: ![shot](qa/evidence/TC-1.png) or [sample](docs/sample.xlsx) in docs_write, a comment, a work log or a "
        "test case proof; the board copies it. For the ticket's scratch folder, manage_ticket(action='workspace') "
        "gives its path: write the file there with your own file tools.",
    ),
    (
        ("/docs/resolve", "/docs/pages/"),
        "To check the links of a Docs page use docs_read(action='check_links'); to read a page, "
        "docs_read(action='get'). The board's window cannot be driven from a browser outside the app.",
    ),
)


def refusal(path: str) -> str:
    """The 403 text for a request without the secret, with the MCP tool an AI run should use instead."""
    hint = next(
        (text for parts, text in _INSTEAD if any(p in path for p in parts)),
        "An AI run changes the board through the kanban MCP tools, not the REST API or a browser.",
    )
    return f"This request must come from the board's own window. {hint}"


def allows(method: str, path: str, given: str | None) -> bool:
    """Whether a request may go on: no secret is set, it does not change anything, it is one of the unchecked
    endpoints, or it carries the secret."""
    if not SECRET or method.upper() not in CHANGING:
        return True
    if path.startswith(UNCHECKED_PREFIXES):
        return True
    return hmac.compare_digest(given or "", SECRET)
