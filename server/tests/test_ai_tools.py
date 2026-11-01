"""Skills and plugins from a source, role packs and the repository scan (design/screens/ai-team-process.md B, C, D),
against local git repositories (file:// URLs): no network."""

import json
import subprocess
from pathlib import Path

import pytest

from services.ai import packs, plugins, repo_scan
from tests.test_ai import FAKE, _project, _runner, _ticket, _wait, env  # noqa: F401


def _git(cwd, *args):
    return subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=T", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=True,
    )


def _skill(folder: Path, name: str, body: str = "Do it.") -> None:
    (folder / name).mkdir(parents=True, exist_ok=True)
    (folder / name / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {name} skill.\n---\n{body}\n"
    )


def _repo(path: Path) -> str:
    _git(path, "init", "-q", "-b", "main")
    _git(path, "add", "-A")
    _git(path, "commit", "-q", "-m", "v1")
    return f"file://{path}"


@pytest.fixture(autouse=True)
def _runs_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("KANBAN_AI_RUNS_DIR", str(tmp_path / "ai-runs"))


# --------------------------------------------------------------------------- layouts


def test_a_plugin_at_the_root_is_used_as_it_is(tmp_path):
    src = tmp_path / "p"
    (src / ".claude-plugin").mkdir(parents=True)
    (src / ".claude-plugin" / "plugin.json").write_text(
        json.dumps({"name": "ui-ux-pro-max", "version": "2.15.0"})
    )
    _skill(src / ".claude" / "skills", "ui-ux-pro-max")
    info = plugins.build(src, into=tmp_path / "out")
    assert info["name"] == "ui-ux-pro-max"
    assert info["version"] == "2.15.0"
    assert info["skills"] == ["ui-ux-pro-max"]


def test_a_marketplace_entry_that_is_a_folder(tmp_path):
    src = tmp_path / "m"
    (src / ".claude-plugin").mkdir(parents=True)
    (src / ".claude-plugin" / "marketplace.json").write_text(
        json.dumps(
            {
                "name": "kw",
                "plugins": [
                    {"name": "design", "source": "./design", "description": "Design"},
                    {
                        "name": "x",
                        "source": {"source": "git-subdir", "url": "https://e/x.git"},
                    },
                ],
            }
        )
    )
    (src / "design" / ".claude-plugin").mkdir(parents=True)
    (src / "design" / ".claude-plugin" / "plugin.json").write_text(
        json.dumps({"name": "design", "version": "1.2.0"})
    )
    for s in ("design-critique", "ux-copy"):
        _skill(src / "design" / "skills", s)
    assert [c["name"] for c in plugins.build(src, into=tmp_path / "c")["choices"]] == [
        "design",
        "x",
    ]
    info = plugins.build(src, plugin="design", into=tmp_path / "out")
    assert info["skills"] == ["design-critique", "ux-copy"]
    with pytest.raises(plugins.PluginError, match="another repository"):
        plugins.build(src, plugin="x", into=tmp_path / "out2")


def test_a_marketplace_entry_that_lists_skills_and_a_subset_of_them(tmp_path):
    src = tmp_path / "skills-repo"
    (src / ".claude-plugin").mkdir(parents=True)
    (src / ".claude-plugin" / "marketplace.json").write_text(
        json.dumps(
            {
                "plugins": [
                    {
                        "name": "example-skills",
                        "source": "./",
                        "skills": [
                            "./skills/frontend-design",
                            "./skills/canvas-design",
                            "./skills/webapp-testing",
                        ],
                    }
                ]
            }
        )
    )
    for s in ("frontend-design", "canvas-design", "webapp-testing", "pdf"):
        _skill(src / "skills", s)
    whole = plugins.build(src, plugin="example-skills", into=tmp_path / "a")
    assert whole["skills"] == ["canvas-design", "frontend-design", "webapp-testing"]
    one = plugins.build(
        src, plugin="example-skills", skills=["frontend-design"], into=tmp_path / "b"
    )
    assert one["name"] == "frontend-design"
    assert one["skills"] == ["frontend-design"]
    assert (
        json.loads((tmp_path / "b" / ".claude-plugin" / "plugin.json").read_text())[
            "name"
        ]
        == "frontend-design"
    )


def test_a_bare_skills_folder_and_a_single_skill(tmp_path):
    bare = tmp_path / "bare"
    _skill(bare / "skills", "tdd")
    assert plugins.build(bare, into=tmp_path / "o1")["skills"] == ["tdd"]
    single = tmp_path / "single"
    single.mkdir()
    (single / "SKILL.md").write_text("---\nname: single\ndescription: s\n---\nx")
    assert plugins.build(single, into=tmp_path / "o2")["skills"] == ["single"]
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(plugins.PluginError, match="No plugin"):
        plugins.build(empty, into=tmp_path / "o3")


def _market(src: Path, entry: dict) -> None:
    (src / ".claude-plugin").mkdir(parents=True, exist_ok=True)
    (src / ".claude-plugin" / "marketplace.json").write_text(
        json.dumps({"plugins": [{"name": "evil", "source": "./", **entry}]})
    )


def test_a_marketplace_cannot_copy_files_from_outside_its_checkout(tmp_path):
    secret = tmp_path / "home" / ".ssh"
    secret.mkdir(parents=True)
    (secret / "id_rsa").write_text("PRIVATE KEY")
    src = tmp_path / "repo"
    _skill(src / "skills", "ok")
    for listed in (["../home/.ssh"], [str(secret)], ["./skills/../../home/.ssh"]):
        _market(src, {"skills": listed})
        with pytest.raises(plugins.PluginError, match="outside its own repository"):
            plugins.build(src, plugin="evil", into=tmp_path / "out")
        assert not (tmp_path / "out" / "skills" / ".ssh").exists()
    # a sibling folder whose name starts like the checkout's is outside it too
    _skill(tmp_path / "repo-other" / "skills", "x")
    _market(src, {"source": "../repo-other"})
    with pytest.raises(plugins.PluginError, match="outside its own repository"):
        plugins.build(src, plugin="evil", into=tmp_path / "out2")


def test_a_link_in_a_plugin_is_refused_and_a_huge_one_is_not_copied(
    tmp_path, monkeypatch
):
    secret = tmp_path / "home"
    secret.mkdir()
    (secret / "id_rsa").write_text("PRIVATE KEY")
    src = tmp_path / "linked"
    _skill(src / "skills", "tdd")
    (src / "skills" / "tdd" / "keys").symlink_to(secret, target_is_directory=True)
    with pytest.raises(plugins.PluginError, match="is a link"):
        plugins.build(src, into=tmp_path / "out")
    assert not (tmp_path / "out" / "skills" / "tdd" / "keys").exists()
    big = tmp_path / "big"
    _skill(big / "skills", "tdd")
    (big / "skills" / "tdd" / "blob.bin").write_bytes(b"x" * 2048)
    monkeypatch.setattr(plugins, "MAX_PLUGIN_BYTES", 1024)
    with pytest.raises(plugins.PluginError, match="larger than"):
        plugins.build(big, into=tmp_path / "out-big")
    assert not (tmp_path / "out-big").exists()


def test_a_git_url_is_never_read_as_an_option(tmp_path, monkeypatch):
    seen = []

    def fake_run(args, cwd=None, timeout=300):
        seen.append(args)
        return subprocess.CompletedProcess(args, 1, "", "nope")

    monkeypatch.setattr(plugins, "_run", fake_run)
    with pytest.raises(plugins.PluginError):
        plugins._clone("--upload-pack=touch /tmp/x", None, str(tmp_path / "c"))
    with pytest.raises(plugins.PluginError):
        plugins._clone("--upload-pack=x", "abc1234", str(tmp_path / "d"))
    for args in seen:
        assert args.index("--") < args.index(
            next(a for a in args if a.startswith("--upload-pack"))
        )


# --------------------------------------------------------------------------- install, update, roll back, pin


async def test_install_update_rollback_pin_and_remove(env, tmp_path, monkeypatch):
    c = env["c"]
    monkeypatch.setattr(plugins, "cache_root", lambda: _mk(tmp_path / "cache"))
    pid, _ = await _project(c)
    src = tmp_path / "tdd-plugin"
    _skill(src / "skills", "red-green")
    url = _repo(src)
    pre = (
        await c.post(
            f"/projects/{pid}/ai/plugins/preview",
            json={"source_kind": "git", "source": url},
        )
    ).json()
    assert pre["skills"] == ["red-green"]
    assert pre["commit"]
    r = await c.post(
        f"/projects/{pid}/ai/plugins",
        json={"source_kind": "git", "source": url, "roles": ["dev"]},
    )
    assert r.status_code == 201, r.text
    plug = r.json()
    assert Path(plugins.cache_root(), plug["id"]).is_dir()
    dup = await c.post(
        f"/projects/{pid}/ai/plugins", json={"source_kind": "git", "source": url}
    )
    assert dup.status_code == 422
    # a new commit upstream: offered, never applied on its own
    _skill(src / "skills", "refactor")
    _git(src, "add", "-A")
    _git(src, "commit", "-q", "-m", "v2")
    up = (await c.get(f"/ai/plugins/{plug['id']}/update")).json()
    assert up["update"] is True
    diff = (await c.get(f"/ai/plugins/{plug['id']}/changes")).json()
    assert any("refactor" in f for f in diff["added"])
    updated = (await c.post(f"/ai/plugins/{plug['id']}/update")).json()
    assert sorted(updated["skills"]) == ["red-green", "refactor"]
    assert updated["has_previous"] is True
    back = (await c.post(f"/ai/plugins/{plug['id']}/rollback")).json()
    assert back["skills"] == ["red-green"]
    pinned = (await c.post(f"/ai/plugins/{plug['id']}/pin")).json()
    assert pinned["pinned"] is True
    assert (await c.get(f"/ai/plugins/{plug['id']}/update")).json() == {
        "update": False,
        "pinned": True,
    }
    assert (await c.post(f"/ai/plugins/{plug['id']}/update")).status_code == 422
    assert (await c.delete(f"/ai/plugins/{plug['id']}")).status_code == 204
    assert not Path(plugins.cache_root(), plug["id"]).exists()


def _mk(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


async def test_a_member_of_the_role_gets_the_plugin_in_its_run_and_can_switch_it_off(
    env, tmp_path, monkeypatch
):
    c = env["c"]
    monkeypatch.setattr(plugins, "cache_root", lambda: _mk(tmp_path / "cache"))
    record = tmp_path / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    pid, _ = await _project(c)
    src = tmp_path / "tdd"
    _skill(src / "skills", "red-green")
    plug = (
        await c.post(
            f"/projects/{pid}/ai/plugins",
            json={"source_kind": "folder", "source": str(src), "roles": ["dev"]},
        )
    ).json()
    dev = (
        await c.post(
            f"/projects/{pid}/ai/packs/dev/member",
            json={"name": "Dev An", "working_dir": env["repo"]},
        )
    ).json()
    await c.patch(f"/ai/members/{dev['id']}", json={"cli_path": FAKE})
    other = await _runner(c, pid, env["repo"], name="Claude Code · Other")
    t1 = await _ticket(c, pid, "one")
    await c.post(
        f"/tickets/{t1}/ai/assign", json={"member_id": dev["id"], "start": "now"}
    )
    await _wait(c, t1, ("finished",))
    args = [json.loads(x) for x in record.read_text().splitlines()][-1]
    assert plug["id"] in " ".join(
        args[i + 1] for i, a in enumerate(args) if a == "--plugin-dir"
    )
    t2 = await _ticket(c, pid, "two")
    await c.post(
        f"/tickets/{t2}/ai/assign", json={"member_id": other["id"], "start": "now"}
    )
    await _wait(c, t2, ("finished",))
    args = [json.loads(x) for x in record.read_text().splitlines()][-1]
    assert "--plugin-dir" not in args  # not its role, and no default
    await c.put(f"/ai/plugins/{plug['id']}/members/{dev['id']}", json={"on": False})
    t3 = await _ticket(c, pid, "three")
    await c.post(
        f"/tickets/{t3}/ai/assign", json={"member_id": dev["id"], "start": "now"}
    )
    await _wait(c, t3, ("finished",))
    args = [json.loads(x) for x in record.read_text().splitlines()][-1]
    assert "--plugin-dir" not in args


# --------------------------------------------------------------------------- role packs


async def test_eight_ready_made_packs_and_a_project_copy_with_versions(env):
    c = env["c"]
    pid, _ = await _project(c)
    listed = (await c.get(f"/projects/{pid}/ai/packs")).json()
    assert [p["key"] for p in listed] == packs.BUILTIN_KEYS
    assert {p["glyph"] for p in listed} >= {
        "TR",
        "PM",
        "BA",
        "DS",
        "DV",
        "RV",
        "QA",
        "UT",
    }
    reviewer = next(p for p in listed if p["key"] == "reviewer")
    assert any(
        "pytest" in a for a in reviewer["allow"]
    )  # the reviewer may run the tests it is asked to run
    edited = (
        await c.put(
            f"/projects/{pid}/ai/packs/dev",
            json={"name": "Dev (TDD)", "effort": "high"},
        )
    ).json()
    assert (
        edited["version"] == 1
        and edited["builtin"] is False
        and edited["effort"] == "high"
    )
    assert edited["persona"]  # the rest came from the ready-made one
    again = (
        await c.put(
            f"/projects/{pid}/ai/packs/dev",
            json={"name": "Dev (TDD)", "effort": "medium"},
        )
    ).json()
    assert again["version"] == 2
    bad = await c.put(
        f"/projects/{pid}/ai/packs/dev", json={"name": "x", "effort": "huge"}
    )
    assert bad.status_code == 422
    assert (await c.delete(f"/projects/{pid}/ai/packs/dev")).status_code == 204
    assert (await c.get(f"/projects/{pid}/ai/packs/dev")).json()["builtin"] is True


async def test_a_pack_exports_to_one_file_and_imports_saying_what_is_missing(env):
    c = env["c"]
    pid, _ = await _project(c)
    out = (await c.get(f"/projects/{pid}/ai/packs/designer/export")).json()
    assert out["format"] == packs.FORMAT
    pid2 = (
        await c.post(
            "/projects", json={"name": "Other", "prefix": "OTH", "color": "#2E6F40"}
        )
    ).json()["id"]
    got = (await c.post(f"/projects/{pid2}/ai/packs/import", json=out)).json()
    assert got["pack"]["key"] == "designer"
    assert set(got["missing"]) >= {"design", "ui-ux-pro-max"}
    assert (
        await c.post(f"/projects/{pid2}/ai/packs/import", json={"x": 1})
    ).status_code == 422


async def test_a_member_made_from_a_pack_carries_its_role_and_persona(env):
    c = env["c"]
    pid, _ = await _project(c)
    r = await c.post(
        f"/projects/{pid}/ai/packs/user_tester/member",
        json={
            "name": "Tester Tu",
            "working_dir": env["repo"],
            "plays": "keyboard only",
        },
    )
    assert r.status_code == 201, r.text
    m = r.json()
    assert m["model"] == "sonnet"
    assert "keyboard only" in m["persona"]
    from models import AiMember

    async with env["maker"]() as s:
        prof = await s.get(AiMember, m["id"])
    assert plugins.role_of(prof) == "user_tester"


async def test_an_mcp_entry_of_the_catalogue_is_added_to_the_members_of_its_roles(env):
    c = env["c"]
    pid, _ = await _project(c)
    ut = (
        await c.post(
            f"/projects/{pid}/ai/packs/user_tester/member",
            json={"name": "Tester Tu", "working_dir": env["repo"]},
        )
    ).json()
    dev = (
        await c.post(
            f"/projects/{pid}/ai/packs/dev/member",
            json={"name": "Dev An", "working_dir": env["repo"]},
        )
    ).json()
    out = (
        await c.post(f"/projects/{pid}/ai/catalogue/playwright/install", json={})
    ).json()
    assert out["mcp_added_to"] == [ut["id"]]
    from models import AiMember

    async with env["maker"]() as s:
        cfg = json.loads((await s.get(AiMember, ut["id"])).config)
        dev_cfg = json.loads((await s.get(AiMember, dev["id"])).config)
    assert any(srv["name"] == "playwright" for srv in cfg["mcp_servers"])
    assert not any(
        srv.get("name") == "playwright" for srv in dev_cfg.get("mcp_servers") or []
    )


# --------------------------------------------------------------------------- the repository scan


def _sample_repo(root: Path) -> None:
    (root / "ui").mkdir(parents=True)
    (root / "ui" / "package.json").write_text(
        json.dumps(
            {
                "name": "ui",
                "scripts": {
                    "test": "vitest",
                    "lint": "eslint src",
                    "build": "vite build",
                    "dev": "vite",
                },
                "dependencies": {"react": "18"},
                "devDependencies": {"vite": "5", "vitest": "1"},
            }
        )
    )
    (root / "server").mkdir()
    (root / "server" / "pyproject.toml").write_text(
        "[project]\nname='s'\ndependencies=['fastapi']\n[dependency-groups]\ndev=['pytest','ruff']\n"
    )
    (root / "server" / "uv.lock").write_text("")
    (root / ".github" / "workflows").mkdir(parents=True)
    (root / ".github" / "workflows" / "ci.yml").write_text(
        "jobs:\n  t:\n    steps:\n      - run: cd server && uv run pytest -q\n      - run: echo hello\n"
    )
    (root / "CLAUDE.md").write_text("# rules")


def test_the_scan_reads_the_repository_by_code_and_suggests_a_team(tmp_path):
    _sample_repo(tmp_path)
    found = repo_scan.scan(str(tmp_path))
    assert set(found["languages"]) == {"node", "python"}
    assert {"react", "vite", "vitest", "fastapi"} <= set(found["frameworks"])
    assert found["ui"] is True and found["monorepo"] is True
    assert found["ci_commands"] == ["cd server && uv run pytest -q"]
    assert "CLAUDE.md" in found["agent_files"]
    s = repo_scan.suggest(found)
    assert "cd ui && npm test -- --run" in s["commands"]["test"]
    assert "cd server && uv run pytest -q" in s["commands"]["test"]
    assert "cd ui && npm ci" in s["prepare"] and "cd server && uv sync" in s["prepare"]
    assert s["workflow_default"] == "feature_ui"
    assert [m["pack"] for m in s["team"]] == [
        "triage",
        "pm",
        "ba",
        "designer",
        "dev",
        "qa",
        "reviewer",
        "user_tester",
    ]
    assert s["handover"] == "local"
    assert "playwright" in s["plugins"] and "design" in s["plugins"]


def test_the_trial_runs_the_commands_in_a_scratch_worktree_and_shows_failures(tmp_path):
    _skill(tmp_path / "skills", "x")
    _repo(tmp_path)
    ok = repo_scan._try(str(tmp_path), "true", "python3 -c 'print(42)'")
    assert ok["prepare"]["ok"] and ok["test"]["ok"]
    assert ok["test"]["tail"] == ["42"]
    bad = repo_scan._try(str(tmp_path), "exit 3", "echo never")
    assert bad["prepare"]["ok"] is False and bad["prepare"]["exit_code"] == 3
    assert bad["test"] is None  # nothing runs after a failing step
    worktrees = _git(tmp_path, "worktree", "list").stdout.strip().splitlines()
    assert len(worktrees) == 1  # the scratch worktree was removed


async def test_the_scan_creates_nothing_until_apply(env, tmp_path):
    c = env["c"]
    pid, _ = await _project(c)
    _sample_repo(tmp_path / "repo2")
    r = await c.post(
        f"/projects/{pid}/ai/scan",
        json={"folder": str(tmp_path / "repo2"), "trial": False},
    )
    assert r.status_code == 201, r.text
    scan = r.json()
    assert scan["suggested"]["team"]
    members_before = (await c.get(f"/projects/{pid}/members")).json()
    choice = {
        **scan["suggested"],
        "team": [
            {"pack": "dev", "name": "Dev An"},
            {"pack": "reviewer", "name": "Reviewer Rin"},
        ],
        "plugins": [],
    }
    out = (await c.post(f"/ai/scans/{scan['id']}/apply", json=choice)).json()
    assert [m["name"] for m in out["created"]] == ["Dev An", "Reviewer Rin"]
    assert out["settings"]["workflow_default"] == "feature_ui"
    assert out["settings"]["worktrees"]["prepare"] == scan["suggested"]["prepare"]
    members_after = (await c.get(f"/projects/{pid}/members")).json()
    assert len(members_after) == len(members_before) + 2


def test_a_plain_pip_library_gets_no_global_install_and_no_browser_plugins(tmp_path):
    (tmp_path / "pyproject.toml").write_text(
        '[project]\nname = "calc"\nversion = "0.1.0"\n'
    )
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_calc.py").write_text("def test_x():\n    assert True\n")
    s = repo_scan.suggest(repo_scan.scan(str(tmp_path)))
    assert (
        "pip install" not in s["prepare"]
    )  # it would install into the person's own Python
    assert not {"webapp-testing", "chrome-devtools", "playwright"} & set(s["plugins"])
