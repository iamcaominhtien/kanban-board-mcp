"""Golden vectors for the repository scan (`crates/kb-ai-scan`, `services/ai/repo_scan.py`): what `scan` reads from
about thirty small repository layouts, what `suggest` proposes for each, the change fingerprint `sweep` compares, how
a command's result is classified, the folder-and-script helpers (`_dir`, `_npm`, `_py`, `_pkg_cmd`), the answers of
the light model and the AI as they are read, the AI's prompt and a job's document after a scripted run.

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_ai_scan.py
Writes `ai_scan.json` next to this file. It runs with its own temporary KANBAN_* folders and a temporary HOME, builds
the layouts in a temporary folder, runs `git init` in some of them, never runs a command found in a layout and never
opens the developer's database.

A layout is described as data (`files`, `links`, `git`), so the Rust test builds the same folder. Besides what the
functions return, each case records the order in which the system lists every folder of the layout (`dir_order`):
`scan` keeps the first twelve `package.json` in that order (`Path.rglob` reads directories as the file system gives
them), so a layout whose manifests are in several folders is compared exactly when the Rust test's folder is listed in
the same order, and in a normalised order otherwise (see the test).
"""

import base64
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

work = tempfile.mkdtemp(prefix="gen-ai-scan-")
os.environ["KANBAN_CONFIG_DIR"] = f"{work}/config"
os.environ["KANBAN_DB_PATH"] = f"{work}/data/kanban.db"
os.environ["KANBAN_LOG_DIR"] = f"{work}/logs"
os.environ["KANBAN_AI_KEY_FILE"] = f"{work}/ai.key"
os.environ["CLAUDE_CONFIG_DIR"] = f"{work}/claude"
os.environ["HOME"] = f"{work}/home"
os.makedirs(f"{work}/home", exist_ok=True)
os.environ["GIT_CONFIG_GLOBAL"] = f"{work}/gitconfig"
os.environ["GIT_CONFIG_NOSYSTEM"] = "1"
open(f"{work}/gitconfig", "w").close()
sys.path.insert(0, os.getcwd())

from services.ai import repo_scan  # noqa: E402

OUT = Path(__file__).with_name("ai_scan.json")
out: dict = {}


# --------------------------------------------------------------------------------------------------------------
# layouts
# --------------------------------------------------------------------------------------------------------------
def pkg(name="app", deps=None, dev=None, scripts=None, **extra):
    data = {"name": name}
    if deps is not None:
        data["dependencies"] = deps
    if dev is not None:
        data["devDependencies"] = dev
    if scripts is not None:
        data["scripts"] = scripts
    data.update(extra)
    return json.dumps(data, indent=2)


UI_DEPS = {"react": "18.2.0", "react-dom": "18.2.0"}
UI_DEV = {"vite": "5.0.0", "vitest": "1.0.0", "eslint": "9.0.0", "tailwindcss": "3.4.0", "@playwright/test": "1.40.0"}
PYPROJECT_UV = (
    "[project]\nname = 's'\nversion = '0.1'\ndependencies = ['fastapi', 'sqlalchemy']\n"
    "[dependency-groups]\ndev = ['pytest', 'ruff']\n"
)
GHA = (
    "name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n"
    "      - uses: actions/checkout@v4\n"
    "      - run: npm ci\n"
    "      - run: npm test\n"
    "      - name: lint\n        run: npm run lint\n"
    "      - run: |\n          pip install -r requirements.txt\n          pytest -q\n\n          ruff check .\n"
    "          echo done\n"
    "      - run: echo hello\n"
    "      - run: npm test\n"
    "      - run: cargo test --all\n"
    "      - run: go test ./...\n"
    "      - run: make build\n"
    "      -   run:    mypy src   \n"
)

LAYOUTS: list[dict] = []


def layout(name, files=(), links=(), git=None, note="", order_free=False):
    LAYOUTS.append(
        {"name": name, "files": [list(f) for f in files], "links": [list(link) for link in links], "git": git, "note": note}
    )


layout("python_uv", [
    ["pyproject.toml", PYPROJECT_UV], ["uv.lock", ""], ["README.md", "# s\n\nline\n\nmore\n"],
    ["src/s/__init__.py", ""], ["tests/test_s.py", "def test_x():\n    assert True\n"],
])
layout("python_requirements_tox", [
    ["requirements.txt", "flask==3.0\npytest\n"], ["tox.ini", "[tox]\nenvlist = py312\n[testenv]\ncommands = pytest\n"],
    ["app.py", "print('x')\n"], ["tests/test_a.py", ""],
])
layout("python_poetry", [
    ["pyproject.toml", "[tool.poetry]\nname = 'p'\n[tool.poetry.dependencies]\ndjango = '*'\n[tool.poetry.group.dev.dependencies]\npytest = '*'\n"],
    ["poetry.lock", ""], ["test/test_a.py", ""],
])
layout("python_pip_library", [
    ["pyproject.toml", "[project]\nname = 'calc'\nversion = '0.1.0'\n[tool.ruff]\nline-length = 100\n[tool.pytest.ini_options]\naddopts = '-q'\n"],
    ["tests/test_calc.py", "def test_x():\n    assert True\n"],
])
layout("node_npm_ui", [
    ["package.json", pkg("ui", UI_DEPS, UI_DEV, {"test": "vitest", "lint": "eslint src", "build": "vite build", "dev": "vite"})],
    ["package-lock.json", "{}"], ["index.html", "<html></html>"], ["src/main.tsx", "x"], ["tests/a.test.ts", "x"],
])
layout("node_pnpm", [
    ["package.json", pkg("p", {"next": "14"}, {"jest": "29"}, {"test": "jest", "build": "next build"})],
    ["pnpm-lock.yaml", "lockfileVersion: 6\n"], ["__tests__/a.test.js", ""],
])
layout("node_yarn_scripts_only_dev", [
    ["package.json", pkg("y", {"vue": "3"}, None, {"dev": "vite", "test": "vitest run"})], ["yarn.lock", ""],
])
layout("node_vitest_variants", [
    ["package.json", pkg("v", None, {"vitest": "1"}, {"test": "vitest --run"})],
    ["svelte/package.json", pkg("sv", {"svelte": "4"}, None, {"test": "vitest run --coverage", "lint": "eslint ."})],
    ["electron-app/package.json", pkg("el", None, {"electron": "30"}, {"test": "echo vitest"})],
])
layout("node_monorepo_workspaces", [
    ["package.json", pkg("root", None, None, {"test": "npm test --workspaces"}, workspaces=["packages/*", "apps/*"])],
    ["packages/a/package.json", pkg("a", None, {"jest": "29"}, {"test": "jest", "build": "tsc"})],
    ["packages/b/package.json", pkg("b", {"react": "18"}, None, {"lint": "eslint ."})],
    ["apps/web/package.json", pkg("web", {"next": "14", "react": "18"}, None, {"build": "next build", "test": "playwright test"})],
    ["node_modules/dep/package.json", pkg("dep", None, None, {"test": "x"})],
    [".github/skills/x/scripts/package.json", pkg("tool", None, None, {"test": "x"})],
    [".claude/worktrees/w/package.json", pkg("wt", None, None, {"test": "x"})],
    ["apps/web/node_modules/y/package.json", pkg("y")],
], order_free=True)
layout("rust_crate", [
    ["Cargo.toml", "[package]\nname = 'c'\nversion = '0.1.0'\n"], ["src/main.rs", "fn main() {}\n"], ["tests/it.rs", ""],
])
layout("go_module", [["go.mod", "module example.com/m\n\ngo 1.22\n"], ["main.go", "package main\n"], ["main_test.go", ""]])
layout("java_maven", [["pom.xml", "<project/>"], ["src/test/java/ATest.java", ""]])
layout("java_gradle", [["build.gradle", "plugins { id 'java' }\n"], ["settings.gradle", ""], ["src/test/java/ATest.java", ""]])
layout("dotnet_solution", [["App.sln", ""], ["App/App.csproj", "<Project/>"], ["App.Tests/App.Tests.csproj", "<Project/>"]])
layout("php_composer", [["composer.json", "{\"name\": \"a/b\", \"require\": {\"php\": \">=8\"}}"], ["tests/ExampleTest.php", ""]])
layout("ruby_gemfile", [["Gemfile", "source 'https://rubygems.org'\ngem 'rails'\n"], ["Gemfile.lock", ""], ["test/a_test.rb", ""]])
layout("makefile_only", [
    ["Makefile", "# build\n.PHONY: all test\nall: build\nbuild:\n\techo b\ntest-unit: build\n\techo t\n_hidden:\n9nine:\nlint :\n"
                 "CFLAGS := -O2\nfoo:=bar\nversion:\n\t@echo 1\nÜber: x\ndeploy-prod:\n"],
    ["main.c", "int main(){}"],
])
layout("makefile_many_targets", [["Makefile", "".join(f"t{i}:\n\techo {i}\n" for i in range(30))]])
layout("docker_and_compose", [
    ["Dockerfile", "FROM scratch\n"], ["compose.yaml", "services: {}\n"], ["docker-compose.yml", "services: {}\n"],
])
layout("docker_compose_only", [["docker-compose.yml", "services: {}\n"]])
layout("github_actions", [
    [".github/workflows/ci.yml", GHA],
    [".github/workflows/release.yaml", "jobs:\n  r:\n    steps:\n      - run: npm run build\n      - run: |\n         docker build .\n         pytest\n"],
    [".github/workflows/notes.txt", "run: pytest\n"],
    [".github/workflows/odd.yxml", "run: jest\n"],
    [".github/workflows/sub.yml/inner.yml", "run: jest\n"],
    ["package.json", pkg("a", None, None, {"test": "jest"})],
])
layout("github_actions_many_commands", [
    [".github/workflows/many.yml", "jobs:\n  j:\n    steps:\n" + "".join(f"      - run: npm run build:{i}\n" for i in range(30))],
])
layout("github_actions_block_edges", [
    [".github/workflows/b.yml",
     "steps:\n  - run: |\n    unindented test\n  - run: >\n      npm test\n  - run: |\n      a\n\t  tabbed test\n      b\n"
     "  - run:\n      test: nested\n  run: pytest\n   - run: lint -x\n- run: ruff .\nrun:jest\n"
     "      - run: |-\n          vitest run\n  - run: \"eslint .\"\n  - run: \"TEST\"\n  - run: contest\n  - run: tsc --noEmit\n"],
    [".github/workflows/crlf.yml", "steps:\r\n  - run: |\r\n      pytest -q\r\n      mypy .\r\n  - run: cargo test\r\n"],
])
layout("gitlab_ci", [
    [".gitlab-ci.yml", "test:\n  script:\n    - pytest\n    - ruff check .\nbuild:\n  script:\n    - npm run build\n"],
    ["pyproject.toml", "[project]\nname='g'\n[tool.pytest]\n"],
])
layout("circleci", [
    [".circleci/config.yml", "version: 2.1\njobs:\n  build:\n    steps:\n      - run: npm test\n      - run: npm run lint\n"],
    ["package.json", pkg("c", None, None, {"test": "mocha"})],
])
layout("nothing_recognizable", [["README.md", "just words\n"], ["notes.txt", "x"], ["data/blob.bin", "\x00\x01\x02"]])
layout("empty_repository", [])
layout("only_empty_folders", [["a/.keep", ""], ["b/c/.keep", ""]])
layout("agent_files", [
    ["CLAUDE.md", "# rules\n"], ["AGENTS.md", "# agents\n"], [".claude/settings.json", "{}"], [".mcp.json", "{}"],
    ["package.json", pkg("x", {"react": "18"})],
])
layout("agent_files_partial", [[".claude/skills/x/SKILL.md", "x"], ["README.md", "r"]])
layout("malformed_package_json", [
    ["package.json", "{ not json at all"], ["ui/package.json", ""], ["api/package.json", "\ufeff" + pkg("bom", {"react": "1"})],
    ["lib/package.json", pkg("ok", {"vue": "3"}, None, {"test": "mocha"})],
], order_free=True)
layout("malformed_binary_files", [
    ["pyproject.toml", {"b64": base64.b64encode(b"[project]\nname='\xff\xfe'\n\x00\x00fastapi\xc3\x28 pytest ruff\n").decode()}],
    ["Makefile", {"b64": base64.b64encode(b"all:\n\t\xff\nbad\xc3(:\nok2:\n").decode()}],
    ["README.md", {"b64": base64.b64encode(b"a\r\nb\rc\n\xff\xfe\nd").decode()}],
    [".github/workflows/ci.yml", {"b64": base64.b64encode(b"- run: pytest\xff\n- run: \x00npm test\n").decode()}],
])
layout("manifest_is_a_folder_or_link", [
    ["package.json/inner.txt", "x"], ["ui/package.json", pkg("ui", {"react": "1"})], ["real/package.json", pkg("real")],
], [["linked", "real"], ["broken", "does-not-exist"], ["ui/pyproject.toml", "../real/package.json"]], order_free=True)
layout("symlinks_to_folders", [
    ["real/package.json", pkg("real", {"vue": "3"})], ["real/tests/t.txt", "x"],
], [["alias", "real"], ["testlink", "real/tests"], ["loop", "."]], order_free=True)
layout("package_json_not_an_object", [["package.json", "[1, 2]"], ["README.md", "x"]])
layout("package_json_string", [["package.json", "\"hello\""]])
layout("package_json_null", [["package.json", "null"]])
layout("package_json_number", [["package.json", "12"]])
layout("package_json_deps_list", [["package.json", "{\"name\": \"a\", \"dependencies\": [\"react\"]}"]])
layout("package_json_deps_string", [["package.json", "{\"name\": \"a\", \"devDependencies\": \"react\"}"]])
layout("package_json_falsy_parts", [
    ["package.json", "{\"name\": null, \"dependencies\": [], \"devDependencies\": 0, \"scripts\": \"\"}"],
])
layout("package_json_odd_name_and_scripts", [
    ["package.json", "{\"name\": 12, \"scripts\": {\"test\": \"jest\", \"lint\": \"x\", \"build\": \"y\", \"build:ci\": \"z\"}, \"dependencies\": {\"react\": 1}}"],
])
layout("deep_folders", [
    ["/".join(["d"] * 12) + "/package.json", pkg("deep", {"react": "18"}, None, {"test": "jest"})],
    ["/".join(["x"] * 30) + "/tests/t.py", ""], ["a/b/c/test_one/x", ""], ["a/b/c/testing/x", ""], ["a/b/tests/x", ""],
    ["Test/upper.txt", "x"], ["tests", "a file, not a folder"],
])
layout("test_folders_many", [[f"t{i:02d}/test{i:02d}/x", ""] for i in range(14)] + [["test/x", ""], ["tests/x", ""], [".hidden/tests/x", ""]])
layout("test_folders_in_skipped_places", [
    ["node_modules/pkg/test/x", ""], [".venv/lib/tests/x", ""], [".git-like/test/x", ""], ["build/test/x", ""],
    ["dist/tests/x", ""], ["src/tests/x", ""],
])
layout("large_files", [
    ["package.json", {"repeat": "{\"name\": \"big\", \"pad\": \"", "times": 1, "tail": "x" * 250_000 + "\"}"}],
    ["pyproject.toml", {"repeat": "# pad\n", "times": 40_000, "tail": "fastapi pytest ruff\n"}],
    ["README.md", {"repeat": "line\n", "times": 100_000}],
    ["Makefile", {"repeat": "x" * 80 + "\n", "times": 3_000, "tail": "late:\n"}],
    [".github/workflows/ci.yml", {"repeat": "# pad\n", "times": 50_000, "tail": "      - run: pytest\n"}],
])
layout("large_but_valid_package_json", [
    ["package.json", {"repeat": "", "times": 0, "tail": "{\"name\": \"fits\", \"scripts\": {\"test\": \"jest\"}, \"pad\": \"" + "y" * 150_000 + "\"}"}],
])
layout("many_manifests", [[f"pkg{i:02d}/package.json", pkg(f"p{i}", None, None, {"test": "jest"})] for i in range(15)]
       + [[f"py{i:02d}/pyproject.toml", "[project]\nname='x'\n[tool.pytest]\n"] for i in range(10)], order_free=True)
layout("many_fingerprint_files", [[f"d{i:02d}/{n}", f"{n} {i}"] for i in range(60) for n in ("Makefile", "go.mod", "Cargo.toml", "Gemfile")])
layout("unicode_and_spaces_in_paths", [
    ["apps/my app/package.json", pkg("sp", {"react": "18"}, None, {"test": "jest", "lint": "eslint"})],
    ["ứng dụng/package.json", pkg("vn", None, None, {"build": "vite build"})],
    ["srv/server code/pyproject.toml", "[project]\nname='x'\n[tool.pytest]\n[tool.ruff]\n"], ["srv/server code/uv.lock", ""],
    ["thử nghiệm/x", ""], ["test dir/x", ""],
], order_free=True)
layout("crlf_and_cr_files", [
    ["Makefile", "a:\r\n\tx\r\nb:\r\n"], ["README.md", "1\r\n2\r\n3\r"], ["pyproject.toml", "[tool.poetry]\r\nname='x'\r\n"],
])
layout("pyproject_variants", [
    ["a/pyproject.toml", "[project]\nname='a'\ndependencies=['Flask', 'PYTEST', 'Ruff']\n"],
    ["b/pyproject.toml", "[project]\nname='b'\n"], ["b/uv.lock", ""],
    ["c/pyproject.toml", "[tool.poetry]\n[tool.uv]\n"], ["c/uv.lock", ""],
], order_free=True)
layout("git_tracked_and_ignored", [
    ["package.json", pkg("root", {"react": "18"}, None, {"test": "jest"})],
    ["ui/package.json", pkg("ui", {"vue": "3"}, None, {"build": "vite build"})],
    ["vendor/tool/package.json", pkg("tool", None, None, {"test": "x"})],
    ["server/pyproject.toml", "[project]\nname='s'\n[tool.pytest]\n"], ["server/uv.lock", ""],
    ["untracked/package.json", pkg("u")],
    [".gitignore", "vendor/\n"],
], git={"commit": True, "remote": "https://user:token@github.com/o/r.git", "untracked": ["untracked/package.json"]}, order_free=True)
layout("git_gitlab_remote", [["go.mod", "module m\n"]], git={"commit": True, "remote": "git@gitlab.com:o/r.git"})
layout("git_github_scp_remote", [["Cargo.toml", "[package]\nname='x'\n"]], git={"commit": True, "remote": "git@github.com:o/r.git"})
layout("git_https_remote_user_only", [["go.mod", "module m\n"]], git={"commit": True, "remote": "https://oauth2:abc@gitlab.example.com/o/r.git"})
layout("git_no_commit", [["package.json", pkg("n", {"react": "1"}, None, {"test": "jest"})]], git={"commit": False, "remote": None})
layout("git_no_remote", [["package.json", pkg("n", None, None, {"test": "jest"})]], git={"commit": True, "remote": None})
layout("git_remote_with_blank_url", [["go.mod", "module m\n"]], git={"commit": True, "remote": "//@//x"})


def materialize(root: Path, spec: dict) -> None:
    root.mkdir(parents=True, exist_ok=True)
    for rel, content in spec["files"]:
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, dict):
            if "b64" in content:
                path.write_bytes(base64.b64decode(content["b64"]))
            else:
                path.write_text(content["repeat"] * content["times"] + content.get("tail", ""), encoding="utf-8", newline="")
        else:
            path.write_text(content, encoding="utf-8", newline="")
    for rel, target in spec["links"]:
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        os.symlink(target, root / rel)
    git = spec["git"]
    if git is not None:
        def run(*args):
            subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=T", *args], cwd=root, check=True, capture_output=True)

        run("init", "-q", "-b", "main")
        if git.get("remote"):
            run("remote", "add", "origin", git["remote"])
        if git.get("commit"):
            run("add", "-A")
            for rel in git.get("untracked", []):
                run("rm", "-q", "--cached", rel)
            run("commit", "-q", "--allow-empty", "-m", "x")


def dir_order(root: Path) -> dict:
    out_: dict = {}
    for dirpath, dirs, _ in os.walk(root):
        rel = os.path.relpath(dirpath, root)
        out_["" if rel == "." else rel] = os.listdir(dirpath)
        dirs[:] = [d for d in dirs if d != ".git"]
    return out_


def error_of(exc: Exception) -> dict:
    return {"error": [type(exc).__name__, str(exc)]}


cases = []
for i, spec in enumerate(LAYOUTS):
    root = Path(work) / "repos" / f"{i:02d}-{spec['name']}"
    materialize(root, spec)
    case = {k: v for k, v in spec.items()}
    case["order_free"] = False
    case["dir_order"] = dir_order(root)
    try:
        found = repo_scan.scan(str(root))
        assert found["folder"] == str(root)
        found["folder"] = "<root>"
        case["scan"] = found
        try:
            case["suggest"] = repo_scan.suggest(found)
        except Exception as exc:  # noqa: BLE001
            case["suggest"] = error_of(exc)
    except Exception as exc:  # noqa: BLE001
        case["scan"] = error_of(exc)
        case["suggest"] = None
    case["fingerprint"] = repo_scan.fingerprint(root)
    committed = repo_scan._committed(root)
    case["committed"] = None if committed is None else sorted(committed)
    cases.append(case)
ORDER_FREE = {"node_monorepo_workspaces", "malformed_package_json", "manifest_is_a_folder_or_link", "symlinks_to_folders",
              "many_manifests", "unicode_and_spaces_in_paths", "pyproject_variants", "git_tracked_and_ignored"}
for case in cases:
    case["order_free"] = case["name"] in ORDER_FREE
out["layouts"] = cases

# the folder is the one given, as `str(Path(...))` writes it
out["path_str"] = [[g, str(Path(g))] for g in ["", ".", "./", "a//b", "//a", "///a", "/a/./b/", "/", "//", "a/../b", "./a", "a/", "/a//",
                                                 "ü/ö", "a b/c", "/./", "a/./.", "////", "../x"]]
out["folder_missing"] = []
for given in ["/no/such/folder", "no-such", "~/no-such-here", "/etc/hostname"]:
    try:
        repo_scan.scan(given)
        out["folder_missing"].append([given, None])
    except Exception as exc:  # noqa: BLE001
        out["folder_missing"].append([given, [type(exc).__name__, str(exc)]])

# --------------------------------------------------------------------------------------------------------------
# classify and the reasons
# --------------------------------------------------------------------------------------------------------------
OUTPUTS = [
    "", "ok", "sh: npm: command not found", "bash: ./scripts/ci.sh: No such file or directory", 'npm error Missing script: "lint:ci"',
    "FAIL src/a.test.ts\nTests  2 failed", "npm error code ENOENT\nnpm error syscall open\nnpm error path /r/package.json\nnpm error errno -2\n"
    "npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '/r/package.json'",
    "error Couldn't find a package.json file in \"/r\"", " ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND  No package.json was found",
    "FAIL a.test.ts\nError: ENOENT: no such file or directory, open 'fixtures/x.json'",
    "FAIL src/scan.test.ts\n  ● reads the manifest\n    Error: ENOENT: no such file or directory, open '/r/test/fixtures/package.json'\n"
    "    Could not read package.json fixture\nTests:  1 failed, 4 passed\nnpm error Lifecycle script `test` failed with error:\nnpm error code 1",
    "npm ERR! path /r/package.json\nnpm ERR! code ENOENT", "npm ERR! enoent ENOENT: no such file or directory, open '/r/package.json'",
    "python: can't open file '/r/manage.py': [Errno 2] No such file or directory", "make: *** No rule to make target 'lint'.  Stop.",
    "make: *** No targets specified and no makefile found.  Stop.", "ERROR: file or directory not found: tests/",
    "make: *** No rule to make target 'a.o', needed by 'app'.  Stop.", "sh: line 3: tool: No such file or directory\n1 failed",
    "zsh: command not found: pnpm", "/bin/sh: 1: foo: not found", "error: unknown option '--x'", "Unknown command: \"nope\"",
    "error: unrecognized subcommand 'x'", "Failed to spawn: `pytest`", "error: Couldn't find a script named \"x\"", "Unknown script: \"x\"",
    "'x' is not recognized as an internal or external command", "no such command: `x`", "COMMAND NOT FOUND", "x\r\ny: not found\r\n",
    "line1\nsh: foo: No such file or directory\nline3", "dash: 1: x: No such file or directory", "ash: x: No such file or directory",
    "bash: x: No such file or directory", "sh: a b: No such file or directory", "sh: x: No such file or directory trailing",
    "open: No such file or directory: 'a/b.txt'", "No such file or directory: ", "No such file or directory: x/y\nmore",
    "No package.json (or package.yaml, or package.json5) was found in \"/r\"", "ünïcode: not found é", "a" * 5000 + ": not found",
    "error: Couldn't find a package.json file", "Couldn't find a package.json file", "npm error enoent\nnpm error path package.json",
    "npm error path /r/package.json trailing package.json", "no rule to make target 'x'.\n\n  stop", "NPM ERR! ENOENT package.json",
]
CODES = [0, 1, 2, 126, 127, 254, -9, -15, 255, None]
out["classify"] = [[code, text, timed, repo_scan.classify(code, text, timed)]
                   for text in OUTPUTS for code in CODES for timed in (False,) if not (text.startswith("a" * 50) and code not in (1, 0))]
out["classify"] += [[None, "", True, repo_scan.classify(None, "", True)], [0, "", True, repo_scan.classify(0, "", True)],
                    [127, "x", True, repo_scan.classify(127, "x", True)]]
out["why_wrong"] = [[text, code, repo_scan._why_wrong(text, code)] for text in OUTPUTS for code in (1, 2, 127, None)]

# --------------------------------------------------------------------------------------------------------------
# folders and scripts of a package
# --------------------------------------------------------------------------------------------------------------
PKGS = [
    {"path": ".", "kind": "node", "scripts": {"test": "jest"}}, {"path": "", "kind": "node", "scripts": {}},
    {"path": "ui", "kind": "node", "scripts": {"test": "vitest", "lint": "eslint", "build": "vite build"}},
    {"path": "vendor/my tool", "kind": "node", "scripts": {"test": "vitest run"}}, {"path": "a\\b", "kind": "node", "scripts": {"test": "mocha vitest"}},
    {"path": "a/b", "kind": "node", "scripts": {"test": "vitest --run"}}, {"path": "x", "kind": "node", "scripts": {"test": "vitest run --coverage"}},
    {"path": "x", "kind": "node", "scripts": {"test": "npx vitest"}}, {"path": "x", "kind": "node", "scripts": {"test": ""}},
    {"path": "x", "kind": "node"}, {"path": "x", "kind": "node", "scripts": None}, {"path": "x", "kind": "node", "scripts": {"test": "VITEST"}},
    {"path": "x", "kind": "node", "scripts": {"lint": "a", "build": "b", "dev": "c", "test:unit": "d"}},
    {"path": ".", "kind": "python", "manager": "uv"}, {"path": "s", "kind": "python", "manager": "uv"},
    {"path": "my srv", "kind": "python", "manager": "poetry"}, {"path": ".", "kind": "python", "manager": "poetry"},
    {"path": ".", "kind": "python", "manager": "pip"}, {"path": "lib", "kind": "python", "manager": "pip"},
]
out["dir_npm_py"] = [
    [p, repo_scan._dir(p), repo_scan._npm(p, "ci"), repo_scan._npm(p, "run x"), repo_scan._py(p, "sync"),
     repo_scan._py(p, "run pytest -q")] for p in PKGS
]
out["pkg_cmd"] = [[p, s, repo_scan._pkg_cmd(p, s)] for p in PKGS if p["kind"] == "node" for s in ("test", "lint", "build", "dev", "start")]
out["pkg_cmd_errors"] = []
for p in [{"path": "x", "kind": "node", "scripts": "test"}, {"path": "x", "kind": "node", "scripts": ["test"]},
          {"path": "x", "kind": "node", "scripts": 5}, {"path": "x", "kind": "node", "scripts": {"test": ["vitest"]}},
          {"path": "x", "kind": "node", "scripts": {"test": 5}}, {"path": "x", "kind": "node", "scripts": {"test": {"vitest": 1}}},
          {"path": "x", "kind": "node", "scripts": {"test": ["jest"]}}, {"path": "x", "kind": "node", "scripts": "lint build"},
          {"path": "x", "kind": "node", "scripts": True}]:
    row = [p]
    for s in ("test", "lint"):
        try:
            row.append([s, repo_scan._pkg_cmd(p, s)])
        except Exception as exc:  # noqa: BLE001
            row.append([s, error_of(exc)])
    out["pkg_cmd_errors"].append(row)

# --------------------------------------------------------------------------------------------------------------
# suggest, on facts written by hand
# --------------------------------------------------------------------------------------------------------------
BASE = {"packages": [], "languages": [], "ui": False}
FOUNDS = [
    BASE, {**BASE, "ui": True}, {**BASE, "languages": ["go"]}, {**BASE, "languages": ["rust"]}, {**BASE, "languages": ["go", "rust"]},
    {**BASE, "languages": ["go"], "ci_commands": ["pytest -q"]}, {**BASE, "ci_commands": ["npm test", "pytest", "npm run lint", "ruff check ."]},
    {**BASE, "ci_commands": ["make LINT", "Jest --ci", "run eslint", "contest", "latest", "pytest-cov", "mypy ."]},
    {**BASE, "ci_commands": ["cargo build", "x lint y"]}, {**BASE, "remote": "https://github.com/o/r"}, {**BASE, "remote": "git@gitlab.com:o/r"},
    {**BASE, "remote": ""}, {**BASE, "remote": None}, {**BASE, "git": True}, {**BASE, "git": False},
    {"packages": [{"path": "vendor/my tool", "kind": "node", "scripts": {}}, {"path": ".", "kind": "python", "manager": "uv", "pytest": True},
                  {"path": "lib", "kind": "python", "manager": "pip", "pytest": True, "ruff": True}], "languages": ["node", "python"], "ui": False},
    {"packages": [{"path": "ui", "kind": "node", "scripts": {"test": "vitest", "lint": "eslint src", "build": "vite build"}},
                  {"path": "server", "kind": "python", "manager": "uv", "pytest": True, "ruff": True}],
     "languages": ["node", "python"], "ui": True, "ci_commands": ["cd server && uv run pytest -q"], "remote": "https://github.com/o/r", "git": True},
    {"packages": [{"path": "a", "kind": "node", "scripts": {"test": "x"}}, {"path": "b", "kind": "node", "scripts": {"test": "y"}},
                  {"path": "c", "kind": "node", "scripts": {"test": "z"}}], "languages": ["node"], "ui": False},
    {"packages": [{"path": "a", "kind": "node", "scripts": {}}, {"path": "a", "kind": "node", "scripts": {}}], "languages": ["node"], "ui": 1},
    {"packages": [{"path": ".", "kind": "python", "manager": "poetry", "pytest": True, "ruff": True},
                  {"path": "s", "kind": "python", "manager": "poetry", "pytest": False, "ruff": True}], "languages": ["python"], "ui": 0},
    {"packages": [{"path": ".", "kind": "other"}], "languages": [], "ui": False},
]
out["suggest"] = []
for f in FOUNDS:
    try:
        out["suggest"].append([f, repo_scan.suggest(f)])
    except Exception as exc:  # noqa: BLE001
        out["suggest"].append([f, error_of(exc)])
out["suggest_missing_keys"] = []
for f in [{}, {"packages": []}, {"packages": [], "languages": []}, {"languages": [], "ui": False}]:
    try:
        out["suggest_missing_keys"].append([f, repo_scan.suggest(f)])
    except Exception as exc:  # noqa: BLE001
        out["suggest_missing_keys"].append([f, error_of(exc)])
out["wanted"] = [[e, f, repo_scan._wanted(e, f)] for e in ({}, {"ui": True}, {"ui": False}, {"ui": 1}, {"ui": ""})
                 for f in ({}, {"ui": True}, {"ui": False}, {"ui": 0}, {"ui": "x"})]
out["role_names"] = repo_scan._ROLE_NAMES

# --------------------------------------------------------------------------------------------------------------
# the answers of the light model and of the AI
# --------------------------------------------------------------------------------------------------------------
TEXTS = [
    None, "", "no json here", '{"roles": ["dev", "qa", "bogus"], "plugins": ["design", "nope"], "why": "small repo"}',
    'Sure!\n```json\n{"roles": ["dev"]}\n```\nBye {not json}', "{}", "[1,2]", "{ {", '{"a": 1} and {"b": 2}', "} {", '{"a": [1, 2}',
    '{"commands": {"prepare": {"command": "npm ci", "source": "ci.yml · job ui", "note": ""}, "test": "npm test", "lint": 5, "build": null}, "notes": "n"}',
    '{"commands": {"test": {"command": "  npm   --prefix ui\\n test  ", "source": "' + "s" * 300 + '", "note": "' + "n" * 400 + '"}}, "notes": ' + '"' + "z" * 400 + '"}',
    '{"commands": []}', '{"commands": {}}', '{"commands": "x"}', '{"notes": "x"}', '{"commands": {"prepare": {"command": ["a"], "source": 3}}, "notes": 7}',
    '{"commands": {"prepare": {"command": "a" }, "test": {"command": "é\\u00e9 \\ud83d\\ude00"}}}', "text {\n\"commands\": {\"build\": \"make\"}\n} more",
    '{"commands": {"test": {"command": "x", "source": "a › b", "note": null}}, "notes": false}', '{"commands": {"test": {"command": true}}}',
    "\u00e9 {\"commands\": {\"lint\": \"ruff\"}}", '{"commands": {"test": "a"}, "commands": {"lint": "b"}}',
]
out["parse_refined"] = [[t, repo_scan._parse_refined(t)] for t in TEXTS]
out["parse_proposal"] = [[t, repo_scan._parse_proposal(t)] for t in TEXTS]
SUGGESTED = [
    {}, {"commands": {"test": "npm test", "lint": "", "build": "make"}, "prepare": "npm ci"}, {"prepare": "uv sync"}, {"commands": None, "prepare": None},
    {"commands": {"prepare": "ignored", "test": "t"}, "prepare": ""}, {"commands": {"test": 0, "lint": "l"}, "prepare": "p"},
]
out["code_proposal"] = [[s, repo_scan._code_proposal(s)] for s in SUGGESTED]
TOOLS = [
    ("Read", {"file_path": "/tmp/wt/.github/workflows/ci.yml"}, "/tmp/wt"), ("Read", {"file_path": "/other/x"}, "/tmp/wt"),
    ("Read", {"file_path": "/tmp/wt"}, "/tmp/wt"), ("Read", {"file_path": "/tmp/wtx/y"}, "/tmp/wt"), ("Read", {}, "/tmp/wt"),
    ("Read", {"file_path": None}, "/tmp/wt"), ("Read", {"file_path": 5}, "/tmp/wt"), ("Read", {"file_path": "/a//b"}, ""),
    ("Glob", {"pattern": "**/*.yml"}, "/x"), ("Glob", {}, "/x"), ("Grep", {"pattern": "test"}, "/x"), ("Grep", {"pattern": 5}, "/x"),
    ("LS", {"path": "/tmp/wt/ui"}, "/tmp/wt"), ("LS", {"path": "/tmp/wt"}, "/tmp/wt"), ("LS", {}, "/tmp/wt"), ("LS", {"path": ""}, "/tmp/wt"),
    ("Bash", {"command": "ls"}, "/x"), ("", {}, "/x"), ("Read", {"file_path": "/tmp/wt//a"}, "/tmp/wt"), ("Read", {"file_path": "/tmp/wt/"}, "/tmp/wt"),
]
out["describe_tool"] = [[n, d, c, repo_scan._describe_tool(n, d, c)] for n, d, c in TOOLS]

FOUND_FOR_PROMPT = {
    "languages": ["node"], "frameworks": ["react"], "packages": [{"path": ".", "kind": "node", "name": "x", "scripts": {"test": "jest"}}],
    "ci_commands": ["npm test", "ünï"], "makefile_targets": ["all"], "agent_files": [], "monorepo": False, "ui": True, "extra": "never shown",
}
LAST = {
    "prepare": {"command": "npm ci", "status": "works", "exit_code": 0, "tail": []},
    "test": {"command": "npm test", "status": "wrong", "exit_code": 127, "tail": ["a", "b", "c", "d", "e", "f"]},
    "lint": {"command": "npm run lint", "status": "fails", "exit_code": 1, "tail": ["x" * 300, "y" * 300]},
    "build": None,
}
PROMPTS = [
    (FOUND_FOR_PROMPT, "", {}, {}), (FOUND_FOR_PROMPT, "  the app is at the root  ", {}, {}), (FOUND_FOR_PROMPT, "h" * 1500, {}, {}),
    (FOUND_FOR_PROMPT, "", {"test": "npm test", "build": ""}, {}), (FOUND_FOR_PROMPT, "x", {"lint": "make lint"}, LAST),
    (FOUND_FOR_PROMPT, "", {"test": "npm test"}, LAST), ({}, "", {}, None), ({"languages": ["{facts}", "{extra}", "{{x}}"]}, "{extra}", {"a": "{facts}"}, {}),
    ({"packages": [{"path": str(i), "kind": "node", "scripts": {"test": "x" * 100}} for i in range(200)]}, "", {}, {}),
    (FOUND_FOR_PROMPT, "", {}, {"test": {"command": None, "status": "timeout", "exit_code": None, "tail": None}, "lint": {"status": "wrong"}}),
]
out["ai_prompt"] = [[f, h, k, last, repo_scan._ai_prompt(f, h, k, last)] for f, h, k, last in PROMPTS]
import hashlib  # noqa: E402

out["prompts"] = {
    "ai": [len(repo_scan.AI_PROMPT), hashlib.sha256(repo_scan.AI_PROMPT.encode()).hexdigest()],
    "refine": [len(repo_scan.REFINE_PROMPT), hashlib.sha256(repo_scan.REFINE_PROMPT.encode()).hexdigest()],
}

# --------------------------------------------------------------------------------------------------------------
# the job's document
# --------------------------------------------------------------------------------------------------------------
def job_script(mode, trial, ops, finish):
    job = repo_scan._Job("scn", mode, "hint", dict(trial), {"commands": {}})
    for op in ops:
        kind, args = op[0], op[1:]
        if kind == "step":
            job.step(*args)
        elif kind == "mark":
            key, state, kw = args
            job.mark(key, state, **kw)
        elif kind == "line":
            job.line(*args)
    job.finish(*finish)
    doc = dict(job.doc)
    doc.pop("started_at"), doc.pop("ended_at")
    for s in doc["steps"]:
        s["at_s"] = None if s["at_s"] is None else 0
    return {"doc": doc, "trial": job.trial}


RUNNING = {"command": "x", "status": "running", "ok": False, "exit_code": None, "seconds": 0, "tail": [], "reason": None}
WAITING = {**RUNNING, "status": "waiting"}
DONE = {**RUNNING, "status": "works", "ok": True, "exit_code": 0}
STEPS = [("step", "ai", "The AI is reading", "d", "running"), ("step", "path", "Looking"), ("step", "prepare", "Prepare"),
         ("step", "test", "Test"), ("step", "ai", "Again", "d2", "waiting"), ("mark", "ai", "done", {"label": "L", "detail": "D"}),
         ("mark", "test", "running", {}), ("mark", "nope", "done", {}), ("mark", "prepare", "failed", {"detail": "boom"}),
         ("line", "a" * 600), *[("line", f"l{i}") for i in range(450)]]
out["job"] = [
    ["ai", {"prepare": None, "test": WAITING, "lint": RUNNING, "build": DONE}, STEPS, ("done",)],
    ["try", {}, STEPS, ("failed", "boom")], ["ai", {"test": RUNNING}, STEPS[:6], ("timeout", "The AI stopped after 10 minutes.")],
    ["try", {"test": WAITING, "lint": {"status": "running", "x": 1}}, [], ("cancelled",)],
    ["try", {"test": WAITING, "lint": RUNNING, "build": None, "prepare": {}}, [("step", "a", "A", "", "running"), ("step", "b", "B")], ("failed", None)],
    ["try", {"test": WAITING}, [("step", "a", "A", "", "running"), ("step", "b", "B"), ("step", "c", "C", "", "done")], ("failed", "")],
]
out["job"] = [[m, t, ops, fin, job_script(m, t, ops, fin)] for m, t, ops, fin in out["job"]]
VIEWS = [
    "", "{}", '{"state": "running"}', '{"started_at": "2026-11-12T10:00:00+00:00", "ended_at": "2026-11-12T10:00:42.9+00:00"}',
    '{"started_at": "2026-11-12T10:00:00.5+00:00", "ended_at": "2026-11-12T10:00:00+00:00"}', '{"started_at": "garbage", "ended_at": null}',
    '{"started_at": "2026-11-12T10:00:00+00:00", "ended_at": "bad"}', '{"started_at": "", "state": "done"}',
    '{"started_at": "2026-11-12T10:00:00+00:00", "ended_at": "2026-11-12T12:30:00+02:00"}',
]
out["job_view"] = [[v, repo_scan._job_view(v)] for v in VIEWS if "ended_at" in v or v in ("", "{}", '{"state": "running"}', '{"started_at": "garbage", "ended_at": null}')]

OUT.write_text(json.dumps(out, ensure_ascii=False, indent=0, sort_keys=False) + "\n", encoding="utf-8")
print(f"wrote {OUT} ({OUT.stat().st_size} bytes, {len(cases)} layouts)")
