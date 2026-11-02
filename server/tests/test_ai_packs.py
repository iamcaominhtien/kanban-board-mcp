"""Members made from the ready-made packs get the tools their pack's work needs."""

from services.ai import packs
from tests.test_ai import env  # noqa: F401


def _pack(key: str) -> dict:
    return next(p for p in packs.BUILTIN if p["key"] == key)


def test_a_pack_that_changes_code_can_edit_files_and_run_commands():
    for key in ("dev", "qa"):
        allow = packs.member_body(
            _pack(key), name="x", working_dir=None, account_id=None
        )["config"]["allow_rules"]
        assert {"Edit", "Write", "Bash"} <= set(allow), key


def test_a_pack_that_writes_nothing_keeps_its_own_narrow_list():
    for key in ("triage", "pm", "reviewer"):
        allow = packs.member_body(
            _pack(key), name="x", working_dir=None, account_id=None
        )["config"]["allow_rules"]
        assert allow == list(_pack(key)["allow"]), key
        assert "Bash" not in allow, key
        # the PM writes the file of a Diagram of a plan; it never gets a shell to change code with
        assert ("Edit" in allow) == (key == "pm"), key


def test_triage_sets_labels_without_asking_and_makes_nothing_else():
    from services.ai.permissions import ALLOWED, BLOCKED, TEMPLATES, validate_overrides

    body = packs.member_body(
        _pack("triage"), name="x", working_dir=None, account_id=None
    )
    got = {
        **TEMPLATES[body["template"]],
        **validate_overrides(body["template"], body["permissions"]),
    }
    assert got["edit_fields"] == ALLOWED
    assert all(
        got[a] == BLOCKED
        for a in ("create_tickets", "edit_docs", "create_branches", "change_assignee")
    )


def test_an_ai_writing_its_own_work_log_needs_only_the_comment_right():
    from services.ai import guard

    assert guard.classify("ticket_items", "work_log.add", {}) == ["comment"]
    assert guard.classify("ticket_items", "criterion.add", {}) == ["edit_fields"]
    # ticking off what was checked is verifying (a reviewer may); writing a new criterion still edits the ticket
    assert guard.classify("ticket_items", "criterion.toggle", {}) == [
        "manage_test_cases"
    ]
    assert guard.classify("ticket_items", "sub_task.toggle", {}) == [
        "manage_test_cases"
    ]


def _body(key: str) -> dict:
    return packs.member_body(_pack(key), name="x", working_dir=None, account_id=None)


def test_a_designer_gets_figma_and_a_user_tester_gets_playwright():
    figma = _body("designer")["config"]["mcp_servers"]
    # the Designer looks at its own frames in a browser too
    assert [s["name"] for s in figma] == ["figma", "playwright"]
    assert figma[0]["type"] == "http" and figma[0]["url"].startswith("https://")
    tester = _body("user_tester")["config"]
    assert [s["name"] for s in tester["mcp_servers"]] == ["playwright"]
    assert tester["mcp_servers"][0]["command"] == "npx"
    assert tester["hands_in"] == _pack("user_tester")["hands_in"]


def test_a_pack_carries_its_models_and_plugins_on_the_member():
    dev = _body("dev")["config"]
    assert dev["retry_model"] == "opus" and dev["pack_plugins"] == ["tdd"]
    assert "depth_models" in _body("reviewer")["config"]
    assert _body("designer")["config"]["pack_plugins"] == _pack("designer")["plugins"]


def test_a_pack_without_mcp_or_plugins_adds_nothing():
    cfg = _body("triage")["config"]
    assert "mcp_servers" not in cfg and "pack_plugins" not in cfg


def test_an_unknown_mcp_key_is_skipped():
    pack = {**_pack("designer"), "mcp": ["figma", "nope"]}
    cfg = packs.member_body(pack, name="x", working_dir=None, account_id=None)["config"]
    assert [s["name"] for s in cfg["mcp_servers"]] == ["figma"]


def test_the_roles_know_which_drawing_to_use():
    from kanban_mcp import instructions
    from services.ai import packs

    personas = {p["key"]: p["persona"] for p in packs.BUILTIN}
    for role in ("ba", "pm", "dev", "designer"):
        assert "draw.io Diagram" in personas[role], role
    assert "HTML frames on a Canvas" in personas["designer"]
    text = (
        instructions.INSTRUCTIONS
        if hasattr(instructions, "INSTRUCTIONS")
        else instructions._INSTRUCTIONS_TAIL
    )
    assert "Which drawing" in text


def test_the_designer_may_write_the_frame_files_a_canvas_is_made_from():
    from services.ai import packs

    body = packs.member_body(
        packs.builtin("designer"), name="D", working_dir="/tmp", account_id=None
    )
    allow = body["config"]["allow_rules"]
    assert {"Write", "Edit"} <= set(allow) and "Bash" not in allow


def test_each_role_has_the_tools_for_what_it_hands_in():
    from services.ai import packs

    def allow(key):
        return set(
            packs.member_body(
                packs.builtin(key), name=key, working_dir="/tmp", account_id=None
            )["config"]["allow_rules"]
        )

    # a Diagram or a Sketch is written as a file first, then made with docs_write
    for key in ("ba", "pm", "designer"):
        assert "Write" in allow(key), key
    # the User tester starts the app it tries; a shell beyond that stays closed
    tester = allow("user_tester")
    assert "Bash(npm run dev:*)" in tester and "Bash" not in tester
    for key in ("ba", "pm", "designer", "triage"):
        assert "Bash" not in allow(key), key


async def test_a_member_made_from_an_older_pack_is_offered_the_update_and_keeps_its_own(
    env,
):
    import json as _json

    from models import AiMember
    from tests.test_ai import _project

    c = env["c"]
    pid, _ = await _project(c)
    m = (
        await c.post(
            f"/projects/{pid}/ai/packs/designer/member",
            json={"name": "Designer Duyen", "working_dir": env["repo"]},
        )
    ).json()
    state = (await c.get(f"/ai/members/{m['id']}/pack")).json()
    assert state["version"] == packs.BUILTIN_VERSION and state["outdated"] is False
    # made from the first version: read-only tools, an old persona; a person picked its model and added a server
    async with env["maker"]() as s:
        p = await s.get(AiMember, m["id"])
        cfg = _json.loads(p.config)
        cfg["pack"]["version"] = 1
        cfg["allow_rules"] = ["Read", "Glob", "Grep"]
        cfg["mcp_servers"] = [
            *cfg.get("mcp_servers", []),
            {"name": "mine", "type": "http", "url": "https://x"},
        ]
        p.config, p.persona, p.model = _json.dumps(cfg), "old persona", "haiku"
        s.add(p)
        await s.commit()
    assert (await c.get(f"/ai/members/{m['id']}/pack")).json()["outdated"] is True
    r = await c.post(f"/ai/members/{m['id']}/pack/update")
    assert r.status_code == 200, r.text
    assert r.json()["outdated"] is False
    async with env["maker"]() as s:
        p = await s.get(AiMember, m["id"])
        cfg = _json.loads(p.config)
    assert "Write" in cfg["allow_rules"] and "HTML frames on a Canvas" in p.persona
    assert p.model == "haiku"  # the person's choice stays
    assert any(srv["name"] == "mine" for srv in cfg["mcp_servers"])


async def test_the_owner_makes_pack_members_that_bypass_permissions_but_triage(env):
    import json as _json

    from models import AiMember
    from tests.test_ai import _project

    c = env["c"]
    pid, _ = await _project(c)
    made = {}
    for key in ("triage", "dev", "designer"):
        m = (
            await c.post(
                f"/projects/{pid}/ai/packs/{key}/member",
                json={"name": key.title(), "working_dir": env["repo"]},
            )
        ).json()
        async with env["maker"]() as s:
            made[key] = _json.loads((await s.get(AiMember, m["id"])).config)[
                "permission_mode"
            ]
    assert made == {"triage": "allowlist", "dev": "bypass", "designer": "bypass"}
