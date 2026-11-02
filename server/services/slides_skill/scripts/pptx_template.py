"""Make a deck in a person's own template: the same theme, masters, layouts and way of laying out a slide.

    pip install python-pptx
    python pptx_template.py inventory template.pptx > inventory.json     # what the template has
    python pptx_template.py build template.pptx outline.json -o deck.pptx

`inventory` lists the theme's colours and fonts, every layout with its placeholders (idx, type, name, box) and every
slide already in the template with its shapes and their text. Look at the template rendered to pictures too (the
skill says how): the inventory tells you names, the pictures tell you the look.

`build` opens the template itself, so its theme, masters and layouts carry over, adds the slides of the outline and
removes the template's own slides (unless `"keep_template_slides": true`). The outline is JSON:

    {"slides": [
      {"layout": "Title Slide", "fill": {"title": "Q3 in one sentence", "subtitle": "Board meeting, 12 Nov"}},
      {"layout": 1, "fill": {"0": "A title", "1": ["A point", {"text": "a sub-point", "level": 1}]},
       "notes": "What to say"},
      {"copy": 4, "replace": {"Title 1": "Revenue grew 18%", "Picture 3": {"image": "chart.png"},
                              "Chart 2": {"chart": {"categories": ["Q1", "Q2"], "series": {"Revenue": [12, 14]}}}}}
    ]}

- `layout`: a layout's name or index. `fill` keys: a placeholder's idx (as a string), its name, or its type
  (`title`, `subtitle`, `body`, `picture`...). A placeholder left out is removed, so no "Click to add text" is left.
- `copy`: the number (from 1) of one of the template's own slides, duplicated with everything on it (its pictures,
  charts, tables, decoration); `replace` keys are shape names from the inventory.
- A value is text, a list of paragraphs (a string, or `{"text", "level", "bold"}`), `{"image": path}` (fitted into the
  box, cropped to fill it), `{"chart": {...}}` (new data for the chart, its style kept) or `{"table": [[...], ...]}`.
Replaced text keeps the look of the text it replaces (the first run's font, size, colour).
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path

from lxml import etree
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.opc.package import Part
from pptx.oxml.ns import qn
from pptx.parts.chart import ChartPart
from pptx.util import Emu

_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def _box(shape) -> dict:
    def inch(v):
        return round(Emu(v or 0).inches, 2)

    return {
        "x": inch(shape.left),
        "y": inch(shape.top),
        "w": inch(shape.width),
        "h": inch(shape.height),
    }


def _theme(prs) -> dict:
    """The theme's colours and fonts, read from the first master's theme part."""
    master = prs.slide_masters[0]
    for rel in master.part.rels.values():
        if rel.reltype == RT.THEME:
            root = etree.fromstring(rel.target_part.blob)
            colors = {}
            scheme = root.find(f".//{{{_A}}}clrScheme")
            for el in scheme if scheme is not None else []:
                v = el[0].get("val") or el[0].get("lastClr")
                colors[etree.QName(el).localname] = v
            fonts = {}
            for kind in ("majorFont", "minorFont"):
                f = root.find(f".//{{{_A}}}{kind}/{{{_A}}}latin")
                if f is not None:
                    fonts["headings" if kind == "majorFont" else "body"] = f.get(
                        "typeface"
                    )
            return {"colors": colors, "fonts": fonts}
    return {}


def _ph_type(ph) -> str:
    return str(ph.placeholder_format.type).split(".")[-1].split(" ")[0].lower()


def inventory(path: Path) -> dict:
    """Everything a deck in this template is made from."""
    prs = Presentation(path)
    layouts = []
    for i, lay in enumerate(prs.slide_layouts):
        layouts.append(
            {
                "index": i,
                "name": lay.name,
                "placeholders": [
                    {
                        "idx": ph.placeholder_format.idx,
                        "type": _ph_type(ph),
                        "name": ph.name,
                        **_box(ph),
                    }
                    for ph in lay.placeholders
                ],
            }
        )
    slides = []
    for n, s in enumerate(prs.slides, 1):
        shapes = []
        for sh in s.shapes:
            item = {
                "name": sh.name,
                "kind": str(sh.shape_type).split(".")[-1].split(" ")[0].lower(),
                **_box(sh),
            }
            if sh.is_placeholder:
                item["placeholder"] = {
                    "idx": sh.placeholder_format.idx,
                    "type": _ph_type(sh),
                }
            if sh.has_text_frame and sh.text_frame.text.strip():
                item["text"] = sh.text_frame.text[:300]
                runs = [r for p in sh.text_frame.paragraphs for r in p.runs]
                if runs and runs[0].font.size:
                    item["size_pt"] = runs[0].font.size.pt
            if getattr(sh, "has_chart", False) and sh.has_chart:
                c = sh.chart
                item["chart"] = {
                    "type": str(c.chart_type).split(".")[-1].split(" ")[0],
                    "categories": [str(x) for x in c.plots[0].categories],
                    "series": [ser.name for ser in c.series],
                }
            if getattr(sh, "has_table", False) and sh.has_table:
                item["table"] = [
                    [cell.text for cell in row.cells] for row in sh.table.rows
                ][:6]
            shapes.append(item)
        notes = s.notes_slide.notes_text_frame.text if s.has_notes_slide else ""
        slides.append(
            {
                "number": n,
                "layout": s.slide_layout.name,
                "shapes": shapes,
                "notes": notes[:300],
            }
        )
    return {
        "size_in": [
            round(Emu(prs.slide_width).inches, 3),
            round(Emu(prs.slide_height).inches, 3),
        ],
        "theme": _theme(prs),
        "layouts": layouts,
        "slides": slides,
    }


# --- filling -----------------------------------------------------------------------------------------------------


def _set_text(shape, value) -> None:
    """Replace the text of ``shape`` keeping the look of its first run (and each level's paragraph style)."""
    tf = shape.text_frame
    first_r = next((r for p in tf.paragraphs for r in p.runs), None)
    rpr = copy.deepcopy(first_r._r.find(qn("a:rPr"))) if first_r is not None else None
    ppr = tf.paragraphs[0]._p.find(qn("a:pPr"))
    ppr = copy.deepcopy(ppr) if ppr is not None else None
    paras = value if isinstance(value, list) else [value]
    txbody = tf._txBody
    for p in list(txbody.findall(qn("a:p"))):
        txbody.remove(p)
    for item in paras:
        item = {"text": item} if isinstance(item, str) else item
        p = etree.SubElement(txbody, qn("a:p"))
        if ppr is not None:
            p.append(copy.deepcopy(ppr))
        if item.get("level"):
            pp = p.find(qn("a:pPr"))
            if pp is None:
                pp = etree.Element(qn("a:pPr"))
                p.insert(0, pp)
            pp.set("lvl", str(item["level"]))
        r = etree.SubElement(p, qn("a:r"))
        if rpr is not None:
            r.append(copy.deepcopy(rpr))
        if item.get("bold") is not None:
            rp = r.find(qn("a:rPr"))
            if rp is None:
                rp = etree.SubElement(r, qn("a:rPr"))
                r.remove(rp)
                r.insert(0, rp)
            rp.set("b", "1" if item["bold"] else "0")
        t = etree.SubElement(r, qn("a:t"))
        t.text = item["text"]


def _set_image(slide, shape, path: str) -> None:
    """Put a picture into ``shape``'s box, cropped to fill it (a picture placeholder takes it directly)."""
    from PIL import Image

    if shape.is_placeholder and _ph_type(shape) == "picture":
        pic = shape.insert_picture(path)
        return pic
    x, y, w, h = shape.left, shape.top, shape.width, shape.height
    iw, ih = Image.open(path).size
    pic = slide.shapes.add_picture(path, x, y, w, h)
    box, img = w / h, iw / ih
    if img > box:  # wider: crop the sides
        c = (1 - box / img) / 2
        pic.crop_left = pic.crop_right = c
    else:
        c = (1 - img / box) / 2
        pic.crop_top = pic.crop_bottom = c
    # keep the stacking order: the picture goes where the shape was
    shape._element.addprevious(pic._element)
    shape._element.getparent().remove(shape._element)
    return pic


def _set_chart(shape, spec: dict) -> None:
    data = CategoryChartData()
    data.categories = spec["categories"]
    for name, values in spec["series"].items():
        data.add_series(name, values)
    shape.chart.replace_data(data)


def _set_table(shape, rows: list[list]) -> None:
    table = shape.table
    for r, row in enumerate(rows[: len(table.rows)]):
        for c, value in enumerate(row[: len(table.columns)]):
            cell = table.cell(r, c)
            _set_text(cell, str(value)) if cell.text_frame.paragraphs[
                0
            ].runs else setattr(cell, "text", str(value))


def _fill(slide, shape, value) -> None:
    if isinstance(value, dict) and "image" in value:
        _set_image(slide, shape, value["image"])
    elif isinstance(value, dict) and "chart" in value:
        _set_chart(shape, value["chart"])
    elif isinstance(value, dict) and "table" in value:
        _set_table(shape, value["table"])
    else:
        _set_text(shape, value)


def _layout(prs, key):
    for i, lay in enumerate(prs.slide_layouts):
        if (isinstance(key, int) and i == key) or lay.name == key:
            return lay
    names = [lay.name for lay in prs.slide_layouts]
    raise SystemExit(f"No layout {key!r}; the template has: {names}")


def _from_layout(prs, spec: dict):
    slide = prs.slides.add_slide(_layout(prs, spec["layout"]))
    fill = {str(k): v for k, v in (spec.get("fill") or {}).items()}
    for ph in list(slide.placeholders):
        kind = _ph_type(ph)
        # a title slide's title is a "center_title": "title" finds it too
        keys = (str(ph.placeholder_format.idx), ph.name, kind, "title" if kind == "center_title" else kind)
        value = next((fill[k] for k in keys if k in fill), None)
        if value is None:
            ph._element.getparent().remove(
                ph._element
            )  # no empty "Click to add text" left behind
        else:
            _fill(slide, ph, value)
    return slide


def _clone(prs, number: int):
    """A copy of the template's slide ``number`` at the end, with its own copy of each chart (pictures shared)."""
    src = prs.slides[number - 1]
    dst = prs.slides.add_slide(src.slide_layout)
    for ph in list(dst.placeholders):
        ph._element.getparent().remove(ph._element)
    rid_map = {}
    for rid, rel in src.part.rels.items():
        if rel.reltype in (RT.SLIDE_LAYOUT, RT.NOTES_SLIDE):
            continue
        if rel.is_external:
            rid_map[rid] = dst.part.relate_to(
                rel.target_ref, rel.reltype, is_external=True
            )
        elif rel.reltype == RT.CHART:
            rid_map[rid] = dst.part.relate_to(
                _copy_chart(prs, rel.target_part), rel.reltype
            )
        else:
            rid_map[rid] = dst.part.relate_to(rel.target_part, rel.reltype)
    tree = dst.shapes._spTree
    for el in src.shapes._spTree:
        if el.tag in (qn("p:nvGrpSpPr"), qn("p:grpSpPr")):
            continue
        new = copy.deepcopy(el)
        for node in new.iter():
            for attr, val in list(node.attrib.items()):
                if attr.startswith(f"{{{_R}}}") and val in rid_map:
                    node.set(attr, rid_map[val])
        tree.append(new)
    bg = src._element.find(qn("p:cSld")).find(qn("p:bg"))
    if bg is not None:
        dst._element.find(qn("p:cSld")).insert(0, copy.deepcopy(bg))
    return dst


def _copy_chart(prs, part):
    package = prs.part.package
    new = ChartPart.load(
        package.next_partname(ChartPart.partname_template),
        part.content_type,
        package,
        part.blob,
    )
    for rid, rel in part.rels.items():
        target = rel.target_part
        clone = Part(package.next_partname("/ppt/embeddings/Microsoft_Excel_Worksheet%d.xlsx"), target.content_type,
                     package, target.blob) if "package" in rel.reltype else target  # fmt: skip
        new_rid = new.relate_to(clone, rel.reltype)
        if new_rid != rid:
            for node in new._element.iter():
                for attr, val in list(node.attrib.items()):
                    if attr.startswith(f"{{{_R}}}") and val == rid:
                        node.set(attr, new_rid)
    return new


def _drop_slide(prs, slide) -> None:
    ids = prs.slides._sldIdLst
    for sid in list(ids):
        if prs.part.related_part(sid.get(qn("r:id"))) is slide.part:
            prs.part.drop_rel(sid.get(qn("r:id")))
            ids.remove(sid)


def build(template: Path, outline: dict, out: Path) -> Path:
    """Write ``out``: the outline's slides in ``template``'s theme and layouts."""
    prs = Presentation(template)
    originals = list(prs.slides)
    for spec in outline["slides"]:
        if "copy" in spec:
            slide = _clone(prs, int(spec["copy"]))
            names = {sh.name: sh for sh in slide.shapes}
            for name, value in (spec.get("replace") or {}).items():
                if name not in names:
                    raise SystemExit(
                        f"Slide {spec['copy']} has no shape {name!r}; it has: {list(names)}"
                    )
                _fill(slide, names[name], value)
        else:
            slide = _from_layout(prs, spec)
        if spec.get("notes"):
            slide.notes_slide.notes_text_frame.text = spec["notes"]
    if not outline.get("keep_template_slides"):
        for s in originals:
            _drop_slide(prs, s)
    prs.save(out)
    return out


def main() -> None:
    """Command line: inventory TEMPLATE, or build TEMPLATE OUTLINE -o OUT."""
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    i = sub.add_parser("inventory")
    i.add_argument("template", type=Path)
    b = sub.add_parser("build")
    b.add_argument("template", type=Path)
    b.add_argument("outline", type=Path)
    b.add_argument("-o", "--out", type=Path, default=Path("deck.pptx"))
    a = ap.parse_args()
    if a.cmd == "inventory":
        print(json.dumps(inventory(a.template), ensure_ascii=False, indent=1))
    else:
        print(build(a.template, json.loads(a.outline.read_text()), a.out))


if __name__ == "__main__":
    sys.exit(main())
