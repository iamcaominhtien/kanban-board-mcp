"""One-shot completions for the Board AI (chat, drafts, insights, docs). No tools: the board builds the context and
the model answers with text or JSON that the board turns into drafts. Streams text as it arrives.

API-key members call the provider directly; a Claude Code member runs the CLI headless with every tool and MCP
server turned off. Keys are decrypted only for the call and never logged.
"""

import asyncio
import json
import os
import tempfile
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import httpx

from models import AiMember

from . import cli, secrets
from .providers import PROVIDERS, cost_of

Delta = Callable[[str], Awaitable[None] | None]


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
) -> Completion:
    out = Completion(model=model)
    body = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": prompt}],
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
) -> Completion:
    out = Completion(model=model)
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
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


async def _claude_cli(
    profile: AiMember,
    system: str,
    prompt: str,
    on_delta: Delta | None,
    session: "SessionUse | None" = None,
) -> Completion:
    spec = PROVIDERS.get(profile.provider) or {}
    path, _ = cli.find_cli(spec.get("binary") or "claude", profile.cli_path)
    if not path:
        raise LlmError("runner", "The Claude Code CLI was not found on this computer.")
    model = profile.model or spec.get("default_model")
    args = [
        path,
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--tools",
        "",
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
    cwd = (
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
    try:
        async for line in proc.lines():
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            t = ev.get("type")
            if t == "stream_event":
                e = ev.get("event") or {}
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
    return out


async def complete(
    profile: AiMember,
    *,
    system: str,
    prompt: str,
    max_tokens: int = 2000,
    timeout: float = 60.0,
    temperature: float = 0.2,
    on_delta: Delta | None = None,
    session: "SessionUse | None" = None,
) -> Completion:
    """One answer from the member. Raises `LlmError`; `asyncio.CancelledError` stops the call (and the CLI).
    A `session` keeps a local Claude Code conversation going (the CLI remembers it); other connections ignore it."""
    started = time.monotonic()
    if profile.connection == "local":
        if profile.provider != "claude-code":
            raise LlmError(
                "unsupported",
                "Only Claude Code can answer as the Board AI among local runners.",
            )
        coro = _claude_cli(profile, system, prompt, on_delta, session)
    elif profile.connection == "api_key":
        key = secrets.decrypt(profile.key_enc)
        if not key:
            raise LlmError("auth", "This AI member has no API key.")
        spec = PROVIDERS.get(profile.provider) or {}
        base = profile.base_url or spec.get("base_url") or ""
        model = profile.model or spec.get("default_model") or ""
        fn = _anthropic if profile.provider == "anthropic" else _openai
        coro = fn(base, key, model, system, prompt, max_tokens, temperature, on_delta)
    else:
        raise LlmError(
            "unsupported", "This AI member cannot answer board questions (inbox only)."
        )
    try:
        out = await asyncio.wait_for(coro, timeout)
    except asyncio.TimeoutError as exc:
        raise LlmError("timeout", f"Timed out after {int(timeout)} s.") from exc
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
