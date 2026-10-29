from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Form, Request, Response, UploadFile
from sqlmodel.ext.asyncio.session import AsyncSession

import events as board_events
from database import get_session
from services import sketches as svc

router = APIRouter(tags=["sketches"])

Session = Annotated[AsyncSession, Depends(get_session)]

# The picture is shown through <img>; the source is data. Both must be re-checked on every use, so a
# conflict is noticed at once, and neither may be sniffed into something else.
_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=0, must-revalidate",
    "Access-Control-Expose-Headers": "ETag, Content-Disposition",
}


async def _read(file: UploadFile | None) -> bytes | None:
    """Read an uploaded part, stopping one byte past the limit so a huge file is refused cheaply."""
    if file is None:
        return None
    try:
        return await file.read(svc.MAX_BYTES + 1)
    finally:
        await file.close()


async def _need(file: UploadFile | None, what: str) -> bytes:
    data = await _read(file)
    if data is None:
        raise svc.DocsError(422, "invalid_sketch", f"The {what} is missing.")
    return data


@router.get("/sketches")
async def get_sketches(
    owner_kind: str, owner_id: str, session: Session
) -> list[dict[str, Any]]:
    """List the sketches of one page, ticket or idea."""
    return await svc.list_sketches(session, owner_kind, owner_id)


@router.post("/sketches", status_code=201)
async def post_sketch(
    session: Session,
    owner_kind: Annotated[str, Form()],
    owner_id: Annotated[str, Form()],
    png: Annotated[UploadFile, File()],
    source: Annotated[UploadFile, File()],
    title: Annotated[str | None, Form()] = None,
    project_id: Annotated[str | None, Form()] = None,
) -> dict[str, Any]:
    """Save a new sketch: the PNG and the editable source (4096 px and 10 MB per file, 10 layers)."""
    out = await svc.create_sketch(
        session,
        owner_kind=owner_kind,
        owner_id=owner_id,
        title=title,
        png=await _need(png, "picture"),
        source=await _need(source, "editable source"),
        project_id=project_id,
    )
    await board_events.publish("invalidate")
    return out


@router.get("/sketches/{sketch_id}")
async def get_sketch(sketch_id: str, session: Session) -> dict[str, Any]:
    """Read a sketch's details (who owns it, size, version, whether the caller may edit)."""
    return await svc.get_sketch(session, sketch_id)


@router.put("/sketches/{sketch_id}")
async def put_sketch(
    sketch_id: str,
    session: Session,
    base_version: Annotated[int, Form()],
    png: Annotated[UploadFile, File()],
    source: Annotated[UploadFile, File()],
    title: Annotated[str | None, Form()] = None,
    force: Annotated[bool, Form()] = False,
) -> dict[str, Any]:
    """Save a new version; 409 `sketch_conflict` if someone saved a newer one (unless `force`)."""
    out = await svc.update_sketch(
        session,
        sketch_id,
        base_version=base_version,
        png=await _need(png, "picture"),
        source=await _need(source, "editable source"),
        title=title,
        force=force,
    )
    await board_events.publish("invalidate")
    return out


@router.post("/sketches/{sketch_id}/copy", status_code=201)
async def post_sketch_copy(
    sketch_id: str,
    session: Session,
    png: Annotated[UploadFile | None, File()] = None,
    source: Annotated[UploadFile | None, File()] = None,
    title: Annotated[str | None, Form()] = None,
) -> dict[str, Any]:
    """Save a copy as a second sketch; without files it copies the saved one."""
    out = await svc.copy_sketch(
        session,
        sketch_id,
        png=await _read(png),
        source=await _read(source),
        title=title,
    )
    await board_events.publish("invalidate")
    return out


@router.delete("/sketches/{sketch_id}")
async def del_sketch(sketch_id: str, session: Session) -> dict[str, Any]:
    """Unlink a sketch. The row and the files are kept and it can be restored."""
    out = await svc.delete_sketch(session, sketch_id)
    await board_events.publish("invalidate")
    return out


@router.post("/sketches/{sketch_id}/restore")
async def post_restore_sketch(sketch_id: str, session: Session) -> dict[str, Any]:
    """Bring an unlinked sketch back."""
    out = await svc.restore_sketch(session, sketch_id)
    await board_events.publish("invalidate")
    return out


async def _file(
    request: Request, session: AsyncSession, sketch_id: str, kind: str, download: bool
) -> Response:
    content, media, name, s = await svc.read_file(session, sketch_id, kind=kind)
    headers = dict(_HEADERS)
    headers["ETag"] = f'"{s.id}-v{s.version}-{kind}"'
    if request.headers.get("if-none-match") == headers["ETag"]:
        return Response(status_code=304, headers=headers)
    if download:
        headers["Content-Disposition"] = f'attachment; filename="{name}"'
    return Response(content, media_type=media, headers=headers)


@router.get("/sketches/{sketch_id}/png")
async def get_sketch_png(
    sketch_id: str, request: Request, session: Session, download: bool = False
) -> Response:
    """The PNG shown on the page (always the latest version)."""
    return await _file(request, session, sketch_id, "png", download)


@router.get("/sketches/{sketch_id}/source")
async def get_sketch_source(
    sketch_id: str, request: Request, session: Session, download: bool = False
) -> Response:
    """The editable source (JSON with layers) the editor opens."""
    return await _file(request, session, sketch_id, "source", download)
