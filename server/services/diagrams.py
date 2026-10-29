"""Diagrams: draw.io drawings kept as an editable ``.drawio`` source plus an SVG preview.

A diagram is referenced from any markdown field as ``[Auth flow](diagram:dg_8f2a)``. Saving a new
version needs the version you started from (``base_version``), so two people cannot silently
overwrite each other. Deleting only *unlinks*: the row and its versions stay (Recycle Bin).
Docs pages pin the diagram versions they were published with, so restoring a page restores them.
"""

import base64
import json
import re
import urllib.parse
import xml.etree.ElementTree as ET
import zlib
from datetime import UTC, datetime
from typing import Any

from defusedxml import ElementTree as SafeET
from defusedxml import DefusedXmlException
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import Diagram, DiagramSettings, DiagramVersion, Project
from services import activity, diagram_model
from services.docs_text import DocsError

MAX_BYTES = 2 * 1024 * 1024  # per diagram: the .drawio source and the SVG preview each
MAX_LABEL = 200
MAX_SUMMARY = 1000
ITEM_KINDS = ("ticket", "comment", "doc")
SELF_HOSTED_DEFAULT = "http://localhost:8080"
PUBLIC_URL = "https://embed.diagrams.net"

DIAGRAM_REF = re.compile(r"\(diagram:(dg_[0-9a-f]{8})\)")
_SVG_NS = "http://www.w3.org/2000/svg"
_XLINK_NS = "http://www.w3.org/1999/xlink"
_XHTML_NS = "http://www.w3.org/1999/xhtml"


def _now() -> str:
    return datetime.now(UTC).isoformat()


def refs_in(markdown: str) -> list[str]:
    """Return the diagram ids a markdown text references, in order, without repeats."""
    seen: dict[str, None] = {}
    for m in DIAGRAM_REF.finditer(markdown or ""):
        seen.setdefault(m.group(1), None)
    return list(seen)


# --- validation ------------------------------------------------------------------


def _check_size(label: str, text: str) -> None:
    size = len(text.encode("utf-8"))
    if size > MAX_BYTES:
        mb = size / (1024 * 1024)
        raise DocsError(
            413,
            "diagram_too_large",
            f"This diagram is {mb:.1f} MB. The limit is {MAX_BYTES // (1024 * 1024)} MB. "
            "Remove embedded images or split it into pages, then save again.",
            size_bytes=size,
            limit_bytes=MAX_BYTES,
            part=label,
        )


def _forbid_dtd(text: str, what: str) -> None:
    """Reject DTDs and entities: they are never part of a drawing and enable entity bombs."""
    head = text.lstrip()[:4096].upper()
    if "<!DOCTYPE" in head or "<!ENTITY" in text.upper():
        raise DocsError(
            422,
            "invalid_diagram",
            f"The {what} contains a DTD or entity declaration, which is not allowed.",
        )


def _parse(text: str, what: str) -> ET.Element:
    _forbid_dtd(text, what)
    try:
        return SafeET.fromstring(text, forbid_dtd=True)
    except (ET.ParseError, DefusedXmlException) as e:
        raise DocsError(
            422, "invalid_diagram", f"The {what} is not valid XML ({e})."
        ) from e


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def validate_source(source: str) -> ET.Element:
    """Check a ``.drawio`` source is well-formed draw.io XML and within the size limit.

    Args:
        source: ``<mxfile>`` or ``<mxGraphModel>`` XML.

    Returns:
        The parsed root element.

    Raises:
        DocsError: 413 if too large; 422 if it is not draw.io XML.
    """
    _check_size("source", source)
    root = _parse(source, "diagram file")
    if _local(root.tag) not in ("mxfile", "mxGraphModel"):
        raise DocsError(
            422,
            "invalid_diagram",
            "This is not a draw.io file (expected an <mxfile> or <mxGraphModel>).",
        )
    return root


def _graph_models(root: ET.Element) -> list[ET.Element]:
    """The ``<mxGraphModel>`` of each page; compressed pages are inflated."""
    if _local(root.tag) == "mxGraphModel":
        return [root]
    models: list[ET.Element] = []
    for page in root.iter():
        if _local(page.tag) != "diagram":
            continue
        inner = next((c for c in page if _local(c.tag) == "mxGraphModel"), None)
        if inner is not None:
            models.append(inner)
            continue
        data = (page.text or "").strip()
        if not data:
            continue
        try:
            raw = zlib.decompress(base64.b64decode(data), -15)
            parsed = SafeET.fromstring(
                urllib.parse.unquote(raw.decode("utf-8")), forbid_dtd=True
            )
        except (ValueError, zlib.error, ET.ParseError):
            continue
        models.append(parsed)
    return models


def _cells(root: ET.Element) -> list[ET.Element]:
    return [
        c
        for m in _graph_models(root)
        for c in m.iter()
        if _local(c.tag) in ("mxCell", "UserObject", "object")
    ]


def is_empty(root: ET.Element) -> bool:
    """True when the drawing has no shape or connector (only the two root cells)."""
    for c in _cells(root):
        if c.get("vertex") == "1" or c.get("edge") == "1":
            return False
    return not any(_local(c.tag) in ("UserObject", "object") for c in _cells(root))


def _plain(label: str) -> str:
    text = re.sub(r"<[^>]{0,200}>", " ", label or "")
    text = text.replace("&nbsp;", " ").replace("&amp;", "&")
    return re.sub(r"\s+", " ", text).strip()


def text_summary(root: ET.Element, limit: int = 12) -> str:
    """Draft a short text summary from the labels in the drawing (shape and connector text)."""
    labels: list[str] = []
    for c in _cells(root):
        if _local(c.tag) in ("UserObject", "object"):
            text = _plain(c.get("label", ""))
        else:
            text = _plain(c.get("value", ""))
        if text and text not in labels:
            labels.append(text)
    if not labels:
        return ""
    shown = ", ".join(labels[:limit])
    more = f" and {len(labels) - limit} more" if len(labels) > limit else ""
    return f"Contains: {shown}{more}."


def sanitize_svg(svg: str) -> str:
    """Return the SVG preview without scripts, event handlers or ``javascript:`` links.

    Args:
        svg: SVG exported by the editor.

    Returns:
        A cleaned SVG document.

    Raises:
        DocsError: 413 if too large; 422 if it is not an SVG.
    """
    _check_size("preview", svg)
    root = _parse(svg, "preview image")
    if _local(root.tag) != "svg":
        raise DocsError(422, "invalid_diagram", "The preview must be an SVG image.")
    ET.register_namespace("", _SVG_NS)
    ET.register_namespace("xlink", _XLINK_NS)
    for el in root.iter():
        for name in list(el.attrib):
            value = el.attrib[name]
            if _local(name).lower().startswith("on"):
                del el.attrib[name]
            elif _local(name) == "href" and re.match(
                r"\s*(javascript|data:text/html)", value, re.I
            ):
                del el.attrib[name]
    for parent in root.iter():
        for child in list(parent):
            if _local(child.tag) in ("script", "iframe", "object", "embed"):
                parent.remove(child)
    out = ET.tostring(root, encoding="unicode")
    _check_size("preview", out)
    return out


# --- permissions and lookups --------------------------------------------------------


async def role_of(session: AsyncSession, project_id: str) -> str:
    """The caller's role in a project: viewer, member or admin."""
    from services.docs_comments import _members, role_in

    return role_in(await _members(session, project_id), activity.current_actor())


def _need_member(role: str) -> None:
    if role == "viewer":
        raise DocsError(
            403,
            "read_only",
            "Viewers can look at and download diagrams but cannot edit them.",
        )


async def _diagram(
    session: AsyncSession, diagram_id: str, *, deleted_ok: bool = False
) -> Diagram:
    d = await session.get(Diagram, diagram_id)
    if d is None or (d.deleted_at and not deleted_ok):
        raise DocsError(
            404,
            "diagram_not_found",
            "Diagram not found. It was deleted, or you do not have access.",
        )
    return d


async def _version(
    session: AsyncSession, diagram_id: str, n: int | None, current: int
) -> DiagramVersion:
    want = current if n is None else n
    rows = await session.exec(
        select(DiagramVersion).where(
            DiagramVersion.diagram_id == diagram_id, DiagramVersion.version == want
        )
    )
    v = rows.first()
    if v is None:
        raise DocsError(404, "version_not_found", f"Diagram version {want} not found")
    return v


def _label(label: str | None) -> str:
    text = re.sub(r"[\[\]\n\r]+", " ", (label or "")).strip()[:MAX_LABEL]
    return text or "Diagram"


async def _out(
    session: AsyncSession, d: Diagram, v: DiagramVersion | None = None
) -> dict[str, Any]:
    """The diagram as the API returns it (no source or SVG body)."""
    role = await role_of(session, d.project_id)
    ver = v or await _version(session, d.id, None, d.version)
    try:
        empty = (
            is_empty(SafeET.fromstring(ver.source, forbid_dtd=True))
            if ver.source
            else True
        )
    except (ET.ParseError, DefusedXmlException):
        empty = False
    return {
        "id": d.id,
        "project_id": d.project_id,
        "label": d.label,
        "summary": d.summary,
        "item_kind": d.item_kind,
        "item_id": d.item_id,
        "version": d.version,
        "shown_version": ver.version,
        "empty": empty,
        "created_by": d.created_by,
        "created_at": d.created_at,
        "updated_by": d.updated_by,
        "updated_at": d.updated_at,
        "deleted_at": d.deleted_at,
        "size_bytes": len(ver.source.encode("utf-8")),
        "role": role,
        "can_edit": role != "viewer" and not d.deleted_at,
    }


# --- create, read, update, delete ---------------------------------------------------


async def create_diagram(
    session: AsyncSession,
    project_id: str,
    *,
    label: str | None,
    source: str,
    svg: str,
    summary: str | None = None,
    item_kind: str | None = None,
    item_id: str | None = None,
) -> dict[str, Any]:
    """Save a new diagram (version 1).

    Args:
        project_id: Project the diagram belongs to.
        label: Name; becomes the alt text.
        source: The ``.drawio`` XML.
        svg: The SVG preview made by the editor on save.
        summary: Optional short text summary.
        item_kind: ``ticket``, ``comment`` or ``doc`` when it belongs to an item.
        item_id: Id of that item.

    Returns:
        The saved diagram.

    Raises:
        DocsError: 403 for viewers; 404 for an unknown project; 413 / 422 for a bad file.
    """
    if await session.get(Project, project_id) is None:
        raise DocsError(404, "project_not_found", "Project not found")
    _need_member(await role_of(session, project_id))
    validate_source(source)
    clean_svg = sanitize_svg(svg)
    if item_kind is not None and item_kind not in ITEM_KINDS:
        raise DocsError(422, "invalid_item", f"item_kind must be one of {ITEM_KINDS}")
    actor = activity.current_actor()
    d = Diagram(
        project_id=project_id,
        label=_label(label),
        summary=(summary or "").strip()[:MAX_SUMMARY],
        item_kind=item_kind,
        item_id=item_id,
        created_by=actor,
        updated_by=actor,
    )
    session.add(d)
    await session.flush()
    session.add(
        DiagramVersion(
            diagram_id=d.id, version=1, source=source, svg=clean_svg, author=actor
        )
    )
    await session.commit()
    return await _out(session, d)


async def get_diagram(
    session: AsyncSession,
    diagram_id: str,
    *,
    version: int | None = None,
    include_source: bool = False,
) -> dict[str, Any]:
    """Return a diagram's details and a text summary drafted from its labels.

    Args:
        diagram_id: Diagram to read.
        version: A specific saved version; defaults to the latest.
        include_source: Also return the ``.drawio`` source (the editor needs it, a page does not).

    Returns:
        The diagram, with ``suggested_summary`` and, if asked for, ``source``.
    """
    d = await _diagram(session, diagram_id)
    v = await _version(session, d.id, version, d.version)
    out = await _out(session, d, v)
    if include_source:
        out["source"] = v.source
    try:
        out["suggested_summary"] = text_summary(
            SafeET.fromstring(v.source, forbid_dtd=True)
        )
    except (ET.ParseError, DefusedXmlException):
        out["suggested_summary"] = ""
    return out


async def read_file(
    session: AsyncSession,
    diagram_id: str,
    *,
    kind: str,
    version: int | None = None,
) -> tuple[str, str, str]:
    """Return ``(content, media_type, file_name)`` of a diagram's ``svg`` preview or ``drawio`` source."""
    d = await _diagram(session, diagram_id)
    v = await _version(session, d.id, version, d.version)
    stem = re.sub(r"[^\w.-]+", "-", d.label, flags=re.ASCII).strip("-._") or "diagram"
    if kind == "svg":
        return v.svg, "image/svg+xml", f"{stem}.svg"
    return v.source, "application/vnd.jgraph.mxfile", f"{stem}.drawio"


async def update_diagram(
    session: AsyncSession,
    diagram_id: str,
    *,
    base_version: int,
    source: str,
    svg: str,
    label: str | None = None,
    summary: str | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    """Save a new version of a diagram.

    Args:
        diagram_id: Diagram to change.
        base_version: The version the edit started from; must be the latest.
        source: The ``.drawio`` XML.
        svg: The SVG preview.
        label: New name, if changed.
        summary: New text summary, if changed.
        note: What changed, kept with the version.

    Returns:
        The saved diagram.

    Raises:
        DocsError: 403 for viewers; 409 ``diagram_conflict`` if someone saved a newer version.
    """
    d = await _diagram(session, diagram_id)
    _need_member(await role_of(session, d.project_id))
    if base_version != d.version:
        latest = await _version(session, d.id, None, d.version)
        raise DocsError(
            409,
            "diagram_conflict",
            f"{latest.author} saved a newer version while you were editing.",
            latest_version=d.version,
            latest_author=latest.author,
            latest_at=latest.created_at,
        )
    validate_source(source)
    clean_svg = sanitize_svg(svg)
    actor = activity.current_actor()
    d.version += 1
    d.updated_by = actor
    d.updated_at = _now()
    if label is not None:
        d.label = _label(label)
    if summary is not None:
        d.summary = summary.strip()[:MAX_SUMMARY]
    session.add(d)
    session.add(
        DiagramVersion(
            diagram_id=d.id,
            version=d.version,
            source=source,
            svg=clean_svg,
            author=actor,
            note=(note or "").strip()[:200] or None,
        )
    )
    await session.commit()
    return await _out(session, d)


async def delete_diagram(session: AsyncSession, diagram_id: str) -> dict[str, Any]:
    """Unlink a diagram: it stops resolving but is kept, with its versions, for restoring."""
    d = await _diagram(session, diagram_id)
    _need_member(await role_of(session, d.project_id))
    d.deleted_at = _now()
    d.deleted_by = activity.current_actor()
    session.add(d)
    await session.commit()
    return {"id": d.id, "deleted_at": d.deleted_at}


async def restore_diagram(session: AsyncSession, diagram_id: str) -> dict[str, Any]:
    """Bring an unlinked diagram back."""
    d = await _diagram(session, diagram_id, deleted_ok=True)
    _need_member(await role_of(session, d.project_id))
    d.deleted_at = None
    d.deleted_by = None
    session.add(d)
    await session.commit()
    return await _out(session, d)


async def list_versions(session: AsyncSession, diagram_id: str) -> list[dict[str, Any]]:
    """List a diagram's saved versions, newest first."""
    d = await _diagram(session, diagram_id)
    rows = await session.exec(
        select(DiagramVersion)
        .where(DiagramVersion.diagram_id == d.id)
        .order_by(DiagramVersion.version.desc())  # type: ignore[attr-defined]
    )
    return [
        {
            "version": v.version,
            "author": v.author,
            "note": v.note,
            "created_at": v.created_at,
            "size_bytes": len(v.source.encode("utf-8")),
        }
        for v in rows.all()
    ]


async def list_diagrams(
    session: AsyncSession, project_id: str, *, deleted: bool = False
) -> list[dict[str, Any]]:
    """List a project's diagrams (or, with ``deleted``, the ones in the Recycle Bin)."""
    if await session.get(Project, project_id) is None:
        raise DocsError(404, "project_not_found", "Project not found")
    rows = await session.exec(
        select(Diagram)
        .where(Diagram.project_id == project_id)
        .order_by(Diagram.updated_at.desc())  # type: ignore[attr-defined]
    )
    return [await _out(session, d) for d in rows.all() if bool(d.deleted_at) == deleted]


# --- Docs history -------------------------------------------------------------------


async def pin_versions(session: AsyncSession, markdown: str) -> str:
    """JSON ``{diagram id: version}`` for the live diagrams a page text references."""
    pins: dict[str, int] = {}
    for diagram_id in refs_in(markdown):
        d = await session.get(Diagram, diagram_id)
        if d is not None and not d.deleted_at:
            pins[diagram_id] = d.version
    return json.dumps(pins)


def parse_pins(raw: str | None) -> dict[str, int]:
    """Read the pins stored on a page version."""
    try:
        data = json.loads(raw or "{}")
    except ValueError:
        return {}
    return (
        {k: v for k, v in data.items() if isinstance(v, int)}
        if isinstance(data, dict)
        else {}
    )


async def restore_pins(session: AsyncSession, pins: dict[str, int]) -> None:
    """Make each pinned diagram's latest version the pinned one (as a new version); no commit.

    An unlinked diagram that a restored page uses is linked again. A diagram that no longer
    exists is skipped; the page then shows its "Diagram not found" state.
    """
    actor = activity.current_actor()
    for diagram_id, n in pins.items():
        d = await session.get(Diagram, diagram_id)
        if d is None:
            continue
        d.deleted_at = None
        d.deleted_by = None
        if d.version != n:
            rows = await session.exec(
                select(DiagramVersion).where(
                    DiagramVersion.diagram_id == d.id, DiagramVersion.version == n
                )
            )
            old = rows.first()
            if old is not None:
                d.version += 1
                d.updated_by = actor
                d.updated_at = _now()
                session.add(
                    DiagramVersion(
                        diagram_id=d.id,
                        version=d.version,
                        source=old.source,
                        svg=old.svg,
                        author=actor,
                        note=f"Restored from v{n}",
                    )
                )
        session.add(d)
    await session.flush()


# --- editor setting -----------------------------------------------------------------


async def get_settings(session: AsyncSession) -> dict[str, Any]:
    """Where the draw.io editor runs, with the address the browser should open."""
    row = await session.get(DiagramSettings, 1)
    mode = row.mode if row else "self-hosted"
    url = (row.url if row else "").strip()
    effective = PUBLIC_URL if mode == "public" else (url or SELF_HOSTED_DEFAULT)
    return {
        "mode": mode,
        "url": url,
        "effective_url": effective.rstrip("/"),
        "default_self_hosted_url": SELF_HOSTED_DEFAULT,
        "public_url": PUBLIC_URL,
        "sends_drawings_to_third_party": mode == "public",
    }


async def set_settings(
    session: AsyncSession, *, mode: str, url: str | None
) -> dict[str, Any]:
    """Change where the editor runs. Admin only.

    Raises:
        DocsError: 403 unless the caller is an admin; 422 for a bad mode or address.
    """
    from services.docs_comments import _members, role_in

    project_ids = (await session.exec(select(Project.id))).all()
    actor = activity.current_actor()
    is_admin = actor == activity.HUMAN_ACTOR
    if not is_admin:
        for pid in project_ids:
            if role_in(await _members(session, pid), actor) == "admin":
                is_admin = True
                break
    if not is_admin:
        raise DocsError(
            403, "admin_only", "Only an admin can change where the editor runs."
        )
    if mode not in ("self-hosted", "public"):
        raise DocsError(422, "invalid_mode", "mode must be self-hosted or public")
    clean = (url or "").strip()
    if clean and not re.match(r"^https?://[^\s/?#]+(/[^\s?#]*)?$", clean):
        raise DocsError(
            422, "invalid_url", "The editor address must start with http:// or https://"
        )
    row = await session.get(DiagramSettings, 1) or DiagramSettings(id=1)
    row.mode = mode
    row.url = clean
    session.add(row)
    await session.commit()
    return await get_settings(session)


# --- AI agent access: the drawing as nodes and edges ----------------------------------------------


async def read_outline(
    session: AsyncSession,
    diagram_id: str,
    *,
    version: int | None = None,
    include_xml: bool = False,
) -> dict[str, Any]:
    """A diagram as the agent reads it: details plus the first page as ``nodes`` and ``edges``.

    Args:
        diagram_id: Diagram to read.
        version: A saved version; the latest by default.
        include_xml: Also return the raw ``.drawio`` XML.
    """
    d = await _diagram(session, diagram_id)
    v = await _version(session, d.id, version, d.version)
    out = {
        "id": d.id,
        "project_id": d.project_id,
        "label": d.label,
        "summary": d.summary,
        "version": d.version,
        "shown_version": v.version,
        "updated_by": d.updated_by,
        "updated_at": d.updated_at,
        "markdown": f"[{d.label}](diagram:{d.id})",
    }
    out.update(diagram_model.Drawing(v.source).outline())
    if include_xml:
        out["xml"] = v.source
    return out


async def agent_create(
    session: AsyncSession,
    project_id: str,
    *,
    label: str,
    nodes: list[dict[str, Any]] | None = None,
    edges: list[dict[str, Any]] | None = None,
    direction: str = "LR",
    xml: str | None = None,
    summary: str | None = None,
) -> dict[str, Any]:
    """Create a diagram from nodes and edges (laid out for you) or from complete ``.drawio`` XML."""
    if (xml is None) == (not nodes):
        raise DocsError(
            422,
            "invalid_diagram_edit",
            "Give either nodes (and edges) or xml, not both.",
        )
    source = (
        xml
        if xml is not None
        else diagram_model.build_source(nodes or [], edges or [], direction)
    )
    svg = diagram_model.render_svg(source)
    out = await create_diagram(
        session, project_id, label=label, source=source, svg=svg, summary=summary
    )
    out["markdown"] = f"[{out['label']}](diagram:{out['id']})"
    return out


async def agent_edit(
    session: AsyncSession,
    diagram_id: str,
    *,
    base_version: int,
    ops: list[dict[str, Any]],
    label: str | None = None,
    summary: str | None = None,
) -> dict[str, Any]:
    """Apply edit operations to the latest version and save the result as a new version."""
    d = await _diagram(session, diagram_id)
    if base_version != d.version:
        return await update_diagram(  # raises the 409 with who saved the newer one
            session, diagram_id, base_version=base_version, source="", svg=""
        )
    v = await _version(session, d.id, None, d.version)
    source, info = diagram_model.apply_ops(v.source, ops)
    out = await update_diagram(
        session,
        diagram_id,
        base_version=base_version,
        source=source,
        svg=diagram_model.render_svg(source),
        label=label,
        summary=summary,
        note=f"Edited by an AI agent ({len(ops)} operation{'s' if len(ops) != 1 else ''})",
    )
    out["added"] = info["added"]
    return out


async def agent_replace(
    session: AsyncSession,
    diagram_id: str,
    *,
    base_version: int,
    xml: str,
    label: str | None = None,
) -> dict[str, Any]:
    """Replace a diagram's whole ``.drawio`` source."""
    return await update_diagram(
        session,
        diagram_id,
        base_version=base_version,
        source=xml,
        svg=diagram_model.render_svg(xml),
        label=label,
        note="Replaced by an AI agent",
    )


async def restore_version(
    session: AsyncSession, diagram_id: str, version: int
) -> dict[str, Any]:
    """Save an old version's content again as a new version (history is kept)."""
    d = await _diagram(session, diagram_id)
    old = await _version(session, d.id, version, d.version)
    return await update_diagram(
        session,
        diagram_id,
        base_version=d.version,
        source=old.source,
        svg=old.svg,
        note=f"Restored from v{version}",
    )
