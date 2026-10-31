#!/usr/bin/env python3
"""Run several accounts of the same AI CLI side by side, each in its own profile.

    ai_profile.py <cli> new <name> [--no-keychain]
    ai_profile.py <cli> login <name> [login args]
    ai_profile.py <cli> run <name> [cli args]      run the CLI as that account
    ai_profile.py <cli> status <name>
    ai_profile.py <cli> list
    ai_profile.py <cli> rm <name> [-y]
    ai_profile.py list                             profiles of every CLI

<cli> is agy, claude, codex or opencode. How a profile keeps its login apart:

    agy       its own HOME, plus a login keychain inside it (macOS)
    claude    its own CLAUDE_CONFIG_DIR
    codex     its own CODEX_HOME, with credentials forced into a file
    opencode  its own XDG_*_HOME dirs (the free models need no login)

Environment: <CLI>_PROFILES_HOME (default ~/.<cli>-profiles), <CLI>_BIN (default: the CLI on PATH).
Standard library only.
"""
from __future__ import annotations

import json
import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path

REAL_HOME = Path.home()
CLIS = ("agy", "claude", "codex", "opencode")
NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]*$")
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
CODEX_STORE_KEY = "cli_auth_credentials_store"


class Fail(Exception):
    """A user-facing error: printed without a traceback."""


def profiles_root(cli: str) -> Path:
    return Path(os.environ.get(f"{cli.upper()}_PROFILES_HOME") or REAL_HOME / f".{cli}-profiles")


def find_bin(cli: str) -> str:
    found = os.environ.get(f"{cli.upper()}_BIN") or shutil.which(cli)
    if not found:
        raise Fail(f"{cli} not found on PATH (set {cli.upper()}_BIN)")
    return found


class Profile:
    """One account of one CLI. Subclasses say how its login is kept apart."""

    cli = ""
    login_args: tuple[str, ...] = ()

    def __init__(self, name: str):
        if not NAME_RE.match(name or ""):
            raise Fail(f"bad profile name: {name!r}" if name else "missing profile name")
        self.name = name
        self.dir = profiles_root(self.cli) / name

    # What changes in the environment, and what must not leak in from it.
    def env(self) -> dict[str, str]:
        return {}

    def dropped_env(self) -> tuple[str, ...]:
        return ()

    def build_env(self) -> dict[str, str]:
        env = {k: v for k, v in os.environ.items() if k not in self.dropped_env()}
        env.update(self.env())
        return env

    def call(self, argv: list[str], *, capture: bool = False, cwd: Path | None = None):
        kwargs = dict(env=self.build_env(), cwd=cwd)
        if capture:
            return subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, **kwargs)
        return subprocess.call(argv, **kwargs)

    # Lifecycle.
    def exists(self) -> bool:
        return self.dir.is_dir()

    def create(self, flags: set[str]) -> None:
        self.dir.mkdir(parents=True)

    def prepare(self) -> None:
        """Runs before login, run and status."""

    def forget(self) -> None:
        """Runs before rm, for logins kept outside the profile directory."""

    def login_argv(self, extra: list[str]) -> list[str]:
        return [find_bin(self.cli), *self.login_args, *extra]

    def login_cwd(self) -> Path | None:
        return None

    def status(self) -> tuple[bool, str]:
        raise NotImplementedError

    def next_step(self) -> str:
        return f"next: {Path(sys.argv[0]).name} {self.cli} login {self.name}"


class Agy(Profile):
    """agy keeps one Keychain entry per user, so a profile needs its own HOME and its own keychain."""

    cli = "agy"

    @property
    def home(self) -> Path:
        return self.dir / "home"

    @property
    def keychain(self) -> Path:
        return self.home / "Library" / "Keychains" / "login.keychain-db"

    def env(self) -> dict[str, str]:
        env = {
            "HOME": str(self.home),
            "GIT_CONFIG_GLOBAL": str(REAL_HOME / ".gitconfig"),
            "AGY_CLI_DISABLE_AUTO_UPDATE": "1",
        }
        if os.name == "nt":
            env["USERPROFILE"] = str(self.home)
        return env

    def dropped_env(self) -> tuple[str, ...]:
        # Without a profile keychain agy should fall back to its file store, not a desktop keyring.
        return () if self.keychain.exists() else ("DBUS_SESSION_BUS_ADDRESS",)

    def security(self, *args: str) -> None:
        if subprocess.call(["security", *args], env=self.build_env()):
            raise Fail(f"`security {args[0]}` failed for this profile")

    def create(self, flags: set[str]) -> None:
        use_keychain = "--no-keychain" not in flags
        if use_keychain and platform.system() != "Darwin":
            raise Fail("agy profiles need the macOS keychain; on other systems try --no-keychain (experimental, untested)")
        (self.home / ".config").mkdir(parents=True)
        if use_keychain:
            self.keychain.parent.mkdir(parents=True)
            kc = str(self.keychain)
            self.security("create-keychain", "-p", "", kc)
            self.security("set-keychain-settings", kc)  # never auto-lock
            self.security("unlock-keychain", "-p", "", kc)
            self.security("default-keychain", "-s", kc)
            self.security("list-keychains", "-s", kc)
        # Read-only things other tools expect under HOME.
        for rel in (".ssh", ".config/gh"):
            source = REAL_HOME / rel
            if source.exists():
                try:
                    (self.home / rel).symlink_to(source)
                except OSError:
                    pass

    def prepare(self) -> None:
        if self.keychain.exists():
            result = self.call_quiet(["security", "unlock-keychain", "-p", "", str(self.keychain)])
            if result.returncode:
                raise Fail("cannot unlock the keychain of this profile")

    def call_quiet(self, argv: list[str]):
        return subprocess.run(argv, env=self.build_env(), capture_output=True, text=True, stdin=subprocess.DEVNULL)

    def login_argv(self, extra: list[str]) -> list[str]:
        print(f"Sign in as the Google account for '{self.name}' (choose it in the browser; a private window helps).")
        return [find_bin(self.cli)]

    def login_cwd(self) -> Path:
        return self.home

    def status(self) -> tuple[bool, str]:
        ok = self.call([find_bin(self.cli), "models"], capture=True).returncode == 0
        return ok, f"{self.name}: {'signed in' if ok else 'not signed in'}"


class Claude(Profile):
    cli = "claude"
    login_args = ("auth", "login", "--claudeai")

    def env(self) -> dict[str, str]:
        return {"CLAUDE_CONFIG_DIR": str(self.dir)}

    def dropped_env(self) -> tuple[str, ...]:
        # These outrank a saved login, so they would hide the profile's account.
        return ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY")

    def forget(self) -> None:
        self.call([find_bin(self.cli), "auth", "logout"], capture=True)

    def status(self) -> tuple[bool, str]:
        out = self.call([find_bin(self.cli), "auth", "status", "--json"], capture=True).stdout
        info = json.loads(out[out.index("{"):]) if "{" in out else {}
        ok = bool(info.get("loggedIn"))
        detail = ", ".join(str(info[k]) for k in ("authMethod", "subscriptionType") if info.get(k))
        return ok, f"{self.name}: {'signed in' if ok else 'not signed in'} ({detail})"


class Codex(Profile):
    cli = "codex"
    login_args = ("login",)

    def env(self) -> dict[str, str]:
        return {"CODEX_HOME": str(self.dir)}

    def create(self, flags: set[str]) -> None:
        super().create(flags)
        self.prepare()

    def prepare(self) -> None:
        # Codex may default to the OS keyring, which is not per CODEX_HOME. A file keeps the login in the profile.
        config = self.dir / "config.toml"
        line = f'{CODEX_STORE_KEY} = "file"\n'
        text = config.read_text() if config.exists() else ""
        if not re.search(rf"^\s*{CODEX_STORE_KEY}\s*=", text, re.M):
            config.write_text(line + text)  # top-level keys must come before any [table]

    def status(self) -> tuple[bool, str]:
        out = self.call([find_bin(self.cli), "login", "status"], capture=True)
        first = ((out.stdout + out.stderr).strip().splitlines() or ["no answer"])[0]
        return first.startswith("Logged in"), f"{self.name}: {first}"


class Opencode(Profile):
    cli = "opencode"
    login_args = ("auth", "login")

    def env(self) -> dict[str, str]:
        return {
            "XDG_DATA_HOME": str(self.dir / "data"),
            "XDG_CONFIG_HOME": str(self.dir / "config"),
            "XDG_CACHE_HOME": str(self.dir / "cache"),
            "XDG_STATE_HOME": str(self.dir / "state"),
        }

    def create(self, flags: set[str]) -> None:
        for sub in ("data", "config", "cache", "state"):
            (self.dir / sub).mkdir(parents=True)

    def next_step(self) -> str:
        return f"free models need no login: {Path(sys.argv[0]).name} opencode run {self.name} run -m opencode/<model>-free \"...\""

    def status(self) -> tuple[bool, str]:
        out = self.call([find_bin(self.cli), "auth", "list"], capture=True)
        match = re.search(r"(\d+) credentials?", ANSI_RE.sub("", out.stdout + out.stderr))
        return True, f"{self.name}: {match.group(1) if match else 0} stored credential(s); free models need none"


PROFILE_CLASSES = {"agy": Agy, "claude": Claude, "codex": Codex, "opencode": Opencode}


def existing(cli: str, name: str) -> Profile:
    profile = PROFILE_CLASSES[cli](name)
    if not profile.exists():
        raise Fail(f"no such {cli} profile: {name}")
    return profile


def split_flags(args: list[str]) -> tuple[list[str], set[str]]:
    return [a for a in args if not a.startswith("-")], {a for a in args if a.startswith("-")}


def cmd_new(cli: str, args: list[str]) -> int:
    names, flags = split_flags(args)
    profile = PROFILE_CLASSES[cli](names[0] if names else "")
    if profile.exists():
        raise Fail(f"{cli} profile '{profile.name}' already exists")
    profile.create(flags)
    print(f"created {cli} profile '{profile.name}' at {profile.dir}")
    print(profile.next_step())
    return 0


def cmd_login(cli: str, args: list[str]) -> int:
    profile = existing(cli, args[0] if args else "")
    profile.prepare()
    return profile.call(profile.login_argv(args[1:]), cwd=profile.login_cwd())


def cmd_run(cli: str, args: list[str]) -> int:
    profile = existing(cli, args[0] if args else "")
    profile.prepare()
    return profile.call([find_bin(cli), *args[1:]])


def cmd_status(cli: str, args: list[str]) -> int:
    profile = existing(cli, args[0] if args else "")
    profile.prepare()
    ok, text = profile.status()
    print(text)
    return 0 if ok else 1


def cmd_list(clis: tuple[str, ...]) -> int:
    for cli in clis:
        root = profiles_root(cli)
        if root.is_dir():
            for entry in sorted(root.iterdir()):
                if entry.is_dir():
                    print(cli, entry.name)
    return 0


def cmd_rm(cli: str, args: list[str]) -> int:
    names, flags = split_flags(args)
    profile = existing(cli, names[0] if names else "")
    if not flags & {"-y", "--yes"}:
        if input(f"delete {cli} profile '{profile.name}' and its login? [y/N] ").strip().lower() != "y":
            return 0
    profile.forget()
    shutil.rmtree(profile.dir)
    return 0


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(__doc__)
        return 2
    if argv[0] == "list":
        return cmd_list(CLIS)
    cli, sub, args = argv[0], (argv[1] if len(argv) > 1 else ""), argv[2:]
    if cli not in CLIS:
        raise Fail(f"unknown CLI '{cli}' (use one of: {', '.join(CLIS)})")
    if sub == "list":
        return cmd_list((cli,))
    commands = {"new": cmd_new, "login": cmd_login, "run": cmd_run, "status": cmd_status, "rm": cmd_rm}
    if sub not in commands:
        print(__doc__)
        return 2
    return commands[sub](cli, args)


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Fail as error:
        print(f"ai-profile: {error}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
