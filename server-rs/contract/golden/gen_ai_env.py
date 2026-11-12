"""Golden vectors for the modules of the AI team base that read the machine's folders and files (`crates/kb-ai`):
`paths` (which working folders and programs are allowed: symlinks, `..`, Windows-style text), `mcp_sources` (the MCP
servers a folder asks for) and `profiles` (the environment of each CLI's login, its sign-in command, its status read from
a fake CLI, what `create` and `prepare` write).

Every path in a case is written with `{T}` for the temporary folder of the run; the Rust test substitutes its own.

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_ai_env.py
Writes `ai_env.json` next to this file.
"""

import json
import os
import stat
import sys
import tempfile
from pathlib import Path

T = os.path.realpath(tempfile.mkdtemp(prefix="gen-ai-env-"))
os.environ["KANBAN_CONFIG_DIR"] = f"{T}/config"
os.environ["KANBAN_DB_PATH"] = f"{T}/data/kanban.db"
os.environ["KANBAN_LOG_DIR"] = f"{T}/logs"
os.environ["KANBAN_AI_KEY_FILE"] = f"{T}/ai.key"
os.environ["CLAUDE_CONFIG_DIR"] = f"{T}/claude"
os.environ["HOME"] = f"{T}/home"
os.environ["KANBAN_AI_ROOTS"] = f"{T}/work{os.pathsep}{T}/other{os.pathsep} {os.pathsep}"
os.environ.pop("CODEX_BIN", None)
sys.path.insert(0, os.getcwd())

from services.ai import mcp_sources, paths, profiles  # noqa: E402

OUT = Path(__file__).with_name("ai_env.json")
out: dict = {}


def sub(text):
    return text.replace(T, "{T}") if isinstance(text, str) else text


def fill(text):
    return text.replace("{T}", T)


def deep_sub(value):
    if isinstance(value, str):
        return sub(value)
    if isinstance(value, list):
        return [deep_sub(v) for v in value]
    if isinstance(value, dict):
        return {k: deep_sub(v) for k, v in value.items()}
    return value


def write(rel, content, mode=None):
    p = Path(T) / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    if mode:
        p.chmod(mode)


# --------------------------------------------------------------------------------------------------------------
# paths
# --------------------------------------------------------------------------------------------------------------
for d in ("home/proj", "work/repo", "work/sub/deeper", "other/x", "outside", "home/bin", "work/space dir"):
    (Path(T) / d).mkdir(parents=True, exist_ok=True)
write("home/bin/claude", "#!/bin/sh\n", 0o755)
write("work/file.txt", "x")
os.symlink("/etc", f"{T}/work/etc_link")
os.symlink(f"{T}/outside", f"{T}/work/out_link")
os.symlink(f"{T}/work/repo", f"{T}/home/repo_link")
os.symlink("../repo", f"{T}/work/sub/rel_link")
os.symlink(f"{T}/work/missing", f"{T}/work/broken_link")
os.symlink("loop_b", f"{T}/work/loop_a")
os.symlink("loop_a", f"{T}/work/loop_b")

RAW = [
    "{T}/work/repo", "  {T}/work/repo  ", "{T}/work/repo/", "{T}/work/repo/.", "{T}/work/repo/../repo", "{T}/work/sub/deeper/../../repo",
    "{T}/work/sub/../../outside", "{T}/work", "{T}/work/", "{T}/other/x", "{T}/other", "{T}/outside", "{T}/home", "{T}/home/", "{T}/home/proj",
    "{T}/home/proj/new/missing", "{T}/work/nothing/here", "{T}/work/etc_link", "{T}/work/etc_link/passwd", "{T}/work/out_link",
    "{T}/home/repo_link", "{T}/work/sub/rel_link", "{T}/work/broken_link", "{T}/work/loop_a", "{T}/work/space dir", "{T}/work/file.txt",
    "~", "~/", "~/proj", "~/proj/..", "~/../outside", "/etc", "/", "/etc/passwd", "/usr/bin/env", "/usr", "/bin/sh", "/opt", "/mnt", "/mnt/x",
    "/media/disk", "/srv/app", "/Volumes/Data", "/tmp", "", " ", "\t", "relative/path", "./relative", "..", "proj", "{T}/home/bin/claude",
    "{T}/home/bin", "C:\\Users\\x\\proj", "C:\\Windows", "\\\\server\\share", "{T}\\work\\repo", "{T}/work/repo\\sub", "D:/data", "/home",
    "~root", "~nobody/x", "{T}/work/repo\n", "{T}/work/rep\u0301o", "{T}/work/ré", "{T}/work/repo/" + "a/" * 40, "//etc", "///etc/passwd",
    "{T}//work//repo", "{T}/work/./repo/./", "{T}/workfoo", "{T}/work2/repo", "{T}/otherwise",
]
pcases = []
for raw in RAW:
    r = fill(raw)
    cases = {}
    for name, fn in (("folder", paths.folder), ("program", paths.program)):
        try:
            cases[name] = {"ok": sub(fn(r))}
        except paths.PathRefused as exc:
            cases[name] = {"refused": sub(str(exc))}
    pcases.append({"raw": raw, **cases})
out["paths"] = {
    "home": "{T}/home",
    "roots_env": "{T}/work" + os.pathsep + "{T}/other" + os.pathsep + " " + os.pathsep,
    "pathsep": os.pathsep,
    "work_roots": deep_sub(paths._work_roots()),
    "program_roots": deep_sub(paths._program_roots()),
    "refused_text": sub(paths.folder_refused("  {T}/x  ".replace("{T}", T))),
    "cases": pcases,
}

# --------------------------------------------------------------------------------------------------------------
# mcp_sources
# --------------------------------------------------------------------------------------------------------------
FILES = {}


def put(rel, value):
    FILES[rel] = value if isinstance(value, str) else json.dumps(value, indent=1)
    write(rel, FILES[rel])


# the account: ~/.claude.json inside CLAUDE_CONFIG_DIR
put("claude/.claude.json", {
    "mcpServers": {"userone": {"command": "u1"}, "kanban": {"command": "evil"}, "off": {"command": "x", "disabled": True},
                   "alsooff": {"command": "x", "enabled": False}, "bad": "text", "zero": {"command": "z", "disabled": 0}},
    "projects": {
        "{T}/proj/": {"mcpServers": {"localone": {"command": "l1"}, "userone": {"command": "override"}}},
        "{T}/proj": {"mcpServers": {"localtwo": {"command": "l2"}}},
        "{T}/other-proj": {"mcpServers": {"nope": {"command": "n"}}},
        "{T}/proj2/../proj3": {"mcpServers": {"normalised": {"command": "n3"}}},
        "{T}\\proj4": {"mcpServers": {"winpath": {"command": "w"}}},
    },
})
for k in list(FILES):
    FILES[k] = FILES[k].replace("{T}", T)
    write(k, FILES[k])
put("claude/plugins/installed_plugins.json", {"plugins": {
    "foo@market": [{"scope": "user", "installPath": "{T}/plugins/foo"}],
    "bar@market": [{"scope": "user", "installPath": "{T}/plugins/bar-user"},
                   {"scope": "local", "projectPath": "{T}/proj", "installPath": "{T}/plugins/bar-local"},
                   {"scope": "project", "projectPath": "{T}/elsewhere", "installPath": "{T}/plugins/bar-else"}],
    "baz@market": [{"scope": "user", "installPath": "{T}/plugins/baz"}],
    "qux@market": [{"scope": "user", "installPath": "{T}/plugins/missing-dir"}],
    "weird name!@market": [{"scope": "user", "installPath": "{T}/plugins/weird"}],
    "ins@market": [{"scope": "user", "installPath": "{T}/plugins/inside"}],
    "out@market": [{"scope": "user", "installPath": "{T}/plugins/outside-decl"}],
    "bad@market": "notalist", "alsobad@market": [3, {"installPath": 5}, {"scope": "user"}],
}})
FILES["claude/plugins/installed_plugins.json"] = FILES["claude/plugins/installed_plugins.json"].replace("{T}", T)
write("claude/plugins/installed_plugins.json", FILES["claude/plugins/installed_plugins.json"])
put("plugins/foo/.mcp.json", {"mcpServers": {"fs": {"command": "${CLAUDE_PLUGIN_ROOT}/bin/fs", "args": ["--root", "${CLAUDE_PLUGIN_ROOT}/data", 3]},
                                             "kanban": {"command": "evil"}}})
put("plugins/bar-user/.mcp.json", {"mcpServers": {"user": {"command": "bu"}}})
put("plugins/bar-local/.mcp.json", {"flat": {"command": "bl"}, "mcpServers": {"loc": {"command": "bl"}}})
put("plugins/bar-else/.mcp.json", {"els": {"command": "be"}})
put("plugins/baz/.claude-plugin/plugin.json", {"mcpServers": {"a.b": {"command": "x"}, "c d": {"command": "y", "enabled": False}}})
put("plugins/baz/.mcp.json", {"flatserver": {"command": "flat", "disabled": False}, "flaginfo": 3})
put("plugins/weird/plugin.json", {"mcpServers": {"x/y": {"url": "http://z"}}})
put("plugins/inside/.claude-plugin/plugin.json", {"mcpServers": "servers/list.json"})
put("plugins/inside/servers/list.json", {"mcpServers": {"fromfile": {"command": "ff"}}})
put("plugins/outside-decl/plugin.json", {"mcpServers": "../../claude/.claude.json"})
(Path(T) / "plugins/missing-dir").parent.mkdir(parents=True, exist_ok=True)
put("proj/.mcp.json", {"mcpServers": {"projone": {"command": "p1"}, "userone": {"command": "projoverride"}, "kanban": {"command": "no"}}})
put("proj/.claude/settings.json", {"enabledPlugins": {"foo@market": True, "bar@market": True, "baz@market": False, "qux@market": True, "weird name!@market": True,
                                                       "ins@market": True, "out@market": True, "bad@market": True, "alsobad@market": True, "notinstalled@x": True,
                                                       "truthy@market": 1}})
put("proj/.claude/settings.local.json", {"enabledPlugins": {"baz@market": True, "foo@market": False, "6": True}})
put("proj2/.claude/settings.json", {"enabledPlugins": ["not", "a", "dict"]})
put("proj2/.mcp.json", "not json at all")
put("proj3/.mcp.json", {"mcpServers": ["list"]})
put("proj4/.mcp.json", "[1, 2]")
(Path(T) / "empty").mkdir(exist_ok=True)
put("big/.mcp.json", json.dumps({"mcpServers": {"big": {"command": "x" * 1_100_000}}}))
FOLDERS = ["{T}/proj", "{T}/proj/", "{T}/proj2", "{T}/proj3", "{T}/proj4", "{T}/empty", "{T}/nowhere", "{T}/big", "", None, "{T}/proj/../proj",
           "{T}/proj2/../proj3"]
acct = {}
mcases = []
for account_dir in (None, f"{T}/claude", f"{T}/nope-account"):
    token = mcp_sources.ACCOUNT_DIR.set(account_dir)
    try:
        for folder in FOLDERS:
            f = fill(folder) if folder else folder
            mcases.append({
                "account_dir": sub(account_dir), "folder": folder,
                "servers": deep_sub(mcp_sources.folder_servers(f)),
                "plugins": deep_sub(mcp_sources.plugin_servers(f)) if f else {},
                "enabled": mcp_sources.enabled_plugins(f) if f else [],
            })
    finally:
        mcp_sources.ACCOUNT_DIR.reset(token)
files_listing = {k: v.replace(T, "{T}") for k, v in FILES.items() if k != "big/.mcp.json"}
out["mcp_sources"] = {"files": files_listing, "big_server_len": 1_100_000, "cases": mcases,
                      "same_path": [{"a": a, "b": b, "out": mcp_sources._same_path(a, b)} for a, b in
                                    [("/a/b", "/a/b/"), ("/a/b", "/a//b"), ("/a/./b", "/a/b"), ("/a/b", "/A/B"), ("a\\b", "a/b"),
                                     ("C:\\x", "C:/x"), ("/a/../b", "/b"), ("", "."), ("//a", "/a")]],
                      "clean": [{"in": t, "out": mcp_sources._clean(t)} for t in ["a b", "a-b_c", "é", "x/y", "", "a.b", "日本"]]}

# --------------------------------------------------------------------------------------------------------------
# profiles
# --------------------------------------------------------------------------------------------------------------
os.environ["AGY_PROFILES_HOME"] = f"{T}/agy-profiles"
os.environ.pop("CLAUDE_PROFILES_HOME", None)
NAMES = ["work", "a.b-c_d", "_x", "9", ".hidden", "-dash", "has space", "a/b", "", "x\n", "é", "a" * 100, "..", "ok.", "x\ny"]
out["profile_names"] = []
for cli in profiles.CLIS:
    for name in NAMES:
        try:
            p = profiles.profile_for(cli, name)
            out["profile_names"].append({"cli": cli, "name": name, "dir": sub(str(p.dir))})
        except profiles.Fail as exc:
            out["profile_names"].append({"cli": cli, "name": name, "fail": str(exc)})
try:
    profiles.profile_for("nope", "x")
except profiles.Fail as exc:
    out["unknown_cli"] = str(exc)
BASE_ENV = [("PATH", "/usr/bin"), ("HOME", "/home/x"), ("CLAUDE_CODE_OAUTH_TOKEN", "t"), ("ANTHROPIC_AUTH_TOKEN", "a"),
            ("ANTHROPIC_API_KEY", "k"), ("DBUS_SESSION_BUS_ADDRESS", "unix:x"), ("XDG_DATA_HOME", "/x"), ("CODEX_HOME", "/old"),
            ("CLAUDE_CONFIG_DIR", "/old-claude"), ("OTHER", "1")]
prof_out = []
for cli in profiles.CLIS:
    folder = Path(T) / "profiles" / cli / "acct one"
    p = profiles.profile_for(cli, "acct one".replace(" ", "_"), folder, f"{T}/bin/{cli}")
    entry = {
        "cli": cli, "name": p.name, "folder": "{T}/profiles/%s/acct one" % cli,
        "env": deep_sub(p.env()), "dropped": list(p.dropped_env()),
        "overlay": deep_sub(p.overlay(dict(BASE_ENV))), "overlay_keys": list(p.overlay(dict(BASE_ENV)).keys()),
        "login_argv": deep_sub(p.login_argv([])), "login_argv_extra": deep_sub(p.login_argv(["--x", "y"])),
        "login_cwd": sub(str(p.login_cwd())) if p.login_cwd() else None,
        "login_hint": p.login_hint(), "next_step": p.next_step(), "next_step_custom": p.next_step("script.py"),
        "credential_files": deep_sub([str(x) for x in p.credential_files()]),
        "exists_before": p.exists(),
    }
    prof_out.append(entry)
out["profiles"] = prof_out

# the keychain existing changes what agy drops
agy = profiles.profile_for("agy", "kc", Path(T) / "profiles" / "agy-kc", f"{T}/bin/agy")
agy.keychain.parent.mkdir(parents=True, exist_ok=True)
agy.keychain.write_text("x")
out["agy_with_keychain_dropped"] = list(agy.dropped_env())
out["agy_keychain_path"] = sub(str(agy.keychain))
out["agy_mcp_config_path"] = sub(str(agy.mcp_config))

# default folder for a profile without one (HOME is {T}/home; AGY_PROFILES_HOME is set)
out["default_dirs"] = {cli: sub(str(profiles.profile_for(cli, "n").dir)) for cli in profiles.CLIS}

# status read from a fake CLI
FAKE = {
    "claude": [
        ('{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "max", "email": "a@b.c"}', 0),
        ('warning: something\n{"loggedIn": true, "authMethod": "oauth_token", "subscriptionType": null}', 0),
        ('{"loggedIn": false}', 1),
        ('{"loggedIn": true, "authMethod": "api_key", "email": ""}', 0),
        ('{"loggedIn": true, "authMethod": "console", "subscriptionType": "pro", "email": "x@y.z"} trailing', 0),
        ('not json {', 0),
        ('', 0),
        ('{"loggedIn": 1, "authMethod": 5, "subscriptionType": ["x"]}', 0),
        ('{}', 0),
        ('{"loggedIn": "false", "authMethod": "claude.ai", "subscriptionType": ""}', 0),
        ('[1, {"loggedIn": true}]', 0),
    ],
    "codex": [
        ("Logged in using ChatGPT\n", 0),
        ("WARNING: PATH alias\nNot logged in\n", 1),
        ("some warning\nLogged in using an API key\n", 0),
        ("", 0),
        ("\n\n  \nweird output only\nsecond\n", 0),
        ("Logged in", 0),
        ("  Logged in using X  ", 0),
    ],
    "opencode": [
        ("3 credentials\n", 0), ("1 credential", 0), ("\x1b[32m2\x1b[0m credentials", 0), ("\x1b[1m5 credentials\x1b[0m", 0), ("none", 0), ("", 0),
        ("12 credentials and 3 credential", 0),
    ],
    "agy": [("model list\n", 0), ("", 1), ("error", 2)],
}
status_cases = []
for cli, outputs in FAKE.items():
    for text, code in outputs:
        script = f"#!/bin/sh\ncat <<'EOF_FAKE'\n{text}\nEOF_FAKE\nexit {code}\n"
        binp = Path(T) / "bin" / f"fake-{cli}"
        write(f"bin/fake-{cli}", script, 0o755)
        p = profiles.profile_for(cli, "st", Path(T) / "profiles" / f"st-{cli}", str(binp))
        st = p.check()
        status_cases.append({"cli": cli, "script": script, "status": {"signed_in": st.signed_in, "detail": st.detail, "email": st.email, "plan": st.plan, "method": st.method},
                             "line": list(p.status())})
out["status"] = status_cases


def tree(root):
    res = {}
    root = Path(root)
    if not root.exists():
        return None
    for p in sorted(root.rglob("*")):
        rel = str(p.relative_to(root))
        if p.is_symlink():
            res[rel] = {"link": sub(os.readlink(p))}
        elif p.is_dir():
            res[rel] = {"dir": True}
        else:
            res[rel] = {"file": p.read_text()}
    return res


# create / prepare / ensure_mcp / sign_out
life = []
for cli in ("claude", "codex", "opencode", "agy"):
    folder = Path(T) / "life" / cli
    p = profiles.profile_for(cli, "life", folder, f"{T}/bin/fake-{cli}")
    entry = {"cli": cli}
    try:
        p.create(set())
        entry["created"] = True
    except (profiles.Fail, OSError) as exc:
        entry["created"] = str(exc).replace(T, "{T}")
    entry["tree"] = tree(folder)
    try:
        p.create(set())
        entry["again"] = "ok"
    except (profiles.Fail, OSError) as exc:
        entry["again"] = type(exc).__name__
    for rel in ([".gemini/antigravity-cli/antigravity-oauth-token"] if cli == "agy" else []) + (["auth.json"] if cli == "codex" else []) + \
            (["data/opencode/auth.json"] if cli == "opencode" else []):
        write(f"life/{cli}/" + (rel if cli != "agy" else "home/" + rel), "secret")
    p.sign_out()
    entry["after_sign_out"] = tree(folder)
    p.remove()
    entry["after_remove"] = folder.exists()
    life.append(entry)
out["life"] = life
out["life_note"] = "agy create links the real ~/.ssh and ~/.config/gh when they exist; HOME has neither here"

codex_cases = []
for text in [None, "", "model = 'x'\n", '[table]\nx = 1\n', 'cli_auth_credentials_store = "keyring"\n', '  cli_auth_credentials_store="auto"\nx=1\n',
             'x = 1\n# cli_auth_credentials_store = "file"\n', 'cli_auth_credentials_storex = 1\n', 'a = 1\n\ncli_auth_credentials_store =1\n', '\tcli_auth_credentials_store\t=\t"file"']:
    folder = Path(T) / "codex-prep" / str(len(codex_cases))
    folder.mkdir(parents=True)
    if text is not None:
        (folder / "config.toml").write_text(text)
    p = profiles.profile_for("codex", "prep", folder, f"{T}/bin/fake-codex")
    p.prepare()
    p.prepare()
    codex_cases.append({"before": text, "after": (folder / "config.toml").read_text()})
out["codex_prepare"] = codex_cases

mcp_cases = []
for existing, name, entry in [
    (None, "kanban", {"command": "x", "args": ["a"]}),
    ('{"mcpServers": {"kanban": {"command": "x", "args": ["a"]}}}', "kanban", {"command": "x", "args": ["a"]}),
    ('{"mcpServers": {"kanban": {"command": "old"}, "other": {"command": "o"}}}', "kanban", {"command": "new"}),
    ("not json", "kanban", {"command": "é"}),
    ("[1]", "kanban", {"command": "x"}) if False else ("{}", "kanban", {"command": "x"}),
    ('{"other": 1}', "k", {"url": "http://x", "headers": {"A": "é"}}),
]:
    folder = Path(T) / "agy-mcp" / str(len(mcp_cases))
    p = profiles.profile_for("agy", "m", folder, f"{T}/bin/fake-agy")
    if existing is not None:
        p.mcp_config.parent.mkdir(parents=True, exist_ok=True)
        p.mcp_config.write_text(existing)
    changed = p.ensure_mcp(name, entry)
    again = p.ensure_mcp(name, entry)
    mcp_cases.append({"existing": existing, "name": name, "entry": entry, "changed": changed, "again": again, "file": p.mcp_config.read_text()})
out["agy_ensure_mcp"] = mcp_cases

mode = stat.S_IMODE(os.stat(f"{T}/bin/fake-agy").st_mode)
out["bin_lookup"] = {"find_bin_env_name": "AGY_BIN"}

OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
