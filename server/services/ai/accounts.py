"""AI accounts: separate logins of the same AI CLI that AI members can share (design/screens/ai-accounts.md).

An account is a folder of its own (``~/.kanban-board/ai-accounts/<name>``) plus a row that remembers its name, CLI and
last status. The login lives with the CLI, in that folder or (Claude Code on macOS) in the system keychain under its
own entry; the board starts the CLI and asks it who is signed in, and never reads, shows or sends the login.
The CLI-specific part (environment variables, status command) is in ``profiles.py``.
"""

import asyncio
import os
import re
import shutil
import sys
from pathlib import Path

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

import events as board_events
from models import AiAccount, AiMember, Member

from . import cli, profiles
from .providers import PROVIDERS
from .store import now_iso, parse_iso

ROOT_ENV = "KANBAN_AI_ACCOUNTS_HOME"

# account CLI -> what it is called, which provider it serves and whether runs of that provider start today
ACCOUNT_CLIS: dict[str, dict] = {
    "claude": {
        "label": "Claude Code",
        "provider": "claude-code",
        "binary": "claude",
        "blurb": "Anthropic · subscription (Pro, Max, Team)",
        "runnable": True,
    },
    "codex": {
        "label": "Codex",
        "provider": "codex",
        "binary": "codex",
        "blurb": "OpenAI · ChatGPT login",
        "runnable": True,
    },
    "opencode": {
        "label": "opencode",
        "provider": "opencode",
        "binary": "opencode",
        "blurb": "Paid providers only · free models need no account",
        "runnable": True,
    },
    "agy": {
        "label": "Antigravity",
        "provider": "antigravity",
        "binary": "agy",
        "blurb": "Google · the agy command",
        "runnable": True,
    },
}
CLI_OF_PROVIDER = {v["provider"]: k for k, v in ACCOUNT_CLIS.items()}
STATUSES = ("signed_in", "needs_sign_in", "cli_missing")
NAME_MAX = 60


class AccountError(ValueError):
    """Something a person can fix; the message is shown as it is. ``code`` lets the UI pick the state to show."""

    def __init__(self, message: str, code: str = "invalid"):
        """The text for the person, and a short machine code."""
        super().__init__(message)
        self.code = code


def root() -> Path:
    """Folder that holds every account's folder. Outside the data folder, so it is not synced with it."""
    return Path(
        os.environ.get(ROOT_ENV) or Path.home() / ".kanban-board" / "ai-accounts"
    )


def _inside_root(leaf: str) -> Path:
    """``root()/leaf``, refused unless it stays directly inside the accounts folder (the name comes from a person)."""
    base = os.path.normpath(str(root()))
    full = os.path.normpath(os.path.join(base, leaf))
    if os.path.dirname(full) != base or not full.startswith(base + os.sep):
        raise AccountError("Choose another name for the account.", "name_invalid")
    return Path(full)


def _slug(name: str) -> str:
    text = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return text[:40] or "account"


def binary_of(account: AiAccount) -> str | None:
    """Path of the CLI this account runs, or None when it is not installed."""
    path, _ = cli.find_cli(ACCOUNT_CLIS[account.cli]["binary"])
    return path


def profile_of(account: AiAccount) -> profiles.Profile:
    """The profile (folder, environment, status command) of an account."""
    return profiles.profile_for(
        account.cli, Path(account.folder).name, account.folder, binary_of(account)
    )


def env_for(account: AiAccount, base: dict[str, str]) -> dict[str, str]:
    """``base`` (a CLI environment) with the account applied: its own config folder, no variable that would override
    its login."""
    return profile_of(account).overlay(base)


def claude_config_dir(account: AiAccount | None) -> str | None:
    """The CLAUDE_CONFIG_DIR a Claude Code account uses, where its sessions are kept."""
    return account.folder if account and account.cli == "claude" else None


def cli_for_provider(provider: str) -> str | None:
    """The account CLI that serves an AI member type, or None when that type has no accounts."""
    return CLI_OF_PROVIDER.get(provider)


def _windows() -> bool:
    return sys.platform == "win32"


def available(cli_name: str) -> str | None:
    """Why an account of this CLI cannot be made on this computer, or None."""
    if cli_name == "agy" and _windows():
        return "Not available on Windows"
    return None


def cli_cards() -> list[dict]:
    """Step 1 of the Add account window: each CLI, whether it is installed and whether it can be used here."""
    cards = []
    for key, spec in ACCOUNT_CLIS.items():
        path, _ = cli.find_cli(spec["binary"])
        cards.append(
            {
                "cli": key,
                "label": spec["label"],
                "blurb": spec["blurb"],
                "provider": spec["provider"],
                "found": bool(path),
                "runnable": spec["runnable"],
                "unavailable": available(key),
            }
        )
    return cards


def _clean_name(name: str) -> str:
    name = " ".join((name or "").split())
    if not name:
        raise AccountError("Give the account a name.", "name_required")
    if len(name) > NAME_MAX:
        raise AccountError(f"Use at most {NAME_MAX} characters.", "name_too_long")
    return name


async def _name_taken(
    session: AsyncSession, name: str, except_id: str | None = None
) -> bool:
    rows = (await session.exec(select(AiAccount))).all()
    return any(r.name.lower() == name.lower() and r.id != except_id for r in rows)


async def get(session: AsyncSession, account_id: str) -> AiAccount:
    """The account, or an AccountError (code ``not_found``)."""
    account = await session.get(AiAccount, account_id)
    if account is None:
        raise AccountError("AI account not found.", "not_found")
    return account


async def list_all(session: AsyncSession) -> list[AiAccount]:
    """Every account on this computer, oldest first."""
    return list(
        (
            await session.exec(select(AiAccount).order_by(col(AiAccount.created_at)))
        ).all()
    )


async def create(
    session: AsyncSession, name: str, cli_name: str, *, by: str
) -> AiAccount:
    """Make the account's folder and its row. Signing in is a separate step (a person, in the terminal)."""
    name = _clean_name(name)
    if cli_name not in ACCOUNT_CLIS:
        raise AccountError("Choose one of the supported CLIs.", "bad_cli")
    why = available(cli_name)
    if why:
        raise AccountError(why, "unavailable")
    if await _name_taken(session, name):
        raise AccountError("An account with this name exists.", "name_taken")
    binary = ACCOUNT_CLIS[cli_name]["binary"]
    path, _ = cli.find_cli(binary)
    if not path:
        raise AccountError(f"“{binary}” was not found on this computer.", "cli_missing")
    base = _slug(name)
    folder, n = _inside_root(base), 1
    while folder.exists():
        n += 1
        folder = _inside_root(f"{base}-{n}")
    root().mkdir(parents=True, exist_ok=True)
    try:
        profiles.profile_for(cli_name, folder.name, folder, path).create(set())
    except profiles.Fail as exc:
        raise AccountError(str(exc), "unavailable") from exc
    except OSError as exc:
        shutil.rmtree(folder, ignore_errors=True)
        raise AccountError(
            f"Could not make the account's folder ({exc.strerror or exc}).", "folder"
        ) from exc
    account = AiAccount(
        name=name,
        cli=cli_name,
        folder=str(folder),
        status="needs_sign_in",
        created_by=by,
    )
    session.add(account)
    await session.commit()
    await session.refresh(account)
    await board_events.publish(board_events.INVALIDATE)
    return account


async def rename(session: AsyncSession, account_id: str, name: str) -> AiAccount:
    """Change the name shown everywhere; the folder keeps its name."""
    account = await get(session, account_id)
    name = _clean_name(name)
    if await _name_taken(session, name, except_id=account.id):
        raise AccountError("An account with this name exists.", "name_taken")
    account.name = name
    account.updated_at = now_iso()
    session.add(account)
    await session.commit()
    await board_events.publish(board_events.INVALIDATE)
    return account


def _apply(account: AiAccount, status: profiles.Status | None, found: bool) -> bool:
    """Write a CLI answer into the row. Returns True when the account has just been found signed out."""
    before = account.status
    now = now_iso()
    account.checked_at = now
    if not found:
        account.status = "cli_missing"
        account.status_detail = "CLI not installed"
    elif status is None:
        return False  # the CLI did not answer: keep what we knew
    elif status.signed_in:
        account.status = "signed_in"
        account.status_detail = status.detail or None
        account.email = status.email or account.email
        account.plan = status.plan or account.plan
        account.method = status.method or account.method
        account.signed_out_at = account.signed_out_how = None
    else:
        account.status = "needs_sign_in"
        account.status_detail = status.detail or "Not signed in"
    account.updated_at = now
    return before == "signed_in" and account.status == "needs_sign_in"


async def _ask(account: AiAccount) -> tuple[profiles.Status | None, bool]:
    """Ask the account's CLI whether it is signed in. Returns (answer or None if it did not answer, CLI found)."""
    profile = profile_of(account)
    if not profile.binary:
        return None, False
    try:
        profile.prepare()
        return await asyncio.to_thread(profile.check), True
    except Exception as exc:  # noqa: BLE001 - a CLI that crashes or hangs is not "signed in"
        return profiles.Status(
            False, f"The CLI did not answer ({type(exc).__name__})"
        ), True


async def follow(session: AsyncSession, account: AiAccount) -> None:
    """Members on an account follow its sign-in: signed out holds them all, signed in frees them all (a queued run
    then starts on the next tick). One sign-in, fixed once."""
    for m in await members_of(session, account.id):
        if account.status == "needs_sign_in" and m.health != "not_logged_in":
            m.health = "not_logged_in"
            m.health_detail = f"The account {account.name} needs to sign in."
        elif account.status == "signed_in" and m.health == "not_logged_in":
            m.health, m.health_detail = "ok", None
        else:
            continue
        m.checked_at = now_iso()
        session.add(m)
    await session.commit()


async def check(
    session: AsyncSession, account: AiAccount, *, how: str = "check"
) -> AiAccount:
    """Ask the CLI whether this account is signed in (never reads the login) and remember the answer. A sign-in that
    has just ended is recorded once, with how it was found (``check`` or ``run``)."""
    answer, found = await _ask(account)
    if _apply(account, answer, found):
        account.signed_out_at, account.signed_out_how = now_iso(), how
    session.add(account)
    await session.commit()
    await follow(session, account)
    await board_events.publish(board_events.INVALIDATE)
    return account


async def check_all(session: AsyncSession, *, only_stale_s: float | None = None) -> int:
    """Check every account (a few at a time). With ``only_stale_s``, skip those checked more recently. Returns how
    many changed state."""
    now = parse_iso(now_iso())
    gate = asyncio.Semaphore(3)
    todo = []
    for a in await list_all(session):
        seen = parse_iso(a.checked_at)
        if only_stale_s and seen and (now - seen).total_seconds() < only_stale_s:
            continue
        todo.append(a)

    async def one(a: AiAccount) -> bool:
        async with gate:
            before = a.status
            answer, found = await _ask(a)
            if _apply(a, answer, found):
                a.signed_out_at, a.signed_out_how = now_iso(), "check"
            return a.status != before

    changed = await asyncio.gather(*(one(a) for a in todo))
    for a in todo:
        session.add(a)
    await session.commit()
    for a in todo:
        await follow(session, a)
    if todo:
        await board_events.publish(board_events.INVALIDATE)
    return sum(1 for c in changed if c)


async def mark_signed_out(
    session: AsyncSession, account: AiAccount, *, how: str, detail: str | None = None
) -> None:
    """A run failed with a sign-in error: the account is signed out now, and every member on it follows."""
    if account.status == "needs_sign_in":
        return
    account.status = "needs_sign_in"
    account.status_detail = detail or "Session expired"
    account.signed_out_at = now_iso()
    account.signed_out_how = how
    account.updated_at = now_iso()
    session.add(account)
    await session.commit()
    await follow(session, account)
    await board_events.publish(board_events.INVALIDATE)


async def sign_out(session: AsyncSession, account_id: str) -> AiAccount:
    """The CLI forgets the login; the account stays in the list."""
    account = await get(session, account_id)
    profile = profile_of(account)
    await asyncio.to_thread(profile.sign_out)
    account.status = "needs_sign_in"
    account.status_detail = "Signed out"
    account.signed_out_at = account.signed_out_how = None
    account.email = account.plan = None
    account.updated_at = now_iso()
    session.add(account)
    await session.commit()
    await follow(session, account)
    await board_events.publish(board_events.INVALIDATE)
    return account


async def members_of(session: AsyncSession, account_id: str) -> list[AiMember]:
    """The AI members (all projects) that run as this account."""
    return list(
        (
            await session.exec(
                select(AiMember).where(AiMember.account_id == account_id)
            )
        ).all()
    )


async def remove(
    session: AsyncSession,
    account_id: str,
    *,
    members: str = "login",
    other_id: str | None = None,
) -> int:
    """Delete the account, its folder and its saved login. ``members`` says what happens to the AI members that use
    it: ``login`` (the login already on this computer), ``other`` (``other_id``) or ``none`` (they pause until a
    person chooses). Returns how many members were moved.
    """
    account = await get(session, account_id)
    using = await members_of(session, account.id)
    other = None
    if using:
        if members == "other":
            if not other_id or other_id == account.id:
                raise AccountError("Pick the other account.", "other_required")
            other = await get(session, other_id)
            if other.cli != account.cli:
                raise AccountError("Pick an account of the same CLI.", "other_cli")
        elif members not in ("login", "none"):
            raise AccountError("Choose what happens to the members.", "members")
    for m in using:
        m.updated_at = now_iso()
        if members == "other":
            m.account_id = other.id
        else:
            m.account_id = None
            if members == "none":
                m.paused = True
                m.paused_at = now_iso()
                m.paused_reason = (
                    f"Account {account.name} was removed: choose an account"
                )
        session.add(m)
    profile = profile_of(account)
    await asyncio.to_thread(profile.remove)
    await session.delete(account)
    await session.commit()
    await board_events.publish(board_events.INVALIDATE)
    return len(using)


async def assign(
    session: AsyncSession, member_id: str, account_id: str | None
) -> AiMember:
    """Make an AI member run as an account (None: the login already on this computer)."""
    profile = await session.get(AiMember, member_id)
    if profile is None:
        raise AccountError("AI member not found.", "member_not_found")
    if account_id is None:
        profile.account_id = None
    else:
        account = await get(session, account_id)
        if profile.connection != "local":
            raise AccountError(
                "Only a member that runs on this computer can use an account.",
                "not_local",
            )
        wanted = cli_for_provider(profile.provider)
        if wanted != account.cli:
            label = PROVIDERS.get(profile.provider, {}).get("label", profile.provider)
            raise AccountError(
                f"{account.name} is an account of {ACCOUNT_CLIS[account.cli]['label']}, not {label}.",
                "wrong_cli",
            )
        profile.account_id = account.id
    profile.updated_at = now_iso()
    session.add(profile)
    await session.commit()
    await board_events.publish(board_events.INVALIDATE)
    return profile


async def counts(session: AsyncSession, project_id: str | None) -> dict[str, dict]:
    """Per account: the members using it in this project and in others (with names, for the hover)."""
    rows = (
        await session.exec(
            select(AiMember).where(col(AiMember.account_id).is_not(None))
        )
    ).all()
    names = (
        {
            m.id: m
            for m in (
                await session.exec(
                    select(Member).where(col(Member.id).in_([r.id for r in rows]))
                )
            ).all()
        }
        if rows
        else {}
    )
    out: dict[str, dict] = {}
    for r in rows:
        slot = out.setdefault(r.account_id, {"here": [], "elsewhere": []})
        member = names.get(r.id)
        item = {
            "id": r.id,
            "name": member.name if member else r.id,
            "project_id": r.project_id,
        }
        slot["here" if r.project_id == project_id else "elsewhere"].append(item)
    return out


def to_dict(
    account: AiAccount,
    users: dict | None = None,
    *,
    signing_in_by: str | None = None,
) -> dict:
    """An account as the UI and the MCP tools see it. Never includes the folder's content or any login."""
    spec = ACCOUNT_CLIS[account.cli]
    users = users or {"here": [], "elsewhere": []}
    status = "signing_in" if signing_in_by else account.status
    return {
        "id": account.id,
        "name": account.name,
        "cli": account.cli,
        "cli_label": spec["label"],
        "provider": spec["provider"],
        "status": status,
        "status_detail": account.status_detail,
        "email": account.email,
        "plan": account.plan,
        "method": account.method,
        "folder": account.folder,
        "runnable": spec["runnable"],
        "unavailable": available(account.cli),
        "checked_at": account.checked_at,
        "signed_out_at": account.signed_out_at,
        "signed_out_how": account.signed_out_how,
        "signing_in_by": signing_in_by,
        "created_at": account.created_at,
        "created_by": account.created_by,
        "members_here": users["here"],
        "members_elsewhere": users["elsewhere"],
        "member_count": len(users["here"]) + len(users["elsewhere"]),
    }
