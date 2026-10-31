"""Small pictures made without an image library: the snapshot of an HTML board and the overview of a canvas.

A board below 40% zoom shows a picture of its last saved state, and a text export writes the canvas's overview as a
PNG. There is no browser on the server, so the pictures are *wireframes* drawn from the page's outline (headings,
text, buttons, fields, pictures) and from the plane (boards, notes). They are honest placeholders, not screenshots.
"""

import struct
import zlib
from typing import Any

from services import canvas_html

Color = tuple[int, int, int]

INK: Color = (30, 42, 34)
GREY: Color = (230, 236, 232)
MID: Color = (190, 201, 194)
GREEN: Color = (46, 111, 64)
PAPER: Color = (244, 246, 244)
WHITE: Color = (255, 255, 255)
PLANE: Color = (243, 245, 243)
DOT: Color = (211, 219, 214)
BORDER: Color = (208, 217, 211)
NOTE_COLORS: dict[str, Color] = {
    "yellow": (255, 243, 184),
    "green": (227, 243, 231),
    "blue": (221, 236, 250),
    "pink": (252, 226, 233),
    "purple": (239, 232, 251),
    "grey": (232, 236, 233),
}


class Raster:
    """An RGB picture you can fill rectangles in, and write as a PNG."""

    def __init__(self, width: int, height: int, background: Color = WHITE) -> None:
        """Make a picture of one colour."""
        self.w, self.h = max(1, width), max(1, height)
        row = bytes(background) * self.w
        self.rows = [bytearray(row) for _ in range(self.h)]

    def rect(self, x: float, y: float, w: float, h: float, color: Color) -> None:
        """Fill a rectangle (clipped to the picture)."""
        x0, y0 = max(0, int(round(x))), max(0, int(round(y)))
        x1, y1 = min(self.w, int(round(x + w))), min(self.h, int(round(y + h)))
        if x1 <= x0 or y1 <= y0:
            return
        chunk = bytes(color) * (x1 - x0)
        for yy in range(y0, y1):
            self.rows[yy][x0 * 3 : x1 * 3] = chunk

    def frame(
        self, x: float, y: float, w: float, h: float, color: Color, t: int = 1
    ) -> None:
        """Draw a rectangle's outline."""
        self.rect(x, y, w, t, color)
        self.rect(x, y + h - t, w, t, color)
        self.rect(x, y, t, h, color)
        self.rect(x + w - t, y, t, h, color)

    def png(self) -> bytes:
        """The picture as PNG bytes."""

        def chunk(kind: bytes, data: bytes) -> bytes:
            body = kind + data
            return (
                struct.pack(">I", len(data))
                + body
                + struct.pack(">I", zlib.crc32(body))
            )

        raw = b"".join(b"\x00" + bytes(r) for r in self.rows)
        return (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", self.w, self.h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6))
            + chunk(b"IEND", b"")
        )


def board_snapshot(
    html_text: str | None, width: int, height: int, *, max_side: int = 360
) -> bytes:
    """A wireframe of an HTML board (a grey page, with bars for text and boxes for buttons, fields and pictures).

    Args:
        html_text: The cleaned page, or None for an empty board.
        width: Board width in plane units.
        height: Board height in plane units.
        max_side: Longest side of the picture in pixels.

    Returns:
        PNG bytes.
    """
    scale = min(1.0, max_side / max(width, height, 1))
    w, h = max(40, int(width * scale)), max(30, int(height * scale))
    r = Raster(w, h, PAPER)
    r.rect(
        0, 0, w, max(6, h * 0.07), INK
    )  # a top bar, as in the design's board thumbnails
    r.rect(6, 2, w * 0.14, 2, (123, 211, 154))
    items = canvas_html.outline(html_text) if html_text else []
    pad = max(8, w * 0.12)
    y = max(6, h * 0.07) + pad * 0.7
    if items:
        card_x, card_w = pad, w - 2 * pad
        r.rect(card_x - 3, y - 4, card_w + 6, h - y - 2, WHITE)
        r.frame(card_x - 3, y - 4, card_w + 6, h - y - 2, GREY)
        for kind, text in items[:40]:
            if y > h - 10:
                break
            if kind == "head":
                r.rect(
                    card_x,
                    y,
                    min(card_w, 14 + len(text) * 3.2 * scale * 2),
                    max(3, h * 0.035),
                    INK,
                )
                y += max(3, h * 0.035) + 5
            elif kind == "button":
                r.rect(
                    card_x,
                    y,
                    min(card_w, 28 + len(text) * 3.0 * scale * 2),
                    max(5, h * 0.05),
                    GREEN,
                )
                y += max(5, h * 0.05) + 5
            elif kind == "field":
                r.rect(card_x, y, card_w, max(5, h * 0.045), GREY)
                y += max(5, h * 0.045) + 4
            elif kind == "pic":
                bh = max(12, h * 0.16)
                r.rect(card_x, y, card_w, bh, GREY)
                r.frame(card_x, y, card_w, bh, MID)
                y += bh + 5
            else:
                bar = max(2, h * 0.02)
                r.rect(
                    card_x, y, min(card_w, 10 + len(text) * 2.4 * scale * 2), bar, MID
                )
                y += bar + 3.5
    else:
        r.rect(pad, h * 0.4, w - 2 * pad, 3, MID)
    return r.png()


def overview(
    doc: dict[str, Any], page: str | None = None, *, max_side: int = 1200
) -> bytes:
    """A wireframe of one page tab of a canvas: the boards as framed pages, the notes as small coloured squares.

    Args:
        doc: The canvas file.
        page: The page tab to draw (the first when omitted).
        max_side: Longest side of the picture in pixels.

    Returns:
        PNG bytes.
    """
    pages = doc.get("pages") or []
    page = page or (pages[0]["id"] if pages else None)
    boards = [b for b in doc.get("boards", []) if b.get("page") == page]
    notes = [n for n in doc.get("notes", []) if n.get("page") == page]
    labels = [t for t in doc.get("labels", []) if t.get("page") == page]
    xs = [b["x"] for b in boards] + [n["x"] for n in notes] + [t["x"] for t in labels]
    ys = [b["y"] for b in boards] + [n["y"] for n in notes] + [t["y"] for t in labels]
    x1 = [b["x"] + b["w"] for b in boards] + [n["x"] + n.get("w", 160) for n in notes]
    y1 = [b["y"] + b["h"] for b in boards] + [n["y"] + n.get("h", 100) for n in notes]
    if not xs:
        return Raster(max_side // 2, max_side // 3, PLANE).png()
    margin = 40
    left, top = min(xs) - margin, min(ys) - margin
    width = max(x1 + [x + 80 for x in xs]) + margin - left
    height = max(y1 + [y + 30 for y in ys]) + margin - top
    scale = min(1.0, max_side / max(width, height))
    r = Raster(max(60, int(width * scale)), max(40, int(height * scale)), PLANE)
    for b in boards:
        bx, by = (b["x"] - left) * scale, (b["y"] - top) * scale
        bw, bh = b["w"] * scale, b["h"] * scale
        r.rect(bx + 2, by + 3, bw, bh, (226, 231, 228))
        r.rect(bx, by, bw, bh, WHITE)
        r.rect(bx, by, bw, max(3.0, bh * 0.07), INK)
        r.rect(bx + bw * 0.12, by + bh * 0.3, bw * 0.76, max(2.0, bh * 0.06), GREY)
        r.rect(bx + bw * 0.12, by + bh * 0.45, bw * 0.76, max(2.0, bh * 0.06), GREY)
        r.rect(bx + bw * 0.12, by + bh * 0.62, bw * 0.4, max(3.0, bh * 0.08), GREEN)
        r.frame(bx, by, bw, bh, BORDER)
    for n in notes:
        r.rect(
            (n["x"] - left) * scale,
            (n["y"] - top) * scale,
            n.get("w", 160) * scale,
            n.get("h", 100) * scale,
            NOTE_COLORS.get(n.get("color", "yellow"), NOTE_COLORS["yellow"]),
        )
    for t in labels:
        r.rect(
            (t["x"] - left) * scale,
            (t["y"] - top) * scale,
            max(10.0, len(t.get("text", "")) * 9 * scale),
            max(3.0, 14 * scale),
            INK,
        )
    return r.png()
