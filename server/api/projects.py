from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel.ext.asyncio.session import AsyncSession

import events as board_events
from database import get_session
from models import ProjectCreate, ProjectRead, ProjectUpdate
from services.projects import (
    create_project,
    delete_project,
    get_project,
    list_projects,
    update_project,
)

router = APIRouter(prefix="/projects", tags=["projects"])

Session = Annotated[AsyncSession, Depends(get_session)]


@router.get("", response_model=list[ProjectRead])
async def get_projects(session: Session) -> list[ProjectRead]:
    projects = await list_projects(session)
    return [ProjectRead.model_validate(p) for p in projects]


@router.post("", response_model=ProjectRead, status_code=201)
async def post_project(data: ProjectCreate, session: Session) -> ProjectRead:
    try:
        project = await create_project(session, data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await board_events.publish("invalidate")
    return ProjectRead.model_validate(project)


@router.get("/{project_id}", response_model=ProjectRead)
async def get_one_project(project_id: str, session: Session) -> ProjectRead:
    project = await get_project(session, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return ProjectRead.model_validate(project)


@router.patch("/{project_id}", response_model=ProjectRead)
async def patch_project(
    project_id: str, data: ProjectUpdate, session: Session
) -> ProjectRead:
    project = await update_project(session, project_id, data)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    await board_events.publish("invalidate")
    return ProjectRead.model_validate(project)


@router.delete("/{project_id}", status_code=204)
async def del_project(project_id: str, session: Session) -> None:
    try:
        found = await delete_project(session, project_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not found:
        raise HTTPException(status_code=404, detail="Project not found")
    await board_events.publish("invalidate")
