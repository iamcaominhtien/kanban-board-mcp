"""The Configuration tab's server side: what a sync would write, writing it, conflicts and backups, "I've done this"
ticks, import / export, reset with undo (design/screens/ai-provider-config.md)."""

import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlmodel.ext.asyncio.session import AsyncSession

from models import AiConfigState, AiMember, Member

from . import audit
from . import config_model as cm
from . import config_sync as cs
from .providers import GROUPS, adapter_of, capabilities, merged_config
from .store import get_profile, loads, now_iso, parse_iso

UNDO_DAYS = 30
HOOKS_PHRASE = "allow hooks"


class ConfigError(ValueError):
    """A configuration request was refused; the message is shown as is."""


async def get_state(session: AsyncSession, member_id: str) -> AiConfigState:
    """The member's config state row (created on first use)."""
    state = await session.get(AiConfigState, member_id)
    if state is None:
        state = AiConfigState(member_id=member_id)
        session.add(state)
        await session.commit()
        await session.refresh(state)
    return state


async def bump_version(session: AsyncSession, member_id: str) -> int:
    """The configuration changed: a new version number."""
    state = await get_state(session, member_id)
    state.version += 1
    state.updated_at = now_iso()
    session.add(state)
    await session.commit()
    return state.version


def apply_patch(profile: AiMember, patch: dict) -> dict:
    """The configuration after a save: the patch merged over what is stored (secret headers kept), validated.

    Raises:
        ConfigError: Something in it is invalid (the first error is the message; `errors` holds all of them).
    """
    old = merged_config(loads(profile.config, {}))
    cfg = merged_config(cm.prepare_config(old, {**old, **patch}))
    # prepare_config encrypted typed-in secrets; validation sees the normalised result
    errors = [
        e for e in cm.validate_config(cfg, profile.provider) if e["severity"] == "error"
    ]
    if errors:
        exc = ConfigError(errors[0]["message"])
        exc.errors = errors  # type: ignore[attr-defined]
        raise exc
    return cfg


# ---------------------------------------------------------------------------
# Runner and plan
# ---------------------------------------------------------------------------


def runner_info(profile: AiMember) -> dict:
    """Can this computer write into the member's working folder right now?"""
    folder = os.path.expanduser(profile.working_dir or "")
    if not folder:
        return {
            "online": False,
            "reason": "No working folder is set.",
            "folder": None,
            "root": None,
        }
    p = Path(folder)
    if not p.is_dir():
        return {
            "online": False,
            "reason": f"The working folder was not found on this computer: {profile.working_dir}",
            "folder": profile.working_dir,
            "root": None,
        }
    return {
        "online": True,
        "reason": None,
        "folder": profile.working_dir,
        "root": p.resolve(),
    }


def _board_url() -> str:
    from .runs import RT

    return RT.board_url or "http://127.0.0.1:8000"


def _unit_text(kind: str, key: str, value: str | None) -> str | None:
    if value is None:
        return None
    if kind in ("block", "text"):
        return value
    if kind == "mcp":
        return f'"{key[7:]}": ' + json.dumps(
            json.loads(value), indent=2, ensure_ascii=False
        )
    return key.replace(cs.SEP, " · ")


async def _specs(session, profile, cfg, state) -> tuple[list[cs.Spec], dict]:
    files = loads(state.files, {})
    adapter = adapter_of(profile.provider)
    if adapter == "claude-code":
        specs, notes = cs.desired_specs(
            cfg, _board_url(), loads(state.hooks_ok, {}), set(files)
        )
    else:
        return [], {"hooks_pending": False}
    have = {s.path for s in specs}
    for path, entry in files.items():
        if path not in have:  # no longer wanted: its units go
            specs.append(
                cs.Spec(
                    path,
                    entry.get("kind") or "text",
                    {k: None for k in (entry.get("units") or {})},
                )
            )
    return specs, notes


async def build_plan(
    session: AsyncSession,
    profile: AiMember,
    cfg: dict,
    resolutions: dict[str, str] | None = None,
) -> tuple[list[cs.FilePlan], dict, dict, AiConfigState]:
    """Plan every file of the member (without touching the disk)."""
    state = await get_state(session, profile.id)
    runner = runner_info(profile)
    specs, notes = await _specs(session, profile, cfg, state)
    files = loads(state.files, {})
    plans = []
    for spec in specs:
        text = cs.read_text(runner["root"], spec.path)
        plans.append(
            cs.plan_file(
                spec, text, files.get(spec.path), (resolutions or {}).get(spec.path)
            )
        )
    return plans, notes, runner, state


def _describe_plan(
    plans: list[cs.FilePlan], files_state: dict, runner: dict
) -> tuple[list[dict], list[dict]]:
    files, conflicts = [], []
    root = runner["root"]
    for p in plans:
        if p.error:
            files.append(
                {
                    "path": p.path,
                    "action": "error",
                    "added": 0,
                    "removed": 0,
                    "diff": [],
                    "error": p.error,
                    "foreign": False,
                    "conflict": False,
                }
            )
            continue
        for c in p.conflicts:
            mine = _unit_text(p.spec.kind, c["unit"], c["mine"])
            board = _unit_text(p.spec.kind, c["unit"], c["board"])
            edited = None
            if root is not None:
                try:
                    edited = datetime.fromtimestamp(
                        (root / p.path).stat().st_mtime, UTC
                    ).isoformat()
                except OSError:
                    edited = None
            conflicts.append(
                {
                    "path": p.path,
                    "unit": c["unit"],
                    "kind": c["kind"],
                    "written_at": (files_state.get(p.path) or {}).get("written_at"),
                    "edited_at": edited,
                    "diff": cs.diff_lines(board, mine),
                    "backups": cs.list_backups(root, p.path),
                }
            )
        if p.action == "unchanged":
            continue
        added, removed = cs.count_changes(p.old, p.new)
        files.append(
            {
                "path": p.path,
                "action": p.action,
                "added": added,
                "removed": removed,
                "diff": cs.diff_lines(p.old, p.new),
                "error": None,
                "foreign": p.foreign and p.action == "modified",
                "conflict": bool(p.conflicts),
            }
        )
    return files, conflicts


async def preview(
    session: AsyncSession, member_id: str, config: dict | None = None
) -> dict:
    """The sync preview (B8, B9, F5): files to write with diffs, conflicts, hooks waiting for confirmation."""
    member, profile = await get_profile(session, member_id)
    cfg = (
        merged_config(loads(profile.config, {}))
        if config is None
        else merged_config(config)
    )
    plans, notes, runner, state = await build_plan(session, profile, cfg)
    files_state = loads(state.files, {})
    files, conflicts = _describe_plan(plans, files_state, runner)
    adapter = adapter_of(profile.provider)
    return {
        "mode": "synced" if adapter == "claude-code" else "none",
        "runner": {k: v for k, v in runner.items() if k != "root"},
        "files": files,
        "conflicts": conflicts,
        "hooks_pending": notes["hooks_pending"],
        "hooks_hash": cs.hooks_hash(cfg),
        "pending": len([f for f in files if f["action"] != "error"])
        if not runner["online"]
        else 0,
        "backups": [
            {"path": p.path, "items": found}
            for p in plans
            if (found := cs.list_backups(runner["root"], p.path))
        ],
        "synced_at": state.synced_at,
        "synced_files": len(files_state),
    }


async def write(
    session: AsyncSession,
    member_id: str,
    *,
    resolutions: list[dict] | None = None,
    confirm_hooks: str | None = None,
    by: str = "user",
) -> dict:
    """Write the synced files now ("Write now"). Conflicts that have no choice yet stop everything (nothing is
    written); a failed write puts the earlier ones back.

    Returns:
        {ok, written[paths], conflicts, error{path, message}} (the preview, after writing, is a separate call).
    """
    member, profile = await get_profile(session, member_id)
    cfg = merged_config(loads(profile.config, {}))
    choice = {
        r["path"]: r["choice"]
        for r in resolutions or []
        if r.get("choice") in ("keep", "overwrite")
    }
    state = await get_state(session, member_id)
    if confirm_hooks is not None:
        if confirm_hooks.strip() != HOOKS_PHRASE:
            return {
                "ok": False,
                "written": [],
                "conflicts": [],
                "error": {
                    "path": ".claude/settings.json",
                    "message": f"Type “{HOOKS_PHRASE}” exactly to confirm.",
                },
            }
        state.hooks_ok = json.dumps(
            {"hash": cs.hooks_hash(cfg), "by": by, "at": now_iso()}
        )
        session.add(state)
        await session.commit()
        await audit.record(
            member.project_id,
            "hooks_confirmed",
            "info",
            member_id=member_id,
            member_name=member.name,
            on_behalf_of=by,
            detail={"hooks": len([h for h in cfg["hooks"] if h["enabled"]])},
        )
    plans, notes, runner, state = await build_plan(session, profile, cfg, choice)
    if not runner["online"]:
        return {
            "ok": False,
            "written": [],
            "conflicts": [],
            "error": {"path": "", "message": runner["reason"]},
            "offline": True,
        }
    bad = next((p for p in plans if p.error), None)
    if bad:
        return {
            "ok": False,
            "written": [],
            "conflicts": [],
            "error": {"path": bad.path, "message": bad.error},
        }
    open_conflicts = [p for p in plans if p.conflicts and p.path not in choice]
    if open_conflicts:
        _, conflicts = _describe_plan(open_conflicts, loads(state.files, {}), runner)
        return {"ok": False, "written": [], "conflicts": conflicts, "error": None}
    try:
        new_files = cs.apply_plans(runner["root"], plans, loads(state.files, {}))
    except cs.SyncError as exc:
        return {
            "ok": False,
            "written": [],
            "conflicts": [],
            "error": {"path": exc.path, "message": exc.message},
        }
    state.files = json.dumps(new_files)
    state.synced_at = now_iso()
    state.synced_files = len(new_files)
    state.updated_at = now_iso()
    session.add(state)
    await session.commit()
    written = [p.path for p in plans if p.action in ("new", "modified", "delete")]
    if written:
        await audit.record(
            member.project_id,
            "config_synced",
            "info",
            member_id=member_id,
            member_name=member.name,
            on_behalf_of=by,
            detail={"files": written, "resolved": sorted(choice)},
        )
    return {
        "ok": True,
        "written": written,
        "conflicts": [],
        "error": None,
        "hooks_pending": notes["hooks_pending"],
    }


async def sync_for_run(session: AsyncSession, profile: AiMember) -> dict:
    """Before a Claude Code run: write the synced files. {ok, message} (the run does not start when ok is false)."""
    if adapter_of(profile.provider) != "claude-code":
        return {"ok": True, "message": None}
    res = await write(session, profile.id, by="board")
    if res["ok"]:
        return {"ok": True, "message": None}
    if res["conflicts"]:
        paths = ", ".join(sorted({c["path"] for c in res["conflicts"]}))
        return {
            "ok": False,
            "message": f"{paths} changed outside Kanban. Open Configuration → Sync preview and choose keep or overwrite; nothing was overwritten and the run was not started.",
            "kind": "conflict",
        }
    err = res["error"] or {}
    if err.get("path"):
        return {
            "ok": False,
            "message": f"Could not write {err['path']}. {err['message']} The run was not started.",
            "kind": "failed",
        }
    return {
        "ok": False,
        "message": err.get("message") or "The configuration could not be written.",
        "kind": "failed",
    }


async def restore_backup(
    session: AsyncSession, member_id: str, path: str, backup_id: str, by: str
) -> dict:
    """Put an earlier version of a synced file back (the current one is backed up first)."""
    member, profile = await get_profile(session, member_id)
    runner = runner_info(profile)
    if not runner["online"]:
        raise ConfigError(runner["reason"])
    state = await get_state(session, member_id)
    files = loads(state.files, {})
    if path not in files:
        raise ConfigError("Only files the board wrote can be restored from here.")
    text = cs.read_backup(runner["root"], path, backup_id)
    if text is None:
        raise ConfigError("That backup no longer exists.")
    target = cs._safe_target(runner["root"], path)
    cur = cs.read_text(runner["root"], path)
    try:
        if cur is not None and cur != text:
            cs.backup_file(runner["root"], path, cur)
        cs.write_atomic(target, text)
    except OSError as exc:
        raise ConfigError(f"Could not write {path}: {exc.strerror or exc}") from exc
    files[path] = {**files[path], "sha": cm.sha(text)}
    state.files = json.dumps(files)
    session.add(state)
    await session.commit()
    await audit.record(
        member.project_id,
        "config_restored",
        "info",
        member_id=member_id,
        member_name=member.name,
        on_behalf_of=by,
        detail={"file": path, "backup": backup_id},
    )
    return {"ok": True}


# ---------------------------------------------------------------------------
# Status, ticks
# ---------------------------------------------------------------------------


def _tick_rows(cfg: dict, provider: str, ticks: list[dict]) -> list[dict]:
    by_key = {t["item"]: t for t in ticks}
    rows = []
    for it in cm.documented_items(cfg, provider):
        t = by_key.get(it["key"])
        valid = bool(t) and t.get("hash") == it["hash"]
        rows.append(
            {
                "key": it["key"],
                "label": it["label"],
                "group": it["group"],
                "done": valid,
                "stale": bool(t) and not valid,
                "by": t.get("by") if t else None,
                "at": t.get("at") if t else None,
                "empty": it.get("empty", False),
            }
        )
    return rows


async def status(session: AsyncSession, member_id: str) -> dict:
    """Everything the Configuration tab shows besides the config itself."""
    member, profile = await get_profile(session, member_id)
    state = await get_state(session, member_id)
    cfg = merged_config(loads(profile.config, {}))
    caps = capabilities(profile.provider)
    files_state = loads(state.files, {})
    runner = runner_info(profile)
    ticks = _tick_rows(cfg, profile.provider, loads(state.ticks, []))
    snap = loads(state.reset_snapshot, None)
    undo = None
    if snap:
        at = parse_iso(snap.get("at"))
        if at and datetime.now(UTC) - at < timedelta(days=UNDO_DAYS):
            undo = {
                "at": snap["at"],
                "by": snap.get("by"),
                "days_left": UNDO_DAYS - (datetime.now(UTC) - at).days,
            }
    md = cs.claude_md_text(cfg)
    return {
        "version": state.version,
        "synced_at": state.synced_at,
        "synced_files": len(files_state),
        "declares": len([g for g, m in caps.items() if m != "not_supported"]),
        "groups_total": len(GROUPS),
        "runner": {k: v for k, v in runner.items() if k != "root"},
        "documented": ticks,
        "documented_done": len([t for t in ticks if t["done"]]),
        "skipped": cm.skipped_items(cfg, profile.provider),
        "hooks_confirmed": loads(state.hooks_ok, {}).get("hash") == cs.hooks_hash(cfg),
        "hooks_by": loads(state.hooks_ok, {}).get("by"),
        "instructions_tokens": cm.estimate_tokens(md or ""),
        "undo": undo,
        "issues": cm.validate_config(cfg, profile.provider),
    }


async def set_tick(
    session: AsyncSession, member_id: str, item: str, done: bool, by: str
) -> dict:
    """Tick (or untick) a Documented item: who and when are kept, and the tick is cleared when the item changes."""
    member, profile = await get_profile(session, member_id)
    state = await get_state(session, member_id)
    cfg = merged_config(loads(profile.config, {}))
    items = {i["key"]: i for i in cm.documented_items(cfg, profile.provider)}
    if item not in items:
        raise ConfigError("That item is not a documented step of this member.")
    ticks = [t for t in loads(state.ticks, []) if t["item"] != item]
    if done:
        ticks.append(
            {"item": item, "by": by, "at": now_iso(), "hash": items[item]["hash"]}
        )
    state.ticks = json.dumps(ticks)
    session.add(state)
    await session.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Import, export, reset
# ---------------------------------------------------------------------------

_LISTS = {
    "skills": "name",
    "subagents": "name",
    "mcp_servers": "name",
    "custom_tools": "name",
    "remote_mcp": "name",
}


def export_payload(
    profile: AiMember,
    version: int,
    model: str | None = None,
    persona: str | None = None,
) -> dict:
    """The JSON export (F7): everything but secrets."""
    cfg = merged_config(loads(profile.config, {}))
    return {
        "adapter": adapter_of(profile.provider),
        "provider": profile.provider,
        "version": version,
        "exported_at": now_iso(),
        "model": model if model is not None else profile.model,
        "persona": persona if persona is not None else profile.persona,
        "config": cm.export_config(cfg),
        "secrets": "excluded",
    }


def import_preview(
    profile: AiMember, current: dict, payload: dict, mode: str = "merge"
) -> dict:
    """What importing a file would do to the (draft) configuration. The result is loaded into the form, unsaved."""
    if not isinstance(payload, dict) or not isinstance(payload.get("config"), dict):
        raise ConfigError("This is not a configuration export (no “config” in it).")
    cur = merged_config(current)
    imp = merged_config(payload["config"])
    matches = payload.get("adapter") == adapter_of(profile.provider)
    out = json.loads(json.dumps(cur))
    added: dict[str, int] = {}
    if mode == "replace":
        out = json.loads(json.dumps(imp))
        added = {k: len(imp[k]) for k in _LISTS if imp.get(k)}
    else:
        for key, ident in _LISTS.items():
            have = {i[ident] for i in out.get(key) or []}
            new = [i for i in imp.get(key) or [] if i[ident] not in have]
            if new:
                out[key] = (out.get(key) or []) + new
                added[key] = len(new)
        hooks_have = {(h["event"], h["matcher"], h["command"]) for h in out["hooks"]}
        new_hooks = [
            h
            for h in imp["hooks"]
            if (h["event"], h["matcher"], h["command"]) not in hooks_have
        ]
        if new_hooks:
            out["hooks"] += new_hooks
            added["hooks"] = len(new_hooks)
        for key in ("allow_rules", "deny_rules"):
            extra = [r for r in imp[key] if r not in out[key]]
            if extra:
                out[key] += extra
                added[key] = len(extra)
        for key in payload["config"]:
            if (
                key not in _LISTS
                and key not in ("hooks", "allow_rules", "deny_rules", "snippets")
                and key in cur
            ):
                out[key] = imp[key]
    # Secret headers are never exported: they come back empty and must be entered again
    secrets_missing = [
        f"{i['name']} · {h['name']}"
        for key in ("custom_tools", "remote_mcp")
        for i in out.get(key) or []
        for h in i.get("headers") or []
        if h.get("secret") and not h.get("enc")
    ]
    out = merged_config(out)
    nouns = {
        "skills": "skill",
        "subagents": "subagent",
        "mcp_servers": "server",
        "custom_tools": "tool",
        "remote_mcp": "remote server",
        "hooks": "hook",
        "allow_rules": "allow rule",
        "deny_rules": "deny rule",
    }
    parts = [
        f"{n} {nouns[k]}{'' if n == 1 else 's'}" for k, n in added.items() if k in nouns
    ]
    summary = (
        "Adapter matches; "
        if matches
        else f"The file is for {payload.get('adapter')}, this member is {adapter_of(profile.provider)}: unsupported groups will be skipped. "
    )
    if parts:
        joined = (
            parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]
        )
        summary += f"{joined} will be added."
    else:
        summary += "nothing new to add; settings are taken from the file."
    if secrets_missing:
        summary += " Re-enter secrets."
    return {
        "adapter_matches": matches,
        "summary": summary,
        "added": added,
        "secrets_missing": secrets_missing,
        "config": cm.public_config(out),
        "errors": [
            e
            for e in cm.validate_config(out, profile.provider)
            if e["severity"] == "error"
        ],
        "skipped": cm.skipped_items(out, profile.provider),
    }


async def reset(session: AsyncSession, member_id: str, by: str) -> dict:
    """Reset to adapter defaults (F8). The previous configuration is kept for 30 days so it can be restored."""
    member, profile = await get_profile(session, member_id)
    state = await get_state(session, member_id)
    state.reset_snapshot = json.dumps(
        {
            "config": loads(profile.config, {}),
            "files": loads(state.files, {}),
            "at": now_iso(),
            "by": by,
        }
    )
    state.files = (
        "{}"  # files already written stay on disk, but the board stops managing them
    )
    state.ticks = "[]"
    state.hooks_ok = "{}"
    state.version += 1
    state.updated_at = now_iso()
    profile.config = json.dumps(merged_config({}))
    profile.updated_at = now_iso()
    session.add(state)
    session.add(profile)
    await session.commit()
    await audit.record(
        member.project_id,
        "config_reset",
        "info",
        member_id=member_id,
        member_name=member.name,
        on_behalf_of=by,
    )
    return {"ok": True}


async def undo_reset(session: AsyncSession, member_id: str, by: str) -> dict:
    """Bring back the configuration from before the last Reset."""
    member, profile = await get_profile(session, member_id)
    state = await get_state(session, member_id)
    snap = loads(state.reset_snapshot, None)
    at = parse_iso((snap or {}).get("at"))
    if not snap or not at or datetime.now(UTC) - at > timedelta(days=UNDO_DAYS):
        raise ConfigError("There is nothing to undo.")
    profile.config = json.dumps(snap["config"])
    state.files = json.dumps(snap.get("files") or {})
    state.reset_snapshot = None
    state.version += 1
    state.updated_at = now_iso()
    profile.updated_at = now_iso()
    session.add(state)
    session.add(profile)
    await session.commit()
    await audit.record(
        member.project_id,
        "config_reset_undone",
        "info",
        member_id=member_id,
        member_name=member.name,
        on_behalf_of=by,
    )
    return {"ok": True}


async def members_of(
    session: AsyncSession, project_id: str
) -> list[tuple[Member, AiMember]]:
    """The project's AI members with their profiles."""
    from sqlmodel import col, select

    rows = (
        await session.exec(
            select(Member).where(
                Member.project_id == project_id, col(Member.kind) == "ai"
            )
        )
    ).all()
    out = []
    for m in rows:
        p = await session.get(AiMember, m.id)
        if p is not None:
            out.append((m, p))
    return out
