"""One-shot completions for the Board AI (chat, drafts, insights, docs). No tools: the board builds the context and
the model answers with text or JSON that the board turns into drafts. Streams text as it arrives.

API-key members call the provider directly; a Claude Code member runs the CLI headless with every tool and MCP
server turned off. Keys are decrypted only for the call and never logged.
"""

import asyncio
import base64
import json
import os
import shutil
import tempfile
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import httpx

from models import AiMember

from . import cli, secrets
from .providers import PROVIDERS, cost_of

Delta = Callable[[str], Awaitable[None] | None]
Step = Callable[
    [str], Awaitable[None] | None
]  # a line about what the member is doing ("Using get_ticket · YU-12")


@dataclass
class SessionUse:
    """A local Claude Code conversation a call belongs to: `resume` continues it, otherwise it starts with `id`.
    `compact_at_pct` is the share of the context window at which the CLI compacts it."""

    id: str
    resume: bool = False
    compact_at_pct: int | None = None


@dataclass
class Completion:
    """What came back."""

    text: str = ""
    tokens_in: int = 0
    tokens_out: int = 0
    cost: float = 0.0
    metered: bool = True
    stop_reason: str | None = None  # end | max_tokens
    model: str | None = None
    elapsed_s: float = 0.0
    compacted: bool = (
        False  # the CLI summarized the older part of a long session during this call
    )
    # Claude Code only: what the session holds after this call (the input of its last request) and the model's
    # context window, both in tokens; 0 when the CLI did not say
    context_used: int = 0
    context_window: int = 0


class LlmError(Exception):
    """A call failed. `kind`: auth | rate | model | outage | bad_request | timeout | runner | session | unsupported."""

    def __init__(
        self,
        kind: str,
        message: str,
        *,
        status: int | None = None,
        retry_after: float | None = None,
    ):
        """Classify the failure."""
        super().__init__(message)
        self.kind = kind
        self.status = status
        self.retry_after = retry_after


def image_type(data: bytes) -> tuple[str, str]:
    """The media type and file extension of a picture, from its first bytes (never from a name): PNG, JPEG, GIF or
    WebP; anything else is sent as PNG, which is what the editor's own picture is."""
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg", "jpg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif", "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp", "webp"
    return "image/png", "png"


def _classify(status: int, body: str, retry_after: str | None) -> LlmError:
    low = body.lower()
    if status in (401, 403):
        return LlmError(
            "auth", f"The provider rejected the key ({status}).", status=status
        )
    if status == 429:
        try:
            wait = float(retry_after) if retry_after else 30.0
        except ValueError:
            wait = 30.0
        return LlmError(
            "rate",
            "Too many requests on this API key.",
            status=status,
            retry_after=wait,
        )
    if status == 404 and "model" in low:
        return LlmError(
            "model", "The provider does not know this model.", status=status
        )
    if status >= 500:
        return LlmError(
            "outage", f"The provider returned an error ({status}).", status=status
        )
    return LlmError(
        "bad_request",
        f"The provider answered {status}: {secrets.redact(body)[:200]}",
        status=status,
    )


async def _emit(cb: Delta | None, text: str) -> None:
    if cb and text:
        res = cb(text)
        if asyncio.iscoroutine(res):
            await res


_ARG_KEYS = (
    "action",
    "ticket_id",
    "page_id",
    "project_id",
    "title",
    "query",
    "pattern",
    "file_path",
    "path",
    "command",
)


def tool_label(name: str, args: dict | None) -> str:
    """A short line for a tool call of the CLI: "Using get_ticket · YU-12" (the server is named unless it is the board)."""
    server = None
    short = name
    if name.startswith("mcp__") and name.count("__") >= 2:
        _, server, short = name.split("__", 2)
    bits = [short]
    for key in _ARG_KEYS:
        v = (args or {}).get(key)
        if isinstance(v, (str, int)) and str(v).strip():
            text = str(v).strip().replace("\n", " ")
            # a path ends with what matters (the file), anything else starts with it
            bits.append(
                "…" + text[-39:]
                if key in ("file_path", "path") and len(text) > 40
                else text[:40]
            )
        if len(bits) == 3:
            break
    label = "Using " + " · ".join(bits)
    if server and server != "kanban":
        label += f" ({server})"
    return secrets.redact(label)


async def _next_line(lines, idle_s: float | None, paused: Callable[[], bool] | None):
    """The next stdout line. With `idle_s` it gives up when nothing came for that long (time spent while `paused()` is
    true, a tool call that waits for a person's approval, does not count). Raises StopAsyncIteration at the end."""
    if not idle_s:
        return await lines.__anext__()
    task = asyncio.ensure_future(lines.__anext__())
    quiet = 0.0
    try:
        while True:
            done, _ = await asyncio.wait({task}, timeout=1.0)
            if done:
                return task.result()
            quiet = 0.0 if paused and paused() else quiet + 1.0
            if quiet >= idle_s:
                raise LlmError(
                    "timeout",
                    f"No sign of progress for {int(idle_s)} s. Nothing was changed by this answer.",
                )
    finally:
        if not task.done():
            task.cancel()


def _sse_events(lines: list[str]):
    data = "\n".join(x[5:].strip() for x in lines if x.startswith("data:"))
    if not data or data == "[DONE]":
        return None
    try:
        return json.loads(data)
    except ValueError:
        return None


async def _anthropic(
    url: str,
    key: str,
    model: str,
    system: str,
    prompt: str,
    max_tokens: int,
    temperature: float,
    on_delta: Delta | None,
    images: list[bytes] | None = None,
) -> Completion:
    out = Completion(model=model)
    content: str | list[dict] = prompt
    if images:
        content = [
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": image_type(img)[0],
                    "data": base64.b64encode(img).decode("ascii"),
                },
            }
            for img in images
        ] + [{"type": "text", "text": prompt}]
    body = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": content}],
        "temperature": temperature,
        "stream": True,
    }
    headers = {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(120, connect=15)) as client:
        async with client.stream(
            "POST", url.rstrip("/") + "/v1/messages", headers=headers, json=body
        ) as r:
            if r.status_code >= 400:
                text = (await r.aread()).decode(errors="replace")
                raise _classify(r.status_code, text, r.headers.get("retry-after"))
            buf: list[str] = []
            async for line in r.aiter_lines():
                if line:
                    buf.append(line)
                    continue
                ev, buf = _sse_events(buf), []
                if not ev:
                    continue
                t = ev.get("type")
                if t == "message_start":
                    u = (ev.get("message") or {}).get("usage") or {}
                    out.tokens_in = int(u.get("input_tokens") or 0)
                elif t == "content_block_delta":
                    d = ev.get("delta") or {}
                    if d.get("type") == "text_delta":
                        out.text += d.get("text", "")
                        await _emit(on_delta, d.get("text", ""))
                elif t == "message_delta":
                    u = ev.get("usage") or {}
                    out.tokens_out = int(u.get("output_tokens") or out.tokens_out)
                    sr = (ev.get("delta") or {}).get("stop_reason")
                    out.stop_reason = "max_tokens" if sr == "max_tokens" else "end"
                elif t == "error":
                    err = ev.get("error") or {}
                    if err.get("type") == "overloaded_error":
                        raise LlmError("outage", "The provider is overloaded.")
                    raise LlmError(
                        "bad_request",
                        secrets.redact(str(err.get("message") or err))[:200],
                    )
    return out


async def _openai(
    url: str,
    key: str,
    model: str,
    system: str,
    prompt: str,
    max_tokens: int,
    temperature: float,
    on_delta: Delta | None,
    images: list[bytes] | None = None,
) -> Completion:
    out = Completion(model=model)
    content: str | list[dict] = prompt
    if images:
        content = [{"type": "text", "text": prompt}] + [
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:{image_type(img)[0]};base64,"
                    + base64.b64encode(img).decode("ascii")
                },
            }
            for img in images
        ]
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": content},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    headers = {"Authorization": f"Bearer {key}", "content-type": "application/json"}
    async with httpx.AsyncClient(timeout=httpx.Timeout(120, connect=15)) as client:
        async with client.stream(
            "POST", url.rstrip("/") + "/chat/completions", headers=headers, json=body
        ) as r:
            if r.status_code >= 400:
                text = (await r.aread()).decode(errors="replace")
                raise _classify(r.status_code, text, r.headers.get("retry-after"))
            async for line in r.aiter_lines():
                ev = _sse_events([line]) if line.startswith("data:") else None
                if not ev:
                    continue
                for ch in ev.get("choices") or []:
                    piece = (ch.get("delta") or {}).get("content") or ""
                    if piece:
                        out.text += piece
                        await _emit(on_delta, piece)
                    if ch.get("finish_reason"):
                        out.stop_reason = (
                            "max_tokens" if ch["finish_reason"] == "length" else "end"
                        )
                u = ev.get("usage")
                if u:
                    out.tokens_in = int(u.get("prompt_tokens") or 0)
                    out.tokens_out = int(u.get("completion_tokens") or 0)
    return out


@dataclass
class ChatTools:
    """The member's own Claude Code configuration for one chat answer (what a run of the member would get):
    MCP servers, tool rules and limits. Without it the Board AI answers with no tools at all."""

    mcp: dict
    allowed: list[str]
    denied: list[str]
    max_turns: int | None = None
    effort: str | None = None
    extra_flags: list[str] | None = None
    bypass: bool = False  # the member's "Bypass permissions": every tool runs except what a deny rule stops


async def _claude_cli(
    profile: AiMember,
    system: str,
    prompt: str,
    on_delta: Delta | None,
    images: list[bytes] | None = None,
    session: "SessionUse | None" = None,
    tools: ChatTools | None = None,
    on_step: Step | None = None,
    idle_s: float | None = None,
    paused: Callable[[], bool] | None = None,
) -> Completion:
    """Run the CLI headless. With `images` the pictures are written to a private temp folder (picture-1.png ...), which
    becomes the working folder, and the CLI gets the read-only `Read` tool and nothing else, so it can look at them.
    A `session` is ignored then: the CLI keeps sessions per working folder and this one is new every time."""
    if images:
        folder = tempfile.mkdtemp(prefix="kanban-picture-")
        try:
            names = []
            for n, img in enumerate(images, 1):
                name = f"picture-{n}.{image_type(img)[1]}"
                with open(os.path.join(folder, name), "wb") as fh:
                    fh.write(img)
                names.append(name)
            note = (
                (
                    "The picture is the file "
                    if len(names) == 1
                    else "The pictures are the files "
                )
                + ", ".join(names)
                + " in your working folder: open "
                + ("it" if len(names) == 1 else "them")
                + " with the Read tool before you answer. Read no other file.\n\n"
            )
            return await _claude_cli_run(
                profile, system, note + prompt, on_delta, folder, tools="Read"
            )
        finally:
            shutil.rmtree(folder, ignore_errors=True)
    return await _claude_cli_run(
        profile,
        system,
        prompt,
        on_delta,
        None,
        tools="",
        session=session,
        chat_tools=tools,
        on_step=on_step,
        idle_s=idle_s,
        paused=paused,
    )


async def _claude_cli_run(
    profile: AiMember,
    system: str,
    prompt: str,
    on_delta: Delta | None,
    cwd_override: str | None,
    *,
    tools: str,
    session: "SessionUse | None" = None,
    chat_tools: ChatTools | None = None,
    on_step: Step | None = None,
    idle_s: float | None = None,
    paused: Callable[[], bool] | None = None,
) -> Completion:
    spec = PROVIDERS.get(profile.provider) or {}
    path, _ = cli.find_cli(spec.get("binary") or "claude", profile.cli_path)
    if not path:
        raise LlmError("runner", "The Claude Code CLI was not found on this computer.")
    model = profile.model or spec.get("default_model")
    if chat_tools is not None:
        # the member's configured tools, built the way a run of the member builds them
        args = cli.claude_args(
            path,
            prompt=prompt,
            system=system,
            model=profile.model or spec.get("default_model"),
            mcp_config=chat_tools.mcp,
            allowed=chat_tools.allowed,
            denied=chat_tools.denied,
            max_turns=chat_tools.max_turns,
            session_id=session.id if session else str(uuid.uuid4()),
            resume=bool(session and session.resume),
            effort=chat_tools.effort,
            extra_flags=chat_tools.extra_flags,
            bypass=chat_tools.bypass,
        ) + ["--include-partial-messages"]
    else:
        args = [
            path,
            "-p",
            prompt,
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--tools",
            tools,
            "--strict-mcp-config",
            "--mcp-config",
            json.dumps({"mcpServers": {}}),
            *(
                ["--resume" if session.resume else "--session-id", session.id]
                if session
                else ["--no-session-persistence"]
            ),
            "--setting-sources",
            "",
            "--system-prompt",
            system,
        ]
        if model:
            args += ["--model", model]
    cwd = cwd_override or (
        profile.working_dir
        if profile.working_dir and os.path.isdir(profile.working_dir)
        else tempfile.gettempdir()
    )
    proc = cli.CliProcess(
        args,
        cwd,
        env=cli.child_env(session.compact_at_pct if session else None),
    )
    out = Completion(model=model, metered=False)
    await proc.start()
    result: dict | None = None
    held = 0  # what the session holds at the last request: the best measure of how full it is
    try:
        lines = proc.lines().__aiter__()
        while True:
            try:
                line = await _next_line(lines, idle_s if chat_tools else None, paused)
            except StopAsyncIteration:
                break
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            t = ev.get("type")
            if t == "assistant" and chat_tools is not None:
                for block in (ev.get("message") or {}).get("content") or []:
                    if isinstance(block, dict) and block.get("type") == "tool_use":
                        await _emit(
                            on_step,
                            tool_label(block.get("name") or "tool", block.get("input")),
                        )
            if t == "stream_event":
                e = ev.get("event") or {}
                if e.get("type") == "message_start":
                    u = (e.get("message") or {}).get("usage") or {}
                    held = (
                        int(u.get("input_tokens") or 0)
                        + int(u.get("cache_creation_input_tokens") or 0)
                        + int(u.get("cache_read_input_tokens") or 0)
                    ) or held
                if (
                    e.get("type") == "message_start"
                    and chat_tools is not None
                    and out.text
                    and not out.text.endswith("\n")
                ):
                    out.text += "\n\n"  # a new step after a tool call
                    await _emit(on_delta, "\n\n")
                if e.get("type") == "content_block_delta":
                    d = e.get("delta") or {}
                    if d.get("type") == "text_delta":
                        out.text += d.get("text", "")
                        await _emit(on_delta, d.get("text", ""))
                elif e.get("type") == "message_delta":
                    sr = (e.get("delta") or {}).get("stop_reason")
                    out.stop_reason = "max_tokens" if sr == "max_tokens" else "end"
            elif t == "system" and ev.get("subtype") == "compact_boundary":
                out.compacted = True
            elif t == "result":
                result = ev
        code = await proc.wait()
    except BaseException:
        proc.kill()
        raise
    if not result:
        tail = " ".join(proc.stderr_tail[-3:])
        raise LlmError(
            "runner", f"The CLI stopped without an answer (exit {code}). {tail}".strip()
        )
    if result.get("is_error"):
        msg = str(result.get("result") or "The CLI reported an error.")
        low = msg.lower()
        if "no conversation found" in low:
            raise LlmError("session", "The CLI could not resume the chat's session.")
        if "login" in low or "logged in" in low:
            raise LlmError(
                "auth",
                "Claude Code is not signed in on this computer. Run claude and sign in.",
            )
        if "rate" in low or "limit" in low:
            raise LlmError("rate", secrets.redact(msg)[:200], retry_after=60.0)
        raise LlmError("runner", secrets.redact(msg)[:200])
    if not out.text:
        out.text = str(result.get("result") or "")
    usage = result.get("usage") or {}
    out.tokens_in = (
        int(usage.get("input_tokens") or 0)
        + int(usage.get("cache_creation_input_tokens") or 0)
        + int(usage.get("cache_read_input_tokens") or 0)
    )
    out.tokens_out = int(usage.get("output_tokens") or 0)
    windows = [
        int(m.get("contextWindow") or 0)
        for m in (result.get("modelUsage") or {}).values()
        if isinstance(m, dict)
    ]
    out.context_window = max(windows, default=0)
    # a run with tool calls adds up every request in `usage`; the last request is what the session holds
    out.context_used = held or out.tokens_in
    return out


async def complete(
    profile: AiMember,
    *,
    system: str,
    prompt: str,
    max_tokens: int = 2000,
    timeout: float | None = 60.0,
    temperature: float = 0.2,
    on_delta: Delta | None = None,
    images: list[bytes] | None = None,
    session: "SessionUse | None" = None,
    tools: ChatTools | None = None,
    on_step: Step | None = None,
    idle_s: float | None = None,
    paused: Callable[[], bool] | None = None,
) -> Completion:
    """One answer from the member. Raises `LlmError`; `asyncio.CancelledError` stops the call (and the CLI).

    `images` are pictures (PNG, JPEG, GIF or WebP, as bytes) the model should look at: Anthropic and OpenAI-compatible
    members get them all in the request, Claude Code reads them from a temporary folder. Leave it out for a text-only
    call.
    A `session` keeps a local Claude Code conversation going (the CLI remembers it); other connections ignore it.
    `tools` give a Claude Code member its own configured MCP servers and tool rules; other connections ignore it.
    With `tools`, `on_step` hears each tool the CLI calls, and `idle_s` ends the call when the CLI is quiet that long
    (`paused()` true: it waits for a person, so the quiet does not count); `timeout` stays the cap on the whole call."""
    started = time.monotonic()
    if profile.connection == "local":
        if profile.provider != "claude-code":
            raise LlmError(
                "unsupported",
                "Only Claude Code can answer as the Board AI among local runners.",
            )
        coro = _claude_cli(
            profile,
            system,
            prompt,
            on_delta,
            images,
            session,
            tools,
            on_step,
            idle_s,
            paused,
        )
    elif profile.connection == "api_key":
        key = secrets.decrypt(profile.key_enc)
        if not key:
            raise LlmError("auth", "This AI member has no API key.")
        spec = PROVIDERS.get(profile.provider) or {}
        base = profile.base_url or spec.get("base_url") or ""
        model = profile.model or spec.get("default_model") or ""
        fn = _anthropic if profile.provider == "anthropic" else _openai
        coro = fn(
            base, key, model, system, prompt, max_tokens, temperature, on_delta, images
        )
    else:
        raise LlmError(
            "unsupported", "This AI member cannot answer board questions (inbox only)."
        )
    try:
        out = await asyncio.wait_for(coro, timeout)
    except asyncio.TimeoutError as exc:
        raise LlmError("timeout", f"Timed out after {int(timeout or 0)} s.") from exc
    except httpx.HTTPError as exc:
        raise LlmError(
            "outage", f"Could not reach the provider: {type(exc).__name__}."
        ) from exc
    out.elapsed_s = round(time.monotonic() - started, 2)
    if out.metered:
        out.cost = round(cost_of(out.model, out.tokens_in, out.tokens_out), 6)
    return out


def estimate_tokens(text: str) -> int:
    """Rough token count (4 characters a token) for budgets and truncation."""
    return max(1, len(text) // 4)
