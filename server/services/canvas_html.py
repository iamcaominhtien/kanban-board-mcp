"""Reading a board's HTML: a plain-text outline (for AI and the thumbnail) and a title.

Board files are kept exactly as they were given (a board is an open web page: scripts, handlers, CDN links and
fonts all run, as when the file is opened in a browser). Nothing is stripped on the way in.
"""

import html
import re
from html.parser import HTMLParser

# Elements with no closing tag
VOID = frozenset(
    {
        "area",
        "base",
        "br",
        "col",
        "embed",
        "hr",
        "img",
        "input",
        "link",
        "meta",
        "param",
        "source",
        "track",
        "wbr",
    }
)


# --- a plain-text outline of a page, for AI and for the thumbnail ------------------------------------------------


class _Outline(HTMLParser):
    """Headings, text blocks, buttons, fields and pictures of a page in reading order."""

    HEAD = {"h1", "h2", "h3", "h4", "h5", "h6", "title"}
    BLOCK = {
        "p",
        "li",
        "label",
        "td",
        "th",
        "figcaption",
        "blockquote",
        "span",
        "div",
        "a",
        "small",
        "legend",
    }
    BUTTON = {"button"}
    FIELD = {"input", "textarea", "select"}
    PIC = {"img", "svg", "canvas", "video", "picture"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.items: list[tuple[str, str]] = []
        self.stack: list[str] = []
        self.buf: list[str] = []
        self.hidden = 0

    def _flush(self) -> None:
        text = re.sub(r"\s+", " ", "".join(self.buf)).strip()
        self.buf = []
        if not text or self.hidden:
            return
        kind = "text"
        for t in reversed(self.stack):
            if t in self.HEAD:
                kind = "head"
                break
            if t in self.BUTTON or t == "a":
                kind = "button" if t in self.BUTTON else "text"
                break
        self.items.append((kind, text))

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in ("style", "head", "title", "noscript"):
            self.hidden += 1
        if tag in self.FIELD:
            self._flush()
            kind = dict(attrs).get("type") or ""
            if kind in ("submit", "button"):
                self.items.append(("button", dict(attrs).get("value") or "Submit"))
            elif kind not in ("hidden",):
                self.items.append(("field", dict(attrs).get("placeholder") or ""))
        elif tag in self.PIC:
            self._flush()
            self.items.append(("pic", dict(attrs).get("alt") or ""))
        elif tag in self.HEAD or tag in self.BLOCK or tag in self.BUTTON:
            self._flush()
        if tag not in VOID:
            self.stack.append(tag)

    def handle_endtag(self, tag: str) -> None:
        if tag in self.HEAD or tag in self.BLOCK or tag in self.BUTTON:
            self._flush()
        if tag in ("style", "head", "title", "noscript") and self.hidden:
            self.hidden -= 1
        if tag in self.stack:
            while self.stack and self.stack.pop() != tag:
                pass

    def handle_data(self, data: str) -> None:
        self.buf.append(data)


def outline(source: str) -> list[tuple[str, str]]:
    """``[(kind, text)]`` in reading order: ``head``, ``text``, ``button``, ``field`` or ``pic``."""
    p = _Outline()
    p.feed(source)
    p.close()
    p._flush()
    return p.items


def title_of(source: str, fallback: str = "") -> str:
    """The ``<title>`` or the first heading of a page."""
    m = re.search(r"<title[^>]*>(.*?)</title>", source, re.I | re.S)
    if m and m.group(1).strip():
        return html.unescape(re.sub(r"\s+", " ", m.group(1)).strip())[:120]
    for kind, text in outline(source):
        if kind == "head":
            return text[:120]
    return fallback
