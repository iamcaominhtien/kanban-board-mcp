"""Local runner: find the official CLI, check it is signed in, launch it headless, read its stream, kill it cleanly.

The board only starts the CLI exactly as a person would type it. It never reads, copies or stores the CLI's login:
the account shown is what ``claude auth status`` prints (no token is in that output).
"""

import asyncio
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from . import paths
from .secrets import redact

# The command names of the local runners (Claude Code, Codex, opencode, Antigravity)
LOCAL_CLIS = ("claude", "codex", "opencode", "agy")

_SEARCH_DIRS = [
    "~/.local/bin",
    "~/.claude/local",
    "~/.npm-global/bin",
    "~/bin",
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "~/AppData/Roaming/npm",
]


def find_cli(binary: str, explicit: str | None = None) -> tuple[str | None, list[str]]:
    """Path of the CLI: the configured one, then PATH, then the usual install folders.

    Returns:
        (path or None, the places that were checked)
    """
    checked: list[str] = []
    if explicit:
        try:
            p = paths.program(explicit)
        except paths.PathRefused:
            checked.append(explicit)
        else:
            checked.append(p)
            if os.path.isfile(p) and os.access(p, os.X_OK):
                return p, checked
    checked.append("PATH")
    found = shutil.which(binary)
    if found:
        return found, checked
    names = (
        [binary, f"{binary}.cmd", f"{binary}.exe"]
        if sys.platform == "win32"
        else [binary]
    )
    for folder in _SEARCH_DIRS:
        base = Path(folder).expanduser()
        checked.append(str(base))
        for name in names:
            cand = base / name
            if cand.is_file() and os.access(cand, os.X_OK):
                return str(cand), checked
    return None, checked


def _popen_kwargs() -> dict:
    """Start the CLI in its own process group so cancel can stop it and every child it started."""
    if sys.platform == "win32":
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def low_priority_prefix() -> list[str]:
    """`taskpolicy -b` on macOS, only when KANBAN_CLI_LOW_PRIORITY=1: the CLI and its children run on the efficiency
    cores with a lower disk priority. Off by default: five real CLIs took 144 s instead of 106 s with it and the
    CPU peak did not drop. `taskpolicy` execs the command, so the pid stays the CLI's."""
    if sys.platform != "darwin" or os.environ.get("KANBAN_CLI_LOW_PRIORITY") != "1":
        return []
    tool = shutil.which("taskpolicy")
    return [tool, "-b"] if tool else []


def child_env(compact_at_pct: int | None = None) -> dict:
    """Environment for the CLI: the person's own, minus variables that would make it think it runs inside a
    Claude Code session (when the board itself was started from one). `compact_at_pct` is the share of the context
    window at which the CLI compacts a long session by itself."""
    env = dict(os.environ)
    for key in list(env):
        if key in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID"):
            env.pop(key, None)
    # A board tool call may wait for a person's approval (guard.APPROVAL_WAIT_S); keep the CLI from giving up first
    env.setdefault("MCP_TOOL_TIMEOUT", str(15 * 60 * 1000))
    if compact_at_pct:
        env["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"] = str(int(compact_at_pct))
    return env


def session_exists(
    session_id: str, config_dir: str | None = None, provider: str | None = None
) -> bool:
    """Whether the CLI still has this conversation on disk (it is gone when the person cleaned ~/.claude).
    ``config_dir`` is the folder of an AI account, which keeps its own sessions. Without a `provider` either CLI's
    conversations count (a ticket's shared conversation belongs to one of them)."""
    if (
        provider in (None, "antigravity")
        and (
            antigravity_home()
            / "antigravity-cli"
            / "conversations"
            / f"{session_id}.db"
        ).is_file()
    ):
        return True
    if provider == "antigravity":
        return False
    root = (
        Path(
            config_dir or os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude"
        ).expanduser()
        / "projects"
    )
    try:
        return any(root.glob(f"*/{session_id}.jsonl"))
    except OSError:
        return False


async def run_capture(
    args: list[str],
    timeout: float,
    cwd: str | None = None,
    env: dict | None = None,
) -> tuple[int, str, str]:
    """Run a short command and capture its output; kills it on timeout. ``env`` replaces the usual environment
    (an AI account's)."""
    proc = await asyncio.create_subprocess_exec(
        *args,
        cwd=cwd,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env or child_env(),
        **_popen_kwargs(),
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except TimeoutError:
        kill_tree(proc.pid)
        await proc.wait()
        return -1, "", f"Timed out after {int(timeout)} s"
    return (
        proc.returncode or 0,
        out.decode(errors="replace"),
        err.decode(errors="replace"),
    )


async def detect(
    provider: str,
    binary: str,
    explicit: str | None = None,
    env: dict | None = None,
) -> dict:
    """CLI found? version? signed in (and as whom, without ever touching the token)? ``env`` is the environment of
    an AI account, so the answer is about that account's login."""
    path, checked = find_cli(binary, explicit)
    info: dict = {
        "found": bool(path),
        "path": path,
        "checked": checked,
        "version": None,
        "logged_in": None,
        "account": None,
    }
    if not path:
        return info
    code, out, _ = await run_capture([path, "--version"], 20, env=env)
    if code == 0:
        info["version"] = out.strip().split("\n")[0][:80]
    if provider == "claude-code":
        code, out, _ = await run_capture([path, "auth", "status"], 20, env=env)
        try:
            status = json.loads(out)
        except ValueError:
            status = {}
        if status:
            info["logged_in"] = bool(status.get("loggedIn"))
            account = (
                status.get("email") or status.get("account") or status.get("orgName")
            )
            plan = str(status.get("subscriptionType") or "").strip()
            method = (
                f"{plan.capitalize()} plan"
                if plan
                else {"oauth_token": "subscription login", "api_key": "API key"}.get(
                    status.get("authMethod"), status.get("authMethod")
                )
            )
            info["account"] = " · ".join(x for x in (account, method) if x) or None
    return info


async def test_run(
    path: str,
    model: str | None,
    cwd: str | None,
    env: dict | None = None,
    provider: str = "claude-code",
) -> dict:
    """A one-line headless run: proves the CLI starts, is signed in and answers."""
    started = time.monotonic()
    if provider == "antigravity":
        args = [
            path,
            "-p",
            "Reply with exactly the word: pong",
            "--output-format",
            "json",
        ]
        if model:
            args += ["--model", model]
        code, out, err = await run_capture(args, 120, cwd=cwd, env=env)
        seconds = round(time.monotonic() - started, 1)
        try:
            data = json.loads(out.strip().splitlines()[-1]) if out.strip() else {}
        except ValueError:
            data = {}
        reply = str(data.get("response") or "").strip()
        if code == 0 and data.get("status") == "SUCCESS" and reply:
            return {"ok": True, "seconds": seconds, "reply": reply[:80]}
        detail = reply or err.strip() or out.strip() or f"exit code {code}"
        low = detail.lower()
        return {
            "ok": False,
            "seconds": seconds,
            "error": redact(detail)[:300],
            "kind": "not_logged_in"
            if ("log in" in low or "login" in low or "sign in" in low or "auth" in low)
            else "failed",
        }
    args = [
        path,
        "-p",
        "Reply with exactly the word: pong",
        "--output-format",
        "json",
        "--max-turns",
        "1",
        "--tools",
        "",
        "--strict-mcp-config",
    ]
    if model:
        args += ["--model", model]
    code, out, err = await run_capture(args, 90, cwd=cwd, env=env)
    seconds = round(time.monotonic() - started, 1)
    try:
        data = json.loads(out.strip().splitlines()[-1]) if out.strip() else {}
    except ValueError:
        data = {}
    reply = (data.get("result") or "").strip()
    if code == 0 and not data.get("is_error"):
        return {"ok": True, "seconds": seconds, "reply": reply[:80]}
    detail = reply or err.strip() or out.strip() or f"exit code {code}"
    low = detail.lower()
    kind = (
        "not_logged_in"
        if ("log in" in low or "login" in low or "auth" in low)
        else "failed"
    )
    return {
        "ok": False,
        "seconds": seconds,
        "error": redact(detail)[:300],
        "kind": kind,
    }


_RATE_LIMITED = re.compile(
    r"(\b429\b|rate.?limit|usage limit|overloaded_error|too many requests)",
    re.IGNORECASE,
)
RATE_WAIT_DEFAULT = 45.0
RATE_WAIT_MAX = 6 * 3600.0


def rate_limit_wait(text: str | None) -> float | None:
    """Seconds to wait when the CLI's output says the provider is rate-limiting it, else None. A usage-limit
    message names the time it resets (``...limit reached|1760000000``); "retry after N" is honoured too."""
    if not text or not _RATE_LIMITED.search(text):
        return None
    reset = re.search(r"\|(\d{10})\b", text)
    if reset:
        wait = int(reset.group(1)) - time.time()
    else:
        after = re.search(r"retry[- ]after\D{0,10}(\d+)", text, re.IGNORECASE)
        wait = float(after.group(1)) if after else RATE_WAIT_DEFAULT
    return max(5.0, min(wait, RATE_WAIT_MAX))


def kill_tree(pid: int | None) -> None:
    """Stop a process and everything it started (its process group); safe on an already-dead pid."""
    if not pid:
        return
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, check=False
        )
        return
    try:
        pgid = os.getpgid(pid)
    except ProcessLookupError:
        return
    if pgid == os.getpgid(0):  # never our own group
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        return
    try:
        os.killpg(pgid, signal.SIGCONT)  # a paused run must wake up to see the SIGTERM
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return

    def _force() -> None:
        try:
            os.killpg(pgid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass

    # Whatever ignored SIGTERM is killed 2 s later, without blocking the event loop
    timer = threading.Timer(2.0, _force)
    timer.daemon = True
    timer.start()


def can_pause() -> bool:
    """Whether a run's CLI can be paused on this computer (a stopped process group needs POSIX signals)."""
    return sys.platform != "win32"


def suspend_tree(pid: int | None, stop: bool = True) -> bool:
    """Pause (SIGSTOP) or continue (SIGCONT) a process and everything it started; False when it is gone."""
    if not pid or not can_pause():
        return False
    try:
        pgid = os.getpgid(pid)
        if pgid == os.getpgid(0):  # never stop our own group
            return False
        os.killpg(pgid, signal.SIGSTOP if stop else signal.SIGCONT)
    except (ProcessLookupError, PermissionError):
        return False
    return True


def looks_like_cli(pid: int, binary: str | None = None) -> bool:
    """Is `pid` still one of our CLI processes? Used before killing a run left over from a crash, so a reused
    pid is never killed by mistake."""
    if sys.platform == "win32":
        # No /proc on Windows: ask for the process's command line (once per leftover run, at startup)
        try:
            out = subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    f"(Get-CimInstance Win32_Process -Filter 'ProcessId={int(pid)}').CommandLine",
                ],
                capture_output=True,
                timeout=15,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return False
        cmd = out.stdout.decode(errors="replace")
    else:
        try:
            cmd = (
                Path(f"/proc/{pid}/cmdline")
                .read_bytes()
                .replace(b"\0", b" ")
                .decode(errors="replace")
            )
        except OSError:
            return False
    names = (binary,) if binary else LOCAL_CLIS
    return any(n in cmd for n in names) and any(
        f in cmd for f in ("--output-format", "--json", "--format")
    )


# Windows runs the CLI through its `claude.cmd` shim, and cmd.exe refuses a command line over 8191 characters
# ("The command line is too long", exit 1); CreateProcess itself stops at 32767 (WinError 206). Linux and macOS
# cap one argument at 128 KB. A long ticket or chat history in the prompt or system prompt goes over, so past
# these sizes they travel by stdin and a file instead. Through that shim they always do: cmd.exe cuts an argument at
# its first line break (the CLI then exits 0 without an answer) and reads `&`, `|` and `%` in it as commands.
_MAX_COMMAND_CHARS = 6000 if sys.platform == "win32" else 100_000

# flag -> the flag that takes the same text from a file
_FILE_FLAGS = {
    "--system-prompt": "--system-prompt-file",
    "--append-system-prompt": "--append-system-prompt-file",
}


def _through_cmd_exe(args: list[str]) -> bool:
    """Whether Windows starts this command through cmd.exe (a `.cmd` or `.bat` shim such as npm's claude.cmd)."""
    return (
        sys.platform == "win32"
        and bool(args)
        and args[0].lower().endswith((".cmd", ".bat"))
    )


def spill_long_args(args: list[str]) -> tuple[list[str], str | None, str | None]:
    """Move a long prompt and system prompt off the command line.

    Returns:
        (args to run, text for stdin or None, temp folder holding the system prompt file or None). Short commands come
        back unchanged, except behind a Windows `.cmd` shim. `-p <text>` becomes a bare `-p` (the CLI then reads the prompt from stdin); `--system-prompt
        <text>` becomes `--system-prompt-file <path>`.
    """
    if (
        not _through_cmd_exe(args)
        and len(subprocess.list2cmdline(args)) <= _MAX_COMMAND_CHARS
    ):
        return args, None, None
    out = list(args)
    stdin_text: str | None = None
    folder: str | None = None
    for flag, file_flag in (("-p", None), *_FILE_FLAGS.items()):
        if flag not in out or out.index(flag) + 1 >= len(out):
            continue
        i = out.index(flag)
        text = out[i + 1]
        if file_flag is None:
            stdin_text = text
            del out[i + 1]
            continue
        if folder is None:
            folder = tempfile.mkdtemp(prefix="kanban-cli-")
        path = os.path.join(folder, flag.lstrip("-") + ".txt")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        out[i : i + 2] = [file_flag, path]
    return out, stdin_text, folder


class CliProcess:
    """One running CLI: yields its stdout lines; `kill()` stops the whole tree."""

    def __init__(
        self,
        args: list[str],
        cwd: str,
        env: dict | None = None,
        spill: bool = True,
    ):
        """Prepare the command; nothing starts until `start()`. `spill` lets a long prompt travel by stdin (Claude
        Code only)."""
        self.spill = spill
        self.args = args
        self.cwd = cwd
        self.env = env or child_env()
        self.proc: asyncio.subprocess.Process | None = None
        self.stderr_tail: list[str] = []
        self._temp: str | None = None

    async def start(self) -> int:
        """Launch; returns the pid."""
        args, stdin_text, self._temp = (
            spill_long_args(self.args) if self.spill else (self.args, None, None)
        )
        try:
            self.proc = await asyncio.create_subprocess_exec(
                *low_priority_prefix(),
                *args,
                cwd=self.cwd,
                stdin=asyncio.subprocess.DEVNULL
                if stdin_text is None
                else asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=self.env,
                limit=16 * 1024 * 1024,
                **_popen_kwargs(),
            )
        except BaseException:
            self._cleanup()
            raise
        if stdin_text is not None and self.proc.stdin:
            self.proc.stdin.write(stdin_text.encode("utf-8"))
            try:
                await self.proc.stdin.drain()
                self.proc.stdin.close()
            except (ConnectionError, OSError):
                pass  # the CLI already exited; its exit code and stderr say why
        asyncio.create_task(self._drain_stderr())
        return self.proc.pid

    def _cleanup(self) -> None:
        """Remove the temp folder of a spilled system prompt."""
        if self._temp:
            shutil.rmtree(self._temp, ignore_errors=True)
            self._temp = None

    async def _drain_stderr(self) -> None:
        assert self.proc and self.proc.stderr
        async for raw in self.proc.stderr:
            line = raw.decode(errors="replace").rstrip()
            if line:
                self.stderr_tail = (self.stderr_tail + [redact(line)])[-20:]

    async def lines(self):
        """Stdout lines as they arrive."""
        assert self.proc and self.proc.stdout
        async for raw in self.proc.stdout:
            yield raw.decode(errors="replace").rstrip("\n")

    async def wait(self) -> int:
        """Exit code."""
        assert self.proc
        try:
            return await self.proc.wait()
        finally:
            self._cleanup()

    def kill(self) -> None:
        """Stop the CLI and its children."""
        if self.proc and self.proc.returncode is None:
            kill_tree(self.proc.pid)
        self._cleanup()


# ---------------------------------------------------------------------------
# Claude Code stream-json → run steps
# ---------------------------------------------------------------------------


def _short(text: str, n: int = 160) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= n else text[: n - 1] + "…"


def _rel(path: str, cwd: str) -> str:
    try:
        return str(Path(path).resolve().relative_to(Path(cwd).resolve()))
    except (ValueError, OSError):
        return path


def describe_tool(name: str, inp: dict, cwd: str) -> tuple[str, str, dict | None]:
    """(kind, text, file change) for one tool call of the CLI."""
    if name in ("Edit", "MultiEdit"):
        path = _rel(inp.get("file_path", ""), cwd)
        edits = inp.get("edits") or [inp]
        added = sum(len((e.get("new_string") or "").splitlines()) for e in edits)
        removed = sum(len((e.get("old_string") or "").splitlines()) for e in edits)
        return (
            "edit",
            f"Edited {path}",
            {"path": path, "added": added, "removed": removed, "new": False},
        )
    if name == "Write":
        path = _rel(inp.get("file_path", ""), cwd)
        added = len((inp.get("content") or "").splitlines())
        return (
            "create",
            f"Wrote {path}",
            {"path": path, "added": added, "removed": 0, "new": True},
        )
    if name == "Read":
        return "read", f"Read {_rel(inp.get('file_path', ''), cwd)}", None
    if name == "Bash":
        return "command", f"Ran {_short(inp.get('command', ''), 120)}", None
    if name in ("Grep", "Glob"):
        return "search", f"Searched {_short(inp.get('pattern', ''), 80)}", None
    if name.startswith("mcp__"):
        parts = name.split("__")
        tool = parts[-1]
        action = inp.get("action")
        item = inp.get("item")
        label = ".".join(x for x in (tool, item, action) if x)
        target = inp.get("ticket_id") or inp.get("project_id") or ""
        return "board", f"board.{label}({target})", None
    return "tool", f"{name} {_short(json.dumps(inp)[:200], 80)}", None


_PASSED = re.compile(r"\b(\d+) (?:passed|passing)\b", re.IGNORECASE)
_FAILED = re.compile(r"\b(\d+) (?:failed|failing)\b", re.IGNORECASE)
_FAILING_NAME = re.compile(r"^(?:FAILED|FAIL|✗|×)\s+(\S.{0,120})$", re.MULTILINE)


def parse_tests(output: str) -> dict | None:
    """Pass and fail counts read from a test command's output (pytest, jest, vitest, mocha, ...), or None when the
    output does not look like a test run."""
    passed = _PASSED.findall(output or "")
    failed = _FAILED.findall(output or "")
    if not passed and not failed:
        return None
    return {
        "passed": int(passed[-1]) if passed else 0,
        "failed": int(failed[-1]) if failed else 0,
        "failing": [m.strip() for m in _FAILING_NAME.findall(output)][:5],
    }


def _result_text(content) -> str:
    if isinstance(content, list):
        content = "\n".join(c.get("text", "") for c in content if isinstance(c, dict))
    return str(content or "")


def parse_stream_line(line: str, cwd: str) -> dict:
    """One line of ``--output-format stream-json`` → {steps, files, session_id, result, results}.

    `results` are the outputs of earlier tool calls, to attach to their steps: {tool_id, output, exit_code, is_error}.
    """
    out: dict = {
        "steps": [],
        "files": [],
        "session_id": None,
        "result": None,
        "ready": False,
        "results": [],
        # what the conversation held at this model call, and the model's window (tokens)
        "context_used": None,
        "context_window": None,
    }
    line = line.strip()
    if not line.startswith("{"):
        return out
    try:
        ev = json.loads(line)
    except ValueError:
        return out
    kind = ev.get("type")
    if kind == "system" and ev.get("subtype") == "init":
        out["ready"] = True
        out["session_id"] = ev.get("session_id")
        out["model"] = ev.get("model")
    elif kind == "system" and ev.get("subtype") == "compact_boundary":
        meta = ev.get("compact_metadata") or {}
        before, after = meta.get("pre_tokens"), meta.get("post_tokens")
        if isinstance(before, int) and isinstance(after, int):
            out["steps"].append(
                {
                    "kind": "compact",
                    "text": f"Long session compacted ({before:,} → {after:,} tokens)",
                }
            )
    elif kind == "assistant":
        usage = (ev.get("message") or {}).get("usage") or {}
        held = sum(
            int(usage.get(k) or 0)
            for k in (
                "input_tokens",
                "cache_creation_input_tokens",
                "cache_read_input_tokens",
            )
        )
        if held:
            out["context_used"] = held
        for block in (ev.get("message") or {}).get("content") or []:
            if block.get("type") == "tool_use" and block.get("name") == "ToolSearch":
                continue  # the CLI loading its own deferred tools: not a step of the work
            if block.get("type") == "tool_use":
                k, text, change = describe_tool(
                    block.get("name", ""), block.get("input") or {}, cwd
                )
                out["steps"].append(
                    {"kind": k, "text": redact(text), "tool_id": block.get("id")}
                )
                if change:
                    out["files"].append(change)
            elif block.get("type") == "text" and (block.get("text") or "").strip():
                out["steps"].append(
                    {"kind": "say", "text": redact(_short(block["text"], 300))}
                )
    elif kind == "user":
        for block in (ev.get("message") or {}).get("content") or []:
            if isinstance(block, dict) and block.get("type") == "tool_result":
                text = _result_text(block.get("content"))
                code = re.match(r"Exit code (\d+)", text)
                out["results"].append(
                    {
                        "tool_id": block.get("tool_use_id"),
                        "output": redact(text)[:4000],
                        "is_error": bool(block.get("is_error")),
                        "exit_code": int(code.group(1))
                        if code
                        else (1 if block.get("is_error") else 0),
                    }
                )
            if (
                isinstance(block, dict)
                and block.get("type") == "tool_result"
                and block.get("is_error")
            ):
                content = block.get("content")
                if isinstance(content, list):
                    content = " ".join(
                        c.get("text", "") for c in content if isinstance(c, dict)
                    )
                out["steps"].append(
                    {
                        "kind": "error",
                        "text": redact(_short(str(content), 240)),
                        "tool_id": block.get("tool_use_id"),
                    }
                )
    elif kind == "result":
        usage = ev.get("usage") or {}
        out["result"] = {
            "is_error": bool(ev.get("is_error"))
            or ev.get("subtype") not in (None, "success"),
            "subtype": ev.get("subtype"),
            "text": redact(ev.get("result") or ""),
            "cost_usd": float(ev.get("total_cost_usd") or 0),
            "tokens_in": int(usage.get("input_tokens") or 0)
            + int(usage.get("cache_creation_input_tokens") or 0)
            + int(usage.get("cache_read_input_tokens") or 0),
            "tokens_cached": int(usage.get("cache_creation_input_tokens") or 0)
            + int(usage.get("cache_read_input_tokens") or 0),
            "tokens_out": int(usage.get("output_tokens") or 0),
            "turns": ev.get("num_turns"),
        }
        out["session_id"] = ev.get("session_id")
        windows = [
            int(m.get("contextWindow") or 0)
            for m in (ev.get("modelUsage") or {}).values()
            if isinstance(m, dict)
        ]
        out["context_window"] = max(windows) if windows and max(windows) else None
    return out


REJECTED_FLAGS = (
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
    "bypassPermissions",
    "--permission-mode",
)


def claude_args(
    path: str,
    *,
    prompt: str,
    system: str,
    model: str | None,
    mcp_config: dict,
    allowed: list[str],
    denied: list[str],
    max_turns: int | None,
    session_id: str,
    resume: bool,
    effort: str | None = None,
    extra_flags: list[str] | None = None,
    bypass: bool = False,
) -> list[str]:
    """Command line of one headless Claude Code run. By default it never skips the CLI's own permission checks:
    only the Allow rules run, anything else is denied. `bypass` (an owner's explicit choice for the member) lets
    every tool run except what a Deny rule stops."""
    args = [
        path,
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "bypassPermissions" if bypass else "dontAsk",
        "--mcp-config",
        json.dumps(mcp_config),
        "--strict-mcp-config",
        "--append-system-prompt",
        system,
    ]
    if max_turns:
        args += ["--max-turns", str(max_turns)]
    args += ["--resume", session_id] if resume else ["--session-id", session_id]
    if model:
        args += ["--model", model]
    if effort:
        args += ["--effort", effort]
    if allowed:
        args += ["--allowedTools", ",".join(allowed)]
    if denied:
        args += ["--disallowedTools", ",".join(denied)]
    for flag in extra_flags or []:
        if any(bad in flag for bad in REJECTED_FLAGS):
            continue
        args.append(flag)
    return args


# ---------------------------------------------------------------------------
# Antigravity (agy) stream-json → run steps
# ---------------------------------------------------------------------------

# The server name the board's MCP endpoint gets inside an Antigravity run. A person's own `kanban` entry (a stdio
# server with no run token, acting as that person) is always denied there.
AGY_BOARD_SERVER = "board"


def antigravity_home() -> Path:
    """Where Antigravity keeps its conversations and settings (KANBAN_AGY_HOME is for tests)."""
    return Path(os.environ.get("KANBAN_AGY_HOME") or "~/.gemini").expanduser()


def antigravity_global_servers() -> list[str]:
    """Names of the MCP servers in the person's own Antigravity config, except their `kanban` entry."""
    try:
        data = json.loads(
            (antigravity_home() / "config" / "mcp_config.json").read_text(
                encoding="utf-8"
            )
        )
    except (OSError, ValueError):
        return []
    servers = data.get("mcpServers") if isinstance(data, dict) else None
    return [
        name
        for name in (servers or {})
        if isinstance(name, str) and name and name != "kanban"
    ]


def antigravity_rules(claude_rules: list[str]) -> list[str]:
    """A member's Claude-style tool rules (`Bash(git status:*)`, `WebFetch(domain:x)`) as Antigravity rules
    (`command(git status)`, `read_url(x)`). Rules about files and the web search have no counterpart and are left out:
    file edits come from the run's mode and anything not allowed is denied in a headless run."""
    out: list[str] = []
    for rule in claude_rules:
        name, _, rest = rule.partition("(")
        arg = rest[:-1] if rest.endswith(")") else ""
        if name == "Bash" and arg:
            command = arg[:-2] if arg.endswith(":*") else arg
            out.append(f"command({command.strip()})")
        elif name == "WebFetch" and arg.startswith("domain:"):
            out.append(f"read_url({arg[len('domain:') :]})")
    return list(dict.fromkeys(out))


def antigravity_args(
    path: str,
    *,
    prompt: str,
    model: str | None,
    allowed: list[str],
    denied: list[str],
    edits: bool,
    conversation: str | None,
    add_dirs: list[str],
    extra_flags: list[str] | None = None,
    bypass: bool = False,
) -> list[str]:
    """Command line of one headless Antigravity run. Tool permissions travel with the run (`--settings`, never saved):
    what is not allowed is refused, since a headless run cannot ask. `edits` lets it edit files (`--mode accept-edits`).
    `bypass` (an owner's Bypass permissions) auto-approves every request; the deny rules in `--settings` still refuse."""
    args = [path, "-p", prompt, "--output-format", "stream-json"]
    if conversation:
        args += ["--conversation", conversation]
    if model:
        args += ["--model", model]
    # No --effort: agy refuses it with most models (the level is part of the model's name, gemini-…-low)
    if edits:
        args += ["--mode", "accept-edits"]
    for folder in add_dirs:
        args += ["--add-dir", folder]
    if bypass:
        args.append("--dangerously-skip-permissions")
    args += [
        "--settings",
        json.dumps({"permissions": {"allow": allowed, "deny": denied}}),
    ]
    for flag in extra_flags or []:
        if any(bad in flag for bad in REJECTED_FLAGS) or flag.startswith("--mode"):
            continue
        args.append(flag)
    return args


def _first(params: dict, *keys: str) -> str:
    for key in keys:
        value = params.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def describe_agy_tool(
    name: str, params: dict, cwd: str
) -> tuple[str, str, dict | None]:
    """(kind, text, file change) for one tool call of Antigravity."""
    path = _first(params, "Path", "AbsolutePath", "TargetFile", "FilePath", "path")
    if name in ("write_file", "write_to_file"):
        return (
            "create",
            f"Wrote {_rel(path, cwd)}",
            {"path": _rel(path, cwd), "added": 0, "removed": 0, "new": False},
        )
    if name in (
        "edit_file",
        "replace_file_content",
        "multi_replace_file_content",
        "sed_file",
    ):
        return (
            "edit",
            f"Edited {_rel(path, cwd)}",
            {"path": _rel(path, cwd), "added": 0, "removed": 0, "new": False},
        )
    if name in ("read_file", "view_file", "list_dir"):
        return "read", f"Read {_rel(path or cwd, cwd)}", None
    if name == "run_command":
        return "command", f"Ran {_short(_first(params, 'CommandLine'), 120)}", None
    if name in ("grep_search", "find_by_name"):
        query = _first(params, "Query", "Pattern", "SearchPattern", "Search")
        return "search", f"Searched {_short(query, 80)}", None
    if name == "call_mcp_tool":
        server, tool = _first(params, "ServerName"), _first(params, "ToolName")
        arguments = params.get("Arguments")
        if server == AGY_BOARD_SERVER:
            return describe_tool(
                f"mcp__kanban__{tool}",
                arguments if isinstance(arguments, dict) else {},
                cwd,
            )
        return "tool", f"{server}.{tool}", None
    return "tool", f"{name} {_short(json.dumps(params)[:200], 80)}", None


class AgyStream:
    """Reads Antigravity's ``--output-format stream-json`` line by line, giving what `parse_stream_line` gives for
    Claude Code: {steps, files, session_id, result, ready, results, context_used, context_window}. Token totals are
    summed from this run's own model calls, because the final event counts the whole conversation."""

    def __init__(self, cwd: str):
        """`cwd` is the folder the agent works in (paths are shown relative to it)."""
        self.cwd = cwd
        self.text: dict[int, str] = {}
        self.announced: set[tuple[str, int]] = set()
        self.tokens_in = 0
        self.tokens_out = 0
        self.conversation: str | None = None
        # what the board's rules refused during this run (a headless Antigravity run ends its turn at a refusal)
        self.refused: list[str] = []

    def feed(self, line: str) -> dict:
        """One line of stdout."""
        out: dict = {
            "steps": [],
            "files": [],
            "session_id": None,
            "result": None,
            "ready": False,
            "results": [],
            "context_used": None,
            "context_window": None,
        }
        line = line.strip()
        if not line.startswith("{"):
            return out
        try:
            ev = json.loads(line)
        except ValueError:
            return out
        kind = ev.get("event")
        if kind == "init":
            init = ev.get("init") or {}
            self.conversation = ev.get("conversation_id") or self.conversation
            out.update(
                ready=True,
                session_id=self.conversation,
                model=init.get("model"),
            )
        elif kind == "step_update":
            self._step(ev.get("step_update") or {}, out)
        elif kind == "result":
            res = ev.get("result") or {}
            ok = res.get("status") == "SUCCESS"
            out["session_id"] = res.get("conversation_id")
            for denied in res.get("denied_actions") or []:
                label = (
                    denied.get("display_name") or denied.get("action") or "an action"
                )
                if str(label) not in self.refused:
                    self.refused.append(str(label))
                out["steps"].append(
                    {
                        "kind": "error",
                        "text": f"Not allowed for this run: {_short(str(label), 80)}. A headless run cannot ask, so the board's rules decide.",
                    }
                )
            out["result"] = {
                "is_error": not ok,
                "subtype": None if ok else str(res.get("status") or "error").lower(),
                "text": redact(str(res.get("response") or res.get("error") or "")),
                "cost_usd": 0.0,
                "tokens_in": self.tokens_in,
                "tokens_out": self.tokens_out,
                "turns": res.get("num_turns"),
                "refused": list(dict.fromkeys(self.refused)),
            }
        return out

    def _step(self, step: dict, out: dict) -> None:
        index = int(step.get("step_index") or 0)
        state = step.get("state")
        stype = step.get("step_type")
        if stype == "agent_response":
            self.text[index] = self.text.get(index, "") + str(
                step.get("text_delta") or ""
            )
            if state == "DONE":
                text = self.text.pop(index, "").strip()
                usage = step.get("usage") or {}
                held = int(usage.get("input_tokens") or 0) + int(
                    usage.get("cache_read_tokens") or 0
                )
                self.tokens_in += held
                self.tokens_out += int(usage.get("output_tokens") or 0) + int(
                    usage.get("thinking_tokens") or 0
                )
                if held:
                    out["context_used"] = held
                if text:
                    out["steps"].append(
                        {"kind": "say", "text": redact(_short(text, 300))}
                    )
            return
        if stype != "tool":
            return
        tool_id = f"{self.conversation or step.get('conversation_id')}:{index}"
        info = step.get("tool_info") or {}
        if ("tool", index) not in self.announced:
            self.announced.add(("tool", index))
            k, text, change = describe_agy_tool(
                step.get("tool_name") or info.get("name") or "",
                info.get("parameters") or {},
                self.cwd,
            )
            out["steps"].append({"kind": k, "text": redact(text), "tool_id": tool_id})
            if change and state != "ERROR":
                out["files"].append(change)
        if state in ("DONE", "ERROR"):
            error = info.get("error") or {}
            message = str(error.get("message") or "") if state == "ERROR" else ""
            output = message or str(info.get("output") or "")
            out["results"].append(
                {
                    "tool_id": tool_id,
                    "output": redact(output)[:4000],
                    "is_error": state == "ERROR",
                    "exit_code": 1 if state == "ERROR" else 0,
                }
            )
            if state == "ERROR" and "permission" in message.lower():
                self.refused.append(_short(message, 200))
            if state == "ERROR":
                out["steps"].append(
                    {
                        "kind": "error",
                        "text": redact(_short(message, 240)),
                        "tool_id": tool_id,
                    }
                )
