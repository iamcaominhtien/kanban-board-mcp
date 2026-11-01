"""An AI in trouble: notice, diagnose, then act (design/screens/ai-operations.md, C).

Not a timeout, which would kill long builds, but a ladder:

1. **Notice** by code: no new stream event for a while while the run is marked running, or one tool call that has
   been open too long.
2. **Diagnose** by code first: is the process alive and busy, what is the open tool call, does it look like a server
   that never ends or a command waiting for a key, is an MCP call open, is a child eating memory. Only when that is
   inconclusive does a light model (Haiku) read the last steps, and its answer is a proposal, never applied.
3. **Act** with what the diagnosis allows: wait, stop one child process, continue with a note, or hand it to a person
   (Needs you). A standing order (wave 3) may apply the action by itself.

`RunWatch` follows one CLI's stream (fed every line by the runner); `diagnose` reads the process with psutil.
"""

import asyncio
import json
import logging
import re
import time
from datetime import UTC, datetime

import psutil

logger = logging.getLogger(__name__)

HANG_AFTER_S = 10 * 60  # no stream event at all for this long: look at it
SERVER_AFTER_S = 2 * 60  # an open command that looks like a server, for this long
INPUT_AFTER_S = 60  # an open command that waits for a key, for this long
MCP_AFTER_S = 15 * 60  # an open board call: the board's own fault
SLOW_AFTER_S = 30 * 60  # a busy command this long gets a card that only offers to wait
CPU_BUSY = 3.0  # percent: above this, something is working

_SERVER = re.compile(
    r"(\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|preview|watch)\b"
    r"|\bvite(\s|$)(?!build)|\bnext\s+(dev|start)\b|\buvicorn\b|\bgunicorn\b|\bflask\s+run\b|\bfastapi\s+(dev|run)\b"
    r"|\bmanage\.py\s+runserver\b|\brails\s+s(erver)?\b|\bhttp\.server\b|\bnodemon\b|\s--watch\b|\bwebpack(-dev-server|\s+serve)\b"
    r"|\bng\s+serve\b|\bjekyll\s+serve\b|\bhugo\s+server\b|\bdocker[- ]compose\s+up\b(?!.*\s-d\b)|\btail\s+-f\b"
    r"|\bstorybook\b|\bexpo\s+start\b|\bphp\s+-S\b|\bjupyter\s+(notebook|lab)\b)",
    re.IGNORECASE,
)
_INPUT = re.compile(
    r"(\bgit\s+commit\b(?!.*\s(-m|-F|--message|--file|-C|--reuse-message|--no-edit)\b)"
    r"|\bgit\s+rebase\s+(-i|--interactive)\b|\bgit\s+merge\b(?!.*--no-edit)(?!.*--abort)(?!.*--ff-only)"
    r"|\bnpx\s+(?!.*(-y|--yes)\b)|\bnpm\s+init\b(?!.*(-y|--yes)\b)|\b(vi|vim|nvim|nano|emacs|less|more|top|htop)\b(\s|$)"
    r"|\bread\s+-p\b|^\s*(python3?|node|irb|psql|mysql|sqlite3)\s*$|\bssh\s+\S+\s*$)",
    re.IGNORECASE,
)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


class RunWatch:
    """What the board can see of one CLI from its stream, at no cost."""

    def __init__(self) -> None:
        """Nothing seen yet; the clock starts now."""
        self.last_event = time.monotonic()
        self.open: dict[str, dict] = {}  # tool_use id -> {name, input, at}
        self.quota: dict | None = (
            None  # the last rate_limit_event, parsed (services/ai/quota.py)
        )
        self.results = 0
        self.reported: str | None = (
            None  # the cause last reported, so a card is written once per cause
        )
        self.reported_at: float | None = None
        self.snooze_until: float = 0.0
        self.mcp_errors = (
            0  # board calls that failed on the board's side (board faults)
        )

    def observe(self, line: str) -> dict | None:
        """One stdout line: the parsed event, or None."""
        line = (line or "").strip()
        if not line.startswith("{"):
            if line:
                self.last_event = time.monotonic()
            return None
        try:
            ev = json.loads(line)
        except ValueError:
            return None
        self.last_event = time.monotonic()
        kind = ev.get("type")
        if kind == "assistant":
            for block in (ev.get("message") or {}).get("content") or []:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    self.open[block.get("id") or ""] = {
                        "name": block.get("name") or "",
                        "input": block.get("input") or {},
                        "at": time.monotonic(),
                    }
        elif kind == "user":
            for block in (ev.get("message") or {}).get("content") or []:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    self.open.pop(block.get("tool_use_id") or "", None)
        elif kind == "result":
            self.results += 1
            self.open.clear()
        elif kind == "rate_limit_event":
            from . import quota

            self.quota = quota.parse_event(ev)
        return ev

    def quiet_s(self) -> float:
        """Seconds since the last stream event."""
        return time.monotonic() - self.last_event

    def longest_open(self) -> tuple[str, dict, float] | None:
        """(id, call, seconds open) of the oldest open tool call."""
        if not self.open:
            return None
        tid, call = min(self.open.items(), key=lambda kv: kv[1]["at"])
        return tid, call, time.monotonic() - call["at"]

    def moved(self) -> None:
        """The run produced something again: whatever was reported no longer holds."""
        self.reported = None
        self.reported_at = None


def _tree(pid: int | None) -> tuple[psutil.Process | None, list[psutil.Process]]:
    if not pid:
        return None, []
    try:
        proc = psutil.Process(pid)
        return proc, proc.children(recursive=True)
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return None, []


def _cmd(p: psutil.Process) -> str:
    try:
        return " ".join(p.cmdline())[:300] or p.name()
    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
        return "?"


def _sample(pid: int | None) -> dict:
    """The process tree's state: alive, CPU % (one short sample), RSS, children with their own CPU and RSS."""
    proc, children = _tree(pid)
    if proc is None:
        return {"alive": False, "cpu": 0.0, "rss_mb": 0.0, "children": []}
    every = [proc, *children]
    for p in every:
        try:
            p.cpu_percent(None)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    time.sleep(0.5)
    out = []
    total_cpu = 0.0
    for p in every:
        try:
            cpu = p.cpu_percent(None)
            rss = p.memory_info().rss / (1024 * 1024)
            status = p.status()
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue
        total_cpu += cpu
        if p.pid != proc.pid:
            out.append(
                {
                    "pid": p.pid,
                    "cmd": _cmd(p),
                    "cpu": round(cpu, 1),
                    "rss_mb": round(rss, 1),
                    "status": status,
                }
            )
    try:
        own_rss = proc.memory_info().rss / (1024 * 1024)
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        own_rss = 0.0
    return {
        "alive": True,
        "cpu": round(total_cpu, 1),
        "rss_mb": round(own_rss, 1),
        "children": out,
    }


def _minutes(seconds: float) -> str:
    m = int(seconds // 60)
    return f"{m} minute{'' if m == 1 else 's'}" if m >= 1 else f"{int(seconds)} seconds"


def _child_for(command: str, children: list[dict]) -> dict | None:
    """The child process that runs `command` (the deepest match), else the busiest one."""
    words = [w for w in re.split(r"\s+", command or "") if len(w) > 2][:4]
    best = None
    for c in children:
        if words and all(w in c["cmd"] for w in words[:2]):
            best = c
    if best is None and children:
        best = max(children, key=lambda c: (c["cpu"], c["rss_mb"]))
    return best


async def diagnose(
    watch: RunWatch, pid: int | None, *, hang_after_s: float = HANG_AFTER_S
) -> dict | None:
    """The board's reading of a run that may be in trouble, by code, or None when nothing is wrong yet."""
    quiet = watch.quiet_s()
    open_call = watch.longest_open()
    open_for = open_call[2] if open_call else 0.0
    if open_call is None and quiet < hang_after_s:
        return None
    if open_call is not None and quiet < min(
        hang_after_s, SERVER_AFTER_S, INPUT_AFTER_S
    ):
        return None
    state = await asyncio.to_thread(_sample, pid)
    base = {
        "at": _now_iso(),
        "by": "code",
        "quiet_s": int(quiet),
        "process": {
            "alive": state["alive"],
            "cpu": state["cpu"],
            "rss_mb": state["rss_mb"],
        },
        "tried": [],
    }
    if watch.quota and watch.quota.get("status") == "rejected":
        return None  # a used-up window is not a hang; the runner holds the account when the CLI says so
    if not state["alive"]:
        return None  # the CLI is gone: its exit is handled where it is read
    if open_call is not None:
        tid, call, open_for = open_call
        name = call["name"]
        command = str(call["input"].get("command") or "") if name == "Bash" else ""
        if name.startswith("mcp__") and open_for >= MCP_AFTER_S:
            return {
                **base,
                "cause": "mcp_stuck",
                "board_fault": True,
                "trigger": f"A board call has been open for {_minutes(open_for)}",
                "what": f"The AI called {name.split('__')[-1]} {_minutes(open_for)} ago and the board has not answered.",
                "means": "A board tool stopped answering altogether. This is the board's own fault, not the AI's.",
                "actions": ["continue_note", "wait", "cancel"],
                "confidence": "high",
            }
        if command:
            child = _child_for(command, state["children"])
            busy = (child and child["cpu"] >= CPU_BUSY) or state["cpu"] >= CPU_BUSY * 2
            if _SERVER.search(command) and open_for >= SERVER_AFTER_S:
                return {
                    **base,
                    "cause": "foreground_server",
                    "trigger": f"No output for {_minutes(quiet)}",
                    "what": f"The last step ran `{command[:120]}` in the foreground {_minutes(open_for)} ago and it has not returned.",
                    "means": "A server does not end by itself, so the run is waiting for a command that will never return. The work before it is intact.",
                    "child": child,
                    "lesson": f"Start long-running servers in the background (for example `{command[:60]} &` with its output in a log file), never in the foreground.",
                    "actions": ["stop_child", "tell_ai", "wait", "cancel"],
                    "confidence": "high",
                }
            stopped = child and child.get("status") in (
                psutil.STATUS_STOPPED,
                getattr(psutil, "STATUS_TRACING_STOP", "tracing-stop"),
            )
            if (
                (_INPUT.search(command) or stopped)
                and open_for >= INPUT_AFTER_S
                and not busy
            ):
                return {
                    **base,
                    "cause": "waiting_input",
                    "trigger": f"No output for {_minutes(quiet)}",
                    "what": f"`{command[:120]}` has been waiting for {_minutes(open_for)} with no CPU.",
                    "means": "Something is waiting for a key nobody will press: an editor, a confirmation prompt, a REPL.",
                    "child": child,
                    "lesson": "Run commands non-interactively (git commit -m, npx --yes, npm init -y) so nothing waits for a key.",
                    "actions": ["stop_child", "tell_ai", "wait", "cancel"],
                    "confidence": "high" if _INPUT.search(command) else "medium",
                }
            if busy:
                if open_for < SLOW_AFTER_S:
                    return None  # a long build or test, still working: not a hang
                return {
                    **base,
                    "cause": "busy",
                    "trigger": f"One command has run for {_minutes(open_for)}",
                    "what": f"`{command[:120]}` is still working ({child['cpu'] if child else state['cpu']}% CPU).",
                    "means": "A long build or test. Not a hang, only slow.",
                    "child": child,
                    "actions": ["wait", "stop_child", "cancel"],
                    "confidence": "high",
                }
            heavy = max(state["children"], key=lambda c: c["rss_mb"], default=None)
            if (
                heavy
                and heavy["rss_mb"] > 2048
                and heavy["rss_mb"] > 3 * max(state["rss_mb"], 1)
            ):
                return {
                    **base,
                    "cause": "memory_child",
                    "trigger": f"No output for {_minutes(quiet)}",
                    "what": f"`{heavy['cmd'][:120]}` holds {heavy['rss_mb'] / 1024:.1f} GB.",
                    "means": "A child process is eating memory, not the CLI itself.",
                    "child": heavy,
                    "actions": ["stop_child", "continue_note", "cancel"],
                    "confidence": "medium",
                }
        if quiet < hang_after_s and open_for < hang_after_s:
            return None
    if quiet < hang_after_s:
        return None
    if state["cpu"] >= CPU_BUSY * 2:
        return None  # the CLI itself is busy (thinking, compacting): give it time
    last = open_call[1]["name"] if open_call else None
    return {
        **base,
        "cause": "unknown",
        "trigger": f"No output for {_minutes(quiet)}",
        "what": (
            f"The run has produced nothing for {_minutes(quiet)}"
            + (
                f"; its last call, {last}, is still open"
                if last
                else "; no tool call is open"
            )
            + f". The process is alive, CPU {state['cpu']}%."
        ),
        "means": "The board cannot tell why from the process alone.",
        "actions": ["continue_note", "wait", "cancel"],
        "confidence": "low",
    }


def stop_child(pid: int) -> bool:
    """Stop one child process and what it started; the run goes on and its tool call returns."""
    try:
        proc = psutil.Process(pid)
        for p in [*proc.children(recursive=True), proc]:
            try:
                p.terminate()
            except psutil.NoSuchProcess:
                pass
        _, alive = psutil.wait_procs([proc], timeout=3)
        for p in alive:
            p.kill()
        return True
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return False


MODEL_PROMPT = (
    "You are diagnosing an AI coding agent that has stopped producing output. Read its last steps and the state of "
    "its process, then answer with ONE JSON object and nothing else: "
    '{"cause": short phrase, "means": one sentence for a person, "action": one of '
    '"wait" | "stop_child" | "continue_note" | "needs_person", "note": what to tell the agent if it continues, '
    '"lesson": a one-line lesson for the project, or ""}.\n\n'
)


def model_prompt(diagnosis: dict, steps: list[dict]) -> str:
    """What the light model reads: the board's own reading and the last steps."""
    tail = [
        {
            k: s.get(k)
            for k in ("at", "kind", "text", "exit_code")
            if s.get(k) is not None
        }
        for s in steps[-15:]
    ]
    return (
        MODEL_PROMPT
        + "Board's reading: "
        + json.dumps(
            {k: diagnosis.get(k) for k in ("trigger", "what", "process")},
            ensure_ascii=False,
        )
        + "\nLast steps: "
        + json.dumps(tail, ensure_ascii=False)
    )


def parse_model_answer(text: str) -> dict | None:
    """The light model's JSON answer, or None when it gave none."""
    m = re.search(r"\{.*\}", text or "", re.DOTALL)
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
    except ValueError:
        return None
    if data.get("action") not in (
        "wait",
        "stop_child",
        "continue_note",
        "needs_person",
    ):
        data["action"] = "needs_person"
    return {
        k: str(data.get(k) or "")[:400]
        for k in ("cause", "means", "action", "note", "lesson")
    }
