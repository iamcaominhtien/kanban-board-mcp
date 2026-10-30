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
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import httpx

from models import AiMember

from . import cli, secrets
from .providers import PROVIDERS, cost_of

Delta = Callable[[str], Awaitable[None] | None]


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


class LlmError(Exception):
    """A call failed. `kind`: auth | rate | model | outage | bad_request | timeout | runner | unsupported."""

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


async def _claude_cli(
    profile: AiMember,
    system: str,
    prompt: str,
    on_delta: Delta | None,
    images: list[bytes] | None = None,
) -> Completion:
    """Run the CLI headless. With `images` the pictures are written to a private temp folder (picture-1.png ...), which
    becomes the working folder, and the CLI gets the read-only `Read` tool and nothing else, so it can look at them."""
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
    return await _claude_cli_run(profile, system, prompt, on_delta, None, tools="")


async def _claude_cli_run(
    profile: AiMember,
    system: str,
    prompt: str,
    on_delta: Delta | None,
    cwd_override: str | None,
    *,
    tools: str,
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
        tools,
        "--strict-mcp-config",
        "--mcp-config",
        json.dumps({"mcpServers": {}}),
        "--no-session-persistence",
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
    proc = cli.CliProcess(args, cwd)
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
    images: list[bytes] | None = None,
) -> Completion:
    """One answer from the member. Raises `LlmError`; `asyncio.CancelledError` stops the call (and the CLI).

    `images` are pictures (PNG, JPEG, GIF or WebP, as bytes) the model should look at: Anthropic and OpenAI-compatible
    members get them all in the request, Claude Code reads them from a temporary folder. Leave it out for a text-only
    call."""
    started = time.monotonic()
    if profile.connection == "local":
        if profile.provider != "claude-code":
            raise LlmError(
                "unsupported",
                "Only Claude Code can answer as the Board AI among local runners.",
            )
        coro = _claude_cli(profile, system, prompt, on_delta, images)
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
