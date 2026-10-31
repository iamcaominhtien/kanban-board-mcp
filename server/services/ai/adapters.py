"""Headless runners for the local CLIs other than Claude Code: Codex, opencode and Antigravity (``agy``).

Each adapter says three things: how to start the CLI for one run (``launch``), how to read its output into the same
steps, files and result the run panel already shows for Claude Code (``parser``), and how to ask whether it is signed
in. The run lifecycle (queue, timeouts, cancel, pause, summary, status moves) stays in ``runs.py``; Claude Code
keeps its own code there.

How each CLI is held to the member's permissions (the board never passes a flag that skips permission checks):

* Codex: ``exec`` with the ``read-only`` sandbox for a question or in safe mode, ``workspace-write`` otherwise. Its
  sandbox cannot express Claude-style Allow/Deny tool rules, so those are not applied (the capability matrix says so).
* opencode: a permission map in ``OPENCODE_CONFIG_CONTENT`` (everything denied, then the Allow rules, then the Deny
  rules); the file edit tool is denied for a question or in safe mode.
* Antigravity: ``--mode accept-edits`` (``plan`` for a question or in safe mode) and command Allow rules in
  ``--settings``; a command with no rule is denied in headless mode.

The run's token reaches the CLI through its environment, never through its command line or a shared file: Codex
reads it from ``KANBAN_RUN_TOKEN``, opencode gets it inside ``OPENCODE_CONFIG_CONTENT``, and Antigravity starts the
stdio bridge (``mcp_bridge.py``) that its account's MCP config names, which reads it from its own environment.
"""

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from . import cli
from .secrets import redact

TOKEN_ENV = "KANBAN_RUN_TOKEN"
URL_ENV = "KANBAN_MCP_URL"
# Flags a member's "extra flags" may never add: they switch the CLI's permission checks or sandbox off
UNSAFE_FLAGS = (
    "dangerously",
    "bypass",
    "danger-full-access",
    "--yolo",
    "--auto",
    "approve-for-me",
    "--sandbox=",
)


@dataclass
class Spec:
    """Everything one run needs to start a CLI."""

    path: str
    cwd: str
    prompt: str  # the ticket or question, with the board's instructions already put in front
    model: str | None
    mcp_url: str  # the board's MCP endpoint, ending in /mcp/
    token: str
    allowed: list[str] = field(
        default_factory=list
    )  # Claude-style Allow rules, ``Bash(git status:*)``
    denied: list[str] = field(default_factory=list)
    read_only: bool = False  # a question, or safe mode: nothing may be changed
    resume_id: str | None = None
    effort: str | None = None
    extra_flags: list[str] = field(default_factory=list)


@dataclass
class Launch:
    """The command line and the environment variables to add for one run."""

    args: list[str]
    env: dict[str, str] = field(default_factory=dict)
    notes: list[str] = field(
        default_factory=list
    )  # first steps of the run: what was and was not applied


def _short(text: str, n: int = 160) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= n else text[: n - 1] + "…"


def _safe_flags(flags: list[str]) -> list[str]:
    return [
        f for f in flags if isinstance(f, str) and not any(b in f for b in UNSAFE_FLAGS)
    ]


def _empty() -> dict:
    return {
        "steps": [],
        "files": [],
        "session_id": None,
        "result": None,
        "ready": False,
        "results": [],
    }


def _count_diff(diff: str) -> tuple[int, int]:
    """(added, removed) lines of a unified diff."""
    added = removed = 0
    for ln in (diff or "").splitlines():
        if ln.startswith("+") and not ln.startswith("+++"):
            added += 1
        elif ln.startswith("-") and not ln.startswith("---"):
            removed += 1
    return added, removed


def _inner_command(command: str) -> str:
    """Codex runs ``/bin/zsh -lc "<what the model wrote>"``: show what the model wrote."""
    m = re.match(r"^(?:\S*/)?(?:ba|z|da)?sh -l?c (.+)$", command.strip(), re.DOTALL)
    if not m:
        return command
    inner = m.group(1).strip()
    if len(inner) >= 2 and inner[0] == inner[-1] and inner[0] in "'\"":
        inner = inner[1:-1]
    return inner


class Parser:
    """Reads the CLI's stdout one line at a time. Kept per run because some CLIs say the answer and the end of the
    turn in separate lines."""

    def __init__(self, cwd: str):
        """Remember the run's folder, to show paths relative to it."""
        self.cwd = cwd

    def feed(self, line: str) -> dict:
        """One line → {steps, files, session_id, result, ready, results} (see ``cli.parse_stream_line``)."""
        raise NotImplementedError


class Adapter:
    """One CLI: its names, how to start it and how to read it."""

    provider = ""
    cli = ""  # the AI account CLI key
    binary = ""
    label = ""
    # Text of an error that means the earlier session is gone, so the run starts a new one
    resume_missing = ("no conversation", "session not found", "not found")
    needs_account = False  # refuse to run without an AI account

    def launch(self, spec: Spec) -> Launch:
        """The command and environment of one run."""
        raise NotImplementedError

    def parser(self, cwd: str) -> Parser:
        """A fresh output reader for one run."""
        raise NotImplementedError

    def test_args(self, path: str, model: str | None) -> Launch:
        """A one-word run in the CLI's safest mode, for "Run test"."""
        return self.launch(
            Spec(
                path=path,
                cwd=".",
                prompt="Reply with exactly the word: pong",
                model=model,
                mcp_url="",
                token="",
                read_only=True,
            ),
        )

    def login_command(self, path: str) -> list[str] | None:
        """A command that exits 0 when the CLI is signed in, or None when there is no cheap check."""
        return None


# --------------------------------------------------------------------------- Codex


class CodexParser(Parser):
    """``codex exec --json``: thread.started, item.started / item.completed (agent_message, command_execution,
    file_change, mcp_tool_call, reasoning), turn.completed with usage, error and turn.failed."""

    def __init__(self, cwd: str):
        """Start with no answer yet."""
        super().__init__(cwd)
        self.last_text = ""
        self.tokens_in = 0
        self.tokens_out = 0
        self.turns = 0
        self.failure: str | None = None

    def feed(self, line: str) -> dict:
        """Read one event."""
        out = _empty()
        line = line.strip()
        if not line.startswith("{"):
            return out
        try:
            ev = json.loads(line)
        except ValueError:
            return out
        kind = ev.get("type")
        item = ev.get("item") or {}
        itype = item.get("type")
        if kind == "thread.started":
            out["ready"] = True
            out["session_id"] = ev.get("thread_id")
        elif kind == "item.started" and itype == "command_execution":
            out["steps"].append(
                {
                    "kind": "command",
                    "text": redact(
                        f"Ran {_short(_inner_command(item.get('command') or ''), 120)}"
                    ),
                    "tool_id": item.get("id"),
                }
            )
        elif kind == "item.completed" and itype == "command_execution":
            code = item.get("exit_code")
            out["results"].append(
                {
                    "tool_id": item.get("id"),
                    "output": redact(item.get("aggregated_output") or "")[:4000],
                    "is_error": bool(code),
                    "exit_code": int(code or 0),
                }
            )
        elif kind == "item.completed" and itype == "file_change":
            for change in item.get("changes") or []:
                path = cli._rel(change.get("path") or "", self.cwd)
                new = change.get("kind") == "add"
                out["steps"].append(
                    {
                        "kind": "create" if new else "edit",
                        "text": f"{'Wrote' if new else 'Edited'} {path}",
                        "tool_id": item.get("id"),
                    }
                )
                out["files"].append(
                    {"path": path, "added": 0, "removed": 0, "new": new}
                )
        elif kind == "item.started" and itype == "mcp_tool_call":
            tool = item.get("tool") or item.get("name") or "tool"
            out["steps"].append(
                {"kind": "board", "text": f"board.{tool}()", "tool_id": item.get("id")}
            )
        elif kind == "item.completed" and itype == "agent_message":
            text = (item.get("text") or "").strip()
            if text:
                self.last_text = text
                out["steps"].append({"kind": "say", "text": redact(_short(text, 300))})
        elif kind == "turn.completed":
            usage = ev.get("usage") or {}
            self.tokens_in += int(usage.get("input_tokens") or 0)
            self.tokens_out += int(usage.get("output_tokens") or 0)
            self.turns += 1
            out["result"] = {
                "is_error": False,
                "subtype": "success",
                "text": redact(self.last_text),
                "cost_usd": 0.0,
                "tokens_in": self.tokens_in,
                "tokens_out": self.tokens_out,
                "turns": self.turns,
            }
        elif kind in ("error", "turn.failed"):
            message = ev.get("message") or (ev.get("error") or {}).get("message") or ""
            self.failure = redact(_short(str(message), 300))
            out["steps"].append({"kind": "error", "text": self.failure})
            out["result"] = {
                "is_error": True,
                "subtype": "error",
                "text": self.failure,
                "cost_usd": 0.0,
                "tokens_in": self.tokens_in,
                "tokens_out": self.tokens_out,
                "turns": self.turns,
            }
        return out


class CodexAdapter(Adapter):
    """Codex CLI (``codex exec --json``)."""

    provider = "codex"
    cli = "codex"
    binary = "codex"
    label = "Codex"

    def launch(self, spec: Spec) -> Launch:
        """``codex exec [resume <id>] --json -s <sandbox> -C <folder> -c mcp_servers.kanban...``."""
        args = [spec.path, "exec"]
        if spec.resume_id:
            args += ["resume"]
        args += [
            "--json",
            "--skip-git-repo-check",
            "-s",
            "read-only" if spec.read_only else "workspace-write",
            "-C",
            spec.cwd,
        ]
        if spec.model:
            args += ["-m", spec.model]
        if spec.effort:
            args += ["-c", f"model_reasoning_effort={json.dumps(spec.effort)}"]
        env: dict[str, str] = {}
        if spec.mcp_url:
            args += [
                "-c",
                f"mcp_servers.kanban.url={json.dumps(spec.mcp_url)}",
                "-c",
                f"mcp_servers.kanban.bearer_token_env_var={json.dumps(TOKEN_ENV)}",
            ]
            env[TOKEN_ENV] = spec.token
        args += _safe_flags(spec.extra_flags)
        if spec.resume_id:
            args += [spec.resume_id]
        args += [spec.prompt if not spec.prompt.startswith("-") else " " + spec.prompt]
        note = (
            "Codex runs in its own sandbox: read-only for a question"
            if spec.read_only
            else "Codex runs in its workspace-write sandbox (the Allow and Deny tool rules do not apply to it)"
        )
        return Launch(args, env, [note])

    def parser(self, cwd: str) -> Parser:
        """A Codex event reader."""
        return CodexParser(cwd)

    def login_command(self, path: str) -> list[str] | None:
        """``codex login status`` exits 0 when signed in."""
        return [path, "login", "status"]


# --------------------------------------------------------------------------- opencode


def opencode_permissions(
    allowed: list[str], denied: list[str], read_only: bool
) -> dict:
    """The board's Allow/Deny rules as an opencode ``permission`` map. Last match wins, so it is the catch-all deny,
    then the allows, then the denies. ``Bash(git status:*)`` becomes the pattern ``git status*``."""
    bash: dict[str, str] = {"*": "deny"}
    if not read_only:
        for rule in allowed:
            m = re.match(r"^Bash\((.*?)(?::\*)?\)$", rule)
            if m:
                bash[m.group(1) + "*"] = "allow"
            elif rule == "Bash":
                bash["*"] = "allow"
        for rule in denied:
            m = re.match(r"^Bash\((.*?)(?::\*)?\)$", rule)
            if m:
                bash[m.group(1) + "*"] = "deny"
    return {
        "edit": "deny"
        if read_only or not any(r.split("(")[0] in ("Edit", "Write") for r in allowed)
        else "allow",
        "bash": bash,
        "webfetch": "deny",
    }


class OpencodeParser(Parser):
    """``opencode run --format json``: step_start, tool_use (one event with the call and its result), text,
    step_finish with tokens and a reason (``stop`` ends the turn), error."""

    def __init__(self, cwd: str):
        """Start with no answer yet."""
        super().__init__(cwd)
        self.last_text = ""
        self.tokens_in = 0
        self.tokens_out = 0
        self.cost = 0.0
        self.steps = 0

    def _result(self, is_error: bool, text: str) -> dict:
        return {
            "is_error": is_error,
            "subtype": "error" if is_error else "success",
            "text": redact(text),
            "cost_usd": self.cost,
            "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out,
            "turns": self.steps,
        }

    def feed(self, line: str) -> dict:
        """Read one event."""
        out = _empty()
        line = line.strip()
        if not line.startswith("{"):
            return out
        try:
            ev = json.loads(line)
        except ValueError:
            return out
        kind = ev.get("type")
        part = ev.get("part") or {}
        if ev.get("sessionID"):
            out["session_id"] = ev["sessionID"]
        if kind == "step_start":
            out["ready"] = True
        elif kind == "tool_use":
            self._tool(part, out)
        elif kind == "text":
            text = (part.get("text") or "").strip()
            if text:
                self.last_text = text
                out["steps"].append({"kind": "say", "text": redact(_short(text, 300))})
        elif kind == "step_finish":
            tokens = part.get("tokens") or {}
            self.tokens_in += int(tokens.get("input") or 0) + int(
                (tokens.get("cache") or {}).get("read") or 0
            )
            self.tokens_out += int(tokens.get("output") or 0)
            self.cost += float(part.get("cost") or 0)
            self.steps += 1
            if part.get("reason") == "stop":
                out["result"] = self._result(False, self.last_text)
        elif kind == "error":
            err = ev.get("error") or {}
            message = (
                err.get("message")
                or (err.get("data") or {}).get("message")
                or err.get("name")
                or "opencode reported an error"
            )
            text = redact(_short(str(message), 300))
            out["steps"].append({"kind": "error", "text": text})
            out["result"] = self._result(True, text)
        return out

    def _tool(self, part: dict, out: dict) -> None:
        state = part.get("state") or {}
        tool = part.get("tool") or ""
        inp = state.get("input") or {}
        call_id = part.get("callID")
        meta = state.get("metadata") or {}
        if tool == "bash":
            kind, text = "command", f"Ran {_short(inp.get('command') or '', 120)}"
        elif tool in ("edit", "write", "patch", "multiedit"):
            path = cli._rel(inp.get("filePath") or "", self.cwd)
            new = tool == "write"
            added, removed = _count_diff(meta.get("diff") or "")
            if new and not added:
                added = len((inp.get("content") or "").splitlines())
            kind, text = (
                "create" if new else "edit",
                f"{'Wrote' if new else 'Edited'} {path}",
            )
            if state.get("status") == "completed":
                out["files"].append(
                    {"path": path, "added": added, "removed": removed, "new": new}
                )
        elif tool == "read":
            kind, text = "read", f"Read {cli._rel(inp.get('filePath') or '', self.cwd)}"
        elif tool in ("grep", "glob", "list"):
            kind, text = (
                "search",
                f"Searched {_short(inp.get('pattern') or inp.get('path') or '', 80)}",
            )
        elif tool.startswith("kanban_"):
            name = tool[len("kanban_") :]
            target = inp.get("ticket_id") or inp.get("project_id") or ""
            action = inp.get("action")
            kind, text = (
                "board",
                f"board.{'.'.join(x for x in (name, action) if x)}({target})",
            )
        else:
            kind, text = "tool", f"{tool} {_short(json.dumps(inp), 80)}"
        out["steps"].append({"kind": kind, "text": redact(text), "tool_id": call_id})
        status = state.get("status")
        if status in ("completed", "error"):
            code = meta.get("exit")
            failed = status == "error" or bool(code)
            out["results"].append(
                {
                    "tool_id": call_id,
                    "output": redact(
                        str(state.get("output") or state.get("error") or "")
                    )[:4000],
                    "is_error": failed,
                    "exit_code": int(code)
                    if isinstance(code, int)
                    else (1 if failed else 0),
                }
            )
            if status == "error":
                out["steps"].append(
                    {
                        "kind": "error",
                        "text": redact(_short(str(state.get("error") or ""), 240)),
                        "tool_id": call_id,
                    }
                )


class OpencodeAdapter(Adapter):
    """opencode (``opencode run --format json``)."""

    provider = "opencode"
    cli = "opencode"
    binary = "opencode"
    label = "opencode"

    def launch(self, spec: Spec) -> Launch:
        """``opencode run --format json --dir <folder> [-s <id>] [-m <model>] <prompt>`` with the config in the env."""
        args = [spec.path, "run", "--format", "json", "--dir", spec.cwd]
        if spec.resume_id:
            args += ["-s", spec.resume_id]
        if spec.model:
            args += ["-m", spec.model]
        if spec.effort:
            args += ["--variant", spec.effort]
        args += _safe_flags(spec.extra_flags)
        args += ["--", spec.prompt]
        config: dict = {
            "permission": opencode_permissions(
                spec.allowed, spec.denied, spec.read_only
            )
        }
        if spec.mcp_url:
            config["mcp"] = {
                "kanban": {
                    "type": "remote",
                    "url": spec.mcp_url,
                    "headers": {"Authorization": f"Bearer {spec.token}"},
                    "enabled": True,
                }
            }
        return Launch(
            args,
            {"OPENCODE_CONFIG_CONTENT": json.dumps(config)},
            [
                "opencode: tools are held to the Allow and Deny rules (everything else is denied)"
                if not spec.read_only
                else "opencode: a question, so file edits and commands are denied"
            ],
        )

    def parser(self, cwd: str) -> Parser:
        """An opencode event reader."""
        return OpencodeParser(cwd)


# --------------------------------------------------------------------------- Antigravity


def agy_command_rules(allowed: list[str]) -> list[str]:
    """Claude-style ``Bash(git status:*)`` Allow rules as Antigravity ``command(git status)`` rules (a rule matches
    the command and anything after it, on a word boundary)."""
    rules = []
    for rule in allowed:
        m = re.match(r"^Bash\((.*?)(?::\*)?\)$", rule)
        if m and m.group(1).strip():
            rules.append(f"command({m.group(1).strip()})")
    return sorted(set(rules))


_FILE_LINK = re.compile(r"\[([^\]]*)\]\(file://[^)]*\)")


class AgyParser(Parser):
    """``agy -p --output-format stream-json``: ``{"event": "init" | "step_update" | "result"}``. A tool step goes
    ACTIVE then DONE or ERROR; the answer is in the ``result`` event."""

    def feed(self, line: str) -> dict:
        """Read one event."""
        out = _empty()
        line = line.strip()
        if not line.startswith("{"):
            return out
        try:
            ev = json.loads(line)
        except ValueError:
            return out
        kind = ev.get("event")
        if kind == "init":
            out["ready"] = True
            out["session_id"] = ev.get("conversation_id")
        elif kind == "step_update":
            self._step(ev.get("step_update") or {}, out)
        elif kind == "result":
            res = ev.get("result") or {}
            usage = res.get("usage") or {}
            denied = res.get("denied_actions") or []
            if denied:
                names = ", ".join(sorted({d.get("action") or "?" for d in denied}))
                out["steps"].append(
                    {
                        "kind": "error",
                        "text": f"Antigravity denied: {names}. Headless mode cannot ask; add an Allow rule for the command.",
                    }
                )
            bad = res.get("status") not in (None, "SUCCESS")
            out["result"] = {
                "is_error": bad,
                "subtype": "error" if bad else "success",
                "text": redact(_FILE_LINK.sub(r"\1", res.get("response") or "")),
                "cost_usd": 0.0,
                "tokens_in": int(usage.get("input_tokens") or 0)
                + int(usage.get("cache_read_tokens") or 0),
                "tokens_out": int(usage.get("output_tokens") or 0),
                "turns": res.get("num_turns"),
            }
            out["session_id"] = res.get("conversation_id")
        return out

    def _step(self, step: dict, out: dict) -> None:
        if step.get("step_type") != "tool" or step.get("state") not in (
            "DONE",
            "ERROR",
        ):
            return
        name = step.get("tool_name") or ""
        info = step.get("tool_info") or {}
        params = info.get("parameters") or {}
        index = f"step{step.get('step_index')}"
        path = cli._rel(
            params.get("Path") or params.get("AbsolutePath") or "", self.cwd
        )
        if name == "run_command":
            kind, text = (
                "command",
                f"Ran {_short(params.get('CommandLine') or '', 120)}",
            )
        elif name in ("edit_file", "write_file", "create_file", "replace_file_content"):
            new = name in ("write_file", "create_file")
            kind, text = (
                "create" if new else "edit",
                f"{'Wrote' if new else 'Edited'} {path}",
            )
            if step.get("state") == "DONE":
                out["files"].append(
                    {"path": path, "added": 0, "removed": 0, "new": new}
                )
        elif name in ("read_file", "view_file"):
            kind, text = "read", f"Read {path}"
        elif "search" in name or "grep" in name or "find" in name or name == "list_dir":
            kind, text = "search", f"Searched {_short(json.dumps(params), 80)}"
        elif "kanban" in name or name.startswith("mcp"):
            kind, text = "board", f"board.{name}()"
        else:
            kind, text = "tool", f"{name} {_short(json.dumps(params), 80)}"
        out["steps"].append({"kind": kind, "text": redact(text), "tool_id": index})
        err = info.get("error") or {}
        failed = step.get("state") == "ERROR"
        output = err.get("message") if failed else info.get("output")
        code = re.match(r"Command exited with code (\d+)", str(output or ""))
        out["results"].append(
            {
                "tool_id": index,
                "output": redact(str(output or ""))[:4000],
                "is_error": failed or bool(code and int(code.group(1))),
                "exit_code": int(code.group(1)) if code else (1 if failed else 0),
            }
        )
        if failed:
            out["steps"].append(
                {
                    "kind": "error",
                    "text": redact(_short(str(output or ""), 240)),
                    "tool_id": index,
                }
            )


class AgyAdapter(Adapter):
    """Antigravity CLI (``agy -p --output-format stream-json``)."""

    provider = "antigravity"
    cli = "agy"
    binary = "agy"
    label = "Antigravity"
    resume_missing = ("conversation not found", "no conversation", "not found")
    # Its MCP servers live in the account's HOME (mcp_config.json): there is no per-run place for a token, so the run
    # goes through the stdio bridge named there. Without an account that file would be the person's own.
    needs_account = True

    def launch(self, spec: Spec) -> Launch:
        """``agy -p <prompt> --output-format stream-json --mode <mode> --settings <allow rules>``."""
        args = [
            spec.path,
            "-p",
            spec.prompt,
            "--output-format",
            "stream-json",
            "--mode",
            "plan" if spec.read_only else "accept-edits",
        ]
        rules = [] if spec.read_only else agy_command_rules(spec.allowed)
        if rules:
            args += ["--settings", json.dumps({"permissions": {"allow": rules}})]
        if spec.resume_id:
            args += ["--conversation", spec.resume_id]
        if spec.model:
            args += ["--model", spec.model]
        if spec.effort:
            args += ["--effort", spec.effort]
        args += _safe_flags(spec.extra_flags)
        env = {TOKEN_ENV: spec.token, URL_ENV: spec.mcp_url} if spec.mcp_url else {}
        note = (
            "Antigravity: a question, so it only plans and reads"
            if spec.read_only
            else f"Antigravity: file edits allowed; {len(rules)} command rule(s) from the Allow list, other commands are denied"
        )
        return Launch(args, env, [note])

    def parser(self, cwd: str) -> Parser:
        """An Antigravity event reader."""
        return AgyParser(cwd)

    def login_command(self, path: str) -> list[str] | None:
        """``agy models`` needs a login and exits non-zero without one."""
        return [path, "models"]


ADAPTERS: dict[str, Adapter] = {
    a.provider: a for a in (CodexAdapter(), OpencodeAdapter(), AgyAdapter())
}


def for_provider(provider: str) -> Adapter | None:
    """The adapter of a member type, or None for Claude Code (its runner is in runs.py) and for types without one."""
    return ADAPTERS.get(provider)


def bridge_entry(command: str, args: list[str]) -> dict:
    """The ``kanban`` server entry of an Antigravity account's MCP config: the stdio bridge to the board."""
    return {"command": command, "args": [*args, "--bridge"], "disabled": False}


async def test_run(
    adapter: Adapter, path: str, model: str | None, cwd: str | None, env: dict | None
) -> dict:
    """One headless run that proves the CLI starts, is signed in and answers: {ok, seconds, reply | error, kind}."""
    import os
    import time

    launch = adapter.test_args(path, model)
    full_env = dict(env or cli.child_env())
    full_env.update(launch.env)
    started = time.monotonic()
    folder = cwd if cwd and Path(cwd).is_dir() else os.getcwd()
    args = [a if a != "." else folder for a in launch.args]
    code, out, err = await cli.run_capture(args, 120, cwd=folder, env=full_env)
    seconds = round(time.monotonic() - started, 1)
    parser = adapter.parser(folder)
    result = None
    for line in out.splitlines():
        result = parser.feed(line).get("result") or result
    reply = ((result or {}).get("text") or "").strip()
    if code == 0 and result and not result["is_error"]:
        return {"ok": True, "seconds": seconds, "reply": reply[:80]}
    detail = reply or err.strip() or out.strip() or f"exit code {code}"
    low = detail.lower()
    kind = (
        "not_logged_in"
        if ("log in" in low or "login" in low or "auth" in low or "sign in" in low)
        else "failed"
    )
    return {
        "ok": False,
        "seconds": seconds,
        "error": redact(detail)[:300],
        "kind": kind,
    }


async def logged_in(adapter: Adapter, path: str, env: dict | None) -> bool | None:
    """Whether the CLI says it is signed in, or None when it cannot say cheaply."""
    command = adapter.login_command(path)
    if not command:
        return None
    code, _, _ = await cli.run_capture(command, 30, env=env)
    return code == 0
