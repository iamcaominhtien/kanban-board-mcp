"""Folders and programs a person names for an AI member (its working folder, the CLI to run), checked before the
board touches them. The path is made absolute and real (symlinks resolved) and must sit inside a place people keep
their work: the home folder, another drive or volume, or a folder listed in KANBAN_AI_ROOTS. System folders such as
/etc or C:\\Windows are refused. Programs may also live in the usual install folders (/usr, /opt, Program Files)."""

import os
import string

ROOTS_ENV = "KANBAN_AI_ROOTS"


class PathRefused(ValueError):
    """A path outside the places the board may use; the message says why."""


def _prefix(path: str) -> str:
    return os.path.realpath(path).rstrip("\\/") + os.sep


def _work_roots() -> list[str]:
    roots = [os.path.expanduser("~")]
    roots += [p for p in os.environ.get(ROOTS_ENV, "").split(os.pathsep) if p.strip()]
    if os.name == "nt":
        system = (os.environ.get("SystemDrive") or "C:").upper()
        roots += [
            f"{d}:\\"
            for d in string.ascii_uppercase
            if f"{d}:" != system and os.path.isdir(f"{d}:\\")
        ]
    else:
        roots += ["/Volumes", "/mnt", "/media", "/srv"]
    return roots


def _program_roots() -> list[str]:
    roots = _work_roots()
    if os.name == "nt":
        roots += [
            v
            for k in ("ProgramFiles", "ProgramFiles(x86)", "ProgramData")
            if (v := os.environ.get(k))
        ]
    else:
        roots += ["/usr", "/opt", "/snap", "/nix", "/Applications", "/bin"]
    return roots


def folder(raw: str) -> str:
    """The real absolute path of a working folder; refuses the home folder itself and anything outside the roots."""
    path = os.path.realpath(os.path.expanduser(raw.strip()))
    if not path.startswith(tuple(_prefix(r) for r in _work_roots())):
        raise PathRefused(
            f"Choose a project folder inside your home folder (or add its parent to {ROOTS_ENV}): {raw.strip()}"
        )
    return path


def program(raw: str) -> str:
    """The real absolute path of a program to run (a CLI); refuses anything outside the roots and install folders."""
    path = os.path.realpath(os.path.expanduser(raw.strip()))
    if not path.startswith(tuple(_prefix(r) for r in _program_roots())):
        raise PathRefused(
            f"The CLI must be installed in your home folder or a usual install folder: {raw.strip()}"
        )
    return path
