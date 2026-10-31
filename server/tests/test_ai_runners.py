"""Runs of Codex, opencode and Antigravity members: the event readers (on real streams captured from the three CLIs), the
command line and environment of each run, the permissions each CLI is held to, the stdio bridge to the board's MCP
endpoint, and whole runs against fake CLIs that replay those streams."""

import asyncio
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

import mcp_bridge
from services.ai import accounts, adapters, cli, runs
from tests.test_ai import _project, _ticket, _wait, env  # noqa: F401

FIX = Path(__file__).parent / "fixtures"
REAL = FIX / "real"
FAKES = {
    "codex": str(FIX / "fake_codex.py"),
    "opencode": str(FIX / "fake_opencode.py"),
    "antigravity": str(FIX / "fake_agy.py"),
}


def _feed(parser, name):
    out = []
    for line in (REAL / name).read_text().splitlines():
        out.append(parser.feed(line))
    return out


def _all(events, key):
    return [x for e in events for x in e[key]]


# --------------------------------------------------------------------------- reading the three streams


def test_codex_stream_becomes_steps_files_and_a_result():
    ev = _feed(adapters.for_provider("codex").parser("/work"), "codex_run.jsonl")
    assert any(e["ready"] for e in ev) and ev[0]["session_id"]
    steps = _all(ev, "steps")
    kinds = [s["kind"] for s in steps]
    assert "command" in kinds and "edit" in kinds and "say" in kinds
    # the shell wrapper codex adds is not shown
    assert any(s["text"].startswith("Ran python3 -c") for s in steps)
    assert not any("/bin/zsh" in s["text"] for s in steps)
    assert [f["path"] for f in _all(ev, "files")] == ["calc.py"]
    results = _all(ev, "results")
    assert results and all(r["exit_code"] == 0 and not r["is_error"] for r in results)
    assert any(r["output"].strip() == "3" for r in results)
    final = [e["result"] for e in ev if e["result"]][-1]
    assert (
        not final["is_error"] and "add()" in final["text"] and final["tokens_out"] > 0
    )


def test_opencode_stream_counts_the_changed_lines_and_ends_on_stop():
    ev = _feed(adapters.for_provider("opencode").parser("/work"), "opencode_run.jsonl")
    assert any(e["ready"] for e in ev) and ev[0]["session_id"].startswith("ses_")
    steps = _all(ev, "steps")
    assert [s["kind"] for s in steps if s["kind"] != "say"] == [
        "command",
        "read",
        "edit",
        "command",
    ]
    (change,) = _all(ev, "files")
    assert (
        change["path"] == "calc.py" and change["added"] == 1 and change["removed"] == 1
    )
    results = {r["tool_id"]: r for r in _all(ev, "results")}
    assert len(results) == 4 and all(not r["is_error"] for r in results.values())
    finals = [e["result"] for e in ev if e["result"]]
    assert (
        len(finals) == 1
        and finals[0]["text"].startswith("Fixed")
        and finals[0]["tokens_in"] > 0
    )


def test_agy_stream_becomes_steps_and_the_answer_without_file_links():
    ev = _feed(adapters.for_provider("antigravity").parser("/work"), "agy_run.jsonl")
    assert ev[0]["ready"] and ev[0]["session_id"]
    steps = _all(ev, "steps")
    assert [s["kind"] for s in steps] == ["command", "read", "edit", "command"]
    assert [f["path"] for f in _all(ev, "files")] == ["calc.py"]
    (final,) = [e["result"] for e in ev if e["result"]]
    assert (
        not final["is_error"]
        and "file://" not in final["text"]
        and "calc.py" in final["text"]
    )


def test_agy_says_what_headless_mode_denied_and_fails_a_run_that_ended_on_it():
    def result(response):
        return json.dumps(
            {
                "event": "result",
                "result": {
                    "status": "SUCCESS",
                    "response": response,
                    "usage": {"input_tokens": 5, "output_tokens": 1},
                    "denied_actions": [
                        {"action": "command", "display_name": "RunCommand"}
                    ],
                },
            }
        )

    parser = adapters.for_provider("antigravity").parser("/work")
    out = parser.feed(result(""))
    assert "denied: command" in out["steps"][0]["text"]
    # nothing was said after the denial: the run stopped on it, which is a failure and says what to do
    assert out["result"]["is_error"] and "Allow rule" in out["result"]["text"]
    # an answer after a denial still counts
    ok = parser.feed(result("Done without it."))
    assert not ok["result"]["is_error"] and ok["result"]["text"] == "Done without it."


def test_failures_end_the_result_as_errors():
    codex = adapters.for_provider("codex").parser("/work")
    assert codex.feed(json.dumps({"type": "error", "message": "401 Unauthorized"}))[
        "result"
    ]["is_error"]
    oc = adapters.for_provider("opencode").parser("/work")
    assert (
        oc.feed(json.dumps({"type": "error", "error": {"name": "AuthError"}}))[
            "result"
        ]["text"]
        == "AuthError"
    )
    agy = adapters.for_provider("antigravity").parser("/work")
    assert agy.feed(json.dumps({"event": "result", "result": {"status": "FAILED"}}))[
        "result"
    ]["is_error"]


def test_noise_is_ignored():
    for provider in ("codex", "opencode", "antigravity"):
        parser = adapters.for_provider(provider).parser("/work")
        for line in (
            "",
            "Reading additional input from stdin...",
            "{not json",
            "[1, 2]",
        ):
            out = parser.feed(line)
            assert not out["steps"] and not out["result"] and not out["ready"]


# --------------------------------------------------------------------------- how each run is started


def _spec(**kw):
    base = dict(
        path="/bin/x",
        cwd="/work",
        prompt="Fix it",
        model=None,
        mcp_url="http://127.0.0.1:8000/mcp/",
        token="kbr_secret",
        allowed=["Read", "Edit", "Bash(git status:*)", "Bash(pytest:*)", "mcp__kanban"],
        denied=["Bash(rm -rf:*)"],
    )
    return adapters.Spec(**{**base, **kw})


@pytest.mark.parametrize("provider", ["codex", "opencode", "antigravity"])
def test_the_token_is_only_in_the_environment_never_on_the_command_line(provider):
    launch = adapters.for_provider(provider).launch(_spec())
    assert not any("kbr_secret" in a for a in launch.args)
    assert any("kbr_secret" in v for v in launch.env.values())


@pytest.mark.parametrize("provider", ["codex", "opencode", "antigravity"])
def test_flags_that_switch_permission_checks_off_are_dropped(provider):
    flags = [
        "--dangerously-skip-permissions",
        "--sandbox=danger-full-access",
        "--yolo",
        "--auto",
        "--keep",
    ]
    args = adapters.for_provider(provider).launch(_spec(extra_flags=flags)).args
    assert "--keep" in args
    assert not any(
        bad in a
        for a in args
        for bad in ("dangerously", "danger-full-access", "yolo", "--auto")
    )


def test_codex_sandbox_follows_the_kind_of_run():
    adapter = adapters.for_provider("codex")
    work = adapter.launch(_spec()).args
    assert (
        work[:3] == ["/bin/x", "exec", "--json"]
        and work[work.index("-s") + 1] == "workspace-write"
    )
    ask = adapter.launch(_spec(read_only=True)).args
    assert ask[ask.index("-s") + 1] == "read-only"
    assert 'mcp_servers.kanban.bearer_token_env_var="KANBAN_RUN_TOKEN"' in work
    resume = adapter.launch(_spec(resume_id="abc-123")).args
    assert resume[:3] == ["/bin/x", "exec", "resume"] and resume[-2:] == [
        "abc-123",
        "Fix it",
    ]


def test_codex_prompt_that_looks_like_a_flag_is_not_read_as_one():
    args = adapters.for_provider("codex").launch(_spec(prompt="--help me")).args
    assert args[-1] == " --help me"


def test_opencode_permissions_are_deny_first_then_allow_then_deny():
    perm = adapters.opencode_permissions(
        ["Read", "Edit", "Bash(git status:*)", "Bash(pytest:*)"],
        ["Bash(git push:*)"],
        read_only=False,
    )
    assert list(perm["bash"].items()) == [
        ("*", "deny"),
        ("git status*", "allow"),
        ("pytest*", "allow"),
        ("git push*", "deny"),
    ]
    assert perm["edit"] == "allow" and perm["webfetch"] == "deny"
    ask = adapters.opencode_permissions(
        ["Edit", "Bash(git status:*)"], [], read_only=True
    )
    assert ask["edit"] == "deny" and ask["bash"] == {"*": "deny"}
    no_edit = adapters.opencode_permissions(["Read"], [], read_only=False)
    assert no_edit["edit"] == "deny"


def test_opencode_gets_its_config_and_the_board_server_through_the_environment():
    launch = adapters.for_provider("opencode").launch(
        _spec(model="opencode/x-free", resume_id="ses_1")
    )
    config = json.loads(launch.env["OPENCODE_CONFIG_CONTENT"])
    assert config["mcp"]["kanban"]["headers"] == {"Authorization": "Bearer kbr_secret"}
    assert launch.args[launch.args.index("-m") + 1] == "opencode/x-free"
    assert (
        launch.args[launch.args.index("-s") + 1] == "ses_1" and launch.args[-2] == "--"
    )


def test_agy_gets_command_rules_from_the_allow_list_and_never_the_bypass_flag():
    adapter = adapters.for_provider("antigravity")
    work = adapter.launch(_spec(resume_id="conv-1")).args
    assert work[work.index("--mode") + 1] == "accept-edits"
    settings = json.loads(work[work.index("--settings") + 1])
    allow = set(settings["permissions"]["allow"])
    # the Allow list, plus the read-only commands every run starts with (a denied command ends the whole run)
    assert {
        "command(git status)",
        "command(pytest)",
        "command(ls)",
        "command(cat)",
    } <= allow
    assert not any(r in allow for r in ("command(rm)", "command(find)", "command(*)"))
    assert work[work.index("--conversation") + 1] == "conv-1"
    ask = adapter.launch(_spec(read_only=True)).args
    assert ask[ask.index("--mode") + 1] == "plan"
    # a question may use the board's MCP server and no command at all
    assert json.loads(ask[ask.index("--settings") + 1])["permissions"]["allow"] == [
        "mcp(kanban/*)",
        "mcp(kanban)",
    ]
    assert "--dangerously-skip-permissions" not in work + ask
    assert adapter.launch(_spec()).env == {
        "KANBAN_RUN_TOKEN": "kbr_secret",
        "KANBAN_MCP_URL": "http://127.0.0.1:8000/mcp/",
    }


def test_every_run_says_what_was_and_was_not_applied():
    for provider in ("codex", "opencode", "antigravity"):
        assert adapters.for_provider(provider).launch(_spec()).notes


def test_only_claude_code_has_no_adapter():
    assert adapters.for_provider("claude-code") is None
    assert adapters.for_provider("openai") is None


# --------------------------------------------------------------------------- the stdio bridge


class _Board(BaseHTTPRequestHandler):
    seen: list = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        _Board.seen.append((self.headers.get("authorization"), body))
        if body.get("method") == "boom":
            self.send_response(500)
            self.end_headers()
            return
        if body.get("method") == "notifications/initialized":
            self.send_response(202)
            self.end_headers()
            return
        reply = {
            "jsonrpc": "2.0",
            "id": body.get("id"),
            "result": {"echo": body["method"]},
        }
        if body.get("method") == "stream":
            data = f"event: message\ndata: {json.dumps(reply)}\n\n".encode()
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
        else:
            data = json.dumps(reply).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


@pytest.fixture
def board_http():
    _Board.seen = []
    server = HTTPServer(("127.0.0.1", 0), _Board)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}/mcp/"
    server.shutdown()


def _bridge(url, lines, token="kbr_tok"):
    env = {**os.environ, "KANBAN_MCP_URL": url}
    if token:
        env["KANBAN_RUN_TOKEN"] = token
    else:
        env.pop("KANBAN_RUN_TOKEN", None)
    proc = subprocess.run(
        [sys.executable, str(Path(mcp_bridge.__file__))],
        input="\n".join(json.dumps(x) for x in lines) + "\n",
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )
    return proc


def test_the_bridge_forwards_with_the_runs_token_and_returns_json_and_event_streams(
    board_http,
):
    proc = _bridge(
        board_http,
        [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize"},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "stream"},
        ],
    )
    replies = sorted(
        (json.loads(x) for x in proc.stdout.splitlines()), key=lambda m: m["id"]
    )
    assert [r["result"]["echo"] for r in replies] == ["initialize", "stream"]
    assert {auth for auth, _ in _Board.seen} == {"Bearer kbr_tok"}
    assert len(_Board.seen) == 3  # the notification was delivered and needs no answer


def test_the_bridge_answers_a_request_it_could_not_deliver_with_an_error(board_http):
    proc = _bridge(board_http, [{"jsonrpc": "2.0", "id": 7, "method": "boom"}])
    (reply,) = (json.loads(x) for x in proc.stdout.splitlines())
    assert reply["id"] == 7 and reply["error"]["code"] == -32000
    dead = _bridge(
        "http://127.0.0.1:9/mcp/", [{"jsonrpc": "2.0", "id": 8, "method": "x"}]
    )
    assert json.loads(dead.stdout.splitlines()[0])["error"]["message"].startswith(
        "The board did not answer"
    )


def test_the_bridge_refuses_to_start_without_a_token(board_http):
    proc = _bridge(board_http, [], token=None)
    assert proc.returncode == 1 and "KANBAN_RUN_TOKEN" in proc.stderr


def test_the_stdio_entry_point_hands_over_to_the_bridge(board_http):
    server = Path(mcp_bridge.__file__).parent / "mcp_stdio.py"
    env = {**os.environ, "KANBAN_MCP_URL": board_http, "KANBAN_RUN_TOKEN": "kbr_tok"}
    proc = subprocess.run(
        [sys.executable, str(server), "--bridge"],
        input=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"}) + "\n",
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )
    assert json.loads(proc.stdout.splitlines()[0])["result"] == {"echo": "ping"}


# --------------------------------------------------------------------------- whole runs against fake CLIs


@pytest.fixture
def fakes(env, monkeypatch):  # noqa: F811
    monkeypatch.setenv(accounts.ROOT_ENV, str(env["tmp"] / "accounts"))
    record = env["tmp"] / "record.jsonl"
    monkeypatch.setenv("FAKE_CLI_RECORD", str(record))
    real = cli.find_cli

    def find(binary, explicit=None):
        if binary == "agy" and not explicit:
            return FAKES["antigravity"], [FAKES["antigravity"]]
        return real(binary, explicit)

    monkeypatch.setattr(cli, "find_cli", find)
    env["record"] = record
    return env


def _recorded(env):
    return [json.loads(x) for x in env["record"].read_text().splitlines()]


async def _member(c, pid, repo, provider, **extra):
    body = {
        "name": f"{provider} member",
        "provider": provider,
        "working_dir": repo,
        "cli_path": FAKES[provider],
        **extra,
    }
    r = await c.post(f"/projects/{pid}/ai/members", json=body)
    assert r.status_code == 201, r.text
    return r.json()


async def _assign(c, tid, member):
    r = await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": member["id"], "start": "now"}
    )
    assert r.status_code == 200, r.text


@pytest.mark.parametrize("provider", ["codex", "opencode"])
async def test_a_member_of_each_cli_works_a_ticket_to_review(fakes, provider):
    c = fakes["c"]
    pid, _ = await _project(c)
    m = await _member(c, pid, fakes["repo"], provider)
    tid = await _ticket(c, pid)
    await _assign(c, tid, m)
    run = await _wait(c, tid, ("finished", "failed"))
    assert run["state"] == "finished", run
    assert [f["path"] for f in run["files"]] == ["calc.py"]
    assert any(s["kind"] == "command" for s in run["steps"])
    assert any(
        "sandbox" in s["text"] or "Allow and Deny" in s["text"] for s in run["steps"]
    )
    assert run["session_id"]
    assert (await c.get(f"/tickets/{tid}")).json()["status"] == "review"
    (launch,) = _recorded(fakes)
    assert launch["cwd"] == str(Path(fakes["repo"]).resolve()) or launch[
        "cwd"
    ].endswith("repo")
    assert launch["env"][
        "KANBAN_RUN_TOKEN" if provider == "codex" else "OPENCODE_CONFIG_CONTENT"
    ]
    assert not any("kbr_" in a for a in launch["args"])


async def test_a_question_runs_read_only(fakes):
    c = fakes["c"]
    pid, _ = await _project(c)
    m = await _member(c, pid, fakes["repo"], "codex")
    tid = await _ticket(c, pid)
    r = await c.post(
        f"/tickets/{tid}/ai/ask",
        json={"member_id": m["id"], "question": "What does add() do?"},
    )
    assert r.status_code in (200, 201), r.text
    await _wait(c, tid, ("finished", "failed"))
    args = _recorded(fakes)[0]["args"]
    assert args[args.index("-s") + 1] == "read-only"


async def test_the_second_run_on_a_ticket_resumes_the_session(fakes):
    c = fakes["c"]
    pid, _ = await _project(c)
    m = await _member(c, pid, fakes["repo"], "codex")
    tid = await _ticket(c, pid)
    await _assign(c, tid, m)
    first = await _wait(c, tid, ("finished", "failed"))
    runs.RT.wake.set()
    r = await c.post(f"/ai/runs/{first['id']}/retry")
    assert r.status_code == 200, r.text
    for _ in range(100):
        launches = _recorded(fakes)
        if len(launches) == 2:
            break
        runs.RT.wake.set()
        await asyncio.sleep(0.1)
    assert (
        launches[0]["args"][:3] == [FAKES["codex"], "exec", "--json"]
        or "resume" not in launches[0]["args"][:3]
    )
    assert (
        "resume" in launches[1]["args"][:3]
        and first["session_id"] in launches[1]["args"]
    )


async def test_a_session_that_ended_with_a_login_error_marks_the_member(
    fakes, monkeypatch
):
    c = fakes["c"]
    monkeypatch.setenv("FAKE_CLI_MODE", "run_logged_out")
    pid, _ = await _project(c)
    m = await _member(c, pid, fakes["repo"], "codex")
    tid = await _ticket(c, pid)
    await _assign(c, tid, m)
    run = await _wait(c, tid, ("failed",))
    assert run["state"] == "failed"
    assert (await c.get(f"/ai/members/{m['id']}")).json()["health"] == "not_logged_in"


@pytest.mark.skipif(
    sys.platform == "win32", reason="Antigravity accounts are refused on Windows"
)
async def test_antigravity_runs_as_its_account_through_the_bridge(fakes, monkeypatch):
    c = fakes["c"]
    monkeypatch.setenv(
        "FAKE_CLI_MODE", "logged_out"
    )  # `agy models` fails until the account is signed in
    pid, _ = await _project(c)
    acct = (await c.post("/ai/accounts", json={"name": "Google", "cli": "agy"})).json()
    m = await _member(c, pid, fakes["repo"], "antigravity", account_id=acct["id"])
    tid = await _ticket(c, pid)
    await _assign(c, tid, m)
    # signed out: held, not failed
    await asyncio.sleep(0.5)
    held = (await c.get(f"/tickets/{tid}/ai/runs")).json()[0]
    assert held["state"] == "queued"
    # the account is signed in once the CLI says so (`agy models` exits 0)
    monkeypatch.setenv("FAKE_CLI_MODE", "finish")
    await c.post(f"/ai/accounts/{acct['id']}/check")
    run = await _wait(c, tid, ("finished", "failed"))
    assert run["state"] == "finished", run
    assert [f["path"] for f in run["files"]] == ["calc.py"]
    launch = _recorded(fakes)[-1]
    assert launch["env"]["HOME"] == str(Path(acct["folder"]) / "home")
    assert launch["env"]["KANBAN_RUN_TOKEN"].startswith("kbr_")
    assert launch["env"]["KANBAN_MCP_URL"].endswith("/mcp/")
    assert "--dangerously-skip-permissions" not in launch["args"]
    # the account's own MCP config names the bridge, with no token in the file
    text = (
        Path(acct["folder"]) / "home" / ".gemini" / "config" / "mcp_config.json"
    ).read_text()
    servers = json.loads(text)["mcpServers"]
    assert servers["kanban"]["args"][-1] == "--bridge" and "kbr_" not in text


async def test_antigravity_without_an_account_is_refused_with_the_reason(fakes):
    c = fakes["c"]
    pid, _ = await _project(c)
    m = await _member(c, pid, fakes["repo"], "antigravity")
    tid = await _ticket(c, pid)
    await _assign(c, tid, m)
    run = await _wait(c, tid, ("failed",))
    assert "need an AI account" in run["ended_reason"]


@pytest.mark.parametrize("provider", ["codex", "opencode", "antigravity"])
async def test_test_run_in_the_connect_step_works_for_every_cli(fakes, provider):
    c = fakes["c"]
    body = {
        "provider": provider,
        "cli_path": FAKES[provider],
        "working_dir": fakes["repo"],
    }
    r = (await c.post("/ai/test-run", json=body)).json()
    assert r["ok"], r
    detect = (
        await c.post(
            "/ai/detect", json={"provider": provider, "cli_path": FAKES[provider]}
        )
    ).json()
    assert detect["found"]


async def test_a_signed_out_cli_is_seen_by_detect(fakes, monkeypatch):
    c = fakes["c"]
    monkeypatch.setenv("FAKE_CLI_MODE", "logged_out")
    codex = (
        await c.post(
            "/ai/detect", json={"provider": "codex", "cli_path": FAKES["codex"]}
        )
    ).json()
    assert codex["logged_in"] is False
    agy = (
        await c.post(
            "/ai/detect",
            json={"provider": "antigravity", "cli_path": FAKES["antigravity"]},
        )
    ).json()
    assert agy["logged_in"] is False
    opencode = (
        await c.post(
            "/ai/detect", json={"provider": "opencode", "cli_path": FAKES["opencode"]}
        )
    ).json()
    assert (
        opencode["logged_in"] is None
    )  # it cannot say cheaply: free models need no login


def test_leftover_runs_are_recognised_for_every_cli():
    assert cli.LOCAL_CLIS == ("claude", "codex", "opencode", "agy")
