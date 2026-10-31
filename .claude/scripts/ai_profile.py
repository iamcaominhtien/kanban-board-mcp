#!/usr/bin/env python3
"""Run several accounts of the same AI CLI side by side, each in its own profile.

    ai_profile.py <cli> new <name>
    ai_profile.py <cli> login <name> [login args]
    ai_profile.py <cli> run <name> [cli args]      run the CLI as that account
    ai_profile.py <cli> status <name>
    ai_profile.py <cli> list
    ai_profile.py <cli> rm <name> [-y]
    ai_profile.py list                             profiles of every CLI

<cli> is agy, claude, codex or opencode. How a profile keeps its login apart:

    agy       its own HOME (the login ends up as a file inside it)
    claude    its own CLAUDE_CONFIG_DIR
    codex     its own CODEX_HOME, with credentials forced into a file
    opencode  its own XDG_*_HOME dirs (the free models need no login)

Environment: <CLI>_PROFILES_HOME (default ~/.<cli>-profiles), <CLI>_BIN (default: the CLI on PATH).
Standard library only. More in ai_profile.md.

This file is only the command line. The profiles themselves (what each CLI needs to keep its login apart) are in
server/services/ai/profiles.py, which the Kanban Board server uses for its AI accounts too.
"""
from __future__ import annotations

import importlib.util
import shutil
import sys
from pathlib import Path

# The shared module is loaded by path so this script runs from any folder, with no install.
_SHARED = Path(__file__).resolve().parents[2] / "server" / "services" / "ai" / "profiles.py"
_spec = importlib.util.spec_from_file_location("ai_profiles_shared", _SHARED)
profiles = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = profiles  # dataclasses look the module up by name
_spec.loader.exec_module(profiles)

CLIS = profiles.CLIS
Fail = profiles.Fail
PROFILE_CLASSES = profiles.PROFILE_CLASSES
profiles_root = profiles.profiles_root
find_bin = profiles.find_bin
SCRIPT = Path(sys.argv[0]).name


def existing(cli: str, name: str) -> profiles.Profile:
    """The profile called name, or a Fail if `new` was never run for it."""
    profile = PROFILE_CLASSES[cli](name)
    if not profile.exists():
        raise Fail(f"no such {cli} profile: {name}")
    return profile


def split_flags(args: list[str]) -> tuple[list[str], set[str]]:
    """Split a command's arguments into plain words (the name) and --options. Only for commands that own their flags."""
    return [a for a in args if not a.startswith("-")], {a for a in args if a.startswith("-")}


def cmd_new(cli: str, args: list[str]) -> int:
    """new <name>: create the profile and say what to do next."""
    names, flags = split_flags(args)
    if flags:
        raise Fail(f"unknown option: {', '.join(sorted(flags))}")
    profile = PROFILE_CLASSES[cli](names[0] if names else "")
    if profile.exists():
        raise Fail(f"{cli} profile '{profile.name}' already exists")
    profile.create(flags)
    print(f"created {cli} profile '{profile.name}' at {profile.dir}")
    print(profile.next_step(SCRIPT))
    return 0


def cmd_login(cli: str, args: list[str]) -> int:
    """login <name> [args]: sign in. Whatever follows the name goes to the CLI's own login."""
    profile = existing(cli, args[0] if args else "")
    profile.prepare()
    hint = profile.login_hint()
    if hint:
        print(hint)
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
    profile.remove()
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
