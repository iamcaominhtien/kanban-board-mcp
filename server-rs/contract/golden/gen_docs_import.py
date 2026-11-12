"""Golden vectors for the Docs import of crates/kb-docs (`src/docs_import/`): what `services.docs_import` answers for
the pure parts (`clean_path`, `split_front_matter` with PyYAML `safe_load`, `parse_file`) and for the import plan
(`build_plan`) over small spaces, so the Rust port gives the same title, body, error line, folder pages, copy names and
link counts.

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_docs_import.py
Writes `docs_import.json` next to this file with `clean_path`, `front_matter`, `parse_file` and `plans`.

A YAML value is written as JSON the way `Yaml::to_json` in the Rust port writes it: a mapping with only string keys is
an object, any other mapping `{"$": "pairs", "items": [[k, v], ...]}`, a float `{"$": "float", "value": repr}`, an
integer beyond 64 bits `{"$": "bigint", "digits": ...}`, a date, datetime, bytes or set `{"$": "timestamp"|"binary"|"set"}`.
A document that makes the loader raise something other than `yaml.YAMLError` (`int("")` of `0x_`) is `{"crash": true}`.
Plans: ids are replaced by titles (`existing` is the title of the page a folder reuses).
"""

import asyncio
import base64
import datetime
import json
import math
import os
import random
import sys
import tempfile
from pathlib import Path

_tmp = tempfile.mkdtemp(prefix="golden-docs-import-")
os.environ["KANBAN_CONFIG_DIR"] = os.path.join(_tmp, "config")
os.environ["KANBAN_DB_PATH"] = os.path.join(_tmp, "kanban.db")
os.environ["KANBAN_LOG_DIR"] = os.path.join(_tmp, "logs")
sys.path.insert(0, os.getcwd())  # run from `server/`

from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlmodel.ext.asyncio.session import AsyncSession  # noqa: E402

from models import ProjectCreate  # noqa: E402
from services import docs, docs_import, projects  # noqa: E402
from tests.fast_db import fresh_db_file  # noqa: E402

OUT = Path(__file__).with_name("docs_import.json")
rng = random.Random(20261112)


def jsonable(v):
    if v is None or isinstance(v, (bool, str)):
        return v
    if isinstance(v, int):
        return v if -(2**63) <= v < 2**63 else {"$": "bigint", "digits": str(v)}
    if isinstance(v, float):
        if math.isnan(v):
            return {"$": "float", "value": "nan"}
        if math.isinf(v):
            return {"$": "float", "value": "inf" if v > 0 else "-inf"}
        return {"$": "float", "value": repr(v)}
    if isinstance(v, (list, tuple)):
        return [jsonable(x) for x in v]
    if isinstance(v, dict):
        if all(isinstance(k, str) for k in v):
            return {k: jsonable(x) for k, x in v.items()}
        return {"$": "pairs", "items": [[jsonable(k), jsonable(x)] for k, x in v.items()]}
    if isinstance(v, (datetime.date, datetime.datetime)):
        return {"$": "timestamp"}
    if isinstance(v, bytes):
        return {"$": "binary"}
    if isinstance(v, (set, frozenset)):
        return {"$": "set"}
    raise TypeError(type(v))


# --- clean_path ------------------------------------------------------------------------------------------------

PATHS = ["a/b.md", "./a//b.md", "a\\b.md", "../x.md", "a/../b.md", "/etc/passwd.md", "", "   ", "a\x00b.md",
         "D:\\x.md", "c:x.md", "a/./b/./c.md", "//a.md", "a/", ".", "..", "./", " a/b.md ", "dir/ sub /x.md", "tiêu đề/trang.md",
         "a\\..\\b.md", "x" * 300 + ".md", "a/b/c/d/e/f.markdown", "\u00a0a.md", "a\u2003/b.md", "1:/a.md", "é:/a.md"]  # fmt: skip

# --- front matter ----------------------------------------------------------------------------------------------

SCALARS = [
    "yes", "Yes", "YES", "no", "No", "NO", "on", "On", "ON", "off", "Off", "OFF", "true", "True", "TRUE", "false",
    "False", "FALSE", "y", "n", "Y", "N", "yEs", "tRUE", "null", "Null", "NULL", "nULL", "~", "", "'quoted'", '"double"',
    "'yes'", '"1"', "'null'", '""', "''", "0", "1", "-1", "+1", "12", "007", "1_000", "0o17", "017", "0x1F", "0X1f",
    "0b101", "08", "09", "0_7", "1:30", "1:30:00", "-1:30", "1:60", "10:5", "1.5", "1.", ".5", "-.5", "+.5", "1e3",
    "1.0e+3", "1.0e3", "1E-3", "1.5E+2", ".inf", "-.inf", "+.inf", ".Inf", ".INF", ".NaN", ".nan", ".NAN", "1_0.5",
    "1:30.5", "190:20:30.15", "2024-01-02", "2024-1-2", "2024-01-02 03:04:05", "2024-01-02T03:04:05Z",
    "2024-01-02 03:04:05.5 +01:00", "2024-01-02 03:04:05 Z", "2024-01-02t03:04:05", "2024-13-45", "2024-01-02x",
    "12345678901234567890123", "-9223372036854775809", "9223372036854775807", "9223372036854775808", "0x7FFFFFFFFFFFFFFFF",
    "!!str 1", "!!int '5'", "!!float 1", "!!bool yes", "!!null x", "!!str", "!!map {a: 1}", "!!seq [1]", "!!binary aGk=",
    "!!set {a, b}", "!!omap [a: 1]", "!!timestamp 2024-01-02", "!!python/object:os.system x", "!foo bar", "!!int x",
    "!!bool maybe", "!!float x", "|\n  literal\n  text", ">\n  folded\n  text", "|-\n  stripped", "|+\n  kept\n\n",
    "[a, b, 1, yes]", "[]", "{}", "{a: 1, b: [x, y]}", "{a: 1, a: 2}", "- a\n  - b", "[a, [b, c], {d: e}]", "[a,]",
    "[a b, c]", "'it''s'", '"tab\\there"', '"\\u00e9\\n"', '"\\x41"', '"bad \\q"', "a b c", "a: b", "a #comment",
    "# comment", "@bad", "`bad", "%bad", "&anchor value", "*alias", "!", "=", "<<", "? x", "- x", "[unclosed", "{unclosed",
    '"unclosed', "'unclosed", "tiêu đề", "Xin chào", "\u00e9", "emoji \U0001f600", "1 2", "1,5", "1_", "_1", "--", "---x",
    "-", ".", "..", "...x", "0.", "00", "0b", "0x", "0b_", "0x_", "0_", "+", "-.", "yes yes", "Yes!", "on-off",
]  # fmt: skip

DOCUMENTS = [
    "", "# only a comment", "\n\n", "title: x", "title: x\n", "# c\ntitle: x", "title:", "title: ~", "title: null",
    "title: 'it''s'", 'title: "tab\\tinside"', "title:\tx", "\ttitle: x", "title: x\n\tauthor: y", "a:\n\tb: 1",
    "title: x\ntitle: y", "title: [unclosed", "title: {a: ", "key: : value", "a: b: c", "title: @bad", "title: `x",
    "%YAML 1.1\ntitle: x", "&a title: x", "*undefined", "title: *x", "title: !foo bar", "title: !!python/object:os.system x",
    "? [a]\n: b", "? a\n: b", "? {a: 1}\n: b", "1: x\ntrue: y\n1.0: z", "<<: {a: 1}\nb: 2", "base: &b {x: 1}\nd:\n  <<: *b\n  y: 2",
    "base: &b {x: 1, y: 1}\nd:\n  <<: *b\n  y: 2", "a: &a {x: 1}\nb: &b {x: 2}\nd:\n  <<: [*a, *b]", "d:\n  <<: 5",
    "d:\n  <<: [1, 2]", "d: &x [1, 2]\ne: *x", "title: x\n---\nb: 2", "title: x\n--- b", "- a\n- b", "just a string", "42", "true",
    "[a, b]", "- title: x", "title: |\n  a\n  b\nauthor: z", "title: >\n  a\n  b\n", "title: x\ntags: [a, b]\ndraft: yes\ndate: 2024-01-02",
    "title: 0x_", "title: 0b_", "title: !!int ''", "title: 1:60", "a:\n  - 1\n  - 2:\n      - x", "a: 1\n b: 2", "a: 1\n  b: 2",
    "a:\n  b: 1\n c: 2", "a: |\n  x\n b", "a: 'x\ny'", 'a: "x\ny"', "a: x\ny", "- a\nb: c", "a: [1,\n  2", "a: {b: 1,\n c: 2}",
    "title: \x07", "title: \u0085x", "title: \ufffe", "title: \ud7ff", "title: \ue000", "tiêu đề: x\ntitle: Xin chào",
    "title: 'Xin chào'\nauthor: \"Nguyễn\"", "title: x # comment", "title: x #notcomment", "title: x:y", "title: x: y",
    "title: - x", "title: [x]\nother: {y: z}", "title: 5\n", "title: 5.0", "title: 1e3", "title: yes", "title: no", "title: 2024-01-02",
    "title: null\nother: 1", "title: ''\nother: 1", "title: '  padded  '", "title: ' '", "Title: x", "'title': x", '"title": y',
    "? title\n: z", "[title, x]", "title: x\n...\nmore", "{title: x}", "{title: x, tags: [a]}", "{title: }", "{title}", "{title: x",
    "title: x\n# end", "\ntitle: x", "  title: x", " title: x\n title2: y", "title: x\n\n\nauthor: y", "a: b\n-c", "key: value\n- item",
    "a: 1\na: 2\na: 3", "1: a\n1.0: b\ntrue: c", "null: a\n~: b", "a: !!str\nb: !!int 1", "a: &x\nb: *x", "a: &x 1\nb: *x\nc: &x 2\nd: *x",
    "a: [&x 1, *x]", "a: *x\n", "&x a: 1", "a:\n- 1\n- 2", "a:\n- b: 1\n  c: 2", "- a: 1\n  b: 2\n- c: 3", "a: -", "a: ?", "a: :",
    "a: ,", "a: [", "a: ]", "a: }", "a: {", "a: |", "a: >", "a: !", "a: &", "a: *", "a: %", "a: @", "a: `", "a: |\n", "a: >-\n\n",
]  # fmt: skip


def front_matter_cases():
    texts = []
    for v in SCALARS:
        texts.append(f"---\ntitle: {v}\n---\nbody")
        texts.append(f"---\nk: {v}\ntitle: t\n---\nbody")
    for d in DOCUMENTS:
        texts.append(f"---\n{d}\n---\nbody")
        texts.append(f"---\n{d}\n...\n\n\nbody\n")
    texts += [
        "no front matter", "---", "---\n", "---\ntitle: x", "--- \ntitle: x\n---\nb", "---\ntitle: x\n--- \nb", "---\ntitle: x\n...\nb",
        "---\n---\nb", "---\n\n---\nb", "---\n...\nb", "-- -\ntitle: x\n---\nb", " ---\ntitle: x\n---\nb", "---\ttitle: x\n---\nb",
        "---\ntitle: x\n---\n\n\n\nb\n", "---\ntitle: x\n---", "---\ntitle: x\n---\n---\nb: 1\n---\nc", "---\u00a0\ntitle: x\n---\nb",
        "---\ntitle: x\n---\u00a0\nb", "---\ntitle: x\n\x1c---\nb", "---\ntitle: x\n---\x1c\nb", "---\r\ntitle: x\r\n---\r\nb",
        "---\ntitle: x\n---\nline\n---\nother: y\n---\n", "\ufeff---\ntitle: x\n---\nb", "---\ntitle: tiêu đề\n---\nnội dung",
    ]  # fmt: skip
    out = []
    for t in texts:
        try:
            meta, body, err = docs_import.split_front_matter(t)
            out.append({"text": t, "meta": jsonable(meta), "body": body, "error_line": err})
        except Exception as exc:  # noqa: BLE001 - a loader failure that is not a YAMLError: nothing catches it
            if type(exc).__module__.startswith("yaml"):
                raise
            out.append({"text": t, "crash": True})
    return out


# --- parse_file ------------------------------------------------------------------------------------------------

LONG = "L" * 250
FILES = [
    ("a.md", "# Alpha\nbody"), ("a.md", "---\ntitle: T\n---\n# Alpha\nbody"), ("a.md", "---\ntitle: Alpha\n---\n# alpha\n\n\nbody"),
    ("a.md", "---\ntitle: Alpha\n---\n# ALPHA\nbody"), ("a.md", "---\ntitle: Straße\n---\n# STRASSE\nbody"),
    ("a.md", "---\ntitle: 5\n---\nbody"), ("a.md", "---\ntitle: 1.5\n---\nbody"), ("a.md", "---\ntitle: yes\n---\nbody"),
    ("a.md", "---\ntitle: no\n---\nbody"), ("a.md", "---\ntitle: 2024-01-02\n---\nbody"), ("a.md", "---\ntitle: [x]\n---\nbody"),
    ("a.md", "---\ntitle: ~\n---\n# From heading\nbody"), ("a.md", "---\ntitle: '  padded  '\n---\nbody"),
    ("a.md", "---\ntitle: ' '\n---\n# Heading\nbody"), ("a.md", "---\ntitle: 1_000\n---\nbody"), ("a.md", "---\ntitle: 0x1F\n---\nb"),
    ("a.md", "---\ntitle: 1:30\n---\nb"), ("a.md", "---\ntitle: .inf\n---\nb"), ("a.md", "---\ntitle: 1e3\n---\nb"),
    ("a.md", "---\ntitle: 12345678901234567890123\n---\nb"), ("a.md", "---\ntitle: 1.0e+20\n---\nb"), ("a.md", "---\ntitle: 0.1\n---\nb"),
    ("a.md", "---\ntitle: -0.0\n---\nb"), ("a.md", "---\ntitle: 1e-05\n---\nb"), ("a.md", "---\ntitle: .5\n---\nb"),
    ("a.md", "---\ntitle: 100000000000000000.0\n---\nb"), ("a.md", "---\ntitle: 1234567.125\n---\nb"),
    ("a.md", "---\ntitle: 0o17\n---\nb"), ("a.md", "---\ntitle: 017\n---\nb"), ("a.md", "---\ntitle: -017\n---\nb"),
    ("a.md", "---\ntitle: 0b101\n---\nb"), ("a.md", "---\ntitle: -0\n---\nb"), ("a.md", "---\ntitle: +5\n---\nb"),
    ("a.md", "---\ntitle: 0x_\n---\nb"), ("a.md", "---\ntitle: 0b_\n---\nb"),
    ("a.md", "---\ntitle: ok\nitems: [unclosed\n---\nbody"), ("a.md", "---\njust a string\n---\nx"), ("a.md", "---\n- a\n- b\n---\nx"),
    ("a.md", "---\nnot closed\nbody"), ("a.md", "---\n---\nbody"), ("a.md", "---\n# comment\n---\n# Heading\nbody"),
    ("a.md", "```\n# not a heading\n```\nbody"), ("a.md", "~~~\n# not a heading\n~~~\n# Real\nbody"), ("a.md", "## Two\n# One\nbody"),
    ("a.md", "#\nbody"), ("a.md", "# \nbody"), ("a.md", "# Title #\nbody"), ("a.md", "# Title ##  \nbody"), ("a.md", "#Title\nbody"),
    ("a.md", "  # Indented\nbody"), ("a.md", "\ufeff# BOM heading\nx"), ("a.md", "# CRLF\r\nline\r\n"), ("a.md", "# CR\rline\r"),
    ("a.md", "text\n\n# Late heading\n\n\nafter"), ("a.md", "# A\n# B\nx"), ("a.md", "# " + LONG + "\nbody"), ("a.md", ""), ("a.md", "\n\n"),
    ("a.md", "---\ntitle: " + LONG + "\n---\nb"), ("long-" + LONG + ".md", "body"), ("a.md", "---\ntitle: tiêu đề\n---\nnội dung"),
    ("NOTES.MD", "x"), ("c.Markdown", "y"), ("c.MARKDOWN", "y"), ("notes.txt", "x"), ("noext", "x"), (".md", "x"), ("a.md.md", "x"),
    ("dir/index.md", "# Idx\nx"), ("dir/INDEX.md", "x"), ("dir/readme.md", "x"), ("dir/README.markdown", "# Home\nx"), ("index.md", "x"),
    ("dir/indexes.md", "x"), ("dir/sub/Index.MD", "---\ntitle: Sub\n---\nx"), ("../evil.md", "x"), ("a/../../evil.md", "x"),
    ("/abs/evil.md", "x"), ("C:/win/evil.md", "x"), ("back\\..\\evil.md", "x"), ("back\\ok.md", "x"), ("./a/./b.MD", "x"),
    ("a b/c d.md", "x"), ("tiêu đề/Trang Chủ.md", "# Chào\nx"), ("Straße.md", "x"), ("ǅ.md", "x"),
]  # fmt: skip
BYTES = [
    ("latin.md", b"caf\xe9 \xff"), ("bom.md", b"\xef\xbb\xbf# Bom\nx"), ("bom2.md", b"\xef\xbb\xbf\xef\xbb\xbf# Bom\nx"),
    ("overlong.md", b"\xc0\xaf"), ("surrogate.md", b"\xed\xa0\x80"), ("nul.md", b"a\x00b"), ("empty.md", b""),
]  # fmt: skip


def parse_file_cases():
    cases = [(p, t.encode("utf-8")) for p, t in FILES] + BYTES
    out = []
    for path, data in cases:
        try:
            e = docs_import.parse_file(0, path, data)
        except Exception as exc:  # noqa: BLE001
            if type(exc).__module__.startswith("yaml"):
                raise
            out.append({"path": path, "data": base64.b64encode(data).decode(), "crash": True})
            continue
        out.append(
            {
                "path": path,
                "data": base64.b64encode(data).decode(),
                "segments": e.segments,
                "title": e.title,
                "explicit_title": e.explicit_title,
                "body": e.body,
                "size": e.size,
                "error": e.error,
                "is_index": e.is_index,
            }
        )
    return out


# --- plans -----------------------------------------------------------------------------------------------------

WORDS = ["alpha", "beta", "gamma", "Delta", "notes", "Notes", "guide", "setup", "api", "Index", "readme", "tiêu đề", "Straße", "STRASSE"]
FOLDERS = ["docs", "guide", "api", "Docs", "docs/deep", "a/b/c", "sub", "x", "Straße", "strasse", "notes", "Notes.md", "index.md"]


def random_files(n):
    files = []
    for _ in range(n):
        depth = rng.choice([0, 0, 1, 1, 2])
        folder = "/".join(rng.sample(FOLDERS, 1)) if depth else ""
        if depth == 2:
            folder += "/" + rng.choice(FOLDERS[:5])
        kind = rng.random()
        if kind < 0.2:
            name = rng.choice(["index", "README", "readme", "Index"]) + rng.choice([".md", ".markdown"])
        else:
            name = rng.choice(WORDS) + str(rng.choice(["", "", "2"])) + rng.choice([".md", ".md", ".markdown", ".txt"])
        path = (folder + "/" if folder else "") + name
        links = " ".join(f"[[{rng.choice(WORDS)}]]" for _ in range(rng.randrange(0, 4)))
        if rng.random() < 0.2:
            links += " [[a/b/Notes]] [[Missing page]] [[Alpha#Sec|label]] KAN-1"
        style = rng.random()
        if style < 0.3:
            text = f"# {rng.choice(WORDS)}\n{links}"
        elif style < 0.5:
            text = f"---\ntitle: {rng.choice(WORDS)}\n---\n{links}"
        elif style < 0.55:
            text = f"---\ntitle: {rng.choice(WORDS)}\nbad: [x\n---\n{links}"
        elif style < 0.6:
            text = f"---\ntitle: {rng.choice(WORDS)}\n---\n# {rng.choice(WORDS)}\n{links}"
        else:
            text = links or "plain"
        files.append((path, text))
    return files


EXISTING = [
    [],
    [("Notes", None)],
    [("Notes", None), ("docs", None), ("Imports", None), ("Taken", "Imports")],
    [("Alpha", None), ("alpha", None), ("Docs", None), ("deep", "Docs"), ("Index", "Docs")],
    [("Straße", None), ("guide", None), ("setup", "guide"), ("Setup", "guide")],
]
FIXED = [
    ([("Notes.md", "a"), ("other/Notes.md", "b"), ("dupe.md", "# Twin\n1"), ("dupe2.md", "# Twin\n2")], 1, None),
    ([("sub/x.md", "x"), ("Taken.md", "t")], 2, "Imports"),
    ([("guides/index.md", "---\ntitle: All guides\n---\nwelcome"), ("guides/README.md", "# Readme heading\nreadme body"), ("guides/one.md", "one"),
      ("solo/README.md", "# Solo home\nhome body"), ("solo/two.md", "two"), ("plain/README.md", "no heading here")], 0, None),
    ([("docs/index.md", "# Docs home\nhi"), ("docs/a.md", "# Alpha\nsee [[Notes]] and [[Nope]] and [[Nope]]"), ("docs/deep/b.markdown", "bee")], 2, None),
    ([("docs/index.md", "idx"), ("docs/INDEX.md", "idx2"), ("docs/readme.md", "r")], 0, None),
    ([("a.md", "# A\nsee [[B]] and [[Missing]]"), ("b.md", "# B\n## Part\nx")], 0, None),
    ([("one.md", "x"), ("One.md", "y"), ("ONE.md", "z")], 3, None),
    ([("x/a.md", "1"), ("x/A.md", "2"), ("X/a.md", "3")], 0, None),
    ([("docs/a.md/x.md", "1"), ("docs/a.md", "2")], 0, None),
    ([("docs/a.md", "2"), ("docs/a.md/x.md", "1")], 0, None),
]


async def plan_cases():
    engine = create_async_engine(fresh_db_file(Path(_tmp) / "g.db"))
    maker = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    out = []
    async with maker() as s:
        p = await projects.create_project(s, ProjectCreate(name="Kanban", prefix="KAN", color="#123456"))
        pid = p.id
        scenarios = []
        for files, ex, parent in FIXED:
            for on_conflict in ("copy", "skip"):
                scenarios.append((ex, parent, on_conflict, files))
        for i in range(90):
            ex = rng.randrange(len(EXISTING))
            parent = rng.choice([None, None, "Imports", "Docs", "guide"]) if EXISTING[ex] else None
            if parent and parent not in {t for t, _ in EXISTING[ex]}:
                parent = None
            scenarios.append((ex, parent, rng.choice(["copy", "skip"]), random_files(rng.randrange(1, 9))))
        scenarios += [(0, None, "overwrite", [("a.md", "x")]), (0, None, "copy", []), (0, None, "copy", [(f"f{n}.md", "x") for n in range(201)]),
                      (0, None, "copy", [(f"f{n}.md", "x") for n in range(200)])]  # fmt: skip
        for ex, parent, on_conflict, files in scenarios:
            # a fresh space for each scenario: the project's pages are removed and made again
            for row in await docs._all_pages(s, pid):
                await s.delete(row)
            await s.commit()
            by_title = {}
            ids = {}
            for title, par in EXISTING[ex]:
                page = await docs.create_page(s, pid, title, parent_id=by_title.get(par), markdown="")
                by_title[title] = page["id"]
                ids[page["id"]] = title
            data = [(path, text.encode("utf-8")) for path, text in files]
            case = {"existing": [list(e) for e in EXISTING[ex]], "parent": parent, "on_conflict": on_conflict, "files": [list(f) for f in files]}
            try:
                entries, nodes, summary = await docs_import.build_plan(
                    s, pid, data, parent_id=by_title.get(parent), on_conflict=on_conflict
                )
            except docs_import.DocsError as e:
                case["error"] = {"status": e.status, "code": e.code, "message": e.message}
                out.append(case)
                continue
            case["entries"] = [
                {
                    "path": e.path, "segments": e.segments, "title": e.title, "explicit_title": e.explicit_title, "body": e.body,
                    "size": e.size, "error": e.error, "messages": e.messages, "skipped": e.skipped, "page_path": e.page_path,
                    "resolved": e.resolved, "unresolved": e.unresolved, "is_index": e.is_index,
                }
                for e in entries
            ]
            case["nodes"] = [
                {
                    "key": list(n.key), "title": n.title, "body": n.body,
                    "parent_key": list(n.parent_key) if n.parent_key else None,
                    "entry": n.entry.index if n.entry is not None else None,
                    "existing": ids.get(n.existing_id) if n.existing_id else None,
                }
                for n in nodes
            ]
            case["summary"] = summary
            case["report"] = [docs_import._file_report(e) for e in entries]
            out.append(case)
    return out


def main():
    paths = [{"raw": p, "segments": docs_import.clean_path(p)} for p in PATHS]
    front = front_matter_cases()
    files = parse_file_cases()
    plans = asyncio.run(plan_cases())
    out = {"clean_path": paths, "front_matter": front, "parse_file": files, "plans": plans}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    crashes = sum(1 for c in front if c.get("crash"))
    errors = sum(1 for c in front if c.get("error_line") is not None)
    print(f"{len(paths)} paths, {len(front)} front matter ({errors} errors, {crashes} crashes), {len(files)} files, {len(plans)} plans, {OUT.stat().st_size} bytes")


main()
