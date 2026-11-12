"""Which port the board listens on.

An MCP client is told the board's address once (``http://127.0.0.1:<port>/mcp/``), so the port must not change
from one start to the next. The server asks for, in this order:

1. ``KANBAN_PORT``, when set (a fixed port you chose);
2. the port it listened on last time, kept in ``config.json``;
3. any free port (the very first start, or when the wanted port is taken by another program).

A port that is taken is never an error: the board starts on a free one and says so in the log. The port kept for the
next start is changed only when the board got the one it asked for, or had none to ask for, so a second instance that
had to take another port does not steal the first one's.
"""

import logging
import os
import socket
import sys

import config

logger = logging.getLogger("kanban.port")

HOST = "127.0.0.1"


def wanted_port() -> int | None:
    """The port asked for: `KANBAN_PORT`, else the one saved by the last start; None when there is none."""
    raw = (os.environ.get("KANBAN_PORT") or "").strip()
    if raw:
        if raw.isdigit() and 0 < int(raw) < 65536:
            return int(raw)
        logger.warning("KANBAN_PORT=%r is not a port number: ignored", raw)
    return config.get_port()


def _new_socket() -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if sys.platform == "win32":
        # On Windows SO_REUSEADDR lets a second program take a port that is in use; this refuses instead
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    else:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    return sock


def bind_socket() -> socket.socket:
    """A socket bound on the wanted port, or on a free one when that is taken. The caller owns (and closes) it."""
    wanted = wanted_port()
    sock = _new_socket()
    if wanted is not None:
        try:
            sock.bind((HOST, wanted))
        except OSError as exc:
            logger.warning(
                "Port %s is not free (%s): using another one; MCP clients set to %s:%s need the new port",
                wanted,
                exc,
                HOST,
                wanted,
            )
            sock.close()
            sock = _new_socket()
            sock.bind((HOST, 0))
            return sock
    else:
        sock.bind((HOST, 0))
    try:
        config.set_port(sock.getsockname()[1])
    except OSError:
        logger.warning("Could not save the port for the next start", exc_info=True)
    return sock
