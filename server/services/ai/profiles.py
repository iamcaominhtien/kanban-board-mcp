"""Separate logins of the same AI CLI, so two of them can run at the same time (AI accounts).

Standard library only: the developer script ``.claude/scripts/ai_profile.py`` loads this file by path and the server
imports it, so the logic lives in one place.

How it works: a profile is a directory. Running a CLI "as" a profile means starting it with an environment that
points its config and login at that directory, so two profiles never share a login. Each CLI is a ``Profile``
subclass that says which variables to set (``env``), which to remove (``dropped_env``), how to sign in
(``login_argv``) and how to tell whether it is signed in (``check``). To support another CLI add a subclass and
register it in ``PROFILE_CLASSES`` and ``CLIS``. Per-CLI details are in ``.claude/scripts/ai_profile.md``.

The login itself is kept by the CLI: in the profile's folder (``agy``, ``codex``, ``opencode``) or, for ``claude``
on macOS, in the login keychain under an entry named from the folder. This module never reads a token.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

# The user's real home. Profiles must not change it: the agy profile swaps HOME, and some tools still need the real one.
REAL_HOME = Path.home()
CLIS = ("agy", "claude", "codex", "opencode")
# Profile names become directory names and command arguments: no slashes, no leading dot or dash.
NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]*$")
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")  # colour codes in a CLI's output
CODEX_STORE_KEY = "cli_auth_credentials_store"  # Codex setting: where to keep the login (file, keyring, auto)


class Fail(Exception):
    """A user-facing error: one line, no traceback."""


@dataclass
class Status:
    """What a CLI says about a profile's login. Only ``claude`` says who; the others say whether a call works."""

    signed_in: bool
    detail: str = ""  # one line, as the CLI words it
    email: str | None = None
    plan: str | None = None
    method: str | None = (
        None  # subscription | api key | ChatGPT login | Google sign-in ...
    )


def profiles_root(cli: str) -> Path:
    """Folder that holds every profile of one CLI for the developer script. Override with <CLI>_PROFILES_HOME."""
    return Path(
        os.environ.get(f"{cli.upper()}_PROFILES_HOME") or REAL_HOME / f".{cli}-profiles"
    )


def find_bin(cli: str) -> str:
    """Path of the CLI to run: <CLI>_BIN if set, else the first match on PATH."""
    found = os.environ.get(f"{cli.upper()}_BIN") or shutil.which(cli)
    if not found:
        raise Fail(f"{cli} not found on PATH (set {cli.upper()}_BIN)")
    return found


class Profile(ABC):
    """One account of one CLI. Subclasses say how its login is kept apart from the others.

    The base class is the plumbing every CLI shares (naming, building the environment, running the CLI). A subclass
    overrides only what differs; the "hooks" below say when each one is called. Only ``check()`` is abstract: a
    subclass that forgets it cannot be created. A subclass must also set ``cli`` (nothing checks that).
    """

    cli = ""  # the command name, also used for <CLI>_BIN and <CLI>_PROFILES_HOME
    login_args: tuple[
        str, ...
    ] = ()  # the arguments that start a sign-in, after the command itself

    def __init__(
        self, name: str, folder: Path | str | None = None, binary: str | None = None
    ):
        """Args:
        name: Directory-safe name.
        folder: The profile's directory. Default: ``<profiles_root(cli)>/<name>`` (the developer script).
        binary: Path of the CLI. Default: ``find_bin``.
        """
        if not NAME_RE.match(name or ""):
            raise Fail(
                f"bad profile name: {name!r}" if name else "missing profile name"
            )
        self.name = name
        self.dir = Path(folder) if folder else profiles_root(self.cli) / name
        self.binary = binary

    def bin(self) -> str:
        """The CLI to run."""
        return self.binary or find_bin(self.cli)

    # --- environment -----------------------------------------------------------------------------------------

    def env(self) -> dict[str, str]:
        """Variables to set so the CLI keeps its config and login inside this profile."""
        return {}

    def dropped_env(self) -> tuple[str, ...]:
        """Variables to remove from the caller's environment because they would override the profile's login."""
        return ()

    def overlay(self, base: Mapping[str, str]) -> dict[str, str]:
        """``base`` minus dropped_env(), plus env(). Everything else (PATH, proxies) is kept."""
        dropped = self.dropped_env()
        env = {k: v for k, v in base.items() if k not in dropped}
        env.update(self.env())
        return env

    def build_env(self) -> dict[str, str]:
        """The caller's own environment with the profile applied."""
        return self.overlay(os.environ)

    def call(self, argv: list[str], *, capture: bool = False, cwd: Path | None = None):
        """Run a command in the profile's environment.

        Without capture it shares the terminal (interactive use) and returns the exit code. With capture it
        returns a CompletedProcess with text output and no stdin, so a prompt cannot hang a status check.
        """
        kwargs = dict(env=self.build_env(), cwd=cwd)
        if capture:
            return subprocess.run(
                argv,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                timeout=45,
                **kwargs,
            )
        return subprocess.call(argv, **kwargs)

    # --- lifecycle hooks -------------------------------------------------------------------------------------

    def exists(self) -> bool:
        """Whether ``create`` has been run for this profile."""
        return self.dir.is_dir()

    def create(self, flags: set[str]) -> None:
        """Make the profile directory (and anything else the CLI needs there). flags: options given to `new`."""
        self.dir.mkdir(parents=True)

    def prepare(self) -> None:
        """Called before login, run and status. For things that must be true each time, such as unlocking a keychain."""

    def forget(self) -> None:
        """Called before removal, for a login kept outside the profile directory that deleting the folder would not remove."""

    def login_argv(self, extra: list[str]) -> list[str]:
        """The command that signs in. extra are further arguments for the CLI's own login."""
        return [self.bin(), *self.login_args, *extra]

    def login_cwd(self) -> Path | None:
        """Folder to start the sign-in in, or None for the current one."""
        return None

    def login_hint(self) -> str | None:
        """A line for the developer script to print before the sign-in, or None."""
        return None

    @abstractmethod
    def check(self) -> Status:
        """Ask the CLI whether this profile is signed in. Never reads the token."""

    def status(self) -> tuple[bool, str]:
        """(signed in, one line to print); the developer script's exit code follows the first value."""
        st = self.check()
        return st.signed_in, f"{self.name}: {st.detail}"

    def next_step(self, script: str = "ai_profile.py") -> str:
        """What `new` tells the user to do next."""
        return f"next: {script} {self.cli} login {self.name}"

    def credential_files(self) -> list[Path]:
        """Files inside the folder that hold the login (deleted by ``sign_out``); empty when the CLI uses a keychain."""
        return []

    def sign_out(self) -> None:
        """Make the CLI forget the login but keep the profile: ask the CLI to log out where it can, delete the file
        that holds the login where it cannot."""
        self.forget()
        for path in self.credential_files():
            path.unlink(missing_ok=True)

    def remove(self) -> None:
        """Sign out of a login kept outside the folder, then delete the folder."""
        self.forget()
        shutil.rmtree(self.dir, ignore_errors=True)


class Agy(Profile):
    """Antigravity CLI. It keeps its data in ~/.gemini and tries to keep its Google login in the OS keychain (on macOS
    one entry per user: service `gemini`, account `antigravity`). Two profiles sharing that entry would overwrite each
    other, so a profile gets its own HOME. Under a swapped HOME the macOS `security` tool finds no keychain, and agy
    falls back to keeping the login in a file inside the profile (.gemini/antigravity-cli/antigravity-oauth-token,
    mode 0600). That fallback was seen on macOS only.

    Profiles made by an earlier version have their own keychain inside the HOME instead; they keep working (see prepare).
    """

    cli = "agy"

    @property
    def home(self) -> Path:
        """The HOME agy sees. It is the only thing in the profile directory."""
        return self.dir / "home"

    @property
    def keychain(self) -> Path:
        """Keychain of a profile made by an earlier version. New profiles do not have one."""
        return self.home / "Library" / "Keychains" / "login.keychain-db"

    def env(self) -> dict[str, str]:
        """HOME is swapped; git and the updater are pointed back at the real ones."""
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
        """No desktop keyring lookup unless the profile has a keychain of its own."""
        # Without a keychain agy should use its file store, not look for a desktop keyring over D-Bus (Linux, untested).
        return () if self.keychain.exists() else ("DBUS_SESSION_BUS_ADDRESS",)

    def create(self, flags: set[str]) -> None:
        """Make the HOME and link the real .ssh and .config/gh into it."""
        if os.name == "nt":
            # The Windows credential store belongs to the Windows user, not to HOME: profiles might share one login.
            raise Fail(
                "Antigravity accounts are not available on Windows (the login may not stay in the account)"
            )
        (self.home / ".config").mkdir(parents=True)
        # Tools agy starts (git over ssh, gh) read these under HOME. Link to the real ones, read-only in practice.
        for rel in (".ssh", ".config/gh"):
            source = REAL_HOME / rel
            if source.exists():
                try:
                    (self.home / rel).symlink_to(source)
                except OSError:
                    pass  # the tool just will not see it

    def prepare(self) -> None:
        """For a profile made with a keychain: unlock it, because it is locked again after a restart or a long idle."""
        if self.keychain.exists():
            result = subprocess.run(
                ["security", "unlock-keychain", "-p", "", str(self.keychain)],
                env=self.build_env(),
                capture_output=True,
                text=True,
                stdin=subprocess.DEVNULL,
            )
            if result.returncode:
                raise Fail("cannot unlock the keychain of this profile")

    def credential_files(self) -> list[Path]:
        """The OAuth token file under the profile's HOME."""
        return [self.home / ".gemini" / "antigravity-cli" / "antigravity-oauth-token"]

    def login_argv(self, extra: list[str]) -> list[str]:
        """agy has no login subcommand: starting it without a login opens the sign-in itself."""
        return [self.bin()]

    @property
    def mcp_config(self) -> Path:
        """The MCP servers agy starts (``mcpServers``), kept in the profile's HOME."""
        return self.home / ".gemini" / "config" / "mcp_config.json"

    def ensure_mcp(self, name: str, entry: dict) -> bool:
        """Make sure the profile's MCP config has the server ``name`` exactly as ``entry`` says; other servers are
        left alone. Returns True when the file changed. agy has no per-run place for a secret, so the entry names a
        program that reads it from the environment of the run."""
        try:
            data = json.loads(self.mcp_config.read_text())
        except (OSError, ValueError):
            data = {}
        servers = data.setdefault("mcpServers", {})
        if servers.get(name) == entry:
            return False
        servers[name] = entry
        self.mcp_config.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.mcp_config.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2))
        tmp.replace(self.mcp_config)
        return True

    def login_hint(self) -> str:
        """Which Google account to choose."""
        return f"Sign in as the Google account for '{self.name}' (choose it in the browser; a private window helps)."

    def login_cwd(self) -> Path:
        """Start in the profile's HOME: signing in needs no project folder."""
        return self.home

    def check(self) -> Status:
        """`agy models` needs a login and exits non-zero without one; it lists models and does not run one."""
        ok = self.call([self.bin(), "models"], capture=True).returncode == 0
        return Status(
            ok, "signed in" if ok else "not signed in", method="Google sign-in"
        )


class Claude(Profile):
    """Claude Code. CLAUDE_CONFIG_DIR is the documented way to keep several logins: it holds the settings, the
    session history and the login (on macOS the keychain entry name includes a hash of that directory)."""

    cli = "claude"
    login_args = (
        "auth",
        "login",
        "--claudeai",
    )  # the Claude subscription; Console logins are stored outside the dir

    def env(self) -> dict[str, str]:
        """CLAUDE_CONFIG_DIR is the profile folder."""
        return {"CLAUDE_CONFIG_DIR": str(self.dir)}

    def dropped_env(self) -> tuple[str, ...]:
        """Credential variables that outrank a saved login."""
        # Per Claude Code's docs these outrank a saved login, so one set in the caller's shell would make every
        # profile use that credential instead of its own account.
        return ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY")

    def forget(self) -> None:
        """On macOS the login is a keychain entry outside the profile directory; log out so it is removed."""
        try:
            self.call([self.bin(), "auth", "logout"], capture=True)
        except (Fail, OSError, subprocess.SubprocessError):
            pass  # CLI gone: nothing more can be done for the entry

    def check(self) -> Status:
        """Parse `auth status --json`. Warnings may come before the JSON, so start at the first brace."""
        out = self.call([self.bin(), "auth", "status", "--json"], capture=True).stdout
        try:
            info = json.loads(out[out.index("{") :]) if "{" in out else {}
        except ValueError:
            info = {}
        ok = bool(info.get("loggedIn"))
        method = {"claude.ai": "subscription", "oauth_token": "subscription"}.get(
            str(info.get("authMethod")), info.get("authMethod")
        )
        plan = info.get("subscriptionType")
        detail = ", ".join(str(x) for x in (info.get("authMethod"), plan) if x)
        return Status(
            ok,
            f"{'signed in' if ok else 'not signed in'} ({detail})",
            email=info.get("email") or None,
            plan=str(plan) if plan else None,
            method=str(method) if method else None,
        )


class Codex(Profile):
    """Codex CLI. CODEX_HOME holds its state and, by default, the login as auth.json."""

    cli = "codex"
    login_args = ("login",)

    def env(self) -> dict[str, str]:
        """CODEX_HOME is the profile folder."""
        return {"CODEX_HOME": str(self.dir)}

    def create(self, flags: set[str]) -> None:
        """Make the folder and keep the login in a file."""
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
            config.write_text(
                f'{CODEX_STORE_KEY} = "file"\n' + text
            )  # top-level keys must come before any [table]

    def credential_files(self) -> list[Path]:
        """auth.json in CODEX_HOME."""
        return [self.dir / "auth.json"]

    def check(self) -> Status:
        """`login status` says "Logged in using ..." or "Not logged in". Codex may print
        warnings before that line (for example about PATH aliases when the profile is
        under /tmp), so look for the answer, not the first line."""
        out = self.call([self.bin(), "login", "status"], capture=True)
        lines = [
            line.strip()
            for line in (out.stdout + out.stderr).splitlines()
            if line.strip()
        ]
        answer = next(
            (line for line in lines if line.startswith(("Logged in", "Not logged in"))),
            None,
        )
        text = answer or (lines[0] if lines else "no answer")
        ok = bool(answer) and answer.startswith("Logged in")
        return Status(ok, text, method=text[len("Logged in using ") :] if ok else None)


class Opencode(Profile):
    """opencode. It follows the XDG directories: login in $XDG_DATA_HOME/opencode/auth.json, config under
    $XDG_CONFIG_HOME. Its free models (opencode/*-free) work with no login, so a profile may have no credentials."""

    cli = "opencode"
    login_args = ("auth", "login")

    def env(self) -> dict[str, str]:
        """The four XDG folders live inside the profile."""
        return {
            "XDG_DATA_HOME": str(self.dir / "data"),
            "XDG_CONFIG_HOME": str(self.dir / "config"),
            "XDG_CACHE_HOME": str(self.dir / "cache"),
            "XDG_STATE_HOME": str(self.dir / "state"),
        }

    def create(self, flags: set[str]) -> None:
        """Make the four XDG folders."""
        for sub in ("data", "config", "cache", "state"):
            (self.dir / sub).mkdir(parents=True)

    def credential_files(self) -> list[Path]:
        """auth.json under XDG_DATA_HOME."""
        return [self.dir / "data" / "opencode" / "auth.json"]

    def next_step(self, script: str = "ai_profile.py") -> str:
        """Free models need no login."""
        return f'free models need no login: {script} opencode run {self.name} run -m opencode/<model>-free "..."'

    def check(self) -> Status:
        """Always signed in: without credentials the free models still work. Counts the stored credentials."""
        out = self.call([self.bin(), "auth", "list"], capture=True)
        match = re.search(
            r"(\d+) credentials?", ANSI_RE.sub("", out.stdout + out.stderr)
        )
        count = int(match.group(1)) if match else 0
        return Status(
            True,
            f"{count} stored credential(s); free models need none",
            method="API key or OAuth" if count else "free models",
        )


PROFILE_CLASSES: dict[str, type[Profile]] = {
    "agy": Agy,
    "claude": Claude,
    "codex": Codex,
    "opencode": Opencode,
}


def profile_for(
    cli: str, name: str, folder: Path | str | None = None, binary: str | None = None
) -> Profile:
    """The Profile object of ``cli`` (does not create anything)."""
    if cli not in PROFILE_CLASSES:
        raise Fail(f"unknown CLI '{cli}' (use one of: {', '.join(CLIS)})")
    return PROFILE_CLASSES[cli](name, folder, binary)
