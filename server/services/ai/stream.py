"""Claude Code's `--output-format stream-json` → step rows (AI v2).

Every event may belong to the lead or to a subagent (`parent_tool_use_id`, the lead's Agent tool call that started
it). The parser keeps which Agent call started which role, so a step says who did it; the lead's final `result`
carries the structured report (`--json-schema`); messages between sessions and hook events become steps too.
"""

import json
import re
from datetime import UTC, datetime
from typing import Any

from . import cli, quota
from .secrets import redact

_CROSS = re.compile(
    r'<cross-session-message\s+from="([^"]*)"[^>]*>(.*?)</cross-session-message>', re.S
)
_TASK_ENDED = ("completed", "failed", "killed", "stopped")
_RELAY_TOOLS = (
    "ToolSearch",
)  # the CLI loading its own deferred tools: not a step of the work


class Parser:
    """Stateful: one per run (a resumed run keeps a new one; the agents it knew come back from the rows)."""

    def __init__(self, cwd: str, agent_types: dict[str, str] | None = None):
        """`agent_types`: the roles of the subagents a resumed run already knows, by Agent call id."""
        self.cwd = cwd
        self.agent_types: dict[str, str] = dict(agent_types or {})

    def parse(self, line: str) -> dict[str, Any]:
        """One line → {rows, agents, files, results, result, session_id, ready, model, context_used, context_window,
        rate_limit, messages_in, messages_out}."""
        out: dict[str, Any] = {
            "rows": [],
            "agents": [],
            "tasks": [],
            "files": [],
            "results": [],
            "result": None,
            "session_id": None,
            "ready": False,
            "model": None,
            "context_used": None,
            "context_window": None,
            "rate_limit": None,
            "messages_in": [],
            "messages_out": [],
            "init": None,
        }
        line = line.strip()
        if not line.startswith("{"):
            return out
        try:
            ev = json.loads(line)
        except ValueError:
            return out
        kind = ev.get("type")
        parent = ev.get("parent_tool_use_id") or None
        agent_id = parent
        if kind == "system":
            sub = ev.get("subtype")
            if sub == "init":
                out["ready"] = True
                out["session_id"] = ev.get("session_id")
                out["model"] = ev.get("model")
                out["init"] = {
                    "agents": ev.get("agents") or [],
                    "plugins": [
                        p.get("name")
                        for p in (ev.get("plugins") or [])
                        if isinstance(p, dict)
                    ],
                    "tools": ev.get("tools") or [],
                }
            elif sub == "compact_boundary":
                meta = ev.get("compact_metadata") or {}
                before, after = meta.get("pre_tokens"), meta.get("post_tokens")
                title = "Long session compacted"
                if isinstance(before, int) and isinstance(after, int):
                    title += f" ({before:,} → {after:,} tokens)"
                out["rows"].append(
                    {"kind": "compact", "title": title, "agent_id": agent_id}
                )
            elif sub in ("task_started", "task_updated", "task_notification"):
                self._task(ev, sub, out)
            elif sub in ("hook_event", "hook") or ev.get("hook_event_name"):
                out["rows"].append(self._hook_row(ev, agent_id))
        elif kind == "rate_limit_event":
            out["rate_limit"] = quota.parse_event(ev)
        elif kind == "assistant":
            self._assistant(ev, agent_id, out)
        elif kind == "user":
            self._user(ev, agent_id, out)
        elif kind == "result":
            res = self._result(ev)
            if (
                res["turns"] == 0
                and not res["text"]
                and not res["structured"]
                and not res["is_error"]
            ):
                # An empty turn the CLI ran by itself when a session was resumed (it handled a notification left by a
                # role of the earlier run): it is not the lead's answer. Taking it for the answer closed the CLI 20 s
                # later, in the middle of the lead's real work, and the run ended with "Finished." (RES-9, runs 2 and 3).
                res = None
            out["result"] = res
            out["session_id"] = ev.get("session_id")
            windows = [
                int(m.get("contextWindow") or 0)
                for m in (ev.get("modelUsage") or {}).values()
                if isinstance(m, dict)
            ]
            out["context_window"] = max(windows) if windows and max(windows) else None
        elif ev.get("hook_event_name"):
            out["rows"].append(self._hook_row(ev, agent_id))
        return out

    # ---------------------------------------------------------------- pieces

    def _task(self, ev: dict, sub: str | None, out: dict) -> None:
        """The CLI keeps a book of every background task of the lead: `task_started` (a role is `local_agent`, a command
        `local_bash`; a role carries its `subagent_type` and the lead's Agent call in `tool_use_id`), `task_updated`
        with the end, and `task_notification`. A role woken again starts the same task id once more. This is the board's
        source for when a role starts, works and ends: it needs no hook."""
        task = ev.get("task_id")
        if not task:
            return
        task = str(task)
        if sub == "task_started":
            kind = ev.get("task_type")
            out["tasks"].append({"id": task, "type": kind, "event": "started"})
            if kind == "local_agent":
                call = ev.get("tool_use_id")
                out["agents"].append(
                    {
                        "id": call if call in self.agent_types else None,
                        "claude_id": task,
                        "agent_type": str(ev.get("subagent_type") or ""),
                        "reopen": True,
                    }
                )
            return
        patch = ev.get("patch") if sub == "task_updated" else None
        status = (patch or {}).get("status") if patch else ev.get("status")
        if status not in _TASK_ENDED:
            return
        out["tasks"].append({"id": task, "type": None, "event": "ended"})
        entry: dict[str, Any] = {"claude_id": task, "ended": True}
        end = (patch or {}).get("end_time") if patch else None
        if isinstance(end, (int, float)):
            entry["at"] = datetime.fromtimestamp(end / 1000, UTC).isoformat()
        out["agents"].append(entry)

    def _hook_row(self, ev: dict, agent_id: str | None) -> dict:
        name = ev.get("hook_event_name") or ev.get("event") or "hook"
        tool = ev.get("tool_name")
        title = f"{name}" + (f" {tool}" if tool else "")
        return {
            "kind": "hook",
            "title": title[:200],
            "tool": tool,
            "detail": {
                k: ev.get(k)
                for k in ("hook_event_name", "agent_id", "agent_type", "tool_name")
                if ev.get(k)
            },
            "agent_id": agent_id,
        }

    def _assistant(self, ev: dict, agent_id: str | None, out: dict) -> None:
        msg = cli.message_of(ev)
        usage = msg.get("usage") or {}
        held = sum(
            int(usage.get(k) or 0)
            for k in (
                "input_tokens",
                "cache_creation_input_tokens",
                "cache_read_input_tokens",
            )
        )
        if held and agent_id is None:
            out["context_used"] = held
        for block in msg.get("content") or []:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype == "tool_use":
                name = block.get("name") or ""
                inp = block.get("input") if isinstance(block.get("input"), dict) else {}
                tool_id = block.get("id")
                if name in _RELAY_TOOLS:
                    continue
                if name in ("Agent", "Task"):
                    role = str(inp.get("subagent_type") or "general-purpose")
                    if tool_id:
                        self.agent_types[tool_id] = role
                        out["agents"].append({"id": tool_id, "agent_type": role})
                    out["rows"].append(
                        {
                            "kind": "subagent",
                            "title": redact(
                                f"Asked {role}: {cli._short(str(inp.get('description') or inp.get('prompt') or ''), 140)}"
                            ),
                            "tool": name,
                            "detail": {
                                "subagent_type": role,
                                "description": inp.get("description"),
                            },
                            "agent_id": agent_id,
                            "tool_id": tool_id,
                        }
                    )
                    continue
                if name == "SendMessage":
                    to = str(inp.get("to") or inp.get("recipient") or "")
                    text = str(inp.get("message") or inp.get("content") or "")
                    out["messages_out"].append(
                        {"peer": to, "text": text, "agent_id": agent_id}
                    )
                    out["rows"].append(
                        {
                            "kind": "message",
                            "title": redact(f"Sent to {to}: {cli._short(text, 140)}"),
                            "tool": name,
                            "detail": {"direction": "out", "peer": to},
                            "agent_id": agent_id,
                            "tool_id": tool_id,
                        }
                    )
                    continue
                if name == "StructuredOutput":
                    out["rows"].append(
                        {
                            "kind": "report",
                            "title": "Wrote the final report",
                            "tool": name,
                            "agent_id": agent_id,
                            "tool_id": tool_id,
                        }
                    )
                    continue
                if name in ("TaskCreate", "TaskUpdate", "TodoWrite"):
                    out["rows"].append(
                        {
                            "kind": "plan",
                            "title": redact(
                                cli._short(
                                    str(
                                        inp.get("subject")
                                        or inp.get("description")
                                        or name
                                    ),
                                    160,
                                )
                            ),
                            "tool": name,
                            "detail": {"input": inp},
                            "agent_id": agent_id,
                            "tool_id": tool_id,
                        }
                    )
                    continue
                k, text, change = cli.describe_tool(name, inp, self.cwd)
                row = {
                    "kind": k,
                    "title": redact(text),
                    "tool": name,
                    "detail": {},
                    "agent_id": agent_id,
                    "tool_id": tool_id,
                }
                if k == "command":
                    row["detail"]["command"] = redact(str(inp.get("command") or ""))[
                        :2000
                    ]
                if change:
                    row["detail"].update(
                        {
                            k2: v
                            for k2, v in change.items()
                            if k2 in ("path", "added", "removed", "new")
                        }
                    )
                    out["files"].append(change)
                out["rows"].append(row)
            elif btype == "text" and (block.get("text") or "").strip():
                text = block["text"].strip()
                row = {
                    "kind": "text",
                    "title": redact(cli._short(text, 300)),
                    "agent_id": agent_id,
                }
                if len(text) > 300:
                    row["output"] = redact(text)
                out["rows"].append(row)
                if agent_id:
                    out["agents"].append(
                        {"id": agent_id, "last_text": redact(cli._short(text, 300))}
                    )

    def _user(self, ev: dict, agent_id: str | None, out: dict) -> None:
        if ev.get("isReplay"):
            return  # a live run's own message echoed back (--replay-user-messages)
        msg = cli.message_of(ev)
        content = msg.get("content")
        if isinstance(content, str):
            self._user_text(content, agent_id, out)
            return
        for block in content or []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_result":
                text = cli.strip_ansi(cli._result_text(block.get("content")))
                code = re.match(r"Exit code (\d+)", text)
                tests = cli.parse_tests(text)
                res = {
                    "tool_id": block.get("tool_use_id"),
                    "output": redact(text),
                    "is_error": bool(block.get("is_error")),
                    "exit_code": int(code.group(1))
                    if code
                    else (1 if block.get("is_error") else 0),
                    "tests": tests,
                    "agent_id": agent_id,
                }
                out["results"].append(res)
                if block.get("is_error"):
                    out["rows"].append(
                        {
                            "kind": "error",
                            "title": redact(cli._short(text, 240)),
                            "agent_id": agent_id,
                            "parent_tool_id": block.get("tool_use_id"),
                        }
                    )
            elif block.get("type") == "text":
                self._user_text(block.get("text") or "", agent_id, out)

    def _user_text(self, text: str, agent_id: str | None, out: dict) -> None:
        for m in _CROSS.finditer(text or ""):
            peer, body = m.group(1), m.group(2).strip()
            out["messages_in"].append(
                {"peer": peer, "text": body, "agent_id": agent_id}
            )
            out["rows"].append(
                {
                    "kind": "message",
                    "title": redact(f"From {peer}: {cli._short(body, 140)}"),
                    "detail": {"direction": "in", "peer": peer},
                    "output": redact(body) if len(body) > 140 else None,
                    "agent_id": agent_id,
                }
            )

    def _result(self, ev: dict) -> dict:
        usage = ev.get("usage") or {}
        structured = ev.get("structured_output")
        text = ev.get("result") or ""
        if (
            structured is None
            and isinstance(text, str)
            and text.strip().startswith("{")
        ):
            try:
                structured = json.loads(text)
            except ValueError:
                structured = None
        return {
            "is_error": bool(ev.get("is_error"))
            or ev.get("subtype") not in (None, "success"),
            "subtype": ev.get("subtype"),
            "text": redact(text if isinstance(text, str) else json.dumps(text)),
            "structured": structured if isinstance(structured, dict) else None,
            "cost_usd": float(ev.get("total_cost_usd") or 0),
            "tokens_in": int(usage.get("input_tokens") or 0)
            + int(usage.get("cache_creation_input_tokens") or 0)
            + int(usage.get("cache_read_input_tokens") or 0),
            "tokens_cached": int(usage.get("cache_creation_input_tokens") or 0)
            + int(usage.get("cache_read_input_tokens") or 0),
            "tokens_out": int(usage.get("output_tokens") or 0),
            "turns": ev.get("num_turns"),
            "api_error": ev.get("api_error"),
            "api_status": ev.get("api_error_status"),
            "denials": [
                {
                    "tool": str(d.get("tool_name") or ""),
                    "input": d.get("tool_input")
                    if isinstance(d.get("tool_input"), dict)
                    else {},
                }
                for d in (ev.get("permission_denials") or [])
                if isinstance(d, dict) and d.get("tool_name")
            ],
        }
