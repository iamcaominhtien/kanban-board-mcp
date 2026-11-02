"""The `slides` skill: decks a person is proud to present (issue #277, asked for by the owner).

``guide.md`` is the skill's text; its folder ships with it in the board's plugin: ``scripts/`` (HTML to an editable
.pptx, a deck in a person's own template, rendering any office file to look at it), ``themes/`` (each a theme.css,
its sample deck and a preview) and ``examples/``. The themes table in the text is made from the themes' content.json.
"""

from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent

NAME = "slides"
DESCRIPTION = (
    "How to make a presentation deck (.pptx) that looks designed and makes its point: the story first, a theme or the "
    "person's own template, pictures found or drawn, then every slide rendered and looked at. Scripts turn slides "
    "designed in HTML into an editable .pptx, fill a person's template, and render any office file. Use whenever you "
    "make or change slides, a deck or a presentation."
)

# the files the skill ships beside its SKILL.md, by suffix; sample.html and the .pptx are what a run copies from
_SHIP = {
    ".py",
    ".css",
    ".json",
    ".html",
    ".pptx",
    ".jpg",
    ".png",
    ".svg",
    ".mp4",
    ".gif",
}


def themes() -> list[dict]:
    """Each theme's key, label, who it is for and its fonts, from its content.json."""
    out = []
    for p in sorted((HERE / "themes").glob("*/content.json")):
        c = json.loads(p.read_text(encoding="utf-8"))
        out.append(
            {
                "key": p.parent.name,
                "label": c["label"],
                "for": c.get("for", ""),
                "fonts": c["fonts"],
            }
        )
    return out


def body() -> str:
    """The skill's text, with the table of themes."""
    rows = ["| Theme | For | Fonts (web; Office) |", "|---|---|---|"]
    for t in themes():
        f = t["fonts"]
        rows.append(
            f"| `{t['key']}` {t['label']} | {t['for']} | {f['display']} + {f['body']}; "
            f"{f.get('office_display', '')} + {f.get('office_body', '')} |"
        )
    return (
        (HERE / "guide.md")
        .read_text(encoding="utf-8")
        .replace("{THEMES}", "\n".join(rows))
    )


def files() -> dict[str, bytes]:
    """The files beside SKILL.md: ``{relative path: bytes}``."""
    out = {}
    for sub in ("scripts", "themes", "examples"):
        root = HERE / sub
        if not root.is_dir():
            continue
        for p in sorted(root.rglob("*")):
            rel = p.relative_to(HERE)
            if (
                p.is_file()
                and p.suffix in _SHIP
                and not any(part.startswith((".", "__")) for part in rel.parts)
            ):
                out[str(rel)] = p.read_bytes()
    return out
