# ruff: noqa: F811  (pytest fixtures imported from test_docs are redefined as arguments)
import json

import pytest

from kanban_mcp import common, operations as ops
from main import mcp
from services import diagram_model as dm
from services.docs_text import DocsError
from tests.test_docs import c, pid, setup_db, test_async_session  # noqa: F401,F811


@pytest.fixture(autouse=True)
def _mcp_db(monkeypatch):
    monkeypatch.setattr(common, "async_session", test_async_session)


NODES = [
    {"id": "c", "label": "Client"},
    {"id": "g", "label": "API gateway"},
    {"id": "t", "label": "Token valid?", "shape": "diamond"},
    {"id": "s", "label": "Service & <db>", "shape": "cylinder", "fill": "#DCEAF8"},
]
EDGES = [
    {"from": "c", "to": "g"},
    {"from": "g", "to": "t"},
    {"from": "t", "to": "s", "label": "yes"},
]


# --- the model -------------------------------------------------------------------------------


def test_build_lays_out_in_layers_and_reads_back():
    out = dm.Drawing(dm.build_source(NODES, EDGES)).outline()
    xs = {n["id"]: n["x"] for n in out["nodes"]}
    assert xs["c"] < xs["g"] < xs["t"] < xs["s"]
    assert [n["shape"] for n in out["nodes"]] == [
        "rounded",
        "rounded",
        "diamond",
        "cylinder",
    ]
    assert (
        out["nodes"][3]["label"] == "Service & <db>"
        and out["nodes"][3]["fill"] == "#DCEAF8"
    )
    assert [(e["from"], e["to"], e.get("label")) for e in out["edges"]] == [
        ("c", "g", None),
        ("g", "t", None),
        ("t", "s", "yes"),
    ]
    top_down = dm.Drawing(dm.build_source(NODES, EDGES, "TB")).outline()
    ys = {n["id"]: n["y"] for n in top_down["nodes"]}
    assert ys["c"] < ys["g"] < ys["t"] < ys["s"]


def test_layout_survives_cycles_and_a_lonely_node():
    nodes = [{"id": i, "label": i} for i in "abcx"]
    edges = [
        {"from": "a", "to": "b"},
        {"from": "b", "to": "c"},
        {"from": "c", "to": "a"},
    ]
    out = dm.Drawing(dm.build_source(nodes, edges)).outline()
    assert len({(n["x"], n["y"]) for n in out["nodes"]}) == 4


def test_edit_changes_only_what_it_names():
    src = dm.build_source(NODES, EDGES)
    new, info = dm.apply_ops(
        src,
        [
            {"op": "add_node", "id": "cache", "label": "Cache", "shape": "ellipse"},
            {"op": "add_edge", "from": "g", "to": "cache", "label": "hit"},
            {"op": "update", "id": "c", "label": "Browser\nclient", "fill": "#FFF4DC"},
            {"op": "update", "id": "s", "shape": "rect"},
        ],
    )
    assert info["added"][0] == "cache"
    out = dm.Drawing(new).outline()
    by = {n["id"]: n for n in out["nodes"]}
    assert by["c"]["label"] == "Browser\nclient" and by["c"]["fill"] == "#FFF4DC"
    assert by["s"]["shape"] == "rect" and by["s"]["fill"] == "#DCEAF8"  # colour kept
    assert by["t"]["shape"] == "diamond"  # untouched
    assert by["cache"]["x"] > max(by[i]["x"] for i in ("c", "g", "t", "s"))
    assert len(out["edges"]) == 4


def test_delete_removes_connected_edges_and_is_all_or_nothing():
    src = dm.build_source(NODES, EDGES)
    new, _ = dm.apply_ops(src, [{"op": "delete", "id": "t"}])
    out = dm.Drawing(new).outline()
    assert [n["id"] for n in out["nodes"]] == ["c", "g", "s"]
    assert [(e["from"], e["to"]) for e in out["edges"]] == [("c", "g")]
    with pytest.raises(DocsError, match=r"ops\[2\] \(delete\)"):
        dm.apply_ops(src, [{"op": "delete", "id": "c"}, {"op": "delete", "id": "nope"}])


@pytest.mark.parametrize(
    "bad",
    [
        {"op": "fly"},
        {"op": "add_node", "label": "x", "shape": "blob"},
        {"op": "add_node", "label": "x", "x": "far"},
        {"op": "add_node", "id": "c", "label": "dup"},
        {"op": "add_edge", "from": "c", "to": "missing"},
        {"op": "update", "id": "c", "fill": "red; evil=1"},
        {"op": "layout", "direction": "diagonal"},
    ],
)
def test_bad_operations_are_refused(bad):
    with pytest.raises(DocsError):
        dm.apply_ops(dm.build_source(NODES, EDGES), [bad])


def test_other_pages_and_unknown_styles_are_kept(tmp_path):
    two_pages = (
        '<mxfile><diagram name="A"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>'
        '<mxCell id="a" value="Keep" style="shape=mxgraph.aws4.lambda;fillColor=#ED7100;" vertex="1" parent="1">'
        '<mxGeometry x="10" y="10" width="50" height="50" as="geometry"/></mxCell></root></mxGraphModel></diagram>'
        '<diagram name="B"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>'
    )
    new, _ = dm.apply_ops(two_pages, [{"op": "add_node", "id": "n", "label": "New"}])
    assert 'name="B"' in new and "mxgraph.aws4.lambda" in new
    d = dm.Drawing(new)
    assert d.pages == 2 and {n["id"] for n in d.outline()["nodes"]} == {"a", "n"}


def test_entities_and_doctype_are_refused():
    with pytest.raises(DocsError):
        dm.Drawing('<!DOCTYPE x [<!ENTITY a "b">]><mxGraphModel><root/></mxGraphModel>')


def test_preview_is_a_valid_svg_with_every_label():
    from services.diagrams import sanitize_svg

    svg = dm.render_svg(dm.build_source(NODES, EDGES))
    clean = sanitize_svg(svg)
    for word in ("Client", "gateway", "Token valid?", "yes", "&lt;db&gt;"):
        assert word in clean
    assert "<polygon" in clean and "marker-end" in clean


# --- the tools -------------------------------------------------------------------------------


async def _call(name, **args):
    out = await mcp.call_tool(name, args)
    if isinstance(
        out, tuple
    ):  # (content, structured): list results come wrapped as {"result": [...]}
        structured = out[1]
        return structured["result"] if set(structured) == {"result"} else structured
    return json.loads(out[0].text)


async def test_agent_flow_through_the_tools(c, pid):
    made = await _call(
        "diagram_write",
        action="create",
        project_id=pid,
        label="Auth flow",
        nodes=NODES,
        edges=EDGES,
    )
    did = made["id"]
    assert made["markdown"] == f"[Auth flow](diagram:{did})" and made["version"] == 1

    got = await _call("diagram_read", action="get", diagram_id=did)
    assert len(got["nodes"]) == 4 and got["version"] == 1 and "xml" not in got
    assert (
        "<mxfile"
        in (
            await _call("diagram_read", action="get", diagram_id=did, include_xml=True)
        )["xml"]
    )

    edited = await _call(
        "diagram_write",
        action="edit",
        diagram_id=did,
        base_version=1,
        ops=[
            {"op": "add_node", "id": "d", "label": "401 Denied", "fill": "#FBE7E4"},
            {"op": "add_edge", "from": "t", "to": "d", "label": "no"},
        ],
    )
    assert edited["version"] == 2 and edited["added"][0] == "d"
    versions = await _call("diagram_read", action="versions", diagram_id=did)
    assert versions[0]["author"] == "agent" and "AI agent" in versions[0]["note"]

    # a stale base is refused with a way forward
    with pytest.raises(Exception, match="diagram_read"):
        await _call(
            "diagram_write",
            action="edit",
            diagram_id=did,
            base_version=1,
            ops=[{"op": "layout"}],
        )

    # the human side sees the preview the agent's edit produced
    r = await c.get(f"/diagrams/{did}/svg")
    assert "401 Denied" in r.text
    listed = await _call("diagram_read", action="list", project_id=pid)
    assert [d["id"] for d in listed] == [did]

    # unlink, restore, restore an old version
    await _call("diagram_write", action="delete", diagram_id=did)
    assert await _call("diagram_read", action="list", project_id=pid) == []
    assert [
        d["id"]
        for d in await _call("diagram_read", action="recycle_bin", project_id=pid)
    ] == [did]
    await _call("diagram_write", action="restore", diagram_id=did)
    back = await _call(
        "diagram_write", action="restore_version", diagram_id=did, version=1
    )
    assert back["version"] == 3
    assert (
        len((await _call("diagram_read", action="get", diagram_id=did))["nodes"]) == 4
    )


async def test_replace_and_create_from_xml(c, pid):
    src = dm.build_source(NODES[:2], EDGES[:1])
    made = await _call(
        "diagram_write", action="create", project_id=pid, label="Raw", xml=src
    )
    swapped = await _call(
        "diagram_write",
        action="replace",
        diagram_id=made["id"],
        base_version=1,
        xml=dm.build_source(NODES, EDGES),
    )
    assert swapped["version"] == 2
    with pytest.raises(Exception, match="nodes"):
        await _call("diagram_write", action="create", project_id=pid, label="x")
    with pytest.raises(Exception, match="not both"):
        await _call(
            "diagram_write",
            action="create",
            project_id=pid,
            label="x",
            nodes=NODES,
            xml=src,
        )


async def test_wrong_calls_are_answered_with_what_the_action_takes(c, pid):
    with pytest.raises(Exception, match="requires"):
        await _call("diagram_write", action="edit", diagram_id="dg_00000000")
    with pytest.raises(Exception, match="not found"):
        await _call("diagram_read", action="get", diagram_id="dg_00000000")


async def test_operations_are_exported():
    for name in ("get_diagram", "edit_diagram", "create_diagram", "replace_diagram"):
        assert callable(getattr(ops, name))
