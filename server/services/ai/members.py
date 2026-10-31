"""AI members: register, edit, pause, test the connection, remove (design/screens/ai-members.md).

An AI member is a project Member with ``kind='ai'`` (so assignment, @mentions and avatars work everywhere) plus an
AiMember profile holding its connection, persona, limits and permissions.
"""

import json
import os
import re
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import httpx
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

import database
from models import AiApproval, AiMember, AiRun, Member, Project, Ticket

from . import (
    accounts,
    adapters,
    audit,
    budget,
    cli,
    config_model,
    config_service,
    multiproject,
    paths,
    safety,
    secrets,
)
from . import permissions as perms
from .permissions import (
    ACTIONS,
    APPROVAL,
    BLOCKED,
    CEILINGS,
    OWNER_ENABLEABLE,
    TEMPLATES,
    effective,
    validate_overrides,
)
from .providers import DEFAULT_LOOK, PROVIDERS, capabilities, merged_config
from .store import active_runs, get_settings, loads, now_iso

AI_COLORS = [
    "#2E6F40",
    "#6D5DD3",
    "#2F6FB0",
    "#B4791E",
    "#B0446E",
    "#5B6B60",
    "#C4432A",
]
GLYPHS = [
    "asterisk",
    "spark",
    "braces",
    "peak",
    "hex",
    "plug",
    "terminal",
    "eye",
    "tag",
    "doc",
    "phone",
    "chip",
]
MAX_PERSONA = 1000
BYPASS_PHRASE = "bypass permissions"


class AiMemberError(ValueError):
    """A request about an AI member was refused; the message is shown as is."""


class AiPermissionDenied(AiMemberError):
    """Only an owner may make this change (Done, wider scope, Custom, owner-enabled delete)."""


AT_CAP = ("pause", "stop", "ask")
WARN_STEPS = (50, 80, 100)


def _clean_name(name: str) -> str:
    name = " ".join((name or "").split())
    if not name:
        raise AiMemberError("Name must not be empty.")
    if len(name) > 80:
        raise AiMemberError("Name must be at most 80 characters.")
    return name


def _clean_color(color: str) -> str:
    color = (color or "").strip()
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
        raise AiMemberError("Pick one of the avatar colours.")
    return color.upper()


def _clean_glyph(glyph: str) -> str:
    if glyph not in GLYPHS:
        raise AiMemberError("Pick one of the avatar glyphs.")
    return glyph


async def check_name(
    session: AsyncSession, project_id: str, name: str, exclude_id: str | None = None
) -> dict:
    """Names are unique across people and AI in a project (case and surrounding spaces ignored)."""
    clean = " ".join((name or "").split())
    project = await session.get(Project, project_id)
    rows = (
        await session.exec(select(Member).where(Member.project_id == project_id))
    ).all()
    low = clean.lower()
    for m in rows:
        if m.id == exclude_id or m.kind == "ai_removed":
            continue
        if m.name.strip().lower() == low:
            if m.kind == "ai":
                existing = {r.name.strip().lower() for r in rows}
                n = 2
                while f"{low} {n}" in existing:
                    n += 1
                return {
                    "ok": False,
                    "conflict": "ai",
                    "message": f"Another AI member already uses this name. Try “{clean} {n}”.",
                    "suggestion": f"{clean} {n}",
                }
            return {
                "ok": False,
                "conflict": "person",
                "message": f"“{m.name}” is already a member of {project.name if project else 'this project'}.",
                "suggestion": None,
            }
    return {"ok": True, "conflict": None, "message": None, "suggestion": None}


def _validate_limits(data: dict) -> None:
    daily = data.get("daily_budget")
    monthly = data.get("monthly_cap")
    if daily is not None and daily < 0:
        raise AiMemberError("Daily budget must be 0 or more.")
    if monthly is not None and daily is not None and monthly < daily:
        raise AiMemberError(
            f"Monthly cap must be at least the daily budget (${daily:.2f})."
        )
    if data.get("max_parallel") is not None and not 1 <= data["max_parallel"] <= 10:
        raise AiMemberError("Max parallel runs must be between 1 and 10.")
    if (
        data.get("max_runs_per_day") is not None
        and not 1 <= data["max_runs_per_day"] <= 500
    ):
        raise AiMemberError("Scheduled runs per day must be between 1 and 500.")
    if len(data.get("persona") or "") > MAX_PERSONA:
        raise AiMemberError(f"Role / persona must be at most {MAX_PERSONA} characters.")
    if data.get("ceiling") is not None and data["ceiling"] not in CEILINGS:
        raise AiMemberError(f"Status ceiling must be one of {', '.join(CEILINGS)}.")
    if data.get("ceiling") in ("testing", "done") and not data.get("confirm_done"):
        raise AiMemberError(
            "Allowing an AI past Review needs the extra confirmation: nobody reviews these tickets first."
        )
    if data.get("template") is not None and data["template"] not in TEMPLATES:
        raise AiMemberError(f"Role template must be one of {', '.join(TEMPLATES)}.")
    if data.get("scope") is not None and data["scope"] not in ("assigned", "project"):
        raise AiMemberError("Scope must be 'assigned' or 'project'.")
    if data.get("tokens_per_day") is not None and data["tokens_per_day"] < 1000:
        raise AiMemberError("Tokens per day: at least 1,000.")
    if data.get("cap_per_run") is not None and data["cap_per_run"] <= 0:
        raise AiMemberError("Cap per run must be more than $0.")
    warn = data.get("warn_at")
    if warn is not None and (
        not isinstance(warn, list) or any(w not in WARN_STEPS for w in warn)
    ):
        raise AiMemberError("Warn me at: 50, 80 and 100 percent.")


def _validate_connection(
    provider: str, data: dict, *, creating: bool, has_key: bool
) -> None:
    spec = PROVIDERS.get(provider)
    if spec is None:
        raise AiMemberError(f"Unknown provider '{provider}'.")
    if spec["connection"] == "local":
        folder = (data.get("working_dir") or "").strip()
        if folder:
            try:
                real = paths.folder(folder)
            except paths.PathRefused:
                raise AiMemberError(paths.folder_refused(folder)) from None
            if not os.path.isdir(real):
                raise AiMemberError(
                    f"Working folder not found on this computer: {folder}"
                )
    if spec["connection"] == "api_key":
        if creating and not (data.get("api_key") or "").strip():
            raise AiMemberError("Enter an API key.")
        if provider == "custom":
            url = (data.get("base_url") or "").strip()
            if creating and not url:
                raise AiMemberError("Enter the base URL of the endpoint.")
            if url and not (
                url.startswith("https://")
                or url.startswith("http://localhost")
                or url.startswith("http://127.0.0.1")
            ):
                raise AiMemberError("HTTPS is required except for localhost.")


async def _checked_account(
    session: AsyncSession, provider: str, account_id: str | None
) -> str | None:
    """The account id to store for a member of this type, or None; refuses an unknown account or one of another CLI."""
    if not account_id:
        return None
    if (PROVIDERS.get(provider) or {}).get("connection") != "local":
        raise AiMemberError(
            "Only a member that runs on this computer can use an account."
        )
    try:
        account = await accounts.get(session, account_id)
    except accounts.AccountError as exc:
        raise AiMemberError(str(exc)) from exc
    if accounts.cli_for_provider(provider) != account.cli:
        raise AiMemberError(
            f"{account.name} is an account of {accounts.ACCOUNT_CLIS[account.cli]['label']}."
        )
    return account.id


async def create(
    session: AsyncSession, project_id: str, data: dict, *, by: str
) -> Member:
    """Register an AI member.

    Raises:
        AiMemberError: Invalid data or duplicate name.
        secrets.SecretStoreError: The key could not be stored (nothing is created).
    """
    provider = data.get("provider") or ""
    spec = PROVIDERS.get(provider)
    if spec is None:
        raise AiMemberError(f"Unknown provider '{provider}'.")
    name = _clean_name(data.get("name") or "")
    verdict = await check_name(session, project_id, name)
    if not verdict["ok"]:
        raise AiMemberError(verdict["message"])
    ws = safety.defaults_to_dict(await safety.workspace_defaults(session))
    for key in ("template", "ceiling", "daily_budget"):
        if key not in data or (data[key] is None and key in ("template", "ceiling")):
            data[key] = ws[key]
    if "monthly_cap" not in data and (
        data["daily_budget"] is None
        or ws["monthly_cap"] is None
        or ws["monthly_cap"] >= data["daily_budget"]
    ):
        data["monthly_cap"] = ws["monthly_cap"]
    _validate_limits(data)
    _validate_connection(provider, data, creating=True, has_key=False)
    account_id = await _checked_account(session, provider, data.get("account_id"))
    role = await safety.role_name(session, project_id, by)
    if role != "owner" and (
        data.get("ceiling") in ("testing", "done") or data.get("scope") == "project"
    ):
        raise AiPermissionDenied(
            "Only the project owner can allow an AI past Review or on every ticket."
        )
    overrides = validate_overrides(
        data.get("template") or "developer",
        data.get("permissions") or {},
        owner=role == "owner",
    )
    owner_meta: dict = {}
    if (
        overrides.get("delete_tickets") == APPROVAL
        and TEMPLATES[data.get("template") or "developer"]["delete_tickets"] == BLOCKED
    ):
        owner_meta["delete_tickets"] = {"by": by, "at": now_iso(), "mode": APPROVAL}
    if (
        ws["delete_mode"] == "approval"
        and overrides.get("delete_tickets") is None
        and TEMPLATES[data.get("template") or "developer"]["delete_tickets"] == BLOCKED
    ):
        # The workspace default lets an owner-set "Delete tickets: Needs approval" start on every new member
        overrides["delete_tickets"] = APPROVAL
        owner_meta["delete_tickets"] = {
            "by": ws["updated_by"] or by,
            "at": ws["updated_at"] or now_iso(),
            "mode": APPROVAL,
        }
    if owner_meta:
        overrides["_owner"] = owner_meta
    key_enc = key_last4 = None
    if spec["connection"] == "api_key":
        key = data["api_key"].strip()
        key_enc = secrets.encrypt(
            key
        )  # raises SecretStoreError before anything is written
        key_last4 = secrets.last4(key)
    look_glyph, look_color = DEFAULT_LOOK.get(provider, ("spark", AI_COLORS[0]))
    color = _clean_color(data["color"]) if data.get("color") else look_color
    glyph = _clean_glyph(data["glyph"]) if data.get("glyph") else look_glyph
    member = Member(
        id=str(uuid.uuid4()),
        project_id=project_id,
        name=name,
        color=color,
        role="member",
        kind="ai",
    )
    session.add(member)
    await session.flush()
    config = merged_config(
        config_model.prepare_config({}, merged_config(data.get("config") or {}))
    )
    # Bypass permissions is switched on later, on the Configuration tab, by an owner who types the confirmation
    config["permission_mode"] = "allowlist"
    problems = [
        e
        for e in config_model.validate_config(config, provider)
        if e["severity"] == "error"
    ]
    if problems:
        raise AiMemberError(problems[0]["message"])
    profile = AiMember(
        id=member.id,
        project_id=project_id,
        provider=provider,
        connection=spec["connection"],
        description=(data.get("description") or "").strip()[:200],
        glyph=glyph,
        cli_path=(data.get("cli_path") or None),
        working_dir=(data.get("working_dir") or "").strip() or None,
        account_id=account_id,
        base_url=(data.get("base_url") or spec.get("base_url") or None),
        model=data.get("model") or spec.get("default_model"),
        key_enc=key_enc,
        key_last4=key_last4,
        persona=(data.get("persona") or "").strip(),
        max_parallel=data.get("max_parallel") or 2,
        daily_budget=data.get("daily_budget", 5.0)
        if spec["connection"] == "api_key"
        else None,
        monthly_cap=data.get("monthly_cap")
        if spec["connection"] == "api_key"
        else None,
        max_runs_per_day=data.get("max_runs_per_day", 20)
        if spec["connection"] == "local"
        else None,
        template=data.get("template") or "developer",
        ceiling=data.get("ceiling") or "review",
        permissions=json.dumps(overrides),
        scope=data.get("scope") or "assigned",
        config=json.dumps(config),
        health="unknown" if spec["connection"] != "inbox" else "ok",
        created_by=by,
        key_rotated_at=now_iso() if key_enc else None,
        tokens_per_day=data.get("tokens_per_day")
        if spec["connection"] == "api_key"
        else None,
        cap_per_run=data.get("cap_per_run")
        if spec["connection"] == "api_key"
        else None,
        warn_at=json.dumps(sorted(set(data.get("warn_at") or [80, 100]))),
        safe_mode=bool(data.get("safe_mode")),
        allow_external=bool(data.get("allow_external")),
    )
    session.add(profile)
    await session.commit()
    await session.refresh(member)
    settings = await get_settings(session, project_id)
    if settings.board_ai_id is None and spec["connection"] != "inbox":
        settings.board_ai_id = member.id
        session.add(settings)
        await session.commit()
    await audit.record(
        project_id,
        "member_created",
        "info",
        member_id=member.id,
        member_name=name,
        on_behalf_of=by,
        detail={
            "provider": provider,
            "template": profile.template,
            "ceiling": profile.ceiling,
        },
    )
    return member


async def update(
    session: AsyncSession, member_id: str, data: dict, *, by: str
) -> AiMember:
    """Edit identity, connection, limits, permissions or configuration (only the keys given)."""
    member = await session.get(Member, member_id)
    profile = await session.get(AiMember, member_id)
    if member is None or profile is None or member.kind != "ai":
        raise AiMemberError("AI member not found.")
    changes: dict = {}
    config_changed = False
    if "name" in data and data["name"] is not None:
        name = _clean_name(data["name"])
        if name != member.name:
            verdict = await check_name(
                session, member.project_id, name, exclude_id=member_id
            )
            if not verdict["ok"]:
                raise AiMemberError(verdict["message"])
            changes["name"] = [member.name, name]
            member.name = name
    if data.get("color"):
        member.color = _clean_color(data["color"])
    role = await safety.role_name(session, member.project_id, by)
    new_template = data.get("template") or profile.template
    if role != "owner":
        # Widening an AI member is an owner's decision (A3, A1 scope, H1)
        if (
            data.get("ceiling") in ("testing", "done")
            and data["ceiling"] != profile.ceiling
        ):
            raise AiPermissionDenied(
                "Only the project owner can allow an AI to move tickets past Review."
            )
        if data.get("scope") == "project" and profile.scope != "project":
            raise AiPermissionDenied(
                "Only the project owner can widen the scope to every ticket in the project."
            )
        if new_template == "custom" and profile.template != "custom":
            raise AiPermissionDenied(
                "Only the project owner can switch to the Custom template."
            )
    merged = {
        "tokens_per_day": data.get("tokens_per_day", profile.tokens_per_day),
        "cap_per_run": data.get("cap_per_run", profile.cap_per_run),
        "warn_at": data.get("warn_at"),
        "daily_budget": data.get("daily_budget", profile.daily_budget),
        "monthly_cap": data.get("monthly_cap", profile.monthly_cap),
        **{
            k: data[k]
            for k in (
                "max_parallel",
                "max_runs_per_day",
                "persona",
                "ceiling",
                "template",
                "scope",
                "confirm_done",
            )
            if k in data
        },
    }
    if data.get("ceiling") == profile.ceiling:
        merged["confirm_done"] = True
    _validate_limits(merged)
    _validate_connection(
        profile.provider, data, creating=False, has_key=bool(profile.key_enc)
    )
    for key in (
        "description",
        "working_dir",
        "base_url",
        "model",
        "persona",
        "cli_path",
    ):
        if key in data and data[key] is not None:
            value = data[key].strip() if isinstance(data[key], str) else data[key]
            if getattr(profile, key) != (value or None if key != "persona" else value):
                changes[key] = True
            setattr(
                profile,
                key,
                (value or None) if key not in ("persona", "description") else value,
            )
    if "account_id" in data:
        new_account = await _checked_account(
            session, profile.provider, data["account_id"]
        )
        if new_account != profile.account_id:
            changes["account"] = [profile.account_id, new_account]
            profile.account_id = new_account
    if data.get("glyph"):
        profile.glyph = _clean_glyph(data["glyph"])
    for key in (
        "max_parallel",
        "daily_budget",
        "monthly_cap",
        "max_runs_per_day",
        "scope",
        "tokens_per_day",
        "cap_per_run",
    ):
        if key in data:
            if getattr(profile, key) != data[key]:
                changes[key] = [getattr(profile, key), data[key]]
            setattr(profile, key, data[key])
    for key in ("safe_mode", "allow_external"):
        if key in data and data[key] is not None:
            if getattr(profile, key) != bool(data[key]):
                changes[key] = [getattr(profile, key), bool(data[key])]
            setattr(profile, key, bool(data[key]))
    if data.get("warn_at") is not None:
        warn = sorted(set(data["warn_at"]))
        if warn != loads(profile.warn_at, [80, 100]):
            changes["warn_at"] = [loads(profile.warn_at, [80, 100]), warn]
        profile.warn_at = json.dumps(warn)
    template = data.get("template") or profile.template
    if "template" in data or "permissions" in data:
        overrides = data.get("permissions")
        old_raw = loads(profile.permissions, {})
        if overrides is None:
            overrides = {k: v for k, v in old_raw.items() if not k.startswith("_")}
        clean = validate_overrides(template, overrides, owner=role == "owner")
        before_modes = _modes(profile)
        # Owner-enabled actions keep who and when; a new one records the person who enabled it
        prev_owner = (
            old_raw.get("_owner") if isinstance(old_raw.get("_owner"), dict) else {}
        )
        owner_meta = {}
        for action in OWNER_ENABLEABLE:
            if clean.get(action) == APPROVAL and TEMPLATES[template][action] == BLOCKED:
                owner_meta[action] = (
                    prev_owner.get(action)
                    if isinstance(prev_owner.get(action), dict)
                    else {"by": by, "at": now_iso(), "mode": APPROVAL}
                )
        stored = {**clean, **({"_owner": owner_meta} if owner_meta else {})}
        after = SimpleNamespace(
            **{
                **profile.model_dump(),
                "template": template,
                "permissions": json.dumps(stored),
            }
        )
        diffs = _mode_diffs(before_modes, _modes(after))
        if diffs and role == "admin":
            # An admin's permission change waits for the owner; the old setting stays until then (H1)
            kept = {k: v for k, v in old_raw.items() if k != "_pending"}
            kept["_pending"] = {
                "by": by,
                "at": now_iso(),
                "template": template,
                "stored": stored,
                "diffs": diffs,
            }
            profile.permissions = json.dumps(kept)
            changes["pending_owner"] = diffs
        else:
            if template != profile.template:
                changes["template"] = [profile.template, template]
            if stored != old_raw:
                changes["permissions"] = [old_raw, stored]
            profile.template = template
            profile.permissions = json.dumps(stored)
            if diffs:
                changes["diffs"] = diffs
    if data.get("ceiling") and data["ceiling"] != profile.ceiling:
        changes["ceiling"] = [profile.ceiling, data["ceiling"]]
        profile.ceiling = data["ceiling"]
    if "config" in data and data["config"] is not None:
        try:
            cfg = config_service.apply_patch(profile, data["config"])
        except config_service.ConfigError as exc:
            raise AiMemberError(str(exc)) from exc
        _validate_config(cfg)
        old_mode = merged_config(loads(profile.config, {}))["permission_mode"]
        new_mode = cfg["permission_mode"]
        if new_mode != old_mode:
            if new_mode == "bypass":
                if role != "owner":
                    raise AiPermissionDenied(
                        "Only the project owner can turn on Bypass permissions."
                    )
                if (data.get("confirm_bypass") or "").strip().lower() != BYPASS_PHRASE:
                    raise AiMemberError(
                        f"Type “{BYPASS_PHRASE}” to confirm Bypass permissions."
                    )
            changes["permission_mode"] = [old_mode, new_mode]
        config_changed = cfg != merged_config(loads(profile.config, {}))
        profile.config = json.dumps(cfg)
        changes["config"] = True
    if (data.get("api_key") or "").strip():
        key = data["api_key"].strip()
        profile.key_enc = secrets.encrypt(key)
        profile.key_last4 = secrets.last4(key)
        profile.key_rotated_at = now_iso()
        profile.health = "unknown"
        changes["api_key"] = f"••••{profile.key_last4}"
    profile.updated_at = now_iso()
    session.add(member)
    session.add(profile)
    await session.commit()
    await session.refresh(profile)
    if config_changed:
        await config_service.bump_version(session, member_id)
    await multiproject.sync(session, member_id)
    if "permission_mode" in changes:
        await audit.record(
            member.project_id,
            "bypass_permissions_on"
            if changes["permission_mode"][1] == "bypass"
            else "bypass_permissions_off",
            "info",
            member_id=member_id,
            member_name=member.name,
            on_behalf_of=by,
            detail={"by_role": role},
        )
    if changes:
        await audit.record(
            member.project_id,
            "member_updated",
            "info",
            member_id=member_id,
            member_name=member.name,
            on_behalf_of=by,
            detail={"changes": changes, "by_role": role},
        )
    return profile


def pending_change(profile: AiMember) -> dict | None:
    """A permission change an admin asked for, waiting for the owner (H1)."""
    raw = loads(profile.permissions, {})
    pending = raw.get("_pending") if isinstance(raw, dict) else None
    return pending if isinstance(pending, dict) else None


async def decide_pending(
    session, member_id: str, *, by: str, confirm: bool
) -> AiMember:
    """The owner confirms or rejects an admin's permission change; both steps are audited."""
    member = await session.get(Member, member_id)
    profile = await session.get(AiMember, member_id)
    if member is None or profile is None:
        raise AiMemberError("AI member not found.")
    pending = pending_change(profile)
    if pending is None:
        raise AiMemberError("There is no permission change waiting.")
    if await safety.role_name(session, member.project_id, by) != "owner":
        raise AiPermissionDenied(
            "Only the project owner can confirm a permission change."
        )
    raw = {k: v for k, v in loads(profile.permissions, {}).items() if k != "_pending"}
    if confirm:
        profile.template = pending.get("template") or profile.template
        profile.permissions = json.dumps(pending.get("stored") or {})
    else:
        profile.permissions = json.dumps(raw)
    profile.updated_at = now_iso()
    session.add(profile)
    await session.commit()
    await session.refresh(profile)
    await audit.record(
        member.project_id,
        "permission_change_confirmed" if confirm else "permission_change_rejected",
        "info",
        member_id=member_id,
        member_name=member.name,
        on_behalf_of=by,
        detail={"asked_by": pending.get("by"), "diffs": pending.get("diffs") or []},
    )
    return profile


def _modes(profile: AiMember) -> dict[str, str]:
    """Effective mode of every board action of a member, without safe mode or the kill switch."""
    plain = SimpleNamespace(safe_mode=False, paused_all=False)
    return {a: effective(profile, a, plain).mode for a in ACTIONS}


def _mode_diffs(old: dict[str, str], new: dict[str, str]) -> list[dict]:
    return [
        {"action": a, "label": ACTIONS[a][0], "from": old.get(a), "to": mode}
        for a, mode in new.items()
        if old.get(a) != mode
    ]


def _validate_config(cfg: dict) -> None:
    if cfg.get("at_cap", "pause") not in AT_CAP:
        raise AiMemberError(
            "When the cap is reached: pause new runs, stop now, or ask an owner."
        )
    if not 1 <= int(cfg.get("max_steps") or 12) <= 50:
        raise AiMemberError("Max steps: 1 to 50.")
    if not 1 <= int(cfg.get("max_turns") or 40) <= 200:
        raise AiMemberError("Max turns per run: 1 to 200.")
    if not 1 <= int(cfg.get("run_timeout_min") or 30) <= 240:
        raise AiMemberError("Run timeout: 1 to 240 minutes.")
    if not 1 <= int(cfg.get("idle_timeout_min") or 10) <= 120:
        raise AiMemberError("Idle timeout: 1 to 120 minutes.")
    if cfg.get("permission_mode", "allowlist") not in ("allowlist", "bypass"):
        raise AiMemberError("Permission mode: Allow list or Bypass permissions.")
    if not 10 <= int(cfg.get("compact_at_pct") or 60) <= 95:
        raise AiMemberError("Auto-compact at: 10 to 95 percent.")
    for flag in cfg.get("extra_flags") or []:
        if any(bad in str(flag) for bad in cli.REJECTED_FLAGS):
            raise AiMemberError(
                f"Flags that skip permission checks are rejected: {flag}"
            )
    for server in cfg.get("mcp_servers") or []:
        if not isinstance(server, dict) or not (server.get("name") or "").strip():
            raise AiMemberError("Each MCP server needs a name.")
        if server.get("name") == "kanban":
            raise AiMemberError(
                "“kanban” is the board's own server; it is always attached."
            )


async def set_paused(
    session: AsyncSession,
    member_id: str,
    paused: bool,
    *,
    by: str,
    cancel_current: bool = False,
    reason: str | None = None,
) -> AiMember:
    """Pause (new work queues; the current run finishes or is cancelled) or resume."""
    member = await session.get(Member, member_id)
    profile = await session.get(AiMember, member_id)
    if member is None or profile is None:
        raise AiMemberError("AI member not found.")
    profile.paused = paused
    profile.paused_at = now_iso() if paused else None
    profile.paused_reason = (reason or f"Paused by {by}") if paused else None
    session.add(profile)
    await session.commit()
    await session.refresh(profile)
    await audit.record(
        member.project_id,
        "member_paused" if paused else "member_resumed",
        "info",
        member_id=member_id,
        member_name=member.name,
        on_behalf_of=by,
        detail={"cancel_current": cancel_current},
    )
    if paused and cancel_current:
        from . import runs

        for r in await active_runs(session, member_id=member_id):
            if r.state in ("starting", "running"):
                try:
                    await runs.cancel(
                        r.id, by=by, reason=f"{member.name} was paused by {by}"
                    )
                except runs.RunError:
                    pass
    else:
        from .runs import RT

        RT.wake.set()
    await multiproject.sync(session, member_id)
    return profile


async def removal_impact(session: AsyncSession, member_id: str) -> dict:
    """What removing the member affects: open tickets and runs in flight (F2)."""
    open_tickets = (
        await session.exec(
            select(Ticket).where(
                Ticket.assignee == member_id,
                col(Ticket.status).not_in(["done", "wont_do"]),
            )
        )
    ).all()
    runs = await active_runs(session, member_id=member_id)
    return {
        "open_tickets": [
            {"id": t.id, "title": t.title, "status": t.status} for t in open_tickets
        ],
        "active_runs": [
            {"id": r.id, "ticket_id": r.ticket_id, "number": r.number, "state": r.state}
            for r in runs
        ],
    }


async def remove(
    session: AsyncSession,
    member_id: str,
    *,
    by: str,
    tickets: str = "unassign",
    reassign_to: str | None = None,
    runs_choice: str = "cancel",
) -> dict:
    """Remove an AI member: reassign or unassign its open tickets, then cancel its runs or let them finish first.
    Done tickets keep the AI as history (the member row stays, marked removed)."""
    member = await session.get(Member, member_id)
    profile = await session.get(AiMember, member_id)
    if member is None or profile is None or member.kind != "ai":
        raise AiMemberError("AI member not found.")
    if tickets == "reassign":
        target = await session.get(Member, reassign_to) if reassign_to else None
        if (
            target is None
            or target.project_id != member.project_id
            or target.kind != "human"
        ):
            raise AiMemberError("Pick a person to reassign the tickets to.")
    from . import runs as svc_runs

    impact = await removal_impact(session, member_id)
    import services.tickets as svc_tickets
    from models import TicketUpdate

    for t in impact["open_tickets"]:
        await svc_tickets.update_ticket(
            session,
            t["id"],
            TicketUpdate(assignee=reassign_to if tickets == "reassign" else None),
        )
    active = [r for r in impact["active_runs"]]
    running = [
        r for r in active if r["state"] in ("starting", "running", "needs_input")
    ]
    for r in active:
        if r["state"] == "queued" or runs_choice == "cancel":
            try:
                await svc_runs.cancel(
                    r["id"], by=by, reason=f"{member.name} was removed by {by}"
                )
            except svc_runs.RunError:
                pass
    profile = await session.get(AiMember, member_id)
    if runs_choice == "finish" and running:
        profile.remove_after_run = True
        profile.paused = True
        session.add(profile)
        await session.commit()
        await audit.record(
            member.project_id,
            "member_removal_scheduled",
            "info",
            member_id=member_id,
            member_name=member.name,
            on_behalf_of=by,
        )
        return {"removed": False, "scheduled": True}
    await finalize_removal(session, member_id, by=by)
    return {"removed": True, "scheduled": False}


async def finalize_removal(
    session: AsyncSession, member_id: str, by: str = "board"
) -> None:
    """Mark the member removed (kept for history), forget its key and pending approvals."""
    member = await session.get(Member, member_id)
    profile = await session.get(AiMember, member_id)
    if member is None:
        return
    member.kind = "ai_removed"
    session.add(member)
    if profile is not None:
        profile.key_enc = None
        profile.paused = True
        profile.remove_after_run = False
        session.add(profile)
    for apr in (
        await session.exec(
            select(AiApproval).where(
                AiApproval.member_id == member_id, AiApproval.status == "pending"
            )
        )
    ).all():
        apr.status = "expired"
        apr.decision_note = "AI member removed"
        session.add(apr)
    settings = await get_settings(session, member.project_id)
    if settings.board_ai_id == member_id:
        settings.board_ai_id = None
        session.add(settings)
    await session.commit()
    await audit.record(
        member.project_id,
        "member_removed",
        "info",
        member_id=member_id,
        member_name=member.name,
        on_behalf_of=by,
    )


# ---------------------------------------------------------------------------
# Connection test
# ---------------------------------------------------------------------------


_LATEST: dict[str, tuple[float, str | None]] = {}


async def latest_cli_version(provider: str) -> str | None:
    """The newest published version of a provider's CLI (from the npm registry), cached for 6 hours; None when it
    cannot be looked up (offline, or the CLI is not distributed that way)."""
    package = (PROVIDERS.get(provider) or {}).get("npm_package")
    if not package:
        return None
    hit = _LATEST.get(provider)
    if hit and time.monotonic() - hit[0] < (6 * 3600 if hit[1] else 600):
        return hit[1]
    version = None
    try:
        async with httpx.AsyncClient(timeout=4) as client:
            r = await client.get(f"https://registry.npmjs.org/{package}/latest")
        if r.status_code == 200:
            version = str(r.json().get("version") or "") or None
    except (httpx.HTTPError, ValueError):
        version = None
    _LATEST[provider] = (time.monotonic(), version)
    return version


def _semver(text: str | None) -> tuple[int, ...] | None:
    found = re.search(r"(\d+)\.(\d+)\.(\d+)", text or "")
    return tuple(int(x) for x in found.groups()) if found else None


async def detect_local(
    provider: str,
    cli_path: str | None = None,
    *,
    latest: bool = False,
    account=None,
) -> dict:
    """Step 2a: is the CLI installed and signed in on this computer? With `latest`, also whether it is the newest
    version (a network lookup, only the stepper wants it); the install steps and guide link are for step 2b."""
    spec = PROVIDERS.get(provider) or {}
    env = accounts.env_for(account, cli.child_env()) if account is not None else None
    info = await cli.detect(provider, spec.get("binary") or provider, cli_path, env=env)
    adapter = adapters.for_provider(provider)
    if adapter and info["found"] and account is None:
        info["logged_in"] = await adapters.logged_in(adapter, info["path"], env)
    if account is not None and info["found"]:
        # The answer is about the account's own login, not the one already on this computer
        info["logged_in"] = account.status == "signed_in"
        info["account"] = (
            " · ".join(x for x in (account.email, account.plan or account.method) if x)
            or account.name
        )
    info["install"] = spec.get("install")
    info["install_steps"] = spec.get("install_steps") or []
    info["guide_url"] = spec.get("guide_url")
    info["latest_version"] = None
    info["up_to_date"] = None
    if info["found"] and latest:
        newest = await latest_cli_version(provider)
        have = _semver(info.get("version"))
        want = _semver(newest)
        info["latest_version"] = newest
        if have and want:
            info["up_to_date"] = have >= want
    return info


async def test_key(provider: str, api_key: str, base_url: str | None) -> dict:
    """Step 2c: is the key valid? Lists the models the endpoint offers."""
    spec = PROVIDERS.get(provider) or {}
    base = (base_url or spec.get("base_url") or "").rstrip("/")
    if not base:
        return {
            "ok": False,
            "status": None,
            "error": "Enter the base URL of the endpoint.",
        }
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            if provider == "anthropic":
                r = await client.get(
                    f"{base}/v1/models",
                    headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"},
                )
            else:
                r = await client.get(
                    f"{base}/models", headers={"Authorization": f"Bearer {api_key}"}
                )
    except httpx.HTTPError as exc:
        return {
            "ok": False,
            "status": None,
            "error": f"Could not reach {base}: {type(exc).__name__}",
        }
    if r.status_code in (401, 403):
        return {
            "ok": False,
            "status": r.status_code,
            "error": f"{r.status_code} Unauthorized — the endpoint rejected this key. Check the key and the base URL.",
        }
    if r.status_code == 429:
        return {
            "ok": True,
            "status": 429,
            "models": [],
            "note": "Rate limited (429): the key works; try again later.",
        }
    if r.status_code >= 400:
        return {
            "ok": False,
            "status": r.status_code,
            "error": f"The endpoint answered {r.status_code}.",
        }
    try:
        models = [
            m.get("id") for m in (r.json().get("data") or []) if isinstance(m, dict)
        ]
    except ValueError:
        models = []
    return {
        "ok": True,
        "status": r.status_code,
        "models": [m for m in models if m][:50],
    }


def model_listed(model: str | None, models: list[str]) -> bool:
    """Is `model` one the provider still offers? Ids are compared without a ``models/`` prefix (Gemini lists
    ``models/gemini-2.5-pro``), and an alias such as ``claude-sonnet-4-5`` matches its dated ids."""

    def norm(m: str) -> str:
        m = (m or "").strip().lower()
        return m[len("models/") :] if m.startswith("models/") else m

    want = norm(model or "")
    if not want:
        return True
    return any(norm(m) == want or norm(m).startswith(want + "-") for m in models)


async def test_connection(
    session: AsyncSession, member_id: str, *, full: bool = True
) -> dict:
    """Check a saved member: CLI + sign-in + (optionally) a one-line run, or the API key. Updates its health."""
    member = await session.get(Member, member_id)
    profile = await session.get(AiMember, member_id)
    if member is None or profile is None:
        raise AiMemberError("AI member not found.")
    result: dict
    if profile.connection == "inbox":
        result = {
            "ok": True,
            "health": "ok",
            "message": "Connects through MCP; nothing to test from the board.",
        }
    elif profile.connection == "local":
        account = None
        if profile.account_id:
            account = await session.get(accounts.AiAccount, profile.account_id)
            if account is not None:
                await accounts.check(session, account)
        info = await detect_local(profile.provider, profile.cli_path, account=account)
        profile.cli_version = info.get("version")
        profile.account = info.get("account")
        if not info["found"]:
            result = {
                "ok": False,
                "health": "runner_missing",
                "message": f"“{PROVIDERS[profile.provider]['binary']}” was not found on this computer.",
                **info,
            }
        elif info.get("logged_in") is False:
            result = {
                "ok": False,
                "health": "not_logged_in",
                "message": "The CLI is installed but not signed in. Run it in a terminal and sign in.",
                **info,
            }
        elif full:
            folder = os.path.expanduser(profile.working_dir or "") or None
            test_env = (
                accounts.env_for(account, cli.child_env())
                if account is not None
                else None
            )
            adapter = adapters.for_provider(profile.provider)
            if adapter:
                run = await adapters.test_run(
                    adapter,
                    info["path"],
                    profile.model,
                    folder if folder and Path(folder).is_dir() else None,
                    test_env,
                )
            else:
                run = await cli.test_run(
                    info["path"],
                    profile.model,
                    folder if folder and Path(folder).is_dir() else None,
                    env=test_env,
                )
            if run["ok"]:
                result = {
                    "ok": True,
                    "health": "ok",
                    "message": f"Test run passed in {run['seconds']} s — CLI replied “{run['reply']}”",
                    **info,
                }
            else:
                result = {
                    "ok": False,
                    "health": "not_logged_in"
                    if run.get("kind") == "not_logged_in"
                    else "error",
                    "message": run["error"],
                    **info,
                }
        else:
            result = {
                "ok": True,
                "health": "ok",
                "message": "CLI found and signed in.",
                **info,
            }
    else:
        key = secrets.decrypt(profile.key_enc)
        if not key:
            result = {
                "ok": False,
                "health": "key_invalid",
                "message": "No readable key is stored; enter a new one.",
            }
        else:
            r = await test_key(profile.provider, key, profile.base_url)
            if r["ok"]:
                models = r.get("models") or []
                retired = bool(models) and not model_listed(profile.model, models)
                result = {
                    "ok": not retired,
                    "health": "model_retired" if retired else "ok",
                    "message": (
                        f"The provider does not offer {profile.model} any more; pick another model."
                        if retired
                        else f"Key is valid — {len(models)} models available"
                    ),
                    "models": models,
                }
            else:
                result = {
                    "ok": False,
                    "health": "key_invalid"
                    if r.get("status") in (401, 403)
                    else "error",
                    "message": r["error"],
                }
    if result["health"] != "error":
        profile.health = result["health"]
    if result["health"] == "ok":
        profile.retry_at = None
        if profile.connection == "api_key":
            profile.last_call_at = now_iso()  # the provider just answered
    profile.health_detail = None if result["ok"] else result["message"]
    profile.checked_at = now_iso()
    session.add(profile)
    await session.commit()
    from .runs import RT

    RT.wake.set()
    return result


HEALTH_INTERVAL_S = 60  # how often the scheduler re-detects runners
HEALTH_STALE_S = 300  # how often a healthy runner's sign-in is checked again
ACCOUNT_STALE_S = 240  # an account is asked for its status at most every four minutes


async def health_check() -> int:
    """Re-detect what changes without anyone touching the board: a runner whose CLI was uninstalled or reinstalled,
    a sign-in that expired or came back (design/screens/ai-members.md, E4 and E5). A member that is missing or
    signed out is checked on every call, so it heals by itself once the CLI is back; a healthy one only has its
    path looked up cheaply, and its sign-in re-checked every few minutes.

    Returns:
        How many members changed state.
    """
    changed = 0
    now = datetime.now(UTC)
    async with database.async_session() as session:
        rows = (
            await session.exec(
                select(AiMember).where(
                    AiMember.connection == "local",
                    AiMember.remove_after_run == False,  # noqa: E712
                )
            )
        ).all()
        await accounts.check_all(session, only_stale_s=ACCOUNT_STALE_S)
        for profile in rows:
            member = await session.get(Member, profile.id)
            if member is None or member.kind != "ai":
                continue
            binary = (PROVIDERS.get(profile.provider) or {}).get("binary") or ""
            before = profile.health
            if profile.account_id:
                # A member on an account follows the account: one sign-in, fixed once for every member
                account = await session.get(accounts.AiAccount, profile.account_id)
                if account is not None:
                    if account.status == "signed_in":
                        if profile.health == "not_logged_in":
                            profile.health, profile.health_detail = "ok", None
                    elif account.status == "needs_sign_in":
                        profile.health = "not_logged_in"
                        profile.health_detail = (
                            f"The account {account.name} needs to sign in."
                        )
                    else:
                        profile.health = "runner_missing"
                        profile.health_detail = (
                            f"“{binary}” was not found on this computer"
                        )
                    profile.checked_at = now.isoformat()
                    session.add(profile)
                    if profile.health != before:
                        changed += 1
                    continue
            if profile.health in ("runner_missing", "not_logged_in"):
                info = await detect_local(profile.provider, profile.cli_path)
            else:
                path, _ = cli.find_cli(binary, profile.cli_path)
                checked = parse(profile.checked_at)
                stale = (
                    checked is None or (now - checked).total_seconds() > HEALTH_STALE_S
                )
                if path and (not stale or profile.provider != "claude-code"):
                    continue
                info = (
                    await detect_local(profile.provider, profile.cli_path)
                    if path
                    else {"found": False, "version": None, "account": None}
                )
            if not info.get("found"):
                profile.health = "runner_missing"
                profile.health_detail = f"“{binary}” was not found on this computer"
            elif info.get("logged_in") is False:
                profile.health = "not_logged_in"
                profile.health_detail = "The CLI is installed but not signed in. Run it in a terminal and sign in."
            elif profile.health in ("runner_missing", "not_logged_in", "unknown"):
                profile.health, profile.health_detail = "ok", None
            if info.get("found"):
                profile.cli_version = info.get("version") or profile.cli_version
                profile.account = info.get("account") or profile.account
            profile.checked_at = now_iso()
            session.add(profile)
            if profile.health != before:
                changed += 1
                await audit.record(
                    profile.project_id,
                    "member_health",
                    "info",
                    member_id=profile.id,
                    member_name=member.name,
                    on_behalf_of="board",
                    detail={"from": before, "to": profile.health},
                )
        await session.commit()
    if changed:
        from .runs import RT, _publish

        RT.wake.set()  # a runner that is back starts what waited for it
        await _publish(force=True)
    return changed


def parse(value: str | None) -> datetime | None:
    """An ISO time from the database, or None."""
    from .store import parse_iso

    return parse_iso(value)


async def retry_now(session: AsyncSession, member_id: str, *, by: str) -> AiMember:
    """Skip the wait of a rate-limited AI member: its queued runs try the provider again at once (E7).

    Raises:
        AiMemberError: The member is not rate-limited.
    """
    member = await session.get(Member, member_id)
    profile = await session.get(AiMember, member_id)
    if member is None or profile is None or member.kind != "ai":
        raise AiMemberError("AI member not found.")
    if profile.health != "rate_limited":
        raise AiMemberError(f"{member.name} is not rate-limited right now.")
    profile.health, profile.health_detail, profile.retry_at = "ok", None, None
    session.add(profile)
    await session.commit()
    await session.refresh(profile)
    await audit.record(
        member.project_id,
        "member_retry_now",
        "info",
        member_id=member_id,
        member_name=member.name,
        on_behalf_of=by,
    )
    from .runs import RT

    RT.wake.set()
    return profile


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------


async def usage(session: AsyncSession, member_id: str) -> dict:
    """Today, this month and the last 14 days for one member (Usage tab)."""
    today = budget.today_start()
    month_start = budget.month_start()
    since = min(budget.day_bounds(13)[1], month_start)
    runs = (
        await session.exec(
            select(AiRun).where(
                AiRun.member_id == member_id, AiRun.queued_at >= since.isoformat()
            )
        )
    ).all()
    week_ago = (datetime.now(UTC) - timedelta(days=7)).isoformat()
    todays = [r for r in runs if (r.started_at or r.queued_at) >= today.isoformat()]
    month = [
        r for r in runs if (r.started_at or r.queued_at) >= month_start.isoformat()
    ]
    week = [
        r
        for r in runs
        if r.queued_at >= week_ago and r.state in ("finished", "failed", "timed_out")
    ]
    hour_ago = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    days = []
    for i in range(13, -1, -1):
        label, d0, d1 = budget.day_bounds(i)
        rs = [
            r
            for r in runs
            if d0.isoformat() <= (r.started_at or r.queued_at) < d1.isoformat()
        ]
        days.append(
            {
                "date": label,
                "runs": len(rs),
                "cost_usd": round(sum(r.cost_usd for r in rs), 4),
                "seconds": sum(_secs(r) for r in rs),
            }
        )
    return {
        "runs_today": len(todays),
        "scheduled_runs_today": len([r for r in todays if r.trigger == "schedule"]),
        "runs_last_hour": len([r for r in todays if (r.started_at or "") >= hour_ago]),
        "tokens_in_today": sum(r.tokens_in for r in todays),
        "tokens_out_today": sum(r.tokens_out for r in todays),
        "cost_today": round(sum(r.cost_usd for r in todays if r.metered), 4),
        "cost_month": round(sum(r.cost_usd for r in month if r.metered), 4),
        "seconds_today": sum(_secs(r) for r in todays),
        "success_rate_week": (
            round(100 * len([r for r in week if r.state == "finished"]) / len(week))
            if week
            else None
        ),
        "days": days,
    }


def _secs(run: AiRun) -> int:
    from .store import parse_iso

    a, b = parse_iso(run.started_at), parse_iso(run.ended_at) or datetime.now(UTC)
    return int((b - a).total_seconds()) if a else 0


def status_of(
    member: Member, profile: AiMember, runs: list[AiRun], settings, usage_today: dict
) -> dict:
    """The one status a row shows, most blocking first (E): key invalid / not logged in, runner not detected, model
    retired, over budget, rate-limited, paused, then running, idle, online."""
    running = [r for r in runs if r.state in ("starting", "running")]
    if member.kind == "ai_removed":
        return {"code": "removed", "label": "Removed", "detail": None}
    if profile.remove_after_run:
        return {"code": "removing", "label": "Removing after its run", "detail": None}
    if profile.health == "key_invalid":
        # "401 from provider": the code, not the provider's whole message
        code = re.search(r"\b(40[13])\b", profile.health_detail or "")
        return {
            "code": "key_invalid",
            "label": "Key invalid",
            "detail": f"{code.group(1)} from provider"
            if code
            else (profile.health_detail or "401 from provider"),
        }
    if profile.health == "not_logged_in":
        return {
            "code": "not_logged_in",
            "label": "CLI not logged in",
            "detail": profile.health_detail,
        }
    if profile.health == "runner_missing":
        return {
            "code": "runner_missing",
            "label": "Runner not detected",
            "detail": profile.health_detail,
        }
    if profile.health == "model_retired":
        return {
            "code": "model_retired",
            "label": "Model retired",
            "detail": profile.health_detail,
        }
    block = usage_today.get("budget_block")
    if block:
        return {"code": "over_budget", "label": block[0], "detail": block[1]}
    if profile.health == "rate_limited":
        return {
            "code": "rate_limited",
            "label": "Rate-limited",
            "detail": profile.health_detail,
        }
    if settings.paused_all:
        return {
            "code": "paused_all",
            "label": "AI paused",
            "detail": settings.paused_reason,
        }
    if profile.paused:
        # "Paused by user" for a person's pause; an automatic pause (a run of failures) keeps its own reason
        by_person = not profile.paused_reason or profile.paused_reason.startswith(
            "Paused by"
        )
        return {
            "code": "paused",
            "label": "Paused by user" if by_person else "Paused",
            "detail": profile.paused_reason,
        }
    if running:
        return {
            "code": "running",
            "label": "Running",
            "detail": running[0].ticket_id,
            "ticket_id": running[0].ticket_id,
        }
    if profile.connection == "inbox":
        return {
            "code": "inbox",
            "label": "Inbox only",
            "detail": "Connects through MCP",
        }
    if profile.connection == "local":
        return {"code": "idle", "label": "Idle", "detail": None}
    return {"code": "online", "label": "Online", "detail": None}


async def _account_ref(session: AsyncSession, profile: AiMember) -> dict | None:
    """The AI account a member runs as, with how many members share it (never a login)."""
    if not profile.account_id:
        return None
    account = await session.get(accounts.AiAccount, profile.account_id)
    if account is None:
        return None
    shared = await accounts.members_of(session, account.id)
    return {
        "id": account.id,
        "name": account.name,
        "cli": account.cli,
        "cli_label": accounts.ACCOUNT_CLIS[account.cli]["label"],
        "status": account.status,
        "email": account.email,
        "plan": account.plan,
        "method": account.method,
        "signed_out_at": account.signed_out_at,
        "shared_by": len(shared),
    }


async def describe(
    session: AsyncSession, member: Member, profile: AiMember, settings=None
) -> dict:
    """An AI member for the API (never its key, only the last 4 characters)."""
    settings = settings or await get_settings(session, member.project_id)
    runs = await active_runs(session, member_id=member.id)
    use = await usage(session, member.id)
    use["budget_block"] = await budget.blocked(session, profile, settings)
    last = (
        await session.exec(
            select(AiRun)
            .where(AiRun.member_id == member.id, col(AiRun.ended_at).is_not(None))
            .order_by(col(AiRun.ended_at).desc())
            .limit(1)
        )
    ).first()
    assigned = (
        await session.exec(
            select(Ticket).where(
                Ticket.assignee == member.id,
                col(Ticket.status).not_in(["done", "wont_do"]),
            )
        )
    ).all()
    config = merged_config(loads(profile.config, {}))
    titles = {t.id: t for t in assigned}
    for r in runs:
        if r.ticket_id not in titles and (t := await session.get(Ticket, r.ticket_id)):
            titles[r.ticket_id] = t
    return {
        "id": member.id,
        "project_id": member.project_id,
        "name": member.name,
        "color": member.color,
        "kind": member.kind,
        "provider": profile.provider,
        "provider_label": PROVIDERS.get(profile.provider, {}).get(
            "label", profile.provider
        ),
        "connection": profile.connection,
        "description": profile.description,
        "glyph": profile.glyph,
        "cli_path": profile.cli_path,
        "working_dir": profile.working_dir,
        "base_url": profile.base_url,
        "model": profile.model,
        "key_last4": profile.key_last4,
        "persona": profile.persona,
        "max_parallel": profile.max_parallel,
        "daily_budget": profile.daily_budget,
        "monthly_cap": profile.monthly_cap,
        "max_runs_per_day": profile.max_runs_per_day,
        "tokens_per_day": profile.tokens_per_day,
        "cap_per_run": profile.cap_per_run,
        "warn_at": loads(profile.warn_at, [80, 100]),
        "safe_mode": profile.safe_mode,
        "allow_external": profile.allow_external,
        "key_rotated_at": profile.key_rotated_at,
        "mcp_last_used_at": profile.mcp_last_used_at,
        "token_revoked_at": profile.token_revoked_at,
        "token_revoked_by": profile.token_revoked_by,
        "template": profile.template,
        "ceiling": profile.ceiling,
        "permissions": {
            k: v for k, v in loads(profile.permissions, {}).items() if k != "_pending"
        },
        "pending_change": pending_change(profile),
        "projects": await multiproject.projects_of(session, member.id),
        "linked_to": profile.linked_to,
        "scope": profile.scope,
        "config": config_model.public_config(config),
        "capabilities": capabilities(profile.provider),
        "paused": profile.paused,
        "paused_at": profile.paused_at,
        "paused_reason": profile.paused_reason,
        "health": profile.health,
        "health_detail": profile.health_detail,
        "checked_at": profile.checked_at,
        "last_call_at": profile.last_call_at,
        "retry_at": profile.retry_at,
        "cli_version": profile.cli_version,
        "account": profile.account,
        "account_id": profile.account_id,
        "account_ref": await _account_ref(session, profile),
        "is_board_ai": settings.board_ai_id == member.id,
        "status": status_of(member, profile, runs, settings, use),
        "running": [
            {
                "run_id": r.id,
                "ticket_id": r.ticket_id,
                "ticket_title": titles[r.ticket_id].title
                if r.ticket_id in titles
                else None,
                "ticket_status": titles[r.ticket_id].status
                if r.ticket_id in titles
                else None,
                "state": r.state,
                "number": r.number,
                "started_at": r.started_at,
            }
            for r in runs
        ],
        # What needs a person's approval for this AI (template and its own overrides), as the card lists it
        "approvals": [
            {"action": row["action"], "label": row["label"]}
            for row in perms.matrix(profile)
            if row["mode"] == perms.APPROVAL
        ],
        "slots_in_use": len([r for r in runs if r.state in ("starting", "running")]),
        "queued": len([r for r in runs if r.state == "queued"]),
        "assigned": [
            {"id": t.id, "title": t.title, "status": t.status} for t in assigned
        ],
        "usage": {k: v for k, v in use.items() if k not in ("days", "budget_block")},
        "last_run_at": last.ended_at if last else None,
        "last_run": {
            "ticket_id": last.ticket_id,
            "state": last.state,
            "number": last.number,
            "ended_at": last.ended_at,
        }
        if last
        else None,
        "created_by": profile.created_by,
        "created_at": profile.created_at,
    }


async def list_members(
    session: AsyncSession, project_id: str, include_removed: bool = False
) -> list[dict]:
    """The project's AI members, described."""
    kinds = ["ai", "ai_removed"] if include_removed else ["ai"]
    members = (
        await session.exec(
            select(Member).where(
                Member.project_id == project_id, col(Member.kind).in_(kinds)
            )
        )
    ).all()
    settings = await get_settings(session, project_id)
    out = []
    for m in members:
        profile = await session.get(AiMember, m.id)
        if profile is not None:
            out.append(await describe(session, m, profile, settings))
    out.sort(key=lambda d: d["created_at"])
    return out


def utcnow() -> datetime:
    """Now (UTC)."""
    return datetime.now(UTC)
