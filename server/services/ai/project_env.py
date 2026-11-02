"""The environment a project's commands run in (design/screens/ai-repo-commands.md, D3).

An app opened from the Dock or Finder starts with a short PATH (``/usr/bin:/bin:/usr/sbin:/sbin``): it does not see
Homebrew, nvm, Volta or ``~/.local/bin``, so ``npm`` or ``uv`` are "not found" although the person has them. A
project keeps a list of extra folders (``ops.env_path``) that go in front of the PATH for everything the project
runs: the wizard's trial, a ticket's prepare command, the workflow checks and the AI members' own runs. Other projects
and the app itself keep their own PATH.
"""

import os
import re
import shutil
from pathlib import Path

from . import ops

# Where command-line tools are usually installed, beyond what a short PATH has. Globs are expanded newest first
# (nvm keeps one folder per Node version).
_TOOL_DIRS = (
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "~/.local/bin",
    "~/.cargo/bin",
    "~/.volta/bin",
    "~/.bun/bin",
    "~/.deno/bin",
    "~/.npm-global/bin",
    "~/.yarn/bin",
    "~/.pyenv/shims",
    "~/.rbenv/shims",
    "~/.asdf/shims",
    "~/.local/share/mise/shims",
    "~/.local/share/pnpm",
    "~/Library/pnpm",
    "~/go/bin",
    "/usr/local/go/bin",
    "~/.nvm/versions/node/*/bin",
    "~/.local/share/fnm/node-versions/*/installation/bin",
)

# Words a shell line starts a segment with that are not a program to look for
_NOT_PROGRAMS = {
    "cd",
    "export",
    "set",
    "true",
    "false",
    "exit",
    "test",
    "[",
    "if",
    "then",
    "else",
    "fi",
    "for",
    "do",
    "done",
    "while",
    "echo",
    "env",
    "time",
    "nice",
    "sudo",
    "source",
    ".",
}


def extra(settings) -> list[str]:
    """The project's extra PATH folders (``ops.env_path``), cleaned: strings, no empties, no repeats."""
    raw = ops.get(settings).get("env_path") or []
    if not isinstance(raw, list):
        return []
    return list(dict.fromkeys(str(p).strip() for p in raw if str(p or "").strip()))


def with_path(base: dict | None, folders: list[str] | None) -> dict:
    """A copy of ``base`` (default: this process's environment) with ``folders`` in front of its PATH."""
    env = dict(os.environ if base is None else base)
    if not folders:
        return env
    front = [os.path.expanduser(f) for f in folders]
    rest = [p for p in (env.get("PATH") or "").split(os.pathsep) if p]
    env["PATH"] = os.pathsep.join(dict.fromkeys(front + rest))
    return env


def programs(command: str) -> list[str]:
    """The programs a shell line runs: the first word of each segment (``npm --prefix ui ci && uv sync`` → npm,
    uv). Variable assignments (``PATH=… npm``) and plain shell words are skipped."""
    out: list[str] = []
    for seg in re.split(r"&&|\|\||[;|&\n()]", command or ""):
        words = seg.strip().split()
        while words and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[0]):
            words = words[1:]
        if not words:
            continue
        word = words[0].strip("'\"")
        if word in _NOT_PROGRAMS or not word:
            continue
        if "/" in word:  # a path: ./gradlew, bin/test — nothing to look for
            continue
        out.append(word)
    return list(dict.fromkeys(out))


def _candidates() -> list[Path]:
    dirs: list[Path] = []
    for pattern in _TOOL_DIRS:
        path = os.path.expanduser(pattern)
        if "*" in path:
            base, _, tail = path.partition("*")
            parent = Path(base)
            if parent.is_dir():
                found = sorted(parent.glob("*" + tail), key=_version_key, reverse=True)
                dirs += [p for p in found if p.is_dir()]
        elif Path(path).is_dir():
            dirs.append(Path(path))
    return dirs


def _version_key(p: Path) -> tuple:
    nums = re.findall(r"\d+", p.as_posix().rsplit("versions", 1)[-1])
    return tuple(int(n) for n in nums[:3])


def find(program: str, path: str) -> str | None:
    """The folder that holds ``program`` when it is not on ``path``; None when it is on it, or nowhere to be found."""
    if shutil.which(program, path=path):
        return None
    for folder in _candidates():
        cand = folder / program
        if cand.is_file() and os.access(cand, os.X_OK):
            return str(folder)
    return None


def missing_folders(commands: list[str], path: str) -> list[dict]:
    """For each program the commands run that ``path`` does not have, the folder where it is:
    [{"path": "/opt/homebrew/bin", "program": "npm"}]. A program found nowhere is left out (the trial then says
    "command not found", which is the truth)."""
    out: dict[str, dict] = {}
    for cmd in commands:
        for prog in programs(cmd):
            folder = find(prog, path)
            if folder and folder not in out:
                out[folder] = {"path": folder, "program": prog}
    return list(out.values())
