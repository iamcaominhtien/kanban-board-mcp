"""The board's own skills, loaded in every Claude Code run with `--plugin-dir`.

Claude Code keeps only the first 10,000 characters of an MCP server's instructions, so a long guide cannot ride there:
it reaches an AI as a skill instead, which Claude Code loads whole when the work calls for it (the person's own design
skills work the same way). Today: `canvas-design`, the design guide for canvas frames (services/canvas_design.py),
with its exemplar boards in `examples/` (services/design_examples/): a skill can carry files, and a board to look at
teaches the bar better than a paragraph.
"""

import json
from pathlib import Path

import database

NAME = "kanban-board"


def _skills() -> dict[str, str]:
    from services import canvas_design

    return {"canvas-design": canvas_design.SKILL_HEADER + canvas_design.GUIDE}


def _skill_files() -> dict[str, dict[str, bytes]]:
    """The files a skill carries beside its SKILL.md: ``{skill: {relative path: bytes}}``."""
    from services import canvas_design

    return {
        "canvas-design": {
            "craft.md": canvas_design.CRAFT.encode(),
            **{f"examples/{p.name}": p.read_bytes() for p in canvas_design.examples()},
        }
    }


def plugin_dir() -> str:
    """The plugin folder (beside the database), written again when a skill's text changed."""
    root = database.get_db_path().parent / "board-skills"
    manifest = root / ".claude-plugin" / "plugin.json"
    _write(
        manifest,
        json.dumps(
            {
                "name": NAME,
                "description": "The Kanban board's own skills.",
                "version": "1",
            }
        ).encode(),
    )
    for name, text in _skills().items():
        _write(root / "skills" / name / "SKILL.md", text.encode())
    for name, files in _skill_files().items():
        for rel, data in files.items():
            _write(root / "skills" / name / rel, data)
    return str(root)


def examples_dir() -> str:
    """Where the design guide's exemplar boards are on this machine (for an agent outside Claude Code)."""
    return str(Path(plugin_dir()) / "skills" / "canvas-design" / "examples")


def _write(path: Path, data: bytes) -> None:
    if path.is_file() and path.read_bytes() == data:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
