"""AI accounts: separate logins of one CLI (design/screens/ai-accounts.md). Profiles (what each CLI needs), the account
API, members that run as an account, the sign-in terminal against a fake CLI, and who may do what."""

import asyncio
import os
import sys
from pathlib import Path

import httpx
import pytest
from httpx import ASGITransport

from main import app
from models import AiAccount
from services.ai import accounts, cli, profiles, runs, signin
from tests.test_ai import FAKE, _project, _runner, _ticket, _wait, env  # noqa: F401


@pytest.fixture
def fake_cli(env, monkeypatch):  # noqa: F811
    """`claude` resolves to the fake CLI, accounts live in a temporary folder and each has its own login file."""
    monkeypatch.setenv(accounts.ROOT_ENV, str(env["tmp"] / "accounts"))
    monkeypatch.setenv("FAKE_CLAUDE_ACCOUNTS", "1")
    real = cli.find_cli

    def find(binary, explicit=None):
        if binary == "claude" and not explicit:
            return FAKE, [FAKE]
        return real(binary, explicit)

    monkeypatch.setattr(cli, "find_cli", find)
    monkeypatch.setattr(signin, "POLL_S", 0.2)
    return env


async def _account(c, name="Work Claude", cli_="claude"):
    r = await c.post("/ai/accounts", json={"name": name, "cli": cli_})
    assert r.status_code == 201, r.text
    return r.json()


def _login(account, email="an@work.example"):
    """What a finished sign-in leaves in the fake CLI's folder."""
    Path(account["folder"], ".fake-login").write_text(email)


# --------------------------------------------------------------------------- profiles (what each CLI needs)


def test_each_cli_keeps_its_login_in_its_own_place(tmp_path):
    claude = profiles.profile_for("claude", "w", tmp_path / "w")
    assert claude.env() == {"CLAUDE_CONFIG_DIR": str(tmp_path / "w")}
    codex = profiles.profile_for("codex", "x", tmp_path / "x")
    assert codex.env() == {"CODEX_HOME": str(tmp_path / "x")}
    opencode = profiles.profile_for("opencode", "o", tmp_path / "o")
    assert set(opencode.env()) == {
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
    }
    agy = profiles.profile_for("agy", "a", tmp_path / "a")
    assert agy.env()["HOME"] == str(tmp_path / "a" / "home")


def test_overlay_drops_variables_that_hide_the_account_and_keeps_the_rest(tmp_path):
    claude = profiles.profile_for("claude", "w", tmp_path / "w")
    base = {"PATH": "/bin", "ANTHROPIC_API_KEY": "k", "CLAUDE_CODE_OAUTH_TOKEN": "t"}
    out = claude.overlay(base)
    assert out["PATH"] == "/bin" and out["CLAUDE_CONFIG_DIR"] == str(tmp_path / "w")
    assert "ANTHROPIC_API_KEY" not in out and "CLAUDE_CODE_OAUTH_TOKEN" not in out
    assert base["ANTHROPIC_API_KEY"] == "k"  # the caller's environment is not changed


def test_codex_profile_keeps_the_login_in_a_file(tmp_path):
    codex = profiles.profile_for("codex", "x", tmp_path / "x")
    codex.create(set())
    text = (tmp_path / "x" / "config.toml").read_text()
    assert text.startswith('cli_auth_credentials_store = "file"')
    codex.prepare()  # idempotent
    assert (tmp_path / "x" / "config.toml").read_text() == text


def test_bad_names_are_refused(tmp_path):
    for bad in ("", "../x", ".hidden", "a/b", "-x"):
        with pytest.raises(profiles.Fail):
            profiles.profile_for("claude", bad, tmp_path / "x")


def test_a_cli_without_check_cannot_be_made():
    class Half(profiles.Profile):
        cli = "half"

    with pytest.raises(TypeError):
        Half("x")


# --------------------------------------------------------------------------- the account API


async def test_create_check_rename_and_list(fake_cli):
    c = fake_cli["c"]
    a = await _account(c)
    assert (
        a["status"] == "needs_sign_in"
        and a["cli"] == "claude"
        and a["member_count"] == 0
    )
    assert (
        Path(a["folder"]).is_dir()
        and Path(a["folder"]).parent == fake_cli["tmp"] / "accounts"
    )
    # not signed in until the CLI says so
    assert (await c.post(f"/ai/accounts/{a['id']}/check")).json()[
        "status"
    ] == "needs_sign_in"
    _login(a)
    done = (await c.post(f"/ai/accounts/{a['id']}/check")).json()
    assert done["status"] == "signed_in" and done["email"] == "an@work.example"
    assert done["plan"] == "max"
    assert (await c.patch(f"/ai/accounts/{a['id']}", json={"name": "Main"})).json()[
        "name"
    ] == "Main"
    listing = (await c.get("/ai/accounts")).json()
    assert [x["name"] for x in listing["accounts"]] == ["Main"]
    assert {x["cli"] for x in listing["clis"]} == {"claude", "codex", "opencode", "agy"}
    assert listing["terminal"] is (sys.platform != "win32")


async def test_names_are_unique_per_computer_and_checked_before_saving(fake_cli):
    c = fake_cli["c"]
    await _account(c, "Work Claude")
    dup = await c.post("/ai/accounts", json={"name": "work claude", "cli": "claude"})
    assert dup.status_code == 409 and dup.json()["detail"]["code"] == "name_taken"
    assert (
        await c.get("/ai/accounts/name-check", params={"name": "WORK claude"})
    ).json()["ok"] is False
    assert (await c.get("/ai/accounts/name-check", params={"name": "Other"})).json()[
        "ok"
    ] is True
    blank = await c.post("/ai/accounts", json={"name": "  ", "cli": "claude"})
    assert (
        blank.status_code == 422 and blank.json()["detail"]["code"] == "name_required"
    )
    unknown = await c.post("/ai/accounts", json={"name": "X", "cli": "vim"})
    assert unknown.status_code == 422


async def test_antigravity_accounts_are_refused_on_windows(fake_cli, monkeypatch):
    c = fake_cli["c"]
    monkeypatch.setattr(accounts, "_windows", lambda: True)
    r = await c.post("/ai/accounts", json={"name": "Google", "cli": "agy"})
    assert (
        r.status_code == 422
        and r.json()["detail"]["message"] == "Not available on Windows"
    )
    cards = {x["cli"]: x for x in (await c.get("/ai/accounts")).json()["clis"]}
    assert cards["agy"]["unavailable"] == "Not available on Windows"


async def test_a_missing_cli_makes_no_account(fake_cli, monkeypatch):
    c = fake_cli["c"]
    monkeypatch.setattr(cli, "find_cli", lambda binary, explicit=None: (None, []))
    r = await c.post("/ai/accounts", json={"name": "Work", "cli": "claude"})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "cli_missing"
    assert (await c.get("/ai/accounts")).json()["accounts"] == []


async def test_sign_out_keeps_the_account_and_forgets_the_login(fake_cli):
    c = fake_cli["c"]
    a = await _account(c)
    _login(a)
    await c.post(f"/ai/accounts/{a['id']}/check")
    out = (await c.post(f"/ai/accounts/{a['id']}/sign-out")).json()
    assert out["status"] == "needs_sign_in" and out["email"] is None
    assert not Path(a["folder"], ".fake-login").exists()
    assert len((await c.get("/ai/accounts")).json()["accounts"]) == 1


async def test_who_can_change_accounts(fake_cli):
    """The list is open to everyone; changing an account needs the desktop app (a request from this computer)."""
    c = fake_cli["c"]
    a = await _account(c)
    async with httpx.AsyncClient(
        transport=ASGITransport(app=app, client=("203.0.113.9", 5000)),
        base_url="http://test",
    ) as web:
        assert (await web.get("/ai/accounts")).status_code == 200
        for method, url, body in (
            ("POST", "/ai/accounts", {"name": "X", "cli": "claude"}),
            ("PATCH", f"/ai/accounts/{a['id']}", {"name": "Y"}),
            ("POST", f"/ai/accounts/{a['id']}/check", None),
            ("POST", f"/ai/accounts/{a['id']}/sign-out", None),
            ("POST", f"/ai/accounts/{a['id']}/signin", None),
            ("DELETE", f"/ai/accounts/{a['id']}", None),
        ):
            r = await web.request(method, url, json=body)
            assert r.status_code == 403, (method, url)
            assert "desktop app" in r.json()["detail"]


# --------------------------------------------------------------------------- members on an account


async def test_member_runs_as_its_account_and_follows_its_sign_in(
    fake_cli, monkeypatch
):
    c = fake_cli["c"]
    record = fake_cli["tmp"] / "config.txt"
    monkeypatch.setenv("FAKE_CLAUDE_CONFIG_RECORD", str(record))
    pid, _ = await _project(c)
    a = await _account(c)
    m = await _runner(c, pid, fake_cli["repo"], account_id=a["id"])
    assert m["account_id"] == a["id"] and m["account_ref"]["name"] == "Work Claude"
    tid = await _ticket(c, pid)
    # signed out: the run is held with the reason, not failed
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m["id"], "start": "now"}
    )
    await asyncio.sleep(0.6)
    runs.RT.wake.set()
    held = (await c.get(f"/tickets/{tid}/ai/runs")).json()[0]
    assert held["state"] == "queued" and "Work Claude needs sign-in" in (
        held.get("blocked_reason") or str(held)
    )
    # after the sign-in the held run starts by itself, as that account
    _login(a)
    await c.post(f"/ai/accounts/{a['id']}/check")
    run = await _wait(c, tid, ("finished", "failed"))
    assert run["state"] == "finished", run
    assert record.read_text().strip().splitlines()[-1] == a["folder"]


async def test_a_run_that_finds_the_account_signed_out_holds_every_member_on_it(
    fake_cli, monkeypatch
):
    c = fake_cli["c"]
    pid, _ = await _project(c)
    a = await _account(c)
    _login(a)
    await c.post(f"/ai/accounts/{a['id']}/check")
    m1 = await _runner(c, pid, fake_cli["repo"], name="One", account_id=a["id"])
    m2 = await _runner(c, pid, fake_cli["repo"], name="Two", account_id=a["id"])
    monkeypatch.setenv("FAKE_CLAUDE_MODE", "run_logged_out")
    tid = await _ticket(c, pid)
    await c.post(
        f"/tickets/{tid}/ai/assign", json={"member_id": m1["id"], "start": "now"}
    )
    run = await _wait(c, tid, ("failed",))
    assert run["state"] == "failed"
    now = (await c.get(f"/ai/accounts/{a['id']}")).json()
    assert (
        now["status"] == "needs_sign_in"
        and now["signed_out_how"] == "run"
        and now["signed_out_at"]
    )
    # one event for the account; the other member follows
    two = (await c.get(f"/ai/members/{m2['id']}")).json()
    assert two["account_ref"]["status"] == "needs_sign_in"
    # no project asked, so every member counts as "elsewhere"
    assert {x["name"] for x in now["members_elsewhere"]} == {"One", "Two"}
    here = (await c.get("/ai/accounts", params={"project_id": pid})).json()["accounts"][
        0
    ]
    assert {x["name"] for x in here["members_here"]} == {"One", "Two"}


async def test_an_account_only_fits_members_of_its_own_cli_and_runner(fake_cli):
    c = fake_cli["c"]
    pid, _ = await _project(c)
    a = await _account(c)
    m = await _runner(c, pid, fake_cli["repo"])
    assert m["account_id"] is None
    ok = await c.put(f"/ai/members/{m['id']}/account", json={"account_id": a["id"]})
    assert ok.status_code == 200 and ok.json()["account_id"] == a["id"]
    back = await c.put(f"/ai/members/{m['id']}/account", json={"account_id": None})
    assert back.json()["account_id"] is None
    api = await c.post(
        f"/projects/{pid}/ai/members",
        json={"name": "Api", "provider": "openai", "api_key": "sk-test-0000000000"},
    )
    assert api.status_code == 201
    bad = await c.put(
        f"/ai/members/{api.json()['id']}/account", json={"account_id": a["id"]}
    )
    assert bad.status_code == 422 and bad.json()["detail"]["code"] in (
        "not_local",
        "wrong_cli",
    )
    nope = await c.post(
        f"/projects/{pid}/ai/members",
        json={"name": "X", "provider": "claude-code", "account_id": "acct_missing"},
    )
    assert nope.status_code == 422


@pytest.mark.parametrize(
    "policy,expect_account,expect_paused",
    [("login", None, False), ("other", "OTHER", False), ("none", None, True)],
)
async def test_removing_an_account_says_what_happens_to_its_members(
    fake_cli, policy, expect_account, expect_paused
):
    c = fake_cli["c"]
    pid, _ = await _project(c)
    a = await _account(c, "Gone")
    other = await _account(c, "Other")
    m = await _runner(c, pid, fake_cli["repo"], account_id=a["id"])
    params = {"members": policy}
    if policy == "other":
        params["other_id"] = other["id"]
    r = await c.delete(f"/ai/accounts/{a['id']}", params=params)
    assert r.status_code == 200 and r.json()["members_moved"] == 1
    assert not Path(a["folder"]).exists()
    after = (await c.get(f"/ai/members/{m['id']}")).json()
    assert after["account_id"] == (other["id"] if expect_account == "OTHER" else None)
    assert after["paused"] is expect_paused
    assert [x["name"] for x in (await c.get("/ai/accounts")).json()["accounts"]] == [
        "Other"
    ]


async def test_removing_to_a_missing_or_foreign_account_is_refused(fake_cli):
    c = fake_cli["c"]
    pid, _ = await _project(c)
    a = await _account(c, "A")
    await _runner(c, pid, fake_cli["repo"], account_id=a["id"])
    r = await c.delete(f"/ai/accounts/{a['id']}", params={"members": "other"})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "other_required"
    assert Path(a["folder"]).exists()


# --------------------------------------------------------------------------- reading the terminal


@pytest.mark.parametrize(
    "text,phase,url",
    [
        ("$ claude auth login\nStarting…", "waiting", None),
        (
            "Opening your browser to sign in…\nvisit: https://claude.example/oauth/authorize?code=true&client_id=x\n",
            "browser",
            "https://claude.example/oauth/authorize?code=true&client_id=x",
        ),
        ("Paste code here if prompted > ", "paste_code", None),
        (
            "Select login method:\n❯ 1. Google OAuth\n  2. Use a Google Cloud project",
            "choose_method",
            None,
        ),
        ("Paste the authorization code here > ", "paste_code", None),
        ("Do you trust the files in this folder?\n❯ 1. Yes", "trust_folder", None),
        ("Invalid or expired code", "error", None),
        ("\x1b[1mSelect login method\x1b[0m", "choose_method", None),
    ],
)
def test_the_status_bar_reads_the_terminal_best_effort(text, phase, url):
    seen = signin.read_screen(text)
    assert seen["phase"] == phase and seen["url"] == url


def test_nothing_unknown_is_claimed():
    assert (
        signin.read_screen("some new question we have never seen")["phase"] == "waiting"
    )


# --------------------------------------------------------------------------- the sign-in terminal


pytestmark_pty = pytest.mark.skipif(signin.pty is None, reason="no pseudo-terminal")


async def _until(predicate, timeout=10.0):
    end = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > end:
            raise AssertionError("timed out")
        await asyncio.sleep(0.05)


async def _drain(q, until):
    """Collect messages until `until(msg)` is true; returns (text so far, last state)."""
    text, state = "", None
    while True:
        msg = await asyncio.wait_for(q.get(), 10)
        if msg["type"] == "out":
            text += msg["data"]
        else:
            state = msg
        if until(msg):
            return text, state


@pytestmark_pty
async def test_sign_in_in_a_terminal_ends_signed_in_when_the_cli_says_so(fake_cli):
    c = fake_cli["c"]
    a = await _account(c)
    assert (await c.post(f"/ai/accounts/{a['id']}/signin")).json() == {
        "mode": "terminal"
    }
    s = signin.active(a["id"])
    assert s is not None
    listing = (await c.get("/ai/accounts")).json()["accounts"][0]
    assert listing["status"] == "signing_in"  # one sign-in per account at a time
    busy = await c.post(f"/ai/accounts/{a['id']}/signin")
    assert busy.status_code == 409 and busy.json()["detail"]["code"] == "signing_in"
    q = signin.attach(s)
    text, state = await _drain(
        q, lambda m: m["type"] == "state" and m.get("phase") == "paste_code"
    )
    assert "claude.example/oauth" in text
    signin.write(s, "good\n")  # what the person pastes
    text, state = await _drain(q, lambda m: m["type"] == "state" and m.get("signed_in"))
    assert state["account"]["status"] == "signed_in"
    assert state["account"]["email"] == "an@work.example"
    await _until(lambda: signin.active(a["id"]) is None)  # the CLI ended by itself
    assert (await c.get(f"/ai/accounts/{a['id']}")).json()["status"] == "signed_in"


@pytestmark_pty
async def test_a_rejected_code_saves_nothing(fake_cli):
    c = fake_cli["c"]
    a = await _account(c)
    await c.post(f"/ai/accounts/{a['id']}/signin")
    s = signin.active(a["id"])
    q = signin.attach(s)
    await _drain(q, lambda m: m["type"] == "state" and m.get("phase") == "paste_code")
    signin.write(s, "bad\n")
    _, state = await _drain(
        q, lambda m: m["type"] == "state" and m.get("ended") == "exited"
    )
    assert state["exit_code"] == 1 and not state["signed_in"]
    assert (await c.get(f"/ai/accounts/{a['id']}")).json()["status"] == "needs_sign_in"


@pytestmark_pty
async def test_cancel_stops_the_cli_and_marks_nothing(fake_cli):
    c = fake_cli["c"]
    a = await _account(c)
    await c.post(f"/ai/accounts/{a['id']}/signin")
    s = signin.active(a["id"])
    pid = s.proc.pid
    assert (await c.delete(f"/ai/accounts/{a['id']}/signin")).json() == {
        "stopped": True
    }
    await _until(lambda: s.proc.poll() is not None)
    assert signin.active(a["id"]) is None
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)
    assert (await c.get(f"/ai/accounts/{a['id']}")).json()["status"] == "needs_sign_in"


@pytestmark_pty
async def test_the_login_runs_in_the_accounts_own_folder_not_the_one_on_this_computer(
    fake_cli,
):
    c = fake_cli["c"]
    a = await _account(c)
    await c.post(f"/ai/accounts/{a['id']}/signin")
    s = signin.active(a["id"])
    q = signin.attach(s)
    await _drain(q, lambda m: m["type"] == "state" and m.get("phase") == "paste_code")
    signin.write(s, "good\n")
    await _drain(q, lambda m: m["type"] == "state" and m.get("signed_in"))
    assert Path(a["folder"], ".fake-login").is_file()
    assert not (fake_cli["tmp"] / "claude-config" / ".fake-login").exists()


async def test_without_a_pseudo_terminal_the_window_gets_the_command_to_run_itself(
    fake_cli, monkeypatch
):
    c = fake_cli["c"]
    a = await _account(c)
    monkeypatch.setattr(signin, "pty", None)
    r = (await c.post(f"/ai/accounts/{a['id']}/signin")).json()
    assert r["mode"] == "fallback"
    assert (
        f"CLAUDE_CONFIG_DIR={a['folder']}" in r["command"]
        or a["folder"] in r["command"]
    )
    assert "auth login --claudeai" in r["command"]
    # and the same bar polls the CLI until it reports signed in
    _login(a)
    assert (await c.post(f"/ai/accounts/{a['id']}/check")).json()[
        "status"
    ] == "signed_in"


async def test_the_same_login_added_twice_is_noticed_for_claude(fake_cli):
    c = fake_cli["c"]
    first = await _account(c, "Work Claude")
    _login(first, "an@work.example")
    await c.post(f"/ai/accounts/{first['id']}/check")
    second = await _account(c, "Copy")
    _login(second, "AN@work.example")
    s = signin.SignIn(second["id"], "user", ["x"])
    signin.SESSIONS[second["id"]] = s
    await signin._check(s)
    assert s.signed_in and s.duplicate_of == "Work Claude"
    signin.SESSIONS.pop(second["id"], None)


def test_the_terminal_only_talks_to_pages_of_this_computer():
    from api.ai_accounts import _origin_ok

    class Ws:
        def __init__(self, host, origin=None):
            self.client = type("C", (), {"host": host})()
            self.headers = {"origin": origin} if origin else {}

    assert _origin_ok(Ws("127.0.0.1"))
    assert _origin_ok(
        Ws("127.0.0.1", "null")
    )  # the desktop app loads its UI from a file
    assert _origin_ok(Ws("127.0.0.1", "http://localhost:5173"))
    assert not _origin_ok(Ws("127.0.0.1", "https://evil.example"))
    assert not _origin_ok(Ws("10.0.0.5"))


async def test_the_fallback_command_names_the_accounts_folder(fake_cli):
    c = fake_cli["c"]
    a = await _account(c)
    acct = AiAccount(id=a["id"], name=a["name"], cli="claude", folder=a["folder"])
    command = signin.fallback_command(acct)
    assert a["folder"] in command and command.rstrip().endswith("auth login --claudeai")


# --------------------------------------------------------------------------- MCP: read accounts, assign, never sign in


async def test_an_ai_can_list_accounts_and_assign_a_member_but_not_sign_in(fake_cli):
    from kanban_mcp.tools.ai_team import AI_TEAM_OPS, ai_team

    c = fake_cli["c"]
    pid, _ = await _project(c)
    a = await _account(c)
    m = await _runner(c, pid, fake_cli["repo"])
    rows = await ai_team("accounts", project_id=pid)
    assert [r["name"] for r in rows] == ["Work Claude"]
    assert (
        rows[0]["status"] == "needs_sign_in"
        and "Only a person can sign in" in rows[0]["note"]
    )
    assert "folder" not in rows[0] and not any("token" in k for k in rows[0])
    out = await ai_team("assign_account", member_id=m["id"], account_id=a["id"])
    assert out["id"] == m["id"]
    assert (await c.get(f"/ai/members/{m['id']}")).json()["account_id"] == a["id"]
    rows = await ai_team("accounts", project_id=pid)
    assert rows[0]["members"] == [m["name"]]
    await ai_team("assign_account", member_id=m["id"], account_id="none")
    assert (await c.get(f"/ai/members/{m['id']}")).json()["account_id"] is None
    with pytest.raises(ValueError, match="not found"):
        await ai_team("assign_account", member_id=m["id"], account_id="acct_nope")
    # there is no action that signs in, signs out, renames or removes
    assert not {"signin", "sign_in", "login", "sign_out", "remove_account"} & set(
        AI_TEAM_OPS
    )


async def test_inside_an_ai_run_the_accounts_can_be_read_but_not_changed(fake_cli):
    from kanban_mcp.tools.ai_team import ai_team
    from services.ai import guard
    from tests.test_ai import _ctx

    ctx, pid, _, m, _tid = await _ctx(fake_cli)
    a = await _account(fake_cli["c"])
    tokens = guard.enter(ctx)
    try:
        assert len(await ai_team("accounts")) == 1
        with pytest.raises(ValueError, match="cannot start AIs or change AI members"):
            await ai_team("assign_account", member_id=m["id"], account_id=a["id"])
    finally:
        guard.leave(tokens)
