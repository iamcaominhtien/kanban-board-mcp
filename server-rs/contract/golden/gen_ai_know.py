"""Golden vectors for crates/kb-ai-know: the ready-made packs and roles as Python presents them, the files of the
board's plugin folder, the knowledge base's query parser, summaries, keywords and BM25 ranking over a small corpus, the
memory's path and similarity checks, the block of a run's system prompt, text read from PDFs by pypdf, and the plugin
folder builder and switches over a table of cases.

A long text is stored as its SHA-256 (of the UTF-8 bytes) with its length in characters and in bytes; a file as its
name, SHA-256 and size. The Rust tests (`tests/golden_ai_know.rs`) assert equality for every entry.

Run from `server/` with temporary KANBAN_* folders:
    .venv/bin/python ../server-rs/contract/golden/gen_ai_know.py
Writes `ai_know.json` next to this file and the small PDFs of `crates/kb-ai-know/tests/fixtures/`.
"""

import asyncio
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path

_tmp = tempfile.mkdtemp(prefix="golden-ai-know-")
os.environ["KANBAN_CONFIG_DIR"] = os.path.join(_tmp, "config")
os.environ["KANBAN_DB_PATH"] = os.path.join(_tmp, "data", "kanban.db")
os.environ["KANBAN_LOG_DIR"] = os.path.join(_tmp, "logs")
os.environ["CLAUDE_CONFIG_DIR"] = os.path.join(_tmp, "claude-config")
os.environ["KANBAN_AI_KEY_FILE"] = os.path.join(_tmp, "ai.key")
os.environ["HOME"] = os.path.join(_tmp, "home")
sys.path.insert(0, os.getcwd())  # run from `server/`

import database  # noqa: E402
from services.ai import board_skills, kb, knowledge, memory, packs, plugins, roles  # noqa: E402

OUT = Path(__file__).with_name("ai_know.json")
FIXTURES = Path(__file__).resolve().parents[2] / "crates" / "kb-ai-know" / "tests" / "fixtures"
REPO = Path(__file__).resolve().parents[3]


def text(value: str) -> dict:
    data = value.encode("utf-8")
    return {"sha256": hashlib.sha256(data).hexdigest(), "chars": len(value), "bytes": len(data)}


def jtext(value) -> dict:
    """A JSON value as `json.dumps(..., ensure_ascii=False)` writes it."""
    return text(json.dumps(value, ensure_ascii=False))


def files_of(root: Path) -> list:
    out = []
    for p in sorted(root.rglob("*"), key=lambda q: q.parts):
        if p.is_file():
            data = p.read_bytes()
            out.append([str(p.relative_to(root)), hashlib.sha256(data).hexdigest(), len(data)])
    return out


# ---------------------------------------------------------------------------------------------------------------------
# packs and roles
# ---------------------------------------------------------------------------------------------------------------------


def gen_packs() -> dict:
    out: dict = {"builtin_version": packs.BUILTIN_VERSION, "format": packs.FORMAT}
    out["builtin"] = [
        {
            "key": p["key"],
            "fields": list(p),
            "persona": text(p["persona"]),
            "rules": text(packs._rules(p["key"])),
            "whole": jtext(p),
            "rest": jtext({k: v for k, v in p.items() if k != "persona"}),
        }
        for p in packs.BUILTIN
    ]
    out["role_names"] = [
        [k, packs.role_name(k)] for k in [*packs.BUILTIN_KEYS, "custom_role", "my_pack", "", None, "dev (x)"]
    ]
    out["export"] = {p["key"]: jtext(packs.export({**p, "id": f"builtin:{p['key']}", "version": 11})) for p in packs.BUILTIN}
    cleans = [
        {},
        {"name": ""},
        {"name": "   "},
        {"name": "X"},
        {"name": 5},
        {"name": "X", "model": "gpt"},
        {"name": "X", "model": "claude-opus-4"},
        {"name": "X", "model": "opus", "effort": "ultra"},
        {"name": "X", "effort": "max", "junk": 1, "glyph": "XX"},
        {"name": "X", "plugins": "tdd"},
        {"name": "X", "mcp": {"a": 1}},
        {"name": "X", "personas": None, "plugins": None, "mcp": None},
        {"name": "X", "plugins": ["tdd"], "limits": {"max_parallel": 2}},
        {"name": "X", "model": "", "effort": ""},
        {"name": "X", "model": 7},
    ]
    results = []
    for body in cleans:
        try:
            results.append({"body": body, "out": packs.clean(body)})
        except ValueError as exc:
            results.append({"body": body, "error": str(exc)})
    out["clean"] = results
    out["role_from_pack"] = {p["key"]: jtext(roles.role_from_pack(p)) for p in packs.BUILTIN}
    out["catalogue"] = jtext(roles.catalogue())
    out["team_packs"] = jtext(roles.team_packs())
    out["team_pack_roles"] = {k: v["roles"] for k, v in roles.TEAM_PACKS.items()}
    return out


async def gen_roles() -> dict:
    out: dict = {}
    for key in [*roles.TEAM_PACKS, None, "nope"]:
        rs = await roles.roles_for(None, "p", key, {})
        out[str(key)] = {
            "keys": [r["key"] for r in rs],
            "roles": jtext(rs),
            "agents": jtext(roles.agents_json(rs, "Report on the board.")),
            "agents_plain": jtext(roles.agents_json(rs)),
            "markdown": [text(roles.agent_markdown(r)) | {"key": r["key"]} for r in rs],
            "markdown_rules": [text(roles.agent_markdown(r, "Rules.")) | {"key": r["key"]} for r in rs],
            "public": jtext(roles.public(rs)),
        }
    configs = [
        ("bugfix", {"roles": [{"key": "dev", "off": True}]}),
        ("bugfix", {"roles": [{"key": "qa"}, {"key": "custom", "prompt": "Do x.", "model": "opus"}]}),
        ("standard", {"roles": [{"key": "dev", "prompt": "Mine."}, {"key": "reviewer", "off": True}, "junk", {"nokey": 1}]}),
        ("docs", {"roles": [{"key": "tech_writer", "tools": ["Read", "Grep"], "model": "haiku"}, {"key": "tech_writer", "effort": "high"}]}),
        ("full", {"roles": [{"key": "triage"}, {"key": "pm", "off": True}]}),
        ("standard", {"roles": []}),
        ("standard", {"roles": None}),
    ]
    out["configs"] = []
    for key, cfg in configs:
        rs = await roles.roles_for(None, "p", key, cfg)
        out["configs"].append(
            {
                "pack": key,
                "config": cfg,
                "keys": [r["key"] for r in rs],
                "roles": jtext(rs),
                "agents": jtext(roles.agents_json(rs, "R")),
            }
        )
    # an agent with a model, tools and no description
    odd = [{"key": "x", "prompt": "", "model": "opus", "tools": ["Read"], "description": ""}]
    out["odd_agents"] = jtext(roles.agents_json(odd, "Board."))
    out["odd_markdown"] = text(roles.agent_markdown(odd[0], ""))
    out["odd_markdown_unicode"] = text(roles.agent_markdown({"key": "u", "description": "Hỏi “đáp”", "prompt": "P", "model": "m", "tools": ["A", "B"]}, "R"))
    return out


# ---------------------------------------------------------------------------------------------------------------------
# board skills
# ---------------------------------------------------------------------------------------------------------------------


def gen_board_skills() -> dict:
    out: dict = {}
    skills = board_skills._skills()
    out["skills"] = [[name, text(body)] for name, body in skills.items()]
    out["catalog"] = board_skills.catalog()
    full = Path(board_skills.plugin_dir())
    out["full"] = {"folder": full.name, "files": files_of(full)}
    picks = [["canvas-design", "working-a-ticket"], ["slides"], ["role-dev", "role-ba", "docs-pages"], []]
    out["picked"] = []
    for names in picks:
        root = Path(board_skills.plugin_dir(names))
        out["picked"].append({"names": names, "folder": root.name, "files": files_of(root)})
    cases = [
        ({}, None, None),
        ({}, "mem_x", "qa"),
        ({}, "mem_x", None),
        ({}, "x", {"pm", "ba", "dev"}),
        ({}, "t2", {"dev", "reviewer", "qa"}),
        ({}, "t3", {"designer"}),
        ({}, "t4", set()),
        ({}, "t5", "designer"),
        ({"board_skills": [{"skill": "repo-and-machine", "on": False, "members_on": ["dev"]}]}, "designer", None),
        ({"board_skills": [{"skill": "repo-and-machine", "on": False, "members_on": ["dev"]}]}, "dev", None),
        ({"board_skills": [{"skill": "canvas-design", "members_off": ["dev"]}]}, "dev", None),
        ({"board_skills": [{"skill": "canvas-design", "members_off": ["dev"]}]}, "designer", None),
        ({"board_skills": [{"skill": "slides", "on": False}]}, "t1", {"pm"}),
        ({"board_skills": [{"skill": "working-a-ticket", "on": False}]}, "t1", {"pm"}),
        ({"board_skills": [{"skill": "slides", "on": None}, {"skill": "slides", "on": False}, "junk", {"nope": 1}]}, "t1", {"pm", "ba"}),
        ({"board_skills": [{"skill": "keeping-memory", "on": 0, "members_on": ["a"], "members_off": ["b"]}]}, "b", {"dev"}),
        ({"board_skills": [{"skill": "keeping-memory", "on": 0, "members_on": ["a"], "members_off": ["b"]}]}, "a", {"dev"}),
        ({"board_skills": None}, "a", {"dev", "qa", "user_tester"}),
    ]
    out["enabled_for"] = [
        {
            "ops": ops,
            "member": member,
            "role": sorted(role) if isinstance(role, set) else role,
            "role_kind": "set" if isinstance(role, set) else ("str" if isinstance(role, str) else "none"),
            "out": board_skills.enabled_for(ops, member, role),
        }
        for ops, member, role in cases
    ]
    out["craft_roles"] = {k: sorted(v) for k, v in board_skills.CRAFT_ROLES.items()}
    out["always_on"] = board_skills.ALWAYS_ON
    return out


# ---------------------------------------------------------------------------------------------------------------------
# memory
# ---------------------------------------------------------------------------------------------------------------------


def gen_memory() -> dict:
    paths = [
        "Edit `ui/src/App.tsx` and server/models.py; see https://x.io/a/b.py and docs/.",
        "Settings live in server/old_config.py, not in server/models.py.",
        "Run `uv run pytest tests/test_x.py` then (ui/src/).",
        "See www.example.com/a/b.md or http://a.b/c.py",
        "foo@bar.com/x.py and a:b/c.py and ./local/file.rs, ../up/file.go",
        "Use README.md, Makefile, Dockerfile and package.json!",
        "folder/ sub/dir/ and /abs/path/file.txt and ~/home/f.sh",
        "version 1.2.3 and file.name.with.dots.yaml; x.y",
        "ui/src/components/Board.tsx:42 and ui/src/a.ts, ui/src/b.ts.",
        "nothing here",
        "",
        "Vietnamese: thư mục server/dịch/tệp.py và ui/hình/ ở đây",
        "`quoted/path.md` 'single/quoted.md' \"double/quoted.md\"",
        "a/b/c/d/e.json\nnext line docs/guide.md\n",
        "dir/ then.,;:) end/",
        "x/y.TXT and x/y.Py (case)",
        "path/with-dash_and_underscore/file-name_1.toml",
    ]
    out: dict = {"paths_in": [[t, memory.paths_in(t)] for t in paths]}
    pairs = [
        ("Always run the dev server with npm run dev in the foreground.", "Never run the dev server with npm run dev in the foreground."),
        ("The models are in server/models.py.", "Settings live in server/old_config.py, not in server/models.py."),
        ("", "x"),
        ("short", "tiny"),
        ("Use the colour tokens always.", "Use the colour tokens."),
        ("alpha beta gamma delta", "alpha beta epsilon zeta"),
        ("Hỏi đáp tiếng Việt đây", "Hỏi đáp tiếng Việt đó"),
        ("THIS THAT with from", "this that WITH FROM"),
    ]
    out["similarity"] = [[a, b, memory.similarity(a, b)] for a, b in pairs]
    out["negation"] = [
        [t, bool(memory._NEGATION.search(t))]
        for t in ["Never do x", "do not do x", "we don't", "no longer valid", "NOT sure", "knot", "instead of y", "stop it", "avoid", "Not."]
    ]
    out["clean"] = [[t, memory.clean(t)] for t in [None, "", "  a\n b\t c ", "x" * 600, "Hỏi " * 200]]
    out["neg"] = [[s, [ord(c) for c in memory._neg(s)]] for s in [None, "", "2026-01-01T00:00:00+00:00", "ab"]]
    return out


# ---------------------------------------------------------------------------------------------------------------------
# kb
# ---------------------------------------------------------------------------------------------------------------------

BODIES = [
    "Short",
    "# Heading One\n\nThe quick brown fox jumps over the lazy dog. The fox is quick.",
    "   \n\n  ## A second heading that is long enough\nBody text here.",
    "x" * 50,
    "Tôi yêu Việt Nam. Việt Nam là một đất nước xinh đẹp. Đất nước Việt Nam có nhiều núi.",
    "def add(a, b):\n    return a + b\n# a comment that is long enough to count\n",
    "alpha beta beta gamma gamma gamma delta delta delta delta ",
    "the a an and or of to in on for with is are was were be by it this that from as at not no your you we our can will",
    "café déjà-vu naïve résumé façade coöperate",
    "word " * 40,
    "",
    "   ",
    "a-b-c under_score hyphen-ated words_here ab abc abcd",
]
QUERIES = [
    "fox", "quick fox", "brown dog", "", "a", "ab cd", "Việt Nam", "việt", "đất nước", "def add", "x'y", 'say "hello" now',
    "one two three four five six seven eight nine ten eleven twelve thirteen fourteen", "under_score", "hyphen-ated",
    "café", "cafe", "naive", "!!!", "...", "-- --", "NOT fox", "fox AND dog", "fox OR dog", "(fox)", "fox*", "col:fox", "résumé",
]


async def gen_kb() -> dict:
    out: dict = {}
    out["keywords_of"] = [[b, kb.keywords_of(b)] for b in BODIES]
    out["keywords_of_limit"] = [[b, kb.keywords_of(b, 3)] for b in BODIES[:7]]
    out["summary_of"] = [[b, kb.summary_of(b)] for b in BODIES]
    out["fts_query"] = [[q, kb.fts_query(q)] for q in QUERIES]
    out["known_suffix"] = [[n, kb.known_suffix(n)] for n in ["a.PDF", "b.tar.gz", "c.Ts", "d.tsx", "e.sh", "f", "g.json", "h.JPEG", ".md", "x.markdown", None]]
    # a corpus in a database: the FTS5 index, BM25 and the stores
    await database.init_db()
    corpus = [
        # (store, title, body, kind, by, private, source_name)
        ("project", "Release process", "# Release process\nTag the release, build the installer and publish the notes. The release needs a changelog.", "text", "An", False, "release.md"),
        ("project", "Database migrations", "Migrations use alembic. Run alembic upgrade head. Never edit an old migration; add a new revision.", "text", "An", False, "db.md"),
        ("project", "Private note", "The private plan: release the secret feature in the autumn.", "text", "An", True, "plan.md"),
        ("project", "Hướng dẫn cài đặt", "Cài đặt máy chủ bằng Docker. Đăng nhập bằng tài khoản của bạn. Việt Nam.", "text", "Mai", False, None),
        ("project", "server.py", "def release(version):\n    tag = f'v{version}'\n    return tag\n", "code", "Mai", False, "server.py"),
        ("project", "Quick fox", "The quick brown fox. Fox fox fox. " + "filler " * 30, "text", "An", False, None),
        ("shared", "Shared style guide", "Release notes are written in the past tense. Keep the changelog short.", "text", "An", False, "style.md"),
        ("shared", "Shared secret", "Release keys live in the vault.", "text", "Mai", True, "keys.md"),
    ] + [
        # filler documents: with a handful of documents every word is common and BM25 scores all round to zero
        ("project", f"Filler note {i}", f"Lorem ipsum dolor sit amet {i}. Consectetur adipiscing elit sed do eiusmod tempor {i * 7}.", "text", "An", False, None)
        for i in range(24)
    ]
    docs = []
    async with database.async_session() as session:
        for store, title, body, kind, by, private, source in corpus:
            doc = await kb.add(
                session, project_id="P1" if store == "project" else None, store=store, title=title, kind=kind, body=body,
                by=by, source_name=source, private=private,
            )
            docs.append(doc)
        other = await kb.add(session, project_id="P2", store="project", title="Other project release", kind="text", body="Release for the other project.", by="An")
    out["corpus"] = [
        {"store": s, "title": t, "body": b, "kind": k, "by": by, "private": pr, "source_name": sn}
        for s, t, b, k, by, pr, sn in corpus
    ] + [{"store": "project", "project": "P2", "title": "Other project release", "body": "Release for the other project.", "kind": "text", "by": "An", "private": False, "source_name": None}]
    out["docs"] = [
        {
            "title": d.title,
            "summary": d.summary,
            "keywords": json.loads(d.keywords),
            "answers": json.loads(d.answers),
            "described_by": d.described_by,
            "tokens": d.tokens,
        }
        for d in docs
    ]
    titles = {d.id: d.title for d in [*docs, other]}
    searches = []
    async with database.async_session() as session:
        for shared in (False, True):
            if shared:
                from services.ai import ops
                from services.ai.store import get_settings

                settings = await get_settings(session, "P1")
                ops.update(settings, {"knowledge_shared": True})
                session.add(settings)
                await session.commit()
            for q in ["release", "release changelog", "alembic", "Việt Nam", "việt", "fox", "def release", "secret", "vault keys", "nothing matches this", "", "a", 'quote"d', "release OR", "the", "migrations upgrade head", "installer notes"]:
                for person in (None, "An", "Mai"):
                    res = await kb.search(session, "P1", q, person=person)
                    searches.append(
                        {
                            "shared": shared,
                            "q": q,
                            "person": person,
                            "hits": [
                                {"title": titles[r["id"]], "store": r["store"], "kind": r["kind"], "summary": r["summary"], "snippet": r["snippet"], "score": r["score"]}
                                for r in res
                            ],
                        }
                    )
            res = await kb.search(session, "P1", "release", limit=2)
            searches.append({"shared": shared, "q": "release", "person": None, "limit": 2, "hits": [{"title": titles[r["id"]], "score": r["score"]} for r in res]})
            toc = await kb.table_of_contents(session, "P1", person="An")
            searches.append({"shared": shared, "toc": [[titles[r["id"]], r["store"]] for r in toc], "person": "An"})
            toc = await kb.table_of_contents(session, "P1")
            searches.append({"shared": shared, "toc": [[titles[r["id"]], r["store"]] for r in toc], "person": None})
            sh = await kb.shared_store(session, person="Mai")
            searches.append({"shared": shared, "shared_store": [r["title"] for r in sh], "person": "Mai"})
            sh = await kb.shared_store(session)
            searches.append({"shared": shared, "shared_store": [r["title"] for r in sh], "person": None})
    out["searches"] = searches
    # reading: slices, fencing, a document that is not visible
    reads = []
    async with database.async_session() as session:
        by_title = {d.title: d for d in docs}
        for title, start, length, person in [
            ("Release process", 0, 12000, None), ("Release process", 5, 10, None), ("Release process", 10_000, 5, None),
            ("Release process", -20, 15, None), ("Hướng dẫn cài đặt", 3, 12, None), ("Private note", 0, 20, None),
            ("Private note", 0, 20, "An"), ("Shared secret", 0, 5, "Mai"), ("Quick fox", 0, 12000, None),
        ]:
            d = by_title[title]
            try:
                r = await kb.read(session, "P1", d.id, person=person, start=start, length=length)
                reads.append({"title": title, "start": start, "length": length, "person": person, "out": r | {"id": "<id>"}})
            except LookupError as exc:
                reads.append({"title": title, "start": start, "length": length, "person": person, "error": str(exc)})
    out["reads"] = reads
    out["to_dict_keys"] = list(kb.to_dict(docs[0]))
    out["toc_row_keys"] = list(kb._toc_row(docs[0]))
    return out


def gen_pdfs() -> dict:
    FIXTURES.mkdir(parents=True, exist_ok=True)

    def pdf(pages: list[list[str]], name: str) -> None:
        """A PDF by hand: Helvetica, one text block per page."""
        objs: list[bytes] = []
        n_pages = len(pages)
        kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(n_pages))
        objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
        objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {n_pages} >>".encode())
        font_id = 3 + 2 * n_pages
        for i, lines in enumerate(pages):
            content_id = 4 + 2 * i
            objs.append(
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {content_id} 0 R "
                f"/Resources << /Font << /F1 {font_id} 0 R >> >> >>".encode()
            )
            stream = "BT /F1 12 Tf 72 720 Td 16 TL " + " ".join(
                "(" + ln.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") + ") Tj T*" for ln in lines
            ) + " ET"
            objs.append(f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream".encode())
        objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
        body = b"%PDF-1.4\n"
        offsets = []
        for i, o in enumerate(objs, 1):
            offsets.append(len(body))
            body += f"{i} 0 obj\n".encode() + o + b"\nendobj\n"
        xref = len(body)
        body += f"xref\n0 {len(objs) + 1}\n".encode() + b"0000000000 65535 f \n"
        for off in offsets:
            body += f"{off:010d} 00000 n \n".encode()
        body += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
        (FIXTURES / name).write_bytes(body)

    pdf([["Hello from the knowledge base.", "The release needs a changelog."]], "one_page.pdf")
    pdf(
        [["Page one: alembic upgrade head.", "Second line of page one."], ["Page two: the vault keeps the keys.", "Numbers 1 2 3, (brackets) and back\\slash."], []],
        "three_pages.pdf",
    )
    pdf([[]], "blank.pdf")
    (FIXTURES / "broken.pdf").write_bytes(b"%PDF-1.4\nthis is not a pdf at all\n")
    out = {"fixtures": {}, "repo": {}}
    for name in ["one_page.pdf", "three_pages.pdf", "blank.pdf", "broken.pdf"]:
        out["fixtures"][name] = text(kb.pdf_text(str(FIXTURES / name)))
    import re

    for p in sorted((REPO / "docs").rglob("*.pdf")):
        t = kb.pdf_text(str(p))
        # `nospace`: the text without any whitespace: pypdf puts spaces inside words that pdf-extract keeps whole
        out["repo"][str(p.relative_to(REPO))] = {**text(t), "nospace": text(re.sub(r"\s+", "", t))}
    return out


# ---------------------------------------------------------------------------------------------------------------------
# knowledge
# ---------------------------------------------------------------------------------------------------------------------


async def gen_knowledge() -> dict:
    from models import AiLesson, AiMemoryNote, AiProjectKnowledge
    from services.ai import ops
    from services.ai.store import get_settings

    out: dict = {}
    async with database.async_session() as session:
        await knowledge.set_instructions(session, "KP", "  Tests: uv run pytest.  ", by="An")
        await knowledge.set_instructions(session, "KP", "Second text.", by="An")
        for i in range(3):
            await knowledge.add_lesson(session, "KP", f"Lesson {i}: use the tokens   always.", by="An")
        await knowledge.add_lesson(session, "KP", "Proposed only.", by="model", state="proposed")
        lessons = await knowledge.lessons(session, "KP", "kept")
        for i, r in enumerate(lessons):
            r.uses = i
            session.add(r)
        await session.commit()
        await memory.write(session, "KP", "role", "dev", "Run npm test first.", by="Dev An")
        await memory.write(session, "KP", "role", "dev", "A person said: use tabs.", by="An", kind="feedback")
        await memory.write(session, "KP", "ticket", "KP-1", "The bug needs two tabs.", by="Dev An")
        await memory.write(session, "KP", "member", "mem_1", "Own member note.", by="Dev An")
        cases = [
            {"role": "dev", "member_id": "mem_1", "ticket_id": "KP-1"},
            {"role": None, "member_id": "mem_1", "ticket_id": None},
            {"role": "dev", "member_id": None, "ticket_id": "KP-1"},
            {"role": "dev", "member_id": "mem_1", "ticket_id": "KP-1", "notes_on": False},
            {},
        ]
        out["blocks"] = []
        for kw in cases:
            kw = dict(kw)
            notes_on = kw.pop("notes_on", True)
            block, used = await knowledge.block_for(session, "KP", notes_on=notes_on, **kw)
            used_norm = json.loads(json.dumps(used))
            # ids are random: replace them by their position
            lesson_ids = {r.id: f"<lesson:{r.text[:8]}>" for r in await knowledge.lessons(session, "KP")}
            note_ids = {n.id: f"<note:{n.text[:8]}>" for n in await memory.notes(session, "KP")}
            for k, v in {**lesson_ids, **note_ids}.items():
                block = block.replace(k, v)
                used_norm = json.loads(json.dumps(used_norm).replace(k, v))
            out["blocks"].append({"args": {**kw, "notes_on": notes_on}, "block": block, "used": used_norm})
        out["prompt_block"] = (await knowledge.prompt_block(session, "KP")).replace(
            "", ""
        )
        settings = await get_settings(session, "KP")
        ops.update(settings, {"lessons_in_prompt": 2})
        session.add(settings)
        await session.commit()
        block, used = await knowledge.block_for(session, "KP")
        out["capped"] = {"lessons": [x["text"] for x in used["lessons"]], "tokens": used["tokens"]}
        row = await session.get(AiProjectKnowledge, "KP")
        out["history"] = [h["text"] for h in json.loads(row.history)]
        _ = AiLesson, AiMemoryNote
    records = [
        {"k": "event", "e": {"type": "assistant", "message": {"content": [{"type": "text", "text": "I will run the tests " * 30}, {"type": "tool_use", "name": "Bash", "input": {"command": "npm test"}}, {"type": "tool_use", "name": "Read", "input": {"file_path": "/a/b.py"}}, {"type": "tool_use", "name": "Grep", "input": {"pattern": "x" * 300}}, {"type": "tool_use", "name": "Odd", "input": {}}, {"type": "tool_use", "input": None}, "junk", {"type": "text", "text": ""}]}}},
        {"k": "event", "e": {"type": "user", "message": {"content": [{"type": "text", "text": "ignored: not an assistant"}, {"type": "tool_result", "is_error": True, "content": "watch mode never ends"}, {"type": "tool_result", "is_error": True, "content": [{"text": "one"}, {"text": "two"}, {"nope": 1}, "x"]}, {"type": "tool_result", "is_error": True, "content": None}, {"type": "tool_result", "is_error": False, "content": "fine"}, {"type": "tool_result", "is_error": True, "content": {"a": [1, "é"]}}]}}},
        {"k": "note", "text": "Stopped `npm run dev`"},
        {"k": "note"},
        {"k": "event", "e": "not a dict"},
        {"k": "other", "e": {}},
        {"k": "event", "e": {"type": "assistant", "message": {"content": "just text"}}},
    ]
    out["digest"] = [
        {"limit": limit, "out": knowledge.digest(records, limit) if limit else knowledge.digest(records)}
        for limit in (0, 12000, 200, 50)
    ]
    out["digest_records"] = records
    return out


# ---------------------------------------------------------------------------------------------------------------------
# plugins
# ---------------------------------------------------------------------------------------------------------------------


def skill(name: str, body: str = "Body.") -> str:
    return f"---\nname: {name}\ndescription: Use {name}.\n---\n\n{body}\n"


# layouts: {"files": {path: text}, "links": {path: target}, call kwargs, "kind"}
LAYOUTS = [
    {"id": "root-plugin", "files": {".claude-plugin/plugin.json": json.dumps({"name": "My Plugin", "version": "1.2", "description": "Does things."}), "skills/a/SKILL.md": skill("a"), "skills/b/SKILL.md": skill("b"), "README.md": "hi", "hooks/hooks.json": json.dumps({"hooks": {"PreToolUse": [{}, {}], "Stop": [{}]}}), ".mcp.json": json.dumps({"mcpServers": {"x": {}, "y": {}}}), "node_modules/dep/SKILL.md": skill("dep"), ".git/config": "x", "pkg/__pycache__/x.pyc": "x"}},
    {"id": "root-plugin-skills-filter", "files": {".claude-plugin/plugin.json": json.dumps({"name": "root"}), "skills/a/SKILL.md": skill("a"), "skills/b/SKILL.md": skill("b")}, "skills": ["b"]},
    {"id": "root-plugin-two-skills", "files": {".claude-plugin/plugin.json": json.dumps({"name": "root"}), "skills/a/SKILL.md": skill("a"), "skills/b/SKILL.md": skill("b")}, "skills": ["a", "b"]},
    {"id": "root-plugin-no-match", "files": {".claude-plugin/plugin.json": json.dumps({"name": "root"}), "skills/a/SKILL.md": skill("a")}, "skills": ["zzz", "yyy"]},
    {"id": "market-choices", "files": {".claude-plugin/marketplace.json": json.dumps({"plugins": [{"name": "one", "description": "First"}, {"name": "two"}]})}},
    {"id": "market-folder", "files": {".claude-plugin/marketplace.json": json.dumps({"plugins": [{"name": "design", "source": "./design", "version": "2.0", "description": "Design plugin"}, {"name": "other", "source": "./other"}]}), "design/.claude-plugin/plugin.json": json.dumps({"name": "design", "version": "2.1"}), "design/skills/crit/SKILL.md": skill("crit"), "other/skills/o/SKILL.md": skill("o")}, "plugin": "design"},
    {"id": "market-folder-no-manifest", "files": {".claude-plugin/marketplace.json": json.dumps({"plugins": [{"name": "d", "source": "./d", "description": "D"}]}), "d/skills/x/SKILL.md": skill("x"), "d/skills/y/SKILL.md": skill("y")}, "plugin": "d"},
    {"id": "market-skill-list", "files": {".claude-plugin/marketplace.json": json.dumps({"plugins": [{"name": "example-skills", "source": "./", "skills": ["./skills/frontend-design", "./skills/canvas-design"]}]}), "skills/frontend-design/SKILL.md": skill("frontend-design"), "skills/frontend-design/extra.txt": "e", "skills/canvas-design/SKILL.md": skill("canvas-design"), "skills/other/SKILL.md": skill("other")}, "plugin": "example-skills", "skills": ["frontend-design"]},
    {"id": "market-skill-list-all", "files": {".claude-plugin/marketplace.json": json.dumps({"plugins": [{"name": "example-skills", "source": "./", "skills": ["./skills/frontend-design", "./skills/canvas-design"]}]}), "skills/frontend-design/SKILL.md": skill("frontend-design"), "skills/canvas-design/SKILL.md": skill("canvas-design")}, "plugin": "example-skills"},
    {"id": "market-no-such-plugin", "files": {".claude-plugin/marketplace.json": json.dumps({"plugins": [{"name": "one"}, {"description": "nameless"}, {"name": "two"}]})}, "plugin": "three"},
    {"id": "market-long-names", "files": {".claude-plugin/marketplace.json": json.dumps({"plugins": [{"name": "n" * 90}, {"name": "m" * 90}, {"name": "o" * 90}]})}, "plugin": "three"},
    {"id": "market-other-repo", "files": {".claude-plugin/marketplace.json": json.dumps({"plugins": [{"name": "far", "source": {"source": "github", "url": "https://x/y"}}, {"name": "far2", "source": {"source": "github"}}]})}, "plugin": "far"},
    {"id": "market-other-repo-no-url", "files": {".claude-plugin/marketplace.json": json.dumps({"plugins": [{"name": "far2", "source": {"source": "github"}}]})}, "plugin": "far2"},
    {"id": "market-bad-source", "files": {".claude-plugin/marketplace.json": json.dumps({"plugins": [{"name": "p", "source": 5}]})}, "plugin": "p"},
    {"id": "market-outside", "files": {".claude-plugin/marketplace.json": json.dumps({"plugins": [{"name": "p", "source": "../elsewhere"}]})}, "plugin": "p"},
    {"id": "market-outside-skill", "files": {".claude-plugin/marketplace.json": json.dumps({"plugins": [{"name": "p", "source": "./", "skills": ["../x"]}]})}, "plugin": "p"},
    {"id": "market-skill-not-text", "files": {".claude-plugin/marketplace.json": json.dumps({"plugins": [{"name": "p", "source": "./", "skills": [5]}]})}, "plugin": "p"},
    {"id": "skills-folder", "files": {"skills/one/SKILL.md": skill("one"), "skills/two/SKILL.md": skill("two"), "skills/two/refs/doc.md": "doc"}},
    {"id": "single-skill", "files": {"SKILL.md": skill("My Fancy_Skill!", "single"), "notes.txt": "n"}},
    {"id": "single-skill-no-front-matter", "files": {"SKILL.md": "no front matter\nname: nope\n"}},
    {"id": "single-skill-quoted", "files": {"SKILL.md": "---\nname: \"Quoted Name\"\n---\nx\n"}},
    {"id": "single-skill-name-hint", "files": {"SKILL.md": "---\ndescription: d\n---\nx\n"}, "name_hint": "hinted-name"},
    {"id": "nothing", "files": {"README.md": "x"}},
    {"id": "empty-manifest", "files": {".claude-plugin/plugin.json": "{}", "skills/a/SKILL.md": skill("a")}, "name_hint": "hint"},
    {"id": "bad-manifest-json", "files": {".claude-plugin/plugin.json": "{not json", "skills/a/SKILL.md": skill("a")}},
    {"id": "hint-name-slug", "files": {"skills/a/SKILL.md": skill("a")}, "name_hint": "Some_Owner/Repo Name"},
    {"id": "link-inside-file", "files": {".claude-plugin/plugin.json": json.dumps({"name": "lnk"}), "shared/data.txt": "data", "skills/a/SKILL.md": skill("a")}, "links": {"skills/a/data.txt": "../../shared/data.txt"}},
    {"id": "link-inside-dir", "files": {".claude-plugin/plugin.json": json.dumps({"name": "lnk"}), "shared/dir/f.txt": "data", "skills/a/SKILL.md": skill("a")}, "links": {"skills/a/dir": "../../shared/dir"}},
    {"id": "link-out", "files": {".claude-plugin/plugin.json": json.dumps({"name": "lnk"}), "skills/a/SKILL.md": skill("a")}, "links": {"skills/a/key": "/etc/hostname"}},
    {"id": "link-to-parent", "files": {".claude-plugin/plugin.json": json.dumps({"name": "lnk"}), "skills/a/SKILL.md": skill("a")}, "links": {"skills/a/loop": ".."}},
    {"id": "link-up-out", "files": {".claude-plugin/plugin.json": json.dumps({"name": "lnk"}), "skills/a/SKILL.md": skill("a")}, "links": {"skills/a/up": "../../../.."}},
    {"id": "hooks-bad", "files": {".claude-plugin/plugin.json": json.dumps({"name": "h"}), "hooks/hooks.json": "{nope", ".mcp.json": "[1,2"}},
    {"id": "hooks-empty", "files": {".claude-plugin/plugin.json": json.dumps({"name": "h"}), "hooks/hooks.json": json.dumps({"hooks": None}), ".mcp.json": json.dumps({"mcpServers": None})}},
    {"id": "unicode", "files": {".claude-plugin/plugin.json": json.dumps({"name": "Plugin Việt", "description": "Mô tả"}, ensure_ascii=False), "skills/việt/SKILL.md": skill("việt", "Nội dung.")}},
    {"id": "market-plugin-in-dir-with-skills", "files": {".claude-plugin/marketplace.json": json.dumps({"plugins": [{"name": "d", "source": "./pl"}]}), "pl/skills/s/SKILL.md": skill("s"), "pl/other.txt": "o"}, "plugin": "d"},
    {"id": "plugin-arg-without-market", "files": {".claude-plugin/plugin.json": json.dumps({"name": "root"}), "skills/a/SKILL.md": skill("a")}, "plugin": "whatever"},
    {"id": "market-root-manifest-wins-without-plugin-arg", "files": {".claude-plugin/plugin.json": json.dumps({"name": "root"}), ".claude-plugin/marketplace.json": json.dumps({"plugins": [{"name": "x"}]}), "skills/a/SKILL.md": skill("a")}},
]


def materialize(layout: dict, root: Path) -> None:
    for rel, body in layout["files"].items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body, encoding="utf-8", newline="")
    for rel, target in layout.get("links", {}).items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(target, p)


def gen_plugins() -> dict:
    out: dict = {}
    out["catalogue"] = [
        {"key": e["key"], "keys": list(e), "whole": jtext(e)} for e in plugins.CATALOGUE
    ]
    out["catalogue_all"] = jtext(plugins.CATALOGUE)
    out["source_name"] = [
        [s, plugins.source_name(s)]
        for s in [
            "https://github.com/anthropics/skills", "https://github.com/emilkowalski/skills.git", "https://github.com/a/b/",
            "git@github.com:me/plugins.git", "plugin", "", "/", "/tmp/folder/", "https://x.io/Skills", "skills", "a:skills",
            "https://github.com/anthropics/knowledge-work-plugins", "C:/x/Agent-Skills.git", ":a:b", "x.git.git",
        ]
    ]
    cases = []
    for layout in LAYOUTS:
        with tempfile.TemporaryDirectory(prefix="gen-plug-") as tmp:
            checkout = Path(tmp) / "checkout"
            checkout.mkdir()
            materialize(layout, checkout)
            into = Path(tmp) / "built"
            kwargs = {k: layout[k] for k in ("plugin", "skills", "name_hint") if k in layout}
            try:
                info = plugins.build(checkout, into=into, **kwargs)
                res: dict = {"info": info}
                res["built"] = files_of(into) if into.exists() else None
            except plugins.PluginError as exc:
                res = {"error": str(exc).replace(str(checkout), "<checkout>")}
        cases.append(
            {
                "id": layout["id"],
                "layout": layout["files"],
                "links": layout.get("links", {}),
                "plugin": layout.get("plugin"),
                "skills": layout.get("skills"),
                "name_hint": layout.get("name_hint"),
                **res,
            }
        )
    out["build"] = cases
    # on_for over a table
    def team(id_, config=None):
        from models import AiTeam

        return AiTeam(id=id_, project_id="p", provider="claude-code", config=json.dumps(config) if config is not None else "{}")

    def row(**kw):
        from models import AiPlugin

        base = {"project_id": "p", "name": "n", "source": "s"}
        for k in ("members", "roles", "skills", "previous"):
            if k in kw and not isinstance(kw[k], str):
                kw[k] = json.dumps(kw[k])
        return AiPlugin(**{**base, **kw})

    on_cases = []
    teams = {
        "t1": team("t1", {"role": "dev"}),
        "t2": team("t2", {"pack": {"key": "designer"}}),
        "t3": team("t3", {}),
        "t4": team("t4", {"role": "", "pack": {"key": "qa"}}),
        "t5": team("t5", {"role": "pm", "pack": {"key": "qa"}}),
    }
    rows = {
        "plain": row(),
        "dev-only": row(roles=["dev"]),
        "designer-only": row(roles=["designer"]),
        "default": row(default_on=True),
        "t1-off": row(roles=["dev"], members={"t1": False}),
        "t1-on": row(roles=[], members={"t1": True}),
        "default-but-off": row(default_on=True, members={"t1": 0}),
        "bad-members": row(roles=["dev"], members="not json"),
        "roles-null": row(roles="null"),
        "roles-pm-qa": row(roles=["pm", "qa"]),
    }
    role_sets = [None, set(), {"dev"}, {"designer", "qa"}, {"pm"}]
    for rk, r in rows.items():
        for tk, t in teams.items():
            for rs in role_sets:
                on_cases.append(
                    {
                        "row": rk,
                        "team": tk,
                        "role_keys": sorted(rs) if rs is not None else None,
                        "out": plugins.on_for(r, t, rs),
                    }
                )
    out["on_for"] = {
        "rows": {
            k: {
                "default_on": r.default_on,
                "roles": r.roles,
                "members": r.members,
            }
            for k, r in rows.items()
        },
        "teams": {k: {"id": t.id, "config": t.config} for k, t in teams.items()},
        "cases": on_cases,
    }
    out["role_of"] = [[k, plugins.role_of(t)] for k, t in teams.items()]
    entries = [
        row(source="https://github.com/anthropics/knowledge-work-plugins", plugin="design", skills=["design-critique", "other"]),
        row(source="https://github.com/anthropics/knowledge-work-plugins/", plugin="design", skills=["nothing"]),
        row(source="https://github.com/anthropics/knowledge-work-plugins.git", plugin="design", skills=["accessibility-review"]),
        row(source="HTTPS://GitHub.com/Anthropics/Skills", plugin="example-skills", skills=["frontend-design"]),
        row(source="https://github.com/anthropics/skills", plugin="example-skills", skills=["canvas-design", "x"]),
        row(source="https://github.com/anthropics/skills", plugin=None, skills=["frontend-design"]),
        row(source="https://github.com/anthropics/skills", plugin="other", skills=["frontend-design"]),
        row(source="https://github.com/nextlevelbuilder/ui-ux-pro-max-skill", plugin="ui-ux-pro-max", skills=["ui-ux-pro-max"]),
        row(source="https://github.com/Leonxlnx/taste-skill", plugin=None, skills=[]),
        row(source="https://github.com/Leonxlnx/taste-skill", plugin="taste-skill", skills="bad"),
        row(source="  https://github.com/iamcaominhtien/flow  ", plugin="flow", skills=["flow-skill"]),
        row(source="https://example.com/unknown", plugin=None, skills=[]),
        row(source="https://github.com/greensock/gsap-skills", plugin="gsap-skills", skills=["a"]),
        row(source="https://github.com/emilkowalski/skills", plugin=None, skills=["animate"]),
        row(source="https://github.com/emilkowalski/skills", plugin=None, skills=["unrelated"]),
    ]
    out["catalogue_entry_for"] = [
        {
            "source": r.source,
            "plugin": r.plugin,
            "skills": r.skills,
            "key": (plugins.catalogue_entry_for(r) or {}).get("key"),
        }
        for r in entries
    ]
    out["to_dict"] = [
        {
            "row": {"members": r.members, "roles": r.roles, "skills": r.skills, "previous": r.previous, "hooks": 2, "mcp": 1, "size_bytes": 5, "pinned": True, "default_on": False},
            "used": used,
            "out": {k: v for k, v in plugins.to_dict(r, used).items() if k not in ("id", "installed_at", "updated_at")},
        }
        for r, used in [
            (row(members={"a": True, "b": False}, roles=["dev"], skills=["s1", "s2"], previous='{"path":"x"}', hooks=2, mcp=1, size_bytes=5, pinned=True), None),
            (row(members={}, roles=[], skills=[], previous=None, hooks=2, mcp=1, size_bytes=5, pinned=True), {"uses": 3, "by_member": {"a": 2, "b": 1}, "last": "2026-01-01"}),
            (row(members="{}", roles="[]", skills="[]", previous="{}", hooks=2, mcp=1, size_bytes=5, pinned=True), {"uses": 0, "by_member": {}, "last": None}),
        ]
    ]
    return out


async def main() -> None:
    out = {
        "packs": gen_packs(),
        "roles": await gen_roles(),
        "board_skills": gen_board_skills(),
        "memory": gen_memory(),
        "kb": await gen_kb(),
        "pdf": gen_pdfs(),
        "knowledge": await gen_knowledge(),
        "plugins": gen_plugins(),
    }
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(OUT, OUT.stat().st_size)


asyncio.run(main())
