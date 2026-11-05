"""AI v2: what a run's Claude Code CLI is started with (services/ai/launch.py) and how its stream-json output becomes
step rows (services/ai/stream.py). Pure functions: no run, no CLI."""

import json
import os

import pytest

from services.ai import launch, stream


def _args(**over):
    base = dict(
        path="/bin/claude",
        prompt="Do the ticket",
        live=False,
        system_file="/r/system.md",
        sub_system_file="/r/sub.md",
        agents_file="/r/agents.json",
        mcp={"mcpServers": {}},
        settings=launch.settings_json(["Bash(rm -rf /*)"]),
        schema=launch.REPORT_SCHEMA,
        plugin_dirs=["/p/board", "/p/skills"],
        permission_mode="bypass",
        disallowed=[],
        session_id="11111111-2222-3333-4444-555555555555",
        resume=False,
        name="IAM-12 · Dev An",
        model="haiku",
        effort=None,
        debug_file="/r/debug.log",
    )
    base.update(over)
    return launch.args_for(**base)


def _flag(args, name):
    return args[args.index(name) + 1]


# --------------------------------------------------------------------------- the flag set


def test_a_new_run_gets_the_whole_flag_set():
    a = _args()
    assert a[:3] == ["/bin/claude", "-p", "Do the ticket"]
    for flag in (
        "--verbose",
        "--forward-subagent-text",
        "--include-hook-events",
        "--strict-mcp-config",
    ):
        assert flag in a
    assert _flag(a, "--output-format") == "stream-json"
    assert _flag(a, "--permission-mode") == "bypassPermissions"
    assert _flag(a, "--append-system-prompt-file") == "/r/system.md"
    assert _flag(a, "--append-subagent-system-prompt-file") == "/r/sub.md"
    assert _flag(a, "--system-prompt-snapshot") == "off"
    assert _flag(a, "--agents") == "/r/agents.json"
    assert json.loads(_flag(a, "--json-schema"))["required"] == ["status", "summary"]
    assert json.loads(_flag(a, "--settings")) == {
        "permissions": {"deny": ["Bash(rm -rf /*)"]}
    }
    assert [a[i + 1] for i, x in enumerate(a) if x == "--plugin-dir"] == [
        "/p/board",
        "/p/skills",
    ]
    assert _flag(a, "--session-id").startswith("1111") and "--resume" not in a
    assert _flag(a, "--name") == "IAM-12 · Dev An"
    assert _flag(a, "--model") == "haiku" and "--effort" not in a
    assert _flag(a, "--debug-file") == "/r/debug.log"
    assert "--disallowedTools" not in a and "--add-dir" not in a


def test_a_live_run_reads_its_prompt_from_stdin():
    a = _args(live=True)
    assert "Do the ticket" not in a
    assert _flag(a, "--input-format") == "stream-json" and "--replay-user-messages" in a


def test_a_resumed_run_continues_its_session_without_renaming_it():
    a = _args(resume=True)
    assert _flag(a, "--resume").startswith("1111")
    assert "--session-id" not in a and "--name" not in a


@pytest.mark.parametrize(
    "mode,flag",
    [("auto", "auto"), ("bypass", "bypassPermissions"), ("", "bypassPermissions")],
)
def test_permission_mode_is_bypass_unless_auto(mode, flag):
    assert _flag(_args(permission_mode=mode), "--permission-mode") == flag


def test_optional_flags_appear_only_when_set():
    a = _args(
        agents_file=None,
        schema=None,
        plugin_dirs=[],
        disallowed=["WebFetch", "WebSearch"],
        effort="high",
        add_dirs=["/ws"],
    )
    assert "--agents" not in a and "--json-schema" not in a and "--plugin-dir" not in a
    assert _flag(a, "--disallowedTools") == "WebFetch,WebSearch"
    assert _flag(a, "--effort") == "high" and _flag(a, "--add-dir") == "/ws"


def test_the_deny_list_keeps_its_order_and_drops_repeats():
    rules = launch.DEFAULT_DENY + ["Bash(git push --force*)", "Bash(npm publish*)"]
    deny = launch.settings_json(rules)["permissions"]["deny"]
    assert deny[: len(launch.DEFAULT_DENY)] == launch.DEFAULT_DENY
    assert (
        deny.count("Bash(git push --force*)") == 1 and deny[-1] == "Bash(npm publish*)"
    )


# --------------------------------------------------------------------------- MCP servers


def test_the_board_server_comes_first_with_the_runs_token_and_cannot_be_replaced(
    tmp_path,
):
    config = {
        "mcp_servers": [
            {"name": "kanban", "type": "http", "url": "http://evil/mcp"},
            {
                "name": "github",
                "type": "stdio",
                "command": "gh-mcp",
                "args": ["serve"],
                "env": [{"key": "T", "value": "x"}],
            },
            {"name": "off", "type": "stdio", "command": "x", "enabled": False},
            {"type": "stdio", "command": "nameless"},
        ]
    }
    mcp = launch.mcp_config(
        config, "kbr_token", str(tmp_path), None, "http://127.0.0.1:8000"
    )["mcpServers"]
    assert list(mcp) == ["kanban", "github"]
    assert mcp["kanban"] == {
        "type": "http",
        "url": "http://127.0.0.1:8000/mcp/",
        "headers": {"Authorization": "Bearer kbr_token"},
    }
    assert mcp["github"] == {
        "type": "stdio",
        "command": "gh-mcp",
        "args": ["serve"],
        "env": {"T": "x"},
    }


# --------------------------------------------------------------------------- the board's plugin


def test_the_board_plugin_reports_hook_events_and_never_blocks(tmp_path, monkeypatch):
    monkeypatch.setattr(launch, "data_root", lambda: tmp_path)
    root = launch.board_plugin_dir()
    assert launch.board_plugin_dir() == root  # written once per version
    manifest = json.loads(
        open(os.path.join(root, ".claude-plugin", "plugin.json")).read()
    )
    assert (
        manifest["name"] == "kanban-board"
        and manifest["version"] == launch.BOARD_PLUGIN_VERSION
    )
    hooks = json.loads(open(os.path.join(root, "hooks", "hooks.json")).read())["hooks"]
    assert set(hooks) == {"PostToolUse", "SubagentStart", "SubagentStop", "Stop"}
    assert (
        "Edit" in hooks["PostToolUse"][0]["matcher"]
        and "TaskCreate" in hooks["PostToolUse"][0]["matcher"]
    )
    sh = open(os.path.join(root, "hooks", "post.sh")).read()
    cmd = open(os.path.join(root, "hooks", "post.cmd")).read()
    for script in (sh, cmd):
        assert (
            "/ai/hooks" in script and "KANBAN_RUN_TOKEN" in script and "-m 5" in script
        )
    assert sh.rstrip().endswith("exit 0") and cmd.rstrip().endswith("exit /b 0")
    assert os.access(os.path.join(root, "hooks", "post.sh"), os.X_OK)


# --------------------------------------------------------------------------- the stream


def _line(ev: dict) -> str:
    return json.dumps(ev)


def _tool(name, inp, tid, parent=None):
    return _line(
        {
            "type": "assistant",
            "parent_tool_use_id": parent,
            "message": {
                "content": [{"type": "tool_use", "id": tid, "name": name, "input": inp}]
            },
        }
    )


def test_init_gives_the_session_the_model_and_what_was_loaded():
    out = stream.Parser("/w").parse(
        _line(
            {
                "type": "system",
                "subtype": "init",
                "session_id": "s1",
                "model": "claude-haiku",
                "agents": ["dev", "reviewer"],
                "plugins": [{"name": "kanban-board"}, "bad"],
                "tools": ["Bash"],
            }
        )
    )
    assert out["ready"] and out["session_id"] == "s1" and out["model"] == "claude-haiku"
    assert out["init"] == {
        "agents": ["dev", "reviewer"],
        "plugins": ["kanban-board"],
        "tools": ["Bash"],
    }


def test_a_subagents_steps_are_credited_to_the_agent_call_that_started_it():
    p = stream.Parser("/w")
    started = p.parse(
        _tool(
            "Agent",
            {"subagent_type": "reviewer", "description": "Review the diff"},
            "call1",
        )
    )
    assert started["agents"] == [{"id": "call1", "agent_type": "reviewer"}]
    assert (
        started["rows"][0]["kind"] == "subagent"
        and started["rows"][0]["agent_id"] is None
    )
    assert started["rows"][0]["title"].startswith("Asked reviewer: Review the diff")
    inner = p.parse(_tool("Bash", {"command": "pytest -q"}, "t2", parent="call1"))
    assert (
        inner["rows"][0]["agent_id"] == "call1"
        and inner["rows"][0]["detail"]["command"] == "pytest -q"
    )
    said = p.parse(
        _line(
            {
                "type": "assistant",
                "parent_tool_use_id": "call1",
                "message": {"content": [{"type": "text", "text": "Two findings."}]},
            }
        )
    )
    assert said["agents"] == [{"id": "call1", "last_text": "Two findings."}]
    # the lead's own text is not an agent's
    lead = p.parse(
        _line(
            {
                "type": "assistant",
                "message": {"content": [{"type": "text", "text": "Done."}]},
            }
        )
    )
    assert lead["agents"] == [] and lead["rows"][0]["agent_id"] is None


def test_plans_messages_and_the_report_are_their_own_kinds_and_tool_search_is_skipped():
    p = stream.Parser("/w")
    assert p.parse(_tool("ToolSearch", {"query": "x"}, "t0"))["rows"] == []
    plan = p.parse(_tool("TaskCreate", {"subject": "Write the migration"}, "t1"))[
        "rows"
    ][0]
    assert plan["kind"] == "plan" and plan["title"] == "Write the migration"
    sent = p.parse(
        _tool("SendMessage", {"to": "IAM-7", "message": "API is ready"}, "t2")
    )
    assert sent["messages_out"] == [
        {"peer": "IAM-7", "text": "API is ready", "agent_id": None}
    ]
    assert sent["rows"][0]["kind"] == "message" and sent["rows"][0]["detail"] == {
        "direction": "out",
        "peer": "IAM-7",
    }
    assert (
        p.parse(_tool("StructuredOutput", {"status": "done"}, "t3"))["rows"][0]["kind"]
        == "report"
    )


def test_a_message_from_another_session_is_a_step_and_a_replayed_message_is_not():
    p = stream.Parser("/w")
    text = '<cross-session-message from="docs-assistant">Page updated</cross-session-message>'
    got = p.parse(_line({"type": "user", "message": {"content": text}}))
    assert got["messages_in"] == [
        {"peer": "docs-assistant", "text": "Page updated", "agent_id": None}
    ]
    assert got["rows"][0]["title"] == "From docs-assistant: Page updated"
    replay = p.parse(
        _line({"type": "user", "isReplay": True, "message": {"content": text}})
    )
    assert replay["rows"] == [] and replay["messages_in"] == []


def test_a_failed_tool_result_is_an_error_step_and_carries_its_exit_code():
    got = stream.Parser("/w").parse(
        _line(
            {
                "type": "user",
                "message": {
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "t9",
                            "is_error": True,
                            "content": "Exit code 2\nboom",
                        }
                    ]
                },
            }
        )
    )
    assert got["results"][0]["exit_code"] == 2 and got["results"][0]["tool_id"] == "t9"
    assert (
        got["rows"][0]["kind"] == "error" and got["rows"][0]["parent_tool_id"] == "t9"
    )


def test_the_result_carries_the_structured_report_or_reads_it_from_json_text():
    p = stream.Parser("/w")
    out = p.parse(
        _line(
            {
                "type": "result",
                "subtype": "success",
                "session_id": "s1",
                "result": "",
                "structured_output": {"status": "done", "summary": "ok"},
                "usage": {
                    "input_tokens": 10,
                    "cache_read_input_tokens": 90,
                    "output_tokens": 5,
                },
                "total_cost_usd": 0.01,
                "modelUsage": {"m": {"contextWindow": 200000}},
            }
        )
    )
    r = out["result"]
    assert r["structured"] == {"status": "done", "summary": "ok"} and not r["is_error"]
    assert (r["tokens_in"], r["tokens_cached"], r["tokens_out"]) == (100, 90, 5)
    assert out["context_window"] == 200000 and out["session_id"] == "s1"
    text = p.parse(
        _line(
            {
                "type": "result",
                "subtype": "success",
                "result": '{"status": "partial", "summary": "half"}',
            }
        )
    )
    assert text["result"]["structured"]["status"] == "partial"
    failed = p.parse(
        _line({"type": "result", "subtype": "error_max_turns", "result": "stopped"})
    )
    assert failed["result"]["is_error"] and failed["result"]["structured"] is None


def test_secrets_in_commands_are_redacted_and_lines_that_are_not_json_are_ignored():
    p = stream.Parser("/w")
    fake = (
        "z" * 6 + "9" * 6
    )  # a made-up value, built here so no scanner reads it as a real token
    header = "Authorization: " + "Bear" + "er " + fake
    row = p.parse(_tool("Bash", {"command": f"curl -H '{header}' x"}, "t1"))["rows"][0]
    assert fake not in row["detail"]["command"] and fake not in row["title"]
    assert p.parse("not json")["rows"] == [] and p.parse("{broken")["rows"] == []


def test_pictures_a_prompt_names_are_copied_where_the_cli_may_read_them(
    tmp_path, monkeypatch
):
    """Hotfix 3.37.2 in v2: a pasted picture is a web path; the run gets a copy in a folder it may read (--add-dir)."""
    from services.ai import pictures

    uploads = tmp_path / "uploads"
    (uploads / "comments").mkdir(parents=True)
    (uploads / "_private").mkdir()
    (uploads / "comments" / "shot.png").write_bytes(b"\x89PNG")
    (uploads / "_private" / "secret.png").write_bytes(b"\x89PNG")
    monkeypatch.setenv("KANBAN_UPLOADS_DIR", str(uploads))
    monkeypatch.setattr(pictures, "folder_for", lambda key: tmp_path / "staged" / key)
    text = "See ![s](/uploads/comments/shot.png) and ![p](/uploads/_private/secret.png)"
    out, folder = pictures.stage(text, "run_x")
    assert folder == str(tmp_path / "staged" / "run_x")
    assert (tmp_path / "staged" / "run_x" / "shot.png").read_bytes() == b"\x89PNG"
    assert not (tmp_path / "staged" / "run_x" / "secret.png").exists()
    assert (
        out.startswith(text)
        and "open each with Read" in out
        and "shot.png" in out.split(text)[1]
    )
    assert pictures.stage("no pictures here", "run_y") == ("no pictures here", None)
    # and the CLI is allowed to read that folder
    a = _args(add_dirs=[d for d in (None, folder) if d])
    assert _flag(a, "--add-dir") == folder


def test_a_run_folder_never_leads_out_of_the_runs_folder(tmp_path, monkeypatch):
    monkeypatch.setattr(launch, "data_root", lambda: tmp_path)
    assert launch.run_dir("run_abc123") == (tmp_path / "runs" / "run_abc123").resolve()
    assert not (tmp_path / "runs" / "run_new").exists()
    launch.run_dir("run_new", create=False)
    assert not (tmp_path / "runs" / "run_new").exists()
    for bad in ("../x", "a/b", "..", "/etc"):
        with pytest.raises(ValueError):
            launch.run_dir(bad)
