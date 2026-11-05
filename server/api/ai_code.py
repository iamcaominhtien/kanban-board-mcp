"""REST API of where the AIs work and how code is handed over (design/screens/ai-operations.md I, J, K): worktrees,
merge, the hand-over route, a merge conflict, and leaving the synced folder (wave 2 B3)."""

import asyncio
import logging
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

import services.activity as svc_activity
from database import get_session
from models import AiWorktree, Ticket
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


@router.post("/tickets/{ticket_id}/ai/worktree/outputs")
async def post_move_outputs(ticket_id: str) -> dict:
    """Move the outputs left in the worktree (untracked screenshots, logs, reports) to the ticket's Workspace."""
    result = await svc_worktrees.move_outputs(ticket_id)
    await svc_worktrees.log_tidy(ticket_id, result, by=_by())
    return result


@router.post("/tickets/{ticket_id}/ai/worktree/commit")
async def post_commit_worktree(ticket_id: str) -> dict:
    """Commit the code left uncommitted in the worktree on its branch (outputs go to the Workspace first)."""
    try:
        return await svc_worktrees.commit_now(ticket_id, by=_by())
    except svc_worktrees.WorktreeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


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


logger = logging.getLogger(__name__)
_OPENERS: set[asyncio.Task] = set()


def _kept_why(exc: Exception) -> str:
    """Why Clean up kept a worktree, in the board's own words."""
    if "not committed" in str(exc):
        return "Some files are not committed: keep it, or commit them first."
    return "git could not remove it; the server log says why."


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
            # a fixed sentence per cause: git's own words go to the log, not to the page
            logger.info("Worktree of %s kept: %s", row.ticket_id, exc)
            kept.append({"ticket_id": row.ticket_id, "why": _kept_why(exc)})
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


@router.post("/tickets/{ticket_id}/ai/worktree/open")
async def post_open_worktree(ticket_id: str, session: Session) -> dict:
    """Open the worktree's folder in the computer's file manager (the board runs on this computer)."""
    import sys

    row = await session.get(AiWorktree, ticket_id)
    if row is None or row.state == "removed":
        raise HTTPException(status_code=404, detail="This ticket has no worktree.")
    opener = {"darwin": ["open"], "win32": ["explorer"]}.get(sys.platform, ["xdg-open"])
    try:
        # started and left to run (the file manager outlives the request); it is reaped in the background
        proc = await asyncio.create_subprocess_exec(
            *opener,
            row.path,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        reaper = asyncio.create_task(proc.wait())
        _OPENERS.add(reaper)
        reaper.add_done_callback(_OPENERS.discard)
    except OSError as exc:
        raise HTTPException(
            status_code=409, detail=f"Could not open the folder: {exc}"
        ) from exc
    return {"opened": row.path}
