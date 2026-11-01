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
import json
import os
import re
import shutil
import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from models import AiRepoScan

from . import ops, packs, plugins
from .store import get_settings

TRIAL_TIMEOUT_S = 10 * 60
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
        for m in re.finditer(r"^\s*-?\s*run:\s*(\|)?\s*(.*)$", text, re.MULTILINE):
            first = m.group(2).strip()
            if m.group(1):  # a block: take the next indented lines
                tail = text[m.end() :].splitlines()[1:8]
                lines = [t.strip() for t in tail if t.startswith(" ") and t.strip()]
            else:
                lines = [first]
            out += [ln for ln in lines if ln and _CI_HINT.search(ln)]
    return list(dict.fromkeys(out))[:20]


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
    pkg_files = [
        p
        for p in root.rglob("package.json")
        if "node_modules" not in p.parts and ".git" not in p.parts
    ][:12]
    for pkg in pkg_files:
        data = _json(pkg)
        rel = str(pkg.parent.relative_to(root)) or "."
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
        if ".git" not in p.parts and ".venv" not in p.parts
    ][:8]:
        text = _read(py)
        rel = str(py.parent.relative_to(root)) or "."
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
    return found


def _pkg_cmd(pkg: dict, script: str) -> str | None:
    """The npm command of a package script, run from the package's folder (a test run never watches)."""
    scripts = pkg.get("scripts") or {}
    if script not in scripts:
        return None
    prefix = "" if pkg["path"] == "." else f"cd {pkg['path']} && "
    if script == "test":
        watches = "vitest" in scripts["test"] and "run" not in scripts["test"].split()
        return f"{prefix}npm test" + (" -- --run" if watches else "")
    return f"{prefix}npm run {script}"


def suggest(found: dict) -> dict:
    """What the scan proposes; a person changes any of it before anything is created."""
    tests, lints, builds, prepares = [], [], [], []
    for pkg in found["packages"]:
        if pkg["kind"] == "node":
            prefix = "" if pkg["path"] == "." else f"cd {pkg['path']} && "
            for name, bucket in (("test", tests), ("lint", lints), ("build", builds)):
                cmd = _pkg_cmd(pkg, name)
                if cmd:
                    bucket.append(cmd)
            prepares.append(f"{prefix}npm ci")
        elif pkg["kind"] == "python":
            prefix = "" if pkg["path"] == "." else f"cd {pkg['path']} && "
            runner = (
                "uv run "
                if pkg.get("manager") == "uv"
                else ("poetry run " if pkg.get("manager") == "poetry" else "")
            )
            if pkg.get("pytest"):
                tests.append(f"{prefix}{runner}pytest -q")
            if pkg.get("ruff"):
                lints.append(f"{prefix}{runner}ruff check .")
            prepares.append(
                f"{prefix}{'uv sync' if pkg.get('manager') == 'uv' else ('poetry install' if pkg.get('manager') == 'poetry' else 'pip install -e .')}"
            )
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
    names = {
        "triage": "Triage",
        "pm": "PM",
        "ba": "BA",
        "designer": "Designer",
        "dev": "Dev",
        "qa": "QA",
        "reviewer": "Reviewer",
        "user_tester": "User tester",
    }
    team = [{"pack": r, "name": names[r]} for r in roles]
    suggested_plugins = [
        c["key"] for c in plugins.CATALOGUE if set(c["roles"]) & set(roles)
    ]
    handover = (
        "local"
        if not found.get("remote")
        else ("pr" if "github.com" in (found.get("remote") or "") else "branch")
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


def _try(folder: str, prepare: str, test: str) -> dict:
    """Run the prepare and test commands once in a scratch worktree (or a copy), and remove it afterwards."""
    out: dict = {"prepare": None, "test": None}
    root = Path(folder)
    scratch = Path(tempfile.mkdtemp(prefix="kanban-scan-"))
    made_worktree = False
    try:
        if (root / ".git").exists():
            res = subprocess.run(
                ["git", "worktree", "add", "--detach", str(scratch / "wt"), "HEAD"],
                cwd=root,
                capture_output=True,
                text=True,
                timeout=60,
            )
            made_worktree = res.returncode == 0
        work = scratch / "wt"
        if not made_worktree:
            shutil.copytree(
                root,
                work,
                ignore=shutil.ignore_patterns(".git", "node_modules", ".venv"),
            )
        for name, cmd in (("prepare", prepare), ("test", test)):
            if not cmd:
                continue
            started = datetime.now(UTC)
            try:
                res = subprocess.run(
                    cmd,
                    shell=True,
                    cwd=work,
                    capture_output=True,
                    text=True,
                    timeout=TRIAL_TIMEOUT_S,
                )
                tail = (res.stdout + res.stderr).strip().splitlines()[-6:]
                out[name] = {
                    "command": cmd,
                    "ok": res.returncode == 0,
                    "exit_code": res.returncode,
                    "seconds": int((datetime.now(UTC) - started).total_seconds()),
                    "tail": tail,
                }
            except subprocess.TimeoutExpired:
                out[name] = {
                    "command": cmd,
                    "ok": False,
                    "exit_code": None,
                    "seconds": TRIAL_TIMEOUT_S,
                    "tail": ["Timed out."],
                }
            if not out[name]["ok"]:
                break
    finally:
        if made_worktree:
            subprocess.run(
                ["git", "worktree", "remove", "--force", str(scratch / "wt")],
                cwd=root,
                capture_output=True,
                timeout=60,
            )
        shutil.rmtree(scratch, ignore_errors=True)
    return out


async def run_scan(
    session, project_id: str, folder: str, *, trial: bool = True
) -> AiRepoScan:
    """Scan, suggest and (by default) try the commands; nothing is created."""
    found = await asyncio.to_thread(scan, folder)
    proposal = suggest(found)
    tried = (
        await asyncio.to_thread(
            _try, found["folder"], proposal["prepare"], proposal["commands"]["test"]
        )
        if trial
        else {}
    )
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


def to_dict(row: AiRepoScan) -> dict:
    """A scan for the API."""
    return {
        "id": row.id,
        "project_id": row.project_id,
        "folder": row.folder,
        "found": json.loads(row.found or "{}"),
        "suggested": json.loads(row.suggested or "{}"),
        "trial": json.loads(row.trial or "{}"),
        "applied_at": row.applied_at,
        "created_at": row.created_at,
    }


async def apply(session, scan_id: str, choice: dict, *, by: str, create_member) -> dict:
    """Create what the person confirmed: the members from packs, the project's settings, the plugins.

    `choice` is the suggestion as the person edited it: {team: [{pack, name}], commands, prepare, base_port,
    workflow_default, handover, worktrees, plugins: [catalogue keys], account_id}. `create_member(body)` makes one AI
    member through the member service and returns it.
    """
    row = await session.get(AiRepoScan, scan_id)
    if row is None:
        raise LookupError("Scan not found.")
    settings = await get_settings(session, row.project_id)
    patch = {
        "commands": choice.get("commands") or {},
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
    roles_of = {c["key"]: c for c in plugins.CATALOGUE}
    installed, failed = [], []
    for key in choice.get("plugins") or []:
        entry = roles_of.get(key)
        if entry is None or entry["kind"] != "plugin":
            continue
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
        except plugins.PluginError as exc:
            failed.append({"plugin": key, "why": str(exc)})
    row.applied_at = datetime.now(UTC).isoformat()
    session.add(row)
    await session.commit()
    return {
        "created": created,
        "skipped": skipped,
        "plugins": installed,
        "plugin_failures": failed,
        "settings": ops.get(settings),
    }
