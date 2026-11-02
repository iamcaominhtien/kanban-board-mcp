"""The repository scan: applying packs' plugins and MCP, the fingerprint rescan and the light-model step."""

import json
from types import SimpleNamespace

import pytest

from models import AiAccount
from services.ai import plugins, repo_scan
from tests.test_ai import _project, env  # noqa: F401


def _repo(path, *, ui=True):
    path.mkdir(parents=True, exist_ok=True)
    deps = {"react": "18", "vite": "5"} if ui else {}
    (path / "package.json").write_text(
        json.dumps({"name": "app", "dependencies": deps, "scripts": {"test": "x"}})
    )
    return path


async def _scan(env, tmp_path, *, ui=True):
    pid, _ = await _project(env["c"])
    repo = _repo(tmp_path / "r", ui=ui)
    async with env["maker"]() as s:
        row = await repo_scan.run_scan(s, pid, str(repo), trial=False)
    return pid, repo, row


@pytest.fixture
def fake_install(monkeypatch):
    calls = []

    async def install(session, project_id, **kw):
        calls.append(kw["plugin"] or kw["source"])
        return SimpleNamespace(name=kw["plugin"] or kw["source"])

    monkeypatch.setattr(plugins, "install", install)
    return calls


async def _create(body):
    return SimpleNamespace(id="m1", name=body["name"])


async def test_apply_installs_pack_plugins_once_and_reports_mcp(
    env, tmp_path, fake_install
):
    _, _, row = await _scan(env, tmp_path)
    choice = {
        "team": [
            {"pack": "designer", "name": "D"},
            {"pack": "user_tester", "name": "U"},
        ],
        "plugins": ["design", "playwright"],
    }
    async with env["maker"]() as s:
        out = await repo_scan.apply(s, row.id, choice, by="t", create_member=_create)
    assert fake_install.count("design") == 1  # chosen and in the pack: once
    assert {"ui-ux-pro-max", "frontend-design"} <= set(out["plugins"]) or (
        "example-skills" in out["plugins"]
    )
    assert "Playwright MCP" in out["mcp"] and "Figma MCP" in out["mcp"]
    assert out["plugin_failures"] == []


async def test_apply_skips_what_the_project_already_has(env, tmp_path, monkeypatch):
    _, _, row = await _scan(env, tmp_path)
    seen = []

    async def install(session, project_id, **kw):
        seen.append(kw["plugin"])
        return SimpleNamespace(name=kw["plugin"])

    monkeypatch.setattr(plugins, "install", install)
    async with env["maker"]() as s:
        from models import AiPlugin

        s.add(AiPlugin(project_id=row.project_id, name="tdd", source="x"))
        await s.commit()
        await repo_scan.apply(
            s,
            row.id,
            {"team": [{"pack": "dev", "name": "Dev"}]},
            by="t",
            create_member=_create,
        )
    assert "tdd" not in seen


async def test_apply_reports_a_failing_install_and_skips_ui_plugins_without_ui(
    env, tmp_path, monkeypatch
):
    _, _, row = await _scan(env, tmp_path, ui=False)

    async def install(session, project_id, **kw):
        raise plugins.PluginError("offline")

    monkeypatch.setattr(plugins, "install", install)
    async with env["maker"]() as s:
        out = await repo_scan.apply(
            s,
            row.id,
            {"team": [{"pack": "designer", "name": "D"}], "plugins": ["playwright"]},
            by="t",
            create_member=_create,
        )
    assert out["mcp"] == [
        "Figma MCP"
    ]  # Playwright is a browser tool, and there is no UI
    assert {f["plugin"] for f in out["plugin_failures"]} >= {"design"}
    assert "webapp-testing" not in {f["plugin"] for f in out["plugin_failures"]}


async def test_a_changed_manifest_scans_again_and_an_unchanged_one_does_not(
    env, tmp_path
):
    pid, repo, row = await _scan(env, tmp_path)
    assert row.found and json.loads(row.found)["fingerprint"]
    async with env["maker"]() as s:
        assert await repo_scan.rescan_if_changed(s, pid) is False
    (repo / "package.json").write_text(json.dumps({"name": "app", "scripts": {}}))
    async with env["maker"]() as s:
        assert await repo_scan.rescan_if_changed(s, pid) is True
        assert await repo_scan.rescan_if_changed(s, pid) is False
    async with env["maker"]() as s:
        from sqlmodel import select

        from models import AiRepoScan

        rows = (await s.exec(select(AiRepoScan))).all()
    assert len(rows) == 2 and all(r.applied_at is None for r in rows)


async def test_sweep_rescans_only_changed_projects(env, tmp_path):
    pid, repo, _ = await _scan(env, tmp_path)
    assert await repo_scan.sweep(env["maker"]) == []
    (repo / ".github" / "workflows").mkdir(parents=True)
    (repo / ".github" / "workflows" / "ci.yml").write_text("run: pytest\n")
    assert await repo_scan.sweep(env["maker"]) == [pid]


async def _account(env):
    async with env["maker"]() as s:
        s.add(AiAccount(name="a", cli="claude", folder="/x", status="signed_in"))
        await s.commit()


async def test_the_light_model_refines_the_suggestion(env, tmp_path, monkeypatch):
    _, _, row = await _scan(env, tmp_path)
    await _account(env)

    async def ask(prompt, account):
        return '{"roles": ["dev", "qa", "bogus"], "plugins": ["design", "nope"], "why": "small repo"}'

    monkeypatch.setattr(repo_scan, "_ask_light", ask)
    found, base = json.loads(row.found), json.loads(row.suggested)
    async with env["maker"]() as s:
        out = await repo_scan.refine_suggestion(s, row.project_id, found, base)
    assert [t["pack"] for t in out["team"]] == ["dev", "qa"]
    assert out["plugins"] == ["design"] and out["why"]["refined"] == "small repo"


async def test_the_light_model_fails_soft(env, tmp_path, monkeypatch):
    _, _, row = await _scan(env, tmp_path)
    found, base = json.loads(row.found), json.loads(row.suggested)
    calls = []

    async def boom(prompt, account):
        calls.append(1)
        raise RuntimeError("down")

    monkeypatch.setattr(repo_scan, "_ask_light", boom)
    async with env["maker"]() as s:  # no Claude Code account: never asked
        assert await repo_scan.refine_suggestion(s, row.project_id, found, base) == base
    assert calls == []
    await _account(env)
    async with env["maker"]() as s:  # an error
        assert await repo_scan.refine_suggestion(s, row.project_id, found, base) == base

    async def junk(prompt, account):
        return "no json here"

    monkeypatch.setattr(repo_scan, "_ask_light", junk)
    async with env["maker"]() as s:
        assert await repo_scan.refine_suggestion(s, row.project_id, found, base) == base
