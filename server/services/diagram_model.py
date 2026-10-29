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
    xs, ys, xe, ye = [0.0], [0.0], [200.0], [100.0]
    if boxes:
        xs = [b[0] for b in boxes.values()]
        ys = [b[1] for b in boxes.values()]
        xe = [b[0] + b[2] for b in boxes.values()]
        ye = [b[1] + b[3] for b in boxes.values()]
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
        ca, cb = (a[0] + a[2] / 2, a[1] + a[3] / 2), (b[0] + b[2] / 2, b[1] + b[3] / 2)
        p, q = edge_point(a, cb), edge_point(b, ca)
        color = style_get(c.get("style") or "", "strokeColor") or "#333333"
        parts.append(
            f'<line x1="{p[0] - ox:.1f}" y1="{p[1] - oy:.1f}" x2="{q[0] - ox:.1f}" y2="{q[1] - oy:.1f}" '
            f'stroke="{_esc(color)}" stroke-width="1.5" marker-end="url(#arrow)"/>'
        )
        label = d.label_of(e)
        if label:
            mx, my = (p[0] + q[0]) / 2 - ox, (p[1] + q[1]) / 2 - oy
            parts.append(
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
        + "</svg>"
    )
