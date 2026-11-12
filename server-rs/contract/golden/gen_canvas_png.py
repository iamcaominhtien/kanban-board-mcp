"""Golden vectors for crates/kb-draw `canvas_png`: the PNG bytes of `Raster`, `board_snapshot` and `overview`.

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_canvas_png.py
Writes `canvas_png.json` next to this file (a SHA-256 of every picture, and the whole PNG as base64 for the small
ones). The generator runs with its own throwaway KANBAN_* folders.
"""

import base64
import hashlib
import json
import os
import random
import sys
import tempfile
import zlib
from pathlib import Path

_tmp = tempfile.mkdtemp(prefix="kb-golden-")
os.environ["KANBAN_CONFIG_DIR"] = os.path.join(_tmp, "config")
os.environ["KANBAN_DB_PATH"] = os.path.join(_tmp, "data", "kanban.db")
os.environ["KANBAN_LOG_DIR"] = os.path.join(_tmp, "logs")
os.environ["KANBAN_UPLOADS_DIR"] = os.path.join(_tmp, "uploads")
sys.path.insert(0, os.getcwd())  # run from server/

from services import canvas_png as cp  # noqa: E402

OUT = Path(__file__).with_name("canvas_png.json")
FULL_UNDER = 4000  # bytes: a PNG this small is kept whole


def digest(png: bytes) -> dict:
    out = {"sha256": hashlib.sha256(png).hexdigest(), "len": len(png)}
    if len(png) <= FULL_UNDER:
        out["png_b64"] = base64.b64encode(png).decode()
    return out


rng = random.Random(267)


def color() -> list:
    return [rng.randrange(256) for _ in range(3)]


def num() -> float:
    return rng.choice([rng.uniform(-20, 140), float(rng.randrange(-5, 120)), rng.randrange(-5, 120) + 0.5, 0.5, 1.5, 2.5, -0.5])


rasters = []
for i in range(60):
    w, h = rng.choice([(1, 1), (3, 2), (20, 10), (47, 31), (64, 64), (100, 60), (130, 90), (0, 0), (-3, 5)])
    bg = color() if i % 3 else list(cp.WHITE)
    ops = []
    for _ in range(rng.randrange(0, 12)):
        kind = rng.choice(["rect", "rect", "frame", "line"])
        if kind == "rect":
            ops.append(["rect", num(), num(), num(), num(), color()])
        elif kind == "frame":
            ops.append(["frame", num(), num(), num(), num(), color(), rng.choice([1, 2, 3])])
        else:
            ops.append(["line", num(), num(), num(), num(), color()])
    r = cp.Raster(w, h, tuple(bg))
    for op in ops:
        if op[0] == "rect":
            r.rect(*op[1:5], tuple(op[5]))
        elif op[0] == "frame":
            r.frame(*op[1:5], tuple(op[5]), op[6])
        else:
            r.line(*op[1:5], tuple(op[5]))
    rasters.append({"w": w, "h": h, "bg": bg, "ops": ops, **digest(r.png())})

# bigger pictures that make zlib work: compress() of raw inputs of every kind
compress = []
for n in (0, 1, 7, 100, 1000, 5000, 20000, 60000):
    for kind in ("zero", "random", "text", "runs", "gradient"):
        if kind == "zero":
            raw = bytes(n)
        elif kind == "random":
            raw = bytes(rng.randrange(256) for _ in range(n))
        elif kind == "text":
            raw = (b"the quick brown fox jumps over the lazy dog " * (n // 40 + 1))[:n]
        elif kind == "runs":
            raw = b"".join(bytes([rng.randrange(4)]) * rng.randrange(1, 30) for _ in range(n))[:n]
        else:
            raw = bytes((i * 7) % 256 for i in range(n))
        compress.append({"kind": kind, "n": n, "raw_b64": base64.b64encode(raw).decode() if n <= 1000 else None,
                         "seed": None, "sha256_raw": hashlib.sha256(raw).hexdigest(),
                         "sha256": hashlib.sha256(zlib.compress(raw, 6)).hexdigest(),
                         "raw_full_b64": base64.b64encode(raw).decode() if n <= 20000 else None})
compress = [c for c in compress if c["raw_full_b64"] is not None]
for c in compress:
    c.pop("raw_b64", None)
    c.pop("seed", None)

PAGES = [
    "<!doctype html><title>Sign in</title><h1>Sign in</h1><label>Email</label><input type=email placeholder=you@example.com>"
    "<button>Continue</button><img alt='logo'><p>Forgot your password? Reset it.</p>",
    "<h1>One</h1><h2>Two</h2><p>text text text text</p><input type=submit value='Go'><input type=hidden><textarea></textarea>",
    "<div>" + "".join(f"<p>line {i} of the page with some words</p>" for i in range(60)) + "</div>",
    "<style>h1{color:red}</style><script>var a='<h1>x</h1>'</script><h1>Real</h1><svg><text>hi</text></svg>",
    "", "plain text only", "<button>" + "x" * 90 + "</button>", "<a href=x>link</a><span>one</span><div>two</div>",
]
snapshots = []
for page in PAGES:
    for (w, h, ms) in ((1280, 800, 360), (390, 844, 360), (1920, 6000, 360), (320, 120, 360), (10, 10, 360), (800, 600, 120)):
        snapshots.append({"html": page or None, "width": w, "height": h, "max_side": ms,
                          **digest(cp.board_snapshot(page or None, w, h, max_side=ms))})


def board(i, x, y, w, h, page="p_1"):
    return {"id": f"b_{i:08x}", "page": page, "name": f"B{i}", "kind": "empty", "x": x, "y": y, "w": w, "h": h}


DOCS = [
    {"pages": [], "boards": [], "notes": [], "labels": []},
    {"pages": [{"id": "p_1"}], "boards": [board(1, 0, 0, 1280, 800)], "notes": [], "labels": []},
    {"pages": [{"id": "p_1"}, {"id": "p_2"}],
     "boards": [board(1, 0, 0, 1280, 800), board(2, 1360.5, 20, 390, 844), board(3, 5, 5, 320, 120, "p_2")],
     "notes": [{"x": 100, "y": -300, "w": 200, "h": 80, "color": "green", "page": "p_1"},
               {"x": -400, "y": 30, "color": "nope", "page": "p_1"}, {"x": 7, "y": 7, "page": "p_2"}],
     "labels": [{"x": 0, "y": -100, "text": "Step 1", "page": "p_1"}, {"x": 40, "y": 900.5, "text": "", "page": "p_1"}]},
    {"pages": [{"id": "p_1"}], "boards": [board(i, (i % 6) * 1400, (i // 6) * 900, 1280, 800) for i in range(30)],
     "notes": [], "labels": []},
    {"pages": [{"id": "p_1"}], "boards": [], "notes": [{"x": 3, "y": 4, "page": "p_1"}], "labels": []},
    {"pages": [{"id": "p_1"}], "boards": [], "notes": [], "labels": [{"x": 3, "y": 4, "text": "x" * 300, "page": "p_1"}]},
    {"pages": [{"id": "p_1"}], "boards": [board(1, 10.25, 3.5, 99.5, 77.5)], "notes": [], "labels": []},
]
overviews = []
for doc in DOCS:
    for page, ms in ((None, 1200), ("p_2", 1200), (None, 1000), (None, 300), ("p_missing", 1200)):
        overviews.append({"doc": doc, "page": page, "max_side": ms, **digest(cp.overview(doc, page, max_side=ms))})

OUT.write_text(json.dumps({"rasters": rasters, "compress": compress, "snapshots": snapshots, "overviews": overviews},
                          separators=(",", ":")))
print(OUT, OUT.stat().st_size)
