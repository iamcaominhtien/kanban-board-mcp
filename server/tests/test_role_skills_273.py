"""A skill per role, four more ready-made roles and the rules for working together (issue #273)."""

import asyncio
import json
from pathlib import Path

from models import AiMember, AiProjectSettings
from services import role_skills, shared_skills
from services.ai import board_skills, packs, tool_rules
from services.ai.context import RunContext, rules_block
from tests.test_ai import env  # noqa: F401

OLD_ROLES = ["triage", "pm", "ba", "designer", "dev", "reviewer", "qa", "user_tester"]
NEW_ROLES = ["tech_writer", "devops", "security", "data_analyst"]


def _member(role: str | None, provider: str = "claude-code") -> AiMember:
    cfg = (
        {"role": role, "pack": {"key": role, "version": packs.BUILTIN_VERSION}}
        if role
        else {}
    )
    return AiMember(id=f"m_{role}", provider=provider, config=json.dumps(cfg))


def _block(
    member: AiMember, settings: AiProjectSettings | None = None, team=None
) -> str:
    ctx = RunContext("run_1", member.id, "Someone", "p1", "KAN-1", "An Nguyen", "work")
    return rules_block(
        ctx,
        member,
        settings or AiProjectSettings(),
        project_name="Project",
        ticket_status="todo",
        team=team,
    )


def test_every_ready_made_role_has_its_own_skill():
    assert [p["key"] for p in packs.BUILTIN] == OLD_ROLES + NEW_ROLES
    for key in OLD_ROLES + NEW_ROLES:
        assert key in role_skills.SKILL_OF_ROLE, key
    # the Designer's craft is the canvas design guide, tuned in #264
    assert role_skills.SKILL_OF_ROLE["designer"] == "canvas-design"
    catalog = {s["name"]: s for s in board_skills.catalog()}
    for role, name, desc, _body in role_skills.ROLE_SKILLS:
        assert catalog[name]["role"] == role
        # Claude Code opens a skill by its description: it says what it covers and when to use it
        assert "Use " in desc, name


def test_the_role_skills_carry_what_the_runs_before_them_missed():
    text = {
        role: role_skills.guide(role) for role, _n, _d, _b in role_skills.ROLE_SKILLS
    }
    for role, needles in {
        # Triage named its workflow in words, with no line a person could start it from
        "triage": ["`DEPTH:`", "`WORKFLOW:`", "reuse them"],
        # the PM split a Story by layer (read, write, command)
        "pm": [
            "By outcome, not by layer",
            "items=[...]",
            "Rule on the **acceptance criteria",
        ],
        # the BA left 14 criteria and no spec page
        "ba": [
            "could QA write a pass/fail test case",
            "Spec: <feature>",
            "Cover the edges",
        ],
        # the board's TDD check only counts a red run that failed on an assertion
        "dev": ["fail on an assertion", "kind='root_cause'", "You cannot push"],
        # the Reviewer wrote its findings in the work log with no verdict line
        "reviewer": ["One point per comment", "`VERDICT: PASS`", "must fix"],
        # QA did not run the suite and wrote one case per criterion only
        "qa": [
            "Run the whole suite",
            "the edges of each",
            "with its proof in the same call",
        ],
        # the User tester named its screenshots without showing them
        "user_tester": ["Five seconds", "`![Step 2", "never read the code"],
        "tech_writer": ["Try every step", "a tutorial", 'No "simply"'],
        "devops": ["Least privilege", "Never by yourself", "Prove it runs"],
        "security": ["Prove it, safely", "path traversal", "`VERDICT: CHANGES`"],
        "data_analyst": [
            "Pin the question down",
            "Look at the data first",
            "The answer first",
        ],
    }.items():
        for needle in needles:
            assert needle in text[role], (role, needle)


def test_the_examples_do_not_give_away_the_live_tasks():
    """The before/after runs use a water-intake app (Giọt): an example from it would teach the answer, not the craft."""
    from services import ba_templates

    text = "\n".join(
        [b for _r, _n, _d, b in role_skills.ROLE_SKILLS]
        + [d.decode("utf-8") for d in ba_templates.files().values()]
    ).lower()
    for word in (
        "giot",
        "giọt",
        "drink",
        "streak",
        "daily_goal",
        "goal_progress",
        "export_csv",
        " oz",
    ):
        assert word not in text, word


def test_a_member_gets_only_its_own_role_skill():
    dev = board_skills.enabled_for({}, "m1", "dev")
    assert "role-dev" in dev and "role-qa" not in dev and "working-together" in dev
    assert "role-qa" in board_skills.enabled_for({}, "m2", "qa")
    # a member made by hand (no role pack) gets the shared skills and no role's
    none = board_skills.enabled_for({}, "m3", None)
    assert not [n for n in none if n.startswith("role-")]
    # a project switches a role skill off like any other; the member's own switch wins
    ops = {"board_skills": [{"skill": "role-dev", "on": False, "members_on": ["m1"]}]}
    assert "role-dev" not in board_skills.enabled_for(ops, "m9", "dev")
    assert "role-dev" in board_skills.enabled_for(ops, "m1", "dev")
    # a switch cannot hand one role another role's craft
    ops = {"board_skills": [{"skill": "role-qa", "members_on": ["m1"]}]}
    assert "role-qa" not in board_skills.enabled_for(ops, "m1", "dev")


def test_a_run_is_told_to_open_its_role_skill_first():
    block = _block(_member("qa"))
    assert "Open your role's skill `kanban-board:role-qa` before you start" in block
    assert "`kanban-board:working-together`" in block
    # the Designer's step already opens with its guide
    assert "Open your role's skill" not in _block(_member("designer"))
    # an agent outside Claude Code reads the same text through MCP
    other = _block(_member("dev", provider="gemini"))
    assert "docs_read(action='role_guide', query='dev')" in other
    assert "kanban-board:" not in other
    # switched off for the project: not pointed to
    settings = AiProjectSettings(
        ops=json.dumps({"board_skills": [{"skill": "role-qa", "on": False}]})
    )
    assert "role-qa" not in _block(_member("qa"), settings)


def test_the_coordination_rules_ride_in_every_run():
    block = _block(_member("dev"), team=["PM An (PM)", "QA Quyen (QA)"])
    assert "Teammate AIs (exact name, then role): PM An (PM), QA Quyen (QA)." in block
    assert any(
        "Stay in your role and start from the handoff" in r
        for r in shared_skills.CORE_RULES
    )
    text = shared_skills.guides()["working-together"]
    for needle in (
        "Read the handoff first",
        "Ask the PM rather than guess",
        "When you are blocked",
        "kind='blocked'",
        "When you disagree",
        'Never "nobody answered, so I chose"',
    ):
        assert needle in text, needle
    # every ready-made role is in the who-does-what table
    for pack in packs.BUILTIN:
        assert f"| {pack['name'].split(' (')[0]} |" in text, pack["key"]


def test_an_outside_agent_reads_the_same_text_as_the_role_skill():
    from kanban_mcp import operations as ops

    root = Path(board_skills.plugin_dir())
    for role, name, _d, body in role_skills.ROLE_SKILLS:
        got = asyncio.run(ops.role_guide(role))
        folder = got.pop("folder", None)
        assert got == {"role": role, "skill": name, "guide": body}
        # a guide whose skill carries files (the BA's templates) says where they are on this machine
        assert (folder is not None) == (name in role_skills.extra_files())
        skill = (root / "skills" / name / "SKILL.md").read_text(encoding="utf-8")
        assert skill.startswith(f"---\nname: {name}\n") and skill.endswith(body)
    index = asyncio.run(ops.role_guide())
    assert list(index["roles"]) == [r for r, _n, _d, _b in role_skills.ROLE_SKILLS]
    assert "design_guide" in asyncio.run(ops.role_guide("designer"))["guide"]
    # a role written as a person would still finds its guide; an unknown one says which exist
    assert asyncio.run(ops.role_guide("User tester"))["role"] == "user_tester"
    try:
        asyncio.run(ops.role_guide("astronaut"))
    except ValueError as exc:
        assert "tech_writer" in str(exc)
    else:
        raise AssertionError("an unknown role was accepted")


def test_the_new_roles_are_whole_packs():
    by_key = {p["key"]: p for p in packs.BUILTIN}
    for key in NEW_ROLES:
        p = by_key[key]
        assert p["name"] and p["glyph"] and p["tagline"] and p["hands_in"]
        assert len(p["persona"]) <= 1000, key
        assert f"`kanban-board:{role_skills.SKILL_OF_ROLE[key]}`" in p["persona"]
        assert "the board's shared skills" in p["persona"]
        # the role's command rules and their words, for the Safety screen
        assert tool_rules.ROLE_TOOLS[key] and tool_rules.ROLE_WORDS[key]
        assert packs.clean({**p}) and packs.role_name(key) == p["name"]
    # who must never change the product's code
    assert (
        by_key["security"]["writes"] == "nothing"
        and by_key["security"]["template"] == "reviewer"
    )
    assert "VERDICT" in by_key["security"]["persona"]
    # the plugin a pack names is in the catalogue and loads for that role
    from services.ai import plugins

    catalogue = {c["key"]: c for c in plugins.CATALOGUE}
    for key in NEW_ROLES:
        for plug in by_key[key]["plugins"]:
            assert key in catalogue[plug]["roles"], (key, plug)


def test_every_persona_fits_and_points_to_its_craft():
    for p in packs.BUILTIN:
        assert len(p["persona"]) <= 1000, p["key"]
        if p["key"] != "designer":
            assert (
                f"`kanban-board:{role_skills.SKILL_OF_ROLE[p['key']]}`" in p["persona"]
            ), p["key"]
    assert packs.BUILTIN_VERSION == 10
    assert packs.role_name("dev") == "Dev" and packs.role_name("my_role") == "my role"


def test_the_step_text_sends_a_question_to_the_right_place():
    from types import SimpleNamespace

    from services.ai import workflow

    text = workflow._instruction(
        {"key": "build", "label": "Build", "role": "dev"},
        SimpleNamespace(note_in=None),
        SimpleNamespace(template_name="Standard feature", review_depth=None),
        None,
        SimpleNamespace(id="KAN-1"),
    )
    assert "`working-together`" in text and "goes to the PM" in text
    # ai_run(ask) reaches the person, not the coordinator: the step text no longer says otherwise
    assert "ask the coordinator with ai_run" not in text


async def test_a_teammate_made_from_a_pack_is_listed_with_its_role(env):
    c = env["c"]
    from tests.test_ai import _project

    pid, _an = await _project(c)
    made = []
    for key, name in (("pm", "PM An"), ("qa", "QA Quyen")):
        r = await c.post(
            f"/projects/{pid}/ai/packs/{key}/member",
            json={"name": name, "working_dir": str(env["repo"])},
        )
        assert r.status_code == 201, r.text
        made.append(r.json())
    t = (await c.post(f"/projects/{pid}/tickets", json={"title": "Export"})).json()
    async with env["maker"]() as s:
        from models import AiRun

        from services.ai import runs
        from services.ai.store import get_profile

        run = AiRun(
            project_id=pid,
            ticket_id=t["id"],
            member_id=made[1]["id"],
            mode="work",
            trigger="assign",
            started_by="user",
            number=1,
        )
        s.add(run)
        await s.commit()
        await s.refresh(run)
        member, profile = await get_profile(s, made[1]["id"])
        prompt, _, _ = await runs._build_prompt(
            s, run, profile, member, resume_note=None
        )
    line = prompt.split("Teammate AIs (exact name, then role): ")[1].split("\n")[0]
    assert "PM An (PM)" in line and "QA Quyen" not in line
    assert "Open your role's skill `kanban-board:role-qa`" in prompt


async def test_the_ui_lists_each_role_skill_with_its_role(env):
    r = await env["c"].get("/ai/board-skills")
    rows = {s["name"]: s["role"] for s in r.json()}
    assert rows["role-pm"] == "pm" and rows["role-security-reviewer"] == "security"
    assert rows["working-together"] is None


def test_a_red_run_piped_into_tail_still_counts_as_the_same_test_command():
    """A live Dev ran the red test as `pytest -q t.py 2>&1 | tail -16` and the green one plain: the board saw no red
    run and marked the step unproven."""
    from services.ai.workflow import _test_command

    plain = "python3 -m pytest -q tests/test_web_undo.py"
    assert _test_command(plain + " 2>&1 | tail -16") == plain
    assert _test_command("npm test > out.txt") == "npm test"
    assert _test_command("pytest -q  2> /dev/null") == "pytest -q"
    # a different test file is still a different command
    assert _test_command("pytest -q tests/a.py") != _test_command(
        "pytest -q tests/b.py"
    )


def test_the_ba_picks_a_document_from_templates_it_carries():
    """Researched with the owner: one kind of document per situation, as a developer picks an architecture."""
    from services import ba_templates

    guide = role_skills.guide("ba")
    for key in ba_templates.DOCS:
        assert f"`{key}.md`" in guide, key
    assert (
        "`templates/quality-checklist.md`" in guide
        and "examples/feature-spec-example.md" in guide
    )
    # the rule that left two live BAs without a spec page is no longer a judgement call
    assert (
        "however simple its flow looks" in guide
        and "more than about five criteria" not in guide
    )
    for needle in (
        "When <event>",
        "While <state>",
        "If <unwanted condition>, then",
        "[NEEDS CLARIFICATION",
    ):
        assert needle in guide, needle
    # the files ride beside the skill
    root = (
        Path(board_skills.plugin_dir(["role-ba"])) / "skills" / "role-ba" / "templates"
    )
    for rel in ba_templates.files():
        assert (root.parent / rel).is_file(), rel
    feature = (root / "feature-spec.md").read_text(encoding="utf-8")
    for needle in (
        "on its own",
        "Given",
        "FR-001",
        "Edge cases",
        "Success criteria",
        "NEEDS CLARIFICATION",
    ):
        assert needle.lower() in feature.lower(), needle
    bug = (root / "bugfix-spec.md").read_text(encoding="utf-8")
    assert "## Current behaviour" in bug and "## Unchanged behaviour" in bug


async def test_a_person_starts_a_docs_page_from_the_bas_templates(env):
    from services import ba_templates
    from tests.test_ai import _project

    c = env["c"]
    tpls = {t["id"]: t for t in (await c.get("/docs/templates")).json()}
    for key, (name, _desc) in ba_templates.DOCS.items():
        assert tpls[key]["name"] == name and tpls[key]["markdown"] == ba_templates.text(
            key
        )
    assert "quality-checklist" not in tpls  # a check for the BA, not a page
    pid, _ = await _project(c)
    r = await c.post(
        f"/projects/{pid}/docs/pages",
        json={"title": "Bugfix: x", "template": "bugfix-spec"},
    )
    assert r.status_code in (200, 201), r.text


def test_the_desktop_app_bundles_the_templates():
    spec = (
        Path(__file__).resolve().parents[2] / "desktop" / "common_spec.py"
    ).read_text(encoding="utf-8")
    assert "'services', 'ba_templates'" in spec
