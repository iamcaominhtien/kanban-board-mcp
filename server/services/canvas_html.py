"""Locked HTML for canvas boards: nothing in a board may run a script or reach outside the board's own folder.

Boards are shown in a sandboxed frame with a strict ``Content-Security-Policy`` (see ``api/canvases.py``), so this is the
second line of defence: the saved files are cleaned, and what was left out is listed so a missing font or chart is
explained ("3 blocked: 1 script, 2 requests to cdn.example.com"). The same cleaning runs on every HTML and CSS file a
board holds, whoever supplied it (a person, an upload, a ZIP, an AI proposal).
"""

import html
import re
from collections import Counter
from html.parser import HTMLParser
from urllib.parse import urlsplit

# Elements removed with everything inside them
DROP_WITH_CONTENT = frozenset(
    {
        "script",
        "iframe",
        "frame",
        "frameset",
        "object",
        "embed",
        "applet",
        "base",
        "portal",
    }
)
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
URL_ATTRS = frozenset(
    {
        "src",
        "href",
        "poster",
        "action",
        "formaction",
        "data",
        "xlink:href",
        "background",
        "cite",
        "longdesc",
        "manifest",
    }
)
SAFE_DATA = re.compile(r"^data:image/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]", re.I)
SAFE_FONT_DATA = re.compile(
    r"^data:(font/|application/(font|x-font|vnd\.ms-fontobject))", re.I
)

_CSS_URL = re.compile(r"url\(\s*(?P<q>['\"]?)(?P<u>.*?)(?P=q)\s*\)", re.I | re.S)
_CSS_IMPORT = re.compile(r"@import\s+[^;]+;?", re.I)
_CSS_BAD = re.compile(r"(expression\s*\(|behavior\s*:|-moz-binding\s*:)", re.I)


class Blocked:
    """What a cleaning left out, counted: scripts, event handlers, other active content, requests by host."""

    def __init__(self) -> None:
        """Start with nothing counted."""
        self.script = 0
        self.handler = 0
        self.active = 0  # frames, objects, embeds
        self.requests: Counter[str] = Counter()

    def request(self, url: str) -> None:
        """Count a request to somewhere outside the board."""
        self.requests[_host(url)] += 1

    def merge(self, other: "Blocked") -> None:
        """Add another file's counts."""
        self.script += other.script
        self.handler += other.handler
        self.active += other.active
        self.requests.update(other.requests)

    def total(self) -> int:
        """How many things were left out."""
        return self.script + self.handler + self.active + sum(self.requests.values())

    def as_list(self) -> list[dict]:
        """``[{kind, count, host?}]`` for the chip on the board."""
        out: list[dict] = []
        if self.script:
            out.append({"kind": "script", "count": self.script})
        if self.handler:
            out.append({"kind": "handler", "count": self.handler})
        if self.active:
            out.append({"kind": "active", "count": self.active})
        out += [
            {"kind": "request", "count": n, "host": h}
            for h, n in sorted(self.requests.items())
        ]
        return out


def _host(url: str) -> str:
    u = url.strip()
    try:
        host = urlsplit("//" + u.split("://", 1)[1] if "://" in u else u).hostname
    except ValueError:
        host = None
    return host or "an outside address"


def is_local(url: str) -> bool:
    """A reference that stays inside the board: a relative path, a fragment, or a picture/font embedded as data."""
    u = url.strip()
    if not u:
        return True
    if u.startswith("#"):
        return True
    if SAFE_DATA.match(u) or SAFE_FONT_DATA.match(u):
        return True
    if u.startswith("//") or u.startswith("\\\\"):
        return False
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.\-]*:", u):
        return False  # http:, https:, javascript:, data:text/html, ftp:, file: ...
    return ".." not in u.replace("\\", "/").split("/")


def clean_css(css: str, blocked: Blocked) -> str:
    """Remove ``@import``, outside ``url(...)`` and old IE script hooks from a stylesheet."""

    def imp(m: re.Match[str]) -> str:
        blocked.request(m.group(0))
        return ""

    def url(m: re.Match[str]) -> str:
        if is_local(m.group("u")):
            return m.group(0)
        blocked.request(m.group("u"))
        return "url()"

    css = _CSS_IMPORT.sub(imp, css)
    css = _CSS_URL.sub(url, css)
    if _CSS_BAD.search(css):
        blocked.script += len(_CSS_BAD.findall(css))
        css = _CSS_BAD.sub("/* removed */", css)
    return css


def _clean_srcset(value: str, blocked: Blocked) -> str:
    keep = []
    for part in value.split(","):
        bits = part.strip().split()
        if not bits:
            continue
        if is_local(bits[0]):
            keep.append(part.strip())
        else:
            blocked.request(bits[0])
    return ", ".join(keep)


class _Cleaner(HTMLParser):
    def __init__(self, blocked: Blocked) -> None:
        super().__init__(convert_charrefs=False)
        self.blocked = blocked
        self.out: list[str] = []
        self.skip: str | None = None
        self.skip_depth = 0
        self.style: list[str] | None = None

    def _attrs(self, tag: str, attrs: list[tuple[str, str | None]]) -> str:
        parts = []
        for name, value in attrs:
            n = name.lower()
            v = value if value is not None else ""
            if n.startswith("on"):
                self.blocked.handler += 1
                continue
            if n == "srcset":
                v = _clean_srcset(v, self.blocked)
                if not v:
                    continue
            elif n in URL_ATTRS:
                if not is_local(v):
                    # a link to elsewhere stays a harmless anchor; a resource is simply left out
                    self.blocked.request(v)
                    if n == "href" and tag == "a":
                        parts.append('href="#"')
                    continue
            elif n == "style":
                v = clean_css(v, self.blocked)
            elif n == "http-equiv":
                continue
            parts.append(
                f'{name}="{html.escape(v, quote=True)}"' if value is not None else name
            )
        return (" " + " ".join(parts)) if parts else ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if self.skip:
            if tag == self.skip:
                self.skip_depth += 1
            return
        if tag in DROP_WITH_CONTENT:
            if tag == "script":
                self.blocked.script += 1
            else:
                self.blocked.active += 1
            if tag not in VOID:
                self.skip, self.skip_depth = tag, 1
            return
        if tag == "meta" and any(
            k.lower() == "http-equiv"
            and (v or "").lower()
            in ("refresh", "set-cookie", "content-security-policy")
            for k, v in attrs
        ):
            return
        if tag == "link":
            rel = next((v or "" for k, v in attrs if k.lower() == "rel"), "").lower()
            href = next((v or "" for k, v in attrs if k.lower() == "href"), "")
            if not is_local(href) or rel not in (
                "stylesheet",
                "icon",
                "shortcut icon",
                "",
            ):
                if href and not is_local(href):
                    self.blocked.request(href)
                return
        if tag == "style":
            self.style = []
        self.out.append(f"<{tag}{self._attrs(tag, attrs)}>")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if self.skip:
            return
        if tag in DROP_WITH_CONTENT:
            self.handle_starttag(tag, attrs)
            if self.skip == tag:
                self.skip = None
            return
        self.handle_starttag(tag, attrs)
        if tag not in VOID and self.out and self.out[-1].startswith(f"<{tag}"):
            self.out.append(f"</{tag}>")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self.skip:
            if tag == self.skip:
                self.skip_depth -= 1
                if self.skip_depth == 0:
                    self.skip = None
            return
        if tag == "style" and self.style is not None:
            self.out.append(clean_css("".join(self.style), self.blocked))
            self.style = None
        if tag in VOID:
            return
        self.out.append(f"</{tag}>")

    def handle_data(self, data: str) -> None:
        if self.skip:
            return
        if self.style is not None:
            self.style.append(data)
        else:
            self.out.append(data)

    def handle_entityref(self, name: str) -> None:
        if not self.skip:
            (self.style if self.style is not None else self.out).append(f"&{name};")

    def handle_charref(self, name: str) -> None:
        if not self.skip:
            (self.style if self.style is not None else self.out).append(f"&#{name};")

    def handle_decl(self, decl: str) -> None:
        if not self.skip and decl.lower().startswith("doctype"):
            self.out.append(f"<!{decl}>")

    def handle_comment(self, data: str) -> None:  # comments can hide conditional code
        return

    def handle_pi(self, data: str) -> None:
        return


def clean_html(source: str) -> tuple[str, Blocked]:
    """Clean an HTML document.

    Args:
        source: The page as written.

    Returns:
        ``(clean html, what was left out)``.
    """
    blocked = Blocked()
    parser = _Cleaner(blocked)
    parser.feed(source)
    parser.close()
    if parser.style is not None:
        parser.out.append(clean_css("".join(parser.style), blocked))
    return "".join(parser.out), blocked


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
