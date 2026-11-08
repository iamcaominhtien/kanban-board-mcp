"""The `demo-video` skill: a narrated 1080p demo video of the app (or of a feature), built with code from a scenario file.

``SKILL.md`` is the skill's text (it is also the project skill `.claude/skills/demo-video`, a link to this folder). Its folder
ships with it in the board's plugin: ``scripts/`` (a throwaway board, the stage, the sound and the build), ``scenarios/``.
The stock sounds and the Python packages are fetched on first use, outside the skill folder (the board rewrites it).
"""

from __future__ import annotations

import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
_TEXT = (HERE / "SKILL.md").read_text(encoding="utf-8")
_HEAD = re.match(r"^---\nname: (.+)\ndescription: (.+)\n---\n", _TEXT)
assert _HEAD, "SKILL.md must start with its name and description"

NAME = _HEAD.group(1).strip()
DESCRIPTION = _HEAD.group(2).strip()

_SHIP = {".py", ".json", ".html", ".md"}


def body() -> str:
    """The skill's text, without its front matter (the board writes its own header)."""
    return _TEXT[_HEAD.end() :].lstrip("\n")


def files() -> dict[str, bytes]:
    """The files the skill ships beside its SKILL.md: ``{relative path: bytes}``."""
    return {
        p.relative_to(HERE).as_posix(): p.read_bytes()
        for p in sorted(HERE.rglob("*"))
        if p.is_file()
        and p.suffix in _SHIP
        and p.name not in {"SKILL.md", "__init__.py"}
        and "__pycache__" not in p.parts
    }
