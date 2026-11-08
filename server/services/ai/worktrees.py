"""Where an AI works: one git worktree per ticket, and handing the code over
(design/screens/ai-operations.md, I, J, K; plan D4, D6, D7).

- One worktree per ticket, not per member: Dev, Reviewer and Tester of a ticket use it one after another.
- Beside the repository, never inside it: ``<repo>.worktrees/<KEY>`` (a worktree under the checkout shows as
  untracked files, and a local merge is refused while the main folder is dirty).
- A fixed path (``--resume`` needs the same folder), a branch ``ai/<KEY>-<slug>``, a port of its own, and the
  project's prepare command run once when it is made.
- Never removed while something is uncommitted.
- Hand-over by project setting: open a pull request (draft at Review, ready at Done), merge on this machine (only when
  a person asks: moving to Done or the Merge button, never while the main checkout is dirty, a conflict is rolled
  back and becomes a Needs you row), or leave the branch (pushed). Guessed from the remote when set to auto.

Projects turn this on in their AI team settings (``ops.worktrees.on``); off, runs keep the member's own folder.
"""

import asyncio
import json
import logging
import os
import re
import unicodedata
import shutil
import subprocess
from urllib.parse import urlparse
from datetime import UTC, datetime
from pathlib import Path

from sqlmodel import col, select

import database
from models import AiWorktree, Ticket

from . import ops, project_env
from .store import get_settings

logger = logging.getLogger(__name__)

PORT_SPAN = 19
PREPARE_TIMEOUT_S = 15 * 60


class WorktreeError(RuntimeError):
    """The worktree could not be made or used: a board fault, not the AI's."""


class WorktreeNeedsYou(WorktreeError):
    """The worktree cannot be made until a person sets the repository up (it has no commit yet): trying again
    on its own would only fail the same way."""


def _now() -> str:
    return datetime.now(UTC).isoformat()


# The board's own commits (a merge, what an AI left uncommitted) when the repository has no identity of its own;
# a person's configured name and email always win
_BOARD_IDENTITY = {
    "GIT_AUTHOR_NAME": "Kanban Board",
    "GIT_AUTHOR_EMAIL": "kanban-board@localhost",
    "GIT_COMMITTER_NAME": "Kanban Board",
    "GIT_COMMITTER_EMAIL": "kanban-board@localhost",
}
_HAS_IDENTITY: dict[str, bool] = {}


def _identity_env(cwd: str) -> dict[str, str]:
    if cwd not in _HAS_IDENTITY:
        try:
            out = subprocess.run(
                ["git", "config", "user.email"],
                cwd=cwd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=20,
            )
            _HAS_IDENTITY[cwd] = bool(out.stdout.strip())
        except (OSError, subprocess.TimeoutExpired):
            _HAS_IDENTITY[cwd] = True
    if _HAS_IDENTITY[cwd] or any(k in os.environ for k in _BOARD_IDENTITY):
        return {}
    return _BOARD_IDENTITY


def _git(
    cwd: str, *args: str, timeout: float = 120, check: bool = True
) -> subprocess.CompletedProcess:
    proc = subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        env={
            **os.environ,
            **_identity_env(cwd),
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_EDITOR": "true",
        },
    )
    if check and proc.returncode != 0:
        raise WorktreeError(
            f"git {' '.join(args[:3])} failed: {(proc.stderr or proc.stdout).strip()[:300]}"
        )
    return proc


async def git(
    cwd: str, *args: str, timeout: float = 120, check: bool = True
) -> subprocess.CompletedProcess:
    """Run git off the event loop."""
    return await asyncio.to_thread(_git, cwd, *args, timeout=timeout, check=check)


def is_github(remote: str | None) -> bool:
    """Whether a git remote is on github.com (its host, not "github.com" anywhere in the URL): https, ssh:// and
    scp-like git@github.com:owner/repo."""
    url = (remote or "").strip()
    if "://" not in url and "@" in url and ":" in url:
        url = "ssh://" + url.replace(":", "/", 1)  # git@github.com:owner/repo
    try:
        host = urlparse(url).hostname or ""
    except ValueError:
        return False
    return host.lower() == "github.com"


def repo_root(folder: str | None) -> str | None:
    """The top of the git repository that holds `folder`, or None when it is not one."""
    if not folder or not Path(folder).is_dir():
        return None
    try:
        out = _git(folder, "rev-parse", "--show-toplevel", check=False, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return None
    top = out.stdout.strip() if out.returncode == 0 else ""
    return top or None


def slug(title: str, limit: int = 32) -> str:
    """A branch-safe slug of a ticket title; accents are dropped, not the letters ("Tài liệu học" -> tai-lieu-hoc)."""
    plain = unicodedata.normalize(
        "NFKD", (title or "").replace("đ", "d").replace("Đ", "D")
    )
    plain = "".join(ch for ch in plain if not unicodedata.combining(ch))
    s = re.sub(r"[^a-z0-9]+", "-", plain.lower()).strip("-")
    return (s[:limit].rstrip("-")) or "work"


def path_for(repo: str, key: str) -> str:
    """Beside the repository: ``<repo>.worktrees/<KEY>``."""
    root = Path(repo)
    return str(root.parent / f"{root.name}.worktrees" / key)


async def _free_port(session, project_id: str, base: int) -> int:
    used = {
        w.port
        for w in (
            await session.exec(
                select(AiWorktree).where(
                    col(AiWorktree.state).in_(["active", "conflict", "kept"])
                )
            )
        ).all()
        if w.port
    }
    for port in range(base, base + PORT_SPAN + 1):
        if port not in used:
            return port
    raise WorktreeError(
        f"Every port from {base} to {base + PORT_SPAN} is taken by a worktree."
    )


async def for_ticket(session, ticket_id: str) -> AiWorktree | None:
    """The ticket's worktree row, or None."""
    return await session.get(AiWorktree, ticket_id)


async def ensure(
    session, ticket: Ticket, fallback_folder: str | None
) -> AiWorktree | None:
    """The ticket's worktree, made (and prepared) when it does not exist yet. None when the project has worktrees off
    or the folder is not a git repository (the run then uses the shared folder, as before).

    Raises:
        WorktreeError: It could not be made or prepared (a board fault).
    """
    settings = await get_settings(session, ticket.project_id)
    cfg = ops.get(settings)["worktrees"]
    if not cfg.get("on"):
        return None
    repo = repo_root(os.path.expanduser(cfg.get("repo") or fallback_folder or ""))
    if repo is None:
        return None
    row = await session.get(AiWorktree, ticket.id)
    if (
        row is not None
        and row.state in ("active", "conflict", "kept")
        and Path(row.path).is_dir()
    ):
        row.last_used_at = _now()
        session.add(row)
        await session.commit()
        return row
    if (
        await git(repo, "rev-parse", "--verify", "--quiet", "HEAD", check=False)
    ).returncode:
        raise WorktreeNeedsYou(
            f"The repository at {repo} has no commit yet, so the ticket's branch has nothing to start from. "
            'Make a first commit there (for example git commit --allow-empty -m "Start"), then retry the run.'
        )
    path = path_for(repo, ticket.id)
    branch = row.branch if row is not None else f"ai/{ticket.id}-{slug(ticket.title)}"
    base = (
        cfg.get("base_branch")
        or (await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).stdout.strip()
    )
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    exists = (
        await git(
            repo,
            "rev-parse",
            "--verify",
            "--quiet",
            f"refs/heads/{branch}",
            check=False,
        )
    ).returncode == 0
    reused = Path(path).is_dir() and (Path(path) / ".git").exists()
    if reused:
        pass  # left from an earlier session of the board: use it as it is
    elif exists:
        await git(repo, "worktree", "add", path, branch)
    else:
        await git(repo, "worktree", "add", "-b", branch, path, base)
    if not reused and row is not None:
        # a new folder (the ticket's earlier worktree was merged or removed): it is prepared again
        row.prepared_at = None
        row.prepare_s = None
    port = (
        row.port
        if row is not None and row.port
        else await _free_port(
            session, ticket.project_id, int(cfg.get("base_port") or 5180)
        )
    )
    if row is None:
        row = AiWorktree(
            ticket_id=ticket.id,
            project_id=ticket.project_id,
            repo=repo,
            path=path,
            branch=branch,
            base=base,
            port=port,
        )
    row.repo, row.path, row.branch, row.base, row.port = repo, path, branch, base, port
    row.state = "active"
    row.last_used_at = _now()
    session.add(row)
    await session.commit()
    prepare = (cfg.get("prepare") or "").strip()
    if prepare and not row.prepared_at:
        started = datetime.now(UTC)
        try:
            out = await asyncio.to_thread(
                subprocess.run,
                prepare,
                shell=True,
                cwd=path,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=PREPARE_TIMEOUT_S,
                env={
                    **project_env.with_path(None, project_env.extra(settings)),
                    "PORT": str(port),
                },
            )
        except subprocess.TimeoutExpired as exc:
            raise WorktreeError(
                f"The prepare command `{prepare}` did not finish in {PREPARE_TIMEOUT_S // 60} minutes."
            ) from exc
        if out.returncode != 0:
            tail = (out.stderr or out.stdout).strip().splitlines()[-3:]
            raise WorktreeError(
                f"The prepare command `{prepare}` failed: {' '.join(tail)[:300]}"
            )
        row.prepared_at = _now()
        row.prepare_s = int((datetime.now(UTC) - started).total_seconds())
        session.add(row)
        await session.commit()
    return row


async def status(row: AiWorktree) -> dict:
    """What git says about a worktree now: files changed and not committed, size, ahead of its base."""
    out = {
        "uncommitted": [],
        "size_mb": None,
        "exists": Path(row.path).is_dir(),
        "ahead": None,
    }
    if not out["exists"]:
        return out
    lines = await _porcelain(row.path)
    out["uncommitted"] = [line[3:] for line in lines][:50]
    out["outputs"] = outputs_in(lines)[:50]
    ahead = await git(row.path, "rev-list", "--count", f"{row.base}..HEAD", check=False)
    out["ahead"] = (
        int(ahead.stdout.strip())
        if ahead.returncode == 0 and ahead.stdout.strip().isdigit()
        else None
    )
    out["size_mb"] = await asyncio.to_thread(_size_mb, row.path)
    return out


# What a run leaves behind that a person should see, not the code: screenshots, logs, reports, exports. Committed by
# a hand-over they would land in the product's branch; left loose they keep the worktree from being cleaned. They go to
# the ticket's Workspace instead (issue #269). Only untracked files count: a changed tracked file is always code.
_OUTPUT_DIRS = {
    "qa", "evidence", "screenshots", "screenshot", "shots", "test-results", "playwright-report", "reports",
    "report", "output", "outputs", "out-qa", "artifacts", "artefacts", ".look", "tmp", "temp", "scratch",
}  # fmt: skip
_OUTPUT_SUFFIXES = {".log", ".har", ".trace", ".webm", ".mov", ".mp4", ".gif"}
# documents and pictures at the top of the worktree are a run's outputs too (code keeps its pictures in a folder)
_TOP_LEVEL_OUTPUTS = {
    ".png", ".jpg", ".jpeg", ".webp", ".pdf", ".xlsx", ".xls", ".docx", ".pptx", ".csv", ".zip", ".html",
}  # fmt: skip


def is_output(rel: str) -> bool:
    """Whether an untracked file is a run's output (a screenshot, a log, a report) rather than code."""
    p = Path(rel)
    folders = [part.lower() for part in p.parts[:-1]]
    if any(
        f in _OUTPUT_DIRS
        or f.endswith(("_work", "-work", "_output", "-output", "evidence"))
        for f in folders
    ):
        return True
    suffix = p.suffix.lower()
    return suffix in _OUTPUT_SUFFIXES or (not folders and suffix in _TOP_LEVEL_OUTPUTS)


async def _porcelain(path: str) -> list[str]:
    """`git status --porcelain` with every untracked file listed by itself (not its folder)."""
    st = await git(path, "status", "--porcelain", "-uall", check=False)
    return [line for line in st.stdout.splitlines() if line.strip()]


def outputs_in(lines: list[str]) -> list[str]:
    """The untracked outputs among `git status --porcelain` lines."""
    return [line[3:] for line in lines if line.startswith("??") and is_output(line[3:])]


async def move_outputs(ticket_id: str) -> dict:
    """Move the outputs a run left in the ticket's worktree (untracked screenshots, logs, reports) to the ticket's
    Workspace, under ``from-worktree/<date-time>/`` with their paths kept, so they are where a person looks and never
    end up committed. Returns ``{moved, to}``, or ``{moved: [], left, reason}`` when they cannot be moved (Workspace off,
    no worktree)."""
    from services import workspace as svc_workspace

    async with database.async_session() as session:
        row = await session.get(AiWorktree, ticket_id)
        if row is None or row.state == "removed" or not Path(row.path).is_dir():
            return {"moved": [], "left": [], "reason": "This ticket has no worktree."}
        found = outputs_in(await _porcelain(row.path))
        if not found:
            return {"moved": [], "left": []}
        ws = await svc_workspace.get_workspace_settings(session)
        if not ws.enabled:
            return {
                "moved": [],
                "left": found,
                "reason": "Workspace is off (Settings › Workspace), so they stay in the worktree.",
            }
        root = await svc_workspace.init_ticket_workspace(session, ticket_id)
    dest = root / "from-worktree" / datetime.now().strftime("%Y-%m-%d-%H%M%S")
    base = Path(row.path).resolve()

    def _move() -> list[str]:
        moved = []
        for rel in found:
            src = (base / rel).resolve()
            if not src.is_file() or base not in src.parents:
                continue
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(target))
            moved.append(rel)
            parent = src.parent
            while parent != base and parent.is_dir() and not any(parent.iterdir()):
                parent.rmdir()
                parent = parent.parent
        return moved

    moved = await asyncio.to_thread(_move)
    return {"moved": moved, "to": str(dest)}


def _note_for(result: dict, worktree: str) -> str | None:
    """The work-log note that tells the team (and the PM) where a run's outputs are now."""
    moved, left = result.get("moved") or [], result.get("left") or []
    if moved:
        names = "\n".join(f"- `{m}`" for m in moved[:20])
        more = f"\n- … and {len(moved) - 20} more" if len(moved) > 20 else ""
        return (
            f"Moved {len(moved)} output file{'s' if len(moved) != 1 else ''} the run left in the worktree to the "
            f"ticket's Workspace, `{result['to']}`:\n{names}{more}\n\nThey are not committed; the worktree "
            "holds only code."
        )
    if left:
        names = "\n".join(f"- `{m}`" for m in left[:20])
        return (
            f"{len(left)} output file{'s' if len(left) != 1 else ''} the run left are still in the worktree "
            f"`{worktree}` ({result.get('reason') or 'not moved'}):\n{names}\n\nThey keep the worktree from being "
            "cleaned: move them, commit them or delete them (the ticket's AI › Code panel)."
        )
    return None


async def tidy_after_run(ticket_id: str, run_id: str) -> dict | None:
    """A run of the ticket ended: its outputs go from the worktree to the Workspace, and the work log says where."""
    from models import AiRun

    async with database.async_session() as session:
        run = await session.get(AiRun, run_id)
        row = await session.get(AiWorktree, ticket_id)
    if run is None or row is None or run.state not in _RUN_ENDED:
        return None  # a run waiting for an answer comes back to its files
    if await _run_is_working(ticket_id):
        return None  # another run works there now; it tidies when it ends
    result = await move_outputs(ticket_id)
    await log_tidy(ticket_id, result)
    return result


_RUN_ENDED = ("finished", "failed", "cancelled", "timed_out")


async def log_tidy(ticket_id: str, result: dict, by: str | None = None) -> None:
    """Say in the ticket's work log where the outputs went (or why they stayed)."""
    from services import tickets as svc_tickets

    async with database.async_session() as session:
        row = await session.get(AiWorktree, ticket_id)
        note = _note_for(result, row.path if row else "")
        if note:
            await svc_tickets.add_work_log(
                session, ticket_id, author=by or "Kanban Board", role="Other", note=note
            )


async def commit_now(ticket_id: str, *, by: str) -> dict:
    """A person commits what is left in the worktree on its branch: the code, never the outputs (they go to the
    Workspace first, or stay out of the commit when it is off). Returns ``{committed, moved, left}``."""
    async with database.async_session() as session:
        row = await session.get(AiWorktree, ticket_id)
    if row is None or row.state == "removed" or not Path(row.path).is_dir():
        raise WorktreeError("This ticket has no worktree.")
    before = await _porcelain(row.path)
    if not before:
        return {"committed": False, "moved": [], "left": []}
    committed = await _commit_leftovers(
        row, f"{ticket_id}: changes left in the worktree, committed by {by}"
    )
    left = outputs_in(await _porcelain(row.path))
    return {"committed": committed, "left": left}


async def brief(session, ticket_id: str) -> dict | None:
    """The ticket's worktree for an AI reading the ticket: where it is, its branch, and what is not committed (outputs
    apart from code), so nobody reports a vague "not cleaned"."""
    row = await session.get(AiWorktree, ticket_id)
    if row is None or row.state == "removed":
        return None
    out = {
        "path": row.path,
        "branch": row.branch,
        "state": row.state,
        "exists": Path(row.path).is_dir(),
    }
    if out["exists"]:
        lines = await _porcelain(row.path)
        outputs = outputs_in(lines)
        out["uncommitted"] = [line[3:] for line in lines][:30]
        out["outputs"] = outputs[:30]
        if lines:
            out["note"] = (
                f"{len(lines)} file{'s' if len(lines) != 1 else ''} not committed"
                + (
                    f", {len(outputs)} of them outputs (screenshots, logs, reports)"
                    if outputs
                    else ""
                )
                + ": the worktree is not removed until a person commits, moves or discards them."
            )
    return out


def _size_mb(path: str) -> float:
    total = 0
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d != ".git"]
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return round(total / (1024 * 1024), 1)


def to_dict(row: AiWorktree, live: dict | None = None) -> dict:
    """A worktree for the API."""
    return {
        "ticket_id": row.ticket_id,
        "project_id": row.project_id,
        "repo": row.repo,
        "path": row.path,
        "branch": row.branch,
        "base": row.base,
        "port": row.port,
        "state": row.state,
        "handover": row.handover,
        "pr_url": row.pr_url,
        "pr_number": row.pr_number,
        "conflict_files": json.loads(row.conflict_files or "[]"),
        "prepared_at": row.prepared_at,
        "prepare_s": row.prepare_s,
        "created_at": row.created_at,
        "last_used_at": row.last_used_at,
        "merged_at": row.merged_at,
        **({"live": live} if live is not None else {}),
    }


async def list_for_project(session, project_id: str) -> list[dict]:
    """Every worktree of a project with what git says now."""
    rows = (
        await session.exec(
            select(AiWorktree)
            .where(AiWorktree.project_id == project_id, AiWorktree.state != "removed")
            .order_by(AiWorktree.created_at, AiWorktree.ticket_id)
        )
    ).all()
    return [to_dict(r, await status(r)) for r in rows]


async def remove(session, ticket_id: str, *, force: bool = False) -> AiWorktree:
    """Remove a ticket's worktree (never with uncommitted work unless `force`) and give its port back.

    Raises:
        WorktreeError: Something is uncommitted, or git refused.
    """
    row = await session.get(AiWorktree, ticket_id)
    if row is None:
        raise WorktreeError("This ticket has no worktree.")
    live = await status(row)
    if live["uncommitted"] and not force:
        raise WorktreeError(
            f"{len(live['uncommitted'])} files are not committed: keep it, or commit them first."
        )
    if live["exists"]:
        await git(
            row.repo,
            "worktree",
            "remove",
            *(["--force"] if force else []),
            row.path,
            check=False,
        )
        if Path(row.path).exists():
            shutil.rmtree(row.path, ignore_errors=True)
        await git(row.repo, "worktree", "prune", check=False)
    row.state = "removed"
    row.port = None
    row.prepared_at = (
        None  # a worktree made again for the ticket runs the prepare command again
    )
    row.prepare_s = None
    session.add(row)
    await session.commit()
    return row


# ---------------------------------------------------------------------------
# Hand-over (design J)
# ---------------------------------------------------------------------------


async def guess_route(repo: str) -> str:
    """auto → pr (a GitHub remote and gh signed in), local (no remote), or branch (another host)."""
    remote = (
        await git(repo, "remote", "get-url", "origin", check=False)
    ).stdout.strip()
    if not remote:
        return "local"
    if is_github(remote) and shutil.which("gh"):
        try:
            auth = await asyncio.to_thread(
                subprocess.run,
                ["gh", "auth", "status"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=20,
                cwd=repo,
            )
            if auth.returncode == 0:
                return "pr"
        except (OSError, subprocess.TimeoutExpired):
            pass
    return "branch"


async def route_for(session, row: AiWorktree) -> str:
    """The hand-over route of a ticket: its own override, else the project's, guessed when auto."""
    if row.handover and row.handover != "auto":
        return row.handover
    settings = await get_settings(session, row.project_id)
    chosen = ops.get(settings)["worktrees"].get("handover") or "auto"
    return chosen if chosen != "auto" else await guess_route(row.repo)


async def _commit_leftovers(row: AiWorktree, message: str) -> bool:
    """Commit what the AI left uncommitted on its branch (a hand-over never drops work). True when it committed. Its
    outputs (screenshots, logs, reports) go to the Workspace first: they are not code."""
    result = await move_outputs(row.ticket_id)
    await log_tidy(row.ticket_id, result)
    if result.get("left"):
        # the Workspace is off: an output is still not code, so it is left out of the commit
        await git(row.path, "add", "-A")
        await git(row.path, "reset", "-q", "--", *result["left"], check=False)
        st = await git(row.path, "diff", "--cached", "--quiet", check=False)
        if st.returncode == 0:
            return False
        await git(row.path, "commit", "-m", message, "--no-verify", check=False)
        return True
    st = await git(row.path, "status", "--porcelain", check=False)
    if not st.stdout.strip():
        return False
    await git(row.path, "add", "-A")
    await git(row.path, "commit", "-m", message, "--no-verify", check=False)
    return True


async def on_review(ticket_id: str) -> dict | None:
    """The ticket reached Review: push the branch, and open a draft pull request when the route says so."""
    async with database.async_session() as session:
        row = await session.get(AiWorktree, ticket_id)
        ticket = await session.get(Ticket, ticket_id)
        if row is None or ticket is None or row.state != "active":
            return None
        route = await route_for(session, row)
    if route == "local":
        return {"route": route}
    await _commit_leftovers(
        row, f"{ticket_id}: work in progress handed over for review"
    )
    push = await git(
        row.path, "push", "-u", "origin", row.branch, check=False, timeout=180
    )
    if push.returncode != 0:
        return {
            "route": route,
            "error": f"git push failed: {push.stderr.strip()[:200]}",
        }
    if route != "pr" or row.pr_url:
        return {"route": route, "pushed": True}
    body = f"{ticket.description or ''}\n\nOpened by the Kanban board for {ticket_id}. It becomes ready for review when the ticket reaches Done."
    try:
        out = await asyncio.to_thread(
            subprocess.run,
            [
                "gh",
                "pr",
                "create",
                "--draft",
                "--head",
                row.branch,
                "--base",
                row.base,
                "--title",
                f"{ticket_id}: {ticket.title}",
                "--body",
                body.strip(),
            ],
            cwd=row.path,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"route": route, "error": str(exc)[:200]}
    if out.returncode != 0:
        return {
            "route": route,
            "error": f"gh pr create failed: {out.stderr.strip()[:200]}",
        }
    url = out.stdout.strip().splitlines()[-1] if out.stdout.strip() else None
    async with database.async_session() as session:
        row = await session.get(AiWorktree, ticket_id)
        row.pr_url = url
        m = re.search(r"/pull/(\d+)", url or "")
        row.pr_number = int(m.group(1)) if m else None
        session.add(row)
        await session.commit()
    return {"route": route, "pr_url": url}


async def merge(ticket_id: str, *, by: str) -> dict:
    """Merge a ticket's branch into the main checkout (only when a person asks). Refused while the main checkout is
    dirty; a conflict is rolled back, the worktree is left exactly as it was, and a Needs you row offers who resolves
    it. On success the worktree is removed and its port given back.

    Returns:
        {"merged": bool, "conflict": [...files], "refused": "why"}.
    """
    from services import notifications as centre

    async with database.async_session() as session:
        row = await session.get(AiWorktree, ticket_id)
        if row is None or row.state not in ("active", "conflict", "kept"):
            return {"merged": False, "refused": "This ticket has no worktree to merge."}
        route = await route_for(session, row)
    if route == "pr":
        if row.pr_number:
            await asyncio.to_thread(
                subprocess.run,
                ["gh", "pr", "ready", str(row.pr_number)],
                cwd=row.path,
                capture_output=True,
                timeout=60,
            )
        return {"merged": False, "pr_ready": bool(row.pr_number), "pr_url": row.pr_url}
    if route == "branch":
        await _commit_leftovers(row, f"{ticket_id}: done")
        await git(
            row.path, "push", "-u", "origin", row.branch, check=False, timeout=180
        )
        return {"merged": False, "pushed": True}
    dirty = (
        await git(row.repo, "status", "--porcelain", check=False)
    ).stdout.splitlines()
    dirty = [
        d[3:] for d in dirty if d.strip() and not d[3:].startswith(Path(row.path).name)
    ]
    if dirty:
        return {
            "merged": False,
            "refused": "The main checkout has uncommitted changes: "
            + ", ".join(dirty[:8]),
        }
    await _commit_leftovers(row, f"{ticket_id}: done")
    current = (await git(row.repo, "rev-parse", "--abbrev-ref", "HEAD")).stdout.strip()
    if current != row.base:
        return {
            "merged": False,
            "refused": f"The main checkout is on {current}, not {row.base}.",
        }
    out = await git(
        row.repo,
        "merge",
        "--no-ff",
        "--no-edit",
        row.branch,
        "-m",
        f"Merge {ticket_id}: {row.branch}",
        check=False,
        timeout=300,
    )
    if out.returncode != 0:
        files = (
            await git(row.repo, "diff", "--name-only", "--diff-filter=U", check=False)
        ).stdout.split()
        await git(row.repo, "merge", "--abort", check=False)
        if not files:
            # not a conflict (a hook, a lock, git itself): say what git said instead of naming no files
            return {
                "merged": False,
                "refused": "git could not merge: "
                + (out.stderr or out.stdout).strip()[:300],
            }
        async with database.async_session() as session:
            row = await session.get(AiWorktree, ticket_id)
            row.state = "conflict"
            row.conflict_files = json.dumps(files[:50])
            session.add(row)
            await session.commit()
            await centre.emit(
                "merge_conflict",
                project_id=row.project_id,
                recipients=await centre.owners_and_admins(session, row.project_id),
                title=f"{ticket_id} cannot be merged: {row.base} has moved",
                body=(
                    f"{len(files)} file{'s differ' if len(files) != 1 else ' differs'} from {row.base}: "
                    + ", ".join(files[:4])
                    + ". The merge was not started, so the worktree is exactly as the AI left it."
                ),
                target_kind="ticket",
                target_id=ticket_id,
                ticket_id=ticket_id,
                data={"files": files[:50]},
                session=session,
            )
        return {"merged": False, "conflict": files}
    async with database.async_session() as session:
        row = await session.get(AiWorktree, ticket_id)
        row.merged_at = _now()
        row.state = "merged"
        session.add(row)
        await session.commit()
        try:
            await remove(session, ticket_id)
        except WorktreeError:
            row = await session.get(AiWorktree, ticket_id)
            row.state = "merged"
            session.add(row)
            await session.commit()
    return {"merged": True}


def on_status(ticket_id: str, status: str, previous: str, *, by_ai: bool) -> None:
    """Hand-over on the ticket's moves: Review pushes (and opens the draft PR), Done merges or marks the PR ready, but
    only when a person moved it. In the background, never in the request.

    A move to Review the Board AI made (its changes carry "suggested by", whether it acted by itself in its Undo tier
    or a person applied its card) hands nothing over: a push and a pull request post outside the board, which the
    Board AI never does by itself, and its Undo could not take them back. The person's own move to Review (or the AI
    member's that worked on the ticket) does."""
    if status == previous or status not in ("review", "done"):
        return
    if status == "done" and by_ai:
        return  # no AI ever merges (D7)
    from services import activity as act

    if status == "review" and act._suggested.get():
        return  # a Board AI move (Done is always asked first, so a person confirmed that one)

    async def go() -> None:
        try:
            if status == "review":
                # the AI may have moved its own ticket mid-run: while its CLI may still be writing, the hand-over
                # waits for the run to stop (``after_run``); whichever side finds it free takes it, once
                _DEFERRED.add(ticket_id)
                if await _run_is_working(ticket_id) or ticket_id not in _DEFERRED:
                    return
                _DEFERRED.discard(ticket_id)
                await on_review(ticket_id)
            else:
                await merge(ticket_id, by="person")
        except Exception:  # noqa: BLE001 - a hand-over that fails must never disturb the board
            logger.exception("Hand-over of %s failed", ticket_id)

    _spawn(go())


async def _run_is_working(ticket_id: str) -> bool:
    """Whether a CLI run is working in the ticket's worktree right now."""
    from models import AiRun

    async with database.async_session() as session:
        row = (
            await session.exec(
                select(AiRun).where(
                    AiRun.ticket_id == ticket_id,
                    col(AiRun.state).in_(["starting", "running"]),
                )
            )
        ).first()
    return row is not None


def after_run(ticket_id: str) -> None:
    """A run of the ticket stopped (its CLI exited): a Review hand-over that waited for it goes now, if the ticket is
    still in Review and nothing else works in its worktree."""
    if ticket_id not in _DEFERRED:
        return

    async def go() -> None:
        try:
            if await _run_is_working(ticket_id) or ticket_id not in _DEFERRED:
                return  # another run took the worktree (it hands over when that one stops), or it was taken
            _DEFERRED.discard(ticket_id)
            async with database.async_session() as session:
                ticket = await session.get(Ticket, ticket_id)
            if ticket is not None and ticket.status == "review":
                await on_review(ticket_id)
        except Exception:  # noqa: BLE001 - a hand-over that fails must never disturb the board
            logger.exception("Hand-over of %s failed", ticket_id)

    _spawn(go())


def tidy_later(ticket_id: str | None, run_id: str) -> None:
    """``tidy_after_run`` in the background, never failing the run's end."""
    if not ticket_id:
        return

    async def go() -> None:
        try:
            await tidy_after_run(ticket_id, run_id)
        except Exception:  # noqa: BLE001 - tidying must never disturb the board
            logger.exception("Tidying the worktree of %s failed", ticket_id)

    _spawn(go())


def _spawn(coro) -> None:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        coro.close()
        return
    task = loop.create_task(coro)
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)


_TASKS: set[asyncio.Task] = set()
# tickets moved to Review while their run was still working: handed over when it stops
_DEFERRED: set[str] = set()
