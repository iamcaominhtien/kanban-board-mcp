"""Golden vectors for `services/assistant/{docs,editor,ideas}.py` and `services/docs_ai/` (`crates/kb-assist/src/`):
the Docs AI, the editor assistant, the ideas assistant.

`scenarios`: each one holds its rows (dumped from the Python models) and a list of calls with what came back:
`settings` (Docs AI settings: describe, update, who answers), `tidy` (an import over a corpus of Markdown),
`health` (Docs health: missing docs, broken links, overlaps, dismissals), `handoff` (who can receive a page's
threads, and the note a team is sent), `editor` (the /ai menu, what will be sent), `ideas` (status, switches,
advice).

`turns`: everything a Docs AI job, an editor turn and an ideas turn is started with, for a matrix of situations
(each kind of job, a page with and without comments, a selection in the editor, an idea with assumptions). The CLI
of every team is the recorder of `gen_assist.py` (the same bytes as `RECORDER` in `tests/common/mod.rs`); a call
holds what the recorder wrote down (`launches`: the command line, the settings, the MCP config, the schema, the
system prompts, the environment) and what the call gave (the job as the API shows it, the draft, the result).

Times that are relative to now (a ticket done three days ago) are written `<T-72h>` in the rows and are
replaced by the test with its own now; the times of what a call gave are `<TIME>`.

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_assist_docs.py
Writes `assist_docs.json` next to this file. Its temporary folders are removed when it ends.
"""
import asyncio
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path

TMP = tempfile.gettempdir().rstrip("/")
_tmp = tempfile.TemporaryDirectory(prefix="gen-assist-docs-")
work = os.path.realpath(_tmp.name)
os.environ["KANBAN_CONFIG_DIR"] = f"{work}/config"
os.environ["KANBAN_DB_PATH"] = f"{work}/data/kanban.db"
os.environ["KANBAN_LOG_DIR"] = f"{work}/logs"
os.environ["KANBAN_AI_KEY_FILE"] = f"{work}/ai.key"
os.environ["CLAUDE_CONFIG_DIR"] = f"{work}/claude-config"
os.environ["KANBAN_AI_RUNS_DIR"] = f"{work}/ai-runs"
os.environ["KANBAN_UPLOADS_DIR"] = f"{work}/uploads"
os.environ["KANBAN_WORKSPACE_ROOT"] = f"{work}/workspace"
os.environ["KANBAN_AI_ROOTS"] = work
os.environ["KANBAN_AI_ACCOUNTS_HOME"] = f"{work}/accounts"
os.environ["HOME"] = f"{work}/home"
os.environ["PATH"] = f"{work}/bin:/usr/bin:/bin"
# what the board's own environment holds in the Rust test too (`tests/golden_assist.rs`, `BOARD_ENV`): variables a
# child must not inherit, and credentials an account's login must not be outranked by
BOARD_ENV = {
    "CLAUDECODE": "1",
    "CLAUDE_CODE_ENTRYPOINT": "cli",
    "CLAUDE_CODE_SESSION_ID": "board-session",
    "ANTHROPIC_API_KEY": "sk-ant-board-key",
    "CLAUDE_CODE_OAUTH_TOKEN": "board-oauth",
}
os.environ.update(BOARD_ENV)
for name in ("MCP_TOOL_TIMEOUT", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "ANTHROPIC_AUTH_TOKEN", "KANBAN_DATABASE_URL", "KANBAN_URL", "KANBAN_RUN_TOKEN", "KANBAN_RUN_ID", "KANBAN_WORKTREE", "KANBAN_RUNNER", "KANBAN_IN_RUNNER"):
    os.environ.pop(name, None)
sys.path.insert(0, os.getcwd())

# the same bytes as `RECORDER` in crates/kb-assist/tests/common/mod.rs
RECORDER = r"""#!/bin/sh
# Stands in for Claude Code in the golden turns of the assistants: records what it was started with, then answers.
case "$1" in --version) echo "9.9.9 (Claude Code)"; exit 0;; auth) echo '{"loggedIn": true, "authMethod": "oauth_token"}'; exit 0;; esac
out="<OUT>"
n=$(ls "$out" | wc -l | tr -d ' ')
dir="$out/$n"
mkdir -p "$dir"
printf '%s\0' "$0" "$@" > "$dir/args"
env -0 > "$dir/env"
pwd > "$dir/cwd"
sid=""; prev=""
for a in "$@"; do case "$prev" in --session-id|--resume) sid="$a";; esac; prev="$a"; done
if [ -n "$CLAUDE_CONFIG_DIR" ]; then mkdir -p "$CLAUDE_CONFIG_DIR/projects/golden"; : >> "$CLAUDE_CONFIG_DIR/projects/golden/$sid.jsonl"; fi
cat "$GOLDEN_STREAM"
exit 0
"""
RECORDED = f"{work}/recorded"
for folder in ("bin", "home", "uploads", "accounts", "workspace", "tools", "recorded", "streams"):
    os.makedirs(f"{work}/{folder}", exist_ok=True)
for path in (f"{work}/bin/claude", f"{work}/tools/recorder"):
    with open(path, "w") as fh:
        fh.write(RECORDER.replace("<OUT>", RECORDED))
    os.chmod(path, 0o755)

from sqlmodel import select  # noqa: E402

import database  # noqa: E402
from models import (  # noqa: E402
    AiAccount,
    AiAssistSettings,
    AiChat,
    AiChatMessage,
    AiDigest,
    AiInsight,
    AiProjectSettings,
    AiRun,
    AiTeam,
    AiUsage,
    DocsAiSession,
    DocsAiSettings,
    DocsAiHealth,
    DocsAiIgnore,
    DocsAiJob,
    DocsComment,
    DocsCommentEvent,
    DocsCommentThread,
    DocsLink,
    DocsPage,
    DocsVersion,
    IdeaAdvice,
    IdeaAiSettings,
    IdeaAssumption,
    IdeaDigest,
    IdeaTicket,
    Member,
    Project,
    Ticket,
)
from services.ai import runs as ai_runs  # noqa: E402
from services.ai import steps  # noqa: E402
from services.assistant import chat, drafts, engine, errors, health, receipt, sessions, skills  # noqa: E402
from services.assistant import settings as svc_settings  # noqa: E402
from services.assistant.errors import AssistError  # noqa: E402
from services.assistant import docs as adocs, editor, ideas  # noqa: E402
from services.docs_ai import DocsAiError, handoff, health as dhealth, jobs, tidy  # noqa: E402
from services.docs_ai import settings as dsettings  # noqa: E402
from services.docs_text import DocsError  # noqa: E402
import datetime as _dt  # noqa: E402
import events  # noqa: E402

OUT = Path(__file__).with_name("assist_docs.json")
STAMP = "2025-01-01T00:00:00+00:00"
BOARD_URL = "http://127.0.0.1:8123"
ai_runs.set_board_url(BOARD_URL)
blobs: dict = {}
out: dict = {"board_env": BOARD_ENV, "board_url": BOARD_URL, "recorder": RECORDER}

TOKEN_RE = re.compile(r"kbr_chat_[A-Za-z0-9_-]+")
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
TIME_RE = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?\+00:00")
ONESHOT_RE = re.compile(r"oneshot-[0-9a-f]{8}")
RUN_RE = re.compile(r"run_[0-9a-f]{12}")
JOB_RE = re.compile(r"dj_[0-9a-f]{12}")
HEX_RE = re.compile(r"\b[0-9a-f]{32}\b")
DAY_RE = re.compile(r"\d{4}-\d\d-\d\d")
def norm(value):
    """`value` with this run's folders written as <ROOT> and <TMP>."""
    if isinstance(value, str):
        return value.replace(work, "<ROOT>").replace(TMP, "<TMP>")
    if isinstance(value, list):
        return [norm(v) for v in value]
    if isinstance(value, dict):
        return {norm(k): norm(v) for k, v in value.items()}
    return value


def scrub(value):
    """`norm`, and what differs from one run to the next written as a mark: chat tokens, UUIDs, times, the folder of a
    one-shot answer."""
    if isinstance(value, str):
        text = norm(value)
        text = TOKEN_RE.sub("<TOKEN>", text)
        text = UUID_RE.sub("<UUID>", text)
        text = RUN_RE.sub("<RUN>", text)
        text = JOB_RE.sub("<JOB>", text)
        text = HEX_RE.sub("<HEX>", text)
        text = TIME_RE.sub("<TIME>", text)
        text = DAY_RE.sub("<DAY>", text)
        return ONESHOT_RE.sub("oneshot-<ID>", text)
    if isinstance(value, list):
        return [scrub(v) for v in value]
    if isinstance(value, dict):
        return {scrub(k): scrub(v) for k, v in value.items()}
    return value


def T(text):
    """A text: as it is when short, else its hash and length (the text itself goes to `blobs`)."""
    if len(text) <= 200:
        return text
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    blobs[digest] = text
    return {"sha256": digest, "chars": len(text)}


def deep_T(value):
    """`T` on every text inside a value."""
    if isinstance(value, str):
        return T(value)
    if isinstance(value, list):
        return [deep_T(v) for v in value]
    if isinstance(value, dict):
        return {k: deep_T(v) for k, v in value.items()}
    return value


def row_dict(row):
    return norm(json.loads(row.model_dump_json()))

def err(exc):
    return {"error": {"code": exc.code, "message": str(exc)}}


def member(pid, mid, name, kind="human"):
    return Member(id=mid, project_id=pid, name=name, color="#3B82F6", kind=kind, created_at=STAMP)


def team(pid, mid, **more):
    fields = dict(id=mid, project_id=pid, model="haiku", created_at=STAMP, updated_at=STAMP)
    fields.update(more)
    return AiTeam(**fields)


async def add(session, rows, *models):
    for m in models:
        session.add(m)
        rows.setdefault(m.__tablename__, []).append(row_dict(m))



# ---------------------------------------------------------------------------------------------------------------------
# what a turn is started with
# ---------------------------------------------------------------------------------------------------------------------
INIT = {"type": "system", "subtype": "init", "session_id": "golden", "model": "claude-haiku-test"}
TOOL = {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "g1", "name": "mcp__kanban__list_tickets", "input": {"project_id": "p", "status": "todo"}}]}}
TOOL_RESULT = {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "g1", "is_error": False, "content": '[{"id": "KAN-1"}]'}]}}
SAYS = {"type": "assistant", "message": {"content": [{"type": "text", "text": "Looking at the board."}]}}




def result(text=None, structured=None, **more):
    r = {"type": "result", "subtype": "success", "is_error": False, "result": text if structured is None else json.dumps(structured)}
    if structured is not None:
        r["structured_output"] = structured
    r.update({"total_cost_usd": 0.0312, "usage": {"input_tokens": 1200, "output_tokens": 85, "cache_read_input_tokens": 300}, "session_id": "golden"})
    r.update(more)
    return r


def stream(*events):
    return "".join(json.dumps(e) + "\n" for e in events)


STREAM_TEXT = stream(INIT, SAYS, TOOL, TOOL_RESULT, result("Two tickets are open: **KAN-1** and KAN-2."))
STREAM_ERROR = stream(INIT, result("Credit balance is too low. token=ghp_abcdefghijklmnopqrstuvwxyz0123456789", subtype="error_during_execution", is_error=True))
STREAM_NONE = stream(INIT, SAYS)


def stream_json(structured):
    return stream(INIT, TOOL, TOOL_RESULT, result(structured=structured))


class Case:
    """One situation: a project of its own; `calls` are made one after the other."""

    def __init__(self, name, calls, **spec):
        self.name = name
        self.calls = calls
        self.spec = spec
        self.pid = f"p-{name}"
        self.files: list = []
        self.dirs: list = []

    def path(self, rel):
        return f"{work}/cases/{self.name}/{rel}"

    def mkdir(self, path):
        os.makedirs(path, exist_ok=True)
        self.dirs.append(norm(path))
        return path

    def write(self, path, text):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        self.files.append({"path": norm(path), "text": norm(text)})


def read_recordings(start):
    found = []
    n = start
    while os.path.isdir(f"{RECORDED}/{n}"):
        base = f"{RECORDED}/{n}"
        args = open(f"{base}/args", "rb").read().decode("utf-8").split("\0")[:-1]
        env = dict(item.split("=", 1) for item in open(f"{base}/env", "rb").read().decode("utf-8").split("\0") if "=" in item)
        cwd = open(f"{base}/cwd").read().strip()
        found.append((args, env, cwd))
        n += 1
    return found


SHELL_VARS = ("PWD", "OLDPWD", "SHLVL", "_", "GOLDEN_STREAM")


def flag(args, name):
    return args[args.index(name) + 1] if name in args else None


def launch_of(recording):
    args, env, cwd = recording
    board = dict(os.environ)
    read = lambda path: open(path, encoding="utf-8").read() if path and os.path.exists(path) else None  # noqa: E731
    return scrub(
        {
            "args": [T(scrub(a)) for a in args],
            "cwd": cwd,
            "env": {
                "set": {k: v for k, v in sorted(env.items()) if board.get(k) != v and k not in SHELL_VARS},
                "removed": sorted(k for k in board if k not in env and k not in SHELL_VARS),
            },
            "mcp": json.loads(flag(args, "--mcp-config")),
            "settings": json.loads(flag(args, "--settings")),
            "schema": json.loads(flag(args, "--json-schema")) if "--json-schema" in args else None,
            "system": read(flag(args, "--append-system-prompt-file")),
            "sub_system": read(flag(args, "--append-subagent-system-prompt-file")),
            "resumed": "--resume" in args,
        }
    )


RUN_FIELDS = ("kind", "ticket_id", "target", "member_id", "mode", "trigger", "depth", "state", "started_by", "instruction", "session_name", "model", "effort", "account_id", "ended_reason", "tokens_in", "tokens_out", "cost_usd", "report", "summary", "pid", "steps_count")


async def run_of(run_id):
    async with database.async_session() as s:
        run = await s.get(AiRun, run_id)
        rows = await steps.read(s, run_id, limit=200)
        sess = (await s.exec(select(DocsAiSession).where(DocsAiSession.scope == run.target))).first()
    return {
        "run": {k: getattr(run, k) for k in RUN_FIELDS},
        "session_kept": (run.session_id is not None, sess.calls if sess else None, bool(sess and sess.session_id == run.session_id)),
        "steps": [[r["kind"], r["title"], r.get("tool")] for r in rows],
    }


def turn_dict(t):
    return {k: getattr(t, k) for k in ("text", "structured", "state", "error", "tokens_in", "tokens_out", "cost", "metered", "member", "model", "files")}


async def usage_of(pid):
    async with database.async_session() as s:
        rows = (await s.exec(select(AiUsage).where(AiUsage.project_id == pid).order_by(AiUsage.created_at))).all()
    return [{k: getattr(u, k) for k in ("feature", "member_id", "person", "cost", "tokens_in", "tokens_out", "metered")} for u in rows]


async def build(case: Case) -> dict:
    s_ = case.spec
    pid = case.pid
    rows: dict = {}
    repo = case.mkdir(case.path("repo"))
    for path, text in (s_.get("repo_files") or {}).items():
        case.write(f"{repo}/{path}", text)
    async with database.async_session() as s:
        if s_.get("clear_teams"):
            for t in (await s.exec(select(AiTeam))).all():
                await s.delete(t)
            await s.commit()
        await add(s, rows, Project(id=pid, name=s_.get("project_name", "Kanban Board"), prefix=f"A{CASES.index(case):03d}", color="#2E6F40"), member(pid, f"{pid}-an", "An Nguyen"))
        account_id = None
        if s_.get("account"):
            folder = case.mkdir(f"{work}/accounts/{case.name}")
            account_id = f"acct_{case.name}"
            await add(s, rows, AiAccount(id=account_id, name=f"Work {case.name}", cli="claude", folder=folder, status="signed_in", email="an@work.example", plan="max", created_at=STAMP, updated_at=STAMP))
        for i, spec in enumerate(s_.get("teams", [{}])):
            spec = dict(spec)
            mid = f"{pid}-team{i}"
            name = spec.pop("name", f"Team {i}")
            fields = dict(working_dir=repo, cli_path=f"{work}/tools/recorder", account_id=account_id)
            fields.update({k: (v.replace("<ROOT>", work) if isinstance(v, str) else v) for k, v in spec.items()})
            await add(s, rows, member(pid, mid, name, "ai"), team(pid, mid, **fields))
        for extra in s_.get("rows", []):
            await add(s, rows, extra)
        await s.commit()
    for rel, data in (s_.get("uploads") or {}).items():
        case.write(f"{work}/uploads/{rel}", data)
    outs = []
    for i, call in enumerate(case.calls):
        path = f"{work}/streams/{case.name}-{i}.jsonl"
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(call["stream"])
        os.environ["GOLDEN_STREAM"] = path
        start = len(os.listdir(RECORDED))
        given = await do_call(case, {k: v for k, v in call.items() if k != "stream"})
        recs = read_recordings(start)
        outs.append({"launches": [launch_of(r) for r in recs], "gave": deep_T(scrub(json.loads(json.dumps(given))))})
    return {"name": case.name, "project_id": pid, "clear_teams": bool(s_.get("clear_teams")), "rows": rows, "dirs": case.dirs, "files": case.files, "calls": case.calls, "out": outs}


# ---------------------------------------------------------------------------------------------------------------------
# times relative to now, and what a call gave
# ---------------------------------------------------------------------------------------------------------------------
T_MARK: dict = {}


def ago(hours):
    """An ISO time `hours` ago, written `<T-{hours}h>` in the rows (the test puts its own now in)."""
    at = (_dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(hours=hours)).isoformat()
    T_MARK[at] = f"<T-{hours}h>"
    return at


def marked(value):
    if isinstance(value, str):
        return T_MARK.get(value, value)
    if isinstance(value, list):
        return [marked(v) for v in value]
    if isinstance(value, dict):
        return {k: marked(v) for k, v in value.items()}
    return value


def row_dict(row):  # noqa: F811
    return marked(norm(json.loads(row.model_dump_json())))


def fail(exc):
    out = {"type": type(exc).__name__, "message": str(exc)}
    for attr in ("code", "status"):
        if hasattr(exc, attr):
            out[attr] = getattr(exc, attr)
    return {"error": out}


async def settled(job_id, timeout=20.0):
    for _ in range(int(timeout / 0.05)):
        async with database.async_session() as s:
            j = await s.get(DocsAiJob, job_id)
        if j.state not in ("queued", "running"):
            return j
        await asyncio.sleep(0.05)
    raise AssertionError(f"job {job_id} never ended")


async def thread_of(tid):
    from services import docs_comments

    async with database.async_session() as s:
        t = await docs_comments.get_thread(s, tid)
    return t


def model_dict(row, *keys):
    return {k: getattr(row, k) for k in keys}


JOB_KEYS = ("kind", "state", "started_by", "instruction", "page_id", "thread_id", "member_id", "reply_comment_id")
CALLS: dict = {}


def call(fn):
    CALLS[fn.__name__] = fn
    return fn


async def page_row(s, page_id):
    return await s.get(DocsPage, page_id)


async def groups_of(s, spec):
    """`[(page, [thread])]` of `[[page_id, [thread_id]]]`."""
    out = []
    for page_id, thread_ids in spec:
        page = await s.get(DocsPage, page_id)
        threads = [await s.get(DocsCommentThread, t) for t in thread_ids]
        out.append((page, threads))
    return out


# -- Docs AI jobs ------------------------------------------------------------------------------------------------------
@call
async def job(case, c):
    """Start a Docs AI job as a route does and wait for it: the job as the API shows it, and the thread after."""
    async with database.async_session() as s:
        j = await jobs.start(s, project_id=case.pid, started_by=c.get("by", "An Nguyen"), **c["job"])
    done = await settled(j.id)
    out = {"queued": {k: getattr(j, k) for k in JOB_KEYS}, "job": jobs.to_dict(done)}
    if done.thread_id:
        t = await thread_of(done.thread_id)
        out["thread"] = [[x["author"], x["body"], x.get("ai")] for x in t["comments"]]
    return out


@call
async def job_cancel(case, c):
    """A queued job that no task runs: stopping it writes who stopped it; stopping it again changes nothing."""
    async with database.async_session() as s:
        j = await jobs.create(s, project_id=case.pid, started_by="An Nguyen", **c["job"])
        jid = j.id
        first = jobs.to_dict(await jobs.cancel(s, jid, "An Nguyen"))
        second = jobs.to_dict(await jobs.cancel(s, jid, "Ana"))
    return {"first": first, "second": second}


@call
async def job_helpers(case, c):
    async with database.async_session() as s:
        j = await jobs.create(s, project_id=case.pid, kind="check", started_by="An Nguyen", page_id=c.get("page_id"), instruction="x" * 9000, result={"input": {"a": 1}})
        jid = j.id
        await jobs.add_step(jid, "Reading API")
        for i in range(45):
            await jobs.add_step(jid, f"step {i}")
        await jobs.set_reads(jid, [{"page_id": "p1", "title": "API"}])
        await jobs.update(jid, reply_comment_id="c1", result={"k": 1})
        await jobs.finish(jid, state="finished", result={"z": 2}, error=None)
        s.expire_all()
        d = jobs.to_dict(await jobs.get(s, jid))
        listed = [x.kind for x in await jobs.list_jobs(s, case.pid, kind="check", state="finished", limit=500)]
        none = (await jobs.cancel(s, jid, "An Nguyen")).state
        try:
            await jobs.get(s, "dj_nope")
        except DocsAiError as exc:
            missing = fail(exc)
        r2 = await jobs.create(s, project_id=case.pid, kind="ask", started_by="An Nguyen")
        r3 = await jobs.create(s, project_id=case.pid, kind="ask", started_by="An Nguyen")
        ids = (r2.id, r3.id)
        r3.state = "running"
        s.add(r3)
        await s.commit()
        await jobs.recover()
        s.expire_all()
        after = [jobs.to_dict(await jobs.get(s, i)) for i in ids]
    d["instruction"] = len(d["instruction"])
    d["steps"] = [x["text"] for x in d["steps"]]
    return {"job": d, "listed": listed, "cancel_of_finished": none, "missing": missing, "recovered": after}


@call
async def docs_helpers(case, c):
    """What needs no model: ignoring a finding, the ids of findings, markers, the Write dialog, freshness."""
    out = {}
    async with database.async_session() as s:
        for key in ("  ", " k1 ", "k1"):
            try:
                await adocs.ignore(s, c["page_id"], key, "An Nguyen")
                out[f"ignore {key!r}"] = sorted(await adocs.ignored_keys(s, c["page_id"]))
            except DocsAiError as exc:
                out[f"ignore {key!r}"] = fail(exc)
        out["finding_ids"] = [adocs.finding_id(k, q) for k, q in (("unclear", "The API uses REST."), ("style", "Zażółć"), ("", ""))]
        out["markers"] = await adocs.markers_of(s, c["page_id"])
        for i, p in enumerate(c["writes"]):
            try:
                out[f"normalize {i}"] = adocs.normalize_write(p)
                out[f"preview {i}"] = await adocs.write_preview(s, case.pid, p)
            except DocsAiError as exc:
                out[f"normalize {i}"] = fail(exc)
        page = await s.get(DocsPage, c["page_id"])
        out["freshness"] = []
        out["freshness"].append(await adocs.freshness_of(s, page))
        await adocs.freshness_mark(s, page, still_correct=c.get("still", False), dismiss=c.get("dismiss"))
        out["freshness"].append(await adocs.freshness_of(s, page))
        try:
            await adocs.find_finding(s, case.pid, c["page_id"], "nope", None)
        except DocsAiError as exc:
            out["no_finding"] = fail(exc)
        # a job's cost goes on its row: the sum of two turns
        for rating, reason in (("sideways", ""), ("down", "r" * 600)):
            try:
                jobid = c["feedback_job"]
                got = await adocs.feedback(s, jobid, "An Nguyen", rating, reason)
                out[f"feedback {rating}"] = got["result"].get("feedback", {}) | {"reason": len(got["result"]["feedback"]["reason"])}
            except DocsAiError as exc:
                out[f"feedback {rating}"] = fail(exc)
    return out


@call
async def docs_tickets(case, c):
    out = {}
    async with database.async_session() as s:
        made = await adocs.create_tickets(s, c["page_id"], "An Nguyen", c["drafts"], link=c.get("link", True))
        out["made"] = {k: v for k, v in made.items()}
        undone = await adocs.undo_tickets(s, made["undo_token"], "An Nguyen")
        out["undone"] = undone
        try:
            await adocs.undo_tickets(s, made["undo_token"], "An Nguyen")
        except DocsAiError as exc:
            out["again"] = fail(exc)
        try:
            await adocs.create_tickets(s, c["page_id"], "An Nguyen", [{"title": "x", "project_id": "nope"}])
        except DocsAiError as exc:
            out["bad_project"] = fail(exc)
    return out


@call
async def docs_chat(case, c):
    async with database.async_session() as s:
        chat_id = await adocs.open_as_chat(s, c["job_id"], "An Nguyen")
        from models import AiChat, AiChatMessage

        ch = await s.get(AiChat, chat_id)
        msgs = (await s.exec(select(AiChatMessage).where(AiChatMessage.chat_id == chat_id).order_by(AiChatMessage.role.desc()))).all()
    return {"chat": model_dict(ch, "project_id", "owner", "title", "scope", "scope_id", "doc_id"), "messages": [model_dict(m, "role", "text", "state") for m in msgs]}


@call
async def docs_threads(case, c):
    """What the comments list shows of the assistant, and who a mention is delivered to."""
    out = {}
    async with database.async_session() as s:
        page = await s.get(DocsPage, c["page_id"])
        t1 = await thread_of(c["thread_id"])
        threads = [dict(t1)]
        out["on"] = await adocs.annotate(s, page, threads)
        out["annotated"] = [[x["ai_jobs"], x["ai_summary"]] for x in threads]
        members = await __import__("services.docs_access", fromlist=["members_of"]).members_of(s, case.pid)
        out["member_rows"] = await adocs.member_rows(s, case.pid, members, True) + await adocs.member_rows(s, case.pid, members[:1], False)
        for intent in c.get("intents", ["ask"]):
            got = await adocs.deliver(s, thread=t1, by="An Nguyen", intent=intent)
            out[f"deliver {intent}"] = got
            for item in got:
                if item.get("job_id"):
                    await settled(item["job_id"])
    return out


# -- tidy, health, handoff, settings ------------------------------------------------------------------------------------
@call
async def tidy_call(case, c):
    async with database.async_session() as s:
        try:
            return await tidy.tidy(s, case.pid, c["markdown"], c["options"], filename=c.get("filename", "import.md"), accept_see_links=c.get("accept"))
        except DocsAiError as exc:
            return fail(exc)


@call
async def health_call(case, c):
    out = {}
    async with database.async_session() as s:
        for step in c["steps"]:
            what = step[0]
            try:
                if what == "get":
                    out[json.dumps(step)] = await dhealth.get(s, case.pid)
                elif what == "run":
                    out[json.dumps(step)] = await dhealth.run(s, case.pid, "An Nguyen", freshness_day=step[1] if len(step) > 1 else None)
                elif what == "dismiss":
                    out[json.dumps(step)] = await dhealth.dismiss(s, case.pid, step[1], step[2], step[3], "An Nguyen")
                elif what == "count":
                    out[json.dumps(step)] = await dhealth.count(s, case.pid)
                elif what == "words":
                    out[json.dumps(step)] = [dhealth._words(step[1]), sorted(dhealth._shingles(dhealth._words(step[1]), step[2]))]
            except DocsAiError as exc:
                out[json.dumps(step)] = fail(exc)
    return out


@call
async def handoff_call(case, c):
    out = {}
    async with database.async_session() as s:
        for step in c["steps"]:
            what = step[0]
            key = json.dumps(step)
            try:
                if what == "targets":
                    out[key] = await handoff.targets(s, step[1])
                elif what == "note":
                    groups = await groups_of(s, step[1])
                    ticket = await s.get(Ticket, step[3]) if len(step) > 3 and step[3] else None
                    out[key] = await handoff.build_note(s, groups, step[2], ticket)
                elif what == "send":
                    out[key] = await handoff.send(s, **step[1])
                elif what == "of_ticket":
                    got = await handoff.threads_of_ticket(s, step[1])
                    out[key] = [[p.id, [t.id for t in ts]] for p, ts in got]
                    out[key + " count"] = await handoff.open_count_for_ticket(s, step[1])
                elif what == "builder":
                    out[key] = await handoff.builder_team_of(s, await s.get(DocsPage, step[1]))
            except (DocsAiError, DocsError, AssistError) as exc:
                out[key] = fail(exc)
    return out


def srow(row):
    """A row of the database as a dict with its keys in order (a loaded row keeps the order of its columns)."""
    return dict(sorted(row_dict(row).items()))


@call
async def settings_call(case, c):
    out = {}
    async with database.async_session() as s:
        for step in c["steps"]:
            what = step[0]
            key = json.dumps(step)
            try:
                if what == "get":
                    out[key] = srow(await dsettings.get(s, case.pid))
                elif what == "describe":
                    out[key] = await dsettings.describe(s, case.pid)
                elif what == "update":
                    out[key] = srow(await dsettings.update(s, case.pid, step[1], "An Nguyen"))
                elif what == "candidates":
                    out[key] = await dsettings.candidates(s, case.pid)
                elif what == "member":
                    m, p = await dsettings.answering_member(s, case.pid)
                    out[key] = [m.id, m.name, p.provider]
                elif what == "enabled":
                    out[key] = srow(await dsettings.require_enabled(s, step[1] if len(step) > 1 else case.pid))
                elif what == "count":
                    out[key] = await dsettings.count_pages(s, case.pid)
                elif what == "can_answer":
                    out[key] = dsettings.can_answer(await s.get(AiTeam, step[1]) if step[1] else None)
                elif what == "ready":
                    await adocs.ready_or_raise(case.pid)
                    out[key] = True
            except DocsAiError as exc:
                out[key] = fail(exc)
    return out


# -- editor and ideas ---------------------------------------------------------------------------------------------------
def draft_view(d):
    """The draft as it is now (a copy: the draft itself goes on changing)."""
    return json.loads(json.dumps({k: d[k] for k in ("kind", "owner", "status", "member_name", "ticket_id", "doc_id", "raw", "result", "payload", "cost", "tokens", "applied_by")}, default=str))


@call
async def editor_call(case, c):
    out = {}
    async with database.async_session() as s:
        for step in c["steps"]:
            what = step[0]
            key = json.dumps(step)
            try:
                if what == "state":
                    out[key] = await editor.state(s, case.pid, step[1])
                elif what == "preview":
                    out[key] = editor.preview(step[1])
                elif what == "items":
                    out[key] = editor._items(step[1])
            except AssistError as exc:
                out[key] = fail(exc)
    return out


@call
async def editor_draft(case, c):
    """Start a draft, wait for it, then accept / try again as the steps say."""
    out = {}
    async with database.async_session() as s:
        try:
            d = await editor.start(s, case.pid, c["body"], c.get("by", "An Nguyen"))
        except AssistError as exc:
            return fail(exc)
    out["started"] = {k: d[k] for k in ("kind", "status", "owner", "ticket_id", "doc_id", "member_name")}
    for _ in range(400):
        cur = drafts.get(d["id"])
        if cur["status"] != "pending":
            break
        await asyncio.sleep(0.05)
    out["written"] = draft_view(drafts.get(d["id"]))
    for step in c.get("then", []):
        key = json.dumps(step)
        try:
            if step[0] == "accept":
                got = await editor.accept(d["id"], step[1], step[2] if len(step) > 2 else None)
                out[key] = {"status": got["draft"]["status"], "created": got.get("created")}
            elif step[0] == "again":
                got = await editor.again(d["id"], step[1], go_on=step[2])
                out[key] = got["status"]
                for _ in range(400):
                    if drafts.get(d["id"])["status"] != "pending":
                        break
                    await asyncio.sleep(0.05)
                out[key + " written"] = draft_view(drafts.get(d["id"]))
        except AssistError as exc:
            out[key] = fail(exc)
    return out


@call
async def ideas_call(case, c):
    out = {}
    for step in c["steps"]:
        what = step[0]
        key = json.dumps(step)
        async with database.async_session() as s:
            try:
                if what == "status":
                    out[key] = await ideas.status(s, step[1])
                elif what == "update":
                    out[key] = ideas.settings_out(await ideas.update_settings(s, step[1], **step[2]))
                elif what == "advise":
                    a = await ideas.advise(s, step[1], person="An Nguyen")
                    out[key] = None if a is None else model_dict(a, "idea_id", "action", "reason", "confidence", "target_id", "archive_reason", "park_days", "idea_stamp", "cost", "state")
                elif what == "advice_for":
                    out[key] = await ideas.advice_for(s, step[1], include_none=step[2] if len(step) > 2 else False)
                elif what == "advice_state":
                    a = await ideas.set_advice_state(s, step[1], step[2])
                    out[key] = a.state
                elif what == "ask":
                    out[key] = await ideas.ask(s, step[1], project_id=step[2], scope=step[3], person="An Nguyen")
                elif what == "shape":
                    out[key] = await ideas.shape(s, step[1], step[2], question=step[3], person="An Nguyen")
                elif what == "prepare":
                    out[key] = await ideas.prepare_ticket(s, step[1], person="An Nguyen")
                elif what == "groom":
                    out[key] = ideas.digest_out(await ideas.groom(s, step[1], person="An Nguyen"))
                elif what == "latest":
                    d = await ideas.latest_digest(s, step[1])
                    out[key] = None if d is None else ideas.digest_out(d)
                elif what == "brief":
                    idea = await s.get(IdeaTicket, step[1])
                    out[key] = [ideas.brief(idea), ideas.brief(idea, full=True)]
            except AssistError as exc:
                out[key] = fail(exc)
            except ValueError as exc:
                out[key] = fail(exc)
        if step[0] == "advise" and len(step) > 2:
            pass
    return out


@call
async def pure(case, c):
    return {
        "actions": [[k, list(v)] for k, v in editor.ACTIONS.items()],
        "surfaces": {k: v for k, v in editor.SURFACES.items()},
        "extra": editor.EXTRA,
        "limits": [editor.MAX_SELECTION, editor.MAX_AROUND, editor.MAX_PROMPT, adocs.MAX_QUESTION, list(adocs.SCOPES), list(ideas.SHAPE_KINDS), list(ideas.SETTING_KEYS), list(ideas.OPEN_STAGES_OFF)],
        "handoff": [handoff.TRIGGER, handoff.MAX_THREADS, handoff.COMMENTS_PER_THREAD, handoff.COMMENT_CHARS, handoff.QUOTE_CHARS, handoff.OTHERS_LIMIT, handoff.MAX_NOTE_CHARS, list(handoff.DESTINATIONS), handoff.BADGES, handoff.INSTRUCTION],
        "health": [list(dhealth.KINDS), dhealth.MISSING_DAYS, dhealth.MAX_PAIR_PAGES, dhealth.TITLE_SIMILARITY, dhealth.TEXT_SIMILARITY, dhealth.MIN_WORDS],
        "errors": __import__("services.docs_ai.errors", fromlist=["STATUS"]).STATUS,
        "tidy": [tidy.MAX_MARKDOWN],
        "docs_ai_status": [[k, DocsAiError(k, "m").status] for k in ("not_found", "invalid", "paused", "rate_limited", "other")],
    }


async def do_call(case: Case, c: dict) -> dict:
    if isinstance(c.get("markdown"), dict):
        c = {**c, "markdown": c["markdown"]["repeat"][0] * c["markdown"]["repeat"][1]}
    return json.loads(json.dumps(await CALLS[c["kind"]](case, c), default=str))


# ---------------------------------------------------------------------------------------------------------------------
# the cases
# ---------------------------------------------------------------------------------------------------------------------
API_MD = "# API\n\n## Overview\n\nThe API uses REST.\n\n- [ ] Add paging\n- [x] Document errors\n\nSee the Guide for KAN-1 and [[Guide]].\n\n[Needs input: which version?] and [Needs input]\n"
GUIDE_MD = "# Guide\n\n## Start\n\nInstall it. Then read the API page.\n\n```\ncode block\n```\n"


def pg(pid, n, title, md, last_author=None, **more):
    """A published page (and, with `last_author`, a second version by that author)."""
    page_id = f"{pid}-pg{n}"
    versions = [DocsVersion(id=f"{pid}-v{n}", page_id=page_id, version=1, title=title, markdown=md, author="An Nguyen", created_at=STAMP)]
    if last_author:
        versions.append(DocsVersion(id=f"{pid}-v{n}b", page_id=page_id, version=2, title=title, markdown=md, author=last_author, created_at="2025-01-02T00:00:00+00:00"))
    return [
        DocsPage(id=page_id, project_id=pid, title=title, slug=title.lower().replace(" ", "-"), version=len(versions), status="published", created_by="An Nguyen", updated_by="An Nguyen", created_at=STAMP, updated_at=STAMP, **more),
        *versions,
    ]


def th(pid, n, page_n, quote="The API uses REST.", section="overview", kind="inline", status="open", by="An Nguyen"):
    return DocsCommentThread(id=f"{pid}-th{n}", page_id=f"{pid}-pg{page_n}", kind=kind, status=status, anchor_quote=quote, anchor_section=section, created_by=by, created_at=STAMP)


def cm(pid, n, thread_n, author, body, ai=None, mentions="[]", at=STAMP):
    return DocsComment(id=f"{pid}-c{n}", thread_id=f"{pid}-th{thread_n}", author=author, body=body, mentions=mentions, ai=ai, created_at=at)


def world(pid, with_threads=True, team_id=None):
    rows = [
        DocsAiSettings(project_id=pid, enabled=True, member_id=team_id, updated_at=STAMP),
        *pg(pid, 1, "API", API_MD),
        *pg(pid, 2, "Guide", GUIDE_MD),
        DocsAiJob(id=f"{pid}-jobA", project_id=pid, kind="ask", state="finished", started_by="An Nguyen", instruction="Which API style?", result=json.dumps({"question": "Which API style?", "answer": "REST [1].", "verdict": "answered"}), queued_at=STAMP, ended_at=STAMP),
        DocsAiJob(id=f"{pid}-jobF", project_id=pid, page_id=f"{pid}-pg1", kind="freshness", state="finished", started_by="An Nguyen", result=json.dumps({"state": "stale", "reasons": [{"key": "k1", "quote": "REST", "source": "KAN-1", "text": "changed"}, {"key": "k2", "text": "x"}]}), queued_at=STAMP, ended_at=STAMP),
    ]
    if with_threads:
        rows += [
            th(pid, 1, 1),
            cm(pid, 1, 1, "An Nguyen", "Which version? @[Team 0](member:" + f"{pid}-team0)", mentions=json.dumps([f"{pid}-team0"])),
            cm(pid, 2, 1, "Team 0", "Version 2.", ai=json.dumps({"job_id": "j", "member": "Docs AI"})),
            cm(pid, 3, 1, "An Nguyen", "Sent to KAN-1", ai=json.dumps({"kind": "sent"})),
            th(pid, 2, 1, quote=None, section=None, kind="page"),
            cm(pid, 4, 2, "An Nguyen", "Please add a section about KAN-1 and kan-2.\nSecond line."),
            th(pid, 3, 2, quote="Install it.", section="start", status="resolved"),
            cm(pid, 5, 3, "An Nguyen", "Done."),
            cm(pid, 6, 1, "An Nguyen", f"@[Team 0](member:{pid}-team0) once more?", mentions=json.dumps([f"{pid}-team0"]), at="2025-01-03T00:00:00+00:00"),
        ]
    return rows


def st(structured):
    return stream_json(structured)


def J(kind, pid_n="1", stream=None, by="An Nguyen", **fields):
    """A `job` call: `page_id` and `thread_id` are written `{pid}-pg1`, resolved by the case."""
    return dict(kind="job", by=by, job=dict(kind=kind, **fields), stream=stream if stream is not None else STREAM_TEXT)


def with_pid(case_name, value):
    """`<P>` in a value is the project of the case, `<N>` its name."""
    pid = f"p-{case_name}"
    if isinstance(value, str):
        return value.replace("<P>", pid).replace("<N>", case_name)
    if isinstance(value, list):
        return [with_pid(case_name, v) for v in value]
    if isinstance(value, dict):
        return {k: with_pid(case_name, v) for k, v in value.items()}
    return value


class Cases(list):
    def add(self, name, calls, **spec):
        calls = with_pid(name, calls)
        flat = []
        for r in spec.get("rows", []):
            v = r(name) if callable(r) else r
            flat.extend(v if isinstance(v, list) else [v])
        spec["rows"] = flat
        spec.setdefault("project_name", f"P {name}")
        self.append(Case(name, calls, **spec))


CASES = Cases()
PG1, PG2, TH1, TH2 = "<P>-pg1", "<P>-pg2", "<P>-th1", "<P>-th2"
TEAM0 = "<P>-team0"


def rows_of(fn, *a, **k):
    return lambda name: fn(f"p-{name}", *a, **k)


def docs_rows(name):
    return world(f"p-{name}", team_id=f"p-{name}-team0")


CASES.add(
    "jobs_page",
    [
        J("summary", page_id=PG1, instruction="Summarise", result={"input": {"markdown": "The API uses REST."}}, stream=st({"text": "REST API.", "title": "API"})),
        J("summary", page_id=PG1, instruction="Summarise", stream=STREAM_TEXT),
        J("explain", page_id=PG1, instruction="Explain", result={"input": {"selection": "REST", "section": "overview"}}, stream=st({"text": "REST is a style."})),
        J("translate", page_id=PG1, instruction="Translate", result={"input": {"language": "Vietnamese", "section": None}}, stream=st({"markdown": "# API\n\nAPI dùng REST.", "language": "Vietnamese"})),
        J("check", page_id=PG1, instruction="Check", result={"input": {"markdown": None}}, stream=st({"findings": [{"kind": "unclear", "quote": "The API uses REST.", "message": "Say which version.", "suggestion": "REST v2."}, {"quote": "Add paging", "message": "Full sentence."}, {"kind": "style"}, "junk", {"kind": "x", "quote": "q" * 500, "message": "m" * 700}]})),
        J("check_fix", page_id=PG1, instruction="Fix", result={"input": {"finding": {"quote": "REST"}, "markdown": "x"}}, stream=st({"old": "The API uses REST.", "new": "The API uses REST v2."})),
        J("check_fix", page_id=PG1, instruction="Fix", stream=st({"old": "x"})),
        J("diagram", page_id=PG1, instruction="Draw", result={"input": {"selection": "flow", "request": "a flow", "diagram_id": None, "label": "Flow", "markdown": None}}, stream=st({"diagram_id": "dg1", "label": "Flow"})),
        J("diagram", page_id=PG1, instruction="Draw", stream=st({"changed": False})),
        J("freshness", page_id=PG1, instruction="Fresh?", stream=st({"state": "stale", "reasons": [{"quote": "REST", "source": "KAN-1", "why": "changed"}, "x", {"why": "no quote"}, {}]})),
        J("freshness", page_id=PG1, instruction="Fresh?", stream=st({"state": "ok", "reasons": []})),
        J("history_summary", page_id=PG1, instruction="History", result={"input": {"from": 1, "to": 2}}, stream=st({"summary": "Added paging."})),
        J("publish_note", page_id=PG1, instruction="Note", result={"input": {"markdown": "x"}}, stream=st({"note": "  " + "n" * 300 + "  "})),
        J("since_viewed", instruction="Since", stream=st({"lines": [{"page": "API", "line": "changed"}]})),
        J("tickets_draft", page_id=PG1, instruction="Draft tickets", result={"input": {"selection": None}}, stream=st({"drafts": [{"title": "Add paging", "text": "x", "type": "story", "line": 7}, {"text": "no title"}, {"title": "t" * 300}, "junk"], "skipped": ["a"]})),
    ],
    rows=[docs_rows],
    teams=[{"name": "Team 0"}],
)
CASES.add(
    "jobs_ask",
    [
        J("ask", instruction="Which API style?", result={"question": "Which API style?", "scope": "space", "page_id": None}, stream=st({"answer": "REST [1].", "verdict": "answered", "citations": [{"page_id": PG1, "title": "API"}, {"page_id": PG1}, "junk", {"page_id": PG2, "title": "Guide", "section": "start"}], "pages_read": 2})),
        J("ask", page_id=PG1, instruction="Here?", result={"question": "Here?", "scope": "page", "page_id": PG1}, stream=st({"answer": "Yes.", "verdict": "moon", "pages_read": "3"})),
        J("ask", instruction="Nothing?", result={"question": "", "scope": "", "page_id": None}, stream=st({"verdict": "not_covered"})),
        J("write", instruction="Write a notes from ticket", result={"params": {"source": {"kind": "ticket", "ticket_id": "KAN-1", "idea_id": None, "text": None}, "page_kind": "notes", "include": {"comments": True, "linked_pages": True, "code_changes": False}, "title": None, "parent_id": None}}, stream=st({"page_id": "pg-new", "title": "Notes", "gaps": ["owner"]})),
        J("write", instruction="Write", stream=st({"title": "no page"})),
        J("nope", instruction="Unknown"),
        J("summary", page_id=PG1, instruction="Summarise", stream=STREAM_ERROR),
        J("summary", page_id=PG1, instruction="Summarise", stream=STREAM_NONE),
    ],
    rows=[docs_rows],
    teams=[{"name": "Team 0"}],
)
CASES.add(
    "jobs_threads",
    [
        J("thread_summary", page_id=PG1, thread_id=TH1, instruction="Summarise", stream=st({"summary": "Version 2."})),
        J("thread_summary", page_id=PG1, thread_id=TH1, instruction="Summarise", stream=st({"reply": "via reply"})),
        J("thread_reply", page_id=PG1, thread_id=TH1, instruction="@Team 0", member_id="<P>-team0", result={"input": {"depth": 2}}, stream=st({"reply": "  It is REST.  ", "posted": False})),
        J("thread_reply", page_id=PG1, thread_id=TH1, instruction="@Team 0", stream=st({"reply": "Already there.", "posted": True})),
        J("thread_reply", page_id=PG1, thread_id=TH2, instruction="empty", stream=st({"reply": ""})),
        J("docs_route", page_id=PG1, instruction="Route", result={"input": {"note": "<untrusted>x</untrusted>", "thread_ids": ["<P>-th1", "<P>-th2", "<P>-gone"], "tickets": [{"id": "KAN-1"}], "teams": [{"id": "t", "name": "Team 0"}]}}, stream=st({"decision": "Sent", "ticket_id": "KAN-1", "reason": " It knows why. "})),
        J("docs_route", page_id=PG1, instruction="Route", result={"input": {"thread_ids": ["<P>-th2"]}}, stream=st({"decision": "answered", "ticket_id": "None"})),
        J("docs_route", page_id=PG1, instruction="Route", result={"input": {"thread_ids": ["<P>-th2"]}}, stream=st({"decision": "?", "ticket_id": "-"})),
    ],
    rows=[docs_rows],
    teams=[{"name": "Team 0"}],
)
CASES.add("jobs_error_states", [dict(kind="job_cancel", job=dict(kind="summary", page_id="<P>-pg1", instruction="Stop me"), stream=STREAM_TEXT), dict(kind="job_helpers", page_id="<P>-pg1", stream=STREAM_TEXT)], rows=[docs_rows], teams=[{"name": "Team 0"}])
CASES.add(
    "docs_plain",
    [
        dict(kind="docs_helpers", page_id=PG1, feedback_job="<P>-jobA", writes=[{"source": {"kind": "ticket", "ticket_id": "KAN-1"}}, {"source": {"kind": "notes", "text": "  "}}, {"source": {"kind": "prompt", "text": " about x "}, "title": " T ", "page_kind": "spec"}, {"source": {"kind": "idea"}}, {"source": {"kind": "moon"}}, {"source": {"kind": "ticket"}}, {}, {"source": {"kind": "ticket", "ticket_id": "K"}, "include": {"comments": False, "linked_pages": True}}, {"source": {"kind": "idea", "idea_id": "IDEA-1"}, "include": {"comments": True}}], still=True, dismiss="k", stream=STREAM_TEXT),
        dict(kind="docs_tickets", page_id=PG1, drafts=[{"title": " Add paging ", "text": "x", "type": "bug", "column": "todo"}, {"title": "  "}, {"title": "Second"}], stream=STREAM_TEXT),
        dict(kind="docs_tickets", page_id=PG1, drafts=[{"title": "Unlinked"}], link=False, stream=STREAM_TEXT),
        dict(kind="docs_threads", page_id=PG1, thread_id=TH1, intents=["ask", "notify"], stream=STREAM_TEXT),
        dict(kind="docs_threads", page_id=PG1, thread_id=TH2, stream=STREAM_TEXT),
        dict(kind="docs_chat", job_id="<P>-jobA", stream=STREAM_TEXT),
    ],
    rows=[docs_rows],
    teams=[{"name": "Team 0"}, {"name": "Other", "paused": True}],
)


@call
async def tidy_all(case, c):
    """A tidy, then the same with every "see X" it found accepted."""
    async with database.async_session() as s:
        text = c["markdown"]
        first = await tidy.tidy(s, case.pid, text, c["options"], filename=c.get("filename", "import.md"))
        ids = [x["id"] for x in first["see_links"]]
        second = await tidy.tidy(s, case.pid, text, c["options"], filename=c.get("filename", "import.md"), accept_see_links=ids[::2])
    return {"first": first, "second": second}


@call
async def handoff_send(case, c):
    """`send` to the page's assistant or the Board AI, with the jobs it started finished."""
    async with database.async_session() as s:
        try:
            got = await handoff.send(s, **c["send"])
        except (DocsAiError, DocsError, AssistError) as exc:
            return fail(exc)
    out = {"sent": got}
    done = []
    for jid in [*(got.get("job_ids") or []), *([got["job_id"]] if got.get("job_id") else [])]:
        j = await settled(jid)
        done.append(jobs.to_dict(j))
    out["jobs"] = sorted(done, key=lambda j: j["thread_id"] or "")
    out["threads"] = {}
    for tid in c.get("threads", []):
        t = await thread_of(tid)
        out["threads"][tid] = [[x["author"], x["body"], x.get("ai")] for x in t["comments"]]
    return out


def tickets_rows(pfx):
    def rows(name):
        pid = f"p-{name}"
        return [
            Ticket(id=f"{pfx}-1", project_id=pid, title="Write the page API", status="done", assignee=f"{pid}-team0", created_at=STAMP, updated_at=ago(80), activity_log=json.dumps([{"field": "status", "from": "todo", "to": "done", "at": ago(80)}])),
            Ticket(id=f"{pfx}-2", project_id=pid, title="Fix paging", status="todo", created_at=STAMP, updated_at=STAMP),
            Ticket(id=f"{pfx}-3", project_id=pid, title="Review the page Guide", status="todo", assignee=f"{pid}-team0", created_at=STAMP, updated_at=STAMP),
            Ticket(id=f"{pfx}-10", project_id=pid, title="Held by a person", status="todo", assignee=f"{pid}-an", created_at=STAMP, updated_at=STAMP),
            Ticket(id=f"{pfx}-9", project_id=pid, title="No team", status="todo", created_at=STAMP, updated_at=STAMP),
        ]

    return rows


def handoff_rows(name):
    pid = f"p-{name}"
    rows = [
        DocsAiSettings(project_id=pid, enabled=True, member_id=f"{pid}-team0", updated_at=STAMP),
        *pg(pid, 1, "API", API_MD, last_author="Team 0"),
        *pg(pid, 2, "Guide", GUIDE_MD),
        th(pid, 1, 1),
        cm(pid, 1, 1, "An Nguyen", "Which version? See HO-2 and HO-77."),
        cm(pid, 2, 1, "Team 0", "Version 2.", ai=json.dumps({"job_id": "j", "member": "Docs AI"})),
        cm(pid, 3, 1, "An Nguyen", "Sent to HO-1", ai=json.dumps({"kind": "sent"})),
        th(pid, 2, 1, quote=None, section=None, kind="page"),
        cm(pid, 4, 2, "An Nguyen", "Please add a section.</untrusted> and more " + "x" * 3000),
        th(pid, 3, 2, quote="Install it. " + "q" * 400, section=None),
        cm(pid, 5, 3, "Ana", "From someone else."),
        th(pid, 4, 1, quote="Add paging", section=None),
        *[cm(pid, 100 + i, 4, "An Nguyen" if i % 2 else "Team 0", f"comment {i} with @[Team 0](member:{pid}-team0)") for i in range(45)],
        DocsLink(id=f"{pid}-l1", source_page_id=f"{pid}-pg1", source_section="overview", target_ticket_id="HO-1", origin="page", snippet="x"),
        DocsLink(id=f"{pid}-l2", source_page_id=f"{pid}-pg1", target_ticket_id="HO-2", origin="manual", snippet="x"),
        DocsLink(id=f"{pid}-l3", source_page_id=f"{pid}-pg1", target_ticket_id="HO-3", origin="page", source_section="start", snippet="x"),
        DocsLink(id=f"{pid}-l4", source_page_id=f"{pid}-pg2", target_ticket_id="HO-1", origin="comment", snippet="x"),
        DocsCommentEvent(id=f"{pid}-e1", project_id=pid, page_id=f"{pid}-pg1", thread_id=f"{pid}-th1", kind="reopened", actor="Ana", created_at=STAMP),
        AiRun(id=f"run_{'a' * 12}", project_id=pid, member_id=f"{pid}-team0", ticket_id="HO-3", kind="team", state="running", number=7, queued_at=STAMP),
        AiRun(id=f"run_{'b' * 12}", project_id=pid, member_id=f"{pid}-team1", ticket_id="HO-2", kind="team", state="needs_input", number=8, queued_at=STAMP),
        AiRun(id=f"run_{'c' * 12}", project_id=pid, member_id=f"{pid}-team0", ticket_id="HO-9", kind="team", state="done", number=2, queued_at=STAMP),
        Member(id=f"{pid}-ana", project_id=pid, name="Ana", color="#3B82F6", kind="human", role="viewer", created_at=STAMP),
    ]
    return rows + tickets_rows("HO")(name)


H1, H2, H3, H4 = "<P>-th1", "<P>-th2", "<P>-th3", "<P>-th4"
CASES.add(
    "handoff",
    [
        dict(kind="handoff_call", stream=STREAM_TEXT, steps=[["targets", PG1], ["targets", PG2], ["targets", "<P>-gone"], ["builder", PG1], ["builder", PG2], ["of_ticket", "HO-1"], ["of_ticket", "HO-9"], ["of_ticket", "HO-404"],
              ["note", [[PG1, [H1, H2]]], "An Nguyen", None], ["note", [[PG1, [H1, H2, H4]], [PG2, [H3]]], "Ana", "HO-3"], ["note", [], "x", None],
              ["send", {"to": "moon"}], ["send", {"page_id": PG1, "thread_ids": []}], ["send", {"page_id": PG1, "thread_ids": ["<P>-t%d" % i for i in range(21)]}], ["send", {"page_id": PG1, "thread_ids": [H3]}],
              ["send", {"page_id": PG1, "thread_ids": [H1, H1], "to": "team", "ticket_id": "HO-404"}], ["send", {"page_id": PG1, "thread_ids": [H1], "to": "team", "ticket_id": "HO-10", "give_team_id": "<P>-team0"}],
              ["send", {"page_id": PG1, "thread_ids": [H1], "to": "team", "ticket_id": "HO-2"}], ["send", {"from_ticket": "HO-404"}], ["send", {"from_ticket": "HO-9"}], ["send", {"page_id": "<P>-gone", "thread_ids": [H1]}]]),
        dict(kind="handoff_send", stream=st({"reply": "On it.", "posted": True}), send=dict(page_id=PG1, thread_ids=[H1], to="page_assistant"), threads=[H1]),
        dict(kind="handoff_send", stream=st({"decision": "answered", "reason": "Simple."}), send=dict(page_id=PG1, thread_ids=[H2], to="board_ai"), threads=[H2]),
    ],
    rows=[handoff_rows],
    teams=[{"name": "Team 0"}, {"name": "Team 1"}],
)
CASES.add("handoff_off", [dict(kind="handoff_send", stream=STREAM_TEXT, send=dict(page_id=PG1, thread_ids=[H1], to="board_ai"), threads=[])], rows=[lambda name: [DocsAiSettings(project_id=f"p-{name}", enabled=False, updated_at=STAMP), *pg(f"p-{name}", 1, "API", API_MD), th(f"p-{name}", 1, 1)]], teams=[{"name": "Team 0"}])

CASES.add(
    "settings_none",
    [dict(kind="settings_call", stream=STREAM_TEXT, steps=[["get"], ["describe"], ["candidates"], ["member"], ["enabled"], ["enabled", "<P>-gone"], ["count"], ["describe"]])],
    teams=[],
)
CASES.add(
    "settings",
    [dict(kind="settings_call", stream=STREAM_TEXT, steps=[["describe"], ["candidates"], ["member"], ["can_answer", "<P>-team0"], ["can_answer", "<P>-team1"], ["can_answer", "<P>-team2"], ["can_answer", "<P>-team3"], ["can_answer", None],
          ["update", {"enabled": False}], ["describe"], ["enabled"], ["update", {"enabled": True, "member_id": "<P>-team2"}], ["describe"], ["candidates"], ["update", {"member_id": "<P>-team1"}], ["describe"], ["candidates"], ["member"],
          ["update", {"member_id": "<P>-team3"}], ["update", {"member_id": "<P>-nobody"}], ["update", {"member_id": "p-other-team"}], ["update", {"member_id": ""}], ["describe"],
          ["update", {"style_page_id": "<P>-pg1", "freshness_on": False, "digest_on": 0}], ["update", {"style_page_id": "<P>-pg9"}], ["update", {"style_page_id": "p-other-page"}], ["update", {"style_page_id": None, "freshness_on": None}], ["describe"], ["count"], ["ready"]])],
    rows=[lambda name: [*pg(f"p-{name}", 1, "API", API_MD), *pg(f"p-{name}", 3, "Gone", "x", deleted_at=STAMP)]],
    teams=[{"name": "Team 0"}, {"name": "Paused", "paused": True}, {"name": "Api", "connection": "api_key", "provider": "anthropic"}, {"name": "Other CLI", "provider": "codex"}],
)


def tidy_rows(name):
    pid = f"p-{name}"
    return [DocsAiSettings(project_id=pid, enabled=True, updated_at=STAMP), *pg(pid, 1, "Architecture", "x"), *pg(pid, 2, "Getting Started", "x"), *pg(pid, 3, "gone", "x", deleted_at=STAMP), *tickets_rows("TD")(name)[:2]]


TIDY_A = "# Handbook\n\nIntro text.\n\n## Architecture\n\nSee Architecture for details. Also see the Getting Started guide, and see “Getting Started”.\nTickets TD-1, TD-1 and TD-77; `TD-9` in code.\n\n```\nsee Architecture\nTD-5\n```\n\n### Deep\n\nsee [[Architecture]] and see getting started.\n\n## Other\n\nsee Nothing here. See architecture in page.\n"
TIDY_B = "Just a line, see Architecture\nand TD-2.\n"
TIDY_C = "# One\n\ntext\n\n## A\n\nbody a\n\n## B\n\nbody b\n"
TIDY_D = "Preamble before.\n\n# First\n\nsee Other thing\n\n# Second\n\nsee  Architecture ,\n\n# First\n\ndup\n"
TIDY_E = "### Deep start\n\nsee Architecture.\n\n#### Deeper\n\n###### Six\n"
TIDY_F = "# Top\n## Sub\n### Sub2\r\nwindows\rold mac\n"
CASES.add(
    "tidy",
    [
        dict(kind="tidy_all", stream=STREAM_TEXT, markdown=TIDY_A, options={"split_by_heading": True, "ticket_chips": True, "see_links": True, "heading_levels": True}, filename="hand-book_v2.md"),
        dict(kind="tidy_all", stream=STREAM_TEXT, markdown=TIDY_A, options={"split_by_heading": False, "ticket_chips": True, "see_links": True, "heading_levels": False}, filename="dir/Notes.MARKDOWN"),
        dict(kind="tidy_all", stream=STREAM_TEXT, markdown=TIDY_B, options={"see_links": True, "ticket_chips": True}, filename=""),
        dict(kind="tidy_all", stream=STREAM_TEXT, markdown=TIDY_C, options={"split_by_heading": True}, filename="one.md"),
        dict(kind="tidy_all", stream=STREAM_TEXT, markdown=TIDY_D, options={"split_by_heading": True, "see_links": True, "heading_levels": True}, filename="Zażółć gęślą.md"),
        dict(kind="tidy_all", stream=STREAM_TEXT, markdown=TIDY_E, options={"split_by_heading": True, "heading_levels": True, "see_links": True}),
        dict(kind="tidy_all", stream=STREAM_TEXT, markdown=TIDY_F, options={"split_by_heading": True, "heading_levels": True}),
        dict(kind="tidy_all", stream=STREAM_TEXT, markdown="", options={}),
        dict(kind="tidy_call", stream=STREAM_TEXT, markdown={"repeat": ["a", 2 * 1024 * 1024 + 1]}, options={}),
        dict(kind="tidy_call", stream=STREAM_TEXT, markdown={"repeat": ["é", 1024 * 1024 + 1]}, options={}),
    ],
    rows=[tidy_rows],
    teams=[],
)
CASES.add("tidy_off", [dict(kind="tidy_call", stream=STREAM_TEXT, markdown="x", options={})], rows=[lambda name: [DocsAiSettings(project_id=f"p-{name}", enabled=False, updated_at=STAMP)]], teams=[])


def health_rows(name):
    pid = f"p-{name}"
    body_words = " ".join(f"word{i}" for i in range(60))
    rows = [
        DocsAiSettings(project_id=pid, enabled=True, digest_on=False, updated_at=STAMP),
        *pg(pid, 1, "Release Notes", f"# Release Notes\n\n{body_words}\n\n```\nhidden code\n```\n"),
        *pg(pid, 2, "Release  Notes!", f"# Release Notes\n\n{body_words}\n"),
        *pg(pid, 3, "Guide", "# Guide\n\n## Start\n\ntext\n"),
        *pg(pid, 4, "Unrelated Thing", "x"),
        *pg(pid, 5, "Old", "x", deleted_at=STAMP),
        DocsLink(id=f"{pid}-l1", source_page_id=f"{pid}-pg1", target_title="Missing Page", snippet="x"),
        DocsLink(id=f"{pid}-l2", source_page_id=f"{pid}-pg1", target_title="Missing Page", snippet="dup"),
        DocsLink(id=f"{pid}-l3", source_page_id=f"{pid}-pg1", target_title="Guide", target_anchor="nope", snippet="x"),
        DocsLink(id=f"{pid}-l4", source_page_id=f"{pid}-pg1", target_title="Guide", target_anchor="start", snippet="x"),
        DocsLink(id=f"{pid}-l5", source_page_id=f"{pid}-pg3", target_title="Old", snippet="x"),
        DocsLink(id=f"{pid}-l6", source_page_id=f"{pid}-pg5", target_title="Missing Page", snippet="from a binned page"),
        DocsLink(id=f"{pid}-l7", source_page_id=f"{pid}-pg4", target_ticket_id="HL-3", origin="manual", snippet="x"),
        DocsLink(id=f"{pid}-l8", source_page_id=f"{pid}-pg4", target_ticket_id="HL-5", origin="comment", snippet="x"),
        Ticket(id="HL-1", project_id=pid, title="Done long ago", status="done", created_at=STAMP, updated_at=ago(24 * 40), activity_log=json.dumps([{"field": "status", "from": "todo", "to": "done", "at": ago(24 * 40)}])),
        Ticket(id="HL-2", project_id=pid, title="Done three days ago", status="done", created_at=STAMP, updated_at=ago(80), activity_log=json.dumps([{"field": "status", "to": "done", "at": ago(80)}, "junk"])),
        Ticket(id="HL-3", project_id=pid, title="Done with a page", status="done", created_at=STAMP, updated_at=ago(2)),
        Ticket(id="HL-4", project_id=pid, title="A sub-task", status="done", parent_id="HL-2", created_at=STAMP, updated_at=ago(2)),
        Ticket(id="HL-5", project_id=pid, title="Done, named in a comment", status="done", created_at=STAMP, updated_at=ago(1)),
        Ticket(id="HL-6", project_id=pid, title="Still open", status="todo", created_at=STAMP, updated_at=ago(1)),
        Ticket(id="HL-7", project_id=pid, title="Done without a log", status="done", created_at=STAMP, updated_at=ago(30)),
    ]
    return rows


CASES.add(
    "health",
    [
        dict(kind="health_call", stream=STREAM_TEXT, steps=[["count"], ["get"], ["dismiss", "missing", "HL-2", "once"], ["get"], ["dismiss", "missing", "HL-5", "month"], ["dismiss", "broken", "<P>-pg1|[[Missing Page]]", "never"], ["dismiss", "overlaps", "<P>-pg1,<P>-pg2", "once"], ["get"],
              ["run", "2025-03-04"], ["get"], ["dismiss", "moon", "x", "once"], ["dismiss", "missing", "x", "forever"], ["dismiss", "missing", "HL-7", "never"], ["dismiss", "missing", "HL-7", "once"], ["get"],
              ["words", "Hello ```code``` World_1 émoji 日本語 a-b\nline", 4], ["words", "", 4], ["words", "one two three", 4], ["words", "one two three four", 4]])
    ],
    rows=[health_rows],
    teams=[],
)
CASES.add("health_off", [dict(kind="health_call", stream=STREAM_TEXT, steps=[["get"], ["run"], ["count"]])], rows=[lambda name: [DocsAiSettings(project_id=f"p-{name}", enabled=False, updated_at=STAMP)]], teams=[])


def editor_rows(name):
    pid = f"p-{name}"
    return [Ticket(id=f"{name}-ED-1", project_id=pid, title="Fix add()", status="todo", created_at=STAMP, updated_at=STAMP), *pg(pid, 1, "API", API_MD)]


ALL_SURFACES = ["ticket_description", "acceptance_criteria", "comment", "doc", "idea", "debug_note", "test_case", "moon", ""]
PREVIEWS = [
    {"surface": "ticket_description", "action": "improve", "selection": "add is brokn", "ticket_id": "<N>-ED-1"},
    {"surface": "ticket_description", "action": "ask", "prompt": "Write about it", "before": "b" * 2500, "after": "a" * 2500, "ticket_id": "<N>-ED-1", "include": {"ticket": False}},
    {"surface": "doc", "action": "continue", "before": "Some text", "doc_id": "pg", "include": {"page": True}},
    {"surface": "idea", "action": "summarise", "idea_id": "IDEA-1", "include": {"page": False}},
    {"surface": "doc", "action": "translate", "selection": "x", "doc_id": "pg", "ticket_id": "<N>-ED-1", "prompt": "In French"},
    {"surface": "acceptance_criteria", "action": "split", "selection": "A and B"},
    {"surface": "comment", "action": "criteria"},
    {"surface": "comment", "action": "improve", "selection": "   "},
    {"surface": "comment", "action": "improve", "selection": "x" * 12001},
    {"surface": "comment", "action": "translate", "prompt": "p" * 2001},
    {"surface": "doc", "action": "ask", "prompt": "  "},
    {"surface": "doc", "action": "nope"},
    {"surface": "moon", "action": "improve"},
    {"action": "improve"},
]
CASES.add(
    "editor",
    [
        dict(kind="editor_call", stream=STREAM_TEXT, steps=[["state", s] for s in ALL_SURFACES] + [["preview", p] for p in PREVIEWS]
             + [["items", t] for t in ["- one\n* two\n• three", "1. first\n2) second\n3. third", "[ ] todo\n[X] done\n  - [x] nested", "", "\n\n", "12. twelve\n1234.5 five\n9 nine", "a.b\nx. y", "Plain sentence.\r\nSecond third"]]),
        dict(kind="pure", stream=STREAM_TEXT),
    ],
    rows=[editor_rows],
    teams=[{"name": "Team 0"}],
)
CASES.add("editor_no_team", [dict(kind="editor_call", stream=STREAM_TEXT, steps=[["state", "doc"], ["state", "comment"]])], teams=[])
CASES.add(
    "editor_drafts",
    [
        dict(kind="editor_draft", stream=st({"text": "add() is broken."}), body={"surface": "ticket_description", "action": "improve", "selection": "add is brokn", "ticket_id": "<N>-ED-1"}, then=[["accept", "An Nguyen"], ["accept", "An Nguyen"], ["again", "An Nguyen", False]]),
        dict(kind="editor_draft", stream=st({"text": "- first\n2. second\n[ ] third\n"}), body={"surface": "ticket_description", "action": "criteria", "ticket_id": "<N>-ED-1", "before": "Fix it"}, then=[["accept", "Ana"], ["accept", "An Nguyen", ["only this", " "]]]),
        dict(kind="editor_draft", stream=st({"text": "- first\n- second"}), body={"surface": "acceptance_criteria", "action": "more_criteria", "ticket_id": "<N>-ED-1", "selection": "x", "include": {"selection": False, "ticket": False}}, then=[["accept", "An Nguyen"]]),
        dict(kind="editor_draft", stream=st({"text": "Once upon"}), body={"surface": "doc", "action": "continue", "before": "Intro. ", "doc_id": "<P>-pg1", "language": "English", "include": {"page": True}}, then=[["again", "An Nguyen", True], ["again", "Ana", True], ["again", "An Nguyen", False]]),
        dict(kind="editor_draft", stream=st({"text": "   "}), body={"surface": "comment", "action": "improve", "selection": "x"}),
        dict(kind="editor_draft", stream=STREAM_ERROR, body={"surface": "comment", "action": "shorten", "selection": "x" * 50}),
        dict(kind="editor_draft", stream=STREAM_NONE, body={"surface": "debug_note", "action": "summarise", "before": "log"}),
        dict(kind="editor_draft", stream=STREAM_TEXT, body={"surface": "test_case", "action": "ask", "prompt": "Write steps", "selection": "s"}),
        dict(kind="editor_draft", stream=STREAM_TEXT, body={"surface": "comment", "action": "criteria"}),
        dict(kind="editor_draft", stream=st({"text": "x"}), body={"surface": "idea", "action": "ask", "prompt": "Write", "idea_id": "IDEA-9"}, then=[["again", "An Nguyen", False]]),
    ],
    rows=[editor_rows],
    teams=[{"name": "Team 0"}],
)
CASES.add("editor_off", [dict(kind="editor_draft", stream=STREAM_TEXT, body={"surface": "comment", "action": "shorten", "selection": "x"}), dict(kind="editor_draft", stream=STREAM_TEXT, body={"surface": "doc", "action": "continue"})], teams=[{"name": "Team 0"}],
          rows=[lambda name: AiAssistSettings(id=1, features=json.dumps({"drafting": False}), updated_at=STAMP)])


def ideas_rows(name):
    pid = f"p-{name}"
    ideas_ = [
        IdeaTicket(id=f"{name}-IDEA-1", project_id=pid, title="Offline mode", description="Work without a network.", body="Long body " * 5, problem_statement="People lose work.", stage="inbox", tags=json.dumps(["mobile", "sync"]), effort_guess="M", last_touched_at=STAMP, created_at=STAMP, updated_at="2025-02-01T00:00:00+00:00"),
        IdeaTicket(id=f"{name}-IDEA-2", project_id=pid, title="Dark theme", description="", body="", stage="inbox", created_at=STAMP, updated_at=STAMP),
        IdeaTicket(id=f"{name}-IDEA-3", project_id=pid, title="Shipped thing", description="x", stage="shipped", created_at=STAMP, updated_at=STAMP),
        IdeaTicket(id=f"{name}-IDEA-4", project_id=None, title="No project", description="x", stage="inbox", created_at=STAMP, updated_at=STAMP),
        IdeaAssumption(id=f"{name}-A1", idea_id=f"{name}-IDEA-1", position=1, text="Users go offline", impact="high", status="untested", created_at=STAMP, updated_at=STAMP),
        IdeaAssumption(id=f"{name}-A0", idea_id=f"{name}-IDEA-1", position=0, text="Sync is hard", impact="medium", status="validated", created_at=STAMP, updated_at=STAMP),
        IdeaAdvice(id=f"{name}-ADV", idea_id=f"{name}-IDEA-2", action="park", reason="Later.", confidence="low", park_days=7, idea_stamp="2020-01-01T00:00:00+00:00", state="open", created_at=STAMP),
    ]
    return ideas_


CASES.add("ideas_status", [dict(kind="ideas_call", stream=STREAM_TEXT, steps=[["status", "<P>"], ["update", "<P>", {"enabled": False}], ["status", "<P>"], ["update", "<P>", {"enabled": True, "daily_cap": 0.0, "ask": None, "read_repo": 0, "moon": 1}], ["status", "<P>"], ["update", "<P>", {"daily_cap": 5.0}], ["status", None], ["status", "p-gone"], ["brief", "<N>-IDEA-1"], ["brief", "<N>-IDEA-2"], ["advice_for", ["<N>-IDEA-2", "<N>-IDEA-1"]], ["advice_for", []], ["advice_state", "<N>-ADV", "ignored"], ["advice_state", "nope", "ignored"], ["advice_for", ["<N>-IDEA-2"], True], ["latest", "<P>"], ["latest", None]])], rows=[ideas_rows], teams=[{"name": "Team 0"}])


def usage_rows(name):
    return [AiUsage(id=f"{name}-U1", project_id=f"p-{name}", feature="ideas", cost=2.0, tokens_in=1, tokens_out=1, metered=False, created_at=ago(0))]


def one(*step, stream=STREAM_TEXT):
    return dict(kind="ideas_call", stream=stream, steps=[list(step)])


CASES.add(
    "ideas_turns",
    [
        one("advise", "<N>-IDEA-1", stream=st({"action": "merge", "target_id": "<N>-IDEA-2", "reason": "Same as dark theme.", "confidence": "high"})),
        one("advice_for", ["<N>-IDEA-1", "<N>-IDEA-2"]),
        one("advise", "<N>-IDEA-1", stream=st({"action": "merge", "target_id": "<N>-IDEA-404", "reason": "x"})),
        one("advice_for", ["<N>-IDEA-1"], True),
        one("advise", "<N>-IDEA-1", stream=st({"action": "park", "park_days": "7", "reason": "r" * 600, "confidence": "weird"})),
        one("advise", "<N>-IDEA-1", stream=st({"action": "park", "park_days": 3.5})),
        one("advise", "<N>-IDEA-1", stream=st({"action": "park", "park_days": 14})),
        one("advise", "<N>-IDEA-1", stream=st({"action": "archive", "archive_reason": "obsolete", "reason": "Dead."})),
        one("advise", "<N>-IDEA-1", stream=st({"action": "keep"})),
        one("advise", "<N>-IDEA-1", stream=st({"action": "dance"})),
        one("advise", "<N>-IDEA-404", stream=st({"action": "keep"})),
        one("advise", "<N>-IDEA-1", stream=STREAM_ERROR),
        one("advice_for", ["<N>-IDEA-1", "<N>-IDEA-2"], True),
        one("ask", "Which ideas overlap?", "<P>", "project", stream=st({"answer": "Two.", "sources": [{"id": "<N>-IDEA-1", "title": ""}, {"id": "nope"}, "junk", {"id": "<N>-IDEA-2", "title": "Dark"}], "actions": [{"idea_ids": ["nope", "<N>-IDEA-2"], "label": "Open"}, {"idea_ids": []}, "x", {"idea_ids": ["<N>-IDEA-1"]}, {"idea_ids": ["<N>-IDEA-1"]}, {"idea_ids": ["<N>-IDEA-1"]}]})),
        one("ask", "Without project?", None, "none", stream=st({"answer": ""})),
        one("ask", "All?", "<P>", "all", stream=STREAM_TEXT),
        one("shape", "<N>-IDEA-1", "problem", None, stream=st({"problem": "Lost work.", "idea": {"title": "t"}, "extra": 1})),
        one("shape", "<N>-IDEA-1", "assumptions", None, stream=st({"assumptions": [{"text": "a"}]})),
        one("shape", "<N>-IDEA-1", "tests", None, stream=st({"tests": []})),
        one("shape", "<N>-IDEA-1", "effort", None, stream=st({"effort": "M", "why": "w", "files": ["a.py"], "other": 1})),
        one("shape", "<N>-IDEA-1", "exists", None, stream=st({"summary": "s", "found": [{"title": "x"}, "junk"], "items": [{"title": "y"}]})),
        one("shape", "<N>-IDEA-1", "exists", None, stream=st({"summary": "s", "items": [{"title": "y"}, 3]})),
        one("shape", "<N>-IDEA-1", "exists", None, stream=st({"found": []})),
        one("shape", "<N>-IDEA-1", "ask", " Why? ", stream=st({"answer": "Because."})),
        one("shape", "<N>-IDEA-1", "ask", "Why?", stream=STREAM_TEXT),
        one("shape", "<N>-IDEA-1", "ask", "  ", stream=STREAM_TEXT),
        one("shape", "<N>-IDEA-1", "moon", None, stream=STREAM_TEXT),
        one("shape", "<N>-IDEA-1", "problem", None, stream=STREAM_TEXT),
        one("shape", "<N>-IDEA-404", "problem", None, stream=STREAM_TEXT),
        one("prepare", "<N>-IDEA-1", stream=st({"title": "Offline " + "t" * 300, "description": "d", "acceptance_criteria": ["a", 2], "sub_tickets": ["s"]})),
        one("prepare", "<N>-IDEA-1", stream=st({"description": "no title"})),
        one("prepare", "<N>-IDEA-404", stream=STREAM_TEXT),
        one("groom", "<P>", stream=st({"text": "Weekly.", "items": [{"kind": "stale", "idea_ids": ["<N>-IDEA-1", "x"], "text": "Old"}, "junk", {"text": 5}]})),
        one("latest", "<P>"),
        one("groom", None, stream=STREAM_TEXT),
        one("latest", None),
    ],
    rows=[ideas_rows],
    teams=[{"name": "Team 0"}],
)
CASES.add("ideas_off", [one("advise", "<N>-IDEA-1"), one("ask", "q", "<P>", "project"), one("shape", "<N>-IDEA-1", "problem", None), one("groom", "<P>"), one("prepare", "<N>-IDEA-1")],
          rows=[ideas_rows, lambda name: IdeaAiSettings(project_id=f"p-{name}", enabled=False, updated_at=STAMP)], teams=[{"name": "Team 0"}])
CASES.add("ideas_switches", [one("advise", "<N>-IDEA-1"), one("ask", "q", "<P>", "project"), one("groom", "<P>"), one("shape", "<N>-IDEA-1", "problem", None, stream=st({"problem": "p"}))],
          rows=[ideas_rows, lambda name: IdeaAiSettings(project_id=f"p-{name}", enabled=True, triage_advice=False, ask=False, weekly_grooming=False, updated_at=STAMP)], teams=[{"name": "Team 0"}])
CASES.add("ideas_cap", [one("status", "<P>"), one("advise", "<N>-IDEA-1")], rows=[ideas_rows, usage_rows], teams=[{"name": "Team 0"}])
CASES.add("ideas_no_team", [one("status", "<P>")], rows=[ideas_rows], teams=[], )


async def main():
    await database.init_db()
    out["turns"] = []
    only = set(filter(None, os.environ.get("GEN_ONLY", "").split(",")))
    for case in CASES:
        if only and case.name not in only:
            continue
        async with database.async_session() as s:
            for row in (await s.exec(select(AiAssistSettings))).all():
                await s.delete(row)
            await s.commit()
        out["turns"].append(await build(case))
    out["blobs"] = blobs
    text = json.dumps(out, ensure_ascii=False, indent=1)
    OUT.write_text(text + "\n", encoding="utf-8")
    print(f"{OUT.name}: {len(out['turns'])} cases, {sum(len(c['out']) for c in out['turns'])} calls, {len(blobs)} blobs, {len(text.encode()) // 1024} KB")
    for case in out["turns"]:
        for i, o in enumerate(case["out"]):
            if isinstance(o["gave"], dict) and "error" in o["gave"]:
                print("  error:", case["name"], i, o["gave"]["error"])
    _tmp.cleanup()


asyncio.run(main())
