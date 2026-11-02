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
    # the rest of the Designer pack comes with it
    assert "https://github.com/LottieFiles/motion-design-skill" in out["plugins"]
    # Figma signs in through a browser, which a run cannot do: not in the Designer pack
    assert "Playwright MCP" in out["mcp"] and "Figma MCP" not in out["mcp"]
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
    # Playwright is a browser tool, and there is no UI (and Figma is not in the Designer pack)
    assert out["mcp"] == []
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


# --------------------------------------------------------------------------- the AI sets up the commands


import asyncio  # noqa: E402

from services.ai import project_env  # noqa: E402


def _tool(folder, name, body="echo from-tool"):
    folder.mkdir(parents=True, exist_ok=True)
    prog = folder / name
    prog.write_text(f"#!/bin/sh\n{body}\n")
    prog.chmod(0o755)
    return folder


async def _until_done(c, scan_id):
    for _ in range(300):
        scan = (await c.get(f"/ai/scans/{scan_id}")).json()
        if scan["job"].get("state") != "running":
            return scan
        await asyncio.sleep(0.1)
    raise AssertionError("the job never finished")


@pytest.fixture
def ai_on(monkeypatch):
    async def available(session, force=False):
        return {"available": True, "why": None}

    monkeypatch.setattr(repo_scan, "ai_status", available)


def test_the_server_tells_a_wrong_command_from_a_failing_project():
    assert repo_scan.classify(0, "") == "works"
    assert repo_scan.classify(127, "sh: npm: command not found") == "wrong"
    assert repo_scan.classify(1, 'npm error Missing script: "lint:ci"') == "wrong"
    assert repo_scan.classify(1, "FAIL src/a.test.ts\nTests  2 failed") == "fails"
    assert repo_scan.classify(None, "", timed_out=True) == "timeout"


def test_a_package_manager_with_no_package_json_is_a_wrong_command():
    npm = (
        "npm error code ENOENT\nnpm error syscall open\nnpm error path /r/package.json\nnpm error errno -2\n"
        "npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '/r/package.json'"
    )
    assert repo_scan.classify(254, npm) == "wrong"
    assert (
        repo_scan.classify(1, 'error Couldn\'t find a package.json file in "/r"')
        == "wrong"
    )
    assert (
        repo_scan.classify(
            1, " ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND  No package.json was found"
        )
        == "wrong"
    )
    assert "package.json" in repo_scan._why_wrong(npm, 254)
    # a test that fails because its own fixture is missing ran: the project fails, the command is right
    assert (
        repo_scan.classify(
            1,
            "FAIL a.test.ts\nError: ENOENT: no such file or directory, open 'fixtures/x.json'",
        )
        == "fails"
    )


def test_a_missing_input_of_the_program_itself_is_a_wrong_command():
    """RC-2: the script, the Makefile target or the test path the command names is not there."""
    wrong = [
        "npm ERR! enoent ENOENT: no such file or directory, open '/r/package.json'",
        "python: can't open file '/r/manage.py': [Errno 2] No such file or directory",
        "bash: ./scripts/ci.sh: No such file or directory",
        "make: *** No rule to make target 'lint'.  Stop.",
        "make: *** No targets specified and no makefile found.  Stop.",
        "ERROR: file or directory not found: tests/",
    ]
    for out in wrong:
        assert repo_scan.classify(2, out) == "wrong", out
        assert repo_scan._why_wrong(out, 2) == out
    # the project's own build missing a file it needs ran: the command is right
    assert (
        repo_scan.classify(
            2, "make: *** No rule to make target 'a.o', needed by 'app'.  Stop."
        )
        == "fails"
    )
    assert (
        repo_scan.classify(1, "sh: line 3: tool: No such file or directory\n1 failed")
        == "fails"
    )


async def test_every_command_gets_its_own_result(tmp_path):
    repo = _repo(tmp_path / "r")
    out = await repo_scan.try_commands(
        str(repo),
        {
            "prepare": "true",
            "test": "echo 'FAIL a'; exit 1",
            "lint": "no-such-tool-xyz --check",
            "build": "echo built",
        },
    )
    assert out["prepare"]["status"] == "works"
    assert out["test"]["status"] == "fails"  # one failing does not hide the next
    assert out["lint"]["status"] == "wrong" and out["lint"]["exit_code"] == 127
    assert "not found" in out["lint"]["reason"]
    assert out["build"]["status"] == "works" and out["build"]["tail"] == ["built"]


async def test_the_project_path_goes_in_front_of_the_apps(tmp_path):
    repo = _repo(tmp_path / "r")
    tools = _tool(tmp_path / "tools", "mytool-xyz")
    without = await repo_scan.try_commands(str(repo), {"test": "mytool-xyz"})
    assert without["test"]["status"] == "wrong"
    with_path = await repo_scan.try_commands(
        str(repo), {"test": "mytool-xyz"}, [str(tools)]
    )
    assert with_path["test"]["status"] == "works"
    assert with_path["test"]["tail"] == ["from-tool"]


def test_the_programs_a_command_needs_and_where_they_are(tmp_path, monkeypatch):
    assert project_env.programs("npm --prefix ui ci && uv --directory server sync") == [
        "npm",
        "uv",
    ]
    assert project_env.programs("PATH=/x:$PATH npm test; cd ui && ./gradlew b") == [
        "npm"
    ]
    tools = _tool(tmp_path / "bin", "mytool-xyz")
    monkeypatch.setattr(project_env, "_TOOL_DIRS", (str(tools),))
    assert project_env.missing_folders(["mytool-xyz run"], "/usr/bin:/bin") == [
        {"path": str(tools), "program": "mytool-xyz"}
    ]
    assert project_env.missing_folders(["sh -c true"], "/usr/bin:/bin") == []
    env = project_env.with_path({"PATH": "/usr/bin:/bin"}, [str(tools), "/usr/bin"])
    assert env["PATH"] == f"{tools}:/usr/bin:/bin"


def test_a_manifest_under_a_hidden_folder_is_tooling(tmp_path):
    repo = _repo(tmp_path / "r")
    tool = repo / ".github" / "skills" / "x" / "scripts"
    tool.mkdir(parents=True)
    (tool / "pyproject.toml").write_text("[project]\nname='x'\n")
    (tool / "uv.lock").write_text("")
    found = repo_scan.scan(str(repo))
    assert [p["path"] for p in found["packages"]] == ["."]
    assert ".github" not in repo_scan.suggest(found)["prepare"]


async def test_the_ai_proposes_and_the_board_proves_each_command(
    env, tmp_path, monkeypatch, ai_on
):
    _, _, row = await _scan(env, tmp_path)
    tools = _tool(tmp_path / "tools", "mytool-xyz")
    monkeypatch.setattr(project_env, "_TOOL_DIRS", (str(tools),))
    seen = {}
    # The fake AI waits until the test has seen the job running and the second ask refused: a job that finished
    # first made the 409 check depend on timing
    release = asyncio.Event()

    async def fake_ai(prompt, cwd, account, on_line):
        seen["prompt"], seen["cwd"] = prompt, cwd
        on_line("Read package.json")
        await release.wait()
        return json.dumps(
            {
                "commands": {
                    "prepare": {"command": "true", "source": "package.json"},
                    "test": {
                        "command": "mytool-xyz",
                        "source": "package.json › scripts.test",
                        "note": "",
                    },
                    "lint": {
                        "command": "echo 'lint failed'; exit 2",
                        "source": "ci.yml",
                    },
                    "build": {"command": "", "source": ""},
                },
                "notes": "One app at the root.",
            }
        )

    monkeypatch.setattr(repo_scan, "_ask_ai", fake_ai)
    c = env["c"]
    r = await c.post(f"/ai/scans/{row.id}/ai", json={"hint": "the app is at the root"})
    assert r.status_code == 200, r.text
    assert r.json()["job"]["state"] == "running"
    again = await c.post(f"/ai/scans/{row.id}/ai", json={})
    assert again.status_code == 409  # one job at a time
    release.set()
    scan = await _until_done(c, row.id)
    assert scan["job"]["state"] == "done", scan["job"]
    assert "The person says: the app is at the root" in seen["prompt"]
    assert seen["cwd"] != row.folder  # the AI reads a temporary copy
    assert (
        scan["proposal"]["commands"]["test"]["source"] == "package.json › scripts.test"
    )
    assert scan["proposal"]["env_path"] == [
        {"path": str(tools), "by": "ai", "why": "mytool-xyz was found here"}
    ]
    trial = scan["trial"]
    assert trial["prepare"]["status"] == "works"
    # proven by the board itself, with the folder the AI's step found in front of the PATH
    assert trial["test"]["status"] == "works" and trial["test"]["tail"] == ["from-tool"]
    assert trial["lint"]["status"] == "fails"
    assert trial["build"] is None
    assert any("Read package.json" in line for line in scan["job"]["log"])
    keys = [s["key"] for s in scan["job"]["steps"]]
    assert keys == ["ai", "path", "prepare", "test", "lint", "build"]
    latest = (await c.get(f"/projects/{scan['project_id']}/ai/scans/latest")).json()
    assert latest["id"] == row.id


async def test_the_ai_is_refused_when_claude_code_is_not_there(
    env, tmp_path, monkeypatch
):
    _, _, row = await _scan(env, tmp_path)

    async def unavailable(session, force=False):
        return {
            "available": False,
            "why": "Claude Code is not signed in on this computer.",
        }

    monkeypatch.setattr(repo_scan, "ai_status", unavailable)
    r = await env["c"].post(f"/ai/scans/{row.id}/ai", json={})
    assert r.status_code == 422
    assert "not signed in" in r.json()["detail"]
    scan = (await env["c"].get(f"/ai/scans/{row.id}")).json()
    assert scan["ai_available"] is False
    assert scan["ai_unavailable_why"].startswith("Claude Code is not signed in")


async def test_cancel_stops_a_running_trial(env, tmp_path):
    _, _, row = await _scan(env, tmp_path)
    c = env["c"]
    r = await c.post(
        f"/ai/scans/{row.id}/try",
        json={"commands": {"prepare": "", "test": "sleep 30"}, "env_path": []},
    )
    assert r.status_code == 200, r.text
    for _ in range(100):
        scan = (await c.get(f"/ai/scans/{row.id}")).json()
        if (scan["trial"].get("test") or {}).get("status") == "running":
            break
        await asyncio.sleep(0.1)
    r = await c.post(f"/ai/scans/{row.id}/cancel")
    scan = r.json()
    assert scan["job"]["state"] == "cancelled"
    assert scan["job"]["elapsed_s"] < 20
    assert scan["trial"]["test"]["status"] == "not_run"
    assert scan["trial"]["test"]["reason"] == "Cancelled."


async def test_one_rows_run_keeps_the_others_results(env, tmp_path):
    _, _, row = await _scan(env, tmp_path)
    c = env["c"]
    await c.post(
        f"/ai/scans/{row.id}/try",
        json={"commands": {"test": "true", "lint": "exit 1"}, "env_path": []},
    )
    first = await _until_done(c, row.id)
    assert first["trial"]["lint"]["status"] == "fails"
    await c.post(
        f"/ai/scans/{row.id}/try",
        json={"commands": {"test": "true", "lint": "true"}, "only": ["lint"]},
    )
    second = await _until_done(c, row.id)
    assert second["trial"]["lint"]["status"] == "works"
    assert second["trial"]["test"]["status"] == "works"  # kept from the first run


async def test_apply_saves_the_environment_and_the_checks_that_are_off(
    env, tmp_path, fake_install
):
    _, _, row = await _scan(env, tmp_path)
    out = (
        await env["c"].post(
            f"/ai/scans/{row.id}/apply",
            json={
                "team": [],
                "commands": {"test": "npm test", "lint": "npm run lint"},
                "env_path": ["/opt/homebrew/bin", " "],
                "checks_off": ["test", "nope"],
            },
        )
    ).json()
    assert out["settings"]["env_path"] == ["/opt/homebrew/bin"]
    assert out["settings"]["checks_off"] == ["test"]


async def test_a_folder_the_members_could_not_work_in_is_refused_at_step_one(
    env, tmp_path, monkeypatch
):
    """Create would skip every member made for it (services/ai/paths.py), so the scan says so first."""
    from services.ai import paths

    monkeypatch.setenv(paths.ROOTS_ENV, str(tmp_path / "work"))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    pid, _ = await _project(env["c"])
    repo = _repo(tmp_path / "elsewhere" / "r")
    r = await env["c"].post(
        f"/projects/{pid}/ai/scan", json={"folder": str(repo), "trial": False}
    )
    assert r.status_code == 422
    assert "inside your home folder" in r.json()["detail"]
    assert str(repo) in r.json()["detail"]
    ok = _repo(tmp_path / "work" / "r")
    r = await env["c"].post(
        f"/projects/{pid}/ai/scan", json={"folder": str(ok), "trial": False}
    )
    assert r.status_code == 201, r.text
