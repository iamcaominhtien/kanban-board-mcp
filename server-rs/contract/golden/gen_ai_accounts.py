"""Golden vectors for the pure functions of `services/ai/accounts.py` and `services/ai/signin.py`
(`crates/kb-ai-run/src/{accounts,signin}.rs`): the account state machine (`_apply` over every state, answer and
"CLI found"), names and folders (`_clean_name`, `_slug`, `_inside_root`), versions, an account as the UI sees it
(`to_dict`), what the status bar reads from the terminal (`read_screen`) and the command a person runs by hand
(`fallback_command` for a shell and for PowerShell).

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_ai_accounts.py
Writes `ai_accounts.json` next to this file.
"""

import json
import os
import sys
import tempfile
from pathlib import Path
from unittest import mock

work = tempfile.mkdtemp(prefix="gen-ai-accounts-")
os.environ["KANBAN_CONFIG_DIR"] = f"{work}/config"
os.environ["KANBAN_DB_PATH"] = f"{work}/data/kanban.db"
os.environ["KANBAN_LOG_DIR"] = f"{work}/logs"
os.environ["KANBAN_AI_KEY_FILE"] = f"{work}/ai.key"
os.environ["CLAUDE_CONFIG_DIR"] = f"{work}/claude"
os.environ["HOME"] = f"{work}/home"
sys.path.insert(0, os.getcwd())

from models import AiAccount  # noqa: E402
from services.ai import accounts, profiles, signin  # noqa: E402

OUT = Path(__file__).with_name("ai_accounts.json")
out: dict = {}


def row_dict(row):
    return json.loads(row.model_dump_json())


def refused(call):
    try:
        return {"ok": call()}
    except accounts.AccountError as exc:
        return {"error": [str(exc), exc.code]}


NAMES = [
    "Work Claude",
    "  Work   Claude  ",
    "work\tclaude\nmax",
    "",
    "   ",
    "\x1c\x1d",
    "x" * 60,
    "x" * 61,
    "é" * 60,
    "é" * 61,
    "Tài khoản công việc",
    "ÄÖÜ ß İstanbul",
    "ΣΑΣ sigma",
    "---",
    "a--b__c  d",
    "A/B\\C..D",
    "..",
    "Team #1 (Max)",
    "0",
    "名前",
    "y" * 45 + "-" + "z" * 10,
    "a" * 39 + "- b",
    "Ünïcödé Nâme 123",
]
out["clean_name"] = [{"name": n, "out": refused(lambda n=n: accounts._clean_name(n))} for n in NAMES] + [
    {"name": None, "out": refused(lambda: accounts._clean_name(None))}
]
out["slug"] = [{"name": n, "out": accounts._slug(n)} for n in NAMES]

ROOTS = ["/acc/root", "/acc/root/", "/acc//root/./", "/acc/root/../root", "/"]
LEAVES = ["work", "work-2", "a/b", "..", ".", "", "../x", "a/..", "/abs", "work/", "wo rk", "x/../y", "./z", "..hidden", "a\\b", "//x", "root"]
out["inside_root"] = []
for root in ROOTS:
    with mock.patch.dict(os.environ, {accounts.ROOT_ENV: root}):
        for leaf in LEAVES:
            got = refused(lambda leaf=leaf: str(accounts._inside_root(leaf)))
            out["inside_root"].append({"root": root, "leaf": leaf, "out": got})

VERSIONS = [
    "2.1.4 (Claude Code)",
    "claude v2.0.31",
    "v1.2",
    "Version: 10.20.30-beta.1+build.5 extra",
    "1.2.3.4.5",
    "no version here",
    "",
    "release 7",
    "x1.2.3",
    "1.2-rc_1.final!",
    "9.9.9 (Claude Code)\n",
    "warning: old node 18.1\n2.1.4 (Claude Code)",
    "1." + "9" * 60,
    "codex-cli 0.44.0",
    "v.1.2",
    "1.2+",
]
out["parse_version"] = [{"text": v, "out": accounts.parse_version(v)} for v in VERSIONS] + [{"text": None, "out": accounts.parse_version(None)}]

# --------------------------------------------------------------------------------------------------------------
# the state machine: what a CLI answer does to the row
# --------------------------------------------------------------------------------------------------------------
STAMP = "2025-01-01T00:00:00+00:00"


def account(**fields):
    base = dict(id="acct_1", name="Work", cli="claude", folder="/acc/root/work", created_at=STAMP, updated_at=STAMP)
    base.update(fields)
    return AiAccount(**base)


BEFORE = [
    {},
    {"status": "needs_sign_in", "status_detail": "Not signed in"},
    {"status": "signed_in", "status_detail": "signed in (claude.ai, max)", "email": "an@work.example", "plan": "max", "method": "subscription", "checked_at": STAMP},
    {"status": "signed_in", "email": "an@work.example", "signed_out_at": STAMP, "signed_out_how": "run"},
    {"status": "needs_sign_in", "status_detail": "Session expired", "email": "old@work.example", "plan": "pro", "method": "subscription", "signed_out_at": STAMP, "signed_out_how": "run"},
    {"status": "cli_missing", "status_detail": "CLI not installed", "email": "an@work.example"},
    {"status": "signing_in"},
]
ANSWERS = [
    None,
    profiles.Status(True, "signed in (claude.ai, max)", "new@work.example", "max", "subscription"),
    profiles.Status(True, "", None, None, None),
    profiles.Status(True, "signed in ()", "", "", ""),
    profiles.Status(False, "not signed in (none)"),
    profiles.Status(False, ""),
    profiles.Status(False, "The CLI did not answer (TimeoutExpired)", "x@y", "pro", "api key"),
]
out["apply"] = []
for before in BEFORE:
    for answer in ANSWERS:
        for found in (True, False):
            row = account(**before)
            start = row_dict(row)
            just_signed_out = accounts._apply(row, answer, found)
            after = row_dict(row)
            for key in ("checked_at", "updated_at"):
                if after[key] != start[key]:
                    after[key] = "<now>"
            out["apply"].append(
                {
                    "before": start,
                    "answer": None if answer is None else {"signed_in": answer.signed_in, "detail": answer.detail, "email": answer.email, "plan": answer.plan, "method": answer.method},
                    "found": found,
                    "after": after,
                    "out": just_signed_out,
                }
            )

USERS = [
    None,
    {},
    {"here": [], "elsewhere": []},
    {"here": [{"id": "m1", "name": "Claude Code · Backend", "project_id": "p1"}], "elsewhere": []},
    {"here": [{"id": "m1", "name": "A", "project_id": "p1"}], "elsewhere": [{"id": "m2", "name": "B", "project_id": "p2"}, {"id": "m3", "name": "m3", "project_id": "p3"}]},
]
out["to_dict"] = []
for before in BEFORE:
    for users in USERS:
        for by in (None, "An Nguyen", ""):
            row = account(**before, created_by="An Nguyen")
            out["to_dict"].append({"account": row_dict(row), "users": users, "signing_in_by": by, "out": accounts.to_dict(row, users, signing_in_by=by)})

out["cli_for_provider"] = [{"provider": p, "out": accounts.cli_for_provider(p)} for p in ("claude-code", "codex", "", "claude", "Claude-Code")]
out["claude_config_dir"] = [
    {"account": None, "out": accounts.claude_config_dir(None)},
    {"account": row_dict(account()), "out": accounts.claude_config_dir(account())},
    {"account": row_dict(account(cli="codex")), "out": accounts.claude_config_dir(account(cli="codex"))},
]
out["constants"] = {
    "ROOT_ENV": accounts.ROOT_ENV,
    "ACCOUNT_CLIS": accounts.ACCOUNT_CLIS,
    "STATUSES": list(accounts.STATUSES),
    "NAME_MAX": accounts.NAME_MAX,
    "VERSION_TIMEOUT_S": accounts.VERSION_TIMEOUT_S,
    "VERSION_RETRY_S": accounts.VERSION_RETRY_S,
    "available": accounts.available("claude"),
    "KEEP_BYTES": signin.KEEP_BYTES,
    "POLL_S": signin.POLL_S,
    "ORPHAN_S": signin.ORPHAN_S,
    "MAX_S": signin.MAX_S,
    "busy": str(signin.SignInBusy("An Nguyen")),
}

# --------------------------------------------------------------------------------------------------------------
# the sign-in terminal: reading the screen, the command to run by hand
# --------------------------------------------------------------------------------------------------------------
SCREENS = [
    "$ claude auth login\nStarting…",
    "Opening your browser to sign in…\nvisit: https://claude.example/oauth/authorize?code=true&client_id=x\n",
    "Paste code here if prompted > ",
    "Select login method:\n❯ 1. Google OAuth\n  2. Use a Google Cloud project",
    "Paste the authorization code here > ",
    "Do you trust the files in this folder?\n❯ 1. Yes",
    "Invalid or expired code",
    "Paste code here if prompted > bad\nInvalid or expired code\nPress Enter to retry",
    "Paste code here if prompted > bad\nInvalid or expired code",
    "\x1b[1mSelect login method\x1b[0m",
    "some new question we have never seen",
    "",
    "\r\n\r\n",
    "Opening your browser to sign in…\nIf it does not open, visit: https://claude.example/oauth/authorize?code=true&client_id=x\nPaste code here if prompted > ",
    "Opening your browser…\r\nhttps://a.example/one\r\nhttps://b.example/two?x=1&y=(2)\r\nwaiting",
    "link in quotes \"https://q.example/x\" and <https://angle.example/y> and 'https://s.example/z'",
    "\x1b]0;claude\x07\x1b(B\x1b[?25lChoose how to sign in\x1b[0m\r\n> 1. Claude account",
    "Enter the token:",
    "Type your one-time code " + "x" * 60 + " code",
    "enter the\ncode",
    "Login failed\nTry again\nline 3\nline 4\nline 5\nline 6\nline 7",
    "Login failed\nline 2\nline 3",
    "ERROR: network\nRetrying…\nOpening https://ok.example/",
    "Access denied.\nPaste code here > ",
    "one\ntwo\nthree\nfour\nfive\nSelect login method\nseven\neight",
    "Trust this folder? (y/n)",
    "DO YOU TRUST the authors",
    "x" * 2600 + "\nhttps://old.example/gone" + "y" * 2500 + "\nhttps://new.example/kept",
    "é" * 3000 + " paste the code",
    "Login successful",
    "Logged in as an@work.example",
    "http://plain.example/path) trailing",
    "\x1b[31mInvalid\x1b[0m code\x1b[K",
    "a\x0bb\x0cinvalid\x1cend",
    "İNVALID",
]
out["read_screen"] = [{"text": t, "signed_in": s, "out": signin.read_screen(t, s)} for t in SCREENS for s in (False, True)]


class Stub:
    def __init__(self, argv, env, cwd):
        self.argv, self._env, self.cwd = argv, env, cwd

    def login_argv(self, extra):
        return [*self.argv, *extra]

    def env(self):
        return dict(self._env)

    def login_cwd(self):
        return self.cwd


COMMANDS = [
    (["/home/an/.local/bin/claude", "auth", "login", "--claudeai"], {"CLAUDE_CONFIG_DIR": "/home/an/.kanban-board/ai-accounts/work"}, None),
    (["/opt/tools/claude", "auth", "login", "--claudeai"], {"CLAUDE_CONFIG_DIR": "/home/an/My Accounts/it's work"}, None),
    (["/usr/bin/agy"], {"HOME": "/acc/a b/home", "GIT_CONFIG_GLOBAL": "/home/an/.gitconfig", "AGY_CLI_DISABLE_AUTO_UPDATE": "1"}, "/acc/a b/home"),
    (["/usr/bin/agy"], {}, "/acc/plain/home"),
    (["codex", "login"], {}, None),
    (["/x/my tool", "log in", "", "$HOME", "a'b", "ok-._/:=+@%,"], {"A": "", "B": "x y", "C": "é ✓", "D": "semi;colon"}, "/c w d"),
    (["C:\\Program Files\\claude.exe", "auth", "login"], {"CLAUDE_CONFIG_DIR": "C:\\Users\\O'Neil\\acc"}, "C:\\Users\\O'Neil\\acc"),
    (["claude.cmd", "auth", "login", "--claudeai"], {"CLAUDE_CONFIG_DIR": "C:\\Users\\O'Neil\\acc"}, "C:\\Users\\O'Neil\\acc"),
    (["/bin/tên-lệnh", "x"], {}, None),
]
out["fallback_command"] = []
for argv, env, cwd in COMMANDS:
    for platform in ("linux", "win32"):
        with mock.patch.object(signin.accounts, "profile_of", lambda _a, argv=argv, env=env, cwd=cwd: Stub(argv, env, cwd)), mock.patch.object(signin.sys, "platform", platform):
            got = signin.fallback_command(account())
        out["fallback_command"].append({"argv": argv, "env": list(env.items()), "cwd": cwd, "platform": platform, "out": got})
out["powershell"] = [
    {"argv": argv, "env": list(env.items()), "cwd": cwd, "out": signin._powershell(argv, env, cwd)}
    for argv, env, cwd in COMMANDS + [(["claude.cmd", "auth", "login", "--claudeai"], {"CLAUDE_CONFIG_DIR": r"C:\Users\O'Neil\acc"}, r"C:\Users\O'Neil\acc"), ([r"C:\Program Files\claude.exe"], {}, None)]
]

text_out = json.dumps(out, ensure_ascii=False, indent=1)
OUT.write_text(text_out + "\n", encoding="utf-8")
print(f"{OUT.name}: " + ", ".join(f"{k} {len(v)}" for k, v in out.items()) + f", {len(text_out)} bytes")
