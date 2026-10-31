"""The sign-in terminal of an AI account (design/screens/ai-accounts.md, C2 to C4).

A person signs in by running the CLI's own login in a real pseudo-terminal that the app shows. This module starts that
process, keeps its latest output so a window can attach again, and every few seconds asks the CLI whether the account
is signed in (it never reads the login). The terminal output is kept in memory only: not logged, not stored.

Only a person can open it: the routes that use this module are the account routes of the UI, and no MCP tool or AI
runner calls it.

A pseudo-terminal needs the ``pty`` module (macOS and Linux). Without it ``start`` raises ``PtyUnavailable`` and the
window offers the command to run in the person's own terminal instead (``fallback_command``).
"""

import asyncio
import codecs
import contextlib
import os
import re
import shlex
import struct
import subprocess
import sys
import time
from dataclasses import dataclass, field

from models import AiAccount

from . import accounts, cli

try:  # not on Windows
    import fcntl
    import pty
    import termios
except ImportError:  # pragma: no cover - Windows
    pty = None

KEEP_BYTES = 64 * 1024  # what a window that attaches late replays
POLL_S = 3.0  # how often the CLI is asked who is signed in
ORPHAN_S = (
    90.0  # a sign-in with no window attached this long is stopped (the tab was closed)
)
MAX_S = 30 * 60  # no sign-in outlives this
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]")
URL = re.compile(r"https?://[^\s\x1b\"'<>)]+")


class PtyUnavailable(RuntimeError):
    """No pseudo-terminal on this platform (or it could not be opened)."""


class SignInBusy(RuntimeError):
    """A sign-in of this account is already open."""

    def __init__(self, by: str):
        """Who started it."""
        super().__init__(f"{by} is signing in to this account")
        self.by = by


def read_screen(text: str, signed_in: bool = False) -> dict:
    """Best-effort reading of the CLI's latest output: what it is waiting for and the last link it printed.

    The terminal stays fully usable whatever this says; it only decides which sentence the status bar shows.
    """
    clean = ANSI.sub("", text).replace("\r", "\n")
    tail = clean[-2500:]
    last = [ln.strip() for ln in tail.splitlines() if ln.strip()][-6:]
    recent = "\n".join(last).lower()
    urls = URL.findall(tail)
    phase = "waiting"
    if re.search(r"do you trust|trust the files|trust this folder", recent):
        phase = "trust_folder"
    elif (
        re.search(r"(paste|enter|type).{0,40}(code|token)|authorization code", recent)
        and not signed_in
    ):
        phase = "paste_code"
    elif re.search(
        r"select .{0,20}method|login method|choose .{0,20}(method|how)", recent
    ):
        phase = "choose_method"
    elif urls and not signed_in:
        phase = "browser"
    elif re.search(r"invalid|expired|rejected|denied|failed", recent):
        phase = "error"
    return {"phase": phase, "url": urls[-1] if urls else None}


def fallback_command(account: AiAccount) -> str:
    """The command that signs this account in from the person's own terminal, with the account's folder in the
    environment so the login lands in this account and not in the one already on this computer."""
    profile = accounts.profile_of(account)
    argv = profile.login_argv([])
    argv = [os.path.basename(argv[0]), *argv[1:]]
    env = profile.env()
    if sys.platform == "win32":
        sets = "; ".join(f"$env:{k}='{v}'" for k, v in env.items())
        return f"{sets}; {' '.join(argv)}" if sets else " ".join(argv)
    prefix = " ".join(f"{k}={shlex.quote(v)}" for k, v in env.items())
    cmd = shlex.join(argv)
    cwd = profile.login_cwd()
    if cwd:
        cmd = f"cd {shlex.quote(str(cwd))} && " + (
            f"env {prefix} {cmd}" if prefix else cmd
        )
        return cmd
    return f"{prefix} {cmd}".strip()


@dataclass
class SignIn:
    """One open sign-in: the process, its output and the people watching it."""

    account_id: str
    by: str
    argv: list[str]
    started: float = field(default_factory=time.time)
    master: int = -1
    proc: subprocess.Popen | None = None
    buffer: bytearray = field(default_factory=bytearray)
    decoder: codecs.IncrementalDecoder = field(
        default_factory=lambda: codecs.getincrementaldecoder("utf-8")("replace")
    )
    watchers: set = field(default_factory=set)  # asyncio.Queue of messages
    exit_code: int | None = None
    ended: str | None = None  # None while open | exited | cancelled | done
    signed_in: bool = False
    duplicate_of: str | None = None
    account: dict | None = None
    poller: asyncio.Task | None = None
    orphan: asyncio.TimerHandle | None = None

    def publish(self, message: dict) -> None:
        """Send a message to every window attached."""
        for q in list(self.watchers):
            if q.full():
                with contextlib.suppress(asyncio.QueueEmpty):
                    q.get_nowait()
            q.put_nowait(message)

    def state(self) -> dict:
        """What the window shows besides the terminal."""
        screen = read_screen(self.buffer.decode("utf-8", "replace"), self.signed_in)
        return {
            "type": "state",
            "running": self.ended is None,
            "ended": self.ended,
            "exit_code": self.exit_code,
            "signed_in": self.signed_in,
            "duplicate_of": self.duplicate_of,
            "elapsed": int(time.time() - self.started),
            "account": self.account,
            **screen,
        }


SESSIONS: dict[str, SignIn] = {}


def active(account_id: str) -> SignIn | None:
    """The open sign-in of an account, if any."""
    s = SESSIONS.get(account_id)
    return s if s and s.ended is None else None


def signing_in_by(account_id: str) -> str | None:
    """Who is signing in to this account right now."""
    s = active(account_id)
    return s.by if s else None


def _winsize(fd: int, cols: int, rows: int) -> None:
    with contextlib.suppress(OSError):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def _controlling_tty() -> None:  # runs in the child, after setsid
    with contextlib.suppress(OSError):
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)


async def start(account: AiAccount, by: str, cols: int = 80, rows: int = 24) -> SignIn:
    """Open the CLI's login in a pseudo-terminal in the account's folder and start watching for the result.

    Raises:
        SignInBusy: Another sign-in of this account is open.
        PtyUnavailable: This platform has no pseudo-terminal.
        accounts.AccountError: The CLI is not installed.
    """
    if (open_one := active(account.id)) is not None:
        raise SignInBusy(open_one.by)
    if pty is None:
        raise PtyUnavailable("No pseudo-terminal on this platform")
    profile = accounts.profile_of(account)
    if not profile.binary:
        raise accounts.AccountError(
            "The CLI was not found on this computer.", "cli_missing"
        )
    profile.prepare()
    argv = profile.login_argv([])
    env = profile.overlay(cli.child_env())
    env.update(TERM="xterm-256color", COLUMNS=str(cols), LINES=str(rows))
    cwd = profile.login_cwd() or profile.dir
    try:
        master, slave = pty.openpty()
    except OSError as exc:
        raise PtyUnavailable(str(exc)) from exc
    _winsize(master, cols, rows)
    try:
        proc = subprocess.Popen(
            argv,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            cwd=cwd,
            env=env,
            start_new_session=True,
            close_fds=True,
            preexec_fn=_controlling_tty,  # noqa: PLW1509 - the child needs a controlling terminal
        )
    except OSError as exc:
        os.close(master)
        os.close(slave)
        raise PtyUnavailable(f"Could not run the CLI ({exc.strerror or exc})") from exc
    os.close(slave)
    os.set_blocking(master, False)
    session = SignIn(account.id, by, argv, master=master, proc=proc)
    SESSIONS[account.id] = session
    loop = asyncio.get_running_loop()
    loop.add_reader(master, _on_output, session)
    session.poller = asyncio.create_task(_poll(session))
    return session


def _on_output(session: SignIn) -> None:
    try:
        data = os.read(session.master, 4096)
    except BlockingIOError:
        return
    except OSError:
        data = b""
    if not data:  # the process closed its end
        asyncio.get_running_loop().remove_reader(session.master)
        asyncio.create_task(_exited(session))
        return
    session.buffer += data
    if len(session.buffer) > KEEP_BYTES:
        del session.buffer[: len(session.buffer) - KEEP_BYTES]
    session.publish({"type": "out", "data": session.decoder.decode(data)})
    session.publish(session.state())


async def _exited(session: SignIn) -> None:
    code = await asyncio.to_thread(session.proc.wait)
    if session.ended is None:
        session.ended = "exited"
    session.exit_code = code
    _close_fd(session)
    session.publish(session.state())
    await _check(session)  # a CLI that finished may have just signed in


def _close_fd(session: SignIn) -> None:
    if session.master >= 0:
        with contextlib.suppress(Exception):
            asyncio.get_running_loop().remove_reader(session.master)
        with contextlib.suppress(OSError):
            os.close(session.master)
        session.master = -1


async def _check(session: SignIn) -> None:
    """Ask the CLI who is signed in; the account row is updated only from its answer."""
    import database

    async with database.async_session() as db:
        account = await db.get(AiAccount, session.account_id)
        if account is None:
            return
        await accounts.check(db, account)
        session.signed_in = account.status == "signed_in"
        session.duplicate_of = None
        if session.signed_in and account.email:
            for other in await accounts.list_all(db):
                if (
                    other.id != account.id
                    and other.cli == account.cli
                    and other.email
                    and other.email.lower() == account.email.lower()
                ):
                    session.duplicate_of = other.name
                    break
        users = (await accounts.counts(db, None)).get(account.id)
        session.account = accounts.to_dict(account, users)
    session.publish(session.state())


async def _poll(session: SignIn) -> None:
    while session.ended is None:
        await asyncio.sleep(POLL_S)
        if SESSIONS.get(session.account_id) is not session or session.ended:
            return
        if time.time() - session.started > MAX_S:
            await stop(session, "cancelled")
            return
        with contextlib.suppress(Exception):
            await _check(session)


def attach(session: SignIn) -> asyncio.Queue:
    """A queue of messages for one window; it starts with the output so far and the current state."""
    q: asyncio.Queue = asyncio.Queue(maxsize=500)
    if session.buffer:
        q.put_nowait(
            {"type": "out", "data": bytes(session.buffer).decode("utf-8", "replace")}
        )
    q.put_nowait(session.state())
    session.watchers.add(q)
    if session.orphan is not None:
        session.orphan.cancel()
        session.orphan = None
    return q


def detach(session: SignIn, q: asyncio.Queue) -> None:
    """A window went away; the sign-in goes on for a little (a reload attaches again). With no window for ORPHAN_S
    seconds the CLI is stopped, so a closed tab never leaves one running."""
    session.watchers.discard(q)
    if session.watchers or session.ended is not None:
        return
    loop = asyncio.get_running_loop()
    session.orphan = loop.call_later(
        ORPHAN_S, lambda: asyncio.ensure_future(_stop_if_orphaned(session))
    )


async def _stop_if_orphaned(session: SignIn) -> None:
    if not session.watchers and session.ended is None:
        await stop(session, "cancelled")


def write(session: SignIn, data: str) -> None:
    """What the person typed or pasted."""
    if session.ended is None and session.master >= 0:
        with contextlib.suppress(OSError):
            os.write(session.master, data.encode("utf-8"))


def resize(session: SignIn, cols: int, rows: int) -> None:
    """The window changed size."""
    if session.master >= 0 and 10 <= cols <= 500 and 4 <= rows <= 200:
        _winsize(session.master, cols, rows)


async def stop(session: SignIn, how: str = "cancelled") -> None:
    """Close the terminal and stop the CLI (and anything it started). ``how``: cancelled | done."""
    if session.ended is None or session.ended == "exited":
        session.ended = how
    if session.proc and session.proc.poll() is None:
        cli.kill_tree(session.proc.pid)
    _close_fd(session)
    if session.orphan is not None:
        session.orphan.cancel()
    if session.poller and session.poller is not asyncio.current_task():
        session.poller.cancel()
    if how == "done":
        with contextlib.suppress(Exception):
            await _check(
                session
            )  # the row follows what the CLI says after the last question
    session.publish(session.state())
    if SESSIONS.get(session.account_id) is session:
        SESSIONS.pop(session.account_id, None)


async def stop_all() -> None:
    """The board is closing: no CLI outlives it."""
    for s in list(SESSIONS.values()):
        await stop(s)


__all__ = [
    "PtyUnavailable",
    "SignIn",
    "SignInBusy",
    "active",
    "attach",
    "detach",
    "fallback_command",
    "read_screen",
    "resize",
    "signing_in_by",
    "start",
    "stop",
    "stop_all",
    "write",
]
