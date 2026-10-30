"""REST API of the Configuration tab of an AI member: sync preview and write, conflicts and backups, ticks, import /
export, reset, prompt preview, tool checks, MCP probes, dry run and the shared library
(design/screens/ai-provider-config.md)."""

import json
import os
import re
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import events as board_events
from api.ai import Session, _ai, _by
from models import Project, Ticket
from services.ai import api_prompt, custom_tools, dry_run, mcp_remote, paths, secrets
from services.ai import config_model as cm
from services.ai import config_service as svc
from services.ai import library as lib
from services.ai import members as svc_members
from services.ai.providers import PROVIDERS, merged_config
from services.ai.store import loads

router = APIRouter(tags=["ai-config"])


def _refuse(exc: Exception, status: int = 422):
    raise HTTPException(status_code=status, detail=str(exc)) from exc


def _draft(profile, config: dict | None) -> dict:
    """The configuration to work on: the draft from the UI over the saved one (secret headers kept)."""
    old = merged_config(loads(profile.config, {}))
    if config is None:
        return old
    return merged_config(cm.prepare_config(old, {**old, **config}))


# ---------------------------------------------------------------------------
# Status, validation, sync
# ---------------------------------------------------------------------------


@router.get("/ai/members/{member_id}/config/status")
async def get_config_status(member_id: str, session: Session) -> dict:
    """Version, last sync, Documented ticks, skipped items, runner and the undo of a reset."""
    _, profile = await _ai(session, member_id)
    out = await svc.status(session, member_id)
    from services.ai.runs import RT

    out["endpoint"] = f"{RT.board_url or 'http://127.0.0.1:8000'}/mcp/"
    return out


class ConfigBody(BaseModel):
    """A (draft) configuration, and the member fields that are checked with it."""

    config: Optional[dict[str, Any]] = None
    working_dir: Optional[str] = None


@router.post("/ai/members/{member_id}/config/validate")
async def post_validate(member_id: str, body: ConfigBody, session: Session) -> dict:
    """Every problem of a draft configuration; errors block Save, warnings do not."""
    _, profile = await _ai(session, member_id)
    cfg = _draft(profile, body.config)
    issues = cm.validate_config(cfg, profile.provider)
    folder = (body.working_dir or "").strip()
    if profile.connection == "local" and folder:
        try:
            real = paths.folder(folder)
            problem = (
                None if os.path.isdir(real) else "Folder not found on this computer."
            )
        except paths.PathRefused:
            problem = paths.folder_refused(folder)
        if problem:
            issues.append(
                {"path": "working_dir", "message": problem, "severity": "error"}
            )
    return {"issues": issues}


@router.post("/ai/members/{member_id}/config/preview")
async def post_preview(member_id: str, body: ConfigBody, session: Session) -> dict:
    """The sync preview: files the runner would write, with diffs, and the conflicts."""
    await _ai(session, member_id)
    return await svc.preview(session, member_id, body.config)


class ResolutionItem(BaseModel):
    """How to settle one file with a conflict."""

    path: str
    choice: str  # keep | overwrite


class WriteBody(BaseModel):
    """Write now."""

    resolutions: list[ResolutionItem] = []
    confirm_hooks: Optional[str] = None


@router.post("/ai/members/{member_id}/config/write")
async def post_write(member_id: str, body: WriteBody, session: Session) -> dict:
    """Write the synced files now; conflicts without a choice stop everything, nothing is overwritten."""
    await _ai(session, member_id)
    out = await svc.write(
        session,
        member_id,
        resolutions=[r.model_dump() for r in body.resolutions],
        confirm_hooks=body.confirm_hooks,
        by=_by(),
    )
    await board_events.publish("invalidate")
    return out


class RestoreBody(BaseModel):
    """Restore an earlier version of a synced file."""

    path: str
    backup_id: str


@router.post("/ai/members/{member_id}/config/restore")
async def post_restore(member_id: str, body: RestoreBody, session: Session) -> dict:
    """Put a backup back (the current file is backed up first)."""
    await _ai(session, member_id)
    try:
        return await svc.restore_backup(
            session, member_id, body.path, body.backup_id, _by()
        )
    except svc.ConfigError as exc:
        _refuse(exc)


class TickBody(BaseModel):
    """Tick or untick a Documented item."""

    item: str
    done: bool = True


@router.post("/ai/members/{member_id}/config/tick")
async def post_tick(member_id: str, body: TickBody, session: Session) -> dict:
    """“I've done this”: who and when are kept; a change to the item clears the tick."""
    await _ai(session, member_id)
    try:
        return await svc.set_tick(session, member_id, body.item, body.done, _by())
    except svc.ConfigError as exc:
        _refuse(exc)


# ---------------------------------------------------------------------------
# Import, export, reset
# ---------------------------------------------------------------------------


@router.post("/ai/members/{member_id}/config/export")
async def post_export(member_id: str, body: ConfigBody, session: Session) -> dict:
    """The configuration as a JSON file text (never with secrets)."""
    member, profile = await _ai(session, member_id)
    state = await svc.get_state(session, member_id)
    draft = body.config
    if draft is not None:
        profile.config = json.dumps(_draft(profile, draft))
    payload = svc.export_payload(profile, state.version)
    name = re.sub(r"[^a-z0-9]+", "-", member.name.lower()).strip("-") or "member"
    return {
        "filename": f"{name}.config.json",
        "text": json.dumps(payload, indent=2, ensure_ascii=False),
    }


class ImportBody(BaseModel):
    """A file chosen for import."""

    text: str
    config: Optional[dict[str, Any]] = None
    mode: str = "merge"


@router.post("/ai/members/{member_id}/config/import-preview")
async def post_import_preview(
    member_id: str, body: ImportBody, session: Session
) -> dict:
    """What importing the file adds; the result goes into the form as unsaved changes."""
    _, profile = await _ai(session, member_id)
    try:
        payload = json.loads(body.text)
    except ValueError:
        _refuse(ValueError("This is not a JSON file."))
    try:
        return svc.import_preview(
            profile, _draft(profile, body.config), payload, body.mode
        )
    except svc.ConfigError as exc:
        _refuse(exc)


@router.post("/ai/members/{member_id}/config/reset")
async def post_reset(member_id: str, session: Session) -> dict:
    """Reset the configuration to the adapter's defaults; it can be undone for 30 days."""
    await _ai(session, member_id)
    out = await svc.reset(session, member_id, _by())
    await board_events.publish("invalidate")
    return out


@router.post("/ai/members/{member_id}/config/undo-reset")
async def post_undo_reset(member_id: str, session: Session) -> dict:
    """Bring back the configuration from before the last reset."""
    await _ai(session, member_id)
    try:
        out = await svc.undo_reset(session, member_id, _by())
    except svc.ConfigError as exc:
        _refuse(exc)
    await board_events.publish("invalidate")
    return out


# ---------------------------------------------------------------------------
# Model list, MCP probe
# ---------------------------------------------------------------------------


@router.get("/ai/members/{member_id}/models")
async def get_models(member_id: str, session: Session) -> dict:
    """Models to pick from: the provider's own list for API members (with the stored key), aliases for Claude Code."""
    _, profile = await _ai(session, member_id)
    spec = PROVIDERS.get(profile.provider, {})
    builtin = [{"id": m, "label": m} for m in spec.get("models", [])]
    if profile.provider == "claude-code":
        labels = {
            "sonnet": "Sonnet (alias)",
            "haiku": "Haiku (alias)",
            "opus": "Opus (alias)",
        }
        ids = list(dict.fromkeys([*spec.get("models", []), "opus"]))
        return {
            "source": "aliases",
            "models": [{"id": i, "label": labels.get(i, i)} for i in ids],
            "error": None,
        }
    if profile.provider == "antigravity":
        return {"source": "builtin", "models": builtin, "error": None}
    if profile.connection != "api_key":
        return {"source": "none", "models": [], "error": None}
    key = secrets.decrypt(profile.key_enc)
    if not key:
        return {
            "source": "builtin",
            "models": builtin,
            "error": "No readable key is stored; enter it again to load the provider's list.",
        }
    res = await svc_members.test_key(profile.provider, key, profile.base_url)
    if res.get("ok") and res.get("models"):
        return {
            "source": "provider",
            "models": [{"id": m, "label": m} for m in res["models"]],
            "error": None,
        }
    return {
        "source": "builtin",
        "models": builtin,
        "error": res.get("error") or res.get("note"),
    }


class ProbeBody(BaseModel):
    """Check an MCP server."""

    kind: str  # kanban | mcp_servers | remote_mcp
    server: Optional[dict[str, Any]] = None


def _expand_env(value: str) -> str:
    return re.sub(
        r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}",
        lambda m: os.environ.get(m.group(1), ""),
        value,
    )


@router.post("/ai/members/{member_id}/mcp/probe")
async def post_probe(member_id: str, body: ProbeBody, session: Session) -> dict:
    """Status probe of an MCP server: connected with N tools, or why not. Only runs when asked."""
    from services.ai.runs import RT

    _, profile = await _ai(session, member_id)
    if body.kind == "kanban":
        return {
            **await mcp_remote.probe_http(
                f"{RT.board_url or 'http://127.0.0.1:8000'}/mcp/"
            ),
            "state": "checked",
        }
    if not body.server:
        _refuse(ValueError("Nothing to check."))
    old = merged_config(loads(profile.config, {}))
    if body.kind == "remote_mcp":
        s = cm.normalize_remote(body.server)
        saved = next((x for x in old["remote_mcp"] if x["id"] == s["id"]), None)
        headers = {}
        for h in s["headers"]:
            if h["secret"] and not h["value"].strip() and saved:
                prev = next(
                    (
                        x
                        for x in saved["headers"]
                        if x["name"].lower() == h["name"].lower()
                    ),
                    None,
                )
                headers.update(cm.header_values([prev]) if prev else {})
            elif h["value"].strip():
                headers[h["name"]] = h["value"].strip()
            elif not h["secret"] and h["value"]:
                headers[h["name"]] = h["value"]
        if not s["url"].startswith(
            ("https://", "http://localhost", "http://127.0.0.1")
        ):
            return {
                "ok": False,
                "tools": 0,
                "seconds": 0,
                "error": "stdio servers cannot run on the board server. Use a remote HTTP URL.",
                "state": "checked",
            }
        return {**await mcp_remote.probe_http(s["url"], headers), "state": "checked"}
    s = cm.normalize_server(body.server)
    if s["mode"] == "documented":
        return {
            "ok": None,
            "tools": 0,
            "seconds": 0,
            "error": None,
            "state": "documented",
        }
    if s["type"] == "http":
        return {
            **await mcp_remote.probe_http(
                s["url"], {p["name"]: _expand_env(p["value"]) for p in s["headers"]}
            ),
            "state": "checked",
        }
    folder = os.path.expanduser(profile.working_dir or "") or None
    if folder and not os.path.isdir(folder):
        folder = None
    env = {p["name"]: _expand_env(p["value"]) for p in s["env"]}
    return {
        **await mcp_remote.probe_stdio(s["command"], s["args"], env, folder),
        "state": "checked",
    }


# ---------------------------------------------------------------------------
# API agent: prompt preview, tools, dry run
# ---------------------------------------------------------------------------


class PreviewBody(BaseModel):
    """Preview the prompt on a ticket."""

    ticket_id: Optional[str] = None
    config: Optional[dict[str, Any]] = None


async def _sample_ticket(session, project_id: str, ticket_id: str | None) -> str:
    if ticket_id:
        return ticket_id
    from sqlmodel import col, select

    t = (
        await session.exec(
            select(Ticket)
            .where(Ticket.project_id == project_id)
            .order_by(col(Ticket.created_at).desc())
            .limit(1)
        )
    ).first()
    if t is None:
        _refuse(ValueError("This project has no tickets to preview with."))
    return t.id


@router.post("/ai/members/{member_id}/prompt/preview")
async def post_prompt_preview(
    member_id: str, body: PreviewBody, session: Session
) -> dict:
    """The system prompt and first message a run on the ticket would send, with token estimates per source."""
    member, profile = await _ai(session, member_id)
    if profile.connection != "api_key":
        _refuse(ValueError("Prompt variables are for API agents."))
    tid = await _sample_ticket(session, profile.project_id, body.ticket_id)
    cfg = _draft(profile, body.config)
    try:
        return await api_prompt.preview(session, profile, member, cfg, tid, _by())
    except ValueError as exc:
        _refuse(exc)


@router.get("/projects/{project_id}/ai/sample-tickets")
async def get_sample_tickets(project_id: str, session: Session) -> list[dict]:
    """Recent tickets to preview and dry-run with."""
    from sqlmodel import col, select

    if await session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    rows = (
        await session.exec(
            select(Ticket)
            .where(Ticket.project_id == project_id)
            .order_by(col(Ticket.created_at).desc())
            .limit(30)
        )
    ).all()
    return [{"id": t.id, "title": t.title, "status": t.status} for t in rows]


class ToolCheckBody(BaseModel):
    """A tool file to check."""

    spec: str


@router.post("/ai/tools/check")
async def post_tool_check(body: ToolCheckBody) -> dict:
    """Parse and check a ``*.tool.json`` text while it is typed: problems with line, path and a “did you mean”."""
    res = cm.check_tool_spec(body.spec)
    tool = res["tool"] or {}
    return {
        "ok": res["ok"],
        "problems": res["problems"],
        "name": tool.get("name"),
        "method": (tool.get("http") or {}).get("method", "GET"),
        "url": (tool.get("http") or {}).get("url"),
        "sample_args": custom_tools.sample_args(tool.get("input_schema") or {})
        if tool
        else "{}",
    }


class HeaderIn(BaseModel):
    """A header typed into the form."""

    name: str
    value: str = ""
    secret: bool = False


class ToolTestBody(BaseModel):
    """A test call of a custom tool."""

    spec: str
    headers: list[HeaderIn] = []
    tool_id: Optional[str] = None
    args_text: str = "{}"


@router.post("/ai/members/{member_id}/tools/test")
async def post_tool_test(member_id: str, body: ToolTestBody, session: Session) -> dict:
    """Call the tool once with the arguments given (a real request: a POST really happens)."""
    _, profile = await _ai(session, member_id)
    try:
        args = json.loads(body.args_text or "{}")
        assert isinstance(args, dict)
    except (ValueError, AssertionError):
        _refuse(ValueError("The arguments must be a JSON object."))
    old = merged_config(loads(profile.config, {}))
    saved = next((t for t in old["custom_tools"] if t["id"] == body.tool_id), None)
    headers: dict[str, str] = {}
    for h in body.headers:
        if h.value.strip():
            headers[h.name] = h.value.strip()
        elif h.secret and saved:
            prev = next(
                (x for x in saved["headers"] if x["name"].lower() == h.name.lower()),
                None,
            )
            if prev:
                headers.update(cm.header_values([prev]))
    # The request goes to the URL of the saved tool, never to one sent with the test: members may test the tools an
    # admin saved, not call any address they type.
    if saved is None or saved["spec"] != body.spec:
        _refuse(
            ValueError(
                "Test calls the saved tool. Save the tool and the configuration first, then test it."
            )
        )
    res = await custom_tools.call(saved["spec"], headers, args)
    return {k: v for k, v in res.items() if k != "simulated"}


class DryRunBody(BaseModel):
    """A dry run on a ticket."""

    ticket_id: str
    config: Optional[dict[str, Any]] = None
    simulate: bool = True


@router.post("/ai/members/{member_id}/dry-run")
async def post_dry_run(member_id: str, body: DryRunBody, session: Session) -> dict:
    """Simulate a run with the unsaved configuration: real model calls and reads, writes only shown."""
    member, profile = await _ai(session, member_id)
    if not body.simulate:
        _refuse(
            ValueError(
                "A dry run always simulates writes. Use a real run on a test ticket to apply changes."
            )
        )
    cfg = _draft(profile, body.config)
    errors = [
        e for e in cm.validate_config(cfg, profile.provider) if e["severity"] == "error"
    ]
    if errors:
        _refuse(ValueError(f"Fix the configuration first: {errors[0]['message']}"))
    try:
        return await dry_run.run(session, profile, member, cfg, body.ticket_id, _by())
    except ValueError as exc:
        _refuse(exc)


# ---------------------------------------------------------------------------
# Library
# ---------------------------------------------------------------------------


@router.get("/projects/{project_id}/ai/library")
async def get_library(
    project_id: str,
    session: Session,
    type: Optional[str] = None,
    q: Optional[str] = None,
) -> dict:
    """The shared library with versions, who uses each item and who is behind."""
    if await session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return await lib.list_items(session, project_id, type, q)


class LibraryBody(BaseModel):
    """A new library item."""

    type: str
    name: str
    description: str = ""
    content: str


@router.post("/projects/{project_id}/ai/library", status_code=201)
async def post_library(project_id: str, body: LibraryBody, session: Session) -> dict:
    """Add an item (version 1)."""
    if await session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    try:
        item = await lib.create(
            session,
            project_id,
            type_=body.type,
            name=body.name,
            description=body.description,
            content=body.content,
            by=_by(),
        )
    except lib.LibraryError as exc:
        _refuse(exc)
    return await lib.describe(session, item)


@router.get("/ai/library/{item_id}")
async def get_library_item(item_id: str, session: Session) -> dict:
    """One item with its content, history and users."""
    try:
        return await lib.describe(session, await lib.get_item(session, item_id))
    except lib.LibraryError as exc:
        _refuse(exc, 404)


class VersionBody(BaseModel):
    """Save an edit as a new version."""

    content: str
    description: Optional[str] = None
    note: Optional[str] = None


@router.post("/ai/library/{item_id}/versions")
async def post_library_version(
    item_id: str, body: VersionBody, session: Session
) -> dict:
    """The next version of an item; members stay on theirs until updated."""
    try:
        item = await lib.new_version(
            session,
            item_id,
            content=body.content,
            description=body.description,
            note=body.note,
            by=_by(),
        )
    except lib.LibraryError as exc:
        _refuse(exc)
    return await lib.describe(session, item)


@router.delete("/ai/library/{item_id}")
async def delete_library_item(item_id: str, session: Session) -> dict:
    """Remove an item no member uses."""
    try:
        await lib.delete(session, item_id, _by())
    except lib.LibraryError as exc:
        _refuse(exc)
    return {"ok": True}


@router.get("/ai/library/{item_id}/diff")
async def get_library_diff(item_id: str, from_version: int, session: Session) -> dict:
    """What changed between a version and the latest (“Review changes”)."""
    try:
        return lib.version_diff(await lib.get_item(session, item_id), from_version)
    except lib.LibraryError as exc:
        _refuse(exc)


class PropagateBody(BaseModel):
    """Members to bring to the latest version."""

    member_ids: list[str]


@router.post("/ai/library/{item_id}/propagate")
async def post_library_propagate(
    item_id: str, body: PropagateBody, session: Session
) -> dict:
    """“Update N members”: their saved configuration moves to the latest version."""
    try:
        out = await lib.propagate(session, item_id, body.member_ids, _by())
    except lib.LibraryError as exc:
        _refuse(exc)
    await board_events.publish("invalidate")
    return out


class AttachBody(BaseModel):
    """Attach, update or detach a library item in a draft configuration."""

    item_id: str
    config: Optional[dict[str, Any]] = None


async def _library_edit(member_id: str, body: AttachBody, session, how: str) -> dict:
    _, profile = await _ai(session, member_id)
    try:
        item = await lib.get_item(session, body.item_id)
        cfg = _draft(profile, body.config)
        if how == "attach":
            new = lib.attach(item, cfg, profile.provider)
        elif how == "update":
            new = lib.update_in(item, cfg)
        else:
            new = lib.detach(item.id, cfg)
    except lib.LibraryError as exc:
        _refuse(exc)
    return {
        "config": cm.public_config(new),
        "item": {"name": item.name, "version": item.version, "type": item.type},
    }


@router.post("/ai/members/{member_id}/library/attach")
async def post_library_attach(
    member_id: str, body: AttachBody, session: Session
) -> dict:
    """The draft configuration with the item attached (not saved yet)."""
    return await _library_edit(member_id, body, session, "attach")


@router.post("/ai/members/{member_id}/library/update")
async def post_library_update(
    member_id: str, body: AttachBody, session: Session
) -> dict:
    """The draft configuration with the item at its latest version (not saved yet)."""
    return await _library_edit(member_id, body, session, "update")


@router.post("/ai/members/{member_id}/library/detach")
async def post_library_detach(
    member_id: str, body: AttachBody, session: Session
) -> dict:
    """The draft configuration without the item (not saved yet)."""
    return await _library_edit(member_id, body, session, "detach")
