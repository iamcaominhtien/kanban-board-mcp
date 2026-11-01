"""REST API of where the AIs work and how code is handed over (design/screens/ai-operations.md I, J, K): worktrees,
merge, the hand-over route, a merge conflict, and leaving the synced folder (wave 2 B3)."""

from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

import services.activity as svc_activity
from database import get_session
from models import AiMember, AiRun, AiWorktree, Ticket
from services.ai import flags as svc_flags
from services.ai import run_config as svc_run_config
from services.ai import runs as svc_runs
from services.ai import worktrees as svc_worktrees

router = APIRouter(tags=["ai"])
Session = Annotated[AsyncSession, Depends(get_session)]


def _by() -> str:
    return svc_activity.current_actor() or "user"


@router.get("/projects/{project_id}/ai/worktrees")
async def get_worktrees(project_id: str, session: Session) -> dict:
    """Every worktree of the project with what git says now (uncommitted files, size, ahead of its base)."""
    rows = await svc_worktrees.list_for_project(session, project_id)
    return {
        "worktrees": rows,
        "total_mb": round(
            sum((r.get("live") or {}).get("size_mb") or 0 for r in rows), 1
        ),
    }


@router.get("/tickets/{ticket_id}/ai/worktree")
async def get_ticket_worktree(ticket_id: str, session: Session) -> dict | None:
    """The ticket's worktree, or null."""
    row = await session.get(AiWorktree, ticket_id)
    if row is None or row.state == "removed":
        return None
    return svc_worktrees.to_dict(row, await svc_worktrees.status(row))


class RemoveBody(BaseModel):
    """Remove a worktree (never with uncommitted work)."""

    force: bool = False


@router.post("/tickets/{ticket_id}/ai/worktree/remove")
async def post_remove_worktree(
    ticket_id: str, body: RemoveBody, session: Session
) -> dict:
    """Remove the ticket's worktree and give its port back."""
    try:
        row = await svc_worktrees.remove(session, ticket_id, force=body.force)
    except svc_worktrees.WorktreeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return svc_worktrees.to_dict(row)


@router.post("/tickets/{ticket_id}/ai/worktree/keep")
async def post_keep_worktree(ticket_id: str, session: Session) -> dict:
    """Keep a finished worktree (Clean up finished skips it)."""
    row = await session.get(AiWorktree, ticket_id)
    if row is None:
        raise HTTPException(status_code=404, detail="This ticket has no worktree.")
    row.state = "kept"
    session.add(row)
    await session.commit()
    return svc_worktrees.to_dict(row)


@router.post("/projects/{project_id}/ai/worktrees/cleanup")
async def post_cleanup(project_id: str, session: Session) -> dict:
    """Clean up finished: remove the worktrees of merged or done tickets that hold nothing uncommitted."""
    rows = (
        await session.exec(
            select(AiWorktree).where(
                AiWorktree.project_id == project_id,
                AiWorktree.state.in_(["active", "merged"]),
            )  # type: ignore[attr-defined]
        )
    ).all()
    removed, kept = [], []
    for row in rows:
        ticket = await session.get(Ticket, row.ticket_id)
        finished = row.state == "merged" or (
            ticket is not None and ticket.status in ("done", "wont_do")
        )
        if not finished:
            continue
        try:
            await svc_worktrees.remove(session, row.ticket_id)
            removed.append(row.ticket_id)
        except svc_worktrees.WorktreeError as exc:
            kept.append({"ticket_id": row.ticket_id, "why": str(exc)})
    return {"removed": removed, "kept": kept}


@router.post("/tickets/{ticket_id}/ai/merge")
async def post_merge(ticket_id: str) -> dict:
    """Merge the ticket's branch (a person's action; refused while the main checkout is dirty; a conflict is rolled
    back and becomes a Needs you row)."""
    return await svc_worktrees.merge(ticket_id, by=_by())


class HandoverBody(BaseModel):
    """This ticket's hand-over route, instead of the project's."""

    route: Literal["auto", "pr", "local", "branch"]


@router.patch("/tickets/{ticket_id}/ai/handover")
async def patch_handover(ticket_id: str, body: HandoverBody, session: Session) -> dict:
    """Merge here instead (or open a PR, or leave the branch) for this one ticket."""
    row = await session.get(AiWorktree, ticket_id)
    if row is None:
        raise HTTPException(status_code=404, detail="This ticket has no worktree.")
    row.handover = None if body.route == "auto" else body.route
    session.add(row)
    await session.commit()
    return {
        **svc_worktrees.to_dict(row),
        "route": await svc_worktrees.route_for(session, row),
    }


class ConflictBody(BaseModel):
    """Who resolves a merge conflict."""

    choice: Literal["ai", "me", "later"]
    member_id: Optional[str] = None


CONFLICT_TASK = (
    "Resolve the merge conflict of this ticket. In your worktree, merge `{base}` into your branch `{branch}`, resolve "
    "the conflicts in: {files}. Keep both sides' intent; run the tests; commit the merge. Do not touch the main "
    "checkout. When it is done, say which files you resolved and how."
)


@router.post("/tickets/{ticket_id}/ai/conflict")
async def post_conflict(ticket_id: str, body: ConflictBody, session: Session) -> dict:
    """ "Hand it to an AI" starts a run whose only job is the conflict; "I will do it" closes the row and leaves the
    worktree exactly as it is; "later" leaves it for now."""
    row = await session.get(AiWorktree, ticket_id)
    if row is None:
        raise HTTPException(status_code=404, detail="This ticket has no worktree.")
    flag = await svc_flags.current(session, ticket_id, "merge_conflict")
    if flag is None:
        raise HTTPException(
            status_code=409, detail="There is no open merge conflict on this ticket."
        )
    if body.choice == "later":
        return {"ok": True}
    if body.choice == "me":
        await svc_flags.resolve(
            session,
            ticket_id,
            "merge_conflict",
            by=_by(),
            how=f"{_by()} resolves it by hand",
        )
        return {"ok": True}
    member_id = body.member_id
    if not member_id:
        last = (
            await session.exec(
                select(AiRun)
                .where(AiRun.ticket_id == ticket_id, AiRun.mode == "work")
                .order_by(AiRun.queued_at.desc())  # type: ignore[attr-defined]
                .limit(1)
            )
        ).first()
        member_id = last.member_id if last else None
    if not member_id or await session.get(AiMember, member_id) is None:
        raise HTTPException(status_code=422, detail="Pick the AI that resolves it.")
    import json

    files = (
        ", ".join(json.loads(row.conflict_files or "[]")[:20])
        or "the files git reports"
    )
    try:
        run = await svc_runs.create_run(
            session,
            ticket_id=ticket_id,
            member_id=member_id,
            mode="work",
            trigger="conflict",
            started_by=_by(),
            instruction=CONFLICT_TASK.format(
                base=row.base, branch=row.branch, files=files
            ),
        )
    except svc_runs.RunConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except svc_runs.RunError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await svc_flags.resolve(
        session,
        ticket_id,
        "merge_conflict",
        by=_by(),
        how=f"handed to an AI (run {run.id})",
    )
    row.state = "active"
    session.add(row)
    await session.commit()
    return {"ok": True, "run_id": run.id}


@router.get("/ai/members/{member_id}/config-migration")
async def get_config_migration(member_id: str, session: Session) -> dict:
    """What the board once wrote into the member's folder, to remove now that runs load it per run (B3)."""
    profile = await session.get(AiMember, member_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="AI member not found")
    return await svc_run_config.migration(session, profile)


@router.post("/ai/members/{member_id}/config-migration")
async def post_config_migration(member_id: str, session: Session) -> dict:
    """Remove what the board wrote and nobody changed (never a person's own files); the CLAUDE.md block is cut out.
    The next run of the member starts a fresh conversation."""
    profile = await session.get(AiMember, member_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="AI member not found")
    return {"removed": await svc_run_config.remove_written(session, profile)}


@router.post("/tickets/{ticket_id}/ai/worktree/open")
async def post_open_worktree(ticket_id: str, session: Session) -> dict:
    """Open the worktree's folder in the computer's file manager (the board runs on this computer)."""
    import subprocess
    import sys

    row = await session.get(AiWorktree, ticket_id)
    if row is None or row.state == "removed":
        raise HTTPException(status_code=404, detail="This ticket has no worktree.")
    opener = {"darwin": ["open"], "win32": ["explorer"]}.get(sys.platform, ["xdg-open"])
    try:
        subprocess.Popen(
            [*opener, row.path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
    except OSError as exc:
        raise HTTPException(
            status_code=409, detail=f"Could not open the folder: {exc}"
        ) from exc
    return {"opened": row.path}


@router.get("/ai/members/{member_id}/base-prompt")
async def get_base_prompt(member_id: str, session: Session) -> dict:
    """What a member carries into every run before the ticket: the board's rules, the project's instructions and
    lessons, its own instructions and persona, and the skills its plugins list (design wave 2, B: "base prompt N
    tokens")."""
    from services.ai import config_sync as cs
    from services.ai import knowledge as svc_knowledge
    from services.ai import plugins as svc_plugins
    from services.ai.config_model import estimate_tokens
    from services.ai.providers import merged_config
    from services.ai.store import loads

    profile = await session.get(AiMember, member_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="AI member not found")
    cfg = merged_config(loads(profile.config, {}))
    project = await svc_knowledge.prompt_block(session, profile.project_id)
    own = cs.claude_md_text(cfg) or ""
    skills = []
    for row in (
        await session.exec(
            select(svc_plugins.AiPlugin).where(
                svc_plugins.AiPlugin.project_id == profile.project_id
            )
        )
    ).all():
        if svc_plugins.on_for(row, profile):
            skills += loads(row.skills, [])
    parts = {
        "board_rules": 1400,  # the board's rules block, about this size for every member (services/ai/context.py)
        "project_knowledge": estimate_tokens(project),
        "own_instructions": estimate_tokens(own),
        "persona": estimate_tokens(profile.persona or ""),
        "skills": 40
        * len(
            skills
        ),  # each skill's name and description sit in the prompt; the body loads on use
    }
    return {
        "member_id": member_id,
        "tokens": sum(parts.values()),
        "parts": parts,
        "skills": skills,
    }
