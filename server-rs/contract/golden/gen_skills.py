"""Golden vectors for crates/kb-skills: every text and every skill file of `shared_skills`, `role_skills`, the skill
folders (`slides_skill`, `demo_video_skill`, `ba_templates`) and `design_examples`/`office_examples`.

A long text is stored as its SHA-256 (of the UTF-8 bytes) with its length in characters and in bytes; a file as its
name, SHA-256 and size. The Rust tests assert equality for every entry.

Run from `server/` with temporary KANBAN_* folders:
    .venv/bin/python ../server-rs/contract/golden/gen_skills.py
Writes `skills.json` next to this file.
"""

import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, ".")  # run from server/
from services import (  # noqa: E402
    ba_templates,
    demo_video_skill,
    role_skills,
    shared_skills,
    slides_skill,
    ticket_guide,
)

OUT = Path(__file__).with_name("skills.json")
SERVICES = Path("services")


def text(value: str) -> dict:
    data = value.encode("utf-8")
    return {"sha256": hashlib.sha256(data).hexdigest(), "chars": len(value), "bytes": len(data)}


def files(mapping: dict) -> list:
    return [[name, hashlib.sha256(data).hexdigest(), len(data)] for name, data in mapping.items()]


def extra(mapping: dict) -> dict:
    return {skill: files(found) for skill, found in mapping.items()}


def folder(name: str) -> list:
    root = SERVICES / name
    return [
        [p.relative_to(root).as_posix(), hashlib.sha256(p.read_bytes()).hexdigest(), p.stat().st_size]
        for p in sorted(root.rglob("*"))
        if p.is_file() and "__pycache__" not in p.parts and p.name != "__init__.py"
    ]


shared = {
    "skills": [
        {"name": name, "description": text(desc), "body": text(body)} for name, desc, body in shared_skills.SKILLS
    ],
    "skill_files": {name: text(t) for name, t in shared_skills.skill_files().items()},
    "guides": {name: text(t) for name, t in shared_skills.guides().items()},
    "extra_files": extra(shared_skills.extra_files()),
    "core_rules": [text(r) for r in shared_skills.CORE_RULES],
    "header_example": text(shared_skills._header("some-name", "some description")),
    # the ticket guide is in kb-board; its (name, description, text) must be the same as the shared skill's
    "tickets": {
        "name": ticket_guide.NAME,
        "description": text(ticket_guide.DESCRIPTION),
        "body": text(ticket_guide.GUIDE),
    },
}

roles = {
    "skills": [
        {"role": role, "name": name, "description": text(desc), "body": text(body)}
        for role, name, desc, body in role_skills.ROLE_SKILLS
    ],
    "skill_files": {name: text(t) for name, t in role_skills.skill_files().items()},
    "extra_files": extra(role_skills.extra_files()),
    "names": role_skills.names(),
    "skill_of_role": role_skills.SKILL_OF_ROLE,
    "role_of_skill": {
        name: role_skills.role_of_skill(name)
        for name in [*role_skills.names(), "canvas-design", "working-a-ticket", "slides", "", "nope"]
    },
    "guide": {
        role: (None if role_skills.guide(role) is None else text(role_skills.guide(role)))
        for role in [*(r for r, *_ in role_skills.ROLE_SKILLS), "designer", "lead", "", "PM", "nope"]
    },
}

slides = {
    "name": slides_skill.NAME,
    "description": text(slides_skill.DESCRIPTION),
    "body": text(slides_skill.body()),
    "themes": slides_skill.themes(),
    "files": files(slides_skill.files()),
}
demo = {
    "name": demo_video_skill.NAME,
    "description": text(demo_video_skill.DESCRIPTION),
    "body": text(demo_video_skill.body()),
    "files": files(demo_video_skill.files()),
}
ba = {
    "docs": {k: list(v) for k, v in ba_templates.DOCS.items()},
    "files": files(ba_templates.files()),
    "text": {k: text(ba_templates.text(k)) for k in ba_templates.DOCS},
    "docs_templates": {
        k: {"name": v["name"], "description": v["description"], "markdown": text(v["markdown"])}
        for k, v in ba_templates.docs_templates().items()
    },
}

data = {
    "shared": shared,
    "roles": roles,
    "slides": slides,
    "demo_video": demo,
    "ba_templates": ba,
    # folders the server only hands out as they are
    "design_examples": folder("design_examples"),
    "office_examples": folder("office_examples"),
    # every file of the packages, whatever files() filters out
    "folders": {n: folder(n) for n in ("slides_skill", "demo_video_skill", "ba_templates")},
}
OUT.write_text(json.dumps(data, indent=1, ensure_ascii=True) + "\n", encoding="utf-8")
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
