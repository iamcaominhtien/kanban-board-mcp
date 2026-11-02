"""The board's shared skills for every role (issue #277): one text for internal and outside agents, a few core rules
in every work run, and switches per project and per member."""

import asyncio
import json
from pathlib import Path

from models import AiMember, AiProjectSettings
from services import shared_skills
from services.ai import board_skills
from services.ai.context import RunContext, rules_block
from tests.test_ai import env  # noqa: F401

SHARED = [
    "working-a-ticket",
    "evidence-and-handover",
    "repo-and-machine",
    "asking-and-writing",
]


def _block(member: AiMember, settings: AiProjectSettings, mode: str = "work") -> str:
    ctx = RunContext("run_1", "m1", "Dev", "p1", "KAN-1", "An Nguyen", mode)
    return rules_block(
        ctx, member, settings, project_name="Project", ticket_status="todo"
    )


def test_the_four_skills_agreed_with_the_owner_are_board_skills_with_a_description_that_says_when():
    assert [n for n, _d, _b in shared_skills.SKILLS] == SHARED
    names = [s["name"] for s in board_skills.catalog()]
    assert names[:2] == ["canvas-design", "board-permissions"] and names[2:] == SHARED
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
        assert skill.startswith(f"---\nname: {name}\n") and skill.endswith(text)


def test_the_texts_carry_what_the_live_runs_got_wrong():
    text = "\n".join(shared_skills.guides().values())
    for needle in (
        "only what is true",  # a report claimed a person changed the background
        "What you start, you stop",  # http.server left running kept the run open
        "Never invent evidence",
        "ai_run(action='ask')",  # "nobody was there to answer, so I chose"
        "The project's language, everywhere",  # English page names on a Vietnamese canvas
    ):
        assert needle in text, needle


def test_every_work_run_gets_the_core_rules_and_where_the_detail_is():
    member = AiMember(id="m1", provider="claude-code")
    block = _block(member, AiProjectSettings())
    for rule in shared_skills.CORE_RULES:
        assert rule in block
    assert (
        "`kanban-board:working-a-ticket`" in block
        and "`kanban-board:asking-and-writing`" in block
    )
    # an agent with no Claude Code skills is pointed to docs_read
    other = _block(AiMember(id="m2", provider="gemini"), AiProjectSettings())
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
    # nothing listed: every skill is on
    assert board_skills.enabled_for({}, "x") == [
        s["name"] for s in board_skills.catalog()
    ]

    settings = AiProjectSettings(
        ops=json.dumps({"board_skills": [{"skill": "repo-and-machine", "on": False}]})
    )
    block = _block(AiMember(id="designer", provider="claude-code"), settings)
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
    assert [s["name"] for s in r.json()][2:] == SHARED
