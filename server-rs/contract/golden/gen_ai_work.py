"""Golden vectors for the pure parts of `worktrees`, `github` and `project_env` (`crates/kb-ai-work`): branch names and
paths, what counts as an output, remotes, the texts of the notes and of the tasks given to the Dev, the pull request
state read from `gh pr view` JSON, CI roll-ups and the base branch check, and the PATH helpers of a project.

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_ai_work.py
Writes `ai_work.json` next to this file. It runs with its own temporary KANBAN_* folders and a temporary HOME, starts no
process and never opens the developer's database.
"""

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

work = tempfile.mkdtemp(prefix="gen-ai-work-")
os.environ["KANBAN_CONFIG_DIR"] = f"{work}/config"
os.environ["KANBAN_DB_PATH"] = f"{work}/data/kanban.db"
os.environ["KANBAN_LOG_DIR"] = f"{work}/logs"
os.environ["KANBAN_AI_KEY_FILE"] = f"{work}/ai.key"
os.environ["CLAUDE_CONFIG_DIR"] = f"{work}/claude"
os.environ["HOME"] = f"{work}/home"
os.makedirs(f"{work}/home", exist_ok=True)
sys.path.insert(0, os.getcwd())

import database  # noqa: E402
from models import AiProjectSettings, AiWatchedPr, AiWorktree  # noqa: E402
from services.ai import github, ops, project_env, worktrees  # noqa: E402

OUT = Path(__file__).with_name("ai_work.json")
out: dict = {}


# --------------------------------------------------------------------------------------------------------------
# worktrees: names and paths
# --------------------------------------------------------------------------------------------------------------
TITLES = [
    "Fix the CSV export, please!", "Bất tài liệu học", "Đặt lịch hẹn", "Tài liệu học", "!!!", "", "   ", "word " * 30,
    "A" * 40, "a-b_c d", "Ünïcödé façade", "日本語のタイトル", "emoji 🎉 party", "x" * 31 + "-y", "x" * 32 + "-y", "--lead--",
    "ﬁne ligature", "Ⅷ roman", "ＦＵＬＬ ｗｉｄｔｈ", "Straße", "İstanbul", "e\u0301clair", "Ñandú", "co-op / path\\win", "KAN-12: do it",
    "tab\tsep", "multi\nline", "1234567890", "ǅ digraph", "ﷺ", "Ωmega", "ǰ", "Å angstrom", "ẞ", "đĐ", "ơ ư",
]
out["slug"] = [[t, worktrees.slug(t)] for t in TITLES]
out["slug_limit"] = [[t, n, worktrees.slug(t, n)] for t in TITLES[:10] for n in (1, 5, 10, 64)]
REPOS = [("/code/kanban", "KAN-1"), ("/code/kanban/", "KAN-2"), ("/", "K"), ("relative/repo", "K-3"), ("repo", "K-4"),
         ("/a//b/./c", "K-5"), ("/a b/ü", "K-6"), ("", "K-7")]
out["path_for"] = [[r, k, worktrees.path_for(r, k)] for r, k in REPOS]

REMOTES = [
    "https://github.com/o/r.git", "git@github.com:o/r.git", "ssh://git@github.com/o/r.git", "https://gitlab.com/github.com/r.git",
    "https://notgithub.com/o/r", None, "", "  https://github.com/o/r  ", "HTTPS://GITHUB.COM/o/r", "https://user:pw@github.com/o/r",
    "https://github.com:443/o/r", "github.com/o/r", "//github.com/o/r", "git@gitlab.com:o/github.com.git", "ssh://github.com/o/r",
    "https://github.com.evil.com/o/r", "https://evil.com/github.com", "https://[::1]/x", "https://[github.com/x", "git@github.com:22/o/r",
    "file:///tmp/github.com", "/tmp/github.com", "https://github.com", "https://GitHub.com./o", "https://github.com@evil.com/o",
    "https://evil.com@github.com/o", "git+ssh://git@github.com/o/r", "\thttps://github.com/o/r\n", "https://github.com?x=1", "https://github.com#f",
    "ssh://git@github.com:o/r", "x@y:z", "github.com:o/r", "git@github.com", "https://github.com\\@evil.com/o", "git@GITHUB.com:o/r.git",
]
out["is_github"] = [[r, worktrees.is_github(r)] for r in REMOTES]

PATHS = [
    "shot.png", "qa/step1.txt", "run.log", "out/evidence/a.txt", "test-results/x.json", "sub/video.mp4", "my_work/notes.md",
    "src/app.py", "docs/diagram.png", "README.md", "src/logo.png", "script.sh", "Reports/Q1.csv", "a/b/c/tmp/x.py", "./shot.png",
    "a//shot.png", "x.PNG", "x.Log", ".look/a", "dir-output/a", "dir_output/a", "a-work/x", "preevidence/x", "evidence", "evidence/",
    "tests/trace", "x.trace", "x.", ".png", "a/.png", "archive.zip", "sub/archive.zip", "index.html", "web/index.html", "data.csv",
    "data/data.csv", "deck.pptx", "a.xlsx", "b.XLS", "doc.docx", "", "/abs/shot.png", "/abs/qa/x", "A/QA/x", "screenshots/a.png",
    "screenshot/a.png", "shots/a", "tmp/a", "Temp/a", "scratch/a", "artifacts/a", "artefacts/a", "out-qa/a", "output/a", "outputs/a",
    "playwright-report/index.html", "report/a", "reports/a", "src/report.txt", "node_modules/x.log", "ünï/évidence/a", "'quoted name.png'",
]
out["is_output"] = [[p, worktrees.is_output(p)] for p in PATHS]
LINES = [
    "?? shot.png", "?? src/new.py", " M calc.py", "?? qa/a.txt", "A  staged.log", "?? run.log", "?? docs/a.png", "??", "?? ", "?x", "?? a/b.html",
    "?? top.html", "!! ignored.log", "R  old -> new.log", "?? ünï.png", "?? dir_work/x.py", "??  spaced.png",
]
out["outputs_in"] = [[LINES, worktrees.outputs_in(LINES)]]
out["outputs_in"] += [[[line], worktrees.outputs_in([line])] for line in LINES]

NOTES = [
    ({"moved": ["a.png"], "to": "/ws/T-1/from-worktree/2026-01-01-000000"}, "/wt"),
    ({"moved": ["a.png", "b.log"], "to": "/ws/T-1/x"}, "/wt"),
    ({"moved": [f"f{i}.png" for i in range(25)], "to": "/ws/T-1/x"}, "/wt"),
    ({"moved": [f"f{i}.png" for i in range(20)], "to": "/ws/T-1/x"}, "/wt"),
    ({"moved": [], "left": ["a.png"], "reason": "Workspace is off (Settings › Workspace), so they stay in the worktree."}, "/wt/T-1"),
    ({"moved": [], "left": [f"l{i}.log" for i in range(23)], "reason": "x"}, "/wt/T-1"),
    ({"moved": [], "left": ["a", "b"]}, "/wt"),
    ({"moved": [], "left": []}, "/wt"),
    ({"moved": [], "left": [], "reason": "This ticket has no worktree."}, ""),
    ({"moved": ["é.png"], "left": ["x"], "to": "/ü"}, "/wt"),
]
out["note_for"] = [[r, wt, worktrees._note_for(r, wt)] for r, wt in NOTES]

SIZES = [0, 1, 1024, 52428, 52429, 52430, 78643, 78644, 104857, 104858, 157286, 157287, 1048576, 1572864, 5242880, 123456789, 999999999,
         5 * 1024 * 1024 + 52428, 7340032, 3 * 1024 * 1024 + 78643, 262144, 262145, 314572, 314573]
out["size_round"] = [[n, round(n / (1024 * 1024), 1)] for n in SIZES]

# --------------------------------------------------------------------------------------------------------------
# github
# --------------------------------------------------------------------------------------------------------------
CHECKS = [
    [],
    [{"conclusion": "SUCCESS", "status": "COMPLETED"}],
    [{"conclusion": "SUCCESS", "status": "COMPLETED"}, {"conclusion": "FAILURE", "status": "COMPLETED", "name": "lint"}],
    [{"conclusion": "", "status": "IN_PROGRESS"}, {"conclusion": "SUCCESS", "status": "COMPLETED"}],
    [{"conclusion": "failure"}, {"conclusion": "timed_out"}, {"conclusion": "cancelled"}, {"conclusion": "action_required"}],
    [{"conclusion": "NEUTRAL"}, {"conclusion": "SKIPPED"}],
    [{"status": "QUEUED"}, {"status": "pending"}],
    [{"conclusion": None, "status": None}],
    [{"conclusion": "FAILURE", "status": "IN_PROGRESS"}],
    [{"conclusion": "STALE"}, {"conclusion": "STARTUP_FAILURE"}],
    [{"state": "SUCCESS"}, {"state": "FAILURE"}],
]
out["rollup"] = [[c, *github._rollup(c)] for c in CHECKS]


def pr_view(**kw):
    base = {"state": "OPEN", "statusCheckRollup": [], "reviews": [], "comments": [], "headRefName": "ai/K-1-x", "baseRefName": "main", "url": "https://github.com/o/r/pull/7"}
    base.update(kw)
    return base


PR_CASES = [
    ({}, []),
    ({"state": "MERGED"}, []),
    ({"state": "closed"}, []),
    ({"state": None}, []),
    ({"statusCheckRollup": CHECKS[2]}, []),
    ({"statusCheckRollup": None, "comments": None, "reviews": None}, []),
    ({"comments": [
        {"id": "IC_1", "author": {"login": "bob"}, "body": "please rename", "createdAt": "2026-01-01T00:00:00Z", "url": "https://x/1"},
        {"id": "IC_2", "author": {"login": "dependabot[bot]"}, "body": "bump", "createdAt": "2026-01-01T00:00:01Z"},
        {"id": "IC_3", "author": {"login": "me"}, "body": "reply\n<!-- kanban-board-ai -->", "createdAt": "2026-01-01T00:00:02Z"},
        {"author": {"login": "eve"}, "body": "no id", "url": "https://x/4", "createdAt": "2026-01-01T00:00:03Z"},
        {"author": None, "body": "anonymous", "createdAt": "2026-01-01T00:00:04Z"},
        {"body": "nothing at all"},
        {"id": 12345, "author": {"login": "num"}, "body": "x" * 5000, "createdAt": "t", "path": "a.py", "line": 12},
        {"id": 0, "url": "", "createdAt": "", "author": {"login": ""}, "body": ""},
    ]}, []),
    ({"comments": [{"id": "IC_1", "author": {"login": "bob"}, "body": "seen"}], "reviews": [
        {"id": "R_1", "author": {"login": "carol"}, "body": "  looks wrong  ", "path": "b.py", "line": 3, "createdAt": "x"},
        {"id": "R_2", "author": {"login": "dan"}, "body": "   ", "createdAt": "y"},
        {"id": "R_3", "author": {"login": "erin"}, "body": None, "createdAt": "z"},
        {"id": "R_4", "author": {"login": "bot[bot]"}, "body": "review", "createdAt": "w"},
        {"id": "R_5", "author": {"login": "zed"}, "body": "Ünï ✓ " + "ü" * 4100, "createdAt": "v", "line": None},
    ]}, ["IC_1", "R_4"]),
    ({"baseRefName": None, "headRefName": None}, []),
    ({"statusCheckRollup": CHECKS[4], "state": "OPEN"}, []),
]
poll_cases = []


async def poll_python():
    row_base = dict(ticket_id="T-1", project_id="p", number=7, branch="b", repo=work)
    for extra, seen in PR_CASES:
        data = pr_view(**extra)
        text = json.dumps(data)

        async def fake(args, cwd, timeout=60, _t=text):
            return 0, _t

        github.gh = fake
        row = AiWatchedPr(**row_base, seen_comments=json.dumps(seen))
        got = await github.poll(row)
        poll_cases.append({"data": data, "seen": seen, "poll": got})


asyncio.run(poll_python())
out["poll"] = poll_cases

# the answers of the base-branch check
RUNS = [
    [], [{"workflowName": "CI", "conclusion": "success"}], [{"workflowName": "CI", "conclusion": "failure"}],
    [{"workflowName": "CI", "conclusion": ""}, {"workflowName": "CI", "conclusion": "failure"}],
    [{"workflowName": "Other", "conclusion": "failure"}, {"workflowName": "CI", "conclusion": "success"}],
    [{"workflowName": "Other", "conclusion": "failure"}], [{"workflowName": "CI", "conclusion": "CANCELLED"}],
    [{"workflowName": "CI", "conclusion": "Timed_Out"}], [{"workflowName": "CI", "conclusion": "action_required"}],
    [{"workflowName": "CI", "conclusion": "neutral"}], [{"workflowName": "CI", "status": "in_progress"}], {"not": "a list"}, [{"workflowName": "CI", "conclusion": None}],
]
base_cases = []


async def base_python():
    row = AiWatchedPr(ticket_id="T-1", project_id="p", number=7, branch="b", repo=work)
    for runs_ in RUNS:
        for check in ({"workflowName": "CI", "name": "build"}, {"name": "build"}, {"workflowName": ""}):
            for base in ("main", None, ""):
                async def fake(args, cwd, timeout=60, _t=json.dumps(runs_)):
                    return 0, _t

                github.gh = fake
                base_cases.append({"runs": runs_, "check": check, "base": base, "out": await github.base_is_red(row, base, check)})
    # gh failing, or not JSON
    for code, text in ((1, "boom"), (0, "not json")):
        async def fake(args, cwd, timeout=60, _c=code, _t=text):
            return _c, _t

        github.gh = fake
        base_cases.append({"gh": [code, text], "check": {"workflowName": "CI"}, "base": "main", "out": await github.base_is_red(row, "main", {"workflowName": "CI"})})


asyncio.run(base_python())
out["base_is_red"] = base_cases

LOGS = [
    ("https://github.com/o/r/actions/runs/12345678/job/99", "build", (0, "log text")),
    ("https://github.com/o/r/actions/runs/1234/job/99", "build", (0, "short id")),
    ("", "build", (0, "x")),
    (None, None, (0, "x")),
    ("https://github.com/o/r/actions/runs/12345678/job/99", "build", (1, "gh: not found")),
    ("https://github.com/o/r/actions/runs/12345678", "lint", (0, "L" * 13000)),
    ("https://github.com/o/r/actions/runs/12345678", "lint", (0, "é" * 12001)),
    ("https://x/1234567/9876543", "t", (0, "first")),
]
log_cases = []


async def logs_python():
    row = AiWatchedPr(ticket_id="T-1", project_id="p", number=7, branch="b", repo=work)
    for url, name, (code, text) in LOGS:
        calls = []

        async def fake(args, cwd, timeout=60, _c=code, _t=text, _calls=calls):
            _calls.append([args, timeout])
            return _c, _t

        github.gh = fake
        got = await github.failure_log(row, {"detailsUrl": url, "name": name})
        log_cases.append({"url": url, "name": name, "gh": [code, text if len(text) < 100 else None, len(text)], "calls": calls, "out": got})


asyncio.run(logs_python())
out["failure_log"] = log_cases

FENCES = [("ci log · build", "plain"), ('a "quoted"\nlabel', "x</untrusted>y</instruction>z"), ("", ""), ("review comment · @bob · a.py:3", "{braces} {number} {0}")]
out["fence"] = [[s, t, github._fence(s, t)] for s, t in FENCES]
out["ci_task"] = [
    {"number": 7, "check": "build", "base": "main", "log": github._fence("ci log · build", "boom {x}"), "branch": "ai/K-1-x",
     "text": github._CI_TASK.format(number=7, check="build", base="main", log=github._fence("ci log · build", "boom {x}"), branch="ai/K-1-x")},
    {"number": 12, "check": None, "base": "the base branch", "log": "{log}", "branch": "{branch}",
     "text": github._CI_TASK.format(number=12, check=None, base="the base branch", log="{log}", branch="{branch}")},
]
out["review_task"] = [
    {"number": 7, "comments": "<untrusted source=\"x\">\nhi\n</untrusted>", "branch": "ai/K-1-x",
     "text": github._REVIEW_TASK.format(number=7, comments="<untrusted source=\"x\">\nhi\n</untrusted>", branch="ai/K-1-x")},
    {"number": 3, "comments": "{number}", "branch": "{comments}", "text": github._REVIEW_TASK.format(number=3, comments="{number}", branch="{comments}")},
]
out["ai_mark"] = github.AI_MARK
out["auto_per_day"] = github.AUTO_PER_DAY

# the watched-pull-request rows: to_dict and signals
db_cases = {}


async def db_python():
    await database.init_db()
    rows = [
        AiWatchedPr(ticket_id="T-1", project_id="p1", number=1, url="https://github.com/o/r/pull/1", branch="b1", repo="/r", ci="red",
                    red=json.dumps({"check": "build", "workflow": "CI", "url": "https://x/1", "at": "2026-11-12T09:30:00.123456+00:00", "blamed": True, "base_unknown": False, "base": "main"})),
        AiWatchedPr(ticket_id="T-2", project_id="p1", number=2, branch="b2", repo="/r", ci="red",
                    red=json.dumps({"check": "lint", "url": "https://x/2", "at": "2026-11-12T09:31", "blamed": True, "handled_at": "2026-11-12T09:40:00+00:00"})),
        AiWatchedPr(ticket_id="T-3", project_id="p1", number=3, branch="b3", repo="/r", ci="red",
                    red=json.dumps({"check": "test", "at": "", "blamed": False, "base": "main"})),
        AiWatchedPr(ticket_id="T-4", project_id="p1", number=4, branch="b4", repo="/r", ci="red",
                    red=json.dumps({"check": "é ü", "blamed": True, "base": None, "at": "2026-11-12T10:00:00+00:00"})),
        AiWatchedPr(ticket_id="T-5", project_id="p1", number=5, branch="b5", repo="/r", ci="green", red=None,
                    pending_comments=json.dumps([{"id": "c", "author": "bob", "body": "x"}]), checked_at="2026-11-12T10:00:00+00:00", last_error="boom"),
        AiWatchedPr(ticket_id="T-6", project_id="p1", number=6, branch="b6", repo="/r", ci="red", red="not json"),
        AiWatchedPr(ticket_id="T-7", project_id="p2", number=7, branch="b7", repo="/r", ci="red", red=json.dumps({"check": "x", "blamed": True, "at": "2026"})),
        AiWatchedPr(ticket_id="T-8", project_id="p1", number=8, branch="b8", repo="/r", ci=None, red="", state="closed"),
    ]
    async with database.async_session() as session:
        for r in rows:
            session.add(r)
        await session.commit()
        db_cases["rows"] = [json.loads(r.model_dump_json()) for r in rows]
        db_cases["signals_p1"] = await github.signals(session, "p1")
        db_cases["signals_p2"] = await github.signals(session, "p2")
        db_cases["signals_p3"] = await github.signals(session, "p3")
        db_cases["to_dict"] = [github.to_dict(r) for r in rows]
    # to_dict of a worktree row
    wt = AiWorktree(ticket_id="T-1", project_id="p1", repo="/r", path="/r.worktrees/T-1", branch="ai/T-1-x", base="main", port=5180,
                    conflict_files=json.dumps(["a.py", "b.py"]), prepared_at="2026-11-12T09:00:00+00:00", prepare_s=3, created_at="2026-11-12T08:00:00+00:00")
    wt2 = AiWorktree(ticket_id="T-2", project_id="p1", repo="/r", path="/r.worktrees/T-2", branch="ai/T-2-x", conflict_files="", created_at="2026-11-12T08:00:00+00:00")
    db_cases["worktree_dict"] = [
        worktrees.to_dict(wt), worktrees.to_dict(wt, {"exists": True, "uncommitted": [], "size_mb": 0.5, "ahead": 2, "outputs": []}),
        worktrees.to_dict(wt2, {}),
    ]
    db_cases["worktree_rows"] = [json.loads(r.model_dump_json()) for r in (wt, wt2)]


asyncio.run(db_python())
out["db"] = db_cases

# --------------------------------------------------------------------------------------------------------------
# project_env
# --------------------------------------------------------------------------------------------------------------
SETTINGS = [
    None, {}, {"env_path": []}, {"env_path": ["/opt/x", "  /opt/x  ", "", None, 0, 5, "~/bin", "/opt/y", ["a"], {"k": 1}, False, True, " "]},
    {"env_path": "not a list"}, {"env_path": None}, {"env_path": ["a", "b", "a", "c"]}, {"env_path": [1.5, "é", "\u00a0/pad\u00a0"]},
    {"github": {"on": True}}, {"env_path": ["~"]},
]
env_cases = []
for s in SETTINGS:
    row = None if s is None else AiProjectSettings(project_id="p", ops=json.dumps(s))
    env_cases.append([s, project_env.extra(row)])
out["env_extra"] = env_cases

BASES = [
    ({"PATH": "/usr/bin:/bin", "HOME": "/h"}, ["/opt/a", "~/b"]),
    ({"PATH": "/usr/bin:/bin"}, []),
    ({"PATH": "/usr/bin:/bin"}, None),
    ({"PATH": "/usr/bin:/opt/a:/bin:"}, ["/opt/a", "/opt/c"]),
    ({}, ["/opt/a"]),
    ({"PATH": ""}, ["/opt/a"]),
    ({"PATH": "::/a::/b:/a"}, ["/b"]),
    ({"X": "1"}, ["~"]),
    ({"PATH": "/usr/bin"}, ["~other/x", "~/y", "a:b"]),
]
HOME_TEXT = os.environ["HOME"]


def home_placeholder(env):
    return {k: v.replace(HOME_TEXT, "$HOME") for k, v in env.items()}


# a `~` expands to the HOME of the run: the vectors say `$HOME` and the test puts its own back
out["with_path"] = [[b, f, home_placeholder(project_env.with_path(b, f))] for b, f in BASES]

COMMANDS = [
    "npm --prefix ui ci && uv sync", "PATH=/x npm test", "A=1 B=2 make -j4", "cd ui && npm run build", "", None, "echo hi | grep h; pytest",
    "./gradlew test", "bin/test && yarn lint", "'npm' install", '"pnpm" i', "(cd x; make) || cargo build", "export A=1; python3 -m pytest",
    "if [ -f x ]; then ruby a.rb; fi", "for f in a; do node $f; done", "sudo apt-get install x", "time cargo test", "nice -n 5 make", "source env.sh; go test ./...",
    ". env.sh && deno test", "npm ci\nnpm test\n", "a & b", "a || b && c ; d", "  ", "env FOO=1 bar", "X=1", "test -f x && npx playwright test", "[ -x a ] && a", "npm; npm; yarn",
    "make\t-j4", "é=1 tool", "1A=1 tool", "_A=1 tool", "A= tool", "A=1", "(npm)", "\"\" x", "'' x",
]
out["programs"] = [[c, project_env.programs(c)] for c in COMMANDS]
VERSIONS = [
    "/h/.nvm/versions/node/v20.11.1/bin", "/h/.nvm/versions/node/v18.0.0/bin", "/h/.nvm/versions/node/v9.1.2/bin", "/h/.nvm/versions/node/v20.11.10/bin",
    "/h/.local/share/fnm/node-versions/v22.1.0/installation/bin", "/h/versions/versions/1.2.3.4/x", "/nothing/here", "/a/versions/", "/a/versions/v1/versions/v2.3",
    "/a/versions/v100.200.300.400", "/a/versions/v1-2-3", "/a/versions/9999999999999999999999",
]
out["version_key"] = [[v, list(project_env._version_key(Path(v)))] for v in VERSIONS]

# find / missing_folders in a temporary HOME (the machine's own tool folders are never asked: the programs are made up)
home = Path(os.environ["HOME"])
bins = {
    ".local/bin": ["kbtool-one"], ".cargo/bin": ["kbtool-two", "kbtool-dup"], ".volta/bin": ["kbtool-dup"],
    ".nvm/versions/node/v18.0.0/bin": ["kbnode"], ".nvm/versions/node/v20.11.1/bin": ["kbnode", "kbnode-new"],
    ".nvm/versions/node/v9.1.2/bin": ["kbnode-old"], ".local/share/fnm/node-versions/v22.1.0/installation/bin": ["kbfnm"],
}
for rel, names in bins.items():
    d = home / rel
    d.mkdir(parents=True, exist_ok=True)
    for n in names:
        f = d / n
        f.write_text("#!/bin/sh\n")
        f.chmod(0o755)
(home / ".bun/bin").mkdir(parents=True)
(home / ".bun/bin/kbtool-noexec").write_text("x")
(home / ".bun/bin/kbtool-noexec").chmod(0o644)
(home / ".deno/bin/kbtool-dir").mkdir(parents=True)
(home / ".npm-global").mkdir()
path_dir = home / "onpath"
path_dir.mkdir()
(path_dir / "kbtool-here").write_text("#!/bin/sh\n")
(path_dir / "kbtool-here").chmod(0o755)
find_cases = []
for prog in ["kbtool-one", "kbtool-two", "kbtool-dup", "kbnode", "kbnode-new", "kbnode-old", "kbfnm", "kbtool-noexec", "kbtool-dir", "kbtool-here", "kbtool-missing"]:
    for p in (f"/usr/bin:{path_dir}", "/usr/bin"):
        find_cases.append([prog, p.replace(str(home), "$HOME"), (project_env.find(prog, p) or "").replace(str(home), "$HOME") or None])
out["find"] = find_cases
missing = [
    ["kbtool-nowhere kbtool-one && kbtool-two", "kbtool-here"],
    ["kbnode; kbtool-dup", "kbtool-missing"],
    ["kbfnm", "kbtool-here && kbtool-one"],
    ["", "  "],
]
miss_cases = []
for cmds in missing:
    for p in (f"/usr/bin:{path_dir}", "/usr/bin"):
        got = project_env.missing_folders(cmds, p)
        miss_cases.append([cmds, p.replace(str(home), "$HOME"), [{**g, "path": g["path"].replace(str(home), "$HOME")} for g in got]])
out["missing_folders"] = miss_cases
out["candidates"] = [str(c).replace(str(home), "$HOME") for c in project_env._candidates() if str(c).startswith(str(home))]

# --------------------------------------------------------------------------------------------------------------
# what git says about a worktree: status, brief and the listing, on real worktrees of a temporary repository
# --------------------------------------------------------------------------------------------------------------
import subprocess  # noqa: E402

env_git = {**os.environ, "GIT_CONFIG_GLOBAL": f"{work}/empty-gitconfig", "GIT_CONFIG_NOSYSTEM": "1"}
Path(f"{work}/empty-gitconfig").write_text("")


def sh(cwd, *args):
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=T", *args], cwd=cwd, check=True, capture_output=True, env=env_git)


ROOT = Path(work) / "gitcase"
REPO = ROOT / "repo"
REPO.mkdir(parents=True)
(REPO / "calc.py").write_text("def add(a, b):\n    return a - b\n")
sh(REPO, "init", "-q", "-b", "main")
sh(REPO, "add", "-A")
sh(REPO, "commit", "-q", "-m", "first")
TREES = {}
for tid in ("T-A", "T-B", "T-C"):
    path = ROOT / "repo.worktrees" / tid
    sh(REPO, "worktree", "add", "-b", f"ai/{tid}-x", str(path), "main")
    TREES[tid] = path
(TREES["T-B"] / "calc.py").write_text("def add(a, b):\n    return a + b\n")
(TREES["T-B"] / "staged.txt").write_text("staged\n")
sh(TREES["T-B"], "add", "staged.txt")
(TREES["T-B"] / "feature.py").write_text("x = 1\n")
(TREES["T-B"] / "shot.png").write_bytes(b"\x89PNG" * 300000)
(TREES["T-B"] / "qa").mkdir()
(TREES["T-B"] / "qa/step.txt").write_text("step\n")
(TREES["T-B"] / "src").mkdir()
(TREES["T-B"] / "src/new.py").write_text("y = 2\n")
(TREES["T-B"] / "run.log").write_text("log\n")
(TREES["T-C"] / "later.py").write_text("z = 3\n")
sh(TREES["T-C"], "add", "-A")
sh(TREES["T-C"], "commit", "-q", "-m", "ahead")
for _ in range(12):
    (TREES["T-C"] / "m.py").write_text("m\n" * 5)
    sh(TREES["T-C"], "add", "-A")
sh(TREES["T-C"], "commit", "-q", "-m", "ahead again")
for i in range(35):
    (TREES["T-C"] / f"u{i:02d}.py").write_text("u\n")
(TREES["T-C"] / ".git-note-not-a-dir").write_text("n\n")


def scrub(value):
    return json.loads(json.dumps(value).replace(str(ROOT), "$ROOT"))


async def git_python():
    rows = [
        AiWorktree(ticket_id="T-A", project_id="p1", repo=str(REPO), path=str(TREES["T-A"]), branch="ai/T-A-x", base="main", port=5180, created_at="2026-11-12T08:00:00+00:00"),
        AiWorktree(ticket_id="T-B", project_id="p1", repo=str(REPO), path=str(TREES["T-B"]), branch="ai/T-B-x", base="main", port=5181, state="conflict", created_at="2026-11-12T08:01:00+00:00"),
        AiWorktree(ticket_id="T-C", project_id="p1", repo=str(REPO), path=str(TREES["T-C"]), branch="ai/T-C-x", base="main", port=5182, state="kept", created_at="2026-11-12T08:01:00+00:00"),
        AiWorktree(ticket_id="T-D", project_id="p1", repo=str(REPO), path=str(ROOT / "gone"), branch="ai/T-D-x", base="main", created_at="2026-11-12T08:02:00+00:00"),
        AiWorktree(ticket_id="T-E", project_id="p1", repo=str(REPO), path=str(TREES["T-A"]), branch="ai/T-E-x", base="main", state="removed", created_at="2026-11-12T08:03:00+00:00"),
        AiWorktree(ticket_id="T-F", project_id="p2", repo=str(REPO), path=str(TREES["T-A"]), branch="ai/T-F-x", base="main", created_at="2026-11-12T08:04:00+00:00"),
    ]
    cases = {"rows": [scrub(json.loads(r.model_dump_json())) for r in rows], "status": {}, "brief": {}}
    async with database.async_session() as session:
        for r in rows:
            session.add(r)
        await session.commit()
        for r in rows:
            cases["status"][r.ticket_id] = scrub(await worktrees.status(r))
            cases["brief"][r.ticket_id] = scrub(await worktrees.brief(session, r.ticket_id))
        cases["brief"]["T-none"] = await worktrees.brief(session, "T-none")
        cases["list_p1"] = scrub(await worktrees.list_for_project(session, "p1"))
        cases["list_p2"] = scrub(await worktrees.list_for_project(session, "p2"))
        cases["list_p3"] = scrub(await worktrees.list_for_project(session, "p3"))
    # the hand-over route and the main checkout's guess, with no remote and with remotes of both kinds
    cases["guess"] = {"none": await worktrees.guess_route(str(REPO))}
    sh(REPO, "remote", "add", "origin", "https://gitlab.example.com/a/b.git")
    cases["guess"]["gitlab"] = await worktrees.guess_route(str(REPO))
    return cases


out["git"] = asyncio.run(git_python())
out["git"]["files"] = {
    "T-B": {"calc.py": "def add(a, b):\n    return a + b\n", "staged.txt": "staged\n", "feature.py": "x = 1\n", "qa/step.txt": "step\n", "src/new.py": "y = 2\n", "run.log": "log\n"},
}

OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n")
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
