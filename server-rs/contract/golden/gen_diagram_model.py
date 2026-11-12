"""Golden vectors for crates/kb-draw: `diagram_model` (what an agent reads from a .drawio, the SVG preview, the XML
reader behind them) and the pure functions of `diagrams` (sanitize_svg, text_summary, validate_source...).

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_diagram_model.py
Writes `diagram_model.json` next to this file. The generator runs with its own throwaway KANBAN_* folders.
"""

import base64
import json
import os
import sys
import tempfile
import urllib.parse
import zlib
from pathlib import Path

_tmp = tempfile.mkdtemp(prefix="kb-golden-")
os.environ["KANBAN_CONFIG_DIR"] = os.path.join(_tmp, "config")
os.environ["KANBAN_DB_PATH"] = os.path.join(_tmp, "data", "kanban.db")
os.environ["KANBAN_LOG_DIR"] = os.path.join(_tmp, "logs")
os.environ["KANBAN_UPLOADS_DIR"] = os.path.join(_tmp, "uploads")
sys.path.insert(0, os.getcwd())  # run from server/

from defusedxml import ElementTree as SafeET  # noqa: E402

from services import diagram_model as dm  # noqa: E402
from services import diagrams as dg  # noqa: E402
from services import sketches as sk  # noqa: E402
from services.docs_text import DocsError  # noqa: E402
import html  # noqa: E402

OUT = Path(__file__).with_name("diagram_model.json")
ROOT = Path(__file__).resolve().parents[3]


def err(e: Exception) -> dict:
    if isinstance(e, DocsError):
        return {"error": {"type": "DocsError", "status": e.status, "code": e.code, "message": e.message, "extra": e.extra}}
    return {"error": {"type": type(e).__name__, "message": str(e)}}


def run(fn, *args, **kw):
    try:
        return {"ok": fn(*args, **kw)}
    except Exception as e:  # noqa: BLE001
        return err(e)


def pack(inner: str, quote: bool = True) -> str:
    co = zlib.compressobj(wbits=-15)
    text = urllib.parse.quote(inner) if quote else inner
    data = co.compress(text.encode()) + co.flush()
    return base64.b64encode(data).decode()


def _raw(data: bytes) -> bytes:
    co = zlib.compressobj(wbits=-15)
    return co.compress(data) + co.flush()


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


def model_of(cells: str, attrs: str = "") -> str:
    return f'<mxGraphModel{attrs}><root><mxCell id="0"/><mxCell id="1" parent="0"/>{cells}</root></mxGraphModel>'


def vertex(i, label="", x=0, y=0, w=80, h=40, style="", parent="1", extra=""):
    return (
        f'<mxCell id="{i}" value="{label}" style="{style}" vertex="1" parent="{parent}">'
        f'<mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>{extra}'
    )


def edge(i, s, t, label="", style="", points=None):
    pts = ""
    if points:
        pts = '<Array as="points">' + "".join(f'<mxPoint x="{x}" y="{y}"/>' for x, y in points) + "</Array>"
    ends = (f' source="{s}"' if s else "") + (f' target="{t}"' if t else "")
    return (
        f'<mxCell id="{i}" value="{label}" style="{style}" edge="1" parent="1"{ends}>'
        f'<mxGeometry relative="1" as="geometry">{pts}</mxGeometry></mxCell>'
    )


INNER = model_of(vertex("a", "Packed", 0, 0) + vertex("b", "Two &amp; more", 200, 0) + edge("e", "a", "b", "go"))
BAD_DOC = '<!DOCTYPE x [<!ENTITY a "b">]><mxfile/>'

SOURCES: dict[str, str] = {
    "order_flow_sample": (ROOT / "docs" / "demo" / "order-flow-sample.drawio").read_text(encoding="utf-8"),
    "tests_source": (
        '<mxfile><diagram name="Page-1"><mxGraphModel><root>'
        '<mxCell id="0"/><mxCell id="1" parent="0"/>'
        '<mxCell id="2" value="Client" vertex="1" parent="1"/>'
        '<mxCell id="3" value="API &lt;b&gt;gateway&lt;/b&gt;" vertex="1" parent="1"/>'
        '<mxCell id="4" value="yes" edge="1" parent="1" source="2" target="3"/>'
        "</root></mxGraphModel></diagram></mxfile>"
    ),
    "tests_empty": (
        "<mxfile><diagram><mxGraphModel><root>"
        '<mxCell id="0"/><mxCell id="1" parent="0"/>'
        "</root></mxGraphModel></diagram></mxfile>"
    ),
    "mcp_three": drawio("Client", "API gateway", "Service &amp;amp; &amp;lt;db&amp;gt;"),
    "mcp_one": drawio("A"),
    "mcp_extra": drawio("A", "B", extra=vertex("x", "Cache", 40, 200, 120, 60, "shape=mxgraph.aws4.lambda;")),
    "shapes": model_of(
        vertex("a", "O", 0, 0, 80, 40, "ellipse;")
        + vertex("b", "D", 100, 0, 80, 40, "rhombus;")
        + vertex("c", "C", 200, 0, 80, 60, "shape=cylinder3;")
        + vertex("d", "L", 300, 0, 80, 40, "shape=mxgraph.aws4.lambda;")
        + vertex("t", "free text", 400, 0, 80, 40, "text;html=1;")
        + vertex("r", "round", 500, 0, 80, 40, "rounded=1;fillColor=#ff0000;strokeColor=#00ff00;fontColor=#0000ff;fontSize=14;")
        + vertex("s", "tiny cyl", 600, 0, 80, 20, "shape=cylinder;")
    ),
    "compressed": f"<mxfile><diagram name='Packed page'>{pack(INNER)}</diagram></mxfile>",
    "compressed_unquoted": f"<mxfile><diagram>{pack(INNER, quote=False)}</diagram></mxfile>",
    "compressed_whitespace": f"<mxfile><diagram>\n  {pack(INNER)}\n  </diagram></mxfile>",
    "compressed_two_pages": f'<mxfile><diagram name="One">{pack(INNER)}</diagram><diagram name="Two">{pack(INNER)}</diagram></mxfile>',
    "compressed_second_page_plain": f'<mxfile><diagram name="One">{pack(INNER)}</diagram><diagram name="Two">{INNER}</diagram></mxfile>',
    "compressed_garbage": "<mxfile><diagram>!!!not base64 at all!!!</diagram></mxfile>",
    "compressed_bad_padding": "<mxfile><diagram>QUJDR</diagram></mxfile>",
    "compressed_not_deflate": f"<mxfile><diagram>{base64.b64encode(b'hello world, not deflate').decode()}</diagram></mxfile>",
    "compressed_bad_utf8": "<mxfile><diagram>" + base64.b64encode(_raw(b"\xff\xfe")).decode() + "</diagram></mxfile>",
    "compressed_inner_not_xml": f"<mxfile><diagram>{pack('plain words')}</diagram></mxfile>",
    "compressed_inner_dtd": f"<mxfile><diagram>{pack(BAD_DOC)}</diagram></mxfile>",
    "compressed_unicode": f"<mxfile><diagram>{pack(model_of(vertex('u', 'Zażółć gęślą jaźń 日本語 😀', 0, 0)))}</diagram></mxfile>",
    "compressed_percent_literal": f"<mxfile><diagram>{pack(model_of(vertex('u', '100% sure', 0, 0)), quote=False)}</diagram></mxfile>",
    "nested_groups": model_of(
        vertex("g1", "Group", 100, 100, 400, 300, "group;")
        + vertex("g2", "Inner", 20, 20, 300, 200, "swimlane;", parent="g1")
        + vertex("g3", "Leaf", 10, 40, 100, 50, "", parent="g2")
        + vertex("g4", "Table", 500, 0, 200, 100, "shape=table;startSize=30;")
        + vertex("g5", "Box", 10, 10, 50, 30, "container=1;", parent="g4")
        + vertex("lost", "Orphan", 5, 5, 50, 30, "", parent="nowhere")
        + edge("eg", "g3", "g1", "link")
    ),
    "layer_parent": (
        '<mxGraphModel><root><mxCell id="0"/><mxCell id="L" parent="0"/>'
        + vertex("a", "In layer", 10, 10, 60, 30, "", parent="L")
        + vertex("b", "In 1", 100, 10, 60, 30, "", parent="1")
        + "</root></mxGraphModel>"
    ),
    "edges_without_ends": model_of(
        vertex("a", "A", 0, 0) + vertex("b", "B", 200, 100) + edge("e1", "a", "") + edge("e2", "", "b") + edge("e3", "", "")
        + edge("e4", "a", "ghost") + edge("e5", "ghost", "b", "dangling")
    ),
    "edge_styles": model_of(
        vertex("a", "A", 0, 0) + vertex("b", "B", 300, 200) + vertex("c", "C", 300, 0) + vertex("d", "D", 0, 200)
        + edge("e1", "a", "b", "ortho", "edgeStyle=orthogonalEdgeStyle;strokeColor=#ff0000;")
        + edge("e2", "a", "c", "straight")
        + edge("e3", "b", "d", "ortho2", "edgeStyle=orthogonalEdgeStyle;")
        + edge("e4", "c", "d", "bent", "", points=[(150, -80), (150, 300)])
        + edge("e5", "c", "d", "bent ortho", "edgeStyle=orthogonalEdgeStyle;", points=[(400, 100), (50, 150)])
        + edge("e6", "a", "a", "self")
        + edge("e7", "a", "c", "same row", "edgeStyle=orthogonalEdgeStyle;")
    ),
    "html_labels": model_of(
        vertex("a", "&lt;div&gt;Line one&lt;/div&gt;&lt;div&gt;Line two&lt;br&gt;three&lt;/div&gt;", 0, 0, 200, 80)
        + vertex("b", "&lt;b&gt;bold&lt;/b&gt; &amp;amp; &amp;nbsp; &amp;#65; &amp;lt;3 &amp;copy; &amp;unknown;", 300, 0, 200, 80)
        + vertex("c", "&lt;p&gt;para&lt;/p&gt;&lt;BR/&gt;&lt; br /&gt;tail", 600, 0, 200, 80)
        + vertex("d", "plain with &quot;quotes&quot; and &apos;apostrophes&apos; and &lt;less", 900, 0, 200, 80)
        + vertex("e", "a very long label that has to be wrapped over several lines because it is long indeed", 0, 200, 90, 80)
        + vertex("f", "Wide", 300, 200, 300, 80, "fontSize=11.5;fontColor=#123456;")
        + vertex("h", "Huge font", 700, 200, 300, 80, "fontSize=1e7;")
        + vertex("i", "Bad font", 1100, 200, 300, 80, "fontSize=abc;")
        + vertex("j", "Big int font", 0, 400, 300, 80, "fontSize=100000;")
        + vertex("k", "Small", 400, 400, 300, 80, "fontSize=0.00001;")
    ),
    "user_objects": model_of(
        '<UserObject label="Wrapped &lt;b&gt;label&lt;/b&gt;" id="u1"><mxCell style="rounded=1;" vertex="1" parent="1">'
        '<mxGeometry x="10" y="10" width="100" height="50" as="geometry"/></mxCell></UserObject>'
        '<object label="Object label" id="u2"><mxCell vertex="1" parent="1">'
        '<mxGeometry x="200" y="10" width="100" height="50" as="geometry"/></mxCell></object>'
        '<UserObject id="u3" label=""><mxCell edge="1" parent="1" source="u1" target="u2"/></UserObject>'
        '<UserObject id="u4"/>'
    ),
    "entities_and_cdata": model_of(
        '<mxCell id="a" value="&amp;amp; &#65;&#x42; &lt;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>'
        '<mxCell id="b" vertex="1" parent="1"><mxGeometry x="200" y="0" width="80" height="40" as="geometry"/>'
        "<![CDATA[ignored <b>text</b>]]></mxCell>"
    ),
    "comments_and_pi": (
        '<?xml version="1.0" encoding="UTF-8"?><!-- lead --><?pi data?>'
        '<mxfile><!-- c --><diagram name="P"><!-- d --><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>'
        + vertex("a", "A")
        + "</root></mxGraphModel></diagram></mxfile><!-- trail -->"
    ),
    "dtd": '<!DOCTYPE mxfile><mxfile><diagram><mxGraphModel><root/></mxGraphModel></diagram></mxfile>',
    "dtd_entity": BAD_DOC,
    "entity_bomb": (
        '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">'
        '<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]><mxfile><diagram>&lol3;</diagram></mxfile>'
    ),
    "dtd_system": '<!DOCTYPE mxfile SYSTEM "http://evil.example/x.dtd"><mxfile/>',
    "dtd_public": '<!DOCTYPE mxfile PUBLIC "-//W3C//DTD//EN" "http://evil.example/x.dtd"><mxfile/>',
    "external_entity_ref": '<mxfile><diagram>&xxe;</diagram></mxfile>',
    "parameter_entity": '<!DOCTYPE x [<!ENTITY % p SYSTEM "file:///etc/passwd"> %p;]><x/>',
    "encoding_latin1": '<?xml version="1.0" encoding="ISO-8859-1"?>' + drawio("Café", "naïve"),
    "encoding_utf16": '<?xml version="1.0" encoding="UTF-16"?>' + drawio("A"),
    "encoding_bogus": '<?xml version="1.0" encoding="bogus"?>' + drawio("A"),
    "bom": "﻿" + drawio("A"),
    "empty_file": "",
    "whitespace_only": "  \n\t ",
    "no_page": "<mxfile/>",
    "no_page_other_children": "<mxfile><note/></mxfile>",
    "empty_page": "<mxfile><diagram name='E'></diagram></mxfile>",
    "blank_page_text": "<mxfile><diagram name='E'>   \n  </diagram></mxfile>",
    "wrong_root": "<html/>",
    "not_xml": "not xml",
    "mismatched": "<mxfile><diagram></mxfile>",
    "unclosed": "<mxfile><diagram>",
    "bare_model_no_root": "<mxGraphModel/>",
    "bare_model_empty_root": "<mxGraphModel><root/></mxGraphModel>",
    "root_without_ids": "<mxGraphModel><root>" + vertex("a", "A") + "</root></mxGraphModel>",
    "namespaced": (
        '<mxfile xmlns="http://example.org/ns" xmlns:x="http://example.org/x"><diagram name="NS"><mxGraphModel><root>'
        '<mxCell id="0"/><mxCell id="1" parent="0"/>'
        '<mxCell id="a" value="ns" vertex="1" parent="1" x:extra="1"><mxGeometry x="0" y="0" width="50" height="30" as="geometry"/></mxCell>'
        "</root></mxGraphModel></diagram></mxfile>"
    ),
    "unbound_prefix": '<mxfile><x:diagram/></mxfile>',
    "duplicate_attribute": '<mxfile a="1" a="2"/>',
    "two_pages_no_name": "<mxfile><diagram><mxGraphModel><root/></mxGraphModel></diagram><diagram><mxGraphModel><root/></mxGraphModel></diagram></mxfile>",
    "page_name_empty": '<mxfile><diagram name=""><mxGraphModel><root/></mxGraphModel></diagram></mxfile>',
    "geometry_missing": model_of('<mxCell id="a" value="No geometry" vertex="1" parent="1"/>'),
    "geometry_defaults": model_of(
        '<mxCell id="a" value="d1" vertex="1" parent="1"><mxGeometry as="geometry"/></mxCell>'
        '<mxCell id="b" value="d2" vertex="1" parent="1"><mxGeometry x="" y="" width="" height="" as="geometry"/></mxCell>'
    ),
    "geometry_rounding": model_of(
        "".join(
            vertex(f"r{i}", f"v{i}", x, y, w, h)
            for i, (x, y, w, h) in enumerate(
                [
                    (0.25, 0.35, 12.349, 99.95),
                    (0.05, 0.15, 0.45, 0.55),
                    ("1e2", " 5 ", "1_0", "+7.5"),
                    (-0.04, -0.06, -1.25, 1e-9),
                    (1234567.891, 0.123456789, 33.33333, 66.66666),
                    (".5", "5.", "-.5", "00012"),
                    ("2.675", "1.005", "0.125", "0.375"),
                ]
            )
        )
    ),
    "geometry_not_a_number": model_of(vertex("a", "bad", "abc", 0)),
    "geometry_not_a_number_w": model_of(vertex("a", "bad", 0, 0, "wide", 10)),
    "geometry_nan_text": model_of(vertex("a", "bad", "1,5", 0)),
    "waypoint_bad": model_of(
        vertex("a", "A", 0, 0) + vertex("b", "B", 300, 0)
        + '<mxCell id="e" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"><Array as="points">'
        '<mxPoint x="x" y="y"/><mxPoint x="150" y="100"/><mxPoint/></Array></mxGeometry></mxCell>'
    ),
    "duplicate_ids": model_of(vertex("a", "A", 0, 0) + vertex("a", "A again", 300, 0) + edge("a", "a", "a", "loop") + edge("", "a", "a")),
    "edge_without_id": model_of(vertex("a", "A") + '<mxCell edge="1" parent="1" source="a" target="zz"/>'),
    "overlaps": model_of("".join(vertex(f"o{i}", f"S{i}", i * 20, 0, 100, 100) for i in range(9))),
    "overlaps_on_purpose": model_of(
        vertex("big", "Big", 0, 0, 400, 300)
        + vertex("chip", "1", 10, 10, 30, 30)
        + vertex("inside", "Inside", 100, 100, 300, 200)
        + vertex("same1", "same", 500, 0, 100, 100)
        + vertex("same2", "same", 550, 0, 100, 100)
        + vertex("txt", "text", 520, 20, 100, 100, "text;")
    ),
    "overlap_different_parents": model_of(
        vertex("g", "G", 0, 0, 300, 300, "swimlane;")
        + vertex("a", "A", 10, 10, 100, 100, "", parent="g")
        + vertex("b", "B", 50, 50, 100, 100, "", parent="1")
    ),
    "style_corner_cases": model_of(
        vertex("a", "k", 0, 0, 80, 40, "ellipse")
        + vertex("b", "k", 100, 0, 80, 40, ";;rhombus=1;;")
        + vertex("c", "k", 200, 0, 80, 40, "shape=;rounded=1")
        + vertex("d", "k", 300, 0, 80, 40, "rounded=0")
        + vertex("e", "k", 400, 0, 80, 40, "shape=tableau;")
        + vertex("f", "k", 500, 0, 80, 40, "fillColor=&lt;x&quot;&amp;;strokeColor=#&amp;;")
    ),
}
many = "".join(vertex(f"m{i}", f"Shape {i}", (i % 20) * 100, (i // 20) * 100) for i in range(305))
many += "".join(edge(f"me{i}", f"m{i}", f"m{i + 1}", f"l{i}") for i in range(305))
SOURCES["truncated_305"] = model_of(many)
SOURCES["cells_limit_ok"] = "<mxGraphModel><root>" + "".join(f'<mxCell id="c{i}"/>' for i in range(1998)) + "</root></mxGraphModel>"
SOURCES["cells_limit_over"] = "<mxGraphModel><root>" + "".join(f'<mxCell id="c{i}"/>' for i in range(2001)) + "</root></mxGraphModel>"


def case(name: str, source: str) -> dict:
    d = {"name": name, "source": source}
    d["model"] = run(dm.model, source)
    d["model_limit_2"] = run(dm.model, source, 2)
    d["render_svg"] = run(dm.render_svg, source)
    d["uncompressed"] = dm.uncompressed(source)
    d["sanitize_svg"] = run(dg.sanitize_svg, source)
    d["validate_source"] = run(lambda s: dg.validate_source(s).tag, source)
    d["text_summary"] = run(lambda s: dg.text_summary(dg.validate_source(s)), source)
    d["is_empty"] = run(lambda s: dg.is_empty(dg.validate_source(s)), source)
    return d


# --- the XML reader and writer on their own -----------------------------------------------------------------------


def tree(el) -> dict:
    return {
        "tag": el.tag,
        "attrib": [[k, v] for k, v in el.attrib.items()],
        "text": el.text,
        "tail": el.tail,
        "children": [tree(c) for c in el],
    }


XML_CASES = [
    "", "not xml", "<a>", "<a><b></a>", "<a/><b/>", "<a b=1/>", "<a b='1' b='2'/>", "<a>&foo;</a>", "<a>&#0;</a>",
    "<a>&#xD800;</a>", "<a>&amp</a>", "<a>&;</a>", "<a><</a>", "<a b='<'/>", "<a b/>", "<a b=/>", "<a b='x/>",
    "  <?xml version='1.0'?><a/>", "<?xml version='1.0'?><a/>x", "<?xml version='1.0' encoding='ISO-8859-1'?><a>é</a>",
    "<?xml version='2.0'?><a/>", "<?xml?><a/>", "<a></b>", "</a>", "<a><!-- x --></a>", "<a><!-- x -- y --></a>",
    "<a><![CDATA[x</a>", "<a>]]></a>", "<a x:y='1'/>", "<x:a xmlns:x='u'/>", "<a xmlns='u'><b/></a>", "<a>\x01</a>",
    "<a>￾</a>", "<!DOCTYPE a><a/>", "<!DOCTYPE a [<!ENTITY x 'y'>]><a/>", "<!DOCTYPE a SYSTEM 'x.dtd'><a/>",
    "<!DOCTYPE a PUBLIC 'p' 's'><a/>", "<a>\n<b>\n</c></a>", "<a b='1'c='2'/>", "<1a/>", "<a 1b='1'/>", "<a>text", "<a",
    "<a b", "<a b=", "<a b='", "<a><b/", "<?pi", "<!-- c", "<!x>", "<a/>  <!-- c -->  ", "<a/><?pi x?>", "<a/>\n\n junk",
    "﻿<a/>", "<?xml version='1.0'?>\n<?xml version='1.0'?><a/>", "<a>&#x110000;</a>", "<a>&#65;&#x42;</a>",
    "<a xmlns:x='u' x:b='1' x:b='2'/>", "<a xmlns:x='u' xmlns:y='u' x:b='1' y:b='2'/>", "<a:b:c/>", "<a: />", "<:a/>",
    "<a xmlns:xml='u'/>", "<a xmlns:x=''/>", "<a xmlns:xmlns='u'/>", "<a\tb='1'/>", "<a b = '1' />", "<a b='1' / >",
    "<a></a >", "<a></ a>", "<a>\r\n</a>", "<a b='x\ny\r\nz\tw'/>", "<a>>]]></a>", "<a><b></b><b></a>", "<a>é&#x1F600;</a>",
    "<a>\U0001f600\x00</a>", "<?xml version='1.0' standalone='yes'?><a/>", "<?xml version='1.0' encoding=''?><a/>",
    "<?xml encoding='utf-8' version='1.0'?><a/>", "<?xml version='1.0' encoding='utf-16'?><a/>",
    "<?xml version='1.0' encoding='bogus'?><a/>", '<?xml version="1.0" encoding="UTF-8" ?><a/>',
    "<a>x<!--c-->y<?p q?>z<b/>t1<!--c-->t2<![CDATA[t3]]>t4</a>tail", "<a><b/>x<c/>y</a>", "<a>  <b/>  </a>",
    "<a><![CDATA[]]></a>", "<a><![CDATA[<&>]]>&amp;</a>", "<a b='&lt;&amp;&#65;&quot;'/>", "<a b=\"it's\" c='say \"hi\"'/>",
    "<a xmlns='u' xmlns:p='v' p:q='1' r='2'><p:b/><c xmlns=''/></a>", "<xml:a/>", "<a xml:lang='en'/>",
    "<a xmlns:xml='http://www.w3.org/XML/1998/namespace'/>", "<a><b>1</b><b>2</b></a>", "<é:a xmlns:é='u'/>", "<日本語 属性='1'>テキスト</日本語>",
    "<a b='&foo;'/>", "<a b='&#0;'/>", "<a b='&'/>", "<a>&#;</a>", "<a>&#x;</a>", "<a>&#12a;</a>", "<a>& </a>",
    "<a><![CDATA[x]]", "<a><![CDAT[x]]></a>", "<a><!x></a>", "<a><!</a>", "<a><?></a>", "<a><?1 x?></a>", "<a><?pi?></a>",
    "<a><?pi x</a>", "<a><?xml version='1.0'?></a>", "<a><?XML x?></a>", "<a/><!x>", "<a/><a/>", "<a/>&amp;",
    "<a></a><", "<a>", "<a>\n  ", "\n\n<a><b>\n</a>", "<a b='1'", "<a b='1' c", "<a / >", "<a/ >", "<a b='1' / >",
    "<a b=\"1\">", "<a b=\"1\"", "<a\n b='1'\n c='2'\n d>", "<a>\n\r\n\r</a>x", "<a>\rx</a><b/>", "<a><b></c></b></a>",
    "<a x='1' x='1'/>", "<a x:y='1' xmlns:x='u' xmlns:z='u' z:y='2'/>", "<a xmlns:p='http://www.w3.org/XML/1998/namespace'/>",
    "<a xmlns:p='http://www.w3.org/2000/xmlns/'/>", "<a xmlns='http://www.w3.org/XML/1998/namespace'/>",
    "<!-- only a comment -->", "<?pi only?>", "<?xml version='1.0'?>", "<!DOCTYPE", "<!DOCTYPE a", "<!DOCTYPE a [",
    "<!DOCTYPE 1>", "<!DOCTYPE a SYSTEM x>", "<!doctype a><a/>", "<!ENTITY a 'b'><a/>", "<?xml version='1.0'?><!DOCTYPE a><a/>",
    "<a>\x00</a>", "<a b='\x01'/>", "<a>\x7f</a>", "<a>\x0b</a>", "<a>\u0085</a>", "<a> </a>",
]


def mutations() -> list[str]:
    """Truncations, deletions and insertions on a small document, to compare where expat reports each error."""
    base = (
        "<?xml version='1.0' encoding='UTF-8'?>\n<!-- c -->\n<a xmlns:x=\"u\" k='v &amp; w'>t&#65;<![CDATA[d]]>"
        "<x:b y=\"1\"/><?pi q?>\n</a>\n<!-- e -->"
    )
    out = [base[:i] for i in range(1, len(base))]
    for i in range(0, len(base), 3):
        out.append(base[:i] + base[i + 1 :])
    for i in range(0, len(base), 5):
        for ch in ("<", "&", "'", "\"", ">", ":", "\x00", "]"):
            out.append(base[:i] + ch + base[i:])
    return out


def xml_case(text: str) -> dict:
    out: dict = {"source": text}
    try:
        root = SafeET.fromstring(text, forbid_dtd=True)
    except Exception as e:  # noqa: BLE001
        out["error"] = str(e)
        return out
    out["tree"] = tree(root)
    import xml.etree.ElementTree as ET

    out["tostring"] = ET.tostring(root, encoding="unicode")
    return out


def xml_write_cases() -> list[dict]:
    import xml.etree.ElementTree as ET

    texts = [
        "<a x=\"1&amp;2\"><b/>t<c>x&lt;&gt;&amp;</c>tail</a>",
        "<a b='\t\r\n&quot;&lt;&gt;&amp;'>\r\n</a>",
        "<r xmlns='u'><a/><b xmlns='v'/></r>",
        "<r xmlns:x='u' xmlns:y='v' x:a='1' y:b='2'><x:c/><y:d/></r>",
        "<svg xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink'><a xlink:href='#x'/></svg>",
        "<r xml:lang='en' xmlns:h='http://www.w3.org/1999/xhtml'><h:p/></r>",
        "<r xmlns:dc='http://purl.org/dc/elements/1.1/'><dc:title>t</dc:title></r>",
        "<r xmlns:q='urn:q' xmlns:z='urn:z'><q:a z:b='1'/><z:c/></r>",
    ]
    out = []
    for text in texts:
        root = SafeET.fromstring(text, forbid_dtd=True)
        out.append({"source": text, "tostring": ET.tostring(root, encoding="unicode")})
    return out


# --- small pure helpers --------------------------------------------------------------------------------------------

UNQUOTE = ["", "abc", "%41%42", "%C3%A9", "%C3", "%C3a", "%", "%4", "%zz", "a%20b", "é%41é", "%E2%82%AC", "%F0%9F%98%80", "%ff%fe", "100%"]
FLOATS = ["1", " 2.5 ", "1e3", "1_0", "1__0", "_1", "1_", "+3", "-.5", "5.", ".", "", "abc", "inf", "-Infinity", "nan", "+nan", "--1", "1e", "0x10", "١٢", "1,5", "\t7\n"]
UNESCAPE = [
    "plain", "&lt;b&gt;", "&amp;amp;", "&nbsp;x", "&#65;&#x42;&#X43;", "&#0;", "&#128;", "&#xD800;", "&#x110000;", "&#1;", "&#65", "&copy", "&copy;",
    "&notit;", "&notin;", "&foo;", "&foo", "&", "&&amp;", "&#;", "&lt", "&ltx", "&AMP;", "&Amp;", "&#x41;;", "&amp;lt;", "caf&eacute; &hellip;",
    "&" + "a" * 40 + ";", "&#99999999999999999999;", "&#x1F600;",
]
PLAIN = [
    "", "plain", "<b>bold</b>", "a<br>b", "a<BR/>b", "a< br />b", "<p>x</p><p>y</p>", "<div>x</div>", "<div>x</div><div>y</div>", "&lt;b&gt;",
    "  padded  ", "<span style='a>b'>x</span>", "<" + "a" * 250 + ">kept", "a &amp; b &nbsp; c", "x<br >y", "<\nbr>z",
]
STYLES = [
    ("", "k"), ("a=1;b=2", "a"), ("a=1;b=2", "b"), ("a=;b=2", "a"), ("a;b=2", "a"), ("a=1=2", "a"), ("=1", ""), ("a=1;a=2", "a"), (" a=1", "a"),
]


def helpers() -> dict:
    return {
        "unquote": [[s, urllib.parse.unquote(s)] for s in UNQUOTE],
        "float": [[s, run(lambda x: repr(float(x)), s)] for s in FLOATS if not s.startswith("١")],
        "unescape": [[s, html.unescape(s)] for s in UNESCAPE],
        "plain": [[s, dm.plain(s)] for s in PLAIN],
        "style_get": [[a, b, dm.style_get(a, b)] for a, b in STYLES],
        "b64": [
            [s, run(lambda x: base64.b64decode(x).hex(), s)]
            for s in ["", "QUJD", "QUJDRA==", "QUJDRA=", "QUJDR", "QUJ", "Q", "QU JD\nRA==", "QUJD====", "=QUJD", "QU=JD", "QUJDRA==QUJD", "é", "QUJD!!!", "@@@@"]
        ],
        "round1": [[v, round(v, 1)] for v in [0.25, 0.35, 0.05, 0.15, 2.675, -0.25, -0.04, 1e15 + 0.3, 0.45, 0.55, 12.349, 99.95, 5e-324]],
        "fmt_g": [[v, f"{v:g}"] for v in [12.0, 11.5, 1e7, 1e-5, 100000.0, 123456.7, 1234567.0, 0.0001, 0.00001234, 1.5e300, 0.1, 100.0, 99999.95, 999999.5, 1e6, 5e-5]],
        "fmt_f": [[v, f"{v:.1f}", f"{v:.0f}"] for v in [0.25, 0.35, 0.05, 2.5, 3.5, 0.5, 1.5, -0.5, -0.04, 12.349, 1e15, 0.125, 1234.55]],
        "label": [[s, dg._label(s)] for s in [None, "", "  x  ", "a[b]c", "a\nb\r\nc", "[[]]", "x" * 300, "ü" * 250]],
        "refs_in": [[s, dg.refs_in(s)] for s in ["", "[a](diagram:dg_0123abcd) ![b](diagram:dg_0123abcd) [c](diagram:dg_deadbeef) (diagram:zz)", "(diagram:dg_0123ABCD)", "(diagram:dg_0123abcde)"]],
        "parse_pins": [[s, dg.parse_pins(s)] for s in [None, "", "{}", '{"dg_a": 1, "dg_b": "2", "dg_c": true, "dg_d": 1.5}', "[1]", "nope", '{"a": 3}']],
        "forbid_dtd": [[s, run(dg._forbid_dtd, s, "diagram file")] for s in ["<a/>", "<!DOCTYPE a><a/>", "  \n<!doctype a>", "<a><!entity x></a>", "<a><![CDATA[<!ENTITY x>]]></a>", " " * 5000 + "<!DOCTYPE a>", "x" * 5000 + "<!DOCTYPE"]],
    }


SVGS = {
    "clean": '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
    "dirty": (
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="x()">'
        '<script>alert(1)</script><a xlink:href="javascript:alert(1)"><rect onclick="y()" width="1"/></a>'
        '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">label</div></foreignObject></svg>'
    ),
    "href_variants": (
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">'
        '<a href=" JavaScript:x"/><a href="data:text/html,<b>"/><a xlink:href="data:text/html;base64,AA"/>'
        '<a href="https://ok.example/"/><a xlink:href="#local"/><a HREF="javascript:y"/></svg>'
    ),
    "handlers": '<svg xmlns="http://www.w3.org/2000/svg"><rect OnClick="a()" onmouseover="b()" one="keep" width="1"/></svg>',
    "nested_bad": (
        '<svg xmlns="http://www.w3.org/2000/svg"><g><script/><iframe/><object><embed/></object><g><embed/><text>keep</text></g></g>'
        "<script>tail</script>after</svg>"
    ),
    "tails_and_text": '<svg xmlns="http://www.w3.org/2000/svg"><text>a &amp; b &lt; c &gt; d "q" \'s\'</text>tail &amp; more<g/></svg>',
    "attr_escapes": '<svg xmlns="http://www.w3.org/2000/svg" data-a="x &amp; y &lt; &quot; &#10; &#9; &#13;" fill="none"/>',
    "no_namespace": '<svg width="1"><rect/></svg>',
    "other_namespaces": (
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:q="urn:q"><metadata><dc:title>t</dc:title></metadata>'
        '<g inkscape:label="L" q:x="1"/></svg>'
    ),
    "xhtml_default": '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><p xmlns="http://www.w3.org/1999/xhtml">x<br/></p></foreignObject></svg>',
    "xml_prefix": '<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve"><text xml:lang="en">x</text></svg>',
    "wrong_root": "<div/>",
    "svg_in_ns": '<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:rect/></s:svg>',
    "not_xml": "<svg",
    "dtd": '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>',
    "entity_in_body": '<svg xmlns="http://www.w3.org/2000/svg"><text><!ENTITY x "y"></text></svg>',
    "empty_with_text": '<svg xmlns="http://www.w3.org/2000/svg"><g></g><g> </g><g>0</g></svg>',
}


def make_png(width: int, height: int) -> bytes:
    import struct

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    raw = b"".join(b"\x00" + b"\xff\xff\xff\xff" * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


SKETCH_SOURCES = [
    b"", b"{", b"{}", b"[]", b"null", b"1", b'"x"', b"{nope", b'{"a":1,}', b"[1,]", b'{"a" 1}', b'{"a":1 "b":2}', b'{"a":"x',
    b'{"a":"\\q"}', b'{"a":"\\u12"}', b'{"a":"\x01"}', b"{\"a\": 1} x", b"  ", b"\xef\xbb\xbf{}", b"\xff", b"{\"a\": \"\xc3\"}",
    b"{\"a\": \"\xe2\x82\"}", b"\xc3\x28", b"\xe2\x82\x28", b"[NaN]", b"nul", b"tru", b"-", b"-x", b"01", b"1.", b'{"format":"kanban-sketch","version":1,"layers":[{}],"width":8,"height":6}',
    b'{"format":"kanban-sketch","version":1.0,"layers":[{}],"width":8.0,"height":6}',
    b'{"format":"kanban-sketch","version":true,"layers":[{}],"width":8,"height":6}',
    b'{"format":"kanban-sketch","version":"1","layers":[{}],"width":8,"height":6}',
    b'{"format":"kanban-sketch","version":[1,{"a":null}],"layers":[{}],"width":8,"height":6}',
    b'{"format":"kanban-sketch","version":2.5,"layers":[{}],"width":8,"height":6}',
    b'{"format":"kanban-sketch","version":1e2,"layers":[{}],"width":8,"height":6}',
    b'{"format":"kanban-sketch","layers":[{}],"width":8,"height":6}',
    b'{"format":"kanban-sketch","version":1,"layers":[],"width":8,"height":6}',
    b'{"format":"kanban-sketch","version":1,"layers":{},"width":8,"height":6}',
    b'{"format":"kanban-sketch","version":1,"layers":[{}],"width":"8","height":6}',
    b'{"format":"kanban-sketch","version":1,"layers":[{}],"width":8,"height":7}',
    b'{"format":"kanban-sketch","version":1,"layers":[{}],"height":6}',
    b'{"format":"other","version":1,"layers":[{}],"width":8,"height":6}',
    b'{"version":1,"layers":[{}],"width":8,"height":6,"format":"kanban-sketch","format":"x"}',
    b'{"format":"kanban-sketch","version":1,"layers":[{},{},{},{},{},{},{},{},{},{},{}],"width":8,"height":6}',
    b'{"format":"kanban-sketch","version":1,"layers":[1,2],"width":8,"height":6,"pad":"\xc3\xa9\\ud83d\\ude00"}',
    b' \n\t{"format":"kanban-sketch","version":1,"layers":[{}],"width":8,"height":6}\r\n',
    b'{"format":"kanban-sketch"\n,\n"version":1\n\n\n  "layers":[]}',
]


def sketch_cases() -> dict:
    png = make_png(8, 6)
    out = {"png_hex": png.hex(), "validate": [], "png_size": [], "flat_source": sk.flat_source(png).decode()}
    for src in SKETCH_SOURCES:
        out["validate"].append({"source_hex": src.hex(), **run(sk.validate, png, src)})
    for blob in [b"", b"x" * 40, png[:32], png[:33], png, b"\x89PNG\r\n\x1a\n" + b"\0" * 4 + b"IHDX" + b"\0" * 20, make_png(4097, 1)[:200], make_png(0, 0)]:
        out["png_size"].append({"hex": blob.hex(), **run(lambda b: list(sk.png_size(b)), blob)})
    out["flat_source_error"] = run(sk.flat_source, b"nope")
    out["titles"] = [[t, sk._title(t), sk._title(t, "Fb")] for t in [None, "", "  a[b]c\n", "x" * 300, "é" * 250, "[[]]"]]
    return out


def main() -> None:
    cases = [case(n, s) for n, s in SOURCES.items()]
    svg_cases = [{"name": n, "svg": s, "sanitize_svg": run(dg.sanitize_svg, s)} for n, s in SVGS.items()]
    data = {
        "cases": cases,
        "svg_cases": svg_cases,
        "xml": [xml_case(t) for t in XML_CASES + mutations()],
        "xml_write": xml_write_cases(),
        "helpers": helpers(),
        "sketch": sketch_cases(),
    }
    OUT.write_text(json.dumps(data, ensure_ascii=True, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes; {len(cases)} cases, {len(XML_CASES)} xml)")


main()
