"""Build each theme's sample deck: sample.html (the design), sample.pptx (through html_to_pptx.py) and preview.jpg
(the .pptx rendered, thumbnails side by side).

    python build.py                 # every theme
    python build.py ledger pitch    # some

A theme is a folder with `theme.css` (its variables and signature) and `content.json` (the sample deck's words, in
the language of its readers, and its pictures as inline SVG). The layouts are in base.css.
"""

from __future__ import annotations

import html
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))


def _e(s: str) -> str:
    """Escape text, keeping the few inline tags the content uses (<b>, <i>, <br>)."""
    out = html.escape(s, quote=False)
    for tag in ("b", "i", "br"):
        out = out.replace(f"&lt;{tag}&gt;", f"<{tag}>").replace(
            f"&lt;/{tag}&gt;", f"</{tag}>"
        )
    return out.replace("&lt;br/&gt;", "<br>")


def _footer(c: dict, n: int) -> str:
    return f'<div class="footer"><span>{_e(c["deck"])}</span><span>{n:02d}</span></div>'


def _art(a: str | None) -> str:
    return f'<div class="art">{a}</div>' if a else ""


def slides(c: dict) -> list[str]:
    """The sample deck's slides as HTML, in the order every theme shows them."""
    out = []
    v = c["cover"]
    out.append(
        f'<section class="slide l-cover"><div class="eyebrow">{_e(v["eyebrow"])}</div>'
        f'<h1 class="title">{_e(v["title"])}</h1><p class="lede">{_e(v["lede"])}</p>{_art(v.get("art"))}'
        f'<aside class="notes">{_e(v.get("notes", ""))}</aside></section>'
    )
    v = c["agenda"]
    items = "".join(
        f'<li><span class="n">{i:02d}</span><span class="t">{_e(t)}<span class="d">{_e(d)}</span></span></li>'
        for i, (t, d) in enumerate(v["items"], 1)
    )
    out.append(
        f'<section class="slide l-agenda"><h2 class="title">{_e(v["title"])}</h2><ol>{items}</ol>{_footer(c, 2)}</section>'
    )
    v = c["number"]
    out.append(
        f'<section class="slide l-number"><div class="num">{_e(v["num"])}</div><h2 class="title">{_e(v["title"])}</h2>'
        f'<p class="lede">{_e(v["lede"])}</p>{_art(v.get("art"))}{_footer(c, 3)}</section>'
    )
    v = c["chart"]
    spec = dict(v["chart"])
    spec.setdefault("font", c["fonts"]["body"])
    out.append(
        f'<section class="slide l-chart"><h2 class="title">{_e(v["title"])}</h2><p class="lede">{_e(v["lede"])}</p>'
        f'<div class="chart" data-pptx="chart" data-chart=\'{html.escape(json.dumps(spec, ensure_ascii=False), quote=True)}\'></div>'
        f'<div class="side"><div class="num">{_e(v["num"])}</div><div class="cap">{_e(v["cap"])}</div>'
        f"<p>{_e(v['text'])}</p></div>{_footer(c, 4)}</section>"
    )
    v = c["split"]
    body = "".join(f"<p>{_e(p)}</p>" for p in v["body"])
    out.append(
        f'<section class="slide l-split">{_art(v.get("art"))}<div class="eyebrow">{_e(v["eyebrow"])}</div>'
        f'<h2 class="title">{_e(v["title"])}</h2><div class="body">{body}</div>{_footer(c, 5)}</section>'
    )
    v = c["compare"]
    cols = "".join(
        f'<div class="col{" pick" if col.get("pick") else ""}"><div class="tag">{_e(col["tag"])}</div>'
        f'<h3>{_e(col["h"])}</h3><p>{_e(col["p"])}</p><div class="k"><b>{_e(col["k"])}</b>{_e(col["kl"])}</div></div>'
        for col in v["cols"]
    )
    out.append(
        f'<section class="slide l-compare"><h2 class="title">{_e(v["title"])}</h2><div class="cols">{cols}</div>'
        f"{_footer(c, 6)}</section>"
    )
    v = c["steps"]
    steps = "".join(
        f'<div class="step"><div class="when">{_e(s["when"])}</div><h3>{_e(s["h"])}</h3><p>{_e(s["p"])}</p></div>'
        for s in v["steps"]
    )
    out.append(
        f'<section class="slide l-steps"><h2 class="title">{_e(v["title"])}</h2><div class="row">{steps}</div>'
        f"{_footer(c, 7)}</section>"
    )
    v = c["quote"]
    out.append(
        f'<section class="slide l-quote"><div class="mark">“</div><h2 class="title">{_e(v["text"])}</h2>'
        f'<div class="who"><b>{_e(v["who"])}</b>{_e(v["role"])}</div>{_footer(c, 8)}</section>'
    )
    v = c["closing"]
    asks = "".join(f"<div><b>{_e(b)}</b>{_e(t)}</div>" for b, t in v["asks"])
    out.append(
        f'<section class="slide l-closing"><div class="eyebrow">{_e(v["eyebrow"])}</div><h2 class="title">{_e(v["title"])}</h2>'
        f'<div class="asks">{asks}</div>{_footer(c, 9)}</section>'
    )
    return out


def page(theme: Path) -> str:
    """The sample deck of ``theme`` as one HTML file."""
    c = json.loads((theme / "content.json").read_text(encoding="utf-8"))
    fams = {c["fonts"]["display"], c["fonts"]["body"]}
    q = "&".join(
        "family="
        + f.replace(" ", "+")
        + ":ital,wght@0,400;0,500;0,600;0,700;0,800;1,400"
        for f in sorted(fams)
    )
    return (
        f'<!doctype html><html lang="{c.get("lang", "vi")}"><head><meta charset="utf-8"><title>{_e(c["label"])}</title>'
        f'<link rel="stylesheet" href="https://fonts.googleapis.com/css2?{q}&display=swap">'
        f"<style>{(HERE / 'base.css').read_text(encoding='utf-8')}\n{(theme / 'theme.css').read_text(encoding='utf-8')}</style></head><body>"
        + "\n".join(slides(c))
        + "</body></html>"
    )


def build(theme: Path, browser: str | None = None) -> None:
    """sample.html, sample.pptx and preview.jpg for one theme."""
    import html_to_pptx
    import render

    (theme / "sample.html").write_text(page(theme), encoding="utf-8")
    pptx = theme / "sample.pptx"
    html_to_pptx.convert(theme / "sample.html", pptx, browser)
    way, pages = render.render(pptx, theme / ".look")
    if pages:
        render.sheet(pages, theme / "preview.jpg")
    print(theme.name, way, len(pages))


if __name__ == "__main__":
    import os

    wanted = sys.argv[1:]
    for t in sorted(p for p in HERE.iterdir() if (p / "content.json").exists()):
        if not wanted or t.name in wanted:
            build(t, os.environ.get("CHROMIUM"))
