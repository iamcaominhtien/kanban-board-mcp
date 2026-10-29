"""Bypass permissions: an owner's explicit, typed and audited choice for a Claude Code member. It lets work runs use
any CLI tool except what a Deny rule stops; ask runs, safe mode and the board's own checks are untouched."""

import json

from sqlmodel import select

from models import AiAudit
from tests.test_ai import (  # noqa: F401
    _api_member,
    _project,
    _runner,
    _ticket,
    _wait,
    env,
)
from tests.test_ai_safety import OWNER, _people

PHRASE = "bypass permissions"


def _calls(record) -> list[list[str]]:
    return [json.loads(x) for x in record.read_text().splitlines()]


def _flag(args: list[str], name: str) -> str | None:
    return args[args.index(name) + 1] if name in args else None


async def _setup(c, env):
    pid, _ = await _project(c)
    await _people(c, pid)  # Owen Lead is the owner
    m = await _runner(c, pid, env["repo"])
    return pid, m


async def _mode(c, member_id, mode, headers=OWNER, **extra):
    return await c.patch(
        f"/ai/members/{member_id}",
        json={"config": {"permission_mode": mode}, **extra},
        headers=headers,
    )


async def test_only_the_owner_can_turn_it_on_and_must_type_the_phrase(env):
    c = env["c"]
    pid, m = await _setup(c, env)
    default = (await c.get(f"/ai/members/{m['id']}")).json()
    assert default["config"]["permission_mode"] == "allowlist"
    r = await _mode(c, m["id"], "bypass", confirm_bypass="yes")
    assert r.status_code == 422 and PHRASE in r.text
    r = await _mode(c, m["id"], "bypass")
    assert r.status_code == 422
    r = await _mode(
        c, m["id"], "bypass", headers={"X-Actor": "Ada Admin"}, confirm_bypass=PHRASE
    )
    assert r.status_code == 403 and "owner" in r.text
    r = await _mode(c, m["id"], "bypass", confirm_bypass=PHRASE)
    assert r.status_code == 200, r.text
    assert r.json()["config"]["permission_mode"] == "bypass"
    async with env["maker"]() as s:
        rows = (
            await s.exec(
                select(AiAudit).where(AiAudit.action == "bypass_permissions_on")
            )
        ).all()
    assert len(rows) == 1 and rows[0].on_behalf_of == "Owen Lead"
    # turning it off needs no phrase and is audited too
    r = await _mode(c, m["id"], "allowlist", headers={"X-Actor": "Ada Admin"})
    assert r.status_code == 200 and r.json()["config"]["permission_mode"] == "allowlist"
    async with env["maker"]() as s:
        off = (
            await s.exec(
                select(AiAudit).where(AiAudit.action == "bypass_permissions_off")
            )
        ).all()
    assert len(off) == 1


async def test_it_is_only_for_claude_code_and_a_new_member_never_starts_with_it(env):
    c = env["c"]
    pid, _ = await _project(c)
    await _people(c, pid)
    made = await c.post(
        f"/projects/{pid}/ai/members",
        json={
            "name": "Sneaky",
            "provider": "claude-code",
            "working_dir": env["repo"],
            "cli_path": "x",
            "model": "haiku",
            "config": {"permission_mode": "bypass"},
        },
    )
    assert made.status_code in (200, 201), made.text
    assert made.json()["config"]["permission_mode"] == "allowlist"
    api = await _api_member(c, pid)
    bad = await _mode(c, api["id"], "bypass", confirm_bypass=PHRASE)
    assert bad.status_code == 422 and "Claude Code" in bad.text


async def test_work_runs_bypass_but_ask_runs_and_safe_mode_do_not(env, monkeypatch):
    c = env["c"]
    record = env["tmp"] / "args.jsonl"
    monkeypatch.setenv("FAKE_CLAUDE_RECORD", str(record))
    pid, m = await _setup(c, env)
    r = await _mode(c, m["id"], "bypass", confirm_bypass=PHRASE)
    assert r.status_code == 200, r.text
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/run", json={"member_id": m["id"]})
    run = await _wait(c, tid, ("finished", "failed"))
    assert run["state"] == "finished", run
    work = _calls(record)[-1]
    assert _flag(work, "--permission-mode") == "bypassPermissions"
    denied = _flag(work, "--disallowedTools") or ""
    # the Deny rules still stop things, and the web (its domain list needs the allow list) stays off
    assert "Bash(rm -rf:*)" in denied and "WebFetch" in denied and "WebSearch" in denied
    assert any("Bypass permissions" in s["text"] for s in run["steps"])
    # an ask run is read-only whatever the mode
    r = await c.post(
        f"/tickets/{tid}/comments",
        json={
            "text": f"@[{m['name']}](member:{m['id']}) what does add() do?",
            "author": "Owen Lead",
            "ai_intent": "ask",
        },
        headers=OWNER,
    )
    assert r.status_code in (200, 201), r.text
    for _ in range(100):
        if len(_calls(record)) >= 2:
            break
        import asyncio

        await asyncio.sleep(0.1)
    asked = _calls(record)[-1]
    assert _flag(asked, "--permission-mode") == "dontAsk"
    # safe mode wins over the bypass
    await c.patch(f"/ai/members/{m['id']}", json={"safe_mode": True}, headers=OWNER)
    t2 = await _ticket(c, pid, "Another")
    await c.post(f"/tickets/{t2}/ai/run", json={"member_id": m["id"]})
    await _wait(c, t2, ("finished", "failed"))
    assert _flag(_calls(record)[-1], "--permission-mode") == "dontAsk"
