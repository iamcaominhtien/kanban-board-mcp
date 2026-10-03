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
