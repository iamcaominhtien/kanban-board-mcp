"""The board's own skills, loaded in every Claude Code run with `--plugin-dir`.

Claude Code keeps only the first 10,000 characters of an MCP server's instructions, so a long guide cannot ride there:
it reaches an AI as a skill instead, which Claude Code loads whole when the work calls for it (the person's own design
skills work the same way). Today: `canvas-design`, the design guide for canvas frames (services/canvas_design.py),
with `craft.md` and its exemplar boards in `examples/` (services/design_examples/): a skill can carry files, and a
board to look at teaches the bar better than a paragraph; `drawio-diagrams` and `sketches`, how to draw a diagram,
what to do with a person's Sketch and which tool fits (services/visual_guides.py, issue #267); `docs-pages`, how to
work in Docs (services/docs_guide.py, issue #268); `board-permissions`, what an AI may do and what to do
when refused (services/permissions_guide.py); and the shared skills every role uses (services/shared_skills.py, issue
#277): working a ticket, evidence and handing over, the repository and the machine, asking and writing, working
together; and one skill per role (services/role_skills.py, issue #273), which only a member of that role gets.

A project switches each skill off for every member or for one (`ops.board_skills`); a run gets a folder holding only
the skills on for it.
"""

import hashlib
import json
import re
from pathlib import Path

import database

NAME = "kanban-board"


def _skills() -> dict[str, str]:
    from services import (
        canvas_design,
        docs_guide,
        role_skills,
        shared_skills,
        visual_guides,
    )

    return {
        "canvas-design": canvas_design.SKILL_HEADER + canvas_design.GUIDE,
        # draw.io diagrams and what an AI does with a Sketch, with which tool to choose (issue #267)
        "drawio-diagrams": visual_guides.DRAWIO_HEADER + visual_guides.DRAWIO,
        "sketches": visual_guides.SKETCH_HEADER + visual_guides.SKETCH,
        # what the AI may do, what needs a person, what to do when refused (issue #275)
        # how to work in Docs: pages vs comments, the Markdown kept, editing a part, files, comments, tickets (#268)
        "docs-pages": docs_guide.SKILL_HEADER + docs_guide.GUIDE,
        # how any role works a ticket (issue #277)
        **shared_skills.skill_files(),
        # how each role does its own job (issue #273): only a member of that role gets its skill
        **role_skills.skill_files(),
    }


def catalog() -> list[dict]:
    """The board's skills for the UI: ``[{name, description, role}]``, from each SKILL.md's front matter; ``role`` is
    the role a role skill is for (None: every role)."""
    from services import role_skills

    out = []
    for name, text in _skills().items():
        m = re.search(r"^description:\s*(.+)$", text, re.M)
        out.append(
            {
                "name": name,
                "description": m.group(1).strip() if m else "",
                "role": role_skills.role_of_skill(name),
                # the roles that do this craft; None for a skill that is for every team
                "craft_roles": sorted(CRAFT_ROLES[name])
                if name in CRAFT_ROLES
                else None,
                "always_on": name == ALWAYS_ON,
            }
        )
    return out


# Shared skills that teach one craft, and the roles that do that work (AI v2). A team gets one when one of its roles is
# listed; the other shared skills (the ticket, Docs, asking and writing, memory, handing over, the repo) are for every
# team. Fewer skills keep the list the CLI shows the model short enough that it reads it.
CRAFT_ROLES: dict[str, set[str]] = {
    "canvas-design": {"designer", "pm", "ba"},
    "sketches": {"designer", "pm", "ba", "dev"},
    "drawio-diagrams": {
        "designer",
        "pm",
        "ba",
        "dev",
        "tech_writer",
        "devops",
        "data_analyst",
    },
    "slides": {"pm", "ba", "tech_writer", "data_analyst"},
    "office-files": {"pm", "ba", "tech_writer", "data_analyst"},
    "end-user-eyes": {"designer", "qa", "user_tester", "pm", "ba"},
    "brainstorming": {"pm", "ba", "designer"},
    "demo-video": {
        "pm",
        "ba",
        "designer",
        "dev",
        "qa",
        "user_tester",
        "tech_writer",
        "devops",
        "data_analyst",
    },
}


# The skill every run opens first (launch.py says REQUIRED): it cannot be switched off.
ALWAYS_ON = "working-a-ticket"


def enabled_for(
    ops: dict, member_id: str | None, role: str | set[str] | None = None
) -> list[str]:
    """The board's skills on for a team: the team's own switch, else the project's (on unless switched off).

    ``ops["board_skills"]`` is a list (the UI camel-cases dict keys): ``[{skill, on, members_on, members_off}]``; a
    skill not listed is on for everyone. ``role``: the team's role keys (AI v2; one key or None for the v1 callers).
    A role skill is only for a team with that role; a craft skill (CRAFT_ROLES) only for a team with a role that
    does that work, when roles are given."""
    from services import role_skills

    roles = (
        {role} if isinstance(role, str) else (set(role) if role is not None else None)
    )
    rows = {
        r.get("skill"): r
        for r in (ops.get("board_skills") or [])
        if isinstance(r, dict)
    }
    out = []
    for name in _skills():
        for_role = role_skills.role_of_skill(name)
        if for_role is not None and for_role not in (roles or set()):
            continue
        if (
            roles is not None
            and name in CRAFT_ROLES
            and not (CRAFT_ROLES[name] & roles)
        ):
            continue
        r = rows.get(name)
        if r is None or name == ALWAYS_ON:
            out.append(name)
            continue
        if member_id and member_id in (r.get("members_on") or []):
            on = True
        elif member_id and member_id in (r.get("members_off") or []):
            on = False
        else:
            on = r.get("on", True) is not False
        if on:
            out.append(name)
    return out


def _skill_files() -> dict[str, dict[str, bytes]]:
    """The files a skill carries beside its SKILL.md: ``{skill: {relative path: bytes}}``."""
    from services import canvas_design, role_skills, shared_skills

    return {
        "canvas-design": {
            "craft.md": canvas_design.CRAFT.encode(),
            **{f"examples/{p.name}": p.read_bytes() for p in canvas_design.examples()},
        },
        # the slides skill's scripts, themes and examples (issue #277)
        **shared_skills.extra_files(),
        # the BA's document templates (issue #273)
        **role_skills.extra_files(),
    }


def plugin_dir(names: list[str] | None = None) -> str:
    """The plugin folder (beside the database), written again when a skill's text changed. ``names``: only these
    skills (the ones on for the run), in a folder of their own; None: all of them."""
    every = list(_skills())
    picked = every if names is None else [n for n in every if n in set(names)]
    root = database.get_db_path().parent / "board-skills"
    if picked != every:
        root = root.with_name(
            "board-skills-" + hashlib.sha1(",".join(picked).encode()).hexdigest()[:10]
        )
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
    keep = set()
    for name, text in _skills().items():
        if name in picked:
            keep.add(root / "skills" / name / "SKILL.md")
            _write(root / "skills" / name / "SKILL.md", text.encode())
    for name, files in _skill_files().items():
        if name not in picked:
            continue
        for rel, data in files.items():
            keep.add(root / "skills" / name / rel)
            _write(root / "skills" / name / rel, data)
    _prune(root / "skills", keep)
    return str(root)


def _prune(folder: Path, keep: set[Path]) -> None:
    """Remove what an earlier version wrote and this one no longer ships (a renamed script, a dropped theme), so a
    run never finds a stale file beside the current ones. Files a run left in the folder (its .look/ renders) go too:
    the folder is the board's, not a place to work in."""
    if not folder.is_dir():
        return
    for p in sorted(folder.rglob("*"), key=lambda q: len(q.parts), reverse=True):
        if p.is_file() and p not in keep:
            p.unlink(missing_ok=True)
        elif p.is_dir() and not any(p.iterdir()):
            p.rmdir()


def skill_dir(name: str) -> str:
    """Where one of the board's skills is on this machine, with the files it carries (for an agent outside Claude
    Code)."""
    return str(Path(plugin_dir()) / "skills" / name)


def examples_dir() -> str:
    """Where the design guide's exemplar boards are on this machine (for an agent outside Claude Code)."""
    return str(Path(plugin_dir()) / "skills" / "canvas-design" / "examples")


def _write(path: Path, data: bytes) -> None:
    if path.is_file() and path.read_bytes() == data:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
