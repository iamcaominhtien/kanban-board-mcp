"""A small, agent-friendly model of a draw.io drawing: read it as nodes and edges, edit it with a few operations,
build one from scratch, and draw a basic SVG preview of it.

The editable source stays the real ``.drawio`` XML. Edits only touch what they name, so styles, groups, other pages and
anything this module does not understand survive. The SVG made here is a plain preview (boxes, ellipses, diamonds,
arrows and text); the draw.io editor draws the fine one the next time a person saves.
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

SHAPES = ("rect", "rounded", "ellipse", "diamond", "cylinder", "text")
DEFAULT_W, DEFAULT_H = 120, 60
GAP_X, GAP_Y = 70, 40
MAX_CELLS = 2000

_VERTEX_STYLE = {
    "rect": "rounded=0;whiteSpace=wrap;html=1;",
    "rounded": "rounded=1;whiteSpace=wrap;html=1;",
    "ellipse": "ellipse;whiteSpace=wrap;html=1;",
    "diamond": "rhombus;whiteSpace=wrap;html=1;",
    "cylinder": "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;",
    "text": "text;html=1;align=center;verticalAlign=middle;whiteSpace=wrap;",
}
_EDGE_STYLE = "edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=classic;"
# style keys that decide the shape; replaced when the shape of a node changes
_SHAPE_KEYS = {
    "rounded",
    "ellipse",
    "rhombus",
    "shape",
    "text",
    "boundedLbl",
    "backgroundOutline",
    "size",
}


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

    def outline(self) -> dict[str, Any]:
        """The first page as ``{nodes, edges, pages}``; the agent's compact view of the drawing."""
        nodes, edges = [], []
        for el in self.elements():
            cell = self._cell(el)
            style = cell.get("style") or ""
            if cell.get("vertex") == "1":
                g = self.geometry(el) or {
                    "x": 0,
                    "y": 0,
                    "w": DEFAULT_W,
                    "h": DEFAULT_H,
                }
                node: dict[str, Any] = {
                    "id": el.get("id"),
                    "label": self.label_of(el),
                    "shape": shape_of(style),
                    "x": round(g["x"]),
                    "y": round(g["y"]),
                    "w": round(g["w"]),
                    "h": round(g["h"]),
                }
                fill, stroke = (
                    style_get(style, "fillColor"),
                    style_get(style, "strokeColor"),
                )
                if fill:
                    node["fill"] = fill
                if stroke:
                    node["stroke"] = stroke
                if cell.get("parent") not in (None, "0", "1"):
                    node["parent"] = cell.get("parent")
                nodes.append(node)
            else:
                edge: dict[str, Any] = {
                    "id": el.get("id"),
                    "from": cell.get("source"),
                    "to": cell.get("target"),
                }
                label = self.label_of(el)
                if label:
                    edge["label"] = label
                edges.append(edge)
        return {"pages": self.pages, "nodes": nodes, "edges": edges}

    # writing --------------------------------------------------------------------------------

    def to_source(self) -> str:
        """The drawing as ``.drawio`` XML. The edited page is written uncompressed; other pages are kept as they were."""
        if self._page is not None:
            for child in list(self._page):
                self._page.remove(child)
            self._page.text = None
            self._page.append(self.model)
        return ET.tostring(self.root, encoding="unicode")

    def _new_id(self, prefix: str) -> str:
        used = {e.get("id") for e in self.container}
        n = len(used)
        while f"{prefix}{n}" in used:
            n += 1
        return f"{prefix}{n}"

    def bounds(self) -> tuple[float, float, float, float] | None:
        """``(min_x, min_y, max_x, max_y)`` of the top-level vertices."""
        boxes = []
        for el in self.elements():
            cell = self._cell(el)
            g = self.geometry(el)
            if (
                cell.get("vertex") == "1"
                and g
                and cell.get("parent") in (None, "1", self._default_parent())
            ):
                boxes.append((g["x"], g["y"], g["x"] + g["w"], g["y"] + g["h"]))
        if not boxes:
            return None
        return (
            min(b[0] for b in boxes),
            min(b[1] for b in boxes),
            max(b[2] for b in boxes),
            max(b[3] for b in boxes),
        )

    def add_node(self, spec: dict[str, Any]) -> str:
        """Add a vertex; without ``x``/``y`` it goes to the right of the drawing."""
        cell_id = str(spec.get("id") or self._new_id("n"))
        if self.find(cell_id) is not None:
            raise _bad(f"id '{cell_id}' is already used.")
        shape = spec.get("shape") or "rounded"
        if shape not in SHAPES:
            raise _bad(f"shape must be one of {', '.join(SHAPES)}.")
        w = _num(spec, "w", DEFAULT_W)
        h = _num(spec, "h", DEFAULT_H)
        px, py = (
            _num(spec, "x", 0),
            _num(spec, "y", 0),
        )  # validates both, even when one is missing
        if spec.get("x") is None or spec.get("y") is None:
            b = self.bounds()
            x, y = (b[2] + GAP_X, b[1]) if b else (40.0, 40.0)
        else:
            x, y = px, py
        style = spec.get("style") or _VERTEX_STYLE[shape]
        style = _with_colors(style, spec.get("fill"), spec.get("stroke"))
        parent = str(spec.get("parent") or self._default_parent())
        if self.find(parent) is None:
            raise _bad(f"parent '{parent}' does not exist.")
        cell = ET.SubElement(
            self.container,
            "mxCell",
            {
                "id": cell_id,
                "value": encode_label(str(spec.get("label", ""))),
                "style": style,
                "vertex": "1",
                "parent": parent,
            },
        )
        ET.SubElement(
            cell,
            "mxGeometry",
            {
                "x": _fmt(x),
                "y": _fmt(y),
                "width": _fmt(w),
                "height": _fmt(h),
                "as": "geometry",
            },
        )
        return cell_id

    def add_edge(self, spec: dict[str, Any]) -> str:
        """Add a connector between two vertices."""
        src, dst = spec.get("from"), spec.get("to")
        for end, name in ((src, "from"), (dst, "to")):
            if end is None or self.find(str(end)) is None:
                raise _bad(
                    f"add_edge: '{name}' must be the id of an existing node (got {end!r})."
                )
        cell_id = str(spec.get("id") or self._new_id("e"))
        if self.find(cell_id) is not None:
            raise _bad(f"id '{cell_id}' is already used.")
        cell = ET.SubElement(
            self.container,
            "mxCell",
            {
                "id": cell_id,
                "value": encode_label(str(spec.get("label", ""))),
                "style": spec.get("style") or _EDGE_STYLE,
                "edge": "1",
                "parent": self._default_parent(),
                "source": str(src),
                "target": str(dst),
            },
        )
        ET.SubElement(cell, "mxGeometry", {"relative": "1", "as": "geometry"})
        return cell_id

    def update(self, spec: dict[str, Any]) -> None:
        """Change a node or an edge; only the named fields change."""
        el = self.find(str(spec.get("id")))
        if el is None or el not in self.elements():
            raise _bad(f"update: no node or edge with id {spec.get('id')!r}.")
        cell = self._cell(el)
        if "label" in spec and spec["label"] is not None:
            attr = "label" if _local(el.tag) in ("UserObject", "object") else "value"
            el.set(attr, encode_label(str(spec["label"])))
        style = cell.get("style") or ""
        if spec.get("style"):
            style = str(spec["style"])
        if cell.get("vertex") == "1":
            if spec.get("shape"):
                if spec["shape"] not in SHAPES:
                    raise _bad(f"shape must be one of {', '.join(SHAPES)}.")
                style = _reshape(style, spec["shape"])
            style = _with_colors(style, spec.get("fill"), spec.get("stroke"))
            g = next((c for c in cell if _local(c.tag) == "mxGeometry"), None)
            if g is None:
                g = ET.SubElement(cell, "mxGeometry", {"as": "geometry"})
            for key, attr in (("x", "x"), ("y", "y"), ("w", "width"), ("h", "height")):
                if spec.get(key) is not None:
                    g.set(attr, _fmt(_num(spec, key, 0)))
        else:
            for key, attr in (("from", "source"), ("to", "target")):
                if spec.get(key) is not None:
                    if self.find(str(spec[key])) is None:
                        raise _bad(
                            f"update: '{key}' must be the id of an existing node."
                        )
                    cell.set(attr, str(spec[key]))
        if style:
            cell.set("style", style)

    def delete(self, cell_id: str) -> None:
        """Remove a node (with its connectors and anything grouped inside it) or an edge."""
        if self.find(cell_id) is None or cell_id in ("0", "1"):
            raise _bad(f"delete: no node or edge with id {cell_id!r}.")
        gone = {cell_id}
        changed = True
        while (
            changed
        ):  # children of a removed container, then connectors that lost an end
            changed = False
            for el in list(self.container):
                cell = self._cell(el)
                if el.get("id") in gone:
                    continue
                if (
                    cell.get("parent") in gone
                    or cell.get("source") in gone
                    or cell.get("target") in gone
                ):
                    gone.add(el.get("id") or "")
                    changed = True
        for el in list(self.container):
            if el.get("id") in gone:
                self.container.remove(el)

    def layout(self, direction: str = "LR") -> None:
        """Arrange the top-level nodes in layers along the edges (left to right, or top to bottom)."""
        if direction not in ("LR", "TB"):
            raise _bad("layout: direction must be LR or TB.")
        top = self._default_parent()
        nodes = [
            e
            for e in self.elements()
            if self._cell(e).get("vertex") == "1"
            and self._cell(e).get("parent") in ("1", top)
        ]
        ids = [e.get("id") or "" for e in nodes]
        links: dict[str, list[str]] = {i: [] for i in ids}
        for e in self.elements():
            c = self._cell(e)
            if (
                c.get("edge") == "1"
                and c.get("source") in links
                and c.get("target") in links
                and c.get("source") != c.get("target")
            ):
                links[c.get("source") or ""].append(c.get("target") or "")
        rank = _ranks(ids, links)
        layers: dict[int, list[str]] = {}
        for i in ids:
            layers.setdefault(rank[i], []).append(i)
        size = {}
        for e in nodes:
            g = self.geometry(e) or {"w": DEFAULT_W, "h": DEFAULT_H}
            size[e.get("id") or ""] = (g["w"], g["h"])
        horizontal = direction == "LR"
        pos: dict[str, tuple[float, float]] = {}
        spans = {
            r: sum(size[i][1 if horizontal else 0] for i in m)
            + (len(m) - 1) * (GAP_Y if horizontal else GAP_X)
            for r, m in layers.items()
        }
        widest = max(spans.values(), default=0.0)
        offset = 40.0
        for r in sorted(layers):
            members = layers[r]
            cursor = 40.0 + (widest - spans[r]) / 2
            for i in members:
                w, h = size[i]
                pos[i] = (offset, cursor) if horizontal else (cursor, offset)
                cursor += (h + GAP_Y) if horizontal else (w + GAP_X)
            step = max(size[i][0 if horizontal else 1] for i in members)
            offset += step + (GAP_X if horizontal else GAP_Y)
        for e in nodes:
            x, y = pos[e.get("id") or ""]
            g = next((c for c in self._cell(e) if _local(c.tag) == "mxGeometry"), None)
            if g is not None:
                g.set("x", _fmt(x))
                g.set("y", _fmt(y))
        for e in (
            self.elements()
        ):  # connectors are re-routed by draw.io; stale waypoints would bend them
            c = self._cell(e)
            if c.get("edge") == "1":
                for g in [g for g in c if _local(g.tag) == "mxGeometry"]:
                    for arr in [a for a in g if _local(a.tag) == "Array"]:
                        g.remove(arr)


def _ranks(ids: list[str], links: dict[str, list[str]]) -> dict[str, int]:
    """Layer of each node: its longest distance from a source; edges that close a cycle are ignored."""
    state: dict[str, int] = {}
    order: list[str] = []
    back: set[tuple[str, str]] = set()
    for start in ids:
        if start in state:
            continue
        stack = [(start, iter(links[start]))]
        state[start] = 1
        while stack:
            node, it = stack[-1]
            nxt = next(it, None)
            if nxt is None:
                state[node] = 2
                order.append(node)
                stack.pop()
            elif state.get(nxt) == 1:
                back.add((node, nxt))
            elif nxt not in state:
                state[nxt] = 1
                stack.append((nxt, iter(links[nxt])))
    rank = {i: 0 for i in ids}
    for node in reversed(order):  # reverse post-order is a topological order of the DAG
        for nxt in links[node]:
            if (node, nxt) not in back:
                rank[nxt] = max(rank[nxt], rank[node] + 1)
    return rank


# --- styles and labels -----------------------------------------------------------------------


def style_get(style: str, key: str) -> str | None:
    """Value of ``key=value`` in a draw.io style string."""
    for part in style.split(";"):
        k, _, v = part.partition("=")
        if k == key and v:
            return v
    return None


def style_set(style: str, key: str, value: str) -> str:
    """The style with ``key`` set (added or replaced)."""
    parts = [p for p in style.split(";") if p and p.partition("=")[0] != key]
    parts.append(f"{key}={value}")
    return ";".join(parts) + ";"


_COLOR = re.compile(r"^(#[0-9A-Fa-f]{3,8}|none|[a-zA-Z]{3,20})$")


def _with_colors(style: str, fill: Any, stroke: Any) -> str:
    for key, value in (("fillColor", fill), ("strokeColor", stroke)):
        if value:
            if not _COLOR.match(str(value)):
                raise _bad(f"{key[:-5]} must be a colour like '#2E6F40' or 'none'.")
            style = style_set(style, key, str(value))
    return style


def _reshape(style: str, shape: str) -> str:
    keep = [
        p
        for p in style.split(";")
        if p
        and p.partition("=")[0] not in _SHAPE_KEYS
        and p not in ("text", "ellipse", "rhombus")
    ]
    return ";".join(keep + [_VERTEX_STYLE[shape].rstrip(";")]) + ";"


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


def encode_label(text: str) -> str:
    """Plain text as the HTML label draw.io stores (the styles here all have ``html=1``)."""
    return html.escape(text, quote=False).replace("\n", "<br>")


def _num(spec: dict[str, Any], key: str, default: float) -> float:
    value = spec.get(key)
    if value is None:
        return float(default)
    try:
        number = float(value)
    except (TypeError, ValueError) as e:
        raise _bad(f"{key} must be a number.") from e
    if not math.isfinite(number) or abs(number) > 100_000:
        raise _bad(f"{key} is out of range.")
    return number


def _fmt(n: float) -> str:
    return str(int(n)) if float(n).is_integer() else f"{n:.1f}"


# --- editing entry points --------------------------------------------------------------------

_OPS = ("add_node", "add_edge", "update", "delete", "layout")


def apply_ops(source: str, ops: list[dict[str, Any]]) -> tuple[str, dict[str, Any]]:
    """Apply edit operations to a drawing's source and return ``(new_source, {added: [ids]})``.

    Raises:
        DocsError: 422 naming the operation that could not be applied (nothing is changed).
    """
    drawing = Drawing(source)
    added: list[str] = []
    for n, spec in enumerate(ops, start=1):
        if not isinstance(spec, dict) or spec.get("op") not in _OPS:
            raise _bad(f"ops[{n}]: 'op' must be one of {', '.join(_OPS)}.")
        try:
            op = spec["op"]
            if op == "add_node":
                added.append(drawing.add_node(spec))
            elif op == "add_edge":
                added.append(drawing.add_edge(spec))
            elif op == "update":
                drawing.update(spec)
            elif op == "delete":
                drawing.delete(str(spec.get("id")))
            else:
                drawing.layout(str(spec.get("direction") or "LR"))
        except DocsError as e:
            raise _bad(f"ops[{n}] ({spec['op']}): {e.message}") from e
    return drawing.to_source(), {"added": added}


def build_source(
    nodes: list[dict[str, Any]], edges: list[dict[str, Any]], direction: str = "LR"
) -> str:
    """A new drawing from nodes and edges, laid out in layers."""
    drawing = Drawing("<mxGraphModel><root/></mxGraphModel>")
    for spec in nodes:
        if not isinstance(spec, dict):
            raise _bad("Each node must be an object like {id, label, shape}.")
        if not spec.get("id"):
            raise _bad("Every node needs an 'id' so that edges can refer to it.")
        drawing.add_node({**spec, "x": spec.get("x", 0), "y": spec.get("y", 0)})
    for spec in edges:
        if not isinstance(spec, dict):
            raise _bad("Each edge must be an object like {from, to, label}.")
        drawing.add_edge(spec)
    if not any(
        s.get("x") is not None and s.get("y") is not None and (s["x"] or s["y"])
        for s in nodes
        if isinstance(s, dict)
    ):
        drawing.layout(direction)
    source = ET.tostring(drawing.model, encoding="unicode")
    return f'<mxfile><diagram name="Page-1">{source}</diagram></mxfile>'


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
