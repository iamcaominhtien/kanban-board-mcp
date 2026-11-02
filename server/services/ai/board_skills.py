"""The board's own skills, loaded in every Claude Code run with `--plugin-dir`.

Claude Code keeps only the first 10,000 characters of an MCP server's instructions, so a long guide cannot ride there:
it reaches an AI as a skill instead, which Claude Code loads whole when the work calls for it (the person's own design
skills work the same way). Today: `canvas-design`, the design guide for canvas frames (services/canvas_design.py).
"""

import json
from pathlib import Path

import database

NAME = "kanban-board"


def _skills() -> dict[str, str]:
    from services import canvas_design

    return {"canvas-design": canvas_design.SKILL_HEADER + canvas_design.GUIDE}


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
        ),
    )
    for name, text in _skills().items():
        _write(root / "skills" / name / "SKILL.md", text)
    return str(root)


def _write(path: Path, text: str) -> None:
    if path.is_file() and path.read_text() == text:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
