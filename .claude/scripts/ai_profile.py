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
Standard library only. More in ai_profile.md.

How it works: a profile is a directory. Running a CLI "as" a profile means starting it with an environment that
points its config and login at that directory, so two profiles never share a login and can run at the same time.
Each CLI is a Profile subclass that says which variables to set (env), which to remove (dropped_env), how to
sign in (login_argv) and how to tell whether it is signed in (status). To support another CLI, add a subclass,
register it in PROFILE_CLASSES and CLIS, and use the same method names.
"""
from __future__ import annotations

import json
import os
import platform
import re
import shutil
import subprocess
import sys
from abc import ABC, abstractmethod
from pathlib import Path

# The user's real home. Profiles must not change it: the agy profile swaps HOME, and some tools still need the real one.
REAL_HOME = Path.home()
CLIS = ("agy", "claude", "codex", "opencode")
# Profile names become directory names and command arguments: no slashes, no leading dot or dash.
NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]*$")
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")  # colour codes in a CLI's output
CODEX_STORE_KEY = "cli_auth_credentials_store"  # Codex setting: where to keep the login (file, keyring, auto)


class Fail(Exception):
    """A user-facing error: printed as one line, without a traceback, and exits with code 1."""


def profiles_root(cli: str) -> Path:
    """Folder that holds every profile of one CLI. Override with <CLI>_PROFILES_HOME."""
    return Path(os.environ.get(f"{cli.upper()}_PROFILES_HOME") or REAL_HOME / f".{cli}-profiles")


def find_bin(cli: str) -> str:
    """Path of the CLI to run: <CLI>_BIN if set, else the first match on PATH."""
    found = os.environ.get(f"{cli.upper()}_BIN") or shutil.which(cli)
    if not found:
        raise Fail(f"{cli} not found on PATH (set {cli.upper()}_BIN)")
    return found


class Profile(ABC):
    """One account of one CLI. Subclasses say how its login is kept apart from the others.

    The base class is the plumbing every CLI shares (naming, building the environment, running the CLI). A subclass
    overrides only what differs; the "hooks" below say when each one is called. Only status() is abstract: a subclass
    that forgets it cannot be created. A subclass must also set `cli` (nothing checks that).
    """

    cli = ""  # the command name, also used for <CLI>_BIN and <CLI>_PROFILES_HOME
    login_args: tuple[str, ...] = ()  # the arguments that start a sign-in, after the command itself

    def __init__(self, name: str):
        if not NAME_RE.match(name or ""):
            raise Fail(f"bad profile name: {name!r}" if name else "missing profile name")
        self.name = name
        self.dir = profiles_root(self.cli) / name

    # --- environment -----------------------------------------------------------------------------------------

    def env(self) -> dict[str, str]:
        """Variables to set so the CLI keeps its config and login inside this profile."""
        return {}

    def dropped_env(self) -> tuple[str, ...]:
        """Variables to remove from the caller's environment because they would override the profile's login."""
        return ()

    def build_env(self) -> dict[str, str]:
        """The caller's environment, minus dropped_env(), plus env(). Everything else (PATH, proxies) is kept."""
        env = {k: v for k, v in os.environ.items() if k not in self.dropped_env()}
        env.update(self.env())
        return env

    def call(self, argv: list[str], *, capture: bool = False, cwd: Path | None = None):
        """Run a command in the profile's environment.

        Without capture it shares the terminal (interactive use) and returns the exit code. With capture it
        returns a CompletedProcess with text output and no stdin, so a prompt cannot hang a status check.
        """
        kwargs = dict(env=self.build_env(), cwd=cwd)
        if capture:
            return subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, **kwargs)
        return subprocess.call(argv, **kwargs)

    # --- lifecycle hooks -------------------------------------------------------------------------------------

    def exists(self) -> bool:
        """Whether `new` has been run for this name."""
        return self.dir.is_dir()

    def create(self, flags: set[str]) -> None:
        """`new`: make the profile directory (and anything else the CLI needs there). flags are the --options given."""
        self.dir.mkdir(parents=True)

    def prepare(self) -> None:
        """Called before login, run and status. For things that must be true each time, such as unlocking a keychain."""

    def forget(self) -> None:
        """Called before rm, for a login kept outside the profile directory that deleting the folder would not remove."""

    def login_argv(self, extra: list[str]) -> list[str]:
        """The command that signs in. extra are the arguments the user put after the profile name."""
        return [find_bin(self.cli), *self.login_args, *extra]

    def login_cwd(self) -> Path | None:
        """Folder to start the sign-in in, or None for the current one."""
        return None

    @abstractmethod
    def status(self) -> tuple[bool, str]:
        """(signed in, one line to print). The exit code of `status` follows the first value."""

    def next_step(self) -> str:
        """What `new` tells the user to do next."""
        return f"next: {Path(sys.argv[0]).name} {self.cli} login {self.name}"


class Agy(Profile):
    """Antigravity CLI. It keeps its Google login in the OS keychain: one entry per user, service `gemini`,
    account `antigravity`. Two profiles sharing a keychain would overwrite each other, so a profile gets its own HOME
    (agy keeps its data in ~/.gemini) and, on macOS, its own login keychain inside that HOME. The `security` tool
    looks for the keychain under $HOME, so with the swapped HOME it finds the profile's keychain and never the real one.
    """

    cli = "agy"

    @property
    def home(self) -> Path:
        """The HOME agy sees. It is the only thing in the profile directory."""
        return self.dir / "home"

    @property
    def keychain(self) -> Path:
        """Where `security` looks for the default login keychain under the swapped HOME."""
        return self.home / "Library" / "Keychains" / "login.keychain-db"

    def env(self) -> dict[str, str]:
        env = {
            "HOME": str(self.home),
            # git is configured under HOME too; point it back at the real file or commits lose the user's identity.
            "GIT_CONFIG_GLOBAL": str(REAL_HOME / ".gitconfig"),
            # An update would try to install into the profile's HOME instead of the real one.
            "AGY_CLI_DISABLE_AUTO_UPDATE": "1",
        }
        if os.name == "nt":
            env["USERPROFILE"] = str(self.home)  # Windows' home is not HOME (untested)
        return env

    def dropped_env(self) -> tuple[str, ...]:
        # Without a profile keychain agy should fall back to its own file store, not look for a desktop keyring
        # over D-Bus (Linux). Experimental: see `new --no-keychain`.
        return () if self.keychain.exists() else ("DBUS_SESSION_BUS_ADDRESS",)

    def security(self, *args: str) -> None:
        """Run macOS `security` against the profile's keychain; raise if it fails."""
        if subprocess.call(["security", *args], env=self.build_env()):
            raise Fail(f"`security {args[0]}` failed for this profile")

    def create(self, flags: set[str]) -> None:
        """Make the HOME and, unless --no-keychain, a keychain with an empty password that never auto-locks."""
        use_keychain = "--no-keychain" not in flags
        if use_keychain and platform.system() != "Darwin":
            raise Fail("agy profiles need the macOS keychain; on other systems try --no-keychain (experimental, untested)")
        (self.home / ".config").mkdir(parents=True)
        if use_keychain:
            self.keychain.parent.mkdir(parents=True)
            kc = str(self.keychain)
            self.security("create-keychain", "-p", "", kc)
            self.security("set-keychain-settings", kc)  # no arguments = never auto-lock
            self.security("unlock-keychain", "-p", "", kc)
            self.security("default-keychain", "-s", kc)  # recorded under the profile's HOME, not the real one
            self.security("list-keychains", "-s", kc)
        # Tools agy starts (git over ssh, gh) read these under HOME. Link to the real ones, read-only in practice.
        for rel in (".ssh", ".config/gh"):
            source = REAL_HOME / rel
            if source.exists():
                try:
                    (self.home / rel).symlink_to(source)
                except OSError:
                    pass  # e.g. Windows without the right to make symlinks: the tool just will not see it

    def prepare(self) -> None:
        """Unlock the profile's keychain: it is locked again after a restart or a long idle period."""
        if self.keychain.exists():
            result = self.call_quiet(["security", "unlock-keychain", "-p", "", str(self.keychain)])
            if result.returncode:
                raise Fail("cannot unlock the keychain of this profile")

    def call_quiet(self, argv: list[str]):
        """Run a command in the profile's environment and keep its output."""
        return subprocess.run(argv, env=self.build_env(), capture_output=True, text=True, stdin=subprocess.DEVNULL)

    def login_argv(self, extra: list[str]) -> list[str]:
        """agy has no login subcommand: starting it without a login opens the sign-in itself."""
        print(f"Sign in as the Google account for '{self.name}' (choose it in the browser; a private window helps).")
        return [find_bin(self.cli)]

    def login_cwd(self) -> Path:
        """Start in the profile's HOME: signing in needs no project folder."""
        return self.home

    def status(self) -> tuple[bool, str]:
        """`agy models` needs a login and exits non-zero without one; it lists models and does not run one."""
        ok = self.call([find_bin(self.cli), "models"], capture=True).returncode == 0
        return ok, f"{self.name}: {'signed in' if ok else 'not signed in'}"


class Claude(Profile):
    """Claude Code. CLAUDE_CONFIG_DIR is the documented way to keep several logins: it holds the settings, the
    session history and the login (on macOS the keychain entry name includes a hash of that directory)."""

    cli = "claude"
    login_args = ("auth", "login", "--claudeai")  # the Claude subscription; Console logins are stored outside the dir

    def env(self) -> dict[str, str]:
        return {"CLAUDE_CONFIG_DIR": str(self.dir)}

    def dropped_env(self) -> tuple[str, ...]:
        # Per Claude Code's docs these outrank a saved login, so one set in the caller's shell would make every
        # profile use that credential instead of its own account.
        return ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY")

    def forget(self) -> None:
        """On macOS the login is a keychain entry outside the profile directory; log out so it is removed."""
        self.call([find_bin(self.cli), "auth", "logout"], capture=True)

    def status(self) -> tuple[bool, str]:
        """Parse `auth status --json`. Warnings may come before the JSON, so start at the first brace."""
        out = self.call([find_bin(self.cli), "auth", "status", "--json"], capture=True).stdout
        info = json.loads(out[out.index("{"):]) if "{" in out else {}
        ok = bool(info.get("loggedIn"))
        detail = ", ".join(str(info[k]) for k in ("authMethod", "subscriptionType") if info.get(k))
        return ok, f"{self.name}: {'signed in' if ok else 'not signed in'} ({detail})"


class Codex(Profile):
    """Codex CLI. CODEX_HOME holds its state and, by default, the login as auth.json."""

    cli = "codex"
    login_args = ("login",)

    def env(self) -> dict[str, str]:
        return {"CODEX_HOME": str(self.dir)}

    def create(self, flags: set[str]) -> None:
        super().create(flags)
        self.prepare()

    def prepare(self) -> None:
        """Make sure the profile's config.toml keeps the login in a file.

        Codex can store the login in the OS keyring (setting cli_auth_credentials_store: file, keyring or auto), and
        its docs do not say a keyring entry is per CODEX_HOME. Forcing "file" keeps the login inside the profile on
        every system. Idempotent; an existing value of the setting is left alone.
        """
        config = self.dir / "config.toml"
        text = config.read_text() if config.exists() else ""
        if not re.search(rf"^\s*{CODEX_STORE_KEY}\s*=", text, re.M):
            config.write_text(f'{CODEX_STORE_KEY} = "file"\n' + text)  # top-level keys must come before any [table]

    def status(self) -> tuple[bool, str]:
        """The first line of `login status` is "Logged in using ..." or "Not logged in"."""
        out = self.call([find_bin(self.cli), "login", "status"], capture=True)
        first = ((out.stdout + out.stderr).strip().splitlines() or ["no answer"])[0]
        return first.startswith("Logged in"), f"{self.name}: {first}"


class Opencode(Profile):
    """opencode. It follows the XDG directories: login in $XDG_DATA_HOME/opencode/auth.json, config under
    $XDG_CONFIG_HOME. Its free models (opencode/*-free) work with no login, so a profile may have no credentials."""

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
        """Always "ok": without credentials the free models still work. Reports how many are stored."""
        out = self.call([find_bin(self.cli), "auth", "list"], capture=True)
        match = re.search(r"(\d+) credentials?", ANSI_RE.sub("", out.stdout + out.stderr))
        return True, f"{self.name}: {match.group(1) if match else 0} stored credential(s); free models need none"


PROFILE_CLASSES = {"agy": Agy, "claude": Claude, "codex": Codex, "opencode": Opencode}


def existing(cli: str, name: str) -> Profile:
    """The profile called name, or a Fail if `new` was never run for it."""
    profile = PROFILE_CLASSES[cli](name)
    if not profile.exists():
        raise Fail(f"no such {cli} profile: {name}")
    return profile


def split_flags(args: list[str]) -> tuple[list[str], set[str]]:
    """Split a command's arguments into plain words (the name) and --options. Only for commands that own their flags."""
    return [a for a in args if not a.startswith("-")], {a for a in args if a.startswith("-")}


def cmd_new(cli: str, args: list[str]) -> int:
    """new <name> [--no-keychain]: create the profile and say what to do next."""
    names, flags = split_flags(args)
    profile = PROFILE_CLASSES[cli](names[0] if names else "")
    if profile.exists():
        raise Fail(f"{cli} profile '{profile.name}' already exists")
    profile.create(flags)
    print(f"created {cli} profile '{profile.name}' at {profile.dir}")
    print(profile.next_step())
    return 0


def cmd_login(cli: str, args: list[str]) -> int:
    """login <name> [args]: sign in. Whatever follows the name goes to the CLI's own login."""
    profile = existing(cli, args[0] if args else "")
    profile.prepare()
    return profile.call(profile.login_argv(args[1:]), cwd=profile.login_cwd())


def cmd_run(cli: str, args: list[str]) -> int:
    """run <name> [args]: start the CLI as that account. Everything after the name is passed on untouched,
    including flags such as -p, and the caller's working directory is kept so the agent works in its project."""
    profile = existing(cli, args[0] if args else "")
    profile.prepare()
    return profile.call([find_bin(cli), *args[1:]])


def cmd_status(cli: str, args: list[str]) -> int:
    """status <name>: print whether the profile is signed in. Exit code 0 if yes, 1 if not."""
    profile = existing(cli, args[0] if args else "")
    profile.prepare()
    ok, text = profile.status()
    print(text)
    return 0 if ok else 1


def cmd_list(clis: tuple[str, ...]) -> int:
    """list: one line per profile, "<cli> <name>"."""
    for cli in clis:
        root = profiles_root(cli)
        if root.is_dir():
            for entry in sorted(root.iterdir()):
                if entry.is_dir():
                    print(cli, entry.name)
    return 0


def cmd_rm(cli: str, args: list[str]) -> int:
    """rm <name> [-y]: delete the profile and its login after a confirmation (-y skips it)."""
    names, flags = split_flags(args)
    profile = existing(cli, names[0] if names else "")
    if not flags & {"-y", "--yes"}:
        if input(f"delete {cli} profile '{profile.name}' and its login? [y/N] ").strip().lower() != "y":
            return 0
    profile.forget()
    shutil.rmtree(profile.dir)
    return 0


def main(argv: list[str]) -> int:
    """Parse "<cli> <command> [args]" by hand: argparse would try to read flags meant for the CLI (such as -p)."""
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
