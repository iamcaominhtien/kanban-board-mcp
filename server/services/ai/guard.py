"""Who an MCP call acts for: the run behind a bearer token, and the duplicate-write suppression after a resume.

AI v2: a run may do what its tools allow; there is no permission matrix and no approval here. The guard only
resolves the token to a `RunContext`, attributes activity to the AI, and skips a write the run already did
right before it was resumed.
"""

import hashlib
import json
import secrets
from contextvars import ContextVar, Token

from sqlmodel import select

import database
import services.activity as svc_activity
from models import AiRun

from .context import RunContext
from .store import get_profile, get_settings, now_iso

_ctx: ContextVar[RunContext | None] = ContextVar("ai_run_ctx", default=None)


class AiActionError(ValueError):
    """An AI action was refused; the message is what the agent reads (and it says why)."""


def token_hash(token: str) -> str:
    """How a run token is stored."""
    return hashlib.sha256(token.encode()).hexdigest()


def new_token() -> str:
    """A fresh run token (the board keeps only its hash)."""
    return "kbr_" + secrets.token_urlsafe(24)


# Assistant answers have no AiRun: each holds a short-lived token that stands for the asking context (in memory
# only, gone when the answer ends or the app restarts).
_chat_tokens: dict[str, RunContext] = {}


def issue_chat_token(ctx: RunContext) -> str:
    """A token for one assistant answer: its MCP calls act as `ctx`."""
    token = "kbr_chat_" + secrets.token_urlsafe(24)
    _chat_tokens[token_hash(token)] = ctx
    return token


def revoke_chat_token(token: str) -> None:
    """The answer ended: its token stops working."""
    _chat_tokens.pop(token_hash(token), None)


def current() -> RunContext | None:
    """The run the current task acts for."""
    return _ctx.get()


def enter(ctx: RunContext) -> tuple[Token, Token, Token]:
    """Act as `ctx` until `leave()`: AI attribution on activity entries and the AI's name as actor."""
    info = {**ctx.activity(), "member_name": ctx.member_name}
    return (
        _ctx.set(ctx),
        svc_activity.set_ai(info),
        svc_activity.set_actor(ctx.member_name),
    )


def leave(tokens: tuple[Token, Token, Token]) -> None:
    """Undo `enter`."""
    _ctx.reset(tokens[0])
    svc_activity.reset_ai(tokens[1])
    svc_activity.reset_actor(tokens[2])


def suspend() -> tuple[Token, Token, Token]:
    """Act as nobody until `leave()` with the returned tokens."""
    return (_ctx.set(None), svc_activity.set_ai(None), svc_activity.set_actor(None))


def _request_token() -> str | None:
    try:
        from mcp.server.lowlevel.server import request_ctx

        rc = request_ctx.get()
    except (LookupError, ImportError):
        return None
    request = getattr(rc, "request", None)
    headers = getattr(request, "headers", None)
    if not headers:
        return None
    auth = headers.get("authorization") or ""
    if auth.lower().startswith("bearer kbr_"):
        return auth.split(None, 1)[1].strip()
    return None


async def context_for_token(token: str) -> RunContext:
    """The live run a token belongs to.

    Raises:
        AiActionError: When the run ended (finished, cancelled, stopped): its token is dead.
    """
    chat = _chat_tokens.get(token_hash(token))
    if chat is not None:
        return chat
    async with database.async_session() as session:
        run = (
            await session.exec(
                select(AiRun).where(AiRun.token_hash == token_hash(token))
            )
        ).first()
        if run is None or run.state not in ("starting", "running"):
            raise AiActionError(
                "This AI run has ended (finished, cancelled or stopped by a person); the board no longer accepts "
                "its calls. Stop now."
            )
        member, profile = await get_profile(session, run.member_id)
        if profile is not None:
            profile.mcp_last_used_at = now_iso()
            session.add(profile)
            await session.commit()
        return RunContext(
            run_id=run.id,
            member_id=run.member_id,
            member_name=member.name if member else "AI",
            project_id=run.project_id,
            ticket_id=run.ticket_id,
            on_behalf_of=run.started_by,
            mode=getattr(run, "mode", "work") or "work",
            trigger=run.trigger or "",
        )


async def resolve() -> RunContext | None:
    """The run of the current MCP request (from its bearer token), or the one already entered."""
    ctx = current()
    if ctx is not None:
        return ctx
    token = _request_token()
    if token is None:
        return None
    return await context_for_token(token)


async def _settings_for(session, ctx: RunContext):
    """Project AI settings as they apply to this run."""
    return await get_settings(session, ctx.project_id)


# A run resumed with its conversation (a retry, a restart) may repeat the write it made right before the cut:
# the board answers with the earlier result instead of doing it twice.
DUPLICATE_WINDOW_S = 180
_recent_writes: dict[str, list[tuple[float, str, object]]] = {}
_resumed_at: dict[str, float] = {}
_WRITE_TOOLS = {
    "manage_ticket",
    "ticket_items",
    "docs_write",
    "ticket_branches",
    "manage_project",
    "ai_run",
}


def mark_resumed(run_id: str) -> None:
    """The run's CLI starts again with its conversation: repeats from before now are skipped."""
    import time

    _resumed_at[run_id] = time.monotonic()


def forget_run(run_id: str) -> None:
    """The run ended: nothing to suppress any more."""
    _recent_writes.pop(run_id, None)
    _resumed_at.pop(run_id, None)


def _fingerprint(tool: str, action: str, given: dict) -> str:
    return json.dumps([tool, action, given], sort_keys=True, default=str)


def _repeat_of(run_id: str, fp: str) -> object | None:
    import time

    resumed = _resumed_at.get(run_id)
    if resumed is None:
        return None
    now = time.monotonic()
    for at, seen, result in reversed(_recent_writes.get(run_id, [])):
        if now - at > DUPLICATE_WINDOW_S:
            break
        if seen == fp and at < resumed:
            return result
    return None


def _remember_write(run_id: str, fp: str, result) -> None:
    import time

    now = time.monotonic()
    kept = [
        w for w in _recent_writes.get(run_id, []) if now - w[0] <= DUPLICATE_WINDOW_S
    ]
    kept.append((now, fp, result))
    _recent_writes[run_id] = kept[-50:]


async def guarded(tool: str, action: str, given: dict, call):
    """Run `call(given)` for an MCP tool, attributed to the AI run it comes from."""
    ctx = await resolve()
    if ctx is None:
        return await call(given)
    # Omitted optional arguments arrive as None and mean "unchanged": they never count as a change
    given = {k: v for k, v in given.items() if v is not None}
    fp = (
        _fingerprint(tool, action, given)
        if ctx.run_id and tool in _WRITE_TOOLS
        else None
    )
    if fp is not None:
        earlier = _repeat_of(ctx.run_id, fp)
        if earlier is not None:
            note = (
                "Not repeated: this run already did exactly this a moment ago, before it was resumed. Here is what "
                "it returned then; carry on from there."
            )
            return (
                {**earlier, "already_done": note}
                if isinstance(earlier, dict)
                else {"already_done": note}
            )
    tokens = enter(ctx) if current() is None else None
    try:
        if tool == "ticket_items" and action in ("comment.add", "attachment.add"):
            given = {**given, "author": ctx.member_name}
        result = await call(given)
        if fp is not None:
            _remember_write(ctx.run_id, fp, result)
        return result
    finally:
        if tokens is not None:
            leave(tokens)


def at_least_now() -> str:
    """Now, ISO."""
    return now_iso()
