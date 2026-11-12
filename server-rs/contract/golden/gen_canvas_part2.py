"""Golden vectors for crates/kb-draw, canvases part 2: `canvas_comments`, `canvas_delivery`, `canvas_design`,
`visual_guides` and `screenshots`.

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_canvas_part2.py
Writes `canvas_part2.json` next to this file. It holds:

* `texts`: the design guide, the craft page, the draw.io and Sketch guides and their skill headers, whole;
* `examples`: name, length and SHA-256 of each design example file;
* `body`, `clean_anchor`, `snippet_of`, `plain_mentions`, `mentioned`: pure functions of `canvas_comments`;
* `note`, `page_of`: pure functions of `canvas_delivery`;
* `allowed`, `svg_size`, `quote`, `translate_path`, `served`: `screenshots` (what the hidden browser may load, and what
  the throwaway server serves, to whom).

The generator runs with its own throwaway KANBAN_* folders and never opens a database.
"""

import asyncio
import hashlib
import http.client
import json
import os
import random
import sys
import tempfile
import urllib.parse
from pathlib import Path
from types import SimpleNamespace

_tmp = tempfile.mkdtemp(prefix="kb-golden-")
os.environ["KANBAN_CONFIG_DIR"] = os.path.join(_tmp, "config")
os.environ["KANBAN_DB_PATH"] = os.path.join(_tmp, "data", "kanban.db")
os.environ["KANBAN_LOG_DIR"] = os.path.join(_tmp, "logs")
os.environ["KANBAN_UPLOADS_DIR"] = os.path.join(_tmp, "uploads")
sys.path.insert(0, os.getcwd())  # run from server/

from models import Member  # noqa: E402
from services import canvas_comments as cc  # noqa: E402
from services import canvas_delivery as cd  # noqa: E402
from services import canvas_design, docs_comments, screenshots, visual_guides  # noqa: E402
from services.docs_text import DocsError  # noqa: E402

OUT = Path(__file__).with_name("canvas_part2.json")
rng = random.Random(2102)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


out: dict = {}

# --- the texts ------------------------------------------------------------------------------------------------------
out["texts"] = {
    "skill_header": canvas_design.SKILL_HEADER,
    "guide": canvas_design.GUIDE,
    "craft": canvas_design.CRAFT,
    "drawio_header": visual_guides.DRAWIO_HEADER,
    "sketch_header": visual_guides.SKETCH_HEADER,
    "choosing": visual_guides.CHOOSING,
    "drawio": visual_guides.DRAWIO,
    "sketch": visual_guides.SKETCH,
    "diagram_guide": visual_guides.diagram_guide(),
}
out["examples"] = [
    {"name": p.name, "len": len(p.read_bytes()), "sha256": sha(p.read_bytes())}
    for p in canvas_design.examples()
]

# --- canvas_comments._body ----------------------------------------------------------------------------------------
bodies = [
    "hello",
    "  padded  ",
    "",
    "   ",
    "\n\t   ",
    "x" * 4000,
    "y" * 4001,
    "z" * 5000,
    "é" * 4005,
    "tab\tinside",
    "  　wide space　  ",
    "emoji \U0001f600 " * 400,
]
cases = []
for text in bodies:
    try:
        cases.append({"text": text, "out": cc._body(text)})  # noqa: SLF001
    except DocsError as e:
        cases.append({"text": text, "error": [e.status, e.code, e.message]})
out["body"] = cases

# --- canvas_comments.clean_anchor ---------------------------------------------------------------------------------
anchors: list = [
    None,
    "str",
    [],
    {},
    {"sel": ""},
    {"sel": "  "},
    {"sel": "  .btn  "},
    {"sel": ".a" * 400},
    {"text": "  Add   task \n now "},
    {"text": ""},
    {"text": "t" * 200},
    {"text": 5},
    {"sel": 5, "text": None},
    {"sel": "#x", "ox": 0.25, "oy": 0.75, "w": 390},
    {"sel": "#x", "ox": 2, "oy": -1},
    {"sel": "#x", "ox": "0.3", "oy": "abc"},
    {"sel": "#x", "ox": None, "oy": True},
    {"sel": "#x", "ox": " 0.4 ", "oy": "1e-1"},
    {"sel": "#x", "ox": "nan", "oy": "inf"},
    {"sel": "#x", "ox": [0.5], "oy": {"a": 1}},
    {"sel": "#x", "ox": 1e-7, "oy": 0.1234567890123},
    {"sel": "#x", "w": 100.5},
    {"sel": "#x", "w": 101.5},
    {"sel": "#x", "w": 0.5},
    {"sel": "#x", "w": 1},
    {"sel": "#x", "w": 8000},
    {"sel": "#x", "w": 8000.4},
    {"sel": "#x", "w": 8001},
    {"sel": "#x", "w": 0},
    {"sel": "#x", "w": -5},
    {"sel": "#x", "w": "390"},
    {"sel": "#x", "w": " 390.5 "},
    {"sel": "#x", "w": "wide"},
    {"sel": "#x", "w": None},
    {"sel": "#x", "w": True},
    {"sel": "#x", "w": 2.5},
    {"sel": "#x", "w": 3.5},
    {"text": "Add task", "sel": "button", "ox": 0.5, "oy": 0.5, "w": 1280, "extra": 1},
    {"sel": "élément", "text": "café \U0001f600"},
]
for _ in range(120):
    a: dict = {}
    if rng.random() < 0.7:
        a["sel"] = rng.choice(["", " ", ".x", "#id > a", "  div  ", 3, None, "s" * rng.randint(0, 600)])
    if rng.random() < 0.6:
        a["text"] = rng.choice(["", " ", "Save", " a  b\n c ", 7, None, "w " * rng.randint(0, 100)])
    for k in ("ox", "oy"):
        if rng.random() < 0.7:
            a[k] = rng.choice([0, 1, 0.5, -3, 7.25, "0.2", "x", None, False, 0.999999, 1e-9, "1_0"])
    if rng.random() < 0.7:
        a["w"] = rng.choice([0, 1, 1.4, 1.5, 2.5, 99.5, 100.5, 8000, 8000.0, 8000.5, -1, "640", "6_40", "x", None, 12345])
    anchors.append(a)
out["clean_anchor"] = [
    {"raw": a, "out": (json.dumps(cc.clean_anchor(a)) if cc.clean_anchor(a) is not None else None)} for a in anchors
]

# --- docs_comments.plain_mentions and snippet_of (canvas_comments imports snippet_of) ------------------------------------
frags = [
    "hello ",
    "@[Ann Lee](member:m1) ",
    "@[Bob](member:b-2) ",
    "![shot](/uploads/a.png) ",
    "![](/uploads/b.png) ",
    "![d](diagram:dg_1) ",
    "[doc](/docs/p) ",
    "[a diagram](diagram:dg_2) ",
    "!\\[not](x) ",
    "[nested [brackets]](url) ",
    "![alt [x]](u) ",
    "!!![x](y) ",
    "[x](y z) ",
    "[x]() ",
    "[](u) ",
    "\n",
    "  \t ",
    "éè ",
    "\U0001f600 ",
    "@Name ",
    "@[bad name](member:) ",
    "@[Dot](member:a.b) ",
    "long " * 20,
    "(parens) ",
    "[a](b)(c) ",
    "![a](b)[c](d) ",
    "[x](http://e.com/a(b)) ",
]
texts = [
    "",
    "plain",
    "@[Ann Lee](member:m1) please look",
    "see ![shot](/u/a.png) and [docs](/d)",
    "![a](diagram:dg_1)",
    "[x](diagram:dg_2) y",
    "! [x](y)",
    "![x](y)[z](w)",
    "x" * 300,
    "word " * 100,
    "@[A](member:x)" * 60,
]
for _ in range(220):
    texts.append("".join(rng.choice(frags) for _ in range(rng.randint(1, 9))))
out["plain_mentions"] = [{"text": t, "out": docs_comments.plain_mentions(t)} for t in texts]
out["snippet_of"] = [{"text": t, "out": docs_comments.snippet_of(t)} for t in texts]

# --- canvas_comments._mentioned (the pure part: members and a text) ----------------------------------------------------


class _Rows:
    def __init__(self, rows):
        self.rows = rows

    def all(self):
        return self.rows


class _FakeSession:
    def __init__(self, rows):
        self.rows = rows

    async def exec(self, _statement):
        return _Rows(self.rows)


member_sets = [
    [("m1", "Ann"), ("m2", "Ann Lee"), ("m3", "Bob")],
    [("m1", "Hoa"), ("m2", "hoa tran"), ("m3", "Q")],
    [("m1", "Ann"), ("m2", "Bob Stone"), ("m3", "Cho"), ("m4", "Cho Lin")],
    [("a.b", "Dot.Name"), ("m2", "x+y"), ("m3", "(Paren)"), ("m4", "café"), ("m5", "Émile")],
    [("m1", "An"), ("m2", "Anna"), ("m3", "Annabel")],
]
mention_texts = [
    "",
    "no at sign",
    "@Ann",
    "@ann hello",
    "hi @Ann Lee and @Bob",
    "@[Ann Lee](member:m2) only",
    "@[Ann Lee](member:m2) and @Ann",
    "@[Bob](member:m3), @Bob, @bob",
    "mail a@Ann and @@Ann and @Annabel and @Ann_x and @Ann.",
    "(@Ann) [@Bob] \"@Cho\"",
    "@Cho Lin and @Cho",
    "@[x](member:unknown) @[y](member:m1)",
    "@[Dot.Name](member:a.b) @Dot.Name @dot.name!",
    "@x+y @(Paren) @café @CAFÉ @émile @ÉMILE",
    "@An @Anna @Annabel",
    "@Annabel @Anna @An",
    "line\n@Ann\n@Bob\n",
    "@Hoa tran, @HOA",
    "@Q! @q? @Qx",
    "é@Ann é @Anné",
    "@[Ann Lee](member:m2)@Ann",
    "@Ann@Ann @Ann @Ann",
    "@ ann",
    "@[nope(member:m1)",
]
cases = []
for members in member_sets:
    rows = [Member(id=i, project_id="p", name=n) for i, n in members]
    for text in mention_texts:
        found = asyncio.run(cc._mentioned(_FakeSession(rows), SimpleNamespace(project_id="p"), text))  # noqa: SLF001
        cases.append({"members": members, "text": text, "ids": [m.id for m in found]})
out["mentioned"] = cases

# --- canvas_delivery._page_of and _note ----------------------------------------------------------------------------------
pages = []
for page_id in (None, "", "pg1"):
    for kind in ("doc", "page", "ticket", "idea", "comment"):
        for owner in ("o1", ""):
            canvas = SimpleNamespace(page_id=page_id, owner_kind=kind, owner_id=owner)
            pages.append({"page_id": page_id, "owner_kind": kind, "owner_id": owner, "out": cd._page_of(canvas)})  # noqa: SLF001
out["page_of"] = pages
notes = []
for title in ("Login redesign", "Say “hi”", "éè \U0001f600", ""):
    for thread in ({"id": "t1", "board_id": "b_1"}, {"id": "t2", "board_id": None}, {"id": "t3"}):
        for text in (
            "plain",
            "@[Ann Lee](member:m1) look",
            "mail a@b.c and @Bob and x@@y and @@z",
            "@ alone @1 @_x @é",
            "",
        ):
            for by in ("user", "You", "ME", "Hoa", "Émile"):
                canvas = SimpleNamespace(title=title, id="cv_12345678")
                notes.append(
                    {
                        "title": title,
                        "thread": thread,
                        "body": text,
                        "by": by,
                        "out": cd._note(canvas, thread, {"body": text}, by),  # noqa: SLF001
                    }
                )
rng.shuffle(notes)
out["note"] = notes[:200]

# --- screenshots.allowed --------------------------------------------------------------------------------------------------
ORIGIN = "http://127.0.0.1:5123"
urls = [
    f"{ORIGIN}/tokens.css",
    f"{ORIGIN}",
    f"{ORIGIN}/a/b?c=d#e",
    "http://127.0.0.1:5124/x",
    "http://127.0.0.1/x",
    "https://127.0.0.1:5123/x",
    "HTTP://127.0.0.1:5123/x",
    "http://127.0.0.1:5123@evil.com/",
    "http://127.0.0.1:5123.evil.com/",
    "http://user:pw@127.0.0.1:5123/x",
    "https://fonts.googleapis.com/css2",
    "https://cdn.jsdelivr.net/npm/x@1/y.js",
    "http://example.com/",
    "http://EXAMPLE.com:8080/p",
    "http://localhost/",
    "http://LOCALHOST:3000/",
    "http://localhost./",
    "http://a.localhost/",
    "http://x.local/",
    "http://nas.local:8080/",
    "http://svc.internal/",
    "http://svc.INTERNAL/",
    "http://mylocal/",
    "http://notlocalhost/",
    "file:///etc/passwd",
    "ftp://example.com/",
    "ws://example.com/",
    "wss://example.com/",
    "javascript:alert(1)",
    "data:image/png;base64,AA",
    "DATA:text/plain,x",
    "blob:http://127.0.0.1:5123/uuid",
    "about:blank",
    "about:srcdoc",
    "chrome://version",
    "chrome-extension://abc/x",
    "//example.com/x",
    "/relative",
    "relative",
    "",
    "http:///x",
    "http://",
    "http:example.com",
    "https:/example.com",
    "http://[::1]:8010/",
    "http://[::1]/",
    "http://[::]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:8.8.8.8]/",
    "http://[2001:4860:4860::8888]/",
    "http://[2001:db8::1]/",
    "http://[2002::1]/",
    "http://[fc00::1]/",
    "http://[fd12:3456::1]/",
    "http://[fe80::1]/",
    "http://[fe80::1%25eth0]/",
    "http://[64:ff9b::808:808]/",
    "http://[64:ff9b:1::1]/",
    "http://[100::1]/",
    "http://[2001::1]/",
    "http://[2001:1::1]/",
    "http://[2001:1::2]/",
    "http://[2001:1::3]/",
    "http://[2001:3::1]/",
    "http://[2001:4:112::1]/",
    "http://[2001:20::1]/",
    "http://[2001:30::1]/",
    "http://[2001:200::1]/",
    "http://[2606:4700::1111]/",
    "http://[::2]/",
    "http://127.0.0.1/",
    "http://127.255.255.254/",
    "http://0.0.0.0/",
    "http://0.1.2.3/",
    "http://10.0.0.1/",
    "http://10.255.255.255/",
    "http://11.0.0.1/",
    "http://100.63.255.255/",
    "http://100.64.0.1/",
    "http://100.127.255.255/",
    "http://100.128.0.1/",
    "http://169.254.169.254/",
    "http://169.253.0.1/",
    "http://172.15.0.1/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://172.32.0.1/",
    "http://192.0.0.1/",
    "http://192.0.0.7/",
    "http://192.0.0.8/",
    "http://192.0.0.9/",
    "http://192.0.0.10/",
    "http://192.0.0.11/",
    "http://192.0.0.170/",
    "http://192.0.0.171/",
    "http://192.0.0.172/",
    "http://192.0.1.1/",
    "http://192.0.2.1/",
    "http://192.88.99.1/",
    "http://192.168.1.10/",
    "http://192.169.0.1/",
    "http://198.17.255.255/",
    "http://198.18.0.1/",
    "http://198.19.255.255/",
    "http://198.20.0.1/",
    "http://198.51.100.7/",
    "http://203.0.113.9/",
    "http://203.0.114.9/",
    "http://224.0.0.1/",
    "http://239.255.255.250/",
    "http://240.0.0.1/",
    "http://255.255.255.254/",
    "http://255.255.255.255/",
    "http://8.8.8.8/",
    "http://1.1.1.1:443/",
    "http://93.184.216.34/",
    "http://2130706433/",
    "http://0x7f.0.0.1/",
    "http://127.1/",
    "http://127.000.000.001/",
    "http://017700000001/",
    "http://1.2.3/",
    "http://1.2.3.4.5/",
    "http://256.1.1.1/",
    "http://example.com:99999/",
    "http://example.com:abc/",
    "http://exa mple.com/",
    "http://user@example.com/",
    "http://@example.com/",
    "http://example.com@127.0.0.1/",
    "http://éxample.com/",
    "http://xn--xample-9ua.com/",
    "\thttp://example.com/",
    " http://example.com/",
    "http://exam\nple.com/",
    "http://127.0.0.1\t:5123/x",
    "HtTpS://Example.COM/",
]
cases = []
for u in urls:
    try:
        cases.append({"url": u, "origin": ORIGIN, "out": screenshots.allowed(u, ORIGIN)})
    except Exception as e:  # urlsplit refuses it: the browser's reader would stop; the Rust port blocks the request
        cases.append({"url": u, "origin": ORIGIN, "raises": type(e).__name__})
out["allowed"] = cases

# --- screenshots._svg_size and urllib.parse.quote -------------------------------------------------------------------------
svgs = [
    '<svg width="100" height="50"></svg>',
    '<svg width="100px" height="50px"></svg>',
    '<svg width="100.4" height="50.5"></svg>',
    '<svg width="100.5" height="50.5"></svg>',
    '<svg width="101.5" height="2.5"></svg>',
    '<svg viewBox="0 0 640 480"></svg>',
    '<svg viewBox="10 -20 640.5 480.5"></svg>',
    '<svg width="100" viewBox="0 0 640 480"></svg>',
    '<svg width="0" height="0" viewBox="0 0 640 480"></svg>',
    '<svg width="50%" height="50%" viewBox="0 0 300 200"></svg>',
    '<svg height="70"></svg>',
    "<svg></svg>",
    "",
    '<svg width="0" height="0"></svg>',
    '<svg width="0.2" height="0.2"></svg>',
    '<svg stroke-width="3" width="100" height="60"></svg>',
    '<svg><g stroke-width="3"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" ' + 'a="x" ' * 400 + 'width="100" height="60"></svg>',
    '<svg width="100" height="60" viewBox="0 0 1 1"></svg>',
    '<svg viewBox="0 0 0 0" width="9"></svg>',
]
out["svg_size"] = [{"svg": s, "out": list(screenshots._svg_size(s))} for s in svgs]  # noqa: SLF001
entries = [
    "index.html",
    "a b.html",
    "dir/page.html",
    "café.html",
    "a+b&c=d?e#f.html",
    "x~y_z-w.html",
    "100%.html",
    "日本語/ページ.html",
    "q'uote\"s.html",
    "",
    "/abs",
    "a\\b",
]
out["quote"] = [{"text": e, "out": urllib.parse.quote(e)} for e in entries]

# --- the throwaway server -----------------------------------------------------------------------------------------------------
root = Path(tempfile.mkdtemp(prefix="kb-serve-"))
site, outside = root / "site", root / "outside"
(site / "sub").mkdir(parents=True)
(site / "empty").mkdir()
(site / "noindex").mkdir()
(site / "withindex").mkdir()
outside.mkdir()
(site / "index.html").write_text("<h1>home</h1>")
(site / "page.css").write_text("body{}")
(site / "data.json").write_text("{}")
(site / "pic.png").write_bytes(b"\x89PNG\r\n\x1a\n")
(site / "a b.txt").write_text("spaced")
(site / "sub" / "b.txt").write_text("b")
(site / "noindex" / "z.txt").write_text("z")
(site / "noindex" / "A.txt").write_text("a")
(site / "withindex" / "index.htm").write_text("<p>htm</p>")
(outside / "secret.txt").write_text("secret")
os.symlink(outside, site / "link_out")
os.symlink(site / "sub", site / "link_in")
os.symlink(outside / "secret.txt", site / "file_out")
handler = object.__new__(screenshots._OneFolder)  # noqa: SLF001
handler.directory = str(site)
paths = [
    "/",
    "/index.html",
    "/page.css",
    "/data.json",
    "/pic.png",
    "/a%20b.txt",
    "/sub",
    "/sub/",
    "/sub/b.txt",
    "/sub/../index.html",
    "/sub/../../outside/secret.txt",
    "/../outside/secret.txt",
    "/%2e%2e/outside/secret.txt",
    "/%2e%2e%2foutside/secret.txt",
    "/..%2foutside/secret.txt",
    "/sub/%2e%2e/%2e%2e/outside/secret.txt",
    "//outside/secret.txt",
    "/./index.html",
    "/link_out/secret.txt",
    "/link_out",
    "/link_out/",
    "/file_out",
    "/link_in/b.txt",
    "/link_in",
    "/missing.txt",
    "/index.html/",
    "/index.html?x=1#f",
    "/sub?x=1",
    "/empty/",
    "/empty",
    "/noindex/",
    "/withindex/",
    "/withindex",
    "/etc/passwd",
    "/%00",
    "/a%zzb",
]
out["translate_path"] = []
for p in paths:
    try:
        full = handler.translate_path(p)
        shown = "__outside__" if full.endswith("__outside__") else os.path.relpath(full, site) + ("/" if full.endswith("/") else "")
        out["translate_path"].append({"path": p, "inside": shown})
    except Exception as e:
        out["translate_path"].append({"path": p, "raises": type(e).__name__})


def fetch(port, method, path):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request(method, path)
    r = conn.getresponse()
    body = r.read()
    res = {
        "method": method,
        "path": path,
        "status": r.status,
        "content_type": r.getheader("Content-Type"),
        "location": r.getheader("Location"),
        "len": len(body),
        "sha256": sha(body),
    }
    conn.close()
    return res


served = []
with screenshots._Serve(site) as s:  # noqa: SLF001
    port = s.httpd.server_address[1]
    for p in paths:
        if "%00" in p:
            continue
        try:
            served.append(fetch(port, "GET", p))
        except Exception as e:
            served.append({"method": "GET", "path": p, "raises": type(e).__name__})
    for p in ("/", "/index.html", "/sub/b.txt", "/missing", "/link_out/secret.txt"):
        served.append(fetch(port, "HEAD", p))
    for m in ("POST", "PUT", "DELETE", "OPTIONS", "PATCH"):
        try:
            served.append(fetch(port, m, "/index.html"))
        except Exception as e:
            served.append({"method": m, "path": "/index.html", "raises": type(e).__name__})
    out["bound_to"] = s.httpd.server_address[0]
out["served"] = served

text = json.dumps(out, ensure_ascii=False, indent=1)
OUT.write_text(text, encoding="utf-8")
print(f"wrote {OUT} ({len(text) / 1e6:.2f} MB)")
