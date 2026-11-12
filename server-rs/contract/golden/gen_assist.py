"""Golden vectors for `services/assistant/` (`crates/kb-assist/src/assistant/`): the engine of the assistants and
the Board AI chat.

`pure`: the functions that need no database and the constants of `errors`, `settings`, `sessions`, `skills` (every
skill's text by hash, every schema, the files of the plugin), `engine` (`system_prompt`, `render_inputs`,
`Turn.data`), `drafts`, `receipt` (`_item_words`, `summary`, `merge`, `_same`) and `health` (`insight_out`).

`db`: three scripted scenarios on rows built here with the Python models: `settings` (describe, update, the team that
answers, metering), `receipt` (`collect` and `undo` over recorded activity logs, with the tickets as they are
afterwards) and `health` (the panel, the chips, snooze, dismiss, restore). Each holds its rows and a list of calls
with what came back.

`turns`: everything a turn is started with, for a matrix of situations (a first chat turn and a resumed one, a chat
with a ticket or a page in focus, attachments and pictures, every kind of assistant these modules serve, Safe mode on
the team and on the project, an account, models, a one-shot answer). The CLI of every team is a small script
(`RECORDER`, the same bytes in `crates/kb-assist/tests/common/mod.rs`) that writes down its arguments, its
environment and its folder, then prints the stream-json lines of the case. A case holds its rows, folders and files,
its calls, and per call the recording (`launch`: the command line, the settings JSON, the MCP config, the schema, the
system prompts, the child's environment as its difference from the board's own) and what the call gave (the turn,
its run, its steps, the usage, the chat message).

Paths: the temporary folder of this run is written `<ROOT>`, the system's temporary folder `<TMP>`. In what a call
gave, a chat token is `<TOKEN>`, a UUID `<UUID>`, a run's id `<RUN>`, a time `<TIME>`, a date `<DAY>`, the folder of a one-shot answer `oneshot-<ID>`.
A text over 200 characters is stored as its SHA-256 and its length in characters, and once in `blobs` (by hash).

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_assist.py
Writes `assist.json` next to this file.
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
work = os.path.realpath(tempfile.mkdtemp(prefix="gen-assist-"))
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
    DocsPage,
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

OUT = Path(__file__).with_name("assist.json")
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


# ---------------------------------------------------------------------------------------------------------------------
# pure functions and constants
# ---------------------------------------------------------------------------------------------------------------------
pure: dict = {}
pure["errors"] = {"STATUS": [[k, v] for k, v in errors.STATUS.items()]}

STORED = [("{}", "{}"), ('{"chat": false}', '{"time": "09:30"}'), ('{"extra": 1, "docs": 0, "health": null}', '{"days": [5, 6], "new": {"a": 1}, "on": false}'), ("", ""), ("not json", "{broken")]
pure["settings"] = {
    "FEATURES": [[k, v] for k, v in svc_settings.FEATURES.items()],
    "DESCRIPTIONS": [[k, v] for k, v in svc_settings.DESCRIPTIONS.items()],
    "DEFAULT_FEATURES": json.dumps(svc_settings.DEFAULT_FEATURES),
    "DEFAULT_HEALTH": json.dumps(svc_settings.DEFAULT_HEALTH),
    "TONES": list(svc_settings.TONES),
    "STYLE_GUIDE_MAX": svc_settings.STYLE_GUIDE_MAX,
    "stored": [
        {
            "features": f,
            "health": h,
            "out_features": json.dumps(svc_settings.features(AiAssistSettings(id=1, features=f, health=h))),
            "out_health": json.dumps(svc_settings.health_config(AiAssistSettings(id=1, features=f, health=h))),
        }
        for f, h in STORED
    ],
}

ASKED = [(None, "p"), ("", "p"), ("system", "p"), ("user", "p"), ("An Nguyen", "Hello\nthere"), ("Nguyễn Văn An", ""), ("User", "x")]
pure["sessions"] = {
    "MEMBER": sessions.MEMBER,
    "names": {
        "page": sessions.page_name("pg-1"),
        "board": sessions.board_name("p-1"),
        "chat": sessions.chat_name("c-1"),
        "idea": sessions.idea_name("IDEA-1"),
        "sketch": sessions.sketch_name("sk_1"),
    },
    "asked_by": [{"person": p, "prompt": t, "out": sessions.asked_by(p, t)} for p, t in ASKED],
}

plugin = Path(skills.plugin_dir())
pure["skills"] = {
    "PLUGIN": skills.PLUGIN,
    "names": skills.names(),
    "version": skills._version(),
    "texts": {n: {"sha256": hashlib.sha256(skills.text_of(n).encode()).hexdigest(), "chars": len(skills.text_of(n))} for n in skills.names()},
    "schemas": [[k, T(json.dumps(v))] for k, v in skills.SCHEMAS.items()],
    "plugin_dir": norm(str(plugin)),
    "plugin_files": {
        str(p.relative_to(plugin)): {"sha256": hashlib.sha256(p.read_bytes()).hexdigest(), "bytes": p.stat().st_size}
        for p in sorted(plugin.rglob("*"))
        if p.is_file()
    },
    "plugin_json": (plugin / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"),
}

PROMPTS = [
    ("Board AI", "An Nguyen", "Kanban Board", "board-ask"),
    ("Docs AI", "Nguyễn Văn An", "Dự án “Ω”", "docs-summarise"),
    ("Idea AI", "user", "", "idea-ask"),
    ("Sketch AI", "An's team", "A `quoted` project", "sketch-ask"),
]
RENDER = [
    ("board-ask", {"question": "What is open?", "project_id": "p1", "scope": "project", "ticket_id": None, "page_id": None, "also_read_pages": None}, "An Nguyen"),
    (
        "docs-ask",
        {
            "question": "Line one\nline two",
            "pages": ["a", "b"],
            "meta": {"k": "v", "n": 1, "nested": {"x": [1, 2.5, True, None]}, "uni": "Tiếng Việt"},
            "empty": "",
            "zero": 0,
            "flag": False,
            "yes": True,
            "ratio": 0.5,
            "big": 12345678901234567890,
            "long": "x" * 121,
            "exact": "y" * 120,
            "uni": "Tiếng Việt “quoted” </board trusted>",
            "list_empty": [],
            "dict_empty": {},
            "spaces": "   ",
        },
        "user",
    ),
    ("sketch-ask", {"text": "What?", "files": ["/tmp/a b.png"], "canvas": {"w": 800, "h": 600, "title": "Login"}}, "system"),
    ("db-fix", {"stop": {"table": "project", "column": "name"}, "previous": None, "question": None}, "user"),
    ("x", {}, ""),
    ("idea-ask", {"question": "?"}, "Nguyễn Văn An"),
]
DATA = [
    ('{"a": 1}', None),
    ('  {"a": 1, "b": [1, 2]}  \n', None),
    ('```json\n{"a": 1}\n```', None),
    ('```\n{"a": 1}\n```', None),
    ('```{"a": 1}```', None),
    ('```json{"a": 1}```', None),
    ("json", None),
    ("[1]", None),
    ("{bad", None),
    ("", None),
    ("plain text", None),
    ('{"a": 1}', {}),
    ("ignored", {"answer": "A", "ideas": ["x"]}),
    ('`{"a": 1}`', None),
]
pure["engine"] = {
    "BOARD_SKILLS": engine.BOARD_SKILLS,
    "DEFAULT_MODEL": engine.DEFAULT_MODEL,
    "TIMEOUT_S": engine.TIMEOUT_S,
    "NAMES": [[k, v] for k, v in engine.NAMES.items()],
    "system_prompt": [{"member": m, "by": b, "project": p, "skill": s, "out": T(engine.system_prompt(m, b, p, s))} for m, b, p, s in PROMPTS],
    "render_inputs": [{"skill": s, "inputs": i, "by": b, "out": T(engine.render_inputs(s, i, b))} for s, i, b in RENDER],
    "data": [{"text": t, "structured": s, "out": engine.Turn(run_id="r", text=t, structured=s).data()} for t, s in DATA],
}

# drafts
d1 = drafts.new("p1", "editor", "An Nguyen", {"x": 1}, ticket_id="T-1", chat_message_id="m1", member_name="Docs AI")
d2 = drafts.new("p1", "sketch", "An Nguyen", {"result": {"ideas": ["a"]}})
shape1, shape2 = scrub(dict(d1)), scrub(dict(d2))
closed = [drafts.close(d1["id"], "discarded", "An")["status"], drafts.close(d1["id"], "cancelled")["status"]]
d2["status"] = "applied"
closed.append(drafts.close(d2["id"], "discarded")["status"])
try:
    drafts.get("nope")
    gone = None
except AssistError as exc:
    gone = {"code": exc.code, "message": str(exc)}
drafts.DRAFTS.clear()
ids = [drafts.new("p", "editor", "An", {})["id"] for _ in range(drafts.MAX)]
newest = drafts.new("p", "editor", "An", {})["id"]
pure["drafts"] = {
    "MAX": drafts.MAX,
    "new": [shape1, shape2],
    "closed": closed,
    "gone": gone,
    "after_full": {"count": len(drafts.DRAFTS), "first_kept": ids.index(next(i for i in ids if i in drafts.DRAFTS)), "newest_kept": newest in drafts.DRAFTS},
}
drafts.DRAFTS.clear()

WORDS = [
    {"from": None, "to": "open", "ref": "Write tests"},
    {"from": "open", "to": None, "ref": "x"},
    {"from": "open", "to": "done", "ref": "t"},
    {"from": "done", "to": "open"},
    {"from": "open", "to": "other"},
    {"from": None, "to": None},
    {"from": None, "to": "feature/x"},
    {"from": "feature/x", "to": None},
    {"to": "y" * 100},
    {"from": 1, "to": 2, "ref": 3},
    {"from": "", "to": "", "ref": ""},
    {},
]
C1 = {"op": "status", "ticket": "T-1", "before": "todo", "after": "done", "at": "2025-03-01T10:00:00+00:00", "undo": True}
C2 = {"op": "comment", "ticket": "T-1", "before": None, "after": "Hi", "ref": "c1", "at": "2025-03-01T10:01:00+00:00", "undo": True}
OLD = {"applied": [C1, C2, dict(C1, ticket="T-2")], "count": 3, "status": "undone", "runs": ["r0"], "undo": {"undone": 1, "put_back": [1], "skipped": [], "kept": []}}
MERGES = [
    (None, [], "r1"),
    (None, [C1], "r1"),
    (OLD, [C2], "r1"),
    (OLD, [], "r2"),
    ({}, [], "r"),
    ({"applied": [], "runs": ["r0"]}, [], "r1"),
    ({"applied": [C1], "runs": None, "undo": None}, [C2], "r1"),
    ({"applied": [C1, C2], "undo": {"put_back": [0, 1]}, "runs": ["r0"]}, [], "r1"),
]
SAME = [
    ("a", "a"),
    ("x" * 300, "x" * 199 + "…"),
    ("x" * 300, "x" * 300),
    ("x" * 200, "x" * 199 + "…"),
    (None, []),
    ([], None),
    (["a"], ["a"]),
    (["a"], ["b"]),
    (["a", "b"], ["b", "a"]),
    (1, 1.0),
    (None, None),
    ("", None),
    (2.5, 2.5),
    ("a", 1),
    (True, 1),
    (["a"], "a"),
    (None, "todo"),
    ("todo", "todo"),
]
pure["receipt"] = {
    "FIELDS": list(receipt.FIELDS),
    "LISTED": list(receipt.LISTED),
    "MAX_CHANGES": receipt.MAX_CHANGES,
    "HAND_OVER": list(receipt.HAND_OVER),
    "item_words": [{"field": f, "e": e, "out": receipt._item_words(f, e)} for f in ("sub_task", "acceptance_criterion", "branch", "link") for e in WORDS],
    "summary": {"changes": [C1, C2], "runs": ["r1", "r2"], "out": json.dumps(receipt.summary([C1, C2], ["r1", "r2"]))},
    "merge": [{"old": o, "changes": c, "run_id": r, "out": receipt.merge(o, list(c), r)} for o, c, r in MERGES],
    "same": [{"a": a, "b": b, "out": receipt._same(a, b)} for a, b in SAME],
}

INSIGHTS = [
    AiInsight(id="i-1", project_id="p1", kind="stuck", key="k1", ticket_id="T-1", title="T-1 has not moved", detail="Six days.", data='{"chip": "Stuck 6d", "days": 6}', score=80.0, created_at=STAMP, updated_at=STAMP),
    AiInsight(id="i-2", project_id="p1", kind="at_risk", key="k2", title="No owner", data="not json", score=12.5, state="snoozed", snoozed_until="2099-01-01T00:00:00+00:00", seen=True, created_at=STAMP, updated_at=STAMP),
    AiInsight(id="i-3", project_id="p1", kind="wip", key="k3", title="Too much", data="", score=0.0, state="dismissed", draft_id="d-9", created_at=STAMP, updated_at=STAMP),
]
pure["health"] = {"KINDS": list(health.KINDS), "insight_out": [{"row": row_dict(i), "out": json.dumps(health.insight_out(i))} for i in INSIGHTS]}
out["pure"] = pure


# ---------------------------------------------------------------------------------------------------------------------
# scenarios on the database
# ---------------------------------------------------------------------------------------------------------------------
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


async def settings_scenario():
    rows: dict = {}
    calls: list = []
    async with database.async_session() as s:
        await add(
            s,
            rows,
            Project(id="ps1", name="Solo", prefix="PSA", color="#2E6F40"),
            Project(id="ps2", name="Teams", prefix="PSB", color="#2E6F40"),
            Project(id="ps4", name="Chosen", prefix="PSD", color="#2E6F40"),
            Project(id="ps5", name="Foreign", prefix="PSE", color="#2E6F40"),
            member("ps1", "ps1-an", "An Nguyen"),
            member("ps2", "ps2-b", "B team", "ai"),
            member("ps2", "ps2-c", "C team", "ai"),
            member("ps2", "ps2-a", "A team", "ai"),
            member("ps2", "ps2-z", "Aaron Human"),
            member("ps2", "ps2-n", "0 no profile", "ai"),
            team("ps2", "ps2-b", paused=True),
            team("ps2", "ps2-c"),
            team("ps2", "ps2-a", paused=True),
            member("ps4", "ps4-a", "A first", "ai"),
            member("ps4", "ps4-b", "B chosen", "ai"),
            team("ps4", "ps4-a"),
            team("ps4", "ps4-b"),
            member("ps5", "ps5-a", "Only team", "ai"),
            member("ps5", "ps5-h", "Hoa Mai"),
            team("ps5", "ps5-a"),
            DocsAiSettings(project_id="ps2", enabled=True, member_id="ps2-a", updated_at=STAMP),
            DocsAiSettings(project_id="ps4", enabled=True, member_id="ps4-b", updated_at=STAMP),
            DocsAiSettings(project_id="ps5", enabled=True, member_id="ps4-b", updated_at=STAMP),
            DocsAiSettings(project_id="ps1", enabled=True, member_id=None, updated_at=STAMP),
            AiUsage(id="u-old", project_id="ps1", feature="chat", person="An", cost=9.0, tokens_in=1, tokens_out=1, metered=False, created_at="2020-01-01T00:00:00+00:00"),
        )
        await s.commit()

        async def call(op, args, fn):
            try:
                got = await fn()
            except AssistError as exc:
                got = err(exc)
            calls.append({"op": op, "args": args, "out": scrub(got)})

        def settings_row(r):
            return {k: getattr(r, k) for k in ("features", "language", "tone", "style_guide", "health")}

        await call("describe", {"project_id": "ps1"}, lambda: svc_settings.describe(s, "ps1"))
        await call("describe", {"project_id": "ps2"}, lambda: svc_settings.describe(s, "ps2"))
        PATCHES = [
            {"features": {"chat": False, "bogus": True, "docs": 0, "sketch": "yes"}},
            {"language": "x" * 50},
            {"language": None},
            {"language": "Tiếng Việt", "tone": "concise"},
            {"tone": "rude"},
            {"tone": None, "style_guide": "y" * 1200},
            {"style_guide": ""},
            {"health": {"time": "09:30", "extra": 1, "days": []}},
            {"features": "not a dict", "health": ["no"]},
            {},
        ]
        for patch in PATCHES:

            async def do(patch=patch):
                return settings_row(await svc_settings.update(s, patch))

            await call("update", {"data": patch}, do)
        await call("describe", {"project_id": "ps2"}, lambda: svc_settings.describe(s, "ps2"))
        for feature in ("chat", "docs", "health", "sketch", "unknown"):
            await call("feature_on", {"feature": feature}, lambda feature=feature: svc_settings.feature_on(s, feature))

        async def who(fn):
            m, p = await fn
            return {"member": m.id if m else None, "profile": p.id if p else None}

        for pid in ("ps1", "ps2", "ps4", "ps5", "nope"):
            await call("first_team", {"project_id": pid}, lambda pid=pid: who(svc_settings.first_team(s, pid)))
            for feature in ("chat", "docs"):
                await call("answering_team", {"project_id": pid, "feature": feature}, lambda pid=pid, feature=feature: who(svc_settings.answering_team(s, pid, feature)))
        USAGE = [
            ("ps1", "chat", "An Nguyen", dict(tokens_in=200, tokens_out=40, cost=0.02)),
            ("ps1", "docs", None, dict(cost=0.0155555)),
            ("ps2", "chat", "An", dict(tokens_in=3, cost=1 / 3, member_id="ps2-c")),
            ("ps2", "health", "system", dict()),
        ]
        for pid, feature, person, kw in USAGE:

            async def rec(pid=pid, feature=feature, person=person, kw=kw):
                return json.loads((await svc_settings.record_usage(s, pid, feature, person, **kw)).model_dump_json())

            await call("record_usage", {"project_id": pid, "feature": feature, "person": person, **kw}, rec)
        for feature in (None, "chat", "docs", "health", "none"):
            await call("month_spend", {"feature": feature}, lambda feature=feature: svc_settings.month_spend(s, feature))
    return {"rows": rows, "calls": calls}


def entry(field, frm, to, at, *, run="run-A", actor="Dev Team", ref=None):
    e = {"field": field, "from": frm, "to": to, "at": f"2025-03-01T{at}+00:00", "actor": actor}
    if ref:
        e["ref"] = ref
    if run:
        e.update({"ai": True, "on_behalf_of": "An Nguyen", "run_id": run, "member_id": "pr1-team"})
    return e


def comment(cid, text, author, at, deleted=None):
    return {"id": cid, "text": text, "author": author, "at": f"2025-03-01T{at}+00:00", "edited_at": None, "deleted_at": deleted, "mentions": [], "notified": []}


TICKET_FIELDS = ("status", "assignee", "priority", "title", "description", "tags", "estimate", "due_date", "start_date", "parent_id", "type")


async def snapshot(s, ids):
    snap = {}
    for tid in ids:
        s.expire_all()
        t = await s.get(Ticket, tid)
        if t is None:
            snap[tid] = None
            continue
        snap[tid] = {k: getattr(t, k) for k in TICKET_FIELDS}
        snap[tid]["comments"] = [[c.get("id"), bool(c.get("deleted_at"))] for c in json.loads(t.comments or "[]")]
    return snap


async def receipt_scenario():
    rows: dict = {}
    calls: list = []
    long_a, long_b = "Old words. " * 25, "New words! " * 30

    def tk(tid, pid="pr1", *, log, at="10:05:00", **more):
        fields = dict(id=tid, project_id=pid, title=f"Ticket {tid}", status="todo", activity_log=json.dumps(log), created_at=STAMP, updated_at=f"2025-03-01T{at}+00:00")
        fields.update(more)
        return Ticket(**fields)

    async with database.async_session() as s:
        await add(
            s,
            rows,
            Project(id="pr1", name="Receipts", prefix="R", color="#2E6F40", ticket_counter=20),
            Project(id="pr2", name="Other", prefix="Q", color="#2E6F40", ticket_counter=5),
            member("pr1", "pr1-an", "An Nguyen"),
            member("pr1", "pr1-hoa", "Hoa Mai"),
            member("pr1", "pr1-team", "Dev Team", "ai"),
            tk("R-1", status="in-progress", log=[entry("status", "todo", "in-progress", "10:00:01"), entry("priority", "low", "medium", "09:00:00", run="run-B")]),
            tk("R-2", assignee=None, log=[entry("assignee", "pr1-an", "pr1-hoa", "10:00:02"), entry("assignee", "pr1-hoa", None, "10:51:07", run=None, actor="Hoa Mai")]),
            tk(
                "R-3",
                title="New ticket from AI",
                priority="high",
                comments=json.dumps([comment("c-31", "First note", "Dev Team", "10:00:05")]),
                log=[entry("created", None, None, "10:00:03", ref="New ticket from AI"), entry("priority", None, "high", "10:00:04"), entry("comment", None, "First note", "10:00:05", ref="c-31")],
            ),
            tk("R-4", comments=json.dumps([comment("c-41", "A person wrote here", "An Nguyen", "10:20:00")]), log=[entry("created", None, None, "10:00:06")]),
            tk("R-5", description=long_b, log=[entry("description", (long_a[:199] + "…"), (long_b[:199] + "…"), "10:00:07")]),
            tk(
                "R-6",
                log=[
                    entry("sub_task", None, "open", "10:00:08", ref="Write tests"),
                    entry("acceptance_criterion", "open", "done", "10:00:09", ref="It adds"),
                    entry("branch", None, "feature/x", "10:00:10"),
                    entry("link", None, "R-1", "10:00:11"),
                    entry("work_log", None, "1h", "10:00:12"),
                ],
            ),
            tk("R-7", status="done", log=[entry("status", "review", "done", "10:00:13")]),
            tk("R-8", comments=json.dumps([comment("c-81", "Gone", "Dev Team", "10:00:14", deleted="2025-03-01T10:30:00+00:00")]), log=[entry("comment", None, "Gone", "10:00:14", ref="c-81")]),
            tk(
                "R-9",
                title="New title",
                tags='["a", "b"]',
                estimate=2.5,
                due_date="2025-03-09",
                start_date="2025-03-02",
                priority="high",
                type="bug",
                description="Short new",
                log=[
                    entry("tags", None, ["a", "b"], "10:00:15"),
                    entry("estimate", None, 2.5, "10:00:16"),
                    entry("title", "Old title", "New title", "10:00:17"),
                    entry("due_date", None, "2025-03-09", "10:00:18"),
                    entry("priority", "medium", "high", "10:00:19"),
                    entry("type", "task", "bug", "10:00:20"),
                    entry("start_date", None, "2025-03-02", "10:00:21"),
                    entry("description", "Short old", "Short new", "10:00:22"),
                ],
            ),
            tk("R-10", status="todo", log=[entry("status", "wont_do", "todo", "10:00:23")]),
            tk("R-12", status="review", at="11:00:00", log=[entry("status", "todo", "in-progress", "10:00:24"), entry("status", "in-progress", "review", "11:00:00", run="run-B")]),
            tk("R-13", parent_id="R-1", log=[entry("parent_id", None, "R-1", "10:00:25")]),
            tk("R-14", status="in-progress", at="09:00:00", log=[entry("status", "todo", "in-progress", "10:00:26")]),
            tk("Q-1", "pr2", status="in-progress", log=[entry("status", "todo", "in-progress", "10:00:27")]),
        )
        await s.commit()
        ids = ["R-1", "R-2", "R-3", "R-4", "R-5", "R-6", "R-7", "R-8", "R-9", "R-10", "R-12", "R-13", "R-14", "Q-1"]
        collected: dict = {}
        COLLECTS = [
            ("a", "pr1", "run-A", None),
            ("all", None, "run-A", None),
            ("since", "pr1", "run-A", "2025-03-01T10:30:00+00:00"),
            ("b", "pr1", "run-B", None),
            ("none", "pr1", "run-none", None),
            ("other", "pr2", "run-A", ""),
        ]
        for name, pid, run_id, since in COLLECTS:
            got = await receipt.collect(s, pid, run_id, since)
            collected[name] = got
            calls.append({"op": "collect", "name": name, "args": {"project_id": pid, "run_id": run_id, "since": since}, "out": json.loads(json.dumps(got))})
        first = json.loads(json.dumps(collected["a"]))
        got = await receipt.undo(s, first, ["run-A"], {0})
        calls.append({"op": "undo", "args": {"applied": "a", "runs": ["run-A"], "already": [0]}, "out": got, "tickets": await snapshot(s, ids)})
        already = sorted(set(got["put_back"]) | {0})
        got = await receipt.undo(s, first, ["run-A"], set(already))
        calls.append({"op": "undo", "args": {"applied": "a", "runs": ["run-A"], "already": already}, "out": got, "tickets": await snapshot(s, ids)})
        manual = [
            {"op": "status", "ticket": "R-99", "before": "todo", "after": "done", "at": "2025-03-01T10:00:00+00:00", "undo": True},
            {"op": "branch", "ticket": "R-6", "undo": False},
            {"op": "sub_task", "ticket": "R-6", "words": "sub-task added: Write tests", "undo": False},
            {"op": "status", "ticket": "R-1", "before": "todo", "after": "in-progress", "at": "2025-03-01T10:00:01+00:00", "undo": True},
            {"op": "priority", "ticket": "Q-1", "before": "urgent!", "after": "medium", "at": "2025-03-01T10:00:02+00:00", "undo": True},
        ]
        got = await receipt.undo(s, manual, ["run-A"], None)
        calls.append({"op": "undo", "args": {"applied": manual, "runs": ["run-A"], "already": None}, "out": got, "tickets": await snapshot(s, ids)})
    return {"rows": rows, "calls": calls}


async def health_scenario():
    rows: dict = {}
    calls: list = []

    def ins(n, **more):
        fields = dict(id=f"h-{n}", project_id="ph1", kind="stuck", key=f"key-{n}", title=f"Insight {n}", score=float(n), created_at=STAMP, updated_at=STAMP)
        fields.update(more)
        return AiInsight(**fields)

    async with database.async_session() as s:
        await add(
            s,
            rows,
            Project(id="ph1", name="Health", prefix="H", color="#2E6F40"),
            member("ph1", "ph1-team", "Health Team", "ai"),
            team("ph1", "ph1-team"),
            ins(1, ticket_id="H-1", data='{"chip": "Stuck 6d"}'),
            ins(2, ticket_id="H-1", score=90.0, kind="at_risk"),
            ins(3, ticket_id="H-2", kind="wip", seen=True),
            ins(4, score=50.0),
            ins(5, score=50.0, ticket_id="H-3", kind="unassigned"),
            ins(6, score=50.0, seen=True),
            ins(7, state="snoozed", snoozed_until="2020-01-01T00:00:00+00:00", seen=True, ticket_id="H-4"),
            ins(8, state="snoozed", snoozed_until="2099-01-01T00:00:00+00:00", ticket_id="H-5"),
            ins(9, state="dismissed"),
            ins(10, state="resolved", score=99.0),
            ins(11, state="snoozed", snoozed_until="not a time", score=70.0),
            ins(12, score=5.5),
            ins(13, score=6.5),
            ins(14, score=7.5),
            ins(15, score=8.5),
            AiInsight(id="h-other", project_id="ph2", kind="stuck", key="k", title="Elsewhere", score=100.0, created_at=STAMP, updated_at=STAMP),
            AiDigest(id="dg-1", project_id="ph1", day="2025-02-01", summary='{"text": "Older", "tickets": 1}', cost=0.01, tokens=10, created_at="2025-02-01T08:00:00+00:00"),
            AiDigest(id="dg-2", project_id="ph1", day="2025-02-02", summary='{"text": "Newer", "done": [], "in_progress": [], "blocked": [], "tickets": 3}', cost=0.02, tokens=240, created_at="2025-02-02T08:00:00+00:00"),
        )
        await s.commit()

        async def call(op, args, fn):
            try:
                got = await fn()
            except AssistError as exc:
                got = err(exc)
            calls.append({"op": op, "args": args, "out": scrub(json.loads(json.dumps(got)))})

        await call("panel", {"project_id": "ph1"}, lambda: health.panel(s, "ph1"))
        await call("chips", {"project_id": "ph1"}, lambda: health.chips(s, "ph1"))
        await call("panel", {"project_id": "empty"}, lambda: health.panel(s, "empty"))
        STATES = [("h-1", "snooze", 2), ("h-2", "snooze", 0), ("h-3", "dismiss", 24), ("h-8", "restore", 24), ("h-4", "act", 24), ("h-4", "bogus", 24), ("nope", "dismiss", 24)]
        for iid, action, hours in STATES:
            await call("set_state", {"insight_id": iid, "action": action, "hours": hours}, lambda iid=iid, action=action, hours=hours: health.set_state(s, iid, action, hours=hours))
        await call("panel", {"project_id": "ph1"}, lambda: health.panel(s, "ph1"))
        await call("mark_seen", {"project_id": "ph1"}, lambda: health.mark_seen(s, "ph1"))
        await call("panel", {"project_id": "ph1"}, lambda: health.panel(s, "ph1"))
        await call("snooze_all", {"project_id": "ph1", "hours": 24}, lambda: health.snooze_all(s, "ph1", 24))
        await call("panel", {"project_id": "ph1"}, lambda: health.panel(s, "ph1"))
        await call("chips", {"project_id": "ph1"}, lambda: health.chips(s, "ph1"))
    return {"rows": rows, "calls": calls}


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


async def do_call(case: Case, call: dict) -> dict:
    kind = call["kind"]
    pid = case.pid
    given: dict = {}
    if kind == "turn":
        schema = call.get("schema", "skill")
        kw = dict(name=call["name"], skill=call["skill"], inputs=call["inputs"], by=call["by"], feature=call.get("feature", "chat"), schema=True if schema == "skill" else (None if schema == "plain" else schema), ticket_id=call.get("ticket_id"), files=[(n, t.encode()) for n, t in call.get("files", [])] or None, fresh=call.get("fresh", False), depth=call.get("depth", 0), timeout_s=30.0)
        try:
            t = await engine.turn(pid, **kw)
        except AssistError as exc:
            return err(exc)
        given = {"turn": turn_dict(t), **(await run_of(t.run_id))}
    elif kind == "oneshot":
        try:
            t = await engine.oneshot(call["skill"], call["inputs"], **{k: call[k] for k in ("by", "model") if k in call})
        except AssistError as exc:
            return err(exc)
        given = {"turn": turn_dict(t), "run_id": t.run_id}
    elif kind == "chat":
        async with database.async_session() as s:
            try:
                sent = await chat.send(s, call["chat_id"], call["by"], call["text"], doc_ids=call.get("doc_ids"), mode=call.get("mode", "ask"), files=[(n, t.encode()) for n, t in call.get("files", [])] or None, skill=call.get("skill", "board-ask"), extra=call.get("extra"))
            except AssistError as exc:
                return err(exc)
        mid = sent["ai"]["id"]
        for _ in range(600):
            async with database.async_session() as s:
                m = await chat.get_message(s, mid, call["by"])
            if m["state"] not in chat.ACTIVE:
                break
            await asyncio.sleep(0.05)
        async with database.async_session() as s:
            detail = await chat.detail(s, call["chat_id"], call["by"])
        run_id = (m["context"].get("run") or {}).get("id")
        given = {"sent": sent, "message": m, "detail": detail, **((await run_of(run_id)) if run_id else {})}
    elif kind == "health":
        try:
            panel = await health.check(pid, call["by"])
        except AssistError as exc:
            return err(exc)
        async with database.async_session() as s:
            run = (await s.exec(select(AiRun).where(AiRun.project_id == pid).order_by(AiRun.queued_at.desc()))).first()
        given = {"panel": panel, **(await run_of(run.id))}
    given["usage"] = await usage_of(pid)
    return given


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


def chat_row(case, cid="chat-1", **more):
    fields = dict(id=f"{cid}-{case}", project_id=f"p-{case}", owner="An Nguyen", created_at=STAMP, updated_at=STAMP)
    fields.update(more)
    return AiChat(**fields)


def ask(case, text, cid="chat-1", **more):
    return dict(kind="chat", chat_id=f"{cid}-{case}", by="An Nguyen", text=text, stream=more.pop("stream", STREAM_TEXT), **more)


def turn(name, skill, inputs, by="An Nguyen", **more):
    return dict(kind="turn", name=name, skill=skill, inputs=inputs, by=by, stream=more.pop("stream", STREAM_TEXT), **more)


MCP_JSON = json.dumps({"mcpServers": {"repo-tools": {"command": "node", "args": ["tools.js"]}, "kanban": {"command": "never"}}})
CASES = [
    Case("chat", [ask("chat", "What is open?"), ask("chat", "And blocked?")], rows=[chat_row("chat")]),
    Case("chat_no_team", [ask("chat_no_team", "Is anyone there?")], teams=[], rows=[chat_row("chat_no_team", title="Kept title")]),
    Case(
        "chat_ticket",
        [ask("chat_ticket", "What is left to do here?")],
        rows=[
            Ticket(id="KAN-chat_ticket", project_id="p-chat_ticket", title="Fix add()", status="todo", created_at=STAMP, updated_at=STAMP),
            chat_row("chat_ticket", scope="ticket", scope_id="KAN-chat_ticket", ticket_id="KAN-chat_ticket", title="KAN-chat_ticket Fix add()"),
        ],
    ),
    Case(
        "chat_page",
        [ask("chat_page", "Summarise this page in five lines.", doc_ids=["pg-3", "pg-4"], mode="ask")],
        rows=[chat_row("chat_page", scope="doc", scope_id="pg-1", doc_id="pg-1", title="API guide", include_docs='["pg-2"]')],
    ),
    Case("chat_idea", [ask("chat_idea", "Challenge this idea: the weakest assumptions first.")], rows=[chat_row("chat_idea", scope="idea", scope_id="IDEA-7", title="Offline mode")]),
    Case(
        "chat_files",
        [ask("chat_files", "Read the notes and look at ![shot](/uploads/comments/shot.png) please.", files=[["notes.txt", "hello"], ["sub/dir/data.csv", "a,b\n1,2\n"]])],
        rows=[chat_row("chat_files")],
        uploads={"comments/shot.png": "PNG-shot"},
    ),
    Case(
        "chat_sketch",
        [
            ask(
                "chat_sketch",
                "What is this?",
                skill="sketch-ask",
                files=[["canvas.png", "PNG"], ["ref.JPG", "JPG"], ["notes.md", "# n"]],
                extra={"canvas": {"w": 800, "h": 600, "title": "Login"}, "selection": []},
                stream=stream_json({"answer": "A login flow.", "ideas": ["Add an error state", "  ", "Second idea"], "shapes": []}),
            )
        ],
        rows=[chat_row("chat_sketch", scope="sketch", scope_id="sk_1")],
    ),
    Case(
        "docs",
        [turn("docs:pg-1", "docs-summarise", {"page_id": "pg-1", "language": "English (US)"}, feature="docs", stream=stream_json({"text": "Short.", "title": "API"}))],
        teams=[{"name": "A first"}, {"name": "B docs", "model": "sonnet", "effort": "low"}],
        rows=[DocsAiSettings(project_id="p-docs", enabled=True, member_id="p-docs-team1", updated_at=STAMP)],
    ),
    Case(
        "docs_paused",
        [turn("docs:pg-1", "docs-summarise", {"page_id": "pg-1"}, feature="docs")],
        teams=[{"name": "A first"}, {"name": "B docs", "paused": True}],
        rows=[DocsAiSettings(project_id="p-docs_paused", enabled=True, member_id="p-docs_paused-team1", updated_at=STAMP)],
    ),
    Case(
        "health",
        [
            dict(kind="health", by="An Nguyen", stream=stream_json({"insights": [{"kind": "stuck", "ticket_id": "KAN-1", "title": "KAN-1 has not moved for 6 days", "detail": "In todo since Monday.", "score": 80, "data": {"chip": "Stuck 6d"}}, {"kind": "odd", "title": "No owner", "score": "12.5"}, {"kind": "wip"}, "junk"], "summary": "One ticket is stuck."})),
            dict(kind="health", by="system", stream=stream_json({"insights": [{"kind": "odd", "title": "No owner"}]})),
        ],
    ),
    Case("idea", [turn("idea:IDEA-7", "idea-ask", {"question": "Which ideas overlap?", "idea_id": "IDEA-7", "project_id": "p-idea"}, feature="ideas", stream=stream_json({"answer": "None.", "sources": []}))]),
    Case("editor", [turn("editor:KAN-1", "editor-write", {"action": "improve", "text": "add is brokn\nand slow", "instruction": "Fix the spelling."}, feature="drafting", ticket_id="KAN-1", stream=stream_json({"text": "add() is broken\nand slow"}))]),
    Case("schedule", [turn("schedule:sch-1", "schedule-dry-run", {"prompt": "Plan the weekly tidy-up.", "ticket_id": "KAN-1"}, by="system", feature="schedules", stream=stream_json({"text": "1) Tidy."}))]),
    Case("board", [turn("board:p-board", "board-ask", {"question": "What changed today?"}, schema="plain"), turn("board:p-board", "board-ask", {"question": "Start over."}, schema="plain", fresh=True, depth=2)]),
    Case(
        "schema_given",
        [
            turn("docs:pg-2", "docs-ask", {"question": "Where is the API key kept?"}, schema={"type": "object", "properties": {"answer": {"type": "string"}}, "required": ["answer"]}, stream=stream_json({"answer": "In the keychain."})),
            turn("docs:pg-2", "docs-ask", {"question": "And then?"}, schema={}),
            turn("docs:pg-9", "no-such-skill", {"text": "x"}),
        ],
    ),
    Case("safe_team", [turn("board:p-safe_team", "board-ask", {"question": "Hi"}, schema="plain")], teams=[{"permission_mode": "auto"}]),
    Case(
        "safe_project",
        [turn("board:p-safe_project", "board-ask", {"question": "Hi"}, schema="plain")],
        teams=[{"permission_mode": ""}],
        rows=[AiProjectSettings(project_id="p-safe_project", permission_mode="auto", deny_list=json.dumps(["Bash(npm publish*)", "Read(~/.ssh/**)"]))],
    ),
    Case("account", [turn("board:p-account", "board-ask", {"question": "Hi"}, schema="plain"), turn("board:p-account", "board-ask", {"question": "Again"}, schema="plain")], account=True, repo_files={".mcp.json": MCP_JSON}),
    Case("model", [turn("board:p-model", "board-ask", {"question": "Hi"}, schema="plain")], teams=[{"model": "opus", "effort": "high", "config": json.dumps({"mcp_servers": [{"name": "ignored", "command": "x"}], "disallowed_tools": ["WebFetch"]})}]),
    Case("no_folder", [turn("board:p-no_folder", "board-ask", {"question": "Hi"}, schema="plain")], teams=[{"working_dir": "<ROOT>/cases/no_folder/missing", "model": None}]),
    Case("error_result", [turn("board:p-error_result", "board-ask", {"question": "Hi"}, schema="plain", stream=STREAM_ERROR)]),
    Case("no_result", [turn("board:p-no_result", "board-ask", {"question": "Hi"}, schema="plain", stream=STREAM_NONE)]),
    Case("unicode", [turn("board:p-unicode", "board-ask", {"question": "Việc nào “đang mở”?\nKể cả </board trusted>."}, by="Nguyễn Văn An", schema="plain")], project_name="Dự án “Ω”", teams=[{"name": "Đội Phát triển"}]),
    Case("oneshot", [dict(kind="oneshot", skill="db-fix", inputs={"stop": {"table": "project", "column": "name"}, "previous": None, "question": "Why?"}, stream=stream_json({"cause": "Too small.", "statements": ["ALTER TABLE project ADD COLUMN x TEXT"]})), dict(kind="oneshot", skill="session-summary", inputs={"text": "x"}, by="An Nguyen", model="haiku", stream=STREAM_ERROR)], clear_teams=True),
]


async def new_board():
    """The assistant's settings as a new board has them (a scenario may have switched features off)."""
    async with database.async_session() as session:
        for row in (await session.exec(select(AiAssistSettings))).all():
            await session.delete(row)
        await session.commit()


async def main():
    await database.init_db()
    out["db"] = {}
    for name, scenario in (("settings", settings_scenario), ("receipt", receipt_scenario), ("health", health_scenario)):
        await new_board()
        out["db"][name] = await scenario()
    await new_board()
    out["turns"] = [await build(case) for case in CASES]
    out["blobs"] = blobs
    text = json.dumps(out, ensure_ascii=False, indent=1)
    OUT.write_text(text + "\n", encoding="utf-8")
    print(f"{OUT.name}: {len(out['turns'])} turn cases, {sum(len(c['out']) for c in out['turns'])} calls, {len(blobs)} blobs, {len(text.encode()) // 1024} KB")
    for case in out["turns"]:
        for o in case["out"]:
            if "error" in o["gave"]:
                print("  refused:", case["name"], o["gave"]["error"])
            if not o["launches"] and "error" not in o["gave"]:
                print("  no launch:", case["name"])


asyncio.run(main())
