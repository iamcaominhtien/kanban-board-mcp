"""Reads a draw.io drawing and draws a basic SVG preview of its first page.

The editable source is the real ``.drawio`` XML and is never rewritten here. The SVG made here is a plain preview (boxes,
ellipses, diamonds, cylinders, arrows and text; any other shape is drawn as a box); the draw.io editor draws the fine one
the next time a person saves.
"""

import base64
import html
import math
import re
import urllib.parse
import xml.etree.ElementTree as ET
import zlib
from typing import Any

from defusedxml import DefusedXmlException
from defusedxml import ElementTree as SafeET

from services.docs_text import DocsError

DEFAULT_W, DEFAULT_H = 120, 60
MAX_CELLS = 2000

# style keys that decide the shape; replaced when the shape of a node changes


def _bad(message: str) -> DocsError:
    return DocsError(422, "invalid_diagram_edit", message)


# --- reading ---------------------------------------------------------------------------------


def _local(tag: Any) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _parse(text: str) -> ET.Element:
    try:
        return SafeET.fromstring(text, forbid_dtd=True)
    except (ET.ParseError, DefusedXmlException) as e:
        raise _bad(f"The diagram XML could not be read ({e}).") from e


def _inflate(data: str) -> ET.Element:
    try:
        raw = zlib.decompress(base64.b64decode(data.strip()), -15)
        return _parse(urllib.parse.unquote(raw.decode("utf-8")))
    except (ValueError, zlib.error) as e:
        raise _bad(
            "The first page of the diagram is compressed in an unknown way."
        ) from e


class Drawing:
    """The first page of a ``.drawio`` file as an editable graph. Other pages are kept untouched."""

    def __init__(self, source: str) -> None:
        """Parse ``source`` (an ``<mxfile>`` or a bare ``<mxGraphModel>``)."""
        self.root = _parse(source)
        self._page: ET.Element | None = None
        kind = _local(self.root.tag)
        if kind == "mxGraphModel":
            model = self.root
        elif kind == "mxfile":
            pages = [p for p in self.root if _local(p.tag) == "diagram"]
            if not pages:
                raise _bad("The file has no page.")
            self._page = pages[0]
            self.pages = len(pages)
            inner = next(
                (c for c in self._page if _local(c.tag) == "mxGraphModel"), None
            )
            if inner is None:
                inner = (
                    _inflate(self._page.text or "")
                    if (self._page.text or "").strip()
                    else None
                )
            if inner is None:
                raise _bad("The first page is empty.")
            model = inner
        else:
            raise _bad(
                "This is not a draw.io file (expected <mxfile> or <mxGraphModel>)."
            )
        self.model = model
        self.pages = getattr(self, "pages", 1)
        container = next((c for c in model if _local(c.tag) == "root"), None)
        if container is None:
            container = ET.SubElement(model, "root")
        if not any(c.get("id") == "0" for c in container):
            container.insert(0, ET.Element("mxCell", {"id": "0"}))
            container.insert(1, ET.Element("mxCell", {"id": "1", "parent": "0"}))
        self.container = container
        if len(list(container)) > MAX_CELLS:
            raise _bad(f"The diagram has more than {MAX_CELLS} elements.")

    # cells ----------------------------------------------------------------------------------

    def _cell(self, el: ET.Element) -> ET.Element:
        """The ``mxCell`` of an element (``UserObject`` / ``object`` wrap one)."""
        if _local(el.tag) == "mxCell":
            return el
        return next((c for c in el if _local(c.tag) == "mxCell"), el)

    def elements(self) -> list[ET.Element]:
        """Every drawn element (vertex or edge), wrappers included."""
        out = []
        for el in self.container:
            cell = self._cell(el)
            if cell.get("vertex") == "1" or cell.get("edge") == "1":
                out.append(el)
        return out

    def find(self, cell_id: str) -> ET.Element | None:
        """The element with this id."""
        return next((e for e in self.container if e.get("id") == cell_id), None)

    def _default_parent(self) -> str:
        for el in self.container:
            if (
                el.get("id") not in (None, "0")
                and _local(el.tag) == "mxCell"
                and el.get("parent") == "0"
            ):
                return el.get("id") or "1"
        return "1"

    @staticmethod
    def label_of(el: ET.Element) -> str:
        """The element's text as plain text (HTML labels are flattened)."""
        raw = (
            el.get("label")
            if _local(el.tag) in ("UserObject", "object")
            else el.get("value")
        )
        return plain(raw or "")

    def geometry(self, el: ET.Element) -> dict[str, float] | None:
        """``{x, y, w, h}`` of a vertex, relative to its parent."""
        g = next((c for c in self._cell(el) if _local(c.tag) == "mxGeometry"), None)
        if g is None:
            return None
        num = lambda k, d=0.0: float(g.get(k) or d)  # noqa: E731
        return {
            "x": num("x"),
            "y": num("y"),
            "w": num("width", DEFAULT_W),
            "h": num("height", DEFAULT_H),
        }

    # writing --------------------------------------------------------------------------------


# --- styles and labels -----------------------------------------------------------------------


def style_get(style: str, key: str) -> str | None:
    """Value of ``key=value`` in a draw.io style string."""
    for part in style.split(";"):
        k, _, v = part.partition("=")
        if k == key and v:
            return v
    return None


def shape_of(style: str) -> str:
    """The closest of the agent's shape names for a style string."""
    keys = {p.partition("=")[0] for p in style.split(";") if p}
    value = style_get(style, "shape") or ""
    if "ellipse" in keys:
        return "ellipse"
    if "rhombus" in keys:
        return "diamond"
    if "cylinder" in value:
        return "cylinder"
    if "text" in keys:
        return "text"
    return "rounded" if style_get(style, "rounded") == "1" else "rect"


def plain(label: str) -> str:
    """An HTML label as plain text."""
    text = re.sub(r"<\s*(br|/p|/div)\s*/?>", "\n", label, flags=re.I)
    text = re.sub(r"<[^>]{0,200}>", "", text)
    return html.unescape(text).strip()


# --- the drawing as a model, for an agent (issue #267) -----------------------------------------

MODEL_CELLS = 300


def _is_container(style: str) -> bool:
    keys = {p.partition("=")[0] for p in style.split(";") if p}
    return (
        "swimlane" in keys
        or style_get(style, "container") == "1"
        or "group" in keys
        or (style_get(style, "shape") or "").startswith("table")
    )


def model(source: str, limit: int = MODEL_CELLS) -> dict[str, Any]:
    """The first page as the agent reads it: shapes and links with their ids, labels, boxes and styles.

    Returns:
        ``{page, pages, shapes: [{id, label, shape, x, y, w, h, style, in?, container?}], links: [{id, label, from,
        to, style}], problems, truncated?}``. A shape's ``x, y`` are relative to the shape it is ``in`` (a group, a
        container or a lane), else to the page.
    """
    d = Drawing(source)
    layers = {"0", "1", d._default_parent()}
    shapes: list[dict[str, Any]] = []
    links: list[dict[str, Any]] = []
    for el in d.elements():
        cell = d._cell(el)
        style = cell.get("style") or ""
        item: dict[str, Any] = {"id": el.get("id") or "", "label": d.label_of(el)}
        if cell.get("edge") == "1":
            item |= {
                "from": cell.get("source"),
                "to": cell.get("target"),
                "style": style,
            }
            links.append(item)
            continue
        g = d.geometry(el) or {"x": 0.0, "y": 0.0, "w": DEFAULT_W, "h": DEFAULT_H}
        item |= {"shape": shape_of(style), **{k: round(v, 1) for k, v in g.items()}}
        item["style"] = style
        parent = cell.get("parent")
        if parent and parent not in layers:
            item["in"] = parent
        if _is_container(style):
            item["container"] = True
        shapes.append(item)
    out: dict[str, Any] = {
        "page": (d._page.get("name") if d._page is not None else None) or "Page-1",
        "pages": d.pages,
        "shapes": shapes[:limit],
        "links": links[:limit],
        "problems": problems(d),
    }
    if len(shapes) > limit or len(links) > limit:
        out["truncated"] = (
            f"{len(shapes)} shapes and {len(links)} links; the first {limit} of each are listed. "
            "The .drawio file has them all."
        )
    return out


def problems(d: "Drawing") -> list[str]:
    """What will look broken once drawn: links to nothing, repeated ids, shapes on top of each other."""
    out: list[str] = []
    ids = [el.get("id") for el in d.container if el.get("id")]
    seen: set[str] = set()
    for i in ids:
        if i in seen:
            out.append(
                f"The id {i!r} is used twice: give each shape and link its own id."
            )
        seen.add(i or "")
    boxes: list[tuple[str, str, dict[str, float], bool]] = []
    for el in d.elements():
        cell = d._cell(el)
        if cell.get("edge") == "1":
            for end in ("source", "target"):
                ref = cell.get(end)
                if ref and ref not in seen:
                    out.append(
                        f"Link {el.get('id')!r} points at {ref!r}, which is not a shape: use the id of a shape "
                        "on this page (or drop the attribute and give the link sourcePoint / targetPoint)."
                    )
            continue
        g = d.geometry(el)
        if g:
            style = cell.get("style") or ""
            boxes.append(
                (
                    el.get("id") or "",
                    cell.get("parent") or "",
                    g,
                    _is_container(style) or "text" in style.split(";"),
                )
            )
    overlaps = 0
    for i, (a_id, a_parent, a, a_skip) in enumerate(boxes):
        for b_id, b_parent, b, b_skip in boxes[i + 1 :]:
            if a_parent != b_parent or a_skip or b_skip:
                continue
            if (
                a["x"] < b["x"] + b["w"]
                and b["x"] < a["x"] + a["w"]
                and a["y"] < b["y"] + b["h"]
                and b["y"] < a["y"] + a["h"]
            ):
                overlaps += 1
                if overlaps <= 5:
                    out.append(
                        f"Shapes {a_id!r} and {b_id!r} overlap: move one so they are at least 40 px apart."
                    )
    if overlaps > 5:
        out.append(f"... and {overlaps - 5} more overlapping pairs.")
    return out


def uncompressed(source: str) -> str:
    """``source`` with every compressed page written out as plain XML (draw.io reads both), so an agent can edit it
    with its own file tools; unchanged when no page is compressed."""
    try:
        root = _parse(source)
    except DocsError:
        return source
    if _local(root.tag) != "mxfile":
        return source
    changed = False
    for page in root:
        if _local(page.tag) != "diagram" or any(
            _local(c.tag) == "mxGraphModel" for c in page
        ):
            continue
        data = (page.text or "").strip()
        if not data:
            continue
        try:
            inner = _inflate(data)
        except DocsError:
            continue
        page.text = None
        page.append(inner)
        changed = True
    if not changed:
        return source
    return ET.tostring(root, encoding="unicode")


def wireframe_png(source: str, max_side: int = 1600) -> bytes:
    """A picture of the first page made without a browser: shapes as outlined boxes, links as lines, no text."""
    from services import canvas_png

    d = Drawing(source)
    layers = {"0", "1", d._default_parent()}
    boxes: dict[str, tuple[float, float, float, float]] = {}

    def absolute(el: ET.Element, depth: int = 0) -> tuple[float, float, float, float]:
        g = d.geometry(el) or {"x": 0.0, "y": 0.0, "w": DEFAULT_W, "h": DEFAULT_H}
        x, y = g["x"], g["y"]
        parent = d._cell(el).get("parent")
        if parent not in layers and depth < 20:
            pe = d.find(parent or "")
            if pe is not None:
                px, py, _, _ = absolute(pe, depth + 1)
                x, y = x + px, y + py
        return x, y, g["w"], g["h"]

    for el in d.elements():
        if d._cell(el).get("vertex") == "1":
            boxes[el.get("id") or ""] = absolute(el)
    if not boxes:
        return canvas_png.Raster(200, 100).png()
    pad = 20
    left = min(b[0] for b in boxes.values()) - pad
    top = min(b[1] for b in boxes.values()) - pad
    width = max(b[0] + b[2] for b in boxes.values()) + pad - left
    height = max(b[1] + b[3] for b in boxes.values()) + pad - top
    scale = min(1.0, max_side / max(width, height, 1))
    r = canvas_png.Raster(int(width * scale) + 1, int(height * scale) + 1)
    ink, line = (51, 51, 51), (120, 120, 120)

    def to_px(x: float, y: float) -> tuple[float, float]:
        return (x - left) * scale, (y - top) * scale

    for el in d.elements():
        cell = d._cell(el)
        if cell.get("edge") != "1":
            continue
        a, b = boxes.get(cell.get("source") or ""), boxes.get(cell.get("target") or "")
        if a and b:
            r.line(
                *to_px(a[0] + a[2] / 2, a[1] + a[3] / 2),
                *to_px(b[0] + b[2] / 2, b[1] + b[3] / 2),
                line,
            )
    for el_id, (x, y, w, h) in boxes.items():
        el = d.find(el_id)
        style = (d._cell(el).get("style") or "") if el is not None else ""
        px, py = to_px(x, y)
        if not _is_container(style):
            r.rect(px, py, w * scale, h * scale, (255, 255, 255))
        r.frame(px, py, w * scale, h * scale, ink, 2 if not _is_container(style) else 1)
    return r.png()


# --- editing entry points --------------------------------------------------------------------


# --- SVG preview -----------------------------------------------------------------------------


def _esc(text: str) -> str:
    return html.escape(text, quote=True)


def _wrap(text: str, width: float, size: float) -> list[str]:
    per_line = max(4, int(width / (size * 0.58)))
    lines: list[str] = []
    for para in text.split("\n"):
        line = ""
        for word in para.split(" "):
            candidate = f"{line} {word}".strip()
            if len(candidate) > per_line and line:
                lines.append(line)
                line = word
            else:
                line = candidate
        lines.append(line)
    return lines


Box = tuple[float, float, float, float]
Point = tuple[float, float]


def waypoints(cell: ET.Element) -> list[Point]:
    """The bends a person or an agent gave a link: ``<mxGeometry><Array as="points"><mxPoint x y/>``."""
    g = next((c for c in cell if _local(c.tag) == "mxGeometry"), None)
    arr = (
        next(
            (c for c in g if _local(c.tag) == "Array" and c.get("as") == "points"),
            None,
        )
        if g is not None
        else None
    )
    out: list[Point] = []
    for p in arr if arr is not None else []:
        try:
            out.append((float(p.get("x") or 0), float(p.get("y") or 0)))
        except ValueError:
            continue
    return out


def route(a: Box, b: Box, bends: list[Point], orthogonal: bool, clip) -> list[Point]:
    """The points a link is drawn through: its own bends, else for an orthogonal link an elbow between the facing
    sides (as the editor draws it), else a straight line between the edges of the two shapes."""
    ca = (a[0] + a[2] / 2, a[1] + a[3] / 2)
    cb = (b[0] + b[2] / 2, b[1] + b[3] / 2)
    if bends:
        path = [clip(a, bends[0]), *bends, clip(b, bends[-1])]
        if not orthogonal:
            return path
        out = [path[0]]
        for p in path[1:]:
            q = out[-1]
            if abs(p[0] - q[0]) > 0.5 and abs(p[1] - q[1]) > 0.5:
                out.append((p[0], q[1]))
            out.append(p)
        return out
    if not orthogonal:
        return [clip(a, cb), clip(b, ca)]
    dx, dy = cb[0] - ca[0], cb[1] - ca[1]
    if abs(dy) >= abs(dx):
        s = (ca[0], a[1] + a[3] if dy > 0 else a[1])
        e = (cb[0], b[1] if dy > 0 else b[1] + b[3])
        if abs(s[0] - e[0]) < 0.5:
            return [s, e]
        mid = (s[1] + e[1]) / 2
        return [s, (s[0], mid), (e[0], mid), e]
    s = (a[0] + a[2] if dx > 0 else a[0], ca[1])
    e = (b[0] if dx > 0 else b[0] + b[2], cb[1])
    if abs(s[1] - e[1]) < 0.5:
        return [s, e]
    mid = (s[0] + e[0]) / 2
    return [s, (mid, s[1]), (mid, e[1]), e]


def render_svg(source: str) -> str:
    """A basic SVG of the first page: shapes, connectors with arrows, and labels."""
    d = Drawing(source)
    boxes: dict[str, tuple[float, float, float, float]] = {}

    def absolute(el: ET.Element) -> tuple[float, float, float, float] | None:
        g = d.geometry(el)
        if g is None:
            return None
        x, y = g["x"], g["y"]
        parent, seen = d._cell(el).get("parent"), 0
        while parent not in (None, "0", "1", d._default_parent()) and seen < 20:
            pe = d.find(parent or "")
            pg = d.geometry(pe) if pe is not None else None
            if pg:
                x, y = x + pg["x"], y + pg["y"]
            parent = d._cell(pe).get("parent") if pe is not None else None
            seen += 1
        return x, y, g["w"], g["h"]

    verts = [e for e in d.elements() if d._cell(e).get("vertex") == "1"]
    for e in verts:
        box = absolute(e)
        if box:
            boxes[e.get("id") or ""] = box
    parts: list[str] = []
    edge_parts: list[
        str
    ] = []  # arrows are drawn after the shapes so containers never hide them
    xs, ys, xe, ye = [0.0], [0.0], [200.0], [100.0]
    if boxes:
        xs = [b[0] for b in boxes.values()]
        ys = [b[1] for b in boxes.values()]
        xe = [b[0] + b[2] for b in boxes.values()]
        ye = [b[1] + b[3] for b in boxes.values()]
    # a link's own bends (waypoints) count too, so a loop drawn around the outside is not cut off
    bends = {
        e.get("id") or "": waypoints(d._cell(e))
        for e in d.elements()
        if d._cell(e).get("edge") == "1"
    }
    for pts in bends.values():
        xs += [p[0] for p in pts]
        ys += [p[1] for p in pts]
        xe += [p[0] for p in pts]
        ye += [p[1] for p in pts]
    pad = 20.0
    ox, oy = min(xs) - pad, min(ys) - pad
    width, height = max(xe) - min(xs) + 2 * pad, max(ye) - min(ys) + 2 * pad

    def edge_point(
        box: tuple[float, float, float, float], toward: tuple[float, float]
    ) -> tuple[float, float]:
        x, y, w, h = box
        cx, cy = x + w / 2, y + h / 2
        dx, dy = toward[0] - cx, toward[1] - cy
        if dx == 0 and dy == 0:
            return cx, cy
        scale = min(
            (w / 2) / abs(dx) if dx else math.inf, (h / 2) / abs(dy) if dy else math.inf
        )
        return cx + dx * scale, cy + dy * scale

    for e in d.elements():
        c = d._cell(e)
        if c.get("edge") != "1":
            continue
        a, b = boxes.get(c.get("source") or ""), boxes.get(c.get("target") or "")
        if not a or not b:
            continue
        style = c.get("style") or ""
        path = route(
            a,
            b,
            bends.get(e.get("id") or "", []),
            style_get(style, "edgeStyle") == "orthogonalEdgeStyle",
            edge_point,
        )
        color = style_get(style, "strokeColor") or "#333333"
        pts = " ".join(f"{x - ox:.1f},{y - oy:.1f}" for x, y in path)
        edge_parts.append(
            f'<polyline points="{pts}" fill="none" stroke="{_esc(color)}" stroke-width="1.5" '
            'marker-end="url(#arrow)"/>'
        )
        label = d.label_of(e)
        if label:
            # on the middle of the longest segment, where draw.io puts it too
            seg = max(
                zip(path, path[1:]),
                key=lambda s: abs(s[1][0] - s[0][0]) + abs(s[1][1] - s[0][1]),
            )
            p, q = seg
            mx, my = (p[0] + q[0]) / 2 - ox, (p[1] + q[1]) / 2 - oy
            edge_parts.append(
                f'<text x="{mx:.1f}" y="{my - 4:.1f}" text-anchor="middle" font-size="11" fill="#333333" '
                f'stroke="#ffffff" stroke-width="3" paint-order="stroke">{_esc(label)}</text>'
            )
    for e in verts:
        box = boxes.get(e.get("id") or "")
        if not box:
            continue
        x, y, w, h = box[0] - ox, box[1] - oy, box[2], box[3]
        style = d._cell(e).get("style") or ""
        shape = shape_of(style)
        fill = style_get(style, "fillColor") or "#ffffff"
        stroke = style_get(style, "strokeColor") or "#333333"
        attrs = f'fill="{_esc(fill)}" stroke="{_esc(stroke)}" stroke-width="1.5"'
        if shape == "text":
            attrs = 'fill="none" stroke="none"'
        if shape == "ellipse":
            parts.append(
                f'<ellipse cx="{x + w / 2:.1f}" cy="{y + h / 2:.1f}" rx="{w / 2:.1f}" ry="{h / 2:.1f}" {attrs}/>'
            )
        elif shape == "diamond":
            pts = f"{x + w / 2:.1f},{y:.1f} {x + w:.1f},{y + h / 2:.1f} {x + w / 2:.1f},{y + h:.1f} {x:.1f},{y + h / 2:.1f}"
            parts.append(f'<polygon points="{pts}" {attrs}/>')
        elif shape == "cylinder":
            ry = min(15.0, h / 4)
            parts.append(
                f'<path d="M{x:.1f},{y + ry:.1f} a{w / 2:.1f},{ry:.1f} 0 0,1 {w:.1f},0 v{h - 2 * ry:.1f} '
                f'a{w / 2:.1f},{ry:.1f} 0 0,1 {-w:.1f},0 z" {attrs}/>'
                f'<ellipse cx="{x + w / 2:.1f}" cy="{y + ry:.1f}" rx="{w / 2:.1f}" ry="{ry:.1f}" {attrs}/>'
            )
        else:
            r = 8 if shape == "rounded" else 0
            parts.append(
                f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="{r}" {attrs}/>'
            )
        label = d.label_of(e)
        if label:
            try:
                size = float(style_get(style, "fontSize") or 12)
            except ValueError:
                size = 12.0
            color = style_get(style, "fontColor") or "#000000"
            lines = _wrap(label, w - 10, size)
            first = y + h / 2 - (len(lines) - 1) * size * 0.6 + size * 0.35
            spans = "".join(
                f'<tspan x="{x + w / 2:.1f}" y="{first + i * size * 1.2:.1f}">{_esc(line)}</tspan>'
                for i, line in enumerate(lines)
            )
            parts.append(
                f'<text text-anchor="middle" font-size="{size:g}" fill="{_esc(color)}">{spans}</text>'
            )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:.0f}" height="{height:.0f}" viewBox="0 0 {width:.0f} {height:.0f}" '
        'font-family="Helvetica, Arial, sans-serif"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" '
        'markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#333333"/></marker></defs>'
        + "".join(parts)
        + "".join(edge_parts)
        + "</svg>"
    )
