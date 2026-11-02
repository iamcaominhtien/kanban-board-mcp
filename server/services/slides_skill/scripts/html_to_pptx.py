"""Turn slides designed in HTML into a PowerPoint file whose text a person can still edit.

Design each slide as a 1280 x 720 page, then:

    pip install python-pptx playwright
    python html_to_pptx.py deck.html -o deck.pptx          # one file, one <section class="slide"> per slide
    python html_to_pptx.py slides/ -o deck.pptx            # or a folder of 01.html, 02.html, ...

What becomes what:
- Text (an element whose children are only text and inline tags) becomes a PowerPoint text box at the same place, in
  the same font, size, weight, colour, spacing and alignment.
- Everything else (grounds, shapes, SVG, gradients, pictures, CSS art) is drawn by the browser into one picture behind
  the text, so it looks the same everywhere.
- `data-pptx="picture"` on an element makes it a picture of its own (a person can move or swap it).
- `data-pptx="chart"` with `data-chart='{"type": "bar", "categories": [...], "series": {"ml": [...]}, "colors":
  [...], "labels": [...]}'` becomes a native chart a person can edit; draw nothing inside it.
- `<video src="...mp4" poster="...png">` becomes a video that plays in PowerPoint.
- `<aside class="notes">` becomes the speaker notes. `data-pptx="skip"` leaves an element out.

The browser is the system Chrome or Edge when there is one (no download), else Playwright's own Chromium
(`playwright install chromium`), or `--browser /path/to/chrome`. Fonts: the deck uses the font names the HTML asks for,
so ask for a font the reader has (see the skill's fonts list): PowerPoint does not carry a web font with it.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
from pathlib import Path

from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Pt

W_PX, H_PX = 1280, 720
EMU_PER_PX = (
    12192000 // W_PX
)  # 13.333 in wide: 1 px is 0.75 pt, the same ratio as a browser's 96 dpi

# Runs in the page: finds the text boxes, pictures, charts and videos of each slide, measured in CSS pixels
_EXTRACT = r"""
(slide) => {
  const INLINE = new Set(['SPAN','B','STRONG','I','EM','A','BR','SUP','SUB','SMALL','MARK','CODE','U','S','ABBR','TIME','DATA','Q','KBD']);
  const base = slide.getBoundingClientRect();
  const box = (el) => { const r = el.getBoundingClientRect(); return {x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height}; };
  const visible = (el) => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0.01; };
  const isText = (el) => {
    if (!el.textContent.trim()) return false;
    for (const c of el.childNodes) if (c.nodeType === 1 && !INLINE.has(c.tagName)) return false;
    return true;
  };
  const transform = (t, how) => how === 'uppercase' ? t.toUpperCase() : how === 'lowercase' ? t.toLowerCase() : t;
  const runStyle = (el) => { const s = getComputedStyle(el); return {
      font: s.fontFamily.split(',')[0].replace(/["']/g, '').trim(), size: parseFloat(s.fontSize), weight: parseInt(s.fontWeight),
      italic: s.fontStyle === 'italic', color: s.color, spacing: s.letterSpacing === 'normal' ? 0 : parseFloat(s.letterSpacing),
      underline: s.textDecorationLine.includes('underline'), transform: s.textTransform, href: el.closest('a')?.href || null }; };
  const out = {texts: [], pictures: [], charts: [], videos: [], notes: null};
  const walk = (el) => {
    if (el.tagName === 'ASIDE' && el.classList.contains('notes')) { out.notes = el.textContent.trim(); return; }  // hidden or not
    if (!visible(el) || el.dataset.pptx === 'skip') return;
    if (el.dataset.pptx === 'picture') { el.dataset.x2p = 'picture-' + out.pictures.length; out.pictures.push(box(el)); return; }
    if (el.dataset.pptx === 'chart') { out.charts.push({...box(el), spec: JSON.parse(el.dataset.chart)}); el.dataset.x2p = 'chart'; return; }
    if (el.tagName === 'VIDEO') { out.videos.push({...box(el), src: el.currentSrc || el.src, poster: el.poster}); el.dataset.x2p = 'video'; return; }
    if (el.tagName === 'svg' || el.tagName === 'IMG' || el.tagName === 'CANVAS') return;
    if (isText(el)) {
      const s = getComputedStyle(el);
      const runs = [];
      const add = (node, styleEl) => {
        if (node.nodeType === 3) { const st = runStyle(styleEl); const t = transform(node.textContent.replace(/\s+/g, ' '), st.transform); if (t) runs.push({...st, text: t}); }
        else if (node.tagName === 'BR') runs.push({br: true});
        else if (node.nodeType === 1 && visible(node)) for (const c of node.childNodes) add(c, node);
      };
      for (const c of el.childNodes) add(c, el);
      if (runs.length && !runs[0].br) runs[0].text = runs[0].text.replace(/^\s+/, '');
      const last = runs.filter(r => !r.br).pop(); if (last) last.text = last.text.replace(/\s+$/, '');
      const r = box(el);
      const pad = {l: parseFloat(s.paddingLeft) + parseFloat(s.borderLeftWidth), r: parseFloat(s.paddingRight) + parseFloat(s.borderRightWidth),
                   t: parseFloat(s.paddingTop) + parseFloat(s.borderTopWidth), b: parseFloat(s.paddingBottom) + parseFloat(s.borderBottomWidth)};
      // one line or more: measured from the text itself, so a box that is wider than its text still wraps the same
      const range = document.createRange(); range.selectNodeContents(el);
      const lines = new Set([...range.getClientRects()].map(q => Math.round(q.top))).size;
      let bullet = null;
      if (el.tagName === 'LI') { const t = getComputedStyle(el).listStyleType; bullet = t === 'decimal' ? 'num' : (t === 'none' ? null : '•'); }
      out.texts.push({x: r.x + pad.l, y: r.y + pad.t, w: r.w - pad.l - pad.r, h: r.h - pad.t - pad.b, runs, lines,
        align: s.textAlign, lineHeight: s.lineHeight === 'normal' ? null : parseFloat(s.lineHeight), size: parseFloat(s.fontSize),
        valign: s.display.includes('flex') ? s.alignItems : null, bullet, rotate: s.transform});
      el.dataset.x2p = 'text';
      return;
    }
    for (const c of el.children) walk(c);
  };
  for (const c of slide.children) walk(c);
  return out;
}
"""

# Hides what PowerPoint will draw itself, so the picture behind holds only the rest
_HIDE = """
[data-x2p="text"] { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; }
[data-x2p="text"] * { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; text-decoration-color: transparent !important; }
[data-x2p="chart"], [data-x2p="video"], [data-x2p^="picture-"], aside.notes { visibility: hidden !important; }
"""


def _rgb(css: str) -> tuple[RGBColor, float]:
    m = re.match(r"rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)", css)
    if not m:
        return RGBColor(0, 0, 0), 1.0
    r, g, b = (int(float(v)) for v in m.groups()[:3])
    return RGBColor(r, g, b), float(m.group(4)) if m.group(4) else 1.0


def _emu(px: float) -> Emu:
    return Emu(int(round(px * EMU_PER_PX)))


def _launch(pw, browser: str | None):
    if browser:
        return pw.chromium.launch(executable_path=browser)
    for channel in ("chrome", "msedge"):
        try:
            return pw.chromium.launch(channel=channel)
        except Exception:  # noqa: BLE001 - not installed: try the next one
            continue
    return pw.chromium.launch()


def _slides(page, src: Path) -> list:
    """Each slide's element: the <section class="slide">s of one file, or the body of each file in a folder."""
    return page.query_selector_all("section.slide") or [page.query_selector("body")]


def _text_box(slide, t: dict) -> None:
    single = t["lines"] <= 1
    # PowerPoint measures text a little wider than Chrome: give a one-line box room and no wrapping, so it never breaks
    slack = 0.06 * t["w"] + 4 if single else 0.02 * t["w"]
    x = t["x"] - (
        slack
        if t["align"] in ("right", "end")
        else slack / 2
        if t["align"] == "center"
        else 0
    )
    tb = slide.shapes.add_textbox(
        _emu(x), _emu(t["y"]), _emu(t["w"] + slack), _emu(max(t["h"], t["size"]))
    )
    tf = tb.text_frame
    tf.word_wrap = not single
    tf.auto_size = None
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = MSO_ANCHOR.TOP
    align = {
        "center": PP_ALIGN.CENTER,
        "right": PP_ALIGN.RIGHT,
        "end": PP_ALIGN.RIGHT,
        "justify": PP_ALIGN.JUSTIFY,
    }.get(t["align"], PP_ALIGN.LEFT)
    p = tf.paragraphs[0]

    def start(par):
        par.alignment = align
        if t["lineHeight"]:
            par.line_spacing = Pt(t["lineHeight"] * 0.75)
        par.space_before = par.space_after = Pt(0)

    start(p)
    if t["bullet"]:
        r = p.add_run()
        r.text = ("" if t["bullet"] == "num" else t["bullet"]) + "  "
    for run in t["runs"]:
        if run.get("br"):
            p = tf.add_paragraph()
            start(p)
            continue
        r = p.add_run()
        r.text = run["text"]
        f = r.font
        f.name = run["font"]
        f.size = Pt(round(run["size"] * 0.75 * 2) / 2)
        f.bold = run["weight"] >= 600
        f.italic = run["italic"]
        f.underline = run["underline"]
        color, alpha = _rgb(run["color"])
        f.color.rgb = color
        if alpha < 0.99:
            _alpha(r, alpha)
        if run["spacing"]:
            r._r.get_or_add_rPr().set("spc", str(int(run["spacing"] * 0.75 * 100)))
        if run["href"]:
            r.hyperlink.address = run["href"]


def _alpha(run, alpha: float) -> None:
    from pptx.oxml.ns import qn

    fill = run._r.get_or_add_rPr().find(qn("a:solidFill"))
    clr = fill[0] if fill is not None and len(fill) else None
    if clr is not None:
        a = clr.makeelement(qn("a:alpha"), {"val": str(int(alpha * 100000))})
        clr.append(a)


def _chart(slide, c: dict) -> None:
    spec = c["spec"]
    kind = {
        "bar": XL_CHART_TYPE.COLUMN_CLUSTERED,
        "hbar": XL_CHART_TYPE.BAR_CLUSTERED,
        "line": XL_CHART_TYPE.LINE_MARKERS,
        "pie": XL_CHART_TYPE.PIE,
        "doughnut": XL_CHART_TYPE.DOUGHNUT,
        "stacked": XL_CHART_TYPE.COLUMN_STACKED,
    }[spec.get("type", "bar")]
    data = CategoryChartData()
    data.categories = spec["categories"]
    for name, values in spec["series"].items():
        data.add_series(name, values)
    chart = slide.shapes.add_chart(
        kind, _emu(c["x"]), _emu(c["y"]), _emu(c["w"]), _emu(c["h"]), data
    ).chart
    chart.has_title = False
    chart.has_legend = len(spec["series"]) > 1
    chart.font.name = spec.get("font", "Calibri")
    chart.font.size = Pt(spec.get("size", 14))
    muted = RGBColor.from_string(spec.get("muted", "6B7280"))
    if kind not in (XL_CHART_TYPE.PIE, XL_CHART_TYPE.DOUGHNUT):
        va = chart.value_axis
        va.visible = spec.get("value_axis", False)
        va.has_major_gridlines = spec.get("gridlines", False)
        ca = chart.category_axis
        ca.format.line.fill.background()
        ca.tick_labels.font.color.rgb = muted
        chart.plots[0].gap_width = spec.get("gap", 50)
    colors = spec.get("colors") or []
    labels = spec.get("labels") or []
    series = chart.plots[0].series
    for s_i, ser in enumerate(series):
        for i in range(len(spec["categories"])):
            pt = ser.points[i]
            col = (
                colors[i]
                if len(series) == 1 and i < len(colors)
                else (colors[s_i] if s_i < len(colors) else None)
            )
            if col:
                pt.format.fill.solid()
                pt.format.fill.fore_color.rgb = RGBColor.from_string(col.lstrip("#"))
                if kind == XL_CHART_TYPE.LINE_MARKERS:
                    ser.format.line.color.rgb = RGBColor.from_string(col.lstrip("#"))
            if len(series) == 1 and i < len(labels) and labels[i] is not None:
                dl = pt.data_label
                dl.position = (
                    XL_LABEL_POSITION.OUTSIDE_END
                    if kind
                    in (XL_CHART_TYPE.COLUMN_CLUSTERED, XL_CHART_TYPE.BAR_CLUSTERED)
                    else XL_LABEL_POSITION.CENTER
                    if kind
                    in (
                        XL_CHART_TYPE.PIE,
                        XL_CHART_TYPE.DOUGHNUT,
                        XL_CHART_TYPE.COLUMN_STACKED,
                    )
                    else XL_LABEL_POSITION.ABOVE
                )
                dl.text_frame.text = str(
                    labels[i]
                )  # written as the reader writes numbers, whatever the locale
                run = dl.text_frame.paragraphs[0].runs[0]
                run.font.size = Pt(spec.get("size", 14))
                run.font.bold = bool(spec.get("bold_labels", True))


def convert(
    src: Path, out: Path, browser: str | None = None, scale: int = 2
) -> list[Path]:
    """Write ``out`` from the HTML slides at ``src``; returns the browser's picture of each slide (to compare with)."""
    from playwright.sync_api import sync_playwright

    files = sorted(src.glob("*.html")) if src.is_dir() else [src]
    prs = Presentation()
    prs.slide_width, prs.slide_height = _emu(W_PX), _emu(H_PX)
    work = Path(tempfile.mkdtemp(prefix="html2pptx-"))
    previews: list[Path] = []
    with sync_playwright() as pw:
        b = _launch(pw, browser)
        page = b.new_page(
            viewport={"width": W_PX, "height": H_PX}, device_scale_factor=scale
        )
        n = 0
        for f in files:
            page.goto(f.resolve().as_uri(), wait_until="networkidle")
            page.evaluate("document.fonts.ready")
            for el in _slides(page, f):
                n += 1
                el.scroll_into_view_if_needed()
                el.evaluate(
                    "e => { e.style.width = '1280px'; e.style.height = '720px'; e.style.overflow = 'hidden'; }"
                )
                full = work / f"look-{n:02d}.png"
                el.screenshot(path=str(full))
                previews.append(full)
                found = el.evaluate(_EXTRACT)
                pics = []
                for i, _ in enumerate(found["pictures"]):
                    p = work / f"pic-{n:02d}-{i}.png"
                    page.query_selector(f'[data-x2p="picture-{i}"]').screenshot(
                        path=str(p), omit_background=True
                    )
                    pics.append(p)
                style = page.add_style_tag(content=_HIDE)
                ground = work / f"ground-{n:02d}.png"
                el.screenshot(path=str(ground))
                style.evaluate("s => s.remove()")
                page.evaluate(
                    "document.querySelectorAll('[data-x2p]').forEach(e => e.removeAttribute('data-x2p'))"
                )

                s = prs.slides.add_slide(prs.slide_layouts[6])
                s.shapes.add_picture(
                    str(ground), 0, 0, prs.slide_width, prs.slide_height
                )
                for p, r in zip(pics, found["pictures"]):
                    s.shapes.add_picture(
                        str(p), _emu(r["x"]), _emu(r["y"]), _emu(r["w"]), _emu(r["h"])
                    )
                for c in found["charts"]:
                    _chart(s, c)
                for v in found["videos"]:
                    poster = (
                        Path(v["poster"].replace("file://", ""))
                        if v["poster"]
                        else None
                    )
                    s.shapes.add_movie(
                        v["src"].replace("file://", ""),
                        _emu(v["x"]),
                        _emu(v["y"]),
                        _emu(v["w"]),
                        _emu(v["h"]),
                        poster_frame_image=str(poster)
                        if poster and poster.exists()
                        else None,
                        mime_type="video/mp4",
                    )
                for t in found["texts"]:
                    _text_box(s, t)
                if found["notes"]:
                    s.notes_slide.notes_text_frame.text = found["notes"]
        b.close()
    prs.save(out)
    return previews


def main() -> None:
    """Command line: html_to_pptx.py SRC -o OUT."""
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument(
        "src",
        type=Path,
        help="an HTML file with <section class='slide'>s, or a folder of HTML files",
    )
    ap.add_argument("-o", "--out", type=Path, default=Path("deck.pptx"))
    ap.add_argument(
        "--browser", help="path to Chrome or Chromium, when the script cannot find one"
    )
    ap.add_argument(
        "--previews",
        type=Path,
        help="copy the browser's picture of each slide here, to compare",
    )
    a = ap.parse_args()
    previews = convert(a.src, a.out, a.browser)
    if a.previews:
        a.previews.mkdir(parents=True, exist_ok=True)
        for p in previews:
            p.replace(a.previews / p.name)
    print(json.dumps({"pptx": str(a.out), "slides": len(previews)}))


if __name__ == "__main__":
    sys.exit(main())
