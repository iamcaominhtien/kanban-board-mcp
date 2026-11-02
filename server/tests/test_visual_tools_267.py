"""Canvas, draw.io and Sketch for any AI (issue #267): the guides reach internal runs as skills and outside agents
through docs_read with the same text, a diagram reads as a model, and an agent can see a PNG of what it drew."""

import asyncio
import base64
import urllib.parse
import zlib
from pathlib import Path

import pytest

from kanban_mcp import common
from kanban_mcp.tools.docs import docs_read, docs_write
from services import canvas_locks, diagram_export, diagram_model, screenshots
from services import visual_guides
from services.ai import board_skills, guard
from tests.test_ai import _ctx, _project, _ticket, env  # noqa: F401  (fixture)

FLOW = """<mxfile><diagram name="Sign-up"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="form" value="Fill in the form" style="rounded=1;html=1;" vertex="1" parent="1">
<mxGeometry x="40" y="40" width="160" height="60" as="geometry"/></mxCell>
<mxCell id="valid" value="Email valid?" style="rhombus;html=1;" vertex="1" parent="1">
<mxGeometry x="60" y="180" width="120" height="80" as="geometry"/></mxCell>
<mxCell id="lane" value="Server" style="swimlane;html=1;" vertex="1" parent="1">
<mxGeometry x="300" y="0" width="300" height="300" as="geometry"/></mxCell>
<mxCell id="send" value="Send the email" style="rounded=1;html=1;" vertex="1" parent="lane">
<mxGeometry x="40" y="60" width="160" height="60" as="geometry"/></mxCell>
<mxCell id="e1" edge="1" source="form" target="valid" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="e2" value="yes" edge="1" source="valid" target="send" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>"""

BROKEN = FLOW.replace('target="send"', 'target="nowhere"').replace(
    'x="60" y="180"', 'x="60" y="60"'
)
FRAME = "<!doctype html><meta name='viewport' content='width=device-width'><h1>Create your account</h1><button>Create</button>"


@pytest.fixture(autouse=True)
def _mcp(monkeypatch, tmp_path, env):  # noqa: F811
    monkeypatch.setenv("KANBAN_UPLOADS_DIR", str(tmp_path / "uploads"))
    monkeypatch.setattr(common, "async_session", env["maker"])
    # no draw.io editor is reachable in a test: never wait for one
    monkeypatch.setenv(diagram_export.SWITCH_ENV, "off")
    canvas_locks.reset()


def _no_browser(monkeypatch):
    monkeypatch.delenv(diagram_export.EXPORT_CMD_ENV, raising=False)
    monkeypatch.setenv(diagram_export.CHROME_ENV, "/no/such/chrome")


def _png_size(path: str) -> tuple[int, int]:
    data = Path(path).read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


async def _diagram(env, tmp_path, source=FLOW, pid=None):
    pid = pid or (await _project(env["c"]))[0]
    f = tmp_path / "flow.drawio"
    f.write_text(source)
    made = await docs_write(
        action="diagram_create", project_id=pid, title="Sign-up flow", path=str(f)
    )
    return pid, made


# --- the guides ------------------------------------------------------------------------------


def test_the_diagram_and_sketch_guides_are_skills_and_the_same_text_through_docs_read():
    root = Path(board_skills.plugin_dir()) / "skills"
    guide = asyncio.run(docs_read(action="diagram_guide"))
    assert (root / "drawio-diagrams" / "SKILL.md").read_text() == (
        visual_guides.DRAWIO_HEADER + guide["guide"]
    )
    assert (root / "sketches" / "SKILL.md").read_text() == (
        visual_guides.SKETCH_HEADER + guide["sketches"]
    )
    names = [s["name"] for s in board_skills.catalog()]
    assert names[:3] == ["canvas-design", "drawio-diagrams", "sketches"]
    # what the guide must teach (the issue's list) and the choice of tool at its top
    for needle in (
        "## Which tool",
        "**Flowchart**",
        "**Swimlane flowchart**",
        "**Sequence**",
        "**State machine**",
        "## 2. Layout on a grid",
        "## 3. Style from one palette",
        "## 4. Labels",
        "## 5. Groups, containers and lanes",
        "## 7. Changing an existing diagram",
        "change **only those cells**",
        "docs_read(action='picture'",
        "## 9. Hand it in",
    ):
        assert needle in guide["guide"], needle
    # the Sketch decision is written down, with its reason
    assert "You read Sketches; you do not draw them" in guide["sketches"]
    assert "fake hand-drawn look" in guide["sketches"]


def test_the_instructions_say_which_tool_and_where_the_guides_are():
    import kanban_mcp

    text = kanban_mcp.build_instructions(True)
    assert len(text) < 10_000
    for needle in (
        "Which drawing",
        "never draw one",
        "drawio-diagrams",
        "docs_read(diagram_guide)",
        "docs_read(picture)",
        "the flow as a Diagram, the screens on a Canvas",
    ):
        assert needle in text, needle
    assert visual_guides.DRAWIO not in text


def test_each_role_that_draws_is_pointed_at_the_right_tool():
    from services.ai import packs

    by_key = {p["key"]: p["persona"] for p in packs.BUILTIN}
    for role in ("pm", "ba", "designer", "dev"):
        assert "drawio-diagrams" in by_key[role], role
    assert "docs_read(picture)" in by_key["designer"]
    assert "never one you draw" in by_key["ba"]
    # live runs: a BA and a Dev that were only told a diagram "helps" drew none (#267)
    assert "you hand in a draw.io Diagram" in by_key["ba"]
    assert "carries a draw.io Diagram" in by_key["dev"]
    assert packs.BUILTIN_VERSION == 10


# --- a diagram as a model ----------------------------------------------------------------------


async def test_a_diagram_reads_as_a_model_without_a_file(env, tmp_path):
    _, made = await _diagram(env, tmp_path)
    got = await docs_read(action="diagram", diagram_id=made["id"])
    assert "path" not in got and got["version"] == 1
    m = got["model"]
    assert m["page"] == "Sign-up" and m["problems"] == []
    shapes = {s["id"]: s for s in m["shapes"]}
    assert shapes["valid"]["shape"] == "diamond" and shapes["valid"]["label"] == (
        "Email valid?"
    )
    assert shapes["send"]["in"] == "lane" and shapes["lane"]["container"] is True
    assert (shapes["form"]["x"], shapes["form"]["w"]) == (40.0, 160.0)
    links = {e["id"]: e for e in m["links"]}
    assert (links["e2"]["from"], links["e2"]["to"], links["e2"]["label"]) == (
        "valid",
        "send",
        "yes",
    )


async def test_a_save_says_what_will_look_broken(env, tmp_path):
    _, made = await _diagram(env, tmp_path)
    f = tmp_path / "broken.drawio"
    f.write_text(BROKEN)
    saved = await docs_write(
        action="diagram_save", diagram_id=made["id"], path=str(f), base_version=1
    )
    assert saved["version"] == 2
    joined = " ".join(saved["problems"])
    assert "'nowhere', which is not a shape" in joined
    assert "'form' and 'valid' overlap" in joined
    assert "save again" in saved["fix"]


async def test_a_compressed_page_is_written_out_as_plain_xml_and_a_bare_name_is_a_folder(
    env, tmp_path
):
    inner = FLOW.split('<diagram name="Sign-up">', 1)[1].rsplit("</diagram>", 1)[0]
    deflate = zlib.compressobj(9, zlib.DEFLATED, -15)
    packed = base64.b64encode(
        deflate.compress(urllib.parse.quote(inner).encode()) + deflate.flush()
    ).decode()
    _, made = await _diagram(
        env, tmp_path, f'<mxfile><diagram name="Sign-up">{packed}</diagram></mxfile>'
    )
    out = await docs_read(
        action="diagram", diagram_id=made["id"], path=str(tmp_path / "out")
    )
    assert out["path"] == str(tmp_path / "out" / "Sign-up-flow.drawio")
    text = Path(out["path"]).read_text()
    assert "<mxGraphModel" in text and 'id="valid"' in text
    assert {s["id"] for s in out["model"]["shapes"]} >= {"form", "valid", "send"}


# --- looking at what you drew --------------------------------------------------------------------


def test_the_hidden_browser_loads_only_the_page_and_public_hosts():
    origin = "http://127.0.0.1:5123"
    assert screenshots.allowed(f"{origin}/tokens.css", origin)
    assert screenshots.allowed("https://fonts.googleapis.com/css2", origin)
    assert screenshots.allowed("data:image/png;base64,AA", origin)
    for bad in (
        "file:///etc/passwd",
        "http://127.0.0.1:8010/api/projects",
        "http://localhost:3000/",
        "http://192.168.1.10/",
        "http://[::1]:8010/",
        "http://nas.local/",
    ):
        assert not screenshots.allowed(bad, origin), bad


async def test_without_a_browser_a_picture_is_a_wireframe_and_says_so(
    env, tmp_path, monkeypatch
):
    _no_browser(monkeypatch)
    _, made = await _diagram(env, tmp_path)
    pic = await docs_read(
        action="picture", diagram_id=made["id"], path=str(tmp_path / "pics")
    )
    assert pic["drawn_by"] == "wireframe" and "No browser" in pic["note"]
    assert pic["path"] == str(tmp_path / "pics" / "Sign-up-flow.png")
    assert _png_size(pic["path"]) == (pic["width"], pic["height"])
    # a copy on the board, ready for a comment
    stored = pic["markdown"].split("](/uploads/", 1)[1].rstrip(")")
    assert (tmp_path / "uploads" / stored).read_bytes() == Path(
        pic["path"]
    ).read_bytes()
    frame = tmp_path / "canvas" / "01-form"
    frame.mkdir(parents=True)
    (frame / "index.html").write_text(FRAME)
    (frame / "frame.json").write_text('{"size": "phone"}')
    local = await docs_read(action="picture", path=str(frame))
    # beside the folder, never inside it (it would become a file of the frame)
    assert local["path"] == str(tmp_path / "canvas" / "01-form.png")
    assert local["drawn_by"] == "wireframe"


async def test_a_picture_call_that_names_nothing_or_two_things_says_what_to_give(env):
    with pytest.raises(ValueError, match="Give diagram_id, canvas_id"):
        await docs_read(action="picture")
    with pytest.raises(ValueError, match="Give one of"):
        await docs_read(action="picture", diagram_id="dg_1", sketch_id="sk_1")
    with pytest.raises(ValueError, match="does not exist: write the file first"):
        await docs_read(action="picture", path="/no/such/frame.html")
    with pytest.raises(ValueError, match="frame folder or an .html, .svg or .drawio"):
        await docs_read(action="picture", path=__file__)


async def test_an_ai_run_looks_only_at_files_in_its_own_folder(env, tmp_path):
    ctx, pid, an, m, tid = await _ctx(env)
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (outside / "index.html").write_text(FRAME)
    tokens = guard.enter(ctx)
    try:
        with pytest.raises(ValueError, match="outside your working folder"):
            await docs_read(action="picture", path=str(outside))
    finally:
        guard.leave(tokens)


@pytest.mark.skipif(
    diagram_export.find_chrome() is None, reason="no Chrome or Chromium here"
)
async def test_with_a_browser_a_frame_and_a_diagram_are_drawn_for_real(
    env, tmp_path, monkeypatch
):
    monkeypatch.delenv(diagram_export.EXPORT_CMD_ENV, raising=False)
    c = env["c"]
    pid, _ = await _project(c)
    tid = await _ticket(c, pid, "Sign-up")
    folder = tmp_path / "canvas" / "01-form"
    folder.mkdir(parents=True)
    (folder / "index.html").write_text(FRAME)
    made = await docs_write(
        action="canvas_create",
        path=str(tmp_path / "canvas"),
        owner_kind="ticket",
        owner_id=tid,
        title="Sign-up screens",
    )
    pic = await docs_read(
        action="picture",
        canvas_id=made["id"],
        board_id=made["boards"][0]["id"],
        width=390,
        path=str(tmp_path / "shots"),
    )
    assert pic["drawn_by"] == "browser" and pic["width"] == 390
    _, dg = await _diagram(env, tmp_path, pid=pid)
    drawn = await docs_read(action="picture", diagram_id=dg["id"])
    assert drawn["drawn_by"] == "browser" and drawn["width"] > 300
    assert diagram_model.model(FLOW)["problems"] == []


def _pixel(png: bytes, x: int, y: int) -> tuple[int, ...]:
    """One pixel of an 8-bit RGB or RGBA PNG (enough to tell where a shape was drawn)."""
    w = int.from_bytes(png[16:20], "big")
    bpp = {2: 3, 6: 4}[png[25]]
    data, i = b"", 8
    while i < len(png):
        n = int.from_bytes(png[i : i + 4], "big")
        if png[i + 4 : i + 8] == b"IDAT":
            data += png[i + 8 : i + 8 + n]
        i += 12 + n
    raw, stride = zlib.decompress(data), w * bpp
    prev = bytearray(stride)
    for r in range(y + 1):
        start = r * (stride + 1)
        kind, line = raw[start], bytearray(raw[start + 1 : start + 1 + stride])
        for k in range(stride):
            a = line[k - bpp] if k >= bpp else 0
            b = prev[k]
            c = prev[k - bpp] if k >= bpp else 0
            if kind == 1:
                line[k] = (line[k] + a) & 255
            elif kind == 2:
                line[k] = (line[k] + b) & 255
            elif kind == 3:
                line[k] = (line[k] + (a + b) // 2) & 255
            elif kind == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pick = a if pa <= pb and pa <= pc else b if pb <= pc else c
                line[k] = (line[k] + pick) & 255
        prev = line
    return tuple(prev[x * bpp : x * bpp + 3])


NARROW = """<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" value="" style="rounded=0;html=1;fillColor=#ff0000;strokeColor=#ff0000;" vertex="1" parent="1">
<mxGeometry x="40" y="40" width="160" height="60" as="geometry"/></mxCell>
<mxCell id="b" value="" style="rounded=0;html=1;" vertex="1" parent="1">
<mxGeometry x="40" y="200" width="160" height="60" as="geometry"/></mxCell>
</root></mxGraphModel>"""


@pytest.mark.skipif(
    diagram_export.find_chrome() is None, reason="no Chrome or Chromium here"
)
async def test_a_narrow_diagram_is_drawn_at_its_own_size_not_as_a_zoomed_phone_page(
    env, tmp_path, monkeypatch
):
    # a live Dev run looked at a 480 px wide diagram and saw only its top left corner, twice as large (#267)
    monkeypatch.delenv(diagram_export.EXPORT_CMD_ENV, raising=False)
    f = tmp_path / "narrow.drawio"
    f.write_text(NARROW)
    pic = await docs_read(action="picture", path=str(f))
    assert pic["drawn_by"] == "browser"
    png = Path(pic["path"]).read_bytes()
    assert (pic["width"], pic["height"]) == screenshots._svg_size(
        diagram_model.render_svg(NARROW)
    )
    red = _pixel(
        png, 100, 50
    )  # inside the red box (it starts at 20, 20 in the picture)
    assert red[0] > 200 and red[1] < 80, red
    # between the two boxes: white at scale 1, red when the page was zoomed
    assert min(_pixel(png, 190, 150)) > 220


def test_the_plain_preview_draws_a_links_bends_and_orthogonal_elbows():
    looped = FLOW.replace(
        '<mxCell id="e1" edge="1" source="form" target="valid" parent="1"><mxGeometry relative="1" as="geometry"/>',
        '<mxCell id="e1" edge="1" source="valid" target="form" parent="1" style="edgeStyle=orthogonalEdgeStyle;">'
        '<mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="260" y="220"/>'
        '<mxPoint x="260" y="70"/></Array></mxGeometry>',
    )
    assert looped != FLOW
    svg = diagram_model.render_svg(looped)
    first = svg.split('<polyline points="', 1)[1].split('"', 1)[0].split()
    # out of the decision, around through x = 260 (240 in the picture, whose left edge is page x 20), into the form
    assert len(first) >= 4
    assert {round(float(p.split(",")[0])) for p in first[1:-1]} == {240}
    # an orthogonal link without bends is an elbow between facing sides, not a diagonal
    elbow = FLOW.replace(
        'value="yes" edge="1"',
        'value="yes" style="edgeStyle=orthogonalEdgeStyle;" edge="1"',
    )
    points = diagram_model.render_svg(elbow).split('<polyline points="')[2]
    pts = [tuple(map(float, p.split(","))) for p in points.split('"', 1)[0].split()]
    assert all(a[0] == b[0] or a[1] == b[1] for a, b in zip(pts, pts[1:]))
