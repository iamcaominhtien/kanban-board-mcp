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
from datetime import UTC, datetime
from pathlib import Path

from sqlmodel import col, select

from models import AiAccount, AiPlugin, AiRepoScan

from . import ops, packs, plugins, worktrees
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
    found["fingerprint"] = fingerprint(root)
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


_ROLE_NAMES = {
    "triage": "Triage",
    "pm": "PM",
    "ba": "BA",
    "designer": "Designer",
    "dev": "Dev",
    "qa": "QA",
    "reviewer": "Reviewer",
    "user_tester": "User tester",
}


def _wanted(entry: dict, found: dict) -> bool:
    """A browser tool (`ui`) is only for a project with a UI."""
    return bool(found.get("ui")) or not entry.get("ui")


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
            if pkg.get("manager") in ("uv", "poetry"):
                prepares.append(
                    f"{prefix}{'uv sync' if pkg.get('manager') == 'uv' else 'poetry install'}"
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
    session,
    project_id: str,
    folder: str,
    *,
    trial: bool = True,
    refine: bool = False,
) -> AiRepoScan:
    """Scan, suggest and (by default) try the commands; nothing is created. `refine` asks a light model to improve
    the role and plugin suggestions (it fails soft back to the code's)."""
    found = await asyncio.to_thread(scan, folder)
    proposal = suggest(found)
    if refine:
        proposal = await refine_suggestion(session, project_id, found, proposal)
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


REFINE_PROMPT = (
    "You help set up an AI team for a code repository. From these facts, choose the roles and plugins that fit. "
    'Reply with JSON only: {"roles": [role keys], "plugins": [plugin keys], "why": "one short sentence"}.\n'
    "Roles you may use: triage, pm, ba, designer, dev, qa, reviewer, user_tester. Keep dev. "
    "designer and user_tester only when the repository has a web UI.\n"
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
