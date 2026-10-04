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
    """Remove a git worktree at ``path``."""
    resolved = os.path.realpath(os.path.expanduser(path.strip()))
    args = ["remove"]
    if force:
        args.append("--force")
    args.append(resolved)
    try:
        repo.git.worktree(*args)
    except GitCommandError:
        pass
    try:
        repo.git.worktree("prune")
    except GitCommandError:
        pass


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
