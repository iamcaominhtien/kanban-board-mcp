"""AI provider configuration, part 1: what a Claude Code member writes into its working folder (CLAUDE.md, skills,
.mcp.json, settings.json), conflicts with hand edits, backups, hooks confirmation, documented ticks, import / export
and reset (design/screens/ai-provider-config.md, B, C, F)."""

import errno
import json
import os
from pathlib import Path

from services.ai import config_sync as cs
from services.ai import providers
from tests.test_ai import _project, _runner, _ticket, _wait, env  # noqa: F401

SKILL = "---\nname: triage\ndescription: Label and prioritise a new ticket.\n---\n1. Read it.\n2. Label it.\n"


def _cfg(**extra):
    return {
        "instructions": "# Backend rules\n- Work inside /server.\n- Post a summary comment.\n",
        "skills": [{"content": SKILL, "enabled": True}],
        "mcp_servers": [
            {
                "name": "github",
                "type": "stdio",
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-github"],
                "env": [{"name": "GITHUB_TOKEN", "value": "${GITHUB_TOKEN}"}],
            }
        ],
        "allow_rules": ["Read", "Bash(git diff:*)"],
        "deny_rules": ["Bash(rm -rf:*)"],
        **extra,
    }


async def _write(c, mid, **body):
    r = await c.post(f"/ai/members/{mid}/config/write", json=body)
    assert r.status_code == 200, r.text
    return r.json()


async def _preview(c, mid):
    return (await c.post(f"/ai/members/{mid}/config/preview", json={})).json()


async def _save(c, mid, **patch):
    r = await c.patch(f"/ai/members/{mid}", json={"config": patch})
    assert r.status_code == 200, r.text
    return r.json()


def test_capability_matrix_follows_the_design():
    caps = providers.capabilities("claude-code")
    assert (
        len([m for m in caps.values() if m != "not_supported"]) == 8
        and caps["tools"] == "not_supported"
    )
    # The CLIs the board runs itself: everything goes in the prompt or on the command line, nothing is "documented"
    ag = providers.capabilities("antigravity")
    assert (
        len([m for m in ag.values() if m != "not_supported"]) == 4
        and ag["instructions"] == "synced"
        and ag["permissions"] == "synced"
        and ag["skills"] == "not_supported"
    )
    assert "documented" not in ag.values()
    assert providers.capabilities("codex")["permissions"] == "not_supported"
    assert providers.capabilities("opencode")["permissions"] == "synced"
    assert providers.capabilities("codex")["model"] == "synced"
    api = providers.capabilities("anthropic")
    assert (
        api["tools"] == "synced"
        and api["hooks"] == "not_supported"
        and api["skills"] == "not_supported"
    )
    assert not [
        m for m in providers.capabilities("mcp-client").values() if m != "not_supported"
    ]
    matrix = providers.capability_matrix()
    assert [a["key"] for a in matrix["adapters"]] == [
        "claude-code",
        "antigravity",
        "codex",
        "opencode",
        "api",
        "mcp-client",
    ]
    assert len(matrix["groups"]) == 9


async def test_providers_endpoint_carries_the_matrix_and_member_the_nine_groups(env):
    c = env["c"]
    assert "capability_matrix" in (await c.get("/ai/providers")).json()
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    assert len(m["capabilities"]) == 9
    st = (await c.get(f"/ai/members/{m['id']}/config/status")).json()
    assert st["declares"] == 8 and st["groups_total"] == 9 and st["version"] == 1


async def test_sync_writes_the_four_files_and_is_idempotent(env):
    c, repo = env["c"], Path(env["repo"])
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"], config=_cfg())
    pre = await _preview(c, m["id"])
    paths = {f["path"]: f for f in pre["files"]}
    assert set(paths) == {
        "CLAUDE.md",
        ".claude/skills/triage/SKILL.md",
        ".mcp.json",
        ".claude/settings.json",
    }
    assert all(f["action"] == "new" and f["added"] > 0 for f in paths.values())
    assert pre["runner"]["online"] and not pre["conflicts"]
    assert not (repo / "CLAUDE.md").exists()  # a preview writes nothing
    out = await _write(c, m["id"])
    assert out["ok"] and len(out["written"]) == 4
    md = (repo / "CLAUDE.md").read_text()
    assert (
        md.startswith("<!-- kanban:begin")
        and "Work inside /server" in md
        and md.rstrip().endswith("<!-- kanban:end -->")
    )
    assert (repo / ".claude/skills/triage/SKILL.md").read_text() == SKILL
    mcp = json.loads((repo / ".mcp.json").read_text())
    assert mcp["mcpServers"]["github"]["command"] == "npx"
    assert mcp["mcpServers"]["github"]["env"] == {"GITHUB_TOKEN": "${GITHUB_TOKEN}"}
    assert mcp["mcpServers"]["kanban"]["type"] == "http"
    settings = json.loads((repo / ".claude/settings.json").read_text())
    assert settings["permissions"] == {
        "allow": ["Read", "Bash(git diff:*)"],
        "deny": ["Bash(rm -rf:*)"],
    }
    again = await _preview(c, m["id"])
    assert again["files"] == [] and again["synced_files"] == 4 and again["synced_at"]
    assert (await _write(c, m["id"]))["written"] == []
    st = (await c.get(f"/ai/members/{m['id']}/config/status")).json()
    assert st["synced_files"] == 4 and st["synced_at"]


async def test_text_outside_the_markers_and_other_json_keys_are_never_touched(env):
    c, repo = env["c"], Path(env["repo"])
    (repo / "CLAUDE.md").write_text("# My own notes\n\nKeep this.\n")
    (repo / ".mcp.json").write_text(
        json.dumps({"mcpServers": {"mine": {"command": "x"}}, "other": 1})
    )
    (repo / ".claude").mkdir()
    (repo / ".claude/settings.json").write_text(
        json.dumps({"env": {"A": "1"}, "permissions": {"allow": ["WebFetch"]}})
    )
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"], config=_cfg())
    pre = await _preview(c, m["id"])
    assert {f["path"]: f["action"] for f in pre["files"]}["CLAUDE.md"] == "modified"
    assert (await _write(c, m["id"]))["ok"]
    md = (repo / "CLAUDE.md").read_text()
    assert md.startswith("# My own notes\n\nKeep this.\n") and "kanban:begin" in md
    mcp = json.loads((repo / ".mcp.json").read_text())
    assert (
        mcp["other"] == 1
        and "mine" in mcp["mcpServers"]
        and "github" in mcp["mcpServers"]
    )
    st = json.loads((repo / ".claude/settings.json").read_text())
    assert st["env"] == {"A": "1"} and st["permissions"]["allow"] == [
        "WebFetch",
        "Read",
        "Bash(git diff:*)",
    ]
    # the pre-existing files were copied to the backup folder before the first change
    assert cs.list_backups(repo.resolve(), "CLAUDE.md")


async def test_removing_a_skill_and_a_rule_removes_only_what_the_board_wrote(env):
    c, repo = env["c"], Path(env["repo"])
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"], config=_cfg())
    await _write(c, m["id"])
    (repo / ".claude/skills/own").mkdir(parents=True)
    (repo / ".claude/skills/own/SKILL.md").write_text("mine")
    await _save(c, m["id"], skills=[], allow_rules=["Read"], mcp_servers=[])
    out = await _write(c, m["id"])
    assert out["ok"]
    assert (
        not (repo / ".claude/skills/triage").exists()
        and (repo / ".claude/skills/own/SKILL.md").exists()
    )
    assert json.loads((repo / ".claude/settings.json").read_text())["permissions"][
        "allow"
    ] == ["Read"]
    assert "github" not in json.loads((repo / ".mcp.json").read_text())["mcpServers"]


async def test_hand_edit_conflict_blocks_until_keep_or_overwrite_and_backs_up(env):
    c, repo = env["c"], Path(env["repo"])
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"], config=_cfg())
    await _write(c, m["id"])
    # the person edits a line inside the block by hand; the board also changes its text
    md = repo / "CLAUDE.md"
    md.write_text(
        md.read_text().replace("- Post a summary comment.", "- Ping @An in a comment.")
    )
    await _save(
        c,
        m["id"],
        instructions="# Backend rules\n- Work inside /server.\n- Post a summary comment.\n- Never touch migrations.\n",
    )
    pre = await _preview(c, m["id"])
    assert len(pre["conflicts"]) == 1
    conflict = pre["conflicts"][0]
    assert (
        conflict["path"] == "CLAUDE.md"
        and conflict["kind"] == "edited"
        and conflict["edited_at"]
    )
    assert any(r["t"] == "+" and "Ping @An" in r["text"] for r in conflict["diff"])
    blocked = await _write(c, m["id"])
    assert (
        not blocked["ok"] and blocked["conflicts"] and "Ping @An" in md.read_text()
    )  # nothing overwritten
    kept = await _write(
        c, m["id"], resolutions=[{"path": "CLAUDE.md", "choice": "keep"}]
    )
    assert kept["ok"]
    text = md.read_text()
    assert (
        "Ping @An" in text and "Never touch migrations" in text
    )  # my lines stay, the board's new line comes in
    # kept lines stay across later syncs without being flagged again
    assert not (await _preview(c, m["id"]))["conflicts"]
    await _save(
        c,
        m["id"],
        instructions="# Backend rules\n- Work inside /server.\n- Post a summary comment.\n- Never touch migrations.\n- Run lint.\n",
    )
    assert (await _write(c, m["id"]))["ok"]
    text = md.read_text()
    assert "Ping @An" in text and "Run lint" in text
    # overwrite replaces the block with the board version and keeps a backup of the hand-edited file
    md.write_text(md.read_text().replace("- Run lint.", "- Run lint (edited)."))
    await _save(c, m["id"], instructions="# Backend rules\n- Run lint.\n- Brand new.\n")
    res = await _write(
        c, m["id"], resolutions=[{"path": "CLAUDE.md", "choice": "overwrite"}]
    )
    assert res["ok"]
    text = md.read_text()
    assert "Brand new" in text and "Ping @An" not in text and "(edited)" not in text
    backups = cs.list_backups(repo.resolve(), "CLAUDE.md")
    assert backups and any(
        "(edited)" in (cs.read_backup(repo.resolve(), "CLAUDE.md", b["id"]) or "")
        for b in backups
    )
    # restore puts the old version back and backs the current one up
    old = next(
        b
        for b in backups
        if "(edited)" in (cs.read_backup(repo.resolve(), "CLAUDE.md", b["id"]) or "")
    )
    r = await c.post(
        f"/ai/members/{m['id']}/config/restore",
        json={"path": "CLAUDE.md", "backup_id": old["id"]},
    )
    assert r.status_code == 200 and "(edited)" in md.read_text()


async def test_json_files_conflict_per_entry_and_keep_the_persons_version(env):
    c, repo = env["c"], Path(env["repo"])
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"], config=_cfg())
    await _write(c, m["id"])
    path = repo / ".mcp.json"
    data = json.loads(path.read_text())
    data["mcpServers"]["github"]["args"] = ["-y", "my-fork"]
    path.write_text(json.dumps(data))
    # the board did not change the server: the person's edit is simply kept, no conflict
    assert not (await _preview(c, m["id"]))["conflicts"]
    await _write(c, m["id"])
    assert json.loads(path.read_text())["mcpServers"]["github"]["args"] == [
        "-y",
        "my-fork",
    ]
    # now the board changes it as well: that is a conflict
    servers = _cfg()["mcp_servers"]
    servers[0]["args"] = ["-y", "@modelcontextprotocol/server-github", "--v2"]
    await _save(c, m["id"], mcp_servers=servers)
    pre = await _preview(c, m["id"])
    assert pre["conflicts"] and pre["conflicts"][0]["path"] == ".mcp.json"
    await _write(c, m["id"], resolutions=[{"path": ".mcp.json", "choice": "overwrite"}])
    assert json.loads(path.read_text())["mcpServers"]["github"]["args"][-1] == "--v2"
    # an invalid JSON file is reported and never overwritten
    path.write_text("{ nope")
    pre = await _preview(c, m["id"])
    assert any(
        f["action"] == "error" and ".mcp.json" in f["error"] for f in pre["files"]
    )
    assert not (await _write(c, m["id"]))["ok"] and path.read_text() == "{ nope"


async def test_a_failed_write_changes_nothing_and_names_the_file(env, monkeypatch):
    c, repo = env["c"], Path(env["repo"])
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"], config=_cfg())
    real = cs.write_atomic
    calls = {"n": 0}

    def flaky(target, text):
        calls["n"] += 1
        if calls["n"] == 3:
            raise OSError(errno.EACCES, "Permission denied")
        real(target, text)

    monkeypatch.setattr(cs, "write_atomic", flaky)
    out = await _write(c, m["id"])
    assert (
        not out["ok"] and "EACCES" in out["error"]["message"] and out["error"]["path"]
    )
    assert (
        not (repo / "CLAUDE.md").exists() and not (repo / ".mcp.json").exists()
    )  # rolled back
    assert not (repo / ".claude/skills/triage/SKILL.md").exists()
    monkeypatch.setattr(cs, "write_atomic", real)
    assert (await _write(c, m["id"]))["ok"]


async def test_offline_runner_leaves_files_pending_and_nothing_is_written(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"], config=_cfg())
    gone = Path(env["tmp"]) / "gone"
    await c.patch(f"/ai/members/{m['id']}", json={"working_dir": env["repo"]})
    from models import AiMember

    async with env["maker"]() as s:
        row = await s.get(AiMember, m["id"])
        row.working_dir = str(gone)
        s.add(row)
        await s.commit()
    pre = await _preview(c, m["id"])
    assert (
        not pre["runner"]["online"]
        and "not found" in pre["runner"]["reason"]
        and pre["pending"] == 4
    )
    out = await _write(c, m["id"])
    assert not out["ok"] and out.get("offline")
    assert not gone.exists()


async def test_files_never_leave_the_working_folder(env):
    c = env["c"]
    pid, _ = await _project(c)
    for bad in ("../evil", "a/b", "A B"):
        r = await c.post(
            f"/projects/{pid}/ai/members",
            json={
                "name": "X" + bad,
                "provider": "claude-code",
                "working_dir": env["repo"],
                "config": {
                    "skills": [{"content": f"---\nname: {bad}\ndescription: d\n---\nx"}]
                },
            },
        )
        assert r.status_code == 422 and "lowercase" in r.json()["detail"], r.text
    r = await c.post(
        f"/projects/{pid}/ai/members",
        json={
            "name": "Y",
            "provider": "claude-code",
            "working_dir": env["repo"],
            "config": {
                "skills": [
                    {
                        "content": SKILL,
                        "files": [{"path": "../../x", "content": "boom"}],
                    }
                ]
            },
        },
    )
    assert r.status_code == 422 and "not a valid file path" in r.json()["detail"]
    # a symlink that leads outside the folder is refused when writing
    repo = Path(env["repo"])
    outside = Path(env["tmp"]) / "outside"
    outside.mkdir()
    (repo / ".claude").symlink_to(outside)
    m = await _runner(c, pid, env["repo"], config=_cfg())
    out = await _write(c, m["id"])
    assert not out["ok"] and "outside the working folder" in out["error"]["message"]
    assert not any(outside.iterdir())


async def test_hooks_need_the_typed_confirmation(env):
    c, repo = env["c"], Path(env["repo"])
    pid, _ = await _project(c)
    hooks = [
        {
            "event": "PostToolUse",
            "matcher": "Edit|Write",
            "command": "npm run lint --silent",
        },
        {"event": "Stop", "matcher": "", "command": "./scripts/notify.sh"},
    ]
    m = await _runner(c, pid, env["repo"], config=_cfg(hooks=hooks))
    pre = await _preview(c, m["id"])
    assert pre["hooks_pending"]
    await _write(c, m["id"])
    assert "hooks" not in json.loads((repo / ".claude/settings.json").read_text())
    bad = await _write(c, m["id"], confirm_hooks="yes")
    assert not bad["ok"] and "allow hooks" in bad["error"]["message"]
    ok = await _write(c, m["id"], confirm_hooks="allow hooks")
    assert ok["ok"]
    st = json.loads((repo / ".claude/settings.json").read_text())
    assert st["hooks"]["PostToolUse"] == [
        {
            "matcher": "Edit|Write",
            "hooks": [{"type": "command", "command": "npm run lint --silent"}],
        }
    ]
    assert st["hooks"]["Stop"][0]["hooks"][0]["command"] == "./scripts/notify.sh"
    assert (await c.get(f"/ai/members/{m['id']}/config/status")).json()[
        "hooks_confirmed"
    ]
    # a new hook command asks again
    await _save(
        c,
        m["id"],
        hooks=hooks
        + [{"event": "PreToolUse", "matcher": "Bash", "command": "./scripts/guard.sh"}],
    )
    assert (await _preview(c, m["id"]))["hooks_pending"]
    assert "PreToolUse" not in json.loads(
        (repo / ".claude/settings.json").read_text()
    ).get("hooks", {})


async def test_run_writes_the_files_first_and_stops_on_a_conflict(env, monkeypatch):
    c, repo = env["c"], Path(env["repo"])
    rec = Path(env["tmp"]) / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(rec))
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"], config=_cfg())
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/run", json={"member_id": m["id"]})
    run = await _wait(c, tid, ("finished", "failed"))
    assert run["state"] == "finished", run
    assert "Work inside /server" in (repo / "CLAUDE.md").read_text()
    args = json.loads(rec.read_text().splitlines()[-1])
    # instructions travel in CLAUDE.md now, not on the command line
    assert "Work inside /server" not in args[args.index("--append-system-prompt") + 1]
    # hand edit + board change = conflict: the run does not start, nothing is overwritten
    md = repo / "CLAUDE.md"
    md.write_text(md.read_text().replace("Post a summary comment", "Ping me"))
    await _save(c, m["id"], instructions="# Changed\n- Post a summary comment.\n")
    tid2 = await _ticket(c, pid, "Second")
    await c.post(f"/tickets/{tid2}/ai/run", json={"member_id": m["id"]})
    run = await _wait(c, tid2, ("finished", "failed"))
    assert run["state"] == "failed" and "changed outside Kanban" in run["ended_reason"]
    assert "Ping me" in md.read_text()
    assert len(rec.read_text().splitlines()) == 1  # the CLI was not started again


async def test_documented_items_tick_who_when_and_clear_on_change(env):
    # Claude Code is the adapter that still has Documented items (the user-level CLAUDE.md)
    c = env["c"]
    pid, _ = await _project(c)
    mid = (await _runner(c, pid, env["repo"], name="Claude Code · UI"))["id"]
    await _save(c, mid, user_instructions="# Mine\n- No new colors.\n")
    st = (await c.get(f"/ai/members/{mid}/config/status")).json()
    assert "user_instructions" in {d["key"] for d in st["documented"]}
    assert st["documented_done"] == 0
    await c.post(
        f"/ai/members/{mid}/config/tick",
        json={"item": "user_instructions", "done": True},
        headers={"X-Actor": "An Nguyen"},
    )
    st = (await c.get(f"/ai/members/{mid}/config/status")).json()
    rules = next(d for d in st["documented"] if d["key"] == "user_instructions")
    assert (
        rules["done"]
        and rules["by"] == "An Nguyen"
        and rules["at"]
        and st["documented_done"] == 1
    )
    await _save(c, mid, user_instructions="# Mine\n- Changed.\n")
    st = (await c.get(f"/ai/members/{mid}/config/status")).json()
    rules = next(d for d in st["documented"] if d["key"] == "user_instructions")
    assert not rules["done"] and rules["stale"]
    bad = await c.post(f"/ai/members/{mid}/config/tick", json={"item": "nope"})
    assert bad.status_code == 422


async def test_antigravity_mcp_file_sync_is_off_by_default_and_the_target_stays_in_the_folder(
    env,
):
    c, repo = env["c"], Path(env["repo"])
    pid, _ = await _project(c)
    srv = [{"name": "figma", "type": "http", "url": "https://mcp.figma.example/mcp"}]
    r = await c.post(
        f"/projects/{pid}/ai/members",
        json={
            "name": "AG",
            "provider": "antigravity",
            "working_dir": env["repo"],
            "config": {"mcp_servers": srv},
        },
    )
    mid = r.json()["id"]
    assert (await _preview(c, mid))["files"] == []
    await _save(
        c, mid, antigravity={"sync_mcp": True, "mcp_target": ".agents/mcp_config.json"}
    )
    assert (await _write(c, mid))["ok"]
    assert json.loads((repo / ".agents/mcp_config.json").read_text())["mcpServers"][
        "figma"
    ]["url"].startswith("https://")
    bad = await c.patch(
        f"/ai/members/{mid}",
        json={"config": {"antigravity": {"sync_mcp": True, "mcp_target": "../x"}}},
    )
    assert bad.status_code == 422


async def test_export_has_no_secrets_import_previews_and_reset_can_be_undone(env):
    c = env["c"]
    pid, _ = await _project(c)
    tool = json.dumps(
        {
            "name": "lookup",
            "description": "d",
            "input_schema": {"type": "object", "properties": {}},
            "http": {"method": "GET", "url": "https://x.example/api"},
        }
    )
    m = await _runner(
        c,
        pid,
        env["repo"],
        config=_cfg(
            custom_tools=[
                {
                    "spec": tool,
                    "headers": [
                        {
                            "name": "Authorization",
                            "value": "Bearer SECRET\x56ALUE9d41",
                            "secret": True,
                        }
                    ],
                }
            ]
        ),
    )
    shown = json.dumps(m["config"], ensure_ascii=False)
    assert "SECRET\x56ALUE" not in shown and "••••9d41" in shown
    exp = (await c.post(f"/ai/members/{m['id']}/config/export", json={})).json()
    assert (
        exp["filename"].endswith(".config.json")
        and "SECRET\x56ALUE" not in exp["text"]
        and "9d41" not in exp["text"]
    )
    payload = json.loads(exp["text"])
    assert payload["adapter"] == "claude-code" and payload["secrets"] == "excluded"
    # the GITHUB_TOKEN reference survives, a literal would be blanked
    assert "${GITHUB_TOKEN}" in exp["text"]
    other = await _runner(c, pid, env["repo"], name="Second")
    pre = (
        await c.post(
            f"/ai/members/{other['id']}/config/import-preview",
            json={"text": exp["text"]},
        )
    ).json()
    assert (
        pre["adapter_matches"]
        and pre["added"]["skills"] == 1
        and pre["added"]["mcp_servers"] == 1
    )
    assert (
        pre["config"]["skills"][0]["name"] == "triage"
        and "Re-enter secrets" in pre["summary"]
    )
    assert (
        await c.post(
            f"/ai/members/{other['id']}/config/import-preview", json={"text": "nope"}
        )
    ).status_code == 422
    # reset keeps a snapshot for 30 days
    r = await c.post(f"/ai/members/{m['id']}/config/reset")
    assert r.status_code == 200
    now = (await c.get(f"/ai/members/{m['id']}")).json()["config"]
    assert (
        now["skills"] == [] and now["instructions"] == "" and now["mcp_servers"] == []
    )
    st = (await c.get(f"/ai/members/{m['id']}/config/status")).json()
    assert st["undo"] and st["undo"]["days_left"] >= 29
    await c.post(f"/ai/members/{m['id']}/config/undo-reset")
    back = (await c.get(f"/ai/members/{m['id']}")).json()["config"]
    assert (
        back["skills"][0]["name"] == "triage"
        and "Backend rules" in back["instructions"]
    )
    assert (await c.get(f"/ai/members/{m['id']}/config/status")).json()["undo"] is None
    assert (await c.post(f"/ai/members/{m['id']}/config/undo-reset")).status_code == 422


async def test_config_version_counts_real_changes_and_validation_reports_inline(env):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    v = lambda: c.get(f"/ai/members/{m['id']}/config/status")  # noqa: E731
    assert (await v()).json()["version"] == 1
    await _save(c, m["id"], max_turns=41)
    assert (await v()).json()["version"] == 2
    await _save(c, m["id"], max_turns=41)
    assert (await v()).json()["version"] == 2  # nothing changed
    for patch, text in (
        ({"max_steps": 120}, "Max steps"),
        ({"allow_rules": ["Bash(npm run build"]}, "parentheses"),
        ({"extra_flags": ["--dangerously-skip-permissions"]}, "skip permission"),
        ({"effort": "extreme"}, "Effort"),
        ({"hooks": [{"event": "Nope", "command": "x"}]}, "Event must be"),
        (
            {"mcp_servers": [{"name": "kanban", "type": "http", "url": "https://x"}]},
            "board's own",
        ),
        ({"mcp_servers": [{"name": "a", "type": "stdio", "command": ""}]}, "command"),
    ):
        r = await c.patch(f"/ai/members/{m['id']}", json={"config": patch})
        assert r.status_code == 422 and text in r.json()["detail"], (patch, r.text)
    res = (
        await c.post(
            f"/ai/members/{m['id']}/config/validate",
            json={
                "config": {
                    "allow_rules": ["Read", "Read", "()"],
                    "deny_rules": ["Read"],
                }
            },
        )
    ).json()
    msgs = [i["message"] for i in res["issues"]]
    assert any("listed twice" in x for x in msgs) and any(
        "empty parentheses" in x or "tool name" in x for x in msgs
    )
    assert any("allowed and denied" in x for x in msgs)
    # creating a member validates its configuration too
    r = await c.post(
        f"/projects/{pid}/ai/members",
        json={"name": "Z", "provider": "claude-code", "config": {"max_turns": 999}},
    )
    assert r.status_code == 422 and "Max turns" in r.json()["detail"]


async def test_merge3_keeps_my_lines_on_overlap_and_takes_non_overlapping_board_changes():
    base = "a\nb\nc\nd"
    assert cs.merge3(base, "a\nB-mine\nc\nd", "a\nb\nc\nd\ne") == (
        "a\nB-mine\nc\nd\ne",
        False,
    )
    assert cs.merge3(base, "a\nB-mine\nc\nd", "a\nB-board\nc\nd") == (
        "a\nB-mine\nc\nd",
        True,
    )
    assert cs.merge3(base, base, "x\nb\nc\nd") == ("x\nb\nc\nd", False)
    assert os.path.sep  # keep the os import used on every platform
