"""The Board AI chat answers with the member's own configuration: its MCP servers and tool rules, and a token that
lasts one answer and carries the member's permissions."""

import asyncio
import json
from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: F401 - used by the shared `env` fixture

from models import AiChat, AiMember, Member
from services.ai import cli, guard, llm, runs
from services.ai.assist import chat_tools
from services.ai.context import RunContext
from tests.test_ai import _project, _runner, _ticket, env  # noqa: F401


async def _chat_parts(env, **config):
    c = env["c"]
    pid, _ = await _project(c)
    m = await _runner(c, pid, env["repo"])
    if config:
        await c.patch(f"/ai/members/{m['id']}", json={"config": config})
    async with env["maker"]() as s:
        member = await s.get(Member, m["id"])
        profile = await s.get(AiMember, m["id"])
    chat = AiChat(id="chat1", project_id=pid, owner="An Nguyen", scope="project")
    return chat, profile, member, pid


async def test_a_chat_token_acts_as_the_member_until_the_answer_ends(env):
    chat, profile, member, pid = await _chat_parts(env)
    token = guard.issue_chat_token(
        RunContext(
            run_id="chat_chat1",
            member_id=member.id,
            member_name=member.name,
            project_id=pid,
            ticket_id="",
            on_behalf_of="An Nguyen",
            mode="work",
        )
    )
    assert token.startswith(
        "kbr_"
    )  # the MCP layer only reads this kind of bearer token
    ctx = await guard.context_for_token(token)
    assert (ctx.member_id, ctx.project_id, ctx.on_behalf_of) == (
        member.id,
        pid,
        "An Nguyen",
    )
    guard.revoke_chat_token(token)
    with pytest.raises(guard.AiActionError, match="ended"):
        await guard.context_for_token(token)


async def test_a_revoked_member_token_stops_a_chat_token_too(env):
    chat, profile, member, pid = await _chat_parts(env)
    token = guard.issue_chat_token(
        RunContext("chat_x", member.id, member.name, pid, "", "An Nguyen", "work")
    )
    async with env["maker"]() as s:
        row = await s.get(AiMember, profile.id)
        row.token_revoked_at = "2026-01-01T00:00:00+00:00"
        s.add(row)
        await s.commit()
    with pytest.raises(guard.AiActionError, match="revoked"):
        await guard.context_for_token(token)
    guard.revoke_chat_token(token)


async def test_the_chat_gets_the_members_servers_and_rules(env):
    chat, profile, member, pid = await _chat_parts(
        env,
        mcp_servers=[
            {
                "name": "docs",
                "type": "http",
                "url": "http://x.test/mcp",
                "enabled": True,
            },
            {
                "name": "off",
                "type": "http",
                "url": "http://y.test/mcp",
                "enabled": False,
            },
        ],
        allow_rules=["Bash(git status)"],
        deny_rules=["Bash(rm:*)"],
        max_turns=7,
    )
    tools, token = await chat_tools.build(chat, profile, member)
    try:
        servers = tools.mcp["mcpServers"]
        assert set(servers) == {"kanban", "docs"}  # a disabled server stays out
        assert servers["kanban"]["headers"]["Authorization"] == f"Bearer {token}"
        assert "mcp__kanban" in tools.allowed and "mcp__docs" in tools.allowed
        assert "Bash(git status)" in tools.allowed
        assert "Bash(rm:*)" in tools.denied
        assert tools.max_turns is None  # a CLI chat has no turn limit
        assert (await guard.context_for_token(token)).member_id == member.id
    finally:
        guard.revoke_chat_token(token)


async def test_safe_mode_keeps_the_chat_read_only(env):
    chat, profile, member, pid = await _chat_parts(env, allow_rules=["Edit"])
    async with env["maker"]() as s:
        row = await s.get(AiMember, profile.id)
        row.safe_mode = True
        s.add(row)
        await s.commit()
        profile = row
    tools, token = await chat_tools.build(chat, profile, member)
    guard.revoke_chat_token(token)
    assert "Edit" not in tools.allowed
    assert "Edit" in tools.denied


def test_only_claude_code_answers_from_the_board_with_tools():
    local = AiMember(connection="local", provider="claude-code")
    assert chat_tools.applies(AiChat(scope="project"), local)
    assert chat_tools.applies(AiChat(scope="ticket"), local)
    assert not chat_tools.applies(
        AiChat(scope="doc"), local
    )  # a Docs page keeps its rules
    assert not chat_tools.applies(
        AiChat(scope="project"), AiMember(connection="api_key", provider="anthropic")
    )


class _FakeProc:
    seen: list[str] = []

    def __init__(self, args, cwd, env=None):
        _FakeProc.seen = args
        self.stderr_tail = []

    async def start(self):
        return 1

    async def lines(self):
        yield json.dumps(
            {
                "type": "stream_event",
                "event": {
                    "type": "content_block_delta",
                    "delta": {"type": "text_delta", "text": "ok"},
                },
            }
        )
        yield json.dumps({"type": "result", "result": "ok", "usage": {}})

    async def wait(self):
        return 0

    def kill(self):
        pass


async def test_the_cli_runs_with_the_members_tools_or_none_at_all(monkeypatch):
    monkeypatch.setattr(cli, "CliProcess", _FakeProc)
    monkeypatch.setattr(cli, "find_cli", lambda *a, **k: ("/bin/claude", None))
    profile = AiMember(
        connection="local", provider="claude-code", model="haiku", working_dir=""
    )

    plain = await llm.complete(profile, system="s", prompt="hi")
    args = _FakeProc.seen
    assert plain.text == "ok"
    assert args[args.index("--tools") + 1] == ""
    assert json.loads(args[args.index("--mcp-config") + 1]) == {"mcpServers": {}}

    tools = llm.ChatTools(
        mcp={"mcpServers": {"kanban": {"type": "http", "url": "http://b/mcp/"}}},
        allowed=["mcp__kanban"],
        denied=["Bash"],
        max_turns=5,
        effort="low",
    )
    out = await llm.complete(profile, system="s", prompt="hi", tools=tools)
    args = _FakeProc.seen
    assert out.text == "ok"
    assert "--tools" not in args
    assert "kanban" in json.loads(args[args.index("--mcp-config") + 1])["mcpServers"]
    assert args[args.index("--allowedTools") + 1] == "mcp__kanban"
    assert args[args.index("--disallowedTools") + 1] == "Bash"
    assert args[args.index("--max-turns") + 1] == "5"
    assert args[args.index("--effort") + 1] == "low"
    assert "--include-partial-messages" in args  # the answer still streams
    assert args[args.index("--permission-mode") + 1] == "dontAsk"


# --------------------------------------------------------------------------- the board context is sent once

from tests.test_ai_assist import H, _answer, _setup, fake  # noqa: E402, F401


async def _ask(c, chat_id, text, **extra):
    msg = await _answer(c, chat_id, text, **extra)
    assert msg["state"] == "done", msg
    return msg


async def _chat(c, pid):
    return (await c.post(f"/projects/{pid}/ai/assist/chats", json={}, headers=H)).json()


async def test_the_board_context_goes_in_once_then_the_session_holds_it(
    env, fake, monkeypatch
):
    monkeypatch.setattr(
        cli, "session_exists", lambda sid: True
    )  # the CLI keeps the chat
    c, pid, an, m = await _setup(env)
    await _ticket(c, pid, title="Open one", status="in-progress")
    await _ticket(c, pid, title="Finished one", status="done")
    chat = await _chat(c, pid)

    first = await _ask(c, chat["id"], "what is open?")
    assert "Board context:" in fake.prompts[0]
    # the compact form: counts and the open tickets, no activity and no closed tickets
    assert "Tickets: " in fake.prompts[0] and "Open one" in fake.prompts[0]
    assert "Finished one" not in fake.prompts[0]
    assert fake.tools[0] is not None  # the member's tools are on
    assert first["context"]["context_sent"] is True

    second = await _ask(c, chat["id"], "and the closed ones?")
    assert "Board context:" not in fake.prompts[1]
    assert (
        "what is open?" not in fake.prompts[1]
    )  # the session remembers it, nothing is repeated
    assert second["context"]["context_sent"] is False
    assert not second["context"].get("truncated")  # no "Long context" banner


async def test_the_context_comes_again_after_a_compaction_or_a_pick(
    env, fake, monkeypatch
):
    monkeypatch.setattr(cli, "session_exists", lambda sid: True)
    c, pid, an, m = await _setup(env)
    await _ticket(c, pid, title="Open one", status="todo")
    chat = await _chat(c, pid)
    await _ask(c, chat["id"], "first")
    fake.compacted = True
    compacted = await _ask(c, chat["id"], "second")
    assert "Board context:" not in fake.prompts[1] and compacted["context"]["compacted"]
    await _ask(c, chat["id"], "third")  # the session may have dropped it
    assert "Board context:" in fake.prompts[2]
    await _ask(c, chat["id"], "fourth")
    assert "Board context:" not in fake.prompts[3]
    await _ask(
        c, chat["id"], "fifth", filters={"status": "todo"}
    )  # the person narrowed the question
    assert "Board context:" in fake.prompts[4]


async def test_a_chat_without_the_members_tools_gets_the_full_context_every_time(
    env, fake, monkeypatch
):
    monkeypatch.setattr(cli, "session_exists", lambda sid: True)
    monkeypatch.setattr(chat_tools, "applies", lambda chat, profile: False)
    c, pid, an, m = await _setup(env)
    await _ticket(c, pid, title="Finished one", status="done")
    chat = await _chat(c, pid)
    await _ask(c, chat["id"], "one")
    await _ask(c, chat["id"], "two")
    assert all("Board context:" in p and "Finished one" in p for p in fake.prompts)
    assert fake.tools == [None, None]


class _UsageProc(_FakeProc):
    """A run of two requests (a tool call between): `usage` adds them up, the second one is what the session holds."""

    async def lines(self):
        def start(tokens):
            return json.dumps(
                {
                    "type": "stream_event",
                    "event": {
                        "type": "message_start",
                        "message": {
                            "usage": {
                                "input_tokens": 2,
                                "cache_creation_input_tokens": 100,
                                "cache_read_input_tokens": tokens,
                            }
                        },
                    },
                }
            )

        yield start(40_000)
        yield start(52_000)
        yield json.dumps(
            {
                "type": "result",
                "result": "ok",
                "usage": {
                    "input_tokens": 4,
                    "cache_creation_input_tokens": 200,
                    "cache_read_input_tokens": 92_000,
                    "output_tokens": 9,
                },
                "modelUsage": {"claude-x": {"contextWindow": 1_000_000}},
            }
        )


async def test_the_answer_reports_how_full_the_session_is(monkeypatch):
    monkeypatch.setattr(cli, "CliProcess", _UsageProc)
    monkeypatch.setattr(cli, "find_cli", lambda *a, **k: ("/bin/claude", None))
    profile = AiMember(connection="local", provider="claude-code", working_dir="")
    out = await llm.complete(profile, system="s", prompt="hi")
    assert out.context_window == 1_000_000
    assert out.context_used == 52_102  # the last request, not the sum of both (92,204)
    assert out.tokens_in == 92_204


async def test_no_report_when_the_cli_gives_no_window(monkeypatch):
    monkeypatch.setattr(cli, "CliProcess", _FakeProc)
    monkeypatch.setattr(cli, "find_cli", lambda *a, **k: ("/bin/claude", None))
    out = await llm.complete(
        AiMember(connection="local", provider="claude-code", working_dir=""),
        system="s",
        prompt="hi",
    )
    assert out.context_window == 0


async def test_an_answer_carries_how_full_the_session_is(env, fake):
    c, pid, an, m = await _setup(env)
    chat = await _chat(c, pid)
    fake.window = (52_000, 1_000_000)
    msg = await _ask(c, chat["id"], "hi")
    assert msg["context"]["context_window"] == {"used": 52_000, "size": 1_000_000}
    fake.window = None
    msg = await _ask(c, chat["id"], "again")
    assert "context_window" not in msg["context"]


async def test_the_chat_also_gets_the_servers_of_the_working_folders_mcp_json(env):
    chat, profile, member, pid = await _chat_parts(
        env, mcp_servers=[{"name": "docs", "type": "http", "url": "http://x.test/mcp"}]
    )
    (Path(env["repo"]) / ".mcp.json").write_text(
        json.dumps(
            {
                "mcpServers": {
                    "ba-graph": {"command": "uv", "args": ["run", "ba-mcp"]},
                    "kanban": {"type": "http", "url": "http://other/mcp"},
                    "docs": {"type": "http", "url": "http://file.test/mcp"},
                    "off": {"command": "x", "disabled": True},
                }
            }
        ),
        encoding="utf-8",
    )
    tools, token = await chat_tools.build(chat, profile, member)
    guard.revoke_chat_token(token)
    servers = tools.mcp["mcpServers"]
    assert servers["ba-graph"] == {"command": "uv", "args": ["run", "ba-mcp"]}
    assert servers["kanban"]["headers"]["Authorization"].startswith("Bearer kbr_chat_")
    assert servers["docs"]["url"] == "http://x.test/mcp"  # the member's own entry wins
    assert "off" not in servers
    assert "mcp__ba-graph" in tools.allowed


async def test_safe_mode_does_not_open_the_folders_servers(env):
    chat, profile, member, pid = await _chat_parts(env)
    (Path(env["repo"]) / ".mcp.json").write_text(
        json.dumps({"mcpServers": {"ba-graph": {"command": "uv"}}}), encoding="utf-8"
    )
    async with env["maker"]() as s:
        row = await s.get(AiMember, profile.id)
        row.safe_mode = True
        s.add(row)
        await s.commit()
        profile = row
    tools, token = await chat_tools.build(chat, profile, member)
    guard.revoke_chat_token(token)
    assert "mcp__ba-graph" not in tools.allowed


def test_a_broken_mcp_json_is_ignored(tmp_path):
    (tmp_path / ".mcp.json").write_text("{not json", encoding="utf-8")
    assert runs.folder_servers(str(tmp_path)) == {}
    assert runs.folder_servers(None) == {}
    assert runs.folder_servers(str(tmp_path / "missing")) == {}


async def test_bypass_permissions_reaches_the_chat_except_in_safe_mode(env):
    chat, profile, member, pid = await _chat_parts(env)
    # saved through the API only with the owner's typed confirmation; the test sets it on the profile directly
    profile.config = json.dumps(
        {**json.loads(profile.config), "permission_mode": "bypass"}
    )
    tools, token = await chat_tools.build(chat, profile, member)
    guard.revoke_chat_token(token)
    assert tools.bypass
    assert "WebFetch" in tools.denied and "WebSearch" in tools.denied

    async with env["maker"]() as s:
        row = await s.get(AiMember, profile.id)
        row.safe_mode = True
        row.config = profile.config
        s.add(row)
        await s.commit()
        profile = row
    tools, token = await chat_tools.build(chat, profile, member)
    guard.revoke_chat_token(token)
    assert not tools.bypass


async def test_the_cli_gets_bypass_permissions_only_when_asked(monkeypatch):
    monkeypatch.setattr(cli, "CliProcess", _FakeProc)
    monkeypatch.setattr(cli, "find_cli", lambda *a, **k: ("/bin/claude", None))
    profile = AiMember(connection="local", provider="claude-code", working_dir="")
    base = dict(mcp={"mcpServers": {}}, allowed=[], denied=[])
    await llm.complete(profile, system="s", prompt="hi", tools=llm.ChatTools(**base))
    assert _FakeProc.seen[_FakeProc.seen.index("--permission-mode") + 1] == "dontAsk"
    await llm.complete(
        profile, system="s", prompt="hi", tools=llm.ChatTools(**base, bypass=True)
    )
    seen = _FakeProc.seen
    assert seen[seen.index("--permission-mode") + 1] == "bypassPermissions"
    assert "--dangerously-skip-permissions" not in seen


# --------------------------------------------------------------------------- steps and the quiet limit


def test_a_tool_call_is_told_in_a_short_line():
    label = llm.tool_label
    assert (
        label("mcp__kanban__get_ticket", {"ticket_id": "YU-12"})
        == "Using get_ticket · YU-12"
    )
    assert (
        label(
            "mcp__kanban__manage_ticket",
            {"action": "update", "ticket_id": "YU-12", "title": "x"},
        )
        == "Using manage_ticket · update · YU-12"
    )
    assert label("mcp__ba-graph__ba_gaps", {}) == "Using ba_gaps (ba-graph)"
    assert label("Grep", {"pattern": "x" * 90}) == "Using Grep · " + "x" * 40
    assert label("Bash", None) == "Using Bash"
    assert label("Read", {"file_path": "/a/b/" + "d/" * 30 + "LICENSE"}).endswith(
        "d/d/LICENSE"
    )
    assert label("Read", {"file_path": "/a/b/" + "d/" * 30 + "LICENSE"}).startswith(
        "Using Read · …"
    )


class _StepsProc(_FakeProc):
    async def lines(self):
        yield json.dumps(
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {"type": "text", "text": "Let me look."},
                        {
                            "type": "tool_use",
                            "name": "mcp__kanban__get_ticket",
                            "input": {"ticket_id": "YU-9"},
                        },
                    ]
                },
            }
        )
        async for line in super().lines():
            yield line


async def test_the_answer_reports_each_tool_it_calls(monkeypatch):
    monkeypatch.setattr(cli, "CliProcess", _StepsProc)
    monkeypatch.setattr(cli, "find_cli", lambda *a, **k: ("/bin/claude", None))
    heard: list[str] = []

    async def on_step(text):
        heard.append(text)

    profile = AiMember(connection="local", provider="claude-code", working_dir="")
    tools = llm.ChatTools(mcp={"mcpServers": {}}, allowed=[], denied=[])
    await llm.complete(profile, system="s", prompt="hi", tools=tools, on_step=on_step)
    assert heard == ["Using get_ticket · YU-9"]
    heard.clear()  # no tools, no steps: the board's plain answer never reports any
    await llm.complete(profile, system="s", prompt="hi", on_step=on_step)
    assert heard == []


class _QuietProc(_FakeProc):
    """Says nothing for a while, then answers."""

    quiet_s = 2.3

    async def lines(self):
        await asyncio.sleep(self.quiet_s)
        async for line in super().lines():
            yield line


async def test_a_quiet_cli_is_ended_but_a_wait_for_approval_is_not(monkeypatch):
    monkeypatch.setattr(cli, "CliProcess", _QuietProc)
    monkeypatch.setattr(cli, "find_cli", lambda *a, **k: ("/bin/claude", None))
    profile = AiMember(connection="local", provider="claude-code", working_dir="")
    tools = llm.ChatTools(mcp={"mcpServers": {}}, allowed=[], denied=[])
    with pytest.raises(llm.LlmError) as err:
        await llm.complete(
            profile, system="s", prompt="hi", tools=tools, idle_s=1.0, timeout=30
        )
    assert err.value.kind == "timeout" and "No sign of progress" in str(err.value)
    out = await llm.complete(
        profile,
        system="s",
        prompt="hi",
        tools=tools,
        idle_s=1.0,
        paused=lambda: True,
        timeout=30,
    )
    assert out.text == "ok"


async def test_the_chat_answer_shows_its_steps_and_runs_without_a_time_limit(env, fake):
    c, pid, an, m = await _setup(env)
    chat = await _chat(c, pid)
    fake.steps = ["Using get_ticket · YU-1", "Using ba_gaps (ba-graph)"]
    msg = await _ask(c, chat["id"], "look")
    texts = [s["text"] for s in msg["steps"]]
    assert "Using get_ticket · YU-1" in texts and "Using ba_gaps (ba-graph)" in texts
    assert texts.index("Using get_ticket · YU-1") > texts.index("Writing the answer")
    limit = fake.limits[0]
    # a CLI on a person's own computer has no time limit: Stop ends an answer
    assert limit["idle_s"] is None and limit["timeout"] is None
    assert callable(limit["paused"])


def test_the_account_file_adds_user_and_local_servers_and_the_nearest_scope_wins(
    tmp_path, monkeypatch
):
    home = tmp_path / "home"
    work = tmp_path / "work"
    home.mkdir()
    work.mkdir()
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(home))
    (home / ".claude.json").write_text(
        json.dumps(
            {
                "mcpServers": {
                    "mine": {"command": "a"},
                    "kanban": {"command": "unguarded"},
                    "both": {"command": "user"},
                },
                "projects": {
                    str(work): {
                        "mcpServers": {
                            "local-one": {"command": "b"},
                            "both": {"command": "local"},
                        }
                    },
                    str(tmp_path / "other"): {"mcpServers": {"nope": {"command": "c"}}},
                },
            }
        )
    )
    (work / ".mcp.json").write_text(
        json.dumps(
            {"mcpServers": {"proj": {"command": "d"}, "both": {"command": "project"}}}
        )
    )
    got = runs.folder_servers(str(work))
    assert set(got) == {
        "mine",
        "both",
        "local-one",
        "proj",
    }  # never the user's own board server
    assert got["both"]["command"] == "local"


def test_a_plugin_the_folder_enables_adds_its_servers_and_the_others_stay_out(
    tmp_path, monkeypatch
):
    home = tmp_path / "home"
    work = tmp_path / "work"
    on, off, flat = (home / "plugins" / n for n in ("on", "off", "flat"))
    for d in (on, off, flat, work / ".claude"):
        d.mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(home))
    (on / ".mcp.json").write_text(
        json.dumps(
            {
                "mcpServers": {
                    "graph": {
                        "command": "${CLAUDE_PLUGIN_ROOT}/run",
                        "args": ["--db", "${CLAUDE_PLUGIN_ROOT}/db"],
                    }
                }
            }
        )
    )
    (flat / ".mcp.json").write_text(json.dumps({"serena": {"command": "uvx"}}))
    (off / ".mcp.json").write_text(json.dumps({"mcpServers": {"x": {"command": "x"}}}))
    (home / "plugins" / "installed_plugins.json").write_text(
        json.dumps(
            {
                "plugins": {
                    "on@mk": [{"scope": "user", "installPath": str(on)}],
                    "flat@mk": [
                        {
                            "scope": "local",
                            "projectPath": str(tmp_path / "x"),
                            "installPath": "/nope",
                        },
                        {
                            "scope": "local",
                            "projectPath": str(work),
                            "installPath": str(flat),
                        },
                    ],
                    "off@mk": [{"scope": "user", "installPath": str(off)}],
                }
            }
        )
    )
    (work / ".claude" / "settings.json").write_text(
        json.dumps({"enabledPlugins": {"on@mk": True, "off@mk": False}})
    )
    (work / ".claude" / "settings.local.json").write_text(
        json.dumps({"enabledPlugins": {"flat@mk": True}})
    )
    got = runs.folder_servers(str(work))
    assert set(got) == {"plugin_on_graph", "plugin_flat_serena"}
    assert got["plugin_on_graph"]["command"] == f"{on}/run"
    assert got["plugin_on_graph"]["args"] == ["--db", f"{on}/db"]
