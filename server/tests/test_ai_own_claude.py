"""The person's own Claude Code plugins in the board's runs (services/ai/own_claude.py)."""

import json

from services.ai import own_claude


def _plugin(root, name):
    path = root / "plugins" / "cache" / name
    path.mkdir(parents=True)
    return str(path)


def test_the_plugins_installed_for_the_person_load_and_the_ones_switched_off_do_not(
    tmp_path,
):
    mine = _plugin(tmp_path, "frontend-design")
    off = _plugin(tmp_path, "noisy")
    project_only = _plugin(tmp_path, "one-project")
    switched_on = _plugin(tmp_path, "flow")
    (tmp_path / "plugins" / "installed_plugins.json").write_text(
        json.dumps(
            {
                "version": 2,
                "plugins": {
                    "frontend-design@x": [{"scope": "user", "installPath": mine}],
                    "noisy@x": [{"scope": "user", "installPath": off}],
                    "one-project@x": [{"scope": "local", "installPath": project_only}],
                    "flow@flow": [{"scope": "local", "installPath": switched_on}],
                    "gone@x": [
                        {"scope": "user", "installPath": str(tmp_path / "missing")}
                    ],
                },
            }
        )
    )
    (tmp_path / "settings.json").write_text(
        json.dumps({"enabledPlugins": {"noisy@x": False, "flow@flow": True}})
    )
    assert own_claude.plugin_dirs(tmp_path) == [mine, switched_on]
    listed = {p["name"]: p for p in own_claude.plugins(tmp_path)}
    assert listed["frontend-design@x"]["loaded"] and listed["flow@flow"]["loaded"]
    assert listed["noisy@x"]["reason"] == "Switched off in your Claude Code."
    assert "another project" in listed["one-project@x"]["reason"]
    assert listed["gone@x"]["reason"] == "Its folder is missing."
    # narrowed to some roles: the others do not load it
    roles = [{"plugin": "frontend-design@x", "roles": ["designer"]}]
    assert sorted(own_claude.for_role("designer", roles, tmp_path)) == sorted(
        [mine, switched_on]
    )
    assert own_claude.for_role("dev", roles, tmp_path) == [switched_on]


def test_no_claude_folder_means_no_plugins(tmp_path):
    assert own_claude.plugin_dirs(tmp_path / "nowhere") == []
