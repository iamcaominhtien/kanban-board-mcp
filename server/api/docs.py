import json
import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlmodel.ext.asyncio.session import AsyncSession

import events as board_events
from database import get_session
from services import docs as svc
from services import docs_import, docs_search
from services.docs_templates import TEMPLATES

router = APIRouter(tags=["docs"])

Session = Annotated[AsyncSession, Depends(get_session)]


async def docs_error_handler(request: Request, exc: svc.DocsError) -> JSONResponse:
    """Every docs failure answers {detail: {code, message, request_id, ...}} plus an x-request-id header."""
    request_id = (request.headers.get("x-request-id") or "").strip()[
        :64
    ] or uuid.uuid4().hex[:12]
    return JSONResponse(
        status_code=exc.status,
        content={
            "detail": {
                "code": exc.code,
                "message": exc.message,
                "request_id": request_id,
                **exc.extra,
            }
        },
        headers={"x-request-id": request_id},
    )


class PageCreate(BaseModel):
    """Request body to create a page."""

    title: str
    parent_id: str | None = None
    template: str = "blank"
    markdown: str | None = None


class PageRename(BaseModel):
    """Request body to rename a page."""

    title: str
    rewrite_links: bool = False


class PageMove(BaseModel):
    """Request body to move a page."""

    parent_id: str | None = None
    before_id: str | None = None
    after_id: str | None = None


class PageDuplicate(BaseModel):
    """Request body to duplicate a page."""

    title: str | None = None
    parent_id: str | None = None
    include_children: bool = False


class DraftSave(BaseModel):
    """Request body to save a draft."""

    markdown: str
    title: str | None = None
    base_version: int | None = None


class PublishBody(BaseModel):
    """Request body to publish a draft."""

    base_version: int
    note: str | None = None
    markdown: str | None = None
    title: str | None = None
    notify: bool = False


class RestoreBody(BaseModel):
    """Request body to restore a version."""

    note: str | None = None
    notify: bool = False


class ResolveBody(BaseModel):
    """Request body listing references to resolve."""

    refs: list[dict[str, Any]]


class ImportResolveBody(BaseModel):
    """Request body listing the pages created by an import."""

    page_ids: list[str]


class TicketDocBody(BaseModel):
    """Request body to link a ticket to a page."""

    page_id: str


async def _announce(page: dict[str, Any], note: str | None) -> None:
    """Tell watchers a page was published (SSE `data:` is this JSON string)."""
    await board_events.publish(
        json.dumps(
            {
                "type": "docs_published",
                "project_id": page["project_id"],
                "page_id": page["id"],
                "title": page["title"],
                "version": page["version"],
                "author": page["updated_by"],
                "note": (note or "").strip() or None,
            }
        )
    )


@router.get("/docs/templates")
async def get_templates() -> list[dict[str, str]]:
    """List the page templates."""
    return [{"id": k, **v} for k, v in TEMPLATES.items()]


@router.get("/projects/{project_id}/docs/tree")
async def get_tree(project_id: str, session: Session) -> list[dict[str, Any]]:
    """Get the project's page tree."""
    return await svc.list_tree(session, project_id)


@router.post("/projects/{project_id}/docs/pages", status_code=201)
async def post_page(
    project_id: str, body: PageCreate, session: Session
) -> dict[str, Any]:
    """Create a page."""
    page = await svc.create_page(
        session,
        project_id,
        body.title,
        parent_id=body.parent_id,
        template=body.template,
        markdown=body.markdown,
    )
    await board_events.publish("invalidate")
    return page


@router.get("/projects/{project_id}/docs/by-slug/{slug}")
async def get_by_slug(project_id: str, slug: str, session: Session) -> dict[str, Any]:
    """Get a page by slug."""
    return await svc.page_by_slug(session, project_id, slug)


@router.get("/projects/{project_id}/docs/similar")
async def get_similar(
    project_id: str, session: Session, slug: str = ""
) -> list[dict[str, Any]]:
    """Suggest pages whose slug or title resembles `slug`."""
    await svc._project(session, project_id)
    return await docs_search.similar(session, project_id, slug)


@router.get("/projects/{project_id}/docs/search")
async def get_search(
    project_id: str,
    session: Session,
    q: str = "",
    scope: str = "space",
    limit: int = 20,
    offset: int = 0,
    page_id: str | None = None,
    mode: str | None = None,
    author: str | None = None,
    edited_since: str | None = None,
    under_page: str | None = None,
    has_tickets: bool | None = None,
    status: str | None = None,
    sort: str = "relevance",
) -> dict[str, Any]:
    """Search pages and tickets."""
    await svc._project(session, project_id)
    return await docs_search.search(
        session,
        project_id,
        q,
        scope=scope,
        limit=limit,
        offset=offset,
        page_id=page_id,
        mode=mode,
        author=author,
        edited_since=edited_since,
        under_page=under_page,
        has_tickets=has_tickets,
        status=status,
        sort=sort,
    )


@router.get("/projects/{project_id}/docs/recycle-bin")
async def get_recycle_bin(project_id: str, session: Session) -> list[dict[str, Any]]:
    """List pages in the Recycle Bin."""
    return await svc.list_deleted(session, project_id)


@router.delete("/projects/{project_id}/docs/recycle-bin")
async def empty_recycle_bin(project_id: str, session: Session) -> dict[str, int]:
    """Permanently delete everything in the Recycle Bin."""
    result = await svc.empty_recycle_bin(session, project_id)
    await board_events.publish("invalidate")
    return result


@router.post("/projects/{project_id}/docs/resolve")
async def post_resolve(
    project_id: str, body: ResolveBody, session: Session
) -> list[dict[str, Any]]:
    """Resolve `[[references]]` to pages, sections and tickets."""
    return await svc.resolve_refs(session, project_id, body.refs)


@router.post("/projects/{project_id}/docs/import")
async def post_import(
    project_id: str,
    session: Session,
    files: Annotated[list[UploadFile], File()],
    paths: Annotated[list[str] | None, Form()] = None,
    parent_id: Annotated[str | None, Form()] = None,
    on_conflict: Annotated[str, Form()] = "copy",
    dry_run: Annotated[bool, Form()] = False,
    publish: Annotated[bool, Form()] = False,
    notify: Annotated[bool, Form()] = False,
) -> dict[str, Any]:
    """Import Markdown files as draft pages (dry_run only reports the plan)."""
    uploads: list[tuple[str, bytes]] = []
    for i, f in enumerate(files):
        name = paths[i] if paths and i < len(paths) and paths[i] else (f.filename or "")
        # read one byte past the limit so an oversized file is reported, not loaded whole
        uploads.append((name, await f.read(docs_import.MAX_FILE_BYTES + 1)))
    parent = parent_id or None
    if dry_run:
        return await docs_import.dry_run(
            session, project_id, uploads, parent_id=parent, on_conflict=on_conflict
        )
    result = await docs_import.run_import(
        session,
        project_id,
        uploads,
        parent_id=parent,
        on_conflict=on_conflict,
        publish=publish,
    )
    await board_events.publish("invalidate")
    if publish and notify:
        for item in result["created"][:50]:
            await _announce(await svc.page_detail(session, item["page_id"]), "Imported")
    return result


@router.post("/projects/{project_id}/docs/import/resolve")
async def post_import_resolve(
    project_id: str, body: ImportResolveBody, session: Session
) -> dict[str, int]:
    """Re-index links of imported pages and re-point pending links."""
    result = await docs_import.resolve_pages(session, project_id, body.page_ids)
    await board_events.publish("invalidate")
    return result


@router.get("/docs/pages/{page_id}")
async def get_page(page_id: str, session: Session) -> dict[str, Any]:
    """Get a page with its content, draft and stats."""
    return await svc.page_detail(session, page_id)


async def _mutate(coro: Any) -> Any:
    result = await coro
    await board_events.publish("invalidate")
    return result


@router.get("/docs/pages/{page_id}/rename-preview")
async def get_rename_preview(
    page_id: str, session: Session, title: str = ""
) -> dict[str, Any]:
    """Preview the link rewrites a rename would make."""
    return await svc.rename_preview(session, page_id, title)


@router.get("/docs/pages/{page_id}/delete-preview")
async def get_delete_preview(page_id: str, session: Session) -> dict[str, Any]:
    """Preview what deleting a page would affect."""
    return await svc.delete_preview(session, page_id)


@router.patch("/docs/pages/{page_id}")
async def patch_page(
    page_id: str, body: PageRename, session: Session
) -> dict[str, Any]:
    """Rename a page."""
    return await _mutate(
        svc.rename_page(session, page_id, body.title, rewrite_links=body.rewrite_links)
    )


@router.delete("/docs/pages/{page_id}")
async def del_page(page_id: str, session: Session) -> dict[str, Any]:
    """Move a page and its sub-pages to the Recycle Bin."""
    return await _mutate(svc.delete_page(session, page_id))


@router.post("/docs/pages/{page_id}/move")
async def post_move(page_id: str, body: PageMove, session: Session) -> dict[str, Any]:
    """Move a page."""
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
    """Duplicate a page and its sub-pages."""
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
    """Restore a page from the Recycle Bin."""
    return await _mutate(svc.restore_page(session, page_id))


@router.delete("/docs/pages/{page_id}/purge", status_code=204)
async def purge(page_id: str, session: Session) -> None:
    """Permanently delete a page from the Recycle Bin."""
    await _mutate(svc.purge_page(session, page_id))


@router.put("/docs/pages/{page_id}/draft")
async def put_draft(page_id: str, body: DraftSave, session: Session) -> dict[str, Any]:
    """Save your draft of a page."""
    return await svc.save_draft(
        session,
        page_id,
        markdown=body.markdown,
        title=body.title,
        base_version=body.base_version,
    )


@router.delete("/docs/pages/{page_id}/draft")
async def del_draft(page_id: str, session: Session) -> dict[str, Any]:
    """Discard your draft of a page."""
    return await _mutate(svc.discard_draft(session, page_id))


@router.post("/docs/pages/{page_id}/publish")
async def post_publish(
    page_id: str, body: PublishBody, session: Session
) -> dict[str, Any]:
    """Publish the draft as a new version."""
    page = await _mutate(
        svc.publish_page(
            session,
            page_id,
            base_version=body.base_version,
            note=body.note,
            markdown=body.markdown,
            title=body.title,
        )
    )
    if body.notify:
        await _announce(page, body.note)
    return page


@router.get("/docs/pages/{page_id}/versions")
async def get_versions(page_id: str, session: Session) -> list[dict[str, Any]]:
    """List a page's versions."""
    return await svc.list_versions(session, page_id)


@router.get("/docs/pages/{page_id}/versions/{version}")
async def get_version(page_id: str, version: int, session: Session) -> dict[str, Any]:
    """Get one version of a page."""
    return await svc.get_version(session, page_id, version)


@router.get("/docs/pages/{page_id}/versions/{a}/diff/{b}")
async def get_diff(page_id: str, a: int, b: int, session: Session) -> dict[str, Any]:
    """Diff two versions of a page."""
    return await svc.diff_versions(session, page_id, a, b)


@router.post("/docs/pages/{page_id}/versions/{version}/restore")
async def post_restore_version(
    page_id: str, version: int, body: RestoreBody, session: Session
) -> dict[str, Any]:
    """Restore an old version as a new one."""
    page = await _mutate(svc.restore_version(session, page_id, version, note=body.note))
    if body.notify:
        await _announce(page, body.note or f"Restored from v{version}")
    return page


@router.get("/docs/pages/{page_id}/backlinks")
async def get_backlinks(page_id: str, session: Session) -> dict[str, Any]:
    """List the pages and tickets that reference a page."""
    return await svc.backlinks(session, page_id)


@router.get("/tickets/{ticket_id}/docs")
async def get_ticket_docs(ticket_id: str, session: Session) -> list[dict[str, Any]]:
    """List the pages a ticket references or is linked to."""
    return await svc.docs_for_ticket(session, ticket_id)


@router.post("/tickets/{ticket_id}/docs", status_code=201)
async def post_ticket_doc(
    ticket_id: str, body: TicketDocBody, session: Session
) -> dict[str, Any]:
    """Link a ticket to a page."""
    result = await svc.link_ticket_doc(session, ticket_id, body.page_id)
    await board_events.publish("invalidate")
    return result


@router.delete("/tickets/{ticket_id}/docs/{page_id}")
async def delete_ticket_doc(
    ticket_id: str, page_id: str, session: Session
) -> dict[str, Any]:
    """Unlink a ticket from a page."""
    result = await svc.unlink_ticket_doc(session, ticket_id, page_id)
    await board_events.publish("invalidate")
    return result
