"""Golden vectors for crates/kb-draw `canvases`: the pure helpers of `services/canvases.py` (numbers and text of an
item, the cleaned fields of a board, note, label and arrow, safe paths, picture sizes, the file checks of an HTML
frame, the diff of two canvas files, the line diff of a source, the free spot of a new frame).

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_canvases.py
Writes `canvases.json` next to this file. The generator runs with its own throwaway KANBAN_* folders.
"""

import base64
import copy
import json
import os
import random
import struct
import sys
import tempfile
from pathlib import Path

_tmp = tempfile.mkdtemp(prefix="kb-golden-")
os.environ["KANBAN_CONFIG_DIR"] = os.path.join(_tmp, "config")
os.environ["KANBAN_DB_PATH"] = os.path.join(_tmp, "data", "kanban.db")
os.environ["KANBAN_LOG_DIR"] = os.path.join(_tmp, "logs")
os.environ["KANBAN_UPLOADS_DIR"] = os.path.join(_tmp, "uploads")
sys.path.insert(0, os.getcwd())  # run from server/

import difflib  # noqa: E402

from services import canvases as cv  # noqa: E402
from services.docs_text import DocsError  # noqa: E402

OUT = Path(__file__).with_name("canvases.json")
rng = random.Random(277)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def run(fn):
    try:
        return {"ok": fn()}
    except DocsError as e:
        return {"error": {"status": e.status, "code": e.code, "message": e.message, "extra": e.extra}}


VALUES = [None, True, False, 0, 1, -1, 5, 80, 320, 1920, 1921, 100000, 100001, -100001, 3.5, -0.5, 1e9, 1e300, 0.1, 319.9,
          "12", " 7.5 ", "1e3", "nan", "inf", "-inf", "Infinity", "1_000", "_1", "1__0", "abc", "", "0x10", "٣", [], [1], {}, {"a": 1},
          float("nan") if False else 0.0, 2.5, 3.5, 1280, 1280.0, 800.0, "\n 5 \t", "+5", "-5", ".5", "5.", "1e", "1e-2"]

nums = []
for v in VALUES:
    for default in (0, 160, 20, 1280.0, None):
        for lo, hi in ((-100000, 100000), (320, 1920), (80, 600), (10, 96), (-1, 100000), (0, 1000)):
            nums.append({"value": v, "default": default, "lo": lo, "hi": hi, **run(lambda: cv._num(v, default, lo, hi))})

TEXTS = [None, "", "abc", "a\x00b\x07c\x08d\te\nf\x0bg\x0ch\ri\x0ej\x1fk", 0, 5, 5.5, True, False, [], [1, "a"], {"a": [1]},
         {"k": None}, "x" * 300, "é" * 300, "\U0001f600" * 150, " padded ", 1e22, 1e-7, -0.0]
texts = [{"value": v, "limit": n, "out": cv._text(v, n)} for v in TEXTS for n in (0, 5, 40, 200, 1000)]

RAW_PATHS = ["index.html", "a/b.css", "/abs.html", "\\win\\path.html", "../up.html", "a/../b", "a//b", "a/./b", "", " ", "  x  ",
             "x" * 240, "x" * 241, "a\x01b", "a\tb", "é.html", "dir/", "/", "//x", ".", "..", "...", ".hidden", "a b.html",
             "\u201cq\u201d.html", "a\\b\\c.css", " /lead.html", "tail.html ", "\u00a0nb.html", "C:\\x.html", "a/b/../../c"]
paths = [{"raw": p, **run(lambda: cv.safe_path(p))} for p in RAW_PATHS]


def png_hdr(w, h):
    return b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", w, h) + b"\x08\x06\x00\x00\x00"


def jpeg(w, h, extra=b""):
    return b"\xff\xd8\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00" + extra + \
        b"\xff\xc0" + struct.pack(">H", 17) + b"\x08" + struct.pack(">HH", h, w) + b"\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01" + b"\x00" * 12


def webp(kind, w, h):
    body = b""
    if kind == b"VP8X":
        body = b"\x00\x00\x00\x00" + (w - 1).to_bytes(3, "little") + (h - 1).to_bytes(3, "little")
    elif kind == b"VP8 ":
        body = b"\x00\x00\x00\x9d\x01\x2a" + struct.pack("<HH", w, h)
    else:
        bits = (w - 1) | ((h - 1) << 14)
        body = b"\x2f" + bits.to_bytes(4, "little") + b"\x00" * 4
    return b"RIFF" + struct.pack("<I", 4 + 8 + len(body)) + b"WEBP" + kind + struct.pack("<I", len(body)) + body


SAMPLES = [
    b"", b"x", png_hdr(800, 600), png_hdr(1, 1), png_hdr(0, 0), b"\x89PNG", b"\x89PNG\r\n\x1a\n" + b"\x00" * 10,
    b"GIF89a" + struct.pack("<HH", 64, 32), b"GIF87a" + b"\x01", b"GIF", jpeg(640, 480), jpeg(1, 1), jpeg(3000, 2000, b"\xff\xe1\x00\x04ab"),
    b"\xff\xd8", b"\xff\xd8\xff", b"\xff\xd8" + b"\x00" * 30, b"\xff\xd8\xff\xc4\x00\x02" + b"\x00" * 30,
    webp(b"VP8X", 500, 300), webp(b"VP8 ", 400, 200), webp(b"VP8L", 123, 456), b"RIFF\x00\x00\x00\x00WEBP", b"RIFF\x00\x00\x00\x00WEBPVP8X",
    b"RIFF\x00\x00\x00\x00WEBPVP8 abc", b"RIFF1234WEBPxxxx" + b"\x00" * 20,
    b'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"></svg>',
    b'<svg width="1.5.2" height="3"></svg>', b'<svg viewBox="0 0 24 24"></svg>', b'<svg viewBox="0 0 24.5 12.25"></svg>',
    b'<svg viewBox="-5 -5 100 50" width="10"></svg>', b'<SVG WIDTH="5" HEIGHT="6">', b'<svg data-width="9" height="3">',
    b'<svg width="10px" height="20px"></svg>', b'<svg width="." height="1">', b'<svg width="5." height=".5">', b'  \n<svg width="7" height="8">',
    b'<?xml version="1.0"?>\n<svg width="9" height="9">', b'<?xml version="1.0"?><g/>', b'<p>not an image</p>', b'<svg', b'<svg>',
    b'<svg width="10" height="20"', b'<svg viewBox="0,0,30,40"></svg>', b'<svg viewBox="0 0 30"></svg>',
    "<svg width=\"12\" height=\"13\"></svg>".encode("utf-16"), b"\xef\xbb\xbf<svg width=\"2\" height=\"3\">",
    b"\x00\x01\x02" * 100, b"\xff\xd8\xff\xc0" + b"\xff" * 40, b"\xff\xd8" + b"\xff\xc2" + struct.pack(">H", 17) + b"\x08" + struct.pack(">HH", 7, 9) + b"\x00" * 20,
]
for _ in range(60):
    SAMPLES.append(bytes(rng.randrange(256) for _ in range(rng.randrange(0, 40))))
pictures = []
for data in SAMPLES:
    size = cv.image_size(data)
    pictures.append({"data": b64(data), "magic": cv._magic_image(data), "size": list(size) if size else None})

# prepare_files
FILE_SETS = [
    {"index.html": b"<title>Home</title><h1>x</h1>"},
    {"a.html": b"<h1>First</h1>", "b.html": b"<h1>Second</h1>"},
    {"b.html": b"<h1>B</h1>", "a.html": b"<h1>A</h1>", "x.css": b"a{}"},
    {"index.html": b"<h1>x</h1>", "css/site.css": b"a{}", "img/a.png": png_hdr(2, 2), "tool.exe": b"MZ", "run.sh": b"#!"},
    {"index.html": b"<h1>x</h1>", "a.css": b"a{}", "a.css/b.html": b"<p>"},
    {"x.css": b"a{}"}, {}, {"index.html": b"<h1>x</h1>", "../evil.html": b"x"}, {"/abs/index.html": b"<h1>x</h1>"},
    {"INDEX.HTML": b"<h1>x</h1>"}, {"Page.HTM": b"<title>T</title>"}, {"a/b/c.html": b"<h1>deep</h1>", "a/b": b"file"},
    {"index.html": "<title>é\u4e2d</title>".encode()}, {"index.html": b"\xff\xfe<title>bad bytes</title>"},
    {"index.html": b"x" * 100, "big.json": b"y" * (5 * 1024 * 1024)},
    {f"f{i}.txt": b"x" for i in range(301)} | {"index.html": b"<h1>x</h1>"},
    {f"f{i}.txt": b"x" for i in range(299)} | {"index.html": b"<h1>x</h1>"},
]
ENTRIES = [None, "", "index.html", "b.html", "missing.html", "../x", "A.HTML"]
prepares = []
for files in FILE_SETS:
    for entry in ENTRIES[:4] if len(files) > 50 else ENTRIES:
        def go():
            clean, info = cv.prepare_files(files, entry)
            return {"info": info, "files": sorted(clean)}
        prepares.append({"files": {k: b64(v) if len(v) < 1000 else {"fill": chr(v[0]), "n": len(v)} for k, v in files.items()},
                         "entry": entry, **run(go)})

# strip_common_root, slug
ROOTS = [{"dist/index.html": b"a", "dist/a/b.css": b"b"}, {"dist/index.html": b"a", "other/x.css": b"b"}, {"index.html": b"a"},
         {"d/index.html": b"a", "index2.html": b"b"}, {}, {"a/b/c.html": b"x"}, {"a/b/c.html": b"x", "a/d.html": b"y"}]
roots = [{"files": {k: b64(v) for k, v in f.items()}, "out": sorted(cv._strip_common_root(dict(f)))} for f in ROOTS]
SLUGS = [("Sign in", "x"), ("", "fb"), ("---", "fb"), ("a/b\\c", "fb"), ("é\u4e2d", "fb"), ("..x..", "fb"), ("a  b", "fb"), (".hidden", "fb"),
         ("Frame_1.v2", "fb"), ("-._", "fb"), ("A\u00e9B", "fb"), ("x" * 50, "fb"), ("tab\there", "fb"), ("\U0001f600 face", "fb")]
slugs = [{"text": t, "fallback": f, "out": cv._slug(t, f)} for t, f in SLUGS]

# clean_*
SRCS = [
    {}, {"name": "  Home  ", "x": 10, "y": "20", "w": 100, "h": 5000, "order": "3", "page": "p_1", "fit": 1},
    {"name": None, "x": None, "page": {"x": 1}}, {"name": "", "w": "nan"}, {"name": 5, "x": True, "fit": 0},
    {"name": ["a", 1], "h": 119.9}, {"w": 1920, "h": 6000, "x": -100000, "y": 100000}, {"w": 1921, "h": 6001, "order": -2},
    {"fit": None}, {"name": "x" * 300, "order": 1e9}, {"x": 5.5, "y": -5.5, "w": 320.0, "h": 120.0},
    {"color": "green", "text": "hello\x00 world", "by": "zz"}, {"color": ["green"], "text": 12}, {"color": "nope"},
    {"text": "x" * 2000, "w": 79, "h": 59}, {"w": 601, "h": 601}, {"w": 80, "h": 60},
    {"size": 5, "text": "t"}, {"size": "30", "text": None}, {"size": 9, "x": "bad"}, {"size": 97}, {"size": 96.9},
    {"from": "b_1", "to": "n_2", "label": "after"}, {"from": 5, "to": None, "label": 7}, {"from": "x" * 50, "to": "y", "label": "l" * 200},
]
OLDS = [None, {}, {"name": "Old", "x": 1, "y": 2.5, "w": 400, "h": 300, "order": 4, "page": "p_9", "fit": True, "color": "blue",
                  "text": "old", "by": "AB", "size": 33, "from": "b_a", "to": "b_b", "label": "L"}]
ACTORS = ["user", "An Nguyen", "ai-bot", "", "x.y_z-w", "  ", "élan vital", "ß"]
cleans = []
for src in SRCS:
    for old in OLDS:
        for actor in ACTORS[:2] if old else ACTORS:
            cleans.append({"src": src, "old": old, "actor": actor,
                           "board": cv.clean_board_layout(src, old), "note": cv._clean_note(src, old, actor),
                           "label": cv._clean_label(src, old), "arrow": cv._clean_arrow(src, old)})

# names and embed lines
TITLES = [None, "", "  \n ", "Login redesign", "[docs]  Login canvas", "a\nb\r\nc", "x" * 300, "\u00a0 nb \u00a0", "[[]]", "![x](y)"]
names = [{"title": t, "fallback": "Canvas", "name": cv.canvas_name(t, "Canvas"),
          "embed": cv.embed_line("cv_8f3a1c2d", t or "", None), "embed_b": cv.embed_line("cv_8f3a1c2d", t or "", "b_0a1b2c3d")} for t in TITLES]
refs = [{"text": t, "out": cv.refs_in(t)} for t in [
    "", "![Login](canvas:cv_8f3a1c2d)\n![Wrong](canvas:cv_8f3a1c2d#b_0a1b2c3d)\nsee [Other](canvas:cv_11112222) and ![x](sketch:sk_8f2a1c3d)",
    "(canvas:cv_ABCDEF12)", "(canvas:cv_8f3a1c2d#p_0a1b2c3d)", "(canvas:cv_8f3a1c2d#x_0a1b2c3d)", "(canvas:cv_8f3a1c2)", "(canvas:cv_8f3a1c2d0)"]]

# unified_diff
WORDS = ["alpha", "beta", "gamma", "delta", "", "<div>", "</div>", "a{}", "x", "y", "same", "same", "same"]
diffs = []
for n in (0, 1, 3, 10, 50, 120, 250, 400):
    for _ in range(6 if n < 250 else 3):
        a = [rng.choice(WORDS) + (str(rng.randrange(40)) if rng.random() < 0.5 else "") for _ in range(n)]
        b = list(a)
        for _ in range(rng.randrange(0, 8)):
            op = rng.choice(["del", "ins", "rep"])
            if b and op == "del":
                del b[rng.randrange(len(b))]
            elif op == "ins":
                b.insert(rng.randrange(len(b) + 1), rng.choice(WORDS) + str(rng.randrange(5)))
            elif b:
                b[rng.randrange(len(b))] = "changed" + str(rng.randrange(9))
        diffs.append({"a": a, "b": b, "out": list(difflib.unified_diff(a, b, "v1/x", "v2/x", lineterm="", n=2))})
diffs.append({"a": [], "b": [], "out": []})
diffs.append({"a": ["x"], "b": [], "out": list(difflib.unified_diff(["x"], [], "v1/x", "v2/x", lineterm="", n=2))})
diffs.append({"a": [], "b": ["x", "y"], "out": list(difflib.unified_diff([], ["x", "y"], "v1/x", "v2/x", lineterm="", n=2))})
# many popular lines: the autojunk heuristic
pop_a = ["<tr>", "<td>", "</td>", "</tr>"] * 120 + ["unique1"] + ["<tr>", "</tr>"] * 40
pop_b = ["<tr>", "<td>", "</td>", "</tr>"] * 118 + ["unique2", "new"] + ["<tr>", "</tr>"] * 41
diffs.append({"a": pop_a, "b": pop_b, "out": list(difflib.unified_diff(pop_a, pop_b, "v1/x", "v2/x", lineterm="", n=2))})

# diff_docs and describe_changes
def board(i, **kw):
    b = {"id": f"b_{i:08x}", "page": "p_1", "name": f"B{i}", "kind": "html", "x": 0, "y": 0, "w": 1280, "h": 800, "order": 0,
         "ref": None, "content": {"rev": 1, "bytes": 5, "files": [], "entry": "index.html"}, "rev": 1}
    b.update(kw)
    return b


def mkdoc(boards, notes=(), arrows=(), labels=(), pages=None):
    return {"format": "kanban-canvas", "version": 1, "pages": pages or [{"id": "p_1", "name": "Page 1", "rev": 1}],
            "boards": list(boards), "notes": list(notes), "arrows": list(arrows), "labels": list(labels)}


base = mkdoc([board(1), board(2), board(3, content=None, kind="empty")], notes=[{"id": "n_1", "x": 1, "text": "a", "rev": 1}])
variants = [
    ("same", copy.deepcopy(base)),
    ("added", mkdoc(base["boards"] + [board(4)], base["notes"])),
    ("removed", mkdoc(base["boards"][:2], base["notes"])),
    ("content", mkdoc([board(1, content={"rev": 2, "bytes": 5, "files": [], "entry": "index.html"})] + base["boards"][1:], base["notes"])),
    ("content3", mkdoc([board(i, content={"rev": 9, "bytes": 5, "files": [], "entry": "i.html"}) for i in (1, 2, 3)], base["notes"])),
    ("rename", mkdoc([board(1, name="New")] + base["boards"][1:], base["notes"])),
    ("ref", mkdoc([board(1, ref="sk_00000001")] + base["boards"][1:], base["notes"])),
    ("move", mkdoc([board(1, x=5.0)] + base["boards"][1:], base["notes"])),
    ("move_eq", mkdoc([board(1, x=0.0, w=1280.0)] + base["boards"][1:], base["notes"])),
    ("page", mkdoc([board(1, page="p_2")] + base["boards"][1:], base["notes"])),
    ("notes", mkdoc(base["boards"], [{"id": "n_1", "x": 2, "text": "a", "rev": 2}])),
    ("notes_rev", mkdoc(base["boards"], [{"id": "n_1", "x": 1, "text": "a", "rev": 7}])),
    ("arrows", mkdoc(base["boards"], base["notes"], arrows=[{"id": "a_1", "from": "b_00000001", "to": "n_1"}])),
    ("labels", mkdoc(base["boards"], base["notes"], labels=[{"id": "t_1", "text": "t"}])),
    ("pages", mkdoc(base["boards"], base["notes"], pages=[{"id": "p_1", "name": "Renamed", "rev": 1}])),
    ("all", mkdoc([board(1, name="Z"), board(9)], [], arrows=[{"id": "a_1"}], labels=[{"id": "t_1"}])),
]
docs = []
for label, new in variants:
    for old in (base, None):
        ch = cv.diff_docs(old, new)
        names_ = {b["id"]: b["name"] for b in new["boards"]} | {b["id"]: b["name"] for b in (old or {}).get("boards", [])}
        docs.append({"label": label, "old": old, "new": new, "changes": ch, "describe": cv.describe_changes(ch, names_), "names": names_})

# free_spot
spots = []
for _ in range(40):
    boards = [{"id": f"b_{i}", "page": rng.choice(["p_1", "p_1", "p_2"]), "x": rng.choice([0, 80, 1360, 2000.5]), "y": rng.choice([0, 100, -50.5]),
               "w": rng.choice([320, 1280, 390.5]), "h": rng.choice([120, 800])} for i in range(rng.randrange(0, 6))]
    doc = {"boards": boards}
    for page in ("p_1", "p_2", "p_9"):
        for w, h in ((1280, 800), (390, 844)):
            spots.append({"boards": boards, "page": page, "w": w, "h": h, "out": list(cv._free_spot(doc, page, w, h))})

# check_doc
def checked(doc):
    d = copy.deepcopy(doc)
    try:
        cv._check_doc(d)
        return {"ok": d}
    except DocsError as e:
        return {"error": {"status": e.status, "code": e.code, "message": e.message, "extra": e.extra}}


check_in = [
    mkdoc([board(1, page="p_gone")], [{"id": "n_1", "page": None}, {"id": "n_2", "page": "p_1"}],
          arrows=[{"id": "a_1", "from": "b_00000001", "to": "n_1", "page": "zz"}, {"id": "a_2", "from": "b_00000001", "to": "n_x"}]),
    mkdoc([board(i) for i in range(61)]), mkdoc([], pages=[{"id": f"p_{i}"} for i in range(11)]),
    mkdoc([], notes=[{"id": f"n_{i}"} for i in range(501)]), mkdoc([], arrows=[{"id": "a", "from": "x", "to": "y"}] * 501),
    mkdoc([], labels=[{"id": f"t_{i}"} for i in range(301)]),
]
checks = [{"doc": d, **checked(d)} for d in check_in]

OUT.write_text(json.dumps({"nums": nums, "texts": texts, "paths": paths, "pictures": pictures, "prepares": prepares, "roots": roots,
                           "slugs": slugs, "cleans": cleans, "names": names, "refs": refs, "diffs": diffs, "docs": docs,
                           "spots": spots, "checks": checks}, separators=(",", ":")))
print(OUT, OUT.stat().st_size)
