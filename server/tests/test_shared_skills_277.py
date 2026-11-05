"""The board's shared skills for every role (issue #277): one text for internal and outside agents, a few core rules
in every work run, and switches per project and per member."""

import asyncio
import json
from pathlib import Path

from models import AiTeam, AiProjectSettings
from services import shared_skills
from services.ai import board_skills
from services.ai.context import RunContext, rules_block
from tests.ai_helpers import env  # noqa: F401

SHARED = [
    "working-a-ticket",
    # how every part of a ticket is used, and where files go (issue #269)
    "working-with-tickets",
    "evidence-and-handover",
    "repo-and-machine",
    "asking-and-writing",
    # how the roles work together (issue #273)
    "working-together",
    # keeping the project memory without being asked (issue #274)
    "keeping-memory",
    # asked for by the owner in the brainstorm
    "brainstorming",
    "end-user-eyes",
    "office-files",
    # decks, asked for by the owner after the first office-files run (themes, templates, pictures)
    "slides",
]


def _block(member: AiTeam, settings: AiProjectSettings, mode: str = "work") -> str:
    ctx = RunContext("run_1", "m1", "Dev", "p1", "KAN-1", "An Nguyen", mode)
    return rules_block(
        ctx, member, settings, project_name="Project", ticket_status="todo"
    )


def test_the_four_skills_agreed_with_the_owner_are_board_skills_with_a_description_that_says_when():
    assert [n for n, _d, _b in shared_skills.SKILLS] == SHARED
    names = [s["name"] for s in board_skills.catalog() if not s["role"]]
    # AI v2: no permission matrix, so no board-permissions skill
    assert names[:4] == [
        "canvas-design",
        "drawio-diagrams",
        "sketches",
        "docs-pages",  # issue #268
    ]
    assert names[4:] == SHARED
    for s in board_skills.catalog():
        # Claude Code opens a skill by its description: each says what it covers and when to use it
        assert "Use " in s["description"], s["name"]


def test_an_outside_agent_reads_the_same_text_as_the_skill():
    from kanban_mcp import operations as ops

    guides = asyncio.run(ops.shared_guides())
    assert list(guides) == SHARED
    root = Path(board_skills.plugin_dir())
    for name, text in guides.items():
        skill = (root / "skills" / name / "SKILL.md").read_text()
        body = shared_skills.guides()[name]
        assert skill.startswith(f"---\nname: {name}\n") and skill.endswith(body)
        assert text.startswith(body)
    # a guide with files says where they are, so an outside agent can run its scripts
    assert str(root / "skills" / "slides") in guides["slides"]


def test_the_texts_carry_what_the_live_runs_got_wrong():
    text = "\n".join(shared_skills.guides().values())
    for needle in (
        "only what is true",  # a report claimed a person changed the background
        "What you start, you stop",  # http.server left running kept the run open
        "Never invent evidence",
        "ai_run(action='ask')",  # "nobody was there to answer, so I chose"
        "The project's language, everywhere",  # English page names on a Vietnamese canvas
        # the three the owner asked for: a brainstorm in rounds, the user's view, files that were looked at
        "**2 or 3 approaches**",
        "Five seconds",
        "soffice --headless --convert-to pdf",
        "**Formulas, not typed results**",
        "is a sentence that states",
        # how to look at a file on any machine, and decks
        "Quick Look",
        "ai_run(action='ask')` whether to install LibreOffice",
        "scripts/html_to_pptx.py",
        "pptx_template.py inventory",
        "only its subject has",
        "licence",
    ):
        assert needle in text, needle


def test_every_work_run_gets_the_core_rules_and_where_the_detail_is():
    member = AiTeam(id="m1", provider="claude-code")
    block = _block(member, AiProjectSettings())
    for rule in shared_skills.CORE_RULES:
        assert rule in block
    assert (
        "`kanban-board:working-a-ticket`" in block
        and "`kanban-board:asking-and-writing`" in block
    )
    # an agent with no Claude Code skills is pointed to docs_read
    other = _block(AiTeam(id="m2", provider="gemini"), AiProjectSettings())
    assert "docs_read(action='guides')" in other and "kanban-board:" not in other


def test_a_skill_switched_off_for_the_project_or_a_member_is_left_out():
    off = [{"skill": "repo-and-machine", "on": False, "members_on": ["dev"]}]
    ops = {"board_skills": off}
    assert "repo-and-machine" not in board_skills.enabled_for(ops, "designer")
    # the member's own switch wins over the project's
    assert "repo-and-machine" in board_skills.enabled_for(ops, "dev")
    ops = {"board_skills": [{"skill": "canvas-design", "members_off": ["dev"]}]}
    assert "canvas-design" not in board_skills.enabled_for(ops, "dev")
    assert "canvas-design" in board_skills.enabled_for(ops, "designer")
    # nothing listed: every skill is on (a role skill only for its role, issue #273)
    assert board_skills.enabled_for({}, "x") == [
        s["name"] for s in board_skills.catalog() if not s["role"]
    ]

    settings = AiProjectSettings(
        ops=json.dumps({"board_skills": [{"skill": "repo-and-machine", "on": False}]})
    )
    block = _block(AiTeam(id="designer", provider="claude-code"), settings)
    assert (
        "kanban-board:repo-and-machine" not in block
        and "kanban-board:working-a-ticket" in block
    )


def test_a_run_gets_a_folder_with_only_the_skills_on_for_it():
    full = Path(board_skills.plugin_dir())
    some = Path(board_skills.plugin_dir(["canvas-design", "working-a-ticket"]))
    assert some != full
    assert sorted(p.name for p in (some / "skills").iterdir()) == [
        "canvas-design",
        "working-a-ticket",
    ]
    assert (some / "skills" / "canvas-design" / "craft.md").is_file()
    assert (some / ".claude-plugin" / "plugin.json").is_file()
    assert sorted(p.name for p in (full / "skills").iterdir()) == sorted(
        s["name"] for s in board_skills.catalog()
    )


async def test_the_ui_lists_the_board_skills(env):
    r = await env["c"].get("/ai/board-skills")
    assert r.status_code == 200
    assert [s["name"] for s in r.json() if not s["role"]][4:] == SHARED


def test_personas_and_step_texts_point_to_the_skills_instead_of_repeating_them():
    from services.ai import packs

    for pack in packs.BUILTIN:
        assert "the board's shared skills" in pack["persona"], pack["key"]
        assert "Report with ai_run(action='report')" not in pack["persona"], pack["key"]


def test_an_outside_agent_is_told_where_the_guides_are():
    import kanban_mcp

    text = kanban_mcp.build_instructions(True)
    assert "docs_read(guides)" in text and len(text) < 10_000
    # and the core rules themselves, as a board run has them in its prompt
    for rule in shared_skills.CORE_RULES:
        assert rule in text


def test_the_slides_skill_ships_its_scripts_and_themes():
    from services import slides_skill

    root = Path(board_skills.plugin_dir(["slides"])) / "skills" / "slides"
    for rel in (
        "scripts/html_to_pptx.py",
        "scripts/pptx_template.py",
        "scripts/render.py",
        "themes/base.css",
        "themes/ledger/sample.html",
        "themes/ledger/sample.pptx",
        "themes/ledger/preview.jpg",
    ):
        assert (root / rel).is_file(), rel
    assert not list(root.rglob(".look")) and not list(root.rglob("__pycache__"))
    # the themes table is made from the themes themselves
    text = (root / "SKILL.md").read_text()
    for t in slides_skill.themes():
        assert f"`{t['key']}`" in text and t["fonts"]["office_body"] in text


def test_the_slides_files_are_read_as_utf8_whatever_the_machine_locale():
    """A Windows machine reads text as cp1252 by default: the Vietnamese themes would not decode and the board server
    would fail to start (shared_skills builds the slides text at import)."""
    import re

    root = Path(__file__).resolve().parents[1] / "services" / "slides_skill"
    for p in root.rglob("*.py"):
        for line in p.read_text(encoding="utf-8").splitlines():
            if re.search(r"\.(read_text|write_text)\(", line):
                assert re.search(r"encoding=[\"']utf-8", line), (
                    f"{p.relative_to(root)}: {line.strip()}"
                )


def test_a_file_an_earlier_version_shipped_is_removed_from_the_plugin(
    tmp_path, monkeypatch
):
    import database

    monkeypatch.setattr(database, "get_db_path", lambda: tmp_path / "kanban.db")
    root = Path(board_skills.plugin_dir())
    stale = root / "skills" / "slides" / "scripts" / "old_name.py"
    stale.write_text("print('stale')", encoding="utf-8")
    (root / "skills" / "gone-skill").mkdir()
    (root / "skills" / "gone-skill" / "SKILL.md").write_text("x", encoding="utf-8")
    again = Path(board_skills.plugin_dir())
    assert again == root
    assert not stale.exists() and not (root / "skills" / "gone-skill").exists()
    assert (root / "skills" / "slides" / "scripts" / "render.py").is_file()
