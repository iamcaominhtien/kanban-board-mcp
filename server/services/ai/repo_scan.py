"""Giving a new project a team: the repository scan (design/screens/ai-team-process.md, D; plan D19).

1. **Scan by code, no quota**: ``package.json`` scripts and frameworks, ``pyproject.toml``/``uv.lock``, ``go.mod``,
   ``Cargo.toml``, ``Makefile``, a ``Dockerfile``, the CI workflows (the commands CI really runs win over the
   README), ``CLAUDE.md``/``AGENTS.md``, an existing ``.claude/``, a monorepo, test folders, a web UI, the git remote.
2. **Suggest**: test, lint and build commands, the prepare command for a worktree, a port, the default workflow, the
   team (every role the suggested workflow has a step for, plus a Designer and a User tester when there is a UI), the
   plugins of the catalogue for those roles, and the hand-over route.
3. **Try**: the prepare and test commands run once in a scratch worktree; a command that fails is shown failing.
4. **Create** only when a person presses it: the members from the packs, the project's AI team settings, the plugins.
"""

import asyncio
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlmodel import col, select

import database

from models import AiAccount, AiPlugin, AiRepoScan

from . import accounts, cli, ops, packs, paths, plugins, project_env, worktrees
from .store import get_settings

log = logging.getLogger(__name__)

TRIAL_TIMEOUT_S = 10 * 60
_FP_NAMES = (
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "pyproject.toml",
    "uv.lock",
    "poetry.lock",
    "go.mod",
    "Cargo.toml",
    "Gemfile",
    "pom.xml",
    "build.gradle",
    "Makefile",
    "Dockerfile",
    "CLAUDE.md",
    "AGENTS.md",
)
_CI_HINT = re.compile(
    r"\b(test|pytest|vitest|jest|lint|ruff|eslint|tsc|build|typecheck|mypy|go test|cargo test)\b",
    re.I,
)


def _read(path: Path, limit: int = 200_000) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")[:limit]
    except OSError:
        return ""


def _json(path: Path) -> dict:
    try:
        return json.loads(_read(path))
    except ValueError:
        return {}


def _ci_commands(root: Path) -> list[str]:
    """The `run:` lines of the CI workflows that look like a check (what CI really runs)."""
    out: list[str] = []
    for wf in sorted((root / ".github" / "workflows").glob("*.y*ml")):
        text = _read(wf)
        all_lines = text.splitlines()
        for idx, line in enumerate(all_lines):
            step = line.strip()
            step = step[1:].strip() if step.startswith("-") else step
            if not step.startswith("run:"):
                continue
            first = step[len("run:") :].strip()
            if first.startswith("|"):  # a block: take the next indented lines
                tail = all_lines[idx + 1 : idx + 8]
                lines = [t.strip() for t in tail if t.startswith(" ") and t.strip()]
            else:
                lines = [first]
            out += [ln for ln in lines if ln and _CI_HINT.search(ln)]
    return list(dict.fromkeys(out))[:20]


def fingerprint(root: Path) -> str:
    """A hash of the files the scan reads (CI workflows, manifests, lockfiles): it changes when the repo's tooling does."""
    h = hashlib.sha256()
    files = sorted((root / ".github" / "workflows").glob("*.y*ml"))
    for dirpath, dirs, names in os.walk(root):
        dirs[:] = sorted(
            d
            for d in dirs
            if d
            not in (".git", "node_modules", ".venv", "dist", "build", "__pycache__")
        )
        files += [Path(dirpath) / n for n in sorted(names) if n in _FP_NAMES]
        if len(files) > 200:
            break
    for f in files[:200]:
        try:
            data = f.read_bytes()
        except OSError:
            continue
        h.update(str(f.relative_to(root)).encode() + b"\0")
        h.update(hashlib.sha256(data).digest())
    return h.hexdigest()


def _committed(root: Path) -> set[str] | None:
    """The files of the repository's HEAD commit (posix paths from the root), which is all a worktree made from HEAD
    has, or None when the folder is not the root of a git repository with a commit (then nothing is filtered)."""
    if not (root / ".git").exists():
        return None
    try:
        res = subprocess.run(
            ["git", "ls-tree", "-r", "-z", "--name-only", "HEAD"],
            cwd=root,
            capture_output=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if res.returncode != 0:
        return None
    return {p for p in res.stdout.decode("utf-8", "replace").split("\0") if p}


def _in_worktree(path: Path, root: Path, committed: set[str] | None) -> bool:
    """Whether a manifest is in a ticket's worktree: a git-ignored or untracked checkout inside the repository (a
    vendored tool, a nested clone) is on this disk but not in a worktree, so a command that goes there fails."""
    return committed is None or path.relative_to(root).as_posix() in committed


def _hidden(path: Path, root: Path) -> bool:
    """A manifest under a hidden folder (``.github/skills/…/scripts``, ``.claude/worktrees/…``, ``.venv``) is tooling,
    not the application: its install step does not belong in the project's prepare command."""
    return any(part.startswith(".") for part in path.relative_to(root).parts[:-1])


def scan(folder: str) -> dict:
    """What the repository is, read by code (nothing runs, nothing is sent anywhere)."""
    root = Path(os.path.expanduser(folder))
    if not root.is_dir():
        raise ValueError(f"No such folder: {folder}")
    found: dict = {
        "folder": str(root),
        "languages": [],
        "frameworks": [],
        "packages": [],
        "scripts": {},
    }
    committed = _committed(root)
    pkg_files = [
        p
        for p in root.rglob("package.json")
        if "node_modules" not in p.parts
        and not _hidden(p, root)
        and _in_worktree(p, root, committed)
    ][:12]
    for pkg in pkg_files:
        data = _json(pkg)
        rel = pkg.parent.relative_to(root).as_posix()
        deps = {
            **(data.get("dependencies") or {}),
            **(data.get("devDependencies") or {}),
        }
        found["packages"].append(
            {
                "path": rel,
                "kind": "node",
                "name": data.get("name"),
                "scripts": data.get("scripts") or {},
            }
        )
        for fw, dep in (
            ("react", "react"),
            ("vite", "vite"),
            ("next", "next"),
            ("vue", "vue"),
            ("svelte", "svelte"),
            ("electron", "electron"),
            ("vitest", "vitest"),
            ("jest", "jest"),
            ("playwright", "@playwright/test"),
            ("eslint", "eslint"),
            ("tailwind", "tailwindcss"),
        ):
            if dep in deps and fw not in found["frameworks"]:
                found["frameworks"].append(fw)
        if "node" not in found["languages"]:
            found["languages"].append("node")
    for py in [
        p
        for p in root.rglob("pyproject.toml")
        if not _hidden(p, root) and _in_worktree(p, root, committed)
    ][:8]:
        text = _read(py)
        rel = py.parent.relative_to(root).as_posix()
        manager = (
            "uv"
            if (py.parent / "uv.lock").exists()
            else ("poetry" if "[tool.poetry]" in text else "pip")
        )
        found["packages"].append(
            {
                "path": rel,
                "kind": "python",
                "manager": manager,
                "pytest": "pytest" in text,
                "ruff": "ruff" in text,
            }
        )
        for fw in ("fastapi", "django", "flask", "pytest", "ruff", "sqlalchemy"):
            if fw in text.lower() and fw not in found["frameworks"]:
                found["frameworks"].append(fw)
        if "python" not in found["languages"]:
            found["languages"].append("python")
    for name, lang in (
        ("go.mod", "go"),
        ("Cargo.toml", "rust"),
        ("Gemfile", "ruby"),
        ("pom.xml", "java"),
        ("build.gradle", "java"),
    ):
        if (root / name).exists() and lang not in found["languages"]:
            found["languages"].append(lang)
    found["makefile_targets"] = (
        re.findall(r"^([a-zA-Z][\w-]*):", _read(root / "Makefile"), re.MULTILINE)[:20]
        if (root / "Makefile").exists()
        else []
    )
    found["docker"] = (
        (root / "Dockerfile").exists()
        or (root / "docker-compose.yml").exists()
        or (root / "compose.yaml").exists()
    )
    found["ci_commands"] = _ci_commands(root)
    found["agent_files"] = [
        n
        for n in ("CLAUDE.md", "AGENTS.md", ".claude", ".mcp.json")
        if (root / n).exists()
    ]
    found["readme_lines"] = len(_read(root / "README.md").splitlines())
    found["monorepo"] = len(found["packages"]) > 1
    found["tests"] = sorted(
        {
            str(p.relative_to(root))
            for p in root.rglob("test*")
            if p.is_dir()
            and ".git" not in p.parts
            and "node_modules" not in p.parts
            and ".venv" not in p.parts
        }
    )[:10]
    found["ui"] = any(
        f in found["frameworks"]
        for f in ("react", "vue", "svelte", "next", "vite", "electron")
    )
    try:
        remote = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        ).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        remote = ""
    found["git"] = (root / ".git").exists()
    found["remote"] = re.sub(r"//[^@/]+@", "//", remote) or None
    files = 0
    for _, dirs, fs in os.walk(root):
        dirs[:] = [
            d
            for d in dirs
            if d
            not in (".git", "node_modules", ".venv", "dist", "build", "__pycache__")
        ]
        files += len(fs)
    found["files"] = files
    found["fingerprint"] = fingerprint(root)
    return found


def _dir(pkg: dict) -> str | None:
    """A package's folder for a command line (forward slashes, which npm and uv take on Windows too; quoted when it
    has a space), or None for the repository root."""
    path = pkg["path"].replace("\\", "/")
    if path in ("", "."):
        return None
    return f'"{path}"' if " " in path else path


def _npm(pkg: dict, args: str) -> str:
    """An npm command for a package's folder. `--prefix` instead of `cd folder &&`: the commands are joined with `&&`
    into one shell line, where a `cd` would also move every command after it (`cd ui && npm ci && uv sync` ran
    `uv sync` in ui/)."""
    d = _dir(pkg)
    return f"npm {args}" if d is None else f"npm --prefix {d} {args}"


def _py(pkg: dict, args: str) -> str:
    """A uv or poetry command run in a package's folder (`--directory`, for the same reason as `_npm`)."""
    d = _dir(pkg)
    tool = "uv" if pkg.get("manager") == "uv" else "poetry"
    return f"{tool} {args}" if d is None else f"{tool} --directory {d} {args}"


def _pkg_cmd(pkg: dict, script: str) -> str | None:
    """The npm command of a package script, run in the package's folder (a test run never watches)."""
    scripts = pkg.get("scripts") or {}
    if script not in scripts:
        return None
    if script == "test":
        watches = "vitest" in scripts["test"] and "run" not in scripts["test"].split()
        return _npm(pkg, "test" + (" -- --run" if watches else ""))
    return _npm(pkg, f"run {script}")


_ROLE_NAMES = {
    "triage": "Triage",
    "pm": "PM",
    "ba": "BA",
    "designer": "Designer",
    "dev": "Dev",
    "qa": "QA",
    "reviewer": "Reviewer",
    "user_tester": "User tester",
    # the roles of issue #273: only when the repository calls for them (the light model picks them)
    "tech_writer": "Technical writer",
    "devops": "DevOps",
    "security": "Security reviewer",
    "data_analyst": "Data analyst",
}


def _wanted(entry: dict, found: dict) -> bool:
    """A browser tool (`ui`) is only for a project with a UI."""
    return bool(found.get("ui")) or not entry.get("ui")


def suggest(found: dict) -> dict:
    """What the scan proposes; a person changes any of it before anything is created."""
    tests, lints, builds, prepares = [], [], [], []
    for pkg in found["packages"]:
        if pkg["kind"] == "node":
            for name, bucket in (("test", tests), ("lint", lints), ("build", builds)):
                cmd = _pkg_cmd(pkg, name)
                if cmd:
                    bucket.append(cmd)
            prepares.append(_npm(pkg, "ci"))
        elif pkg["kind"] == "python":
            managed = pkg.get("manager") in ("uv", "poetry")
            d = _dir(pkg)
            if pkg.get("pytest"):
                tests.append(
                    _py(pkg, "run pytest -q")
                    if managed
                    else ("pytest -q" if d is None else f"pytest -q {d}")
                )
            if pkg.get("ruff"):
                lints.append(
                    _py(pkg, "run ruff check .")
                    if managed
                    else f"ruff check {d or '.'}"
                )
            if managed:
                prepares.append(
                    _py(pkg, "sync" if pkg.get("manager") == "uv" else "install")
                )
            # plain pip has no environment of its own: `pip install -e .` would install into whatever Python is on
            # the PATH, the person's own, so nothing is proposed and a person writes the command they use
    for cmd in found.get("ci_commands") or []:
        low = cmd.lower()
        if not tests and re.search(r"\b(test|pytest|vitest|jest)\b", low):
            tests.append(cmd)
        if not lints and re.search(r"\b(lint|ruff|eslint)\b", low):
            lints.append(cmd)
    if "go" in found["languages"] and not tests:
        tests.append("go test ./...")
    if "rust" in found["languages"] and not tests:
        tests.append("cargo test")
    workflow = "feature_ui" if found["ui"] else "standard"
    roles = ["triage", "pm", "ba", "dev", "qa", "reviewer"]
    if found["ui"]:
        roles[3:3] = ["designer"]
        roles.append("user_tester")
    team = [{"pack": r, "name": _ROLE_NAMES[r]} for r in roles]
    suggested_plugins = [
        c["key"]
        for c in plugins.CATALOGUE
        if set(c["roles"]) & set(roles) and _wanted(c, found)
    ]
    handover = (
        "local"
        if not found.get("remote")
        else ("pr" if worktrees.is_github(found.get("remote")) else "branch")
    )
    return {
        "commands": {
            "test": " && ".join(tests[:2]),
            "lint": " && ".join(lints[:2]),
            "build": " && ".join(builds[:2]),
        },
        "prepare": " && ".join(dict.fromkeys(prepares)),
        "base_port": 5180,
        "workflow_default": workflow,
        "team": team,
        "plugins": suggested_plugins,
        "handover": handover,
        "worktrees": bool(found.get("git")),
        "why": {
            "commands": "Taken from the CI workflow when there is one, else from the package scripts.",
            "team": "Every role the suggested workflow has a step for"
            + (
                ", plus a Designer and a User tester because it has a UI."
                if found["ui"]
                else "."
            ),
            "handover": {
                "local": "No remote: merge on this machine.",
                "pr": "A GitHub remote: open a pull request.",
                "branch": "A remote that is not GitHub: push the branch.",
            }[handover],
        },
    }


COMMANDS = ("prepare", "test", "lint", "build")
CHECKS = ("test", "lint", "build")
# The shell could not run the command at all: a program that is not there, a script that does not exist, bad
# arguments. Anything else that exits non-zero ran, and the project failed (the two kinds of red, design D4).
_WRONG = re.compile(
    r"command not found|: not found|Missing script|is not recognized as an internal|Unknown command|"
    r"no such command|unrecognized subcommand|Failed to spawn|Couldn't find a script|Unknown script|"
    r"No such file or directory: '?[\w./-]*'?$|error: unknown option|"
    # the package manager found no package.json where it ran (npm exits 254): the command is not for this folder.
    # Only the package manager's own lines: a test that reads a package.json fixture and fails ran, the project fails
    r"^npm (?:ERR!|error) (?:enoent|path)\b[^\n]*package\.json|"
    r"^(?:error )?Couldn't find a package\.json file|ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND|"
    r"No package\.json \(or package\.yaml, or package\.json5\) was found|"
    # the program's own input is not there (RC-2): the script given to python or the shell, the Makefile or its
    # target, the test path given to pytest
    r"can't open file '[^']*': \[Errno 2\]|^(?:ba|z|da)?sh: [^:\n]+: No such file or directory$|"
    r"No rule to make target '[^']*'\.\s+Stop|No targets specified and no makefile found|"
    r"ERROR: file or directory not found:",
    re.I | re.M,
)


def classify(exit_code: int | None, output: str, timed_out: bool = False) -> str:
    """works | wrong | fails | timeout: the server decides from the exit code and the output, never the AI."""
    if timed_out:
        return "timeout"
    if exit_code == 0:
        return "works"
    if exit_code in (126, 127) or _WRONG.search(output or ""):
        return "wrong"
    return "fails"


def _why_wrong(output: str, exit_code: int | None) -> str:
    m = _WRONG.search(output or "")
    if m:
        line = next(
            (ln for ln in (output or "").splitlines() if m.group(0) in ln), m.group(0)
        )
        return line.strip()[:200]
    return f"The shell could not run it (exit {exit_code})."


class _Scratch:
    """A scratch worktree of the repository's HEAD (or a copy when it is not a git repository), removed afterwards."""

    def __init__(self, folder: str):
        self.root = Path(folder)
        self.tmp = Path(tempfile.mkdtemp(prefix="kanban-trial-"))
        self.work = self.tmp / "wt"
        self.made_worktree = False

    def __enter__(self) -> Path:
        if (self.root / ".git").exists():
            res = subprocess.run(
                ["git", "worktree", "add", "--detach", str(self.work), "HEAD"],
                cwd=self.root,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=60,
            )
            self.made_worktree = res.returncode == 0
        if not self.made_worktree:
            shutil.copytree(
                self.root,
                self.work,
                ignore=shutil.ignore_patterns(".git", "node_modules", ".venv"),
            )
        return self.work

    def __exit__(self, *exc) -> None:
        if self.made_worktree:
            subprocess.run(
                ["git", "worktree", "remove", "--force", str(self.work)],
                cwd=self.root,
                capture_output=True,
                timeout=60,
            )
            subprocess.run(
                ["git", "worktree", "prune"],
                cwd=self.root,
                capture_output=True,
                timeout=60,
            )
        shutil.rmtree(self.tmp, ignore_errors=True)


async def _run_one(
    cmd: str, cwd: Path, env: dict, on_line=None, timeout: float = TRIAL_TIMEOUT_S
) -> dict:
    """Run one shell line the way a ticket does (``/bin/sh``, the project's environment), in its own process group so
    a cancel stops it and everything it started."""
    started = datetime.now(UTC)
    proc = await asyncio.create_subprocess_shell(
        cmd,
        cwd=str(cwd),
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        stdin=asyncio.subprocess.DEVNULL,
        **cli._popen_kwargs(),
    )
    lines: list[str] = []

    async def read() -> None:
        assert proc.stdout is not None
        async for raw in proc.stdout:
            line = raw.decode("utf-8", errors="replace").rstrip()
            lines.append(line)
            if len(lines) > 2000:
                del lines[:1000]
            if on_line is not None:
                on_line(line)

    timed_out = False
    try:
        await asyncio.wait_for(asyncio.gather(read(), proc.wait()), timeout)
    except asyncio.TimeoutError:
        timed_out = True
        cli.kill_tree(proc.pid)
        await proc.wait()
    except asyncio.CancelledError:
        cli.kill_tree(proc.pid)
        raise
    output = "\n".join(lines)
    code = None if timed_out else proc.returncode
    status = classify(code, "\n".join(lines[-40:]), timed_out)
    return {
        "command": cmd,
        "status": status,
        "ok": status == "works",
        "exit_code": code,
        "seconds": round((datetime.now(UTC) - started).total_seconds(), 1),
        "tail": [ln for ln in lines if ln.strip()][-12:]
        or (["Timed out."] if timed_out else []),
        "reason": (
            f"Timed out after {int(timeout // 60)} minutes."
            if timed_out
            else (_why_wrong(output[-4000:], code) if status == "wrong" else None)
        ),
    }


async def try_commands(
    folder: str,
    commands: dict,
    extra_path: list[str] | None = None,
    *,
    only: list[str] | None = None,
    on_event=None,
) -> dict:
    """Run the commands once in a scratch worktree, the way a ticket runs them: prepare first (when set), then test,
    lint and build, each on its own (one failing does not hide the next). Every command gets a result with a status;
    one that did not run says why. ``on_event(kind, name, data)`` reports progress: ("start", name, cmd),
    ("line", name, text), ("done", name, result)."""
    env = project_env.with_path(None, extra_path)
    out: dict = {n: None for n in COMMANDS}
    wanted = [n for n in CHECKS if only is None or n in only]

    def emit(kind: str, name: str, data) -> None:
        if on_event is not None:
            on_event(kind, name, data)

    def not_run(name: str, reason: str) -> dict:
        return {
            "command": (commands.get(name) or "").strip(),
            "status": "not_run",
            "ok": False,
            "exit_code": None,
            "seconds": 0,
            "tail": [],
            "reason": reason,
        }

    scratch = _Scratch(folder)
    work = await asyncio.to_thread(scratch.__enter__)
    try:
        prepare = (commands.get("prepare") or "").strip()
        prepared = True
        if prepare:
            emit("start", "prepare", prepare)
            out["prepare"] = await _run_one(
                prepare, work, env, lambda ln: emit("line", "prepare", ln)
            )
            emit("done", "prepare", out["prepare"])
            prepared = out["prepare"]["ok"]
        for name in CHECKS:
            cmd = (commands.get(name) or "").strip()
            if name not in wanted:
                continue
            if not cmd:
                out[name] = (
                    None  # no command: nothing to try (the wizard shows it as empty)
                )
            elif not prepared:
                out[name] = not_run(name, "prepare failed first")
            else:
                emit("start", name, cmd)
                out[name] = await _run_one(
                    cmd, work, env, lambda ln, n=name: emit("line", n, ln)
                )
            emit("done", name, out[name])
    finally:
        await asyncio.to_thread(scratch.__exit__, None, None, None)
    return out


def _try(folder: str, prepare: str, test: str) -> dict:
    """The prepare and test commands tried once (the scan's own trial); see ``try_commands``."""
    out = asyncio.run(
        try_commands(folder, {"prepare": prepare, "test": test}, only=["test"])
    )
    return {"prepare": out["prepare"], "test": out["test"]}


async def run_scan(
    session,
    project_id: str,
    folder: str,
    *,
    trial: bool = True,
    refine: bool = False,
    prepare: str | None = None,
    test: str | None = None,
) -> AiRepoScan:
    """Scan, suggest and (by default) try the commands; nothing is created. `refine` asks a light model to improve
    the role and plugin suggestions (it fails soft back to the code's). `prepare` and `test` are the commands as the
    person edited them: when given ("" for none), they are tried instead of the suggestion's.

    Raises:
        ValueError: No such folder, or one the AI members could not work in (outside the home folder and
            KANBAN_AI_ROOTS): said at step 1, not after the whole wizard when Create skips every member.
    """
    try:
        # the real, absolute path, checked to sit inside the places people keep their work: everything below reads
        # and runs in this one, never in the text the request carried
        folder = paths.folder(folder)
    except paths.PathRefused as exc:
        raise ValueError(
            f"The AI team can only work in a folder inside your home folder, or one listed in {paths.ROOTS_ENV}. "
            f"Move the repository there, or add its parent folder to {paths.ROOTS_ENV}: {folder.strip()}"
        ) from exc
    found = await asyncio.to_thread(scan, folder)
    proposal = suggest(found)
    if refine:
        proposal = await refine_suggestion(session, project_id, found, proposal)
    tried = {}
    if trial:
        settings = await get_settings(session, project_id)
        tried = await try_commands(
            found["folder"],
            {
                "prepare": proposal["prepare"] if prepare is None else prepare.strip(),
                "test": proposal["commands"]["test"] if test is None else test.strip(),
            },
            project_env.extra(settings),
            only=["test"],
        )
        tried = {"prepare": tried["prepare"], "test": tried["test"]}
    row = AiRepoScan(
        project_id=project_id,
        folder=found["folder"],
        found=json.dumps(found),
        suggested=json.dumps(proposal),
        trial=json.dumps(tried),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


REFINE_PROMPT = (
    "You help set up an AI team for a code repository. From these facts, choose the roles and plugins that fit. "
    'Reply with JSON only: {"roles": [role keys], "plugins": [plugin keys], "why": "one short sentence"}.\n'
    "Roles you may use: triage, pm, ba, designer, dev, qa, reviewer, user_tester, tech_writer, devops, security, "
    "data_analyst. Keep dev. designer and user_tester only when the repository has a web UI; tech_writer when it is a "
    "library, an API or has user docs; devops when it has CI, containers or deploy config; security when it handles "
    "logins, payments or personal data; data_analyst when it is mostly data or notebooks.\n"
    "Plugins you may use (key: what for): "
)


async def _ask_light(prompt: str, account) -> str | None:
    """One call of the light model (Haiku) on the project's Claude Code account; the seam the tests replace."""
    from types import SimpleNamespace

    from . import knowledge

    return await knowledge._ask_light_model(
        prompt, SimpleNamespace(cli_path=None), account
    )


async def _claude_account(session, account_id: str | None = None):
    """A signed-in Claude Code account of the board (the chosen one first), or None."""
    if account_id:
        acct = await session.get(AiAccount, account_id)
        if acct is not None and acct.cli == "claude":
            return acct
    return (
        await session.exec(
            select(AiAccount).where(
                AiAccount.cli == "claude", AiAccount.status == "signed_in"
            )
        )
    ).first()


def _parse_refined(text: str | None) -> dict | None:
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


async def refine_suggestion(
    session,
    project_id: str,
    found: dict,
    proposal: dict,
    *,
    account_id: str | None = None,
) -> dict:
    """Ask a light model to refine the suggested team and plugins from the scan's facts. Optional and soft: with no
    Claude Code account, an error or an answer that makes no sense, the code's suggestion comes back unchanged."""
    try:
        account = await _claude_account(session, account_id)
        if account is None:
            return proposal
        facts = {
            k: found.get(k)
            for k in (
                "languages",
                "frameworks",
                "monorepo",
                "ui",
                "tests",
                "agent_files",
            )
        }
        catalogue = "; ".join(
            f"{c['key']}: {c['what'][:60]}"
            for c in plugins.CATALOGUE
            if found.get("ui") or not c.get("ui")
        )
        answer = _parse_refined(
            await _ask_light(
                REFINE_PROMPT + catalogue + "\nFacts: " + json.dumps(facts), account
            )
        )
        if answer is None:
            return proposal
        known = {t["pack"]: t["name"] for t in proposal["team"]}
        roles = [
            r
            for r in answer.get("roles") or []
            if isinstance(r, str)
            and r in _ROLE_NAMES
            and (found.get("ui") or r not in ("designer", "user_tester"))
        ]
        keys = [
            k
            for k in answer.get("plugins") or []
            if isinstance(k, str)
            and k in {c["key"] for c in plugins.CATALOGUE if _wanted(c, found)}
        ]
        out = dict(proposal)
        if roles:
            if "dev" not in roles:
                roles.append("dev")
            order = list(_ROLE_NAMES)
            roles = sorted(dict.fromkeys(roles), key=order.index)
            out["team"] = [
                {"pack": r, "name": known.get(r) or _ROLE_NAMES[r]} for r in roles
            ]
        if keys:
            out["plugins"] = list(dict.fromkeys(keys))
        why = " ".join(str(answer.get("why") or "").split())[:300]
        if why:
            out["why"] = {**proposal.get("why", {}), "refined": why}
        return out
    except Exception:  # noqa: BLE001 - a light-model failure never breaks a scan
        log.warning("repo scan: the light-model refinement failed", exc_info=True)
        return proposal


# --------------------------------------------------------------------------- the AI sets up the commands (design C/D)

JOB_LIMIT_S = 10 * 60
LOG_KEEP = 400
_TASKS: dict[str, asyncio.Task] = {}
_AI_STATUS: dict = {}
_STEP_LABEL = {
    "prepare": "Prepare",
    "test": "Test",
    "lint": "Lint",
    "build": "Build",
}


class JobRunning(Exception):
    """A job already runs for this scan."""


async def ai_status(session, force: bool = False) -> dict:
    """Whether the AI can set up the commands: Claude Code found and signed in (the board's signed-in account, else
    this computer's own login). Cached for 15 s, since the wizard polls."""
    account = await _claude_account(session)
    key = account.id if account is not None else "local"
    cached = _AI_STATUS.get(key)
    if not force and cached and time.monotonic() - cached[0] < 15:
        return cached[1]
    env = accounts.env_for(account, cli.child_env(None)) if account else None
    try:
        info = await cli.detect("claude-code", "claude", None, env)
    except Exception:  # noqa: BLE001 - a detection failure is "not available", never a broken wizard
        info = {"found": False}
    if not info.get("found"):
        value = {
            "available": False,
            "why": "Claude Code is not installed on this computer (the claude command was not found).",
        }
    elif info.get("logged_in") is False:
        value = {
            "available": False,
            "why": "Claude Code is not signed in on this computer. The AI needs it to read the repository.",
        }
    else:
        value = {"available": True, "why": None}
    _AI_STATUS[key] = (time.monotonic(), value)
    return value


def running(scan_id: str) -> bool:
    """Whether a job runs for this scan in this process."""
    task = _TASKS.get(scan_id)
    return task is not None and not task.done()


class _Job:
    """The job's state as the wizard reads it (``AiRepoScan.job``), saved now and then while it runs."""

    def __init__(self, scan_id: str, mode: str, hint: str, trial: dict, proposal: dict):
        self.scan_id = scan_id
        self.doc: dict = {
            "mode": mode,
            "state": "running",
            "started_at": datetime.now(UTC).isoformat(),
            "ended_at": None,
            "hint": hint,
            "steps": [],
            "log": [],
            "error": None,
        }
        self.trial = trial
        self.proposal = proposal
        self._t0 = time.monotonic()
        self._saved = 0.0

    def at(self) -> int:
        return int(time.monotonic() - self._t0)

    def step(
        self, key: str, label: str, detail: str = "", state: str = "waiting"
    ) -> None:
        for s in self.doc["steps"]:
            if s["key"] == key:
                s.update(label=label, detail=detail, state=state)
                return
        self.doc["steps"].append(
            {"key": key, "label": label, "detail": detail, "state": state, "at_s": None}
        )

    def mark(self, key: str, state: str, **kw) -> None:
        for s in self.doc["steps"]:
            if s["key"] == key:
                s["state"] = state
                if state in ("done", "failed"):
                    s["at_s"] = self.at()
                s.update(kw)

    def line(self, text: str) -> None:
        self.doc["log"].append(text[:500])
        if len(self.doc["log"]) > LOG_KEEP:
            del self.doc["log"][: len(self.doc["log"]) - LOG_KEEP]

    def finish(self, state: str, error: str | None = None) -> None:
        self.doc["state"] = state
        self.doc["error"] = error
        self.doc["ended_at"] = datetime.now(UTC).isoformat()
        for s in self.doc["steps"]:
            if s["state"] == "running":
                s["state"] = "failed"
            elif s["state"] == "waiting":
                s["state"] = "skipped"
        for name, res in list(self.trial.items()):
            if res and res.get("status") in ("running", "waiting"):
                self.trial[name] = {
                    **res,
                    "status": "not_run",
                    "ok": False,
                    "reason": {
                        "timeout": "The AI stopped after 10 minutes.",
                        "cancelled": "Cancelled.",
                    }.get(state, error or "It did not run."),
                }

    async def save(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._saved < 0.5:
            return
        self._saved = now
        async with database.async_session() as session:
            row = await session.get(AiRepoScan, self.scan_id)
            if row is None:
                return
            row.job = json.dumps(self.doc)
            row.trial = json.dumps(self.trial)
            row.proposal = json.dumps(self.proposal)
            session.add(row)
            await session.commit()


AI_PROMPT = """You set up the commands an AI team runs for this repository. You are in a temporary copy of it. Read
what you need (the CI workflows, the package manifests and their scripts, a Makefile, the README, CLAUDE.md or
AGENTS.md); do not guess. You cannot run anything: the board runs your commands itself afterwards.

Find four shell commands. Each runs from the repository root with /bin/sh:
- prepare: installs what a fresh checkout needs before work starts, for the application(s) only (not for tooling
  folders such as .github/ or .claude/).
- test: runs the tests once (never in watch mode).
- lint: the lint or static check the project uses (CI's when there is CI).
- build: builds the application.
Prefer what CI really runs. Stay at the root: `npm --prefix <dir> …`, `uv --directory <dir> …` or `(cd <dir> && …)`,
never a bare `cd dir && …` chain. Leave a command "" when the repository has none: never invent one.

What the board's scan (by code) found:
{facts}
{extra}
Reply with JSON only, no prose around it:
{{"commands": {{"prepare": {{"command": "", "source": "where it came from, e.g. ci.yml · job ui, or ui/package.json › scripts.test", "note": "one short sentence only when the person needs to know something, else empty"}}, "test": {{…}}, "lint": {{…}}, "build": {{…}}}}, "notes": "one short sentence: which folders are the application and which are tooling"}}
"""


def _ai_prompt(found: dict, hint: str, keep: dict, last: dict) -> str:
    facts = {
        k: found.get(k)
        for k in (
            "languages",
            "frameworks",
            "packages",
            "ci_commands",
            "makefile_targets",
            "agent_files",
            "monorepo",
            "ui",
        )
    }
    extra = ""
    if hint.strip():
        extra += f"\nThe person says: {hint.strip()[:1000]}\n"
    if keep:
        extra += (
            "\nThese commands are settled (they work, or the person typed them): return them unchanged.\n"
            + "\n".join(f"- {k}: {v}" for k, v in keep.items())
            + "\n"
        )
    wrong = {
        k: r
        for k, r in (last or {}).items()
        if r and r.get("status") in ("wrong", "fails", "timeout") and k not in keep
    }
    if wrong:
        extra += "\nThe last run, by the board:\n" + "\n".join(
            f"- {k}: `{r.get('command')}` → {r.get('status')} (exit {r.get('exit_code')}): "
            + " | ".join((r.get("tail") or [])[-4:])[:400]
            for k, r in wrong.items()
        )
        extra += (
            "\n'wrong' means the shell could not run it (a missing program or script): fix the command. 'fails' means "
            "it ran and the project's own tests or checks failed: keep the command unless it is the wrong one.\n"
        )
    return AI_PROMPT.format(facts=json.dumps(facts, indent=1)[:12000], extra=extra)


def _describe_tool(name: str, data: dict, cwd: str) -> str:
    def rel(p: str) -> str:
        p = str(p or "")
        return p[len(cwd) :].lstrip("/") if cwd and p.startswith(cwd) else p

    if name == "Read":
        return f"Read {rel(data.get('file_path'))}"
    if name == "Glob":
        return f"Looked for {data.get('pattern')}"
    if name == "Grep":
        return f"Searched for {data.get('pattern')}"
    if name == "LS":
        return f"Listed {rel(data.get('path')) or '.'}"
    return name


async def _ask_ai(prompt: str, cwd: str, account, on_line) -> str | None:
    """One Claude Code run that may only read (Read, Glob, Grep) in ``cwd``; returns its final text. ``on_line`` gets
    what it does ("Read .github/workflows/ci.yml"). The seam the tests replace."""
    path, _ = cli.find_cli("claude", None)
    if not path:
        raise RuntimeError("Claude Code is not installed on this computer.")
    env = cli.child_env(None)
    if account is not None:
        env = accounts.env_for(account, env)
    proc = await asyncio.create_subprocess_exec(
        path,
        "-p",
        prompt,
        "--model",
        "sonnet",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "dontAsk",
        "--allowedTools",
        "Read,Glob,Grep,LS",
        "--disallowedTools",
        "Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers": {}}',
        cwd=cwd,
        env=env,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        limit=16 * 1024 * 1024,
        **cli._popen_kwargs(),
    )
    result: str | None = None
    try:
        assert proc.stdout is not None
        async for raw in proc.stdout:
            try:
                event = json.loads(raw)
            except ValueError:
                continue
            if event.get("type") == "assistant":
                for part in (event.get("message") or {}).get("content") or []:
                    if part.get("type") == "tool_use":
                        on_line(
                            _describe_tool(
                                part.get("name"), part.get("input") or {}, cwd
                            )
                        )
            elif event.get("type") == "result":
                if event.get("is_error"):
                    raise RuntimeError(
                        str(event.get("result") or "The AI run failed.")[:300]
                    )
                result = event.get("result")
        await proc.wait()
    except asyncio.CancelledError:
        cli.kill_tree(proc.pid)
        raise
    if result is None and proc.returncode:
        err = (await proc.stderr.read()).decode(errors="replace") if proc.stderr else ""
        raise RuntimeError(
            (err.strip().splitlines() or ["The AI run failed."])[-1][:300]
        )
    return result


def _parse_proposal(text: str | None) -> dict | None:
    data = _parse_refined(text)
    if not data or not isinstance(data.get("commands"), dict):
        return None
    out: dict = {}
    for name in COMMANDS:
        item = data["commands"].get(name)
        if isinstance(item, str):
            item = {"command": item}
        if not isinstance(item, dict):
            item = {}
        out[name] = {
            "command": " ".join(str(item.get("command") or "").split())[:1000],
            "source": str(item.get("source") or "")[:200],
            "note": str(item.get("note") or "")[:300],
        }
    return {"commands": out, "notes": str(data.get("notes") or "")[:300]}


def _code_proposal(suggested: dict) -> dict:
    """The scan's own suggestion in the proposal's shape (when the AI's answer cannot be read)."""
    cmds = dict(suggested.get("commands") or {})
    cmds["prepare"] = suggested.get("prepare") or ""
    return {
        "commands": {
            n: {
                "command": cmds.get(n) or "",
                "source": "the board's scan" if cmds.get(n) else "",
                "note": "",
            }
            for n in COMMANDS
        },
        "notes": "",
    }


async def start_job(
    session,
    scan_id: str,
    *,
    mode: str,
    hint: str = "",
    commands: dict | None = None,
    keep: list[str] | None = None,
    env_path: list[str] | None = None,
    only: list[str] | None = None,
) -> AiRepoScan:
    """Start the AI (``mode="ai"``: it proposes, then the board runs each command) or the board alone (``"try"``) on a
    scan. Returns at once; the wizard polls the scan."""
    row = await session.get(AiRepoScan, scan_id)
    if row is None:
        raise LookupError("Scan not found.")
    if running(scan_id):
        raise JobRunning("The commands are already being set up.")
    if mode == "ai":
        status = await ai_status(session, force=True)
        if not status["available"]:
            raise ValueError(status["why"])
    commands = {n: str((commands or {}).get(n) or "").strip() for n in COMMANDS}
    env_path = [str(p).strip() for p in (env_path or []) if str(p or "").strip()]
    previous = json.loads(row.trial or "{}")
    proposal = json.loads(row.proposal or "{}")
    if mode == "ai":
        trial: dict = {n: None for n in COMMANDS}
    else:
        trial = {n: previous.get(n) for n in COMMANDS}
    job = _Job(scan_id, mode, hint, trial, proposal)
    row.job = json.dumps(job.doc)
    session.add(row)
    await session.commit()
    task = asyncio.create_task(
        _run_job(
            job,
            row.folder,
            row.project_id,
            commands,
            keep or [],
            env_path,
            only,
            previous,
        )
    )
    _TASKS[scan_id] = task
    await session.refresh(row)
    return row


async def cancel_job(session, scan_id: str) -> AiRepoScan:
    """Stop the scan's job: the running command and everything it started is killed, the scratch copy removed."""
    row = await session.get(AiRepoScan, scan_id)
    if row is None:
        raise LookupError("Scan not found.")
    task = _TASKS.get(scan_id)
    if task is not None and not task.done():
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001 - its own handler saved its state
            pass
    await session.refresh(row)
    return row


async def _run_job(
    job: _Job,
    folder: str,
    project_id: str,
    commands: dict,
    keep: list[str],
    env_path: list[str],
    only: list[str] | None,
    previous: dict,
) -> None:
    async def saver() -> None:
        # the wizard polls: the state is written twice a second while it runs
        while True:
            await asyncio.sleep(0.5)
            await job.save(force=True)

    keeper = asyncio.create_task(saver())
    try:
        await asyncio.wait_for(
            _job_body(
                job, folder, project_id, commands, keep, env_path, only, previous
            ),
            JOB_LIMIT_S,
        )
        job.finish("done")
    except asyncio.TimeoutError:
        job.line("Stopped after 10 minutes.")
        job.finish("timeout", "The AI stopped after 10 minutes.")
    except asyncio.CancelledError:
        job.line("Cancelled.")
        job.finish("cancelled")
        await _stop(keeper)
        await job.save(force=True)
        _TASKS.pop(job.scan_id, None)
        raise
    except Exception as exc:  # noqa: BLE001 - a failed job is shown, never left running
        log.warning("repo scan job %s failed", job.scan_id, exc_info=True)
        job.line(f"Failed: {exc}")
        job.finish("failed", str(exc)[:300])
    await _stop(keeper)
    _TASKS.pop(job.scan_id, None)
    await job.save(force=True)


async def _stop(task: asyncio.Task) -> None:
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):  # noqa: BLE001 - the saver only writes state
        pass


async def _job_body(
    job: _Job,
    folder: str,
    project_id: str,
    commands: dict,
    keep: list[str],
    env_path: list[str],
    only: list[str] | None,
    previous: dict,
) -> None:
    async with database.async_session() as session:
        row = await session.get(AiRepoScan, job.scan_id)
        found = json.loads(row.found or "{}")
        suggested = json.loads(row.suggested or "{}")
        settings = await get_settings(session, project_id)
        saved = project_env.extra(settings)
        account = await _claude_account(session)
    mode = job.doc["mode"]
    names = [n for n in COMMANDS if n == "prepare" or only is None or n in only]

    if mode == "ai":
        job.step(
            "ai",
            "The AI is reading the repository",
            "Read-only: Read, Glob and Grep.",
            "running",
        )
        job.step("path", "Looking for the programs the commands need")
    for n in names:
        job.step(n, _STEP_LABEL[n])
    await job.save(force=True)

    env_entries: list[dict] = [
        {"path": p, "by": "you", "why": ""} for p in env_path
    ] or [{"path": p, "by": "project", "why": ""} for p in saved]

    if mode == "ai":
        keep_cmds = {n: commands[n] for n in keep if n in COMMANDS}
        prompt = _ai_prompt(found, job.doc["hint"], keep_cmds, previous)
        scratch = _Scratch(folder)
        work = await asyncio.to_thread(scratch.__enter__)
        reads = 0

        def on_tool(text: str) -> None:
            nonlocal reads
            reads += 1
            job.line(f"ai: {text}")
            job.mark("ai", "running", detail=text)

        try:
            job.line(f"$ cd {work}")
            answer = await _ask_ai(prompt, str(work), account, on_tool)
        finally:
            await asyncio.to_thread(scratch.__exit__, None, None, None)
        proposal = _parse_proposal(answer)
        if proposal is None:
            job.line("The AI's answer could not be read; the board's own scan is used.")
            proposal = _code_proposal(suggested)
        for n, cmd in keep_cmds.items():
            proposal["commands"][n] = {
                **proposal["commands"].get(n, {}),
                "command": cmd,
                "source": proposal["commands"].get(n, {}).get("source")
                or "typed by you",
            }
        commands = {n: proposal["commands"][n]["command"] for n in COMMANDS}
        sources = sorted(
            {
                c["source"].split(" ›")[0].split(" ·")[0]
                for c in proposal["commands"].values()
                if c["source"]
            }
        )
        found_n = sum(1 for c in commands.values() if c)
        job.line(
            "AI proposed: " + ", ".join(f"{n} = {c}" for n, c in commands.items() if c)
            if found_n
            else "AI proposed: no commands (the repository has none it could find)"
        )
        job.mark(
            "ai",
            "done",
            label="The AI proposed the commands"
            if found_n
            else "The AI found no commands",
            detail=(
                f"{found_n} of 4 · from {', '.join(sources)}"
                if sources
                else f"{found_n} of 4"
            )
            + (f" · {proposal['notes']}" if proposal.get("notes") else ""),
        )
        job.proposal = {**proposal, "env_path": []}
        await job.save(force=True)

        # the programs: a folder the app's own PATH does not have, found in the usual install folders
        job.mark("path", "running")
        base = project_env.with_path(None, [e["path"] for e in env_entries])["PATH"]
        missing = project_env.missing_folders([c for c in commands.values() if c], base)
        for m in missing:
            job.line(f"$ which {m['program']}")
            job.line(f"{m['program']} not found on PATH={os.environ.get('PATH', '')}")
            job.line(f"{m['path']}/{m['program']}")
            env_entries.append(
                {"path": m["path"], "by": "ai", "why": f"{m['program']} was found here"}
            )
        job.mark(
            "path",
            "done",
            label="Looked for the programs",
            detail=(
                "; ".join(
                    f"{m['program']} is not on the app’s PATH. Found in {m['path']}; proposed as an extra folder."
                    for m in missing
                )
                or "Everything the commands need is on the PATH."
            ),
        )
        job.proposal["env_path"] = env_entries
        await job.save(force=True)
    else:
        job.proposal = {**(job.proposal or {}), "env_path": env_entries}

    for n in names:
        if n != "prepare" and not commands.get(n):
            job.trial[n] = None
            job.mark(n, "skipped", detail="No command.")
        elif commands.get(n):
            job.trial[n] = {
                "command": commands[n],
                "status": "waiting",
                "ok": False,
                "exit_code": None,
                "seconds": 0,
                "tail": [],
                "reason": None,
            }
            job.mark(n, "waiting", detail=commands[n])
        else:
            job.mark(n, "skipped", detail="No command.")

    def on_event(kind: str, name: str, data) -> None:
        if kind == "start":
            job.trial[name] = {
                **(job.trial.get(name) or {}),
                "command": data,
                "status": "running",
            }
            job.mark(
                name,
                "running",
                label=f"The board is running {name}, the way a ticket will",
                detail=data,
            )
            job.line(f"board$ /bin/sh -c {json.dumps(data)}  (saved PATH in front)")
        elif kind == "line":
            job.line(data)
        elif kind == "done":
            job.trial[name] = data
            if data is None:
                return
            status = data.get("status")
            if status == "not_run":
                job.mark(
                    name,
                    "skipped",
                    label=_STEP_LABEL[name],
                    detail=data.get("reason") or "",
                )
            else:
                job.mark(
                    name,
                    "done" if status == "works" else "failed",
                    label=_STEP_LABEL[name],
                    detail=f"{status} · {data.get('seconds')} s",
                )
                job.line(
                    f"{name}: {status}, exit {data.get('exit_code')}, {data.get('seconds')} s"
                )

    if any(commands.get(n) for n in names):
        run_cmds = {n: commands.get(n, "") for n in names}
        result = await try_commands(
            folder,
            run_cmds,
            [e["path"] for e in env_entries],
            only=[n for n in names if n != "prepare"],
            on_event=on_event,
        )
        for n in names:
            if result.get(n) is not None or n == "prepare":
                job.trial[n] = result.get(n)
    await job.save(force=True)


async def latest(session, project_id: str) -> AiRepoScan | None:
    """The newest scan of the project that was not applied, from the last day (the wizard picks it up again)."""
    since = (datetime.now(UTC) - timedelta(days=1)).isoformat()
    return (
        await session.exec(
            select(AiRepoScan)
            .where(
                AiRepoScan.project_id == project_id,
                col(AiRepoScan.applied_at).is_(None),
                AiRepoScan.created_at >= since,
            )
            .order_by(col(AiRepoScan.created_at).desc())
        )
    ).first()


async def to_api(session, row: AiRepoScan) -> dict:
    """A scan for the API, with whether the AI can run and a job a restart left behind marked as stopped."""
    out = to_dict(row)
    job = out["job"]
    if job.get("state") == "running" and not running(row.id):
        job.update(
            state="failed", error="The app restarted while it ran. Run it again."
        )
    status = await ai_status(session)
    out["ai_available"] = status["available"]
    out["ai_unavailable_why"] = status["why"]
    return out


async def rescan_if_changed(session, project_id: str) -> bool:
    """Scan again when the files the last scan read have changed. Never applies anything: the new scan waits for a
    person. Returns whether it scanned."""
    last = (
        await session.exec(
            select(AiRepoScan)
            .where(AiRepoScan.project_id == project_id)
            .order_by(col(AiRepoScan.created_at).desc())
        )
    ).first()
    if last is None:
        return False
    root = Path(os.path.expanduser(last.folder))
    if not root.is_dir():
        return False
    before = (json.loads(last.found or "{}")).get("fingerprint")
    now = await asyncio.to_thread(fingerprint, root)
    if now == before:
        return False
    await run_scan(session, project_id, last.folder, trial=False)
    return True


async def sweep(session_factory) -> list[str]:
    """One pass over every project that has a scan: scan again where the repository changed. The caller runs it
    now and then (main.py)."""
    async with session_factory() as session:
        ids = list((await session.exec(select(AiRepoScan.project_id).distinct())).all())
    done: list[str] = []
    for pid in ids:
        try:
            async with session_factory() as session:
                if await rescan_if_changed(session, pid):
                    done.append(pid)
        except Exception:  # noqa: BLE001 - one project never stops the others
            log.warning("repo scan: rescan of %s failed", pid, exc_info=True)
    return done


def _job_view(raw: str | None) -> dict:
    job = json.loads(raw or "{}")
    if job.get("started_at"):
        try:
            start = datetime.fromisoformat(job["started_at"])
            end = (
                datetime.fromisoformat(job["ended_at"])
                if job.get("ended_at")
                else datetime.now(UTC)
            )
            job["elapsed_s"] = int((end - start).total_seconds())
        except ValueError:
            job["elapsed_s"] = 0
    return job


def to_dict(row: AiRepoScan) -> dict:
    """A scan for the API."""
    return {
        "id": row.id,
        "project_id": row.project_id,
        "folder": row.folder,
        "found": json.loads(row.found or "{}"),
        "suggested": json.loads(row.suggested or "{}"),
        "trial": json.loads(row.trial or "{}"),
        "job": _job_view(row.job),
        "proposal": json.loads(row.proposal or "{}"),
        "base_path": os.environ.get("PATH", ""),
        "applied_at": row.applied_at,
        "created_at": row.created_at,
    }


async def apply(session, scan_id: str, choice: dict, *, by: str, create_member) -> dict:
    """Create what the person confirmed: the members from packs, the project's settings, the plugins.

    `choice` is the suggestion as the person edited it: {team: [{pack, name}], commands, prepare, base_port,
    workflow_default, handover, worktrees, plugins: [catalogue keys], account_id, env_path: [folders],
    checks_off: [commands saved but not checks yet]}. `create_member(body)` makes one AI
    member through the member service and returns it.
    """
    row = await session.get(AiRepoScan, scan_id)
    if row is None:
        raise LookupError("Scan not found.")
    settings = await get_settings(session, row.project_id)
    patch = {
        "commands": choice.get("commands") or {},
        "checks_off": [
            n
            for n in (choice.get("checks_off") or [])
            if n in ("test", "lint", "build")
        ],
        "env_path": [
            str(p).strip()
            for p in (choice.get("env_path") or [])
            if str(p or "").strip()
        ],
        "workflow_default": choice.get("workflow_default") or "standard",
        "worktrees": {
            "on": bool(choice.get("worktrees")),
            "repo": row.folder,
            "prepare": choice.get("prepare") or "",
            "base_port": int(choice.get("base_port") or 5180),
            "handover": choice.get("handover") or "auto",
        },
    }
    ops.update(settings, patch)
    session.add(settings)
    await session.commit()
    created, skipped = [], []
    for item in choice.get("team") or []:
        pack = await packs.get_pack(session, row.project_id, item.get("pack") or "")
        if pack is None:
            skipped.append({"name": item.get("name"), "why": "no such pack"})
            continue
        body = packs.member_body(
            pack,
            name=item.get("name") or pack["name"],
            working_dir=row.folder,
            account_id=choice.get("account_id"),
            plays=item.get("plays"),
        )
        try:
            member = await create_member(body)
            created.append({"id": member.id, "name": member.name, "pack": pack["key"]})
        except ValueError as exc:
            skipped.append({"name": item.get("name"), "why": str(exc)})
    found = json.loads(row.found or "{}")
    by_key = {c["key"]: c for c in plugins.CATALOGUE}
    wanted = list(choice.get("plugins") or [])
    for pack_key in (c["pack"] for c in created):
        pack = await packs.get_pack(session, row.project_id, pack_key)
        wanted += (pack or {}).get("plugins") or []
        wanted += (pack or {}).get("mcp") or []
    have = {
        p.name
        for p in (
            await session.exec(
                select(AiPlugin).where(AiPlugin.project_id == row.project_id)
            )
        ).all()
    }
    installed, failed, mcp = [], [], []
    for key in dict.fromkeys(wanted):
        entry = by_key.get(key)
        if entry is None or not _wanted(entry, found):
            continue
        if entry["kind"] == "mcp":  # carried on the members by member_body
            mcp.append(entry["name"])
            continue
        if {key, entry["name"], entry.get("plugin")} & have:
            continue  # once per project
        try:
            plug = await plugins.install(
                session,
                row.project_id,
                source_kind="marketplace",
                source=entry["source"],
                plugin=entry.get("plugin"),
                skills=entry.get("skills"),
                roles=entry["roles"],
                by=by,
            )
            installed.append(plug.name)
            have.add(plug.name)
        except plugins.PluginError as exc:
            failed.append({"plugin": key, "why": str(exc)})
    row.applied_at = datetime.now(UTC).isoformat()
    session.add(row)
    await session.commit()
    return {
        "created": created,
        "skipped": skipped,
        "plugins": installed,
        "mcp": mcp,
        "plugin_failures": failed,
        "settings": ops.get(settings),
    }
