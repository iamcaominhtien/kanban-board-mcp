from typing import Annotated, Any, NoReturn

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

import events as board_events
from database import get_session
from services import docs as svc
from services.docs_templates import TEMPLATES

router = APIRouter(tags=["docs"])

Session = Annotated[AsyncSession, Depends(get_session)]


def _raise(exc: svc.DocsError) -> NoReturn:
    raise HTTPException(
        status_code=exc.status,
        detail={"code": exc.code, "message": exc.message, **exc.extra},
    ) from exc


class PageCreate(BaseModel):
    title: str
    parent_id: str | None = None
    template: str = "blank"
    markdown: str | None = None


class PageRename(BaseModel):
    title: str


class PageMove(BaseModel):
    parent_id: str | None = None
    before_id: str | None = None
    after_id: str | None = None


class PageDuplicate(BaseModel):
    title: str | None = None
    parent_id: str | None = None
    include_children: bool = False


class DraftSave(BaseModel):
    markdown: str
    title: str | None = None
    base_version: int | None = None


class PublishBody(BaseModel):
    base_version: int
    note: str | None = None
    markdown: str | None = None
    title: str | None = None


class RestoreBody(BaseModel):
    note: str | None = None


class ResolveBody(BaseModel):
    refs: list[dict[str, Any]]


@router.get("/docs/templates")
async def get_templates() -> list[dict[str, str]]:
    return [{"id": k, **v} for k, v in TEMPLATES.items()]


@router.get("/projects/{project_id}/docs/tree")
async def get_tree(project_id: str, session: Session) -> list[dict[str, Any]]:
    try:
        return await svc.list_tree(session, project_id)
    except svc.DocsError as exc:
        _raise(exc)


@router.post("/projects/{project_id}/docs/pages", status_code=201)
async def post_page(
    project_id: str, body: PageCreate, session: Session
) -> dict[str, Any]:
    try:
        page = await svc.create_page(
            session,
            project_id,
            body.title,
            parent_id=body.parent_id,
            template=body.template,
            markdown=body.markdown,
        )
    except svc.DocsError as exc:
        _raise(exc)
    await board_events.publish("invalidate")
    return page


@router.get("/projects/{project_id}/docs/by-slug/{slug}")
async def get_by_slug(project_id: str, slug: str, session: Session) -> dict[str, Any]:
    try:
        return await svc.page_by_slug(session, project_id, slug)
    except svc.DocsError as exc:
        _raise(exc)


@router.get("/projects/{project_id}/docs/recycle-bin")
async def get_recycle_bin(project_id: str, session: Session) -> list[dict[str, Any]]:
    return await svc.list_deleted(session, project_id)


@router.post("/projects/{project_id}/docs/resolve")
async def post_resolve(
    project_id: str, body: ResolveBody, session: Session
) -> list[dict[str, Any]]:
    try:
        return await svc.resolve_refs(session, project_id, body.refs)
    except svc.DocsError as exc:
        _raise(exc)


@router.get("/docs/pages/{page_id}")
async def get_page(page_id: str, session: Session) -> dict[str, Any]:
    try:
        return await svc.page_detail(session, page_id)
    except svc.DocsError as exc:
        _raise(exc)


async def _mutate(coro: Any) -> Any:
    try:
        result = await coro
    except svc.DocsError as exc:
        _raise(exc)
    await board_events.publish("invalidate")
    return result


@router.patch("/docs/pages/{page_id}")
async def patch_page(
    page_id: str, body: PageRename, session: Session
) -> dict[str, Any]:
    return await _mutate(svc.rename_page(session, page_id, body.title))


@router.delete("/docs/pages/{page_id}")
async def del_page(page_id: str, session: Session) -> dict[str, Any]:
    return await _mutate(svc.delete_page(session, page_id))


@router.post("/docs/pages/{page_id}/move")
async def post_move(page_id: str, body: PageMove, session: Session) -> dict[str, Any]:
    return await _mutate(
        svc.move_page(
            session,
            page_id,
            parent_id=body.parent_id,
            before_id=body.before_id,
            after_id=body.after_id,
        )
    )


@router.post("/docs/pages/{page_id}/duplicate", status_code=201)
async def post_duplicate(
    page_id: str, body: PageDuplicate, session: Session
) -> dict[str, Any]:
    return await _mutate(
        svc.duplicate_page(
            session,
            page_id,
            title=body.title,
            parent_id=body.parent_id,
            parent_given="parent_id" in body.model_fields_set,
            include_children=body.include_children,
        )
    )


@router.post("/docs/pages/{page_id}/restore")
async def post_restore(page_id: str, session: Session) -> dict[str, Any]:
    return await _mutate(svc.restore_page(session, page_id))


@router.delete("/docs/pages/{page_id}/purge", status_code=204)
async def purge(page_id: str, session: Session) -> None:
    await _mutate(svc.purge_page(session, page_id))


@router.put("/docs/pages/{page_id}/draft")
async def put_draft(page_id: str, body: DraftSave, session: Session) -> dict[str, Any]:
    try:
        return await svc.save_draft(
            session,
            page_id,
            markdown=body.markdown,
            title=body.title,
            base_version=body.base_version,
        )
    except svc.DocsError as exc:
        _raise(exc)


@router.delete("/docs/pages/{page_id}/draft")
async def del_draft(page_id: str, session: Session) -> dict[str, Any]:
    return await _mutate(svc.discard_draft(session, page_id))


@router.post("/docs/pages/{page_id}/publish")
async def post_publish(
    page_id: str, body: PublishBody, session: Session
) -> dict[str, Any]:
    return await _mutate(
        svc.publish_page(
            session,
            page_id,
            base_version=body.base_version,
            note=body.note,
            markdown=body.markdown,
            title=body.title,
        )
    )


@router.get("/docs/pages/{page_id}/versions")
async def get_versions(page_id: str, session: Session) -> list[dict[str, Any]]:
    try:
        return await svc.list_versions(session, page_id)
    except svc.DocsError as exc:
        _raise(exc)


@router.get("/docs/pages/{page_id}/versions/{version}")
async def get_version(page_id: str, version: int, session: Session) -> dict[str, Any]:
    try:
        return await svc.get_version(session, page_id, version)
    except svc.DocsError as exc:
        _raise(exc)


@router.get("/docs/pages/{page_id}/versions/{a}/diff/{b}")
async def get_diff(page_id: str, a: int, b: int, session: Session) -> dict[str, Any]:
    try:
        return await svc.diff_versions(session, page_id, a, b)
    except svc.DocsError as exc:
        _raise(exc)


@router.post("/docs/pages/{page_id}/versions/{version}/restore")
async def post_restore_version(
    page_id: str, version: int, body: RestoreBody, session: Session
) -> dict[str, Any]:
    return await _mutate(svc.restore_version(session, page_id, version, note=body.note))


@router.get("/docs/pages/{page_id}/backlinks")
async def get_backlinks(page_id: str, session: Session) -> dict[str, Any]:
    try:
        return await svc.backlinks(session, page_id)
    except svc.DocsError as exc:
        _raise(exc)


@router.get("/tickets/{ticket_id}/docs")
async def get_ticket_docs(ticket_id: str, session: Session) -> list[dict[str, Any]]:
    return await svc.docs_for_ticket(session, ticket_id)
