# ruff: noqa: F811  (pytest fixtures imported from test_docs are redefined as arguments)
import json

import pytest

from kanban_mcp import common, operations as ops
from main import mcp
from services import diagram_model as dm
from services.diagrams import sanitize_svg
from tests.test_docs import c, pid, setup_db, test_async_session  # noqa: F401,F811


@pytest.fixture(autouse=True)
def _mcp_db(monkeypatch):
    monkeypatch.setattr(common, "async_session", test_async_session)


def drawio(*labels: str, extra: str = "") -> str:
    cells = "".join(
        f'<mxCell id="n{i}" value="{label}" style="rounded=1;fillColor=#E6F2EA;" vertex="1" parent="1">'
        f'<mxGeometry x="{40 + 160 * i}" y="40" width="120" height="60" as="geometry"/></mxCell>'
        for i, label in enumerate(labels)
    )
    edges = "".join(
        f'<mxCell id="e{i}" value="{"yes" if i == 0 else ""}" style="endArrow=classic;" edge="1" parent="1" source="n{i}" target="n{i + 1}">'
        '<mxGeometry relative="1" as="geometry"/></mxCell>'
        for i in range(len(labels) - 1)
    )
    return (
        '<mxfile><diagram name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>'
        f"{cells}{edges}{extra}</root></mxGraphModel></diagram></mxfile>"
    )


async def _call(name, **args):
    out = await mcp.call_tool(name, args)
    if isinstance(
        out, tuple
    ):  # (content, structured): list results come wrapped as {"result": [...]}
        structured = out[1]
        return structured["result"] if set(structured) == {"result"} else structured
    return json.loads(out[0].text)


# --- the preview -----------------------------------------------------------------------------


def test_preview_is_a_valid_svg_with_every_label():
    svg = dm.render_svg(drawio("Client", "API gateway", "Service &amp;amp; &amp;lt;db&amp;gt;"))
    clean = sanitize_svg(svg)
    for word in ("Client", "gateway", "yes", "&lt;db&gt;"):
        assert word in clean
    assert "marker-end" in clean


def test_preview_draws_every_basic_shape_and_unknown_ones_as_boxes():
    src = (
        '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>'
        '<mxCell id="a" value="O" style="ellipse;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>'
        '<mxCell id="b" value="D" style="rhombus;" vertex="1" parent="1"><mxGeometry x="100" y="0" width="80" height="40" as="geometry"/></mxCell>'
        '<mxCell id="c" value="C" style="shape=cylinder3;" vertex="1" parent="1"><mxGeometry x="200" y="0" width="80" height="60" as="geometry"/></mxCell>'
        '<mxCell id="d" value="L" style="shape=mxgraph.aws4.lambda;" vertex="1" parent="1"><mxGeometry x="300" y="0" width="80" height="40" as="geometry"/></mxCell>'
        "</root></mxGraphModel>"
    )
    svg = dm.render_svg(src)
    assert (
        "<ellipse" in svg
        and "<polygon" in svg
        and "<path" in svg
        and svg.count("<rect") == 1
    )


def test_compressed_pages_are_read():
    import base64
    import urllib.parse
    import zlib

    inner = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="Packed" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell></root></mxGraphModel>'
    co = zlib.compressobj(wbits=-15)
    data = co.compress(urllib.parse.quote(inner).encode()) + co.flush()
    assert "Packed" in dm.render_svg(
        f"<mxfile><diagram>{base64.b64encode(data).decode()}</diagram></mxfile>"
    )


def test_entities_and_doctype_are_refused():
    with pytest.raises(Exception, match="XML"):
        dm.render_svg(
            '<!DOCTYPE x [<!ENTITY a "b">]><mxGraphModel><root/></mxGraphModel>'
        )


# --- the file workflow through the Docs tools -------------------------------------------------


async def test_agent_edits_a_diagram_as_a_file(c, pid, tmp_path):
    src = tmp_path / "flow.drawio"
    src.write_text(drawio("Client", "Gateway"), encoding="utf-8")
    made = await _call(
        "docs_write",
        action="diagram_create",
        project_id=pid,
        title="Auth flow",
        path=str(src),
        summary="Two steps",
    )
    did = made["id"]
    assert made["markdown"] == f"[Auth flow](diagram:{did})" and made["version"] == 1
    assert [
        d["id"] for d in await _call("docs_read", action="diagrams", project_id=pid)
    ] == [did]
    assert "Gateway" in (await c.get(f"/diagrams/{did}/svg")).text

    # take it back to a folder, edit the file the way an agent would, save it
    got = await _call(
        "docs_read", action="diagram", diagram_id=did, path=str(tmp_path / "work") + "/"
    )
    assert got["path"].endswith("Auth-flow.drawio") and got["version"] == 1
    text = (tmp_path / "work" / "Auth-flow.drawio").read_text(encoding="utf-8")
    assert text == src.read_text(encoding="utf-8")
    shape = '<mxCell id="x" value="Cache" style="shape=mxgraph.aws4.lambda;" vertex="1" parent="1"><mxGeometry x="40" y="200" width="120" height="60" as="geometry"/></mxCell>'
    (tmp_path / "work" / "Auth-flow.drawio").write_text(
        text.replace("</root>", shape + "</root>"), encoding="utf-8"
    )
    saved = await _call(
        "docs_write",
        action="diagram_save",
        diagram_id=did,
        path=got["path"],
        base_version=got["version"],
    )
    assert saved["version"] == 2
    assert "Cache" in (await c.get(f"/diagrams/{did}/svg")).text
    full = (await c.get(f"/diagrams/{did}?source=true")).json()
    assert "mxgraph.aws4.lambda" in full["source"]  # anything draw.io can store is kept
    assert (await c.get(f"/diagrams/{did}/versions")).json()[0][
        "note"
    ] == "Saved by an AI agent"

    # an older version can be exported too
    old = await _call(
        "docs_read",
        action="diagram",
        diagram_id=did,
        path=str(tmp_path / "v1.drawio"),
        version=1,
    )
    assert "Cache" not in (tmp_path / "v1.drawio").read_text(encoding="utf-8") and old[
        "path"
    ].endswith("v1.drawio")

    # unlink and bring back
    await _call("docs_write", action="diagram_delete", diagram_id=did)
    assert await _call("docs_read", action="diagrams", project_id=pid) == []
    restored = await _call("docs_write", action="diagram_restore", diagram_id=did)
    assert restored["version"] == 2


async def test_a_stale_base_version_is_refused_with_a_way_forward(c, pid, tmp_path):
    f = tmp_path / "a.drawio"
    f.write_text(drawio("A"), encoding="utf-8")
    did = (
        await _call(
            "docs_write",
            action="diagram_create",
            project_id=pid,
            title="A",
            path=str(f),
        )
    )["id"]
    await _call(
        "docs_write", action="diagram_save", diagram_id=did, path=str(f), base_version=1
    )
    with pytest.raises(Exception, match="Export the diagram again"):
        await _call(
            "docs_write",
            action="diagram_save",
            diagram_id=did,
            path=str(f),
            base_version=1,
        )


async def test_the_agents_own_svg_is_used_as_the_preview(c, pid, tmp_path):
    f, s = tmp_path / "a.drawio", tmp_path / "a.svg"
    f.write_text(drawio("A"), encoding="utf-8")
    s.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="5" height="5"><text>exact export</text></svg>',
        encoding="utf-8",
    )
    did = (
        await _call(
            "docs_write",
            action="diagram_create",
            project_id=pid,
            title="A",
            path=str(f),
            svg_path=str(s),
        )
    )["id"]
    assert "exact export" in (await c.get(f"/diagrams/{did}/svg")).text


@pytest.mark.parametrize(
    ("content", "match"),
    [
        ("not xml", "not valid XML"),
        ("<html/>", "not a draw.io file"),
        ('<!DOCTYPE x [<!ENTITY a "b">]><mxfile/>', "DTD"),
    ],
)
async def test_bad_files_are_refused(c, pid, tmp_path, content, match):
    f = tmp_path / "bad.drawio"
    f.write_text(content, encoding="utf-8")
    with pytest.raises(Exception, match=match):
        await _call(
            "docs_write",
            action="diagram_create",
            project_id=pid,
            title="Bad",
            path=str(f),
        )


async def test_paths_are_checked(c, pid, tmp_path):
    with pytest.raises(Exception, match="absolute path"):
        await _call(
            "docs_write",
            action="diagram_create",
            project_id=pid,
            title="x",
            path="rel/flow.drawio",
        )
    with pytest.raises(Exception, match="not a file"):
        await _call(
            "docs_write",
            action="diagram_create",
            project_id=pid,
            title="x",
            path=str(tmp_path / "missing.drawio"),
        )
    big = tmp_path / "big.drawio"
    big.write_text(drawio("A").replace("A", "x" * 2_100_000, 1), encoding="utf-8")
    with pytest.raises(Exception, match="2 MB"):
        await _call(
            "docs_write",
            action="diagram_create",
            project_id=pid,
            title="x",
            path=str(big),
        )
    binary = tmp_path / "b.drawio"
    binary.write_bytes(b"\xff\xfe\x00")
    with pytest.raises(Exception, match="UTF-8"):
        await _call(
            "docs_write",
            action="diagram_create",
            project_id=pid,
            title="x",
            path=str(binary),
        )
    with pytest.raises(Exception, match="not found"):
        await _call(
            "docs_read",
            action="diagram",
            diagram_id="dg_00000000",
            path=str(tmp_path / "o.drawio"),
        )
    with pytest.raises(Exception, match="requires"):
        await _call("docs_write", action="diagram_save", diagram_id="dg_00000000")


async def test_operations_are_exported():
    for name in ("export_diagram", "save_diagram_file", "create_diagram_from_file"):
        assert callable(getattr(ops, name))
