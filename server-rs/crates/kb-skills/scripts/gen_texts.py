"""Writes the long texts of `shared_skills` and `role_skills` to `src/text/` (character for character, no trailing
newline added), so the Rust crate loads them with `include_str!`.

Run from `server/` with temporary KANBAN_CONFIG_DIR / KANBAN_DB_PATH / KANBAN_LOG_DIR:
    .venv/bin/python ../server-rs/crates/kb-skills/scripts/gen_texts.py
"""

import sys
from pathlib import Path

sys.path.insert(0, ".")
from services import role_skills, shared_skills, slides_skill  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "src" / "text"


def put(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


# the shared skills written here; working-with-tickets, slides and demo-video come from other modules
OWN = {
    "working-a-ticket", "evidence-and-handover", "repo-and-machine", "asking-and-writing", "brainstorming",
    "end-user-eyes", "office-files", "working-together", "docs-comment-threads", "keeping-memory",
}
names = []
for name, desc, body in shared_skills.SKILLS:
    if name in OWN:
        put(OUT / "shared" / f"{name}.md", body)
        put(OUT / "shared" / f"{name}.description.txt", desc)
        names.append(name)
assert set(names) == OWN, set(OWN) - set(names)
for i, rule in enumerate(shared_skills.CORE_RULES):
    put(OUT / "core_rules" / f"{i:02d}.txt", rule)
for role, name, desc, body in role_skills.ROLE_SKILLS:
    put(OUT / "roles" / f"{role}.md", body)
    put(OUT / "roles" / f"{role}.description.txt", desc)
put(OUT / "slides.description.txt", slides_skill.DESCRIPTION)
print("roles:", [(r, n) for r, n, _d, _b in role_skills.ROLE_SKILLS])
print("shared:", [n for n, _d, _b in shared_skills.SKILLS])
print("rules:", len(shared_skills.CORE_RULES))
