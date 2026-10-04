"""Thin wrapper around GitPython for the per-project git repository.

All functions are synchronous (GitPython shells out to ``git``); async callers
should run them with ``asyncio.to_thread``.
"""

import os
from dataclasses import dataclass

from git import GitCommandError, InvalidGitRepositoryError, NoSuchPathError, Repo


class GitRepoError(ValueError):
    """Raised for any user-facing git problem (bad path, bad name, missing ref)."""


@dataclass(frozen=True)
class BranchInfo:
    name: str
    commit_hash: str
    ahead_count: int
    behind_count: int


def normalize_repo_path(path: str) -> str:
    """Resolve ``path`` and verify it is the root of a git working tree."""
    resolved = os.path.realpath(os.path.expanduser(path.strip()))
    open_repo(resolved)
    return resolved


def open_repo(path: str) -> Repo:
    try:
        return Repo(path)
    except (InvalidGitRepositoryError, NoSuchPathError) as exc:
        raise GitRepoError(f"Not a git repository: {path}") from exc


def _resolve_ref(repo: Repo, name: str) -> str:
    """Return a verified ref for ``name``, falling back to ``origin/<name>``."""
    for candidate in (name, f"origin/{name}"):
        try:
            repo.git.rev_parse("--verify", "--quiet", f"{candidate}^{{commit}}")
            return candidate
        except GitCommandError:
            continue
    raise GitRepoError(f"Branch '{name}' does not exist in the repository")


def validate_branch_name(repo: Repo, name: str) -> None:
    try:
        repo.git.check_ref_format("--branch", name)
    except GitCommandError as exc:
        raise GitRepoError(f"Invalid branch name: {name!r}") from exc


def branch_exists(repo: Repo, name: str) -> bool:
    return any(head.name == name for head in repo.heads)


def create_branch(repo: Repo, name: str, base: str) -> BranchInfo:
    """Create local branch ``name`` at ``base`` (no checkout, working tree untouched)."""
    validate_branch_name(repo, name)
    if branch_exists(repo, name):
        raise GitRepoError(f"Branch '{name}' already exists")
    base_ref = _resolve_ref(repo, base)
    try:
        repo.git.branch(name, base_ref)
    except GitCommandError as exc:
        raise GitRepoError(f"Could not create branch '{name}': {exc.stderr.strip()}") from exc
    return branch_info(repo, name, base)


def branch_info(repo: Repo, name: str, base: str) -> BranchInfo:
    """Tip commit plus ahead/behind counts of ``name`` relative to ``base``."""
    branch_ref = _resolve_ref(repo, name)
    base_ref = _resolve_ref(repo, base)
    commit = repo.git.rev_parse(branch_ref)
    behind, ahead = repo.git.rev_list("--left-right", "--count", f"{base_ref}...{branch_ref}").split()
    return BranchInfo(name=name, commit_hash=commit, ahead_count=int(ahead), behind_count=int(behind))


def list_local_branches(repo: Repo) -> list[str]:
    return sorted(head.name for head in repo.heads)


def resolve_worktree_path(
    template: str,
    repo_path: str,
    project_prefix: str,
    ticket_id: str,
    branch_name: str,
) -> str:
    """Resolve a worktree path template with tokens {project}, {ticket}, {ticket_id}, {branch}, {repo}."""
    sanitized_branch = branch_name.replace("/", "-")
    resolved = (
        template.replace("{project}", project_prefix)
        .replace("{ticket_id}", ticket_id)
        .replace("{ticket}", ticket_id)
        .replace("{branch}", sanitized_branch)
        .replace("{repo}", os.path.basename(repo_path))
    )
    expanded = os.path.expanduser(resolved.strip())
    if not os.path.isabs(expanded):
        expanded = os.path.normpath(os.path.join(repo_path, expanded))
    return os.path.normpath(expanded)


def add_worktree(repo: Repo, path: str, branch: str) -> str:
    """Create a git worktree at ``path`` for branch ``branch``."""
    resolved = os.path.realpath(os.path.expanduser(path.strip()))
    if os.path.exists(resolved):
        raise GitRepoError(f"Target worktree path already exists: {resolved}")
    parent_dir = os.path.dirname(resolved)
    if parent_dir and not os.path.exists(parent_dir):
        os.makedirs(parent_dir, exist_ok=True)
    try:
        repo.git.worktree("add", resolved, branch)
    except GitCommandError as exc:
        raise GitRepoError(
            f"Could not create worktree at '{resolved}': {exc.stderr.strip()}"
        ) from exc
    return resolved


def remove_worktree(repo: Repo, path: str, force: bool = False) -> None:
    """Remove the git worktree at ``path``.

    A worktree that is already gone from disk is not an error (we just prune
    the stale registration); any other failure is raised so it is not hidden.
    """
    resolved = os.path.realpath(os.path.expanduser(path.strip()))
    args = ["remove"]
    if force:
        args.append("--force")
    args.append(resolved)
    try:
        repo.git.worktree(*args)
    except GitCommandError as exc:
        if os.path.exists(resolved):
            raise GitRepoError(
                f"Could not remove worktree '{resolved}': {exc.stderr.strip()}"
            ) from exc
    try:
        repo.git.worktree("prune")
    except GitCommandError:
        pass


def delete_branch(repo: Repo, name: str, force: bool = False) -> None:
    """Delete local branch ``name``. Without ``force`` git refuses unmerged branches."""
    if not branch_exists(repo, name):
        return  # already gone, nothing to delete
    try:
        repo.git.branch("-D" if force else "-d", name)
    except GitCommandError as exc:
        raise GitRepoError(
            f"Could not delete git branch '{name}': {exc.stderr.strip()}"
        ) from exc


def list_worktrees(repo: Repo) -> list[dict]:
    """Return all active worktrees for ``repo``."""
    try:
        output = repo.git.worktree("list", "--porcelain")
    except GitCommandError:
        return []
    worktrees = []
    current: dict = {}
    for line in output.splitlines():
        if line.startswith("worktree "):
            if current:
                worktrees.append(current)
            current = {"path": line.split(" ", 1)[1].strip()}
        elif line.startswith("branch "):
            current["branch"] = line.split(" ", 1)[1].strip().replace("refs/heads/", "")
        elif line.startswith("bare"):
            current["bare"] = True
    if current:
        worktrees.append(current)
    return worktrees


def is_merged(repo: Repo, name: str, base: str) -> bool:
    """True if every commit of ``name`` is already reachable from ``base``."""
    branch_ref = _resolve_ref(repo, name)
    base_ref = _resolve_ref(repo, base)
    try:
        repo.git.merge_base("--is-ancestor", branch_ref, base_ref)
        return True
    except GitCommandError as exc:
        if exc.status == 1:
            return False
        raise GitRepoError(f"Could not compare '{name}' with '{base}': {exc.stderr.strip()}") from exc


def rename_branch(repo: Repo, old: str, new: str) -> None:
    validate_branch_name(repo, new)
    if branch_exists(repo, new):
        raise GitRepoError(f"Branch '{new}' already exists")
    try:
        repo.git.branch("-m", old, new)
    except GitCommandError as exc:
        raise GitRepoError(f"Could not rename branch '{old}': {exc.stderr.strip()}") from exc


def current_branch(repo: Repo) -> str | None:
    """Name of the checked-out branch in the main working tree (None if detached)."""
    try:
        return repo.active_branch.name
    except TypeError:
        return None


def checkout_branch(repo: Repo, name: str) -> None:
    """Check out local branch ``name`` in the main working tree, never losing local changes."""
    if not branch_exists(repo, name):
        raise GitRepoError(f"Branch '{name}' does not exist in the repository")
    if current_branch(repo) == name:
        return
    if repo.is_dirty(untracked_files=False):
        raise GitRepoError(
            "The working tree has uncommitted changes; commit or stash them before switching branches"
        )
    try:
        repo.git.checkout(name)
    except GitCommandError as exc:
        raise GitRepoError(f"Could not check out '{name}': {exc.stderr.strip()}") from exc


def _parse_refs(decoration: str) -> list[dict]:
    """Parse a ``%D`` decoration string into ``[{name, type}]``."""
    refs: list[dict] = []
    for raw in filter(None, (part.strip() for part in decoration.split(","))):
        if raw.startswith("HEAD -> "):
            refs.append({"name": "HEAD", "type": "head"})
            refs.append({"name": raw[len("HEAD -> "):], "type": "branch"})
        elif raw == "HEAD":
            refs.append({"name": "HEAD", "type": "head"})
        elif raw.startswith("tag: "):
            refs.append({"name": raw[len("tag: "):], "type": "tag"})
        elif "/" in raw and raw.split("/", 1)[0] == "origin":
            refs.append({"name": raw, "type": "remote"})
        else:
            refs.append({"name": raw, "type": "branch"})
    return refs


HARD_LIMIT = 300


def commit_graph(repo: Repo, bases: list[str], branches: list[str], limit: int = 80) -> dict:
    """Commit graph over ``bases`` (mainline) and the ticket's ``branches``.

    Returns commits newest-first (topological order) with a ``lane`` per commit:
    lane 0 is the first base's first-parent chain, side branches/merged work get
    lanes >= 1 using the classic ``git log --graph`` column algorithm.
    ``ticket_branches`` lists which of the ticket's branches a commit is exclusive to.
    """
    base_refs = [_resolve_ref(repo, b) for b in bases]
    refs = list(dict.fromkeys(base_refs + [_resolve_ref(repo, b) for b in branches]))
    if not refs:
        return {"base": None, "commits": [], "lane_count": 1, "truncated": False}

    fmt = "%H%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%D%x1e"
    # Always reach back to where the ticket's branches forked off, even if that is
    # further than ``limit`` commits ago (bounded by HARD_LIMIT).
    raw = repo.git.log("--topo-order", f"-n{HARD_LIMIT + 1}", f"--format={fmt}", "--decorate=short", *refs, "--")
    all_records = [r.strip("\n") for r in raw.split("\x1e") if r.strip()]
    positions = {rec.split("\x1f", 1)[0]: i for i, rec in enumerate(all_records)}
    window = limit
    for name in branches:
        try:
            fork = repo.git.merge_base(_resolve_ref(repo, name), base_refs[0]).strip()
        except (GitRepoError, GitCommandError):
            continue
        if fork in positions:
            window = max(window, positions[fork] + 1)
    window = min(window, HARD_LIMIT)
    truncated = len(all_records) > window
    records = all_records[:window]

    commits = []
    for rec in records:
        h, parents, author, date, subject, decoration = rec.split("\x1f")
        commits.append(
            {
                "hash": h,
                "short": h[:7],
                "parents": parents.split() if parents else [],
                "author": author,
                "date": date,
                "subject": subject,
                "refs": _parse_refs(decoration),
            }
        )

    mainline = set(repo.git.rev_list("--first-parent", f"-n{window + 1}", base_refs[0], "--").split())

    # Which commits belong to which ticket branch (commits not yet in the base)
    exclusive: dict[str, set[str]] = {}
    for name in branches:
        try:
            ref = _resolve_ref(repo, name)
            out = repo.git.rev_list(f"-n{window + 1}", ref, f"^{base_refs[0]}", "--")
        except (GitRepoError, GitCommandError):
            continue
        exclusive[name] = set(out.split())

    # Lane assignment (git log --graph columns; column 0 pinned to the mainline)
    cols: list[str | None] = [None]
    for c in commits:
        h = c["hash"]
        if h in mainline:
            lane = 0
        else:
            lane = next((i for i, e in enumerate(cols) if i > 0 and e == h), None)
            if lane is None:
                lane = next((i for i, e in enumerate(cols) if i > 0 and e is None), None)
                if lane is None:
                    cols.append(None)
                    lane = len(cols) - 1
        for i, e in enumerate(cols):
            if e == h:
                cols[i] = None
        # Keep a column reserved until the parent row so a lane is never reused
        # while an older edge is still running through it.
        for idx, p in enumerate(c["parents"]):
            if idx == 0 and lane > 0:
                cols[lane] = p
            elif idx > 0 and any(e == p for e in cols):
                continue  # another line already heads to this parent
            elif p in mainline and lane == 0:
                continue  # mainline-to-mainline needs no column
            else:
                free = next((i for i, e in enumerate(cols) if i > 0 and e is None), None)
                if free is None:
                    cols.append(p)
                else:
                    cols[free] = p
        c["lane"] = lane
        c["ticket_branches"] = [n for n, members in exclusive.items() if h in members]

    return {
        "base": bases[0],
        "current": current_branch(repo),
        "commits": commits,
        "lane_count": max((c["lane"] for c in commits), default=0) + 1,
        "truncated": truncated,
    }
