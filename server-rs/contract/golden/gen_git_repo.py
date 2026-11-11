"""Golden vectors for crates/kb-board/src/git_repo.rs, computed by services/git_repo.py (GitPython).

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_git_repo.py
Writes `git_repo.json` next to this file.

The file is a script: a list of operations run in order in a temporary folder (`<ROOT>`). An operation is either a
step that prepares something (`{"do": ...}`: a git command, a file to write, a folder to make) or a call of a
function of `git_repo` (`{"fn", "repo", "args"}`) with what it returned or raised (`"out"`). The Rust test replays
the same operations on a real temporary repository and compares each `out`. Commit ids are the same on every
machine because the steps fix the author, the committer and the dates.
"""

import dataclasses
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from git import GitCommandError

sys.path.insert(0, os.getcwd())  # run from `server/`: the script's own folder is not where `services` is
from services import git_repo  # noqa: E402

OUT = Path(__file__).with_name("git_repo.json")

GIT_ENV = {
    "GIT_AUTHOR_NAME": "Tester",
    "GIT_AUTHOR_EMAIL": "t@example.com",
    "GIT_COMMITTER_NAME": "Committer",
    "GIT_COMMITTER_EMAIL": "c@example.com",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
}


def date(n: int) -> str:
    return f"2026-01-02T03:{n // 60:02d}:{n % 60:02d}+00:00"


class Script:
    def __init__(self, root: str) -> None:
        self.root = root
        self.ops: list[dict] = []
        self.clock = 0

    # --- steps ---------------------------------------------------------------------------------------------------

    def git(self, repo: str, *args: str) -> str:
        """Run git in `<ROOT>/<repo>`; each command gets the next second as author and committer date."""
        self.clock += 1
        when = date(self.clock)
        self.ops.append({"do": "git", "repo": repo, "args": list(args), "date": when})
        env = {**os.environ, **GIT_ENV, "GIT_AUTHOR_DATE": when, "GIT_COMMITTER_DATE": when}
        done = subprocess.run(
            ["git", *args], cwd=os.path.join(self.root, repo), env=env, check=True, capture_output=True, text=True
        )
        return done.stdout.strip()

    def write(self, path: str, text: str) -> None:
        self.ops.append({"do": "write", "path": path, "text": text})
        full = os.path.join(self.root, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8", newline="") as f:
            f.write(text)

    def write_bytes(self, path: str, data: list[int]) -> None:
        self.ops.append({"do": "write_bytes", "path": path, "bytes": data})
        with open(os.path.join(self.root, path), "wb") as f:
            f.write(bytes(data))

    def mkdir(self, path: str) -> None:
        self.ops.append({"do": "mkdir", "path": path})
        os.makedirs(os.path.join(self.root, path), exist_ok=True)

    def symlink(self, target: str, path: str) -> None:
        self.ops.append({"do": "symlink", "target": target, "path": path})
        os.symlink(os.path.join(self.root, target), os.path.join(self.root, path))

    def commit(self, repo: str, name: str, text: str, message: str) -> str:
        self.write(f"{repo}/{name}", text)
        self.git(repo, "add", ".")
        self.git(repo, "commit", "-q", "-m", message)
        return self.git(repo, "rev-parse", "HEAD")

    # --- calls ---------------------------------------------------------------------------------------------------

    def call(self, fn: str, repo: str | None, *args) -> None:
        """Call `git_repo.<fn>`; `repo` is the folder under `<ROOT>` to open first (None for a function that takes
        no repository). `<ROOT>` in a string argument is the temporary folder."""
        real = [a.replace("<ROOT>", self.root) if isinstance(a, str) else a for a in args]
        try:
            if repo is None:
                result = getattr(git_repo, fn)(*real)
            else:
                opened = git_repo.open_repo(os.path.join(self.root, repo))
                result = getattr(git_repo, fn)(opened, *real)
            if dataclasses.is_dataclass(result):
                result = dataclasses.asdict(result)
            elif fn == "open_repo":
                result = {"working_dir": str(result.working_dir), "git_dir": str(result.git_dir), "bare": result.bare}
            out = {"ok": result}
        except git_repo.GitRepoError as exc:
            out = {"error": "GitRepoError", "message": str(exc)}
        except GitCommandError as exc:
            out = {"error": "GitCommandError", "status": exc.status, "stderr": exc.stderr}
        out = json.loads(json.dumps(out).replace(self.root, "<ROOT>"))
        self.ops.append({"fn": fn, "repo": repo, "args": list(args), "out": out})


def build(s: Script) -> None:
    # --- a repository with a merged branch, an open branch, a tag, a rename and a binary file ----------------------
    s.mkdir("repo")
    s.git("repo", "init", "-q", "-b", "main")
    c_init = s.commit("repo", "a.txt", "a\n", "init")
    s.git("repo", "branch", "feature/x")
    s.git("repo", "checkout", "-q", "feature/x")
    s.commit("repo", "f1.txt", "f1\n", "add f1")
    s.commit("repo", "a.txt", "a\nmore\n", "change a\n\nA body line.\n\nAnother paragraph.")
    s.git("repo", "checkout", "-q", "main")
    s.commit("repo", "m1.txt", "m1\n", "add m1")
    s.git("repo", "merge", "-q", "--no-ff", "-m", "merge feature/x", "feature/x")
    c_merge = s.git("repo", "rev-parse", "HEAD")
    s.git("repo", "tag", "v1")
    s.git("repo", "branch", "feat/open")
    s.git("repo", "checkout", "-q", "feat/open")
    s.git("repo", "mv", "f1.txt", "renamed.txt")
    s.write_bytes("repo/bin.dat", [0, 1, 2, 255, 0, 10])
    s.git("repo", "add", ".")
    s.git("repo", "commit", "-q", "-m", "rename f1 and add a binary file")
    c_rename = s.git("repo", "rev-parse", "HEAD")
    s.commit("repo", "o2.txt", "o2\n", "add o2")
    s.git("repo", "checkout", "-q", "main")
    s.commit("repo", "m2.txt", "m2\n", "add m2")
    s.mkdir("repo/sub")
    s.mkdir("plain")
    s.symlink("repo", "link")

    # --- opening ------------------------------------------------------------------------------------------------
    s.call("open_repo", None, "<ROOT>/repo")
    s.call("open_repo", None, "<ROOT>/repo/.git")
    s.call("open_repo", None, "<ROOT>/repo/sub")
    s.call("open_repo", None, "<ROOT>/plain")
    s.call("open_repo", None, "<ROOT>/nope")
    s.call("normalize_repo_path", None, "  <ROOT>/repo/./sub/..  ")
    s.call("normalize_repo_path", None, "<ROOT>/link")
    s.call("normalize_repo_path", None, "<ROOT>/plain/")
    s.call("normalize_repo_path", None, "<ROOT>/nope/x")

    # --- reading ------------------------------------------------------------------------------------------------
    s.call("list_local_branches", "repo")
    s.call("branch_exists", "repo", "main")
    s.call("branch_exists", "repo", "feature")
    s.call("branch_exists", "repo", "v1")
    s.call("current_branch", "repo")
    s.call("default_base_branch", "repo")
    s.call("resolve_base", "repo", None)
    s.call("resolve_base", "repo", "")
    s.call("resolve_base", "repo", "main")
    s.call("resolve_base", "repo", "develop")
    s.call("_resolve_ref", "repo", "main")
    s.call("_resolve_ref", "repo", "v1")
    s.call("_resolve_ref", "repo", "nope")
    s.call("validate_branch_name", "repo", "ok/name")
    s.call("validate_branch_name", "repo", "bad name")
    s.call("validate_branch_name", "repo", "it's..bad")
    s.call("validate_branch_name", "repo", 'a"b\'c~\\')
    s.call("branch_info", "repo", "feat/open", "main")
    s.call("branch_info", "repo", "feature/x", "main")
    s.call("branch_info", "repo", "main", "feat/open")
    s.call("branch_info", "repo", "nope", "main")
    s.call("branch_info", "repo", "main", "nope")
    s.call("is_merged", "repo", "feature/x", "main")
    s.call("is_merged", "repo", "feat/open", "main")
    s.call("is_merged", "repo", "nope", "main")

    # --- the graph and one commit -----------------------------------------------------------------------------------
    s.call("commit_graph", "repo", ["main"], ["feat/open", "feature/x"], 80)
    s.call("commit_graph", "repo", ["main"], ["feat/open"], 2)
    s.call("commit_graph", "repo", ["main"], [], 3)
    s.call("commit_graph", "repo", ["main", "feature/x"], ["feat/open", "feat/open"], 80)
    s.call("commit_graph", "repo", [], [], 80)
    s.call("commit_graph", "repo", ["main"], ["nope"], 80)
    s.call("commit_detail", "repo", c_merge, 200)
    s.call("commit_detail", "repo", c_rename, 200)
    s.call("commit_detail", "repo", c_rename[:8], 1)
    s.call("commit_detail", "repo", c_init, 200)
    s.call("commit_detail", "repo", c_init[:7] + "\n", 200)
    s.call("commit_detail", "repo", "HEAD", 200)
    s.call("commit_detail", "repo", "abc", 200)
    s.call("commit_detail", "repo", "abcd1234", 200)

    # --- branches -----------------------------------------------------------------------------------------------
    s.call("create_branch", "repo", "new/one", "main")
    s.call("create_branch", "repo", "new/one", "main")
    s.call("create_branch", "repo", "from-tag", "v1")
    s.call("create_branch", "repo", "x", "nope")
    s.call("create_branch", "repo", "bad name", "main")
    s.call("create_branch", "repo", "new", "main")
    s.call("rename_branch", "repo", "new/one", "new/two")
    s.call("rename_branch", "repo", "feat/open", "main")
    s.call("rename_branch", "repo", "ghost", "ghost2")
    s.call("rename_branch", "repo", "from-tag", "bad name")
    s.call("list_local_branches", "repo")

    # --- worktrees ----------------------------------------------------------------------------------------------
    s.call("resolve_worktree_path", None, "../wt/{project}-{ticket}-{branch}", "<ROOT>/repo", "KAN", "KAN-7", "feat/a/b")
    s.call("resolve_worktree_path", None, " <ROOT>/wt//{repo}/./{ticket_id}/ ", "<ROOT>/repo/", "KAN", "KAN-7", "x")
    s.call("resolve_worktree_path", None, "{repo}_{branch}", "<ROOT>/repo", "KAN", "KAN-7", "x")
    s.call("add_worktree", "repo", " <ROOT>/wt/deep/one ", "new/two")
    s.call("add_worktree", "repo", "<ROOT>/wt/deep/one", "from-tag")
    s.call("add_worktree", "repo", "<ROOT>/wt/two", "ghost")
    s.call("add_worktree", "repo", "<ROOT>/wt/three", "new/two")
    s.call("list_worktrees", "repo")
    s.call("open_repo", None, "<ROOT>/wt/deep/one")
    s.call("current_branch", "wt/deep/one")
    s.call("list_local_branches", "wt/deep/one")
    s.call("default_base_branch", "wt/deep/one")
    s.call("delete_branch", "repo", "new/two", False)
    s.write("wt/deep/one/untracked.txt", "left behind\n")
    s.call("remove_worktree", "repo", "<ROOT>/wt/deep/one", False)
    s.call("remove_worktree", "repo", "<ROOT>/wt/deep/one", True)
    s.call("remove_worktree", "repo", "<ROOT>/wt/never", False)
    s.call("remove_worktree", "repo", "<ROOT>/plain", False)
    s.call("list_worktrees", "repo")
    s.call("delete_branch", "repo", "new/two", False)
    s.call("delete_branch", "repo", "ghost", False)
    s.call("delete_branch", "repo", "feat/open", False)
    s.call("delete_branch", "repo", "from-tag", True)
    s.call("list_local_branches", "repo")

    # --- checking out -------------------------------------------------------------------------------------------
    s.call("checkout_branch", "repo", "feature/x")
    s.call("current_branch", "repo")
    s.call("checkout_branch", "repo", "feature/x")
    s.call("checkout_branch", "repo", "ghost")
    s.write("repo/a.txt", "changed and not committed\n")
    s.call("checkout_branch", "repo", "main")
    s.git("repo", "add", ".")
    s.call("checkout_branch", "repo", "main")
    s.git("repo", "reset", "-q", "--hard")
    s.write("repo/untracked.txt", "untracked files do not block\n")
    s.call("checkout_branch", "repo", "main")
    s.call("current_branch", "repo")
    s.git("repo", "pack-refs", "--all")
    s.call("list_local_branches", "repo")
    s.call("branch_exists", "repo", "feat/open")
    s.git("repo", "checkout", "-q", "--detach")
    s.call("current_branch", "repo")
    s.call("default_base_branch", "repo")
    s.call("commit_graph", "repo", ["main"], ["feat/open"], 80)

    # --- a repository whose default branch is master, one with neither, a bare one and an empty one --------------
    s.mkdir("old")
    s.git("old", "init", "-q", "-b", "master")
    s.commit("old", "a.txt", "a\n", "init")
    s.git("old", "branch", "zeta")
    s.call("default_base_branch", "old")
    s.call("resolve_base", "old", "main")
    s.call("resolve_base", "old", None)
    s.call("resolve_base", "old", "zeta")
    s.git("old", "branch", "-m", "master", "trunk")
    s.git("old", "checkout", "-q", "zeta")
    s.call("default_base_branch", "old")
    s.call("resolve_base", "old", "main")
    s.git("old", "checkout", "-q", "--detach")
    s.call("default_base_branch", "old")
    s.git(".", "clone", "-q", "--bare", "old", "bare.git")
    s.call("open_repo", None, "<ROOT>/bare.git")
    s.call("list_local_branches", "bare.git")
    s.call("current_branch", "bare.git")
    s.call("list_worktrees", "bare.git")
    s.call("checkout_branch", "bare.git", "trunk")
    s.mkdir("empty")
    s.git("empty", "init", "-q", "-b", "main")
    s.call("open_repo", None, "<ROOT>/empty")
    s.call("list_local_branches", "empty")
    s.call("current_branch", "empty")
    s.call("default_base_branch", "empty")
    s.call("resolve_base", "empty", "main")
    s.call("resolve_base", "empty", None)
    s.call("branch_info", "empty", "main", "main")
    s.call("create_branch", "empty", "x", "main")


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="golden-git-") as tmp:
        script = Script(os.path.realpath(tmp))
        build(script)
    version = subprocess.run(["git", "--version"], capture_output=True, text=True, check=True).stdout.strip()
    OUT.write_text(
        json.dumps({"git_version": version, "env": GIT_ENV, "ops": script.ops}, indent=1, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    calls = sum(1 for op in script.ops if "fn" in op)
    print(f"{OUT.name}: {len(script.ops)} operations, {calls} calls", file=sys.stderr)


if __name__ == "__main__":
    main()
