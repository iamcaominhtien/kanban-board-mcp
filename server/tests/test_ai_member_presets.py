"""The ready-made AI members of the Add dialog (PM, Dev, Reviewer): the data file the UI and the guideline share, and
that a member created the way the dialog creates one keeps the template, ceiling and CLI rules of its preset."""

import json
from pathlib import Path

import pytest

from services.ai.members import MAX_PERSONA
from services.ai.permissions import CEILINGS, TEMPLATES
from tests.test_ai import _project, env  # noqa: F401

PRESETS = json.loads(
    (Path(__file__).parents[2] / "ui/src/components/ai/memberPresets.json").read_text(
        encoding="utf-8"
    )
)
READ_ONLY_CLI = {"pm", "reviewer"}  # they never edit files


def test_the_three_roles_are_there_in_both_languages():
    assert [p["id"] for p in PRESETS] == ["pm", "dev", "reviewer"]
    for p in PRESETS:
        for lang in ("en", "vi"):
            assert p["tagline"][lang] and p["description"][lang]
            assert 0 < len(p["persona"][lang]) <= MAX_PERSONA, (p["id"], lang)
        assert p["template"] in TEMPLATES and p["template"] != "custom"
        assert p["ceiling"] in CEILINGS
        assert 1 <= p["maxParallel"] <= 10 and 1 <= p["maxRunsPerDay"] <= 500


@pytest.mark.parametrize("pid", sorted(READ_ONLY_CLI))
def test_roles_that_never_edit_files_do_not_get_edit_or_write(pid):
    preset = next(p for p in PRESETS if p["id"] == pid)
    allow = preset["cliAllow"]
    assert "Read" in allow and "Edit" not in allow and "Write" not in allow


async def test_a_member_created_from_a_preset_keeps_its_template_ceiling_and_cli_rules(
    env,
):
    c = env["c"]
    pid, _ = await _project(c)
    for preset in PRESETS:
        body = {
            "name": preset["name"],
            "provider": "claude-code",
            "working_dir": env["repo"],
            "cli_path": "x",
            "model": "sonnet",
            "description": preset["description"]["en"],
            "persona": preset["persona"]["en"],
            "max_parallel": preset["maxParallel"],
            "max_runs_per_day": preset["maxRunsPerDay"],
            "ceiling": preset["ceiling"],
            "template": preset["template"],
            "permissions": {},
        }
        if "cliAllow" in preset:
            body["config"] = {"allow_rules": preset["cliAllow"]}
        r = await c.post(f"/projects/{pid}/ai/members", json=body)
        assert r.status_code in (200, 201), (preset["id"], r.text)
        m = (await c.get(f"/ai/members/{r.json()['id']}")).json()
        assert m["template"] == preset["template"]
        assert m["ceiling"] == preset["ceiling"]
        assert m["persona"] == preset["persona"]["en"]
        if "cliAllow" in preset:
            assert m["config"]["allow_rules"] == preset["cliAllow"]
        else:  # Dev keeps the default rules, with Edit and Write
            assert "Edit" in m["config"]["allow_rules"]
