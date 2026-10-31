"""Antigravity as a local runner: the command line it gets (tool rules, mode, conversation), the per-run workspace with
the board's MCP endpoint, how its stream becomes run steps, and sharing one conversation per ticket."""

import asyncio
import json
from pathlib import Path

import pytest

from services.ai import cli, runs
from tests.test_ai import (  # noqa: F401
    _project,
    _ticket,
    _wait,
    env,
)
from tests.test_ai_safety import OWNER, _people

FAKE_AGY = str(Path(__file__).parent / "fixtures" / "fake_agy_local.py")
SAMPLE = [
    '{"event":"init","conversation_id":"c1","init":{"model":"gemini-3.8-flash-low","cwd":"/w","tools":["run_command"]}}',
    '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"read_file","tool_info":{"name":"read_file","parameters":{"Path":"/w/a.py"}}}}',
    '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":2,"state":"DONE","step_type":"tool","tool_name":"read_file","tool_info":{"name":"read_file","parameters":{"Path":"/w/a.py"},"output":"1 lines, 16 bytes"}}}',
    '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"yuyama"}}',
    '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"-ai\\n","usage":{"input_tokens":10740,"output_tokens":16,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":10756}}}',
    '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"yuyama-ai\\n","num_turns":1,"usage":{"input_tokens":30820,"output_tokens":93}}}',
]


async def _agy(c, pid, repo, name="Gemini", **extra):
    body = {
        "name": name,
        "provider": "antigravity",
        "working_dir": repo,
        "cli_path": FAKE_AGY,
        **extra,
    }
    r = await c.post(f"/projects/{pid}/ai/members", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _calls(record) -> list[dict]:
    return [json.loads(x) for x in record.read_text().splitlines()]


def _flag(args: list[str], name: str) -> str | None:
    return args[args.index(name) + 1] if name in args else None


@pytest.fixture
def agy_env(env, monkeypatch):  # noqa: F811
    record = env["tmp"] / "agy.jsonl"
    monkeypatch.setenv("FAKE_AGY_RECORD", str(record))
    monkeypatch.setenv("KANBAN_AGY_HOME", str(env["tmp"] / "agyhome"))
    return {**env, "record": record}


async def _ask(c, tid, m, text="what does add() do?"):
    r = await c.post(
        f"/tickets/{tid}/comments",
        json={
            "text": f"@[{m['name']}](member:{m['id']}) {text}",
            "author": "Owen Lead",
            "ai_intent": "ask",
        },
        headers=OWNER,
    )
    assert r.status_code in (200, 201), r.text


# --------------------------------------------------------------------------- unit: stream and rules


def test_the_stream_becomes_steps_results_and_this_runs_own_tokens():
    stream = cli.AgyStream("/w")
    out = [stream.feed(line) for line in SAMPLE]
    assert (
        out[0]["ready"]
        and out[0]["session_id"] == "c1"
        and out[0]["model"] == "gemini-3.8-flash-low"
    )
    assert (
        out[1]["steps"][0]["kind"] == "read"
        and out[1]["steps"][0]["text"] == "Read a.py"
    )
    assert out[2]["results"][0]["tool_id"] == out[1]["steps"][0]["tool_id"]
    assert out[4]["steps"] == [{"kind": "say", "text": "yuyama-ai"}]
    assert out[4]["context_used"] == 10740
    result = out[5]["result"]
    assert result["is_error"] is False and result["text"] == "yuyama-ai\n"
    # the final event counts the whole conversation; the run counts only its own calls
    assert (result["tokens_in"], result["tokens_out"]) == (10740, 16)


def test_a_failed_result_and_denied_actions_are_reported():
    stream = cli.AgyStream("/w")
    out = stream.feed(
        '{"event":"result","result":{"conversation_id":"c1","status":"ERROR","response":"boom","denied_actions":[{"action":"mcp","display_name":"CallMcpTool"}]}}'
    )
    assert out["result"]["is_error"] is True and out["result"]["text"] == "boom"
    assert "Not allowed for this run: CallMcpTool" in out["steps"][0]["text"]


def test_claude_style_rules_become_antigravity_rules():
    assert cli.antigravity_rules(
        [
            "Bash(git status:*)",
            "Bash(npm test)",
            "Read(src/**)",
            "WebFetch(domain:github.com)",
            "Edit",
        ]
    ) == ["command(git status)", "command(npm test)", "read_url(github.com)"]


def test_the_board_endpoint_is_named_board_and_the_persons_kanban_is_denied():
    mcp = runs.mcp_config({}, "kbr_x")
    written = runs.antigravity_mcp(mcp)["mcpServers"]
    assert set(written) == {"board"}
    assert written["board"]["headers"]["Authorization"] == "Bearer kbr_x"
    assert "type" not in written["board"]
    for mode, safe in (("ask", False), ("work", False), ("work", True)):
        _, denied, _ = runs.antigravity_run_rules(mode, {}, [], safe=safe, domains=[])
        assert "mcp(kanban/*)" in denied


def test_a_question_and_safe_mode_cannot_edit_or_run_commands_but_work_can_edit():
    for mode, safe in (("ask", False), ("work", True)):
        allow, deny, edits = runs.antigravity_run_rules(
            mode, {}, ["ba-graph"], safe=safe, domains=[]
        )
        assert not edits and {"write_file(*)", "command(*)"} <= set(deny)
        assert "mcp(ba-graph/*)" in allow
    allow, deny, edits = runs.antigravity_run_rules(
        "work",
        {"allow_rules": ["Bash(git diff:*)"], "deny_rules": ["Bash(rm -rf:*)"]},
        [],
        safe=False,
        domains=["github.com"],
    )
    assert edits and "mcp(board/*)" in allow and "command(git diff)" in allow
    assert "read_url(github.com)" in allow and "command(rm -rf)" in deny
    assert "command(*)" not in deny


# --------------------------------------------------------------------------- the runs


async def test_the_member_health_test_runs_the_cli(agy_env, monkeypatch):
    c = agy_env["c"]
    pid, _ = await _project(c)
    m = await _agy(c, pid, agy_env["repo"])
    ok = (await c.post(f"/ai/members/{m['id']}/test", json={"full": True})).json()
    assert ok["ok"] is True and "pong" in ok["message"] and ok["version"] == "1.4.11"
    monkeypatch.setenv("FAKE_AGY_MODE", "logged_out")
    bad = (await c.post(f"/ai/members/{m['id']}/test", json={"full": True})).json()
    assert bad["ok"] is False


async def test_a_question_runs_in_a_scratch_workspace_with_the_board_endpoint(agy_env):
    c, repo = agy_env["c"], agy_env["repo"]
    pid, _ = await _project(c)
    await _people(c, pid)
    m = await _agy(c, pid, repo)
    tid = await _ticket(c, pid)
    await _ask(c, tid, m)
    run = await _wait(c, tid, ("finished", "failed"))
    assert run["state"] == "finished", run
    (call,) = _calls(agy_env["record"])
    args = call["args"]
    assert args[args.index("-p") + 1].startswith(f"Working folder: {repo}")
    assert _flag(args, "--output-format") == "stream-json" and "--mode" not in args
    assert _flag(args, "--add-dir") == repo and "--conversation" not in args
    perms = json.loads(_flag(args, "--settings"))["permissions"]
    assert (
        "mcp(board/get_ticket)" in perms["allow"]
        and "mcp(board/*)" not in perms["allow"]
    )
    assert {"mcp(kanban/*)", "write_file(*)", "command(*)"} <= set(perms["deny"])
    # a scratch folder holds the endpoint with this run's token; the work folder is untouched and the scratch is gone
    assert call["cwd"] != repo
    for _ in range(
        100
    ):  # the run is marked finished just before its scratch folder is removed
        if not Path(call["cwd"]).exists():
            break
        await asyncio.sleep(0.1)
    assert not Path(call["cwd"]).exists()
    assert not (Path(repo) / ".agents").exists()
    board = call["mcp"]["mcpServers"]["board"]
    assert board["url"].endswith("/mcp/") and board["headers"][
        "Authorization"
    ].startswith("Bearer kbr_")
    assert "kanban" not in call["mcp"]["mcpServers"]
    texts = [s["text"] for s in run["steps"]]
    assert any(t.startswith("Ran pytest -q") for t in texts)
    assert "API_TOKEN=sk-ant" not in " ".join(texts)
    assert any(
        s["kind"] == "error" and "permission check failed" in s["text"]
        for s in run["steps"]
    )
    assert (run["tokens_in"], run["tokens_out"]) == (1200, 25)
    assert run["session_id"]


async def test_a_work_run_may_edit_and_files_are_reported(agy_env):
    c, repo = agy_env["c"], agy_env["repo"]
    pid, _ = await _project(c)
    await _people(c, pid)
    m = await _agy(c, pid, repo, model="gemini-3.8-flash-low")
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/run", json={"member_id": m["id"]})
    first = await _wait(c, tid, ("finished", "failed"))
    assert first["state"] == "finished", first
    work = _calls(agy_env["record"])[-1]["args"]
    assert (
        _flag(work, "--mode") == "accept-edits"
        and _flag(work, "--model") == "gemini-3.8-flash-low"
    )
    assert "--dangerously-skip-permissions" not in work
    assert any(s["kind"] == "create" for s in first["steps"])
    assert first["session_id"]


async def test_a_later_question_resumes_the_conversation_the_ticket_shares(agy_env):
    c, repo = agy_env["c"], agy_env["repo"]
    pid, _ = await _project(c)
    await _people(c, pid)
    m = await _agy(c, pid, repo)
    tid = await _ticket(c, pid)
    await _ask(c, tid, m)
    first = await _wait(c, tid, ("finished", "failed"))
    assert first["state"] == "finished", first
    from services.docs_ai import sessions as shared

    assert await shared.lookup(shared.ticket_scope(tid), m["id"]) == first["session_id"]
    await _ask(c, tid, m, "and now?")
    for _ in range(100):
        if len(_calls(agy_env["record"])) >= 2:
            break
        import asyncio

        await asyncio.sleep(0.1)
    again = _calls(agy_env["record"])[-1]["args"]
    assert _flag(again, "--conversation") == first["session_id"]
    # the first prompt of a conversation carries the instructions; a resumed turn does not repeat them
    assert not again[again.index("-p") + 1].startswith("Working folder")


async def test_a_failed_run_says_why_and_a_denied_action_is_noted(agy_env, monkeypatch):
    c, repo = agy_env["c"], agy_env["repo"]
    pid, _ = await _project(c)
    await _people(c, pid)
    m = await _agy(c, pid, repo)
    monkeypatch.setenv("FAKE_AGY_MODE", "fail")
    t1 = await _ticket(c, pid)
    await c.post(f"/tickets/{t1}/ai/run", json={"member_id": m["id"]})
    run = await _wait(c, t1, ("finished", "failed"))
    assert run["state"] == "failed" and "The model failed" in str(run)
    monkeypatch.setenv("FAKE_AGY_MODE", "denied")
    t2 = await _ticket(c, pid, "Other")
    await c.post(f"/tickets/{t2}/ai/run", json={"member_id": m["id"]})
    run = await _wait(c, t2, ("finished", "failed"))
    assert any(
        "Not allowed for this run: RunCommand" in s["text"] for s in run["steps"]
    )


async def test_safe_mode_gives_a_read_only_antigravity_run(agy_env):
    c, repo = agy_env["c"], agy_env["repo"]
    pid, _ = await _project(c)
    await _people(c, pid)
    m = await _agy(c, pid, repo)
    await c.patch(f"/ai/members/{m['id']}", json={"safe_mode": True}, headers=OWNER)
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/run", json={"member_id": m["id"]})
    await _wait(c, tid, ("finished", "failed"))
    args = _calls(agy_env["record"])[-1]["args"]
    assert "--mode" not in args
    deny = json.loads(_flag(args, "--settings"))["permissions"]["deny"]
    assert {"write_file(*)", "command(*)"} <= set(deny)


async def test_a_missing_cli_is_reported_not_run(agy_env, monkeypatch):
    # nothing named antigravity may be found, so a real one on this computer is never started by a test
    monkeypatch.setenv("PATH", "")
    monkeypatch.setattr(cli, "_SEARCH_DIRS", [])
    c, repo = agy_env["c"], agy_env["repo"]
    pid, _ = await _project(c)
    await _people(c, pid)
    m = await _agy(c, pid, repo, cli_path="/nonexistent/agy")
    r = (await c.post(f"/ai/members/{m['id']}/test", json={"full": True})).json()
    assert r["ok"] is False and r["health"] == "runner_missing"
    assert "agy" in r["message"]


async def test_a_refused_action_does_not_end_the_run_the_cli_is_told_and_goes_on(
    agy_env, monkeypatch
):
    c, repo = agy_env["c"], agy_env["repo"]
    pid, _ = await _project(c)
    await _people(c, pid)
    m = await _agy(c, pid, repo)
    monkeypatch.setenv("FAKE_AGY_MODE", "refuse")
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/run", json={"member_id": m["id"]})
    run = await _wait(c, tid, ("finished", "failed"))
    assert run["state"] == "finished", run
    first, second = _calls(agy_env["record"])
    assert "--conversation" not in first["args"]
    assert _flag(second["args"], "--conversation") == run["session_id"]
    prompt = second["args"][second["args"].index("-p") + 1]
    assert "refused by the board's rules" in prompt and "node -v" in prompt
    texts = [s["text"] for s in run["steps"]]
    assert any("continuing (1 of 3)" in t for t in texts)
    assert "Fixed it" in run["steps"][-1]["text"] or any("Fixed it" in t for t in texts)


async def test_an_antigravity_run_that_keeps_being_refused_fails_with_the_reason(
    agy_env, monkeypatch
):
    c, repo = agy_env["c"], agy_env["repo"]
    pid, _ = await _project(c)
    await _people(c, pid)
    m = await _agy(c, pid, repo)
    monkeypatch.setenv("FAKE_AGY_MODE", "refuse_always")
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/run", json={"member_id": m["id"]})
    run = await _wait(c, tid, ("finished", "failed"), timeout=30)
    assert run["state"] == "failed", run
    assert "stopped after the board refused" in run["ended_reason"]
    assert len(_calls(agy_env["record"])) == 1 + runs.REFUSAL_RETRIES


# --------------------------------------------------------------------------- Bypass permissions


def test_bypass_adds_the_skip_permissions_flag_and_keeps_the_deny_rules():
    common = dict(
        prompt="p",
        model=None,
        allowed=[],
        denied=["command(rm -rf)"],
        edits=True,
        conversation=None,
        add_dirs=[],
    )
    plain = cli.antigravity_args("agy", **common)
    assert "--dangerously-skip-permissions" not in plain
    args = cli.antigravity_args("agy", bypass=True, **common)
    assert "--dangerously-skip-permissions" in args
    assert "command(rm -rf)" in _flag(args, "--settings")
    # the flag can still not be smuggled in through the member's own extra flags
    smuggled = cli.antigravity_args(
        "agy", extra_flags=["--dangerously-skip-permissions"], **common
    )
    assert "--dangerously-skip-permissions" not in smuggled


async def test_a_work_run_bypasses_but_an_ask_run_and_safe_mode_do_not(agy_env):
    c, record = agy_env["c"], agy_env["record"]
    pid, _ = await _project(c)
    await _people(c, pid)
    m = await _agy(c, pid, agy_env["repo"])
    r = await c.patch(
        f"/ai/members/{m['id']}",
        json={
            "config": {"permission_mode": "bypass"},
            "confirm_bypass": "bypass permissions",
        },
        headers=OWNER,
    )
    assert r.status_code == 200, r.text
    tid = await _ticket(c, pid)
    await c.post(f"/tickets/{tid}/ai/run", json={"member_id": m["id"]})
    run = await _wait(c, tid, ("finished", "failed"))
    assert run["state"] == "finished", run
    assert "--dangerously-skip-permissions" in _calls(record)[-1]["args"]
    # an ask run stays read-only whatever the mode
    await _ask(c, tid, m)
    for _ in range(100):
        if len(_calls(record)) >= 2:
            break
        await asyncio.sleep(0.1)
    assert "--dangerously-skip-permissions" not in _calls(record)[-1]["args"]
