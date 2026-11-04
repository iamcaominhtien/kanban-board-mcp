"""REST API of the AI team's tools (design/screens/ai-team-process.md B, C, D): skills and plugins installed from a
source, the "Suggested for a role" catalogue, role packs, and the repository scan that gives a project a team."""

import logging
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

import services.activity as svc_activity
from database import get_session
from models import AiPlugin, AiTeam, Project
from services.ai import packs as svc_packs
from services.ai import plugins as svc_plugins
from services.ai import repo_scan as svc_scan

logger = logging.getLogger(__name__)

router = APIRouter(tags=["ai"])
Session = Annotated[AsyncSession, Depends(get_session)]


def _by() -> str:
    return svc_activity.current_actor() or "user"


async def _project(session, project_id: str) -> None:
    if await session.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")


async def _plugin(session, plugin_id: str) -> AiPlugin:
    row = await session.get(AiPlugin, plugin_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Plugin not found")
    return row


def _fail(exc: Exception, status: int = 422):
    raise HTTPException(status_code=status, detail=str(exc)) from exc


# --------------------------------------------------------------------------- the catalogue


@router.get("/ai/catalogue")
async def get_catalogue() -> list[dict]:
    """What each role is suggested to install (D2, D16)."""
    return svc_plugins.CATALOGUE


# --------------------------------------------------------------------------- plugins


@router.get("/ai/board-skills")
async def get_board_skills() -> list[dict]:
    """The board's own skills (the canvas design guide, permissions, the shared skills of issue #277): [{name,
    description}]. Whether each is on for a project or a member is in the project's ops (`board_skills`)."""
    from services.ai import board_skills

    return board_skills.catalog()


@router.get("/projects/{project_id}/ai/plugins")
async def get_plugins(project_id: str, session: Session) -> list[dict]:
    """The project's installed plugins, with their real use counted from the runs."""
    await _project(session, project_id)
    used = await svc_plugins.usage(session, project_id)
    rows = (
        await session.exec(
            select(AiPlugin)
            .where(AiPlugin.project_id == project_id)
            .order_by(AiPlugin.installed_at, AiPlugin.id)
        )
    ).all()
    return [svc_plugins.to_dict(r, used.get(r.name)) for r in rows]


class SourceBody(BaseModel):
    """Where a plugin comes from."""

    source_kind: Literal["git", "marketplace", "folder"] = "git"
    source: str
    ref: Optional[str] = None
    plugin: Optional[str] = None
    skills: Optional[list[str]] = None


@router.post("/projects/{project_id}/ai/plugins/preview")
async def post_preview(project_id: str, body: SourceBody, session: Session) -> dict:
    """What will be installed: skills, hooks, MCP servers, size, commit; a marketplace lists its plugins."""
    await _project(session, project_id)
    try:
        return await svc_plugins.preview(
            body.source_kind,
            body.source,
            ref=body.ref,
            plugin=body.plugin,
            skills=body.skills,
        )
    except svc_plugins.PluginError as exc:
        _fail(exc)


class InstallBody(SourceBody):
    """Install a plugin, and who gets it."""

    roles: list[str] = []
    default_on: bool = False


@router.post("/projects/{project_id}/ai/plugins", status_code=201)
async def post_install(project_id: str, body: InstallBody, session: Session) -> dict:
    """Install (no review step, D1): the source and the commit are recorded."""
    await _project(session, project_id)
    try:
        row = await svc_plugins.install(
            session,
            project_id,
            source_kind=body.source_kind,
            source=body.source,
            ref=body.ref,
            plugin=body.plugin,
            skills=body.skills,
            roles=body.roles,
            default_on=body.default_on,
            by=_by(),
        )
    except svc_plugins.PluginError as exc:
        _fail(exc)
    return svc_plugins.to_dict(row)


class PluginPatch(BaseModel):
    """The project default and the roles that get it."""

    default_on: Optional[bool] = None
    roles: Optional[list[str]] = None


@router.patch("/ai/plugins/{plugin_id}")
async def patch_plugin(plugin_id: str, body: PluginPatch, session: Session) -> dict:
    """Change the project default or the roles; takes effect from the next run."""
    import json

    row = await _plugin(session, plugin_id)
    if body.default_on is not None:
        row.default_on = body.default_on
    if body.roles is not None:
        row.roles = json.dumps(body.roles)
    session.add(row)
    await session.commit()
    return svc_plugins.to_dict(row)


class MemberSwitch(BaseModel):
    """A member's own switch; null follows the project default again."""

    on: Optional[bool] = None


async def put_member_switch(
    plugin_id: str, member_id: str, body: MemberSwitch, session: Session
) -> dict:
    """Switch a plugin on or off for one member."""
    row = await _plugin(session, plugin_id)
    if await session.get(AiTeam, member_id) is None:
        raise HTTPException(status_code=404, detail="AI member not found")
    return svc_plugins.to_dict(
        await svc_plugins.set_member(session, row, member_id, body.on)
    )


@router.get("/ai/plugins/{plugin_id}/update")
async def get_update(plugin_id: str, session: Session) -> dict:
    """Whether a newer version is out (nothing updates on its own)."""
    return await svc_plugins.check_update(await _plugin(session, plugin_id))


@router.get("/ai/plugins/{plugin_id}/changes")
async def get_changes(plugin_id: str, session: Session) -> dict:
    """See what changed: files added, removed and changed by the update."""
    try:
        return await svc_plugins.changes(await _plugin(session, plugin_id))
    except svc_plugins.PluginError as exc:
        _fail(exc)


@router.post("/ai/plugins/{plugin_id}/{action}")
async def post_plugin_action(
    plugin_id: str,
    action: Literal["update", "rollback", "reload", "reset", "pin", "unpin"],
    session: Session,
) -> dict:
    """Update (keeps the previous version), Rollback, Reload (re-read the source), Reset (back to the catalogue
    version), Pin, Unpin. All take effect from the next run."""
    row = await _plugin(session, plugin_id)
    try:
        if action == "update":
            row = await svc_plugins.update(session, row)
        elif action == "rollback":
            row = await svc_plugins.rollback(session, row)
        elif action == "reload":
            row = await svc_plugins.reload(session, row)
        elif action == "reset":
            row = await svc_plugins.reset(session, row)
        else:
            row = await svc_plugins.pin(session, row, action == "pin")
    except svc_plugins.PluginError as exc:
        _fail(exc)
    return svc_plugins.to_dict(row)


@router.delete("/ai/plugins/{plugin_id}", status_code=204)
async def delete_plugin(plugin_id: str, session: Session) -> None:
    """Remove: uninstall it and every cached copy."""
    await svc_plugins.remove(session, await _plugin(session, plugin_id))


class CatalogueInstall(BaseModel):
    """Install a catalogue entry for its roles (or the given members)."""

    member_ids: Optional[list[str]] = None


@router.get("/projects/{project_id}/ai/packs")
async def get_packs(project_id: str, session: Session) -> list[dict]:
    """The ready-made packs and the project's own."""
    await _project(session, project_id)
    return await svc_packs.list_packs(session, project_id)


@router.get("/projects/{project_id}/ai/packs/{key}")
async def get_pack(project_id: str, key: str, session: Session) -> dict:
    """One pack."""
    pack = await svc_packs.get_pack(session, project_id, key)
    if pack is None:
        raise HTTPException(status_code=404, detail="Pack not found")
    return pack


@router.put("/projects/{project_id}/ai/packs/{key}")
async def put_pack(project_id: str, key: str, body: dict, session: Session) -> dict:
    """Create or edit a pack (a new version each time; editing a ready-made one makes the project's copy)."""
    await _project(session, project_id)
    try:
        return await svc_packs.save_pack(session, project_id, key, body, by=_by())
    except ValueError as exc:
        _fail(exc)


@router.delete("/projects/{project_id}/ai/packs/{key}", status_code=204)
async def delete_pack(project_id: str, key: str, session: Session) -> None:
    """Remove the project's own pack (a ready-made one comes back)."""
    if not await svc_packs.delete_pack(session, project_id, key):
        raise HTTPException(
            status_code=404, detail="Only a pack of this project can be removed."
        )


@router.get("/projects/{project_id}/ai/packs/{key}/export")
async def get_pack_export(project_id: str, key: str, session: Session) -> dict:
    """The pack as one file."""
    pack = await svc_packs.get_pack(session, project_id, key)
    if pack is None:
        raise HTTPException(status_code=404, detail="Pack not found")
    return svc_packs.export(pack)


async def post_pack_import(project_id: str, body: dict, session: Session) -> dict:
    """Import a pack file; says what it could not find on this project."""
    await _project(session, project_id)
    try:
        return await svc_packs.import_pack(session, project_id, body, by=_by())
    except ValueError as exc:
        _fail(exc)


class FromPack(BaseModel):
    """Make a member from a pack."""

    name: str
    working_dir: Optional[str] = None
    account_id: Optional[str] = None
    plays: Optional[str] = None


def _install_pack_plugins(project_id: str, pack: dict, by: str) -> None:
    """The pack's plugins on the project, in the background (a clone takes a while); a run waits for them to land."""
    import database

    async def go() -> None:
        async with database.async_session() as session:
            out = await svc_packs.install_plugins(session, project_id, pack, by=by)
        if out["failed"]:
            logger.warning(
                "Pack plugins not installed on %s: %s", project_id, out["failed"]
            )

    # remembered until it ends: a run of the new member waits for it (services/ai/plugins.settled)
    svc_plugins.installing(project_id, go())


@router.get("/projects/{project_id}/ai/own-plugins")
async def get_own_plugins(project_id: str, session: Session) -> dict:
    """The person's own Claude Code plugins, whether a run loads each, and which roles it is narrowed to (Q2).
    Read from their Claude Code folder; nothing there is changed."""
    from services.ai import ops as svc_ops
    from services.ai import own_claude
    from services.ai.store import get_settings

    cfg = svc_ops.get(await get_settings(session, project_id))
    roles = {
        r.get("plugin"): r.get("roles") or []
        for r in cfg.get("own_claude_roles") or []
        if isinstance(r, dict)
    }
    return {
        "on": bool(cfg.get("own_claude", True)),
        "plugins": [{**p, "roles": roles.get(p["name"])} for p in own_claude.plugins()],
    }


# --------------------------------------------------------------------------- the repository scan


class ScanBody(BaseModel):
    """Scan a repository for a new project's team."""

    folder: str
    trial: bool = True
    # D19 step 2: a light model refines the code's suggestion (soft: without a Claude Code account it is skipped)
    refine: bool = True
    # The commands as the person edited them ("Try again" in the wizard): tried instead of the suggestion's
    prepare: str | None = None
    test: str | None = None


@router.post("/projects/{project_id}/ai/scan", status_code=201)
async def post_scan(project_id: str, body: ScanBody, session: Session) -> dict:
    """Scan by code, suggest, and try the commands once in a scratch worktree. Nothing is created."""
    await _project(session, project_id)
    try:
        row = await svc_scan.run_scan(
            session,
            project_id,
            body.folder,
            trial=body.trial,
            refine=body.refine,
            prepare=body.prepare,
            test=body.test,
        )
    except ValueError as exc:
        _fail(exc)
    return await svc_scan.to_api(session, row)


@router.get("/ai/scans/{scan_id}")
async def get_scan(scan_id: str, session: Session) -> dict:
    """A scan (the wizard polls it while the AI or the board tries the commands)."""
    from models import AiRepoScan

    row = await session.get(AiRepoScan, scan_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Scan not found")
    return await svc_scan.to_api(session, row)


@router.get("/projects/{project_id}/ai/scans/latest")
async def get_latest_scan(project_id: str, session: Session) -> dict | None:
    """The newest scan not applied yet (last 24 h), so the wizard picks up a setup that kept running."""
    await _project(session, project_id)
    row = await svc_scan.latest(session, project_id)
    return await svc_scan.to_api(session, row) if row is not None else None


class AiJobBody(BaseModel):
    """Let the AI set up the commands (design/screens/ai-repo-commands.md, C)."""

    hint: str = ""
    # the rows as they are on screen, and those the AI must leave alone (they work, or the person typed them)
    commands: dict[str, str | None] | None = None
    keep: list[str] = []
    env_path: list[str] | None = None


class TryBody(BaseModel):
    """The board runs the commands as the person has them, the way a ticket will."""

    commands: dict[str, str | None]
    env_path: list[str] = []
    only: list[str] | None = (
        None  # which of test, lint, build (prepare runs first when it is set)
    )


async def _scan_job(session, scan_id: str, **kw) -> dict:
    try:
        row = await svc_scan.start_job(session, scan_id, **kw)
    except LookupError as exc:
        _fail(exc, 404)
    except svc_scan.JobRunning as exc:
        _fail(exc, 409)
    except ValueError as exc:
        _fail(exc)
    return await svc_scan.to_api(session, row)


@router.post("/ai/scans/{scan_id}/ai")
async def post_scan_ai(scan_id: str, body: AiJobBody, session: Session) -> dict:
    """Start the AI: it reads the repository and proposes; the board then runs each command itself."""
    return await _scan_job(
        session,
        scan_id,
        mode="ai",
        hint=body.hint,
        commands=body.commands,
        keep=body.keep,
        env_path=body.env_path,
    )


@router.post("/ai/scans/{scan_id}/try")
async def post_scan_try(scan_id: str, body: TryBody, session: Session) -> dict:
    """Run the commands once in a scratch worktree, as a ticket runs them. Returns at once; poll the scan."""
    return await _scan_job(
        session,
        scan_id,
        mode="try",
        commands=body.commands,
        env_path=body.env_path,
        only=body.only,
    )


@router.post("/ai/scans/{scan_id}/cancel")
async def post_scan_cancel(scan_id: str, session: Session) -> dict:
    """Stop the AI or the trial."""
    try:
        row = await svc_scan.cancel_job(session, scan_id)
    except LookupError as exc:
        _fail(exc, 404)
    return await svc_scan.to_api(session, row)


@router.post("/ai/scans/{scan_id}/apply")
async def post_apply(scan_id: str, body: dict, session: Session) -> dict:
    """Create what the person confirmed: the team, the settings and the plugins."""
    from models import AiRepoScan

    row = await session.get(AiRepoScan, scan_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Scan not found")
    try:
        return await svc_scan.apply(session, scan_id, body, by=_by())
    except LookupError as exc:
        _fail(exc, 404)
