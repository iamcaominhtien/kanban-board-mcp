"""REST and terminal API of AI accounts (design/screens/ai-accounts.md).

Reading the list is open to every member. Everything that changes an account, and the sign-in terminal, needs the
request to come from this computer (the desktop app): the web build cannot start a CLI on the person's machine. No
AI member has a route here; the MCP tools only read and assign.
"""

import asyncio
import contextlib
import json
import sys
from typing import Annotated, Literal, Optional
from urllib.parse import urlparse

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

import services.activity as svc_activity
from database import get_session
from models import AiMember, Member
from services.ai import accounts as svc_accounts
from services.ai import cli
from services.ai import members as svc_members
from services.ai import signin

router = APIRouter(tags=["ai-accounts"])

Session = Annotated[AsyncSession, Depends(get_session)]
LOOPBACK = ("127.0.0.1", "::1", "localhost")


def _by() -> str:
    """The person making the request (X-Actor, or the board's own user)."""
    return svc_activity.current_actor() or "user"


def _is_local(host: str) -> bool:
    return host in LOOPBACK or host.startswith("::ffff:127.")


def _desktop_only(request: Request) -> None:
    """Changing an account runs a CLI on this computer: only a request from this computer may do it."""
    host = request.client.host if request.client else ""
    if not _is_local(host):
        raise HTTPException(
            status_code=403,
            detail="AI accounts need the desktop app: signing in runs a terminal on your computer.",
        )


def _fail(exc: svc_accounts.AccountError):
    status = {"not_found": 404, "member_not_found": 404, "name_taken": 409}.get(
        exc.code, 422
    )
    raise HTTPException(
        status_code=status, detail={"message": str(exc), "code": exc.code}
    ) from exc


async def _view(session: AsyncSession, project_id: str | None = None) -> list[dict]:
    rows = await svc_accounts.list_all(session)
    users = await svc_accounts.counts(session, project_id)
    return [
        svc_accounts.to_dict(
            a, users.get(a.id), signing_in_by=signin.signing_in_by(a.id)
        )
        for a in rows
    ]


@router.get("/ai/accounts")
async def get_accounts(
    session: Session, project_id: Optional[str] = Query(default=None)
) -> dict:
    """Every AI account on this computer with its status and the members using it, and the CLIs an account can be made
    for. ``project_id`` splits the members into "here" and "elsewhere"."""
    out = await _view(session, project_id)
    return {
        "accounts": out,
        "clis": svc_accounts.cli_cards(),
        "platform": sys.platform,
        "terminal": signin.pty is not None,
    }


class AccountBody(BaseModel):
    """A new account, or a new name for one."""

    name: str
    cli: Optional[str] = None


@router.post("/ai/accounts", status_code=201)
async def post_account(body: AccountBody, request: Request, session: Session) -> dict:
    """Make an account: its folder and its row. Signing in is the next step."""
    _desktop_only(request)
    try:
        account = await svc_accounts.create(
            session, body.name, body.cli or "", by=_by()
        )
    except svc_accounts.AccountError as exc:
        _fail(exc)
    return svc_accounts.to_dict(account)


@router.get("/ai/accounts/name-check")
async def check_account_name(session: Session, name: str = "") -> dict:
    """Whether a name is free, for the name step (names are unique per computer)."""
    clean = " ".join(name.split())
    if not clean:
        return {"ok": False, "message": "Give the account a name."}
    taken = any(
        a.name.lower() == clean.lower() for a in await svc_accounts.list_all(session)
    )
    return {
        "ok": not taken,
        "message": "An account with this name exists." if taken else None,
    }


@router.get("/ai/accounts/{account_id}")
async def get_account(account_id: str, session: Session) -> dict:
    """One account."""
    try:
        account = await svc_accounts.get(session, account_id)
    except svc_accounts.AccountError as exc:
        _fail(exc)
    users = await svc_accounts.counts(session, None)
    return svc_accounts.to_dict(
        account, users.get(account.id), signing_in_by=signin.signing_in_by(account.id)
    )


@router.patch("/ai/accounts/{account_id}")
async def patch_account(
    account_id: str, body: AccountBody, request: Request, session: Session
) -> dict:
    """Rename an account."""
    _desktop_only(request)
    try:
        account = await svc_accounts.rename(session, account_id, body.name)
    except svc_accounts.AccountError as exc:
        _fail(exc)
    return svc_accounts.to_dict(account)


@router.post("/ai/accounts/{account_id}/check")
async def post_check(account_id: str, request: Request, session: Session) -> dict:
    """Ask the CLI now whether the account is signed in ("Check now")."""
    _desktop_only(request)
    try:
        account = await svc_accounts.check(
            session, await svc_accounts.get(session, account_id)
        )
    except svc_accounts.AccountError as exc:
        _fail(exc)
    users = await svc_accounts.counts(session, None)
    return svc_accounts.to_dict(
        account, users.get(account.id), signing_in_by=signin.signing_in_by(account.id)
    )


@router.post("/ai/accounts/{account_id}/sign-out")
async def post_sign_out(account_id: str, request: Request, session: Session) -> dict:
    """The CLI forgets this account's login. The account stays in the list."""
    _desktop_only(request)
    if signin.active(account_id):
        raise HTTPException(
            status_code=409, detail="A sign-in is open for this account."
        )
    try:
        account = await svc_accounts.sign_out(session, account_id)
    except svc_accounts.AccountError as exc:
        _fail(exc)
    return svc_accounts.to_dict(account)


@router.delete("/ai/accounts/{account_id}")
async def delete_account(
    account_id: str,
    request: Request,
    session: Session,
    members: Literal["login", "other", "none"] = "login",
    other_id: Optional[str] = None,
) -> dict:
    """Remove the account, its folder and its saved login. ``members`` says what happens to the AI members using it."""
    _desktop_only(request)
    if signin.active(account_id):
        raise HTTPException(
            status_code=409, detail="A sign-in is open for this account."
        )
    try:
        moved = await svc_accounts.remove(
            session, account_id, members=members, other_id=other_id
        )
    except svc_accounts.AccountError as exc:
        _fail(exc)
    return {"removed": True, "members_moved": moved}


class AssignBody(BaseModel):
    """The account an AI member should run as, or null for the login already on this computer."""

    account_id: Optional[str] = None


@router.put("/ai/members/{member_id}/account")
async def put_member_account(
    member_id: str, body: AssignBody, session: Session
) -> dict:
    """Choose the account an AI member runs as."""
    try:
        await svc_accounts.assign(session, member_id, body.account_id)
    except svc_accounts.AccountError as exc:
        _fail(exc)
    member = await session.get(Member, member_id)
    profile = await session.get(AiMember, member_id)
    return await svc_members.describe(session, member, profile)


@router.get("/ai/accounts-on-this-computer")
async def logins_on_this_computer() -> list[dict]:
    """The logins the CLIs already have on this computer (what members use with no account chosen). Only Claude Code
    says who; the others are not listed."""
    out = []
    path, _ = cli.find_cli("claude")
    if path:
        info = await cli.detect("claude-code", "claude", path)
        if info.get("logged_in"):
            out.append(
                {
                    "cli": "claude",
                    "label": "Claude Code",
                    "signed_in_with": info.get("account"),
                }
            )
    return out


# --- the sign-in terminal -------------------------------------------------------------------------------------------


def _fallback(account) -> dict:
    return {"command": signin.fallback_command(account)}


@router.post("/ai/accounts/{account_id}/signin")
async def post_signin(
    account_id: str, request: Request, session: Session, cols: int = 80, rows: int = 24
) -> dict:
    """Open the sign-in terminal for an account. If this computer cannot open one, answer with the command to run in
    the person's own terminal instead (the window then polls the account until it is signed in)."""
    _desktop_only(request)
    try:
        account = await svc_accounts.get(session, account_id)
    except svc_accounts.AccountError as exc:
        _fail(exc)
    try:
        await signin.start(account, _by(), cols, rows)
    except signin.SignInBusy as exc:
        raise HTTPException(
            status_code=409,
            detail={"message": str(exc), "code": "signing_in", "by": exc.by},
        ) from exc
    except signin.PtyUnavailable as exc:
        return {"mode": "fallback", "reason": str(exc), **_fallback(account)}
    except svc_accounts.AccountError as exc:
        _fail(exc)
    return {"mode": "terminal"}


@router.delete("/ai/accounts/{account_id}/signin")
async def delete_signin(account_id: str, request: Request) -> dict:
    """Stop signing in: the terminal closes and the CLI is stopped. Nothing is marked signed in."""
    _desktop_only(request)
    session_ = signin.active(account_id)
    if session_:
        await signin.stop(session_, "cancelled")
    return {"stopped": bool(session_)}


@router.post("/ai/accounts/{account_id}/signin/done")
async def post_signin_done(account_id: str, request: Request) -> dict:
    """The person is finished: stop the CLI (it may still be asking a question) and ask it once more who is signed in."""
    _desktop_only(request)
    session_ = signin.active(account_id) or signin.SESSIONS.get(account_id)
    if session_:
        await signin.stop(session_, "done")
    return {"done": bool(session_)}


def _origin_ok(ws: WebSocket) -> bool:
    """A page on another website must not be able to type into the terminal: accept only this computer's own pages
    (the desktop app loads the UI from a file, so its origin is ``null``)."""
    host = ws.client.host if ws.client else ""
    if not _is_local(host):
        return False
    origin = ws.headers.get("origin")
    if origin in (None, "null", "file://"):
        return True
    parsed = urlparse(origin)
    return (parsed.hostname or "") in ("127.0.0.1", "localhost", "::1")


@router.websocket("/ai/accounts/{account_id}/terminal")
async def terminal(ws: WebSocket, account_id: str) -> None:
    """The terminal of an open sign-in. The server sends ``{"type":"out","data"}`` (terminal output) and
    ``{"type":"state",...}`` (what the status bar shows); the window sends ``{"type":"input","data"}``,
    ``{"type":"resize","cols","rows"}`` and ``{"type":"paste","data"}``."""
    if not _origin_ok(ws):
        await ws.close(code=4403)
        return
    session_ = signin.active(account_id)
    if session_ is None:
        await ws.close(code=4404)
        return
    await ws.accept()
    queue = signin.attach(session_)

    async def pump() -> None:
        while True:
            await ws.send_text(json.dumps(await queue.get()))

    sender = asyncio.create_task(pump())
    try:
        while True:
            try:
                message = json.loads(await ws.receive_text())
            except ValueError:
                continue
            kind = message.get("type")
            if kind in ("input", "paste") and isinstance(message.get("data"), str):
                signin.write(session_, message["data"][:20000])
            elif kind == "resize":
                with contextlib.suppress(TypeError, ValueError):
                    signin.resize(session_, int(message["cols"]), int(message["rows"]))
    except WebSocketDisconnect:
        pass
    finally:
        sender.cancel()
        signin.detach(session_, queue)
