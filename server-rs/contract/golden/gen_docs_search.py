"""Golden vectors for the Docs search of crates/kb-docs (`src/docs_search/`): a corpus of pages in English and
Vietnamese, a few hundred queries (words, phrases, exclusions, typos, diacritics, filters, scopes) and what
`services.docs_search.search` and `similar` answer for each, on the FTS5 path and on the scan path (FTS switched off).

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_docs_search.py
Writes `docs_search.json` next to this file: the corpus (`projects`, `members`, `pages` in creation order, `tickets`)
and `queries` (`q`, `params`, `fts`, and `scan` only where it differs from `fts`), `similar`.

Normalization: ids are replaced by `<p:Title>` / `<project:Name>`, and `took_ms` and `updated_at` are dropped (the
Rust test builds the same corpus with its own ids and times). A parameter value `@Title` stands for that page's id.
`extractOne` is handed a `set` of words by the Python code, so a tie is broken by hash order there; the run is made
with the words sorted (what the Rust port does), and the sorted order is noted in the Rust source.
"""

import asyncio
import json
import os
import random
import sys
import tempfile
import unicodedata
from pathlib import Path

_tmp = tempfile.mkdtemp(prefix="golden-docs-search-")
os.environ["KANBAN_CONFIG_DIR"] = os.path.join(_tmp, "config")
os.environ["KANBAN_DB_PATH"] = os.path.join(_tmp, "kanban.db")
os.environ["KANBAN_LOG_DIR"] = os.path.join(_tmp, "logs")
sys.path.insert(0, os.getcwd())  # run from `server/`

from rapidfuzz import process  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlmodel.ext.asyncio.session import AsyncSession  # noqa: E402

from models import Member, ProjectCreate  # noqa: E402
from services import activity, docs, docs_search, projects  # noqa: E402
from services import tickets as svc_tickets  # noqa: E402
from tests.fast_db import fresh_db_file  # noqa: E402

OUT = Path(__file__).with_name("docs_search.json")
rng = random.Random(20261112)

KANBAN = "Kanban"
OTHER = "Other board"

# (title, parent title, markdown, published, author)
PAGES = [
    ("Handbook", None, "## Welcome\nThis handbook explains how the team works.\n\n## Tools\nWe use the board, the wiki and chat.", True, "user"),
    ("Getting started", "Handbook", "## Install\nRun the installer, then open the board.\n\n## First ticket\nCreate a ticket and drag it across the columns.", True, "user"),
    ("Rate limiting", None, "## Overview\nRate limiting protects the API from abusive clients.\n\n## Limits\n100 requests per minute per token.\n\n```text\nrate limit not a heading\n```", True, "user"),
    ("Authentication", None, "## Tokens\nBearer tokens expire hourly. Refresh them with the refresh endpoint.\n\n## Passwords\nPasswords are hashed with argon2.", True, "Mai"),
    ("Deployment", "Handbook", "## Docker\nBuild the image and push it. Deploy with docker compose.\n\n## Rollback\nRoll back by redeploying the previous image.", True, "user"),
    ("Release notes", None, "## v1.2.0\n- Dark mode toggle\n- Faster search\n\n## v1.1.0\n- Export as CSV", True, "user"),
    ("Hướng dẫn cài đặt", None, "## Cài đặt\nChạy trình cài đặt rồi mở bảng Kanban.\n\n## Đăng nhập\nĐăng nhập bằng tài khoản của bạn.", True, "user"),
    ("Tìm kiếm", "Hướng dẫn cài đặt", "## Tìm kiếm mờ\nTìm kiếm các thẻ công việc theo tiêu đề và mô tả.\n\n## Bộ lọc\nLọc theo trạng thái và người phụ trách.", True, "Mai"),
    ("Quy trình triển khai", None, "## Máy chủ\nTriển khai máy chủ bằng Docker.\n\n## Kiểm tra\nKiểm tra nhật ký sau khi triển khai.", True, "user"),
    ("Đăng nhập và mật khẩu", None, "## Quên mật khẩu\nNếu quên mật khẩu, hãy dùng liên kết đặt lại.\n\n## Lỗi thường gặp\nSai mật khẩu không báo lỗi trên điện thoại.", True, "user"),
    ("Café menu", None, "## Déjà vu\nauthentication flows and café au lait.\n\n## Crème brûlée\nA dessert with caramel.", True, "user"),
    ("Straße und Maße", None, "## Größe\nDie Straße ist groß. STRASSE equals straße.\n\n## Fuß\nZu Fuß gehen.", True, "user"),
    ("API reference", None, "## Endpoints\n| Method | Path |\n|---|---|\n| GET | /tickets |\n\n## Errors\n401 when the token is missing. See [[Authentication]].", True, "user"),
    ("Errors and retries", "API reference", "## Retry\nRetry with exponential backoff. max-retries is 3.\n\n## E-mail\nSend an e-mail on failure.", True, "user"),
    ("Roadmap", None, "## Q1\nShip search and rate limiting. Tracks KAN-1 and KAN-2.\n\n## Q2\nMobile app.", True, "user"),
    ("Meeting notes 2026-01", None, "## Agenda\nRoadmap, risks and blockers.\n\n## Decisions\nWe keep the weekly sync.", True, "user"),
    ("Security checklist", "Handbook", "## Secrets\nNever commit secrets. Rotate tokens.\n\n## Review\nEvery change is reviewed. See [[Rate limiting#Limits]].", True, "user"),
    ("Data model", None, "## Fields\nA ticket has a title, a description and tags.\n\n## Relations\nTickets link to pages.", True, "user"),
    ("Onboarding", "Handbook", "## Week one\nMeet the team and read the handbook.\n\n## Week two\nPick a first ticket. See [[Getting started]].", True, "Mai"),
    ("FAQ", None, "## Why is it slow?\nCheck the index and the cache.\n\n## Where are the logs?\nIn the logs folder.", True, "user"),
    ("Glossary", None, "## Board\nA set of columns.\n\n## Ticket\nA unit of work.\n\n## Wiki\nThis space.", True, "user"),
    ("Performance", None, "## Cache\nThe cache stores search results for a minute.\n\n## Index\nThe search index is rebuilt on publish.", True, "user"),
    ("Mobile app", "Roadmap", "## Goals\nPush notifications and offline mode.\n\n## Risks\nStore review times.", True, "user"),
    ("Dark mode", "Release notes", "## Toggle\nThe toggle lives in the settings page.\n\n## Colors\nContrast follows WCAG.", True, "user"),
    ("Settings page", None, "## Language\nPick a language.\n\n## Theme\nLight, dark or system.", True, "user"),
    ("CSV export", "Release notes", "## Columns\nId, title, status, assignee.\n\n## Limits\nOne month at a time.", True, "user"),
    ("Draft: pricing", None, "## Plans\nFree and team plans. Pricing is not final.", False, "user"),
    ("Draft: capybara notes", None, "## Animals\nThe capybara is the largest rodent.", False, "Mai"),
    ("Draft: Kế hoạch", None, "## Mục tiêu\nMục tiêu quý này là tìm kiếm nhanh hơn.", False, "user"),
    ("Backups", "Deployment", "## Schedule\nNightly backups at 02:00.\n\n## Restore\nRestore from the latest backup.", True, "user"),
    ("Monitoring", "Deployment", "## Alerts\nAlerts go to chat when the error rate is high.\n\n## Dashboards\nOne dashboard per service.", True, "user"),
    ("Webhooks", "API reference", "## Events\nTicket created, updated, deleted.\n\n## Signing\nEach payload is signed.", True, "user"),
    ("Thanh toán", None, "## Hóa đơn\nHóa đơn được gửi hàng tháng.\n\n## Thẻ\nThanh toán bằng thẻ.", True, "user"),
    ("Chế độ tối", None, "## Bật chế độ tối\nBật chế độ tối trong trang cài đặt.", True, "user"),
    ("Nhắc việc", None, "## Nhắc uống nước\nNhắc uống nước mỗi giờ.\n\n## Nhắc họp\nNhắc họp trước mười phút.", True, "user"),
    ("Contributing", None, "## Pull requests\nOpen a pull request against main. Squash on merge.\n\n## Style\nFormat before you push.", True, "user"),
    ("Architecture", None, "## Server\nA single process serves the API.\n\n## Database\nSQLite by default, PostgreSQL optional.", True, "user"),
    ("Search design", "Architecture", "## Index\nTitle outranks headings, headings outrank body.\n\n## Fallback\nWithout FTS5 the pages are scanned.", True, "user"),
]
OTHER_PAGES = [
    ("Other limits", None, "## X\nrate limiting elsewhere", True, "user"),
    ("Pricing", None, "## Plans\nPlans and limits for customers.", True, "user"),
    ("Hướng dẫn khác", None, "## Mở đầu\nHướng dẫn cho bảng khác.", True, "user"),
]
TICKETS = [
    (KANBAN, "Fix rate limiting bug", "the limiter breaks under load"),
    (KANBAN, "Search by title", "Tìm kiếm theo tiêu đề"),
    (KANBAN, "Dark mode toggle", "add a toggle to the settings page"),
    (KANBAN, "Sửa lỗi đăng nhập", "Đăng nhập sai mật khẩu không báo lỗi"),
    (KANBAN, "Export CSV", "Export one month as CSV"),
    (OTHER, "Rate card", "pricing"),
]
SLUGS = ["getting-start", "rate-limit", "xqzv", "auth", "deploy", "ke-hoach", "huong-dan", "tim-kiem", "faq", "straße",
         "architecture/search", "settings_page", "", "  /x/  ", "Getting Started", "dark", "mobile-app", "cafe"]  # fmt: skip

STOP = {"the", "a", "of", "to", "and", "in", "is", "for", "on", "with", "an", "or", "by", "as", "at", "it", "we", "be"}


def strip_marks(text: str) -> str:
    out = unicodedata.normalize("NFD", text)
    out = "".join(c for c in out if not unicodedata.combining(c))
    return out.replace("đ", "d").replace("Đ", "D")


def typo(word: str) -> str:
    if len(word) < 4:
        return word + word[-1]
    i = rng.randrange(1, len(word) - 1)
    kind = rng.choice(["drop", "swap", "double", "replace"])
    if kind == "drop":
        return word[:i] + word[i + 1 :]
    if kind == "swap":
        return word[:i] + word[i + 1] + word[i] + word[i + 2 :]
    if kind == "double":
        return word[:i] + word[i] + word[i:]
    return word[:i] + rng.choice("aeioutnrs") + word[i + 1 :]


def build_queries(vocab: list[str], phrases: list[str], titles: list[str]) -> list[tuple[str, dict]]:
    qs: list[tuple[str, dict]] = []
    add = lambda q, **p: qs.append((q, p))  # noqa: E731
    for w in vocab:
        add(w)
    for w in rng.sample(vocab, 40):
        add(w.upper())
        add(w[: max(2, len(w) - 2)])
        add(strip_marks(w))
        add(typo(w))
    for _ in range(30):
        add(" ".join(rng.sample(vocab, 2)))
    for _ in range(20):
        add(" ".join(rng.sample(vocab, 3)))
    for p in phrases:
        add(f'"{p}"')
        add(f'"{p}" {rng.choice(vocab)}')
    for _ in range(25):
        a, b = rng.sample(vocab, 2)
        add(f"{a} -{b}")
    for _ in range(10):
        a, b = rng.sample(vocab, 2)
        add(f'{a} -"{b} {rng.choice(vocab)}"')
    for t in titles:
        add(t)
        add(t.lower())
        add(typo(t.split()[0]) + " " + " ".join(t.split()[1:]))
    for w in rng.sample(vocab, 25):
        add(f"#{w}", mode="headings")
        add(w, mode="headings")
    for w in rng.sample(vocab, 20):
        add(w, scope="tickets")
        add(w, scope="all")
    for w in rng.sample(vocab, 12):
        add(w, status="draft")
        add(w, status="published", limit=3)
        add(w, author="Mai")
        add(w, sort="edited_at", limit=4)
        add(w, has_tickets="true")
        add(w, has_tickets="false", limit=3)
        add(w, edited_since="7d")
        add(w, edited_since="2000-01-01", offset=2, limit=3)
        add(w, under_page="@Handbook")
        add(w, page_id="@Roadmap")
    for q in ['"', '""', '"unterminated', "*", "(", ")", "a AND", "OR", "NOT", "NEAR(a b)", "title:rate", "rate:", "-", "--",
              "- -", "'; DROP TABLE docs_page; --", "^rate", "rate*", "{a b}:c", "%", "_", "\\", "rate\x00limiting", "😀",
              '"a" "b" "c"', "-" * 20, "a" * 320, "KAN-1", "kan-2", "ĐĂNG NHẬP", "đăng nhập", "dang nhap", "STRASSE",
              "straße", "strasse", "cafe", "CAFÉ", "creme brulee", "déjà", "deja vu", "e-mail", "max-retries",
              '"max retries"', "ratte limitng", "authentification", "zzzzzz", "", "   "]:  # fmt: skip
        add(q)
    add("rate", edited_since="last week")
    add("rate", scope="galaxy")
    add("rate", sort="nope")
    add("rate", mode="nope")
    add("rate", limit=0)
    add("rate", limit=1000)
    add("rate", offset=-5)
    return qs


def clean(value, ids: dict[str, str]):
    text = json.dumps(value, ensure_ascii=False, sort_keys=False)
    for i, name in ids.items():
        text = text.replace(i, name)
    out = json.loads(text)

    def walk(v):
        if isinstance(v, dict):
            return {k: walk(x) for k, x in v.items() if k not in ("took_ms", "updated_at")}
        if isinstance(v, list):
            return [walk(x) for x in v]
        return v

    return walk(out)


async def main() -> None:
    engine = create_async_engine(fresh_db_file(Path(_tmp) / "g.db"))
    maker = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    ids: dict[str, str] = {}
    pids: dict[str, str] = {}
    by_title: dict[tuple[str, str], str] = {}
    async with maker() as s:
        for name, prefix in ((KANBAN, "KAN"), (OTHER, "OTH")):
            p = await projects.create_project(s, ProjectCreate(name=name, prefix=prefix, color="#123456"))
            pids[name] = p.id
            ids[p.id] = f"<project:{name}>"
        s.add(Member(project_id=pids[KANBAN], name="Mai", color="#3B82F6", role="member"))
        await s.commit()
        for project, title, desc in TICKETS:
            await svc_tickets.create_ticket(s, pids[project], title, description=desc)
        for project, rows in ((KANBAN, PAGES), (OTHER, OTHER_PAGES)):
            for title, parent, md, published, author in rows:
                tok = activity.set_actor(author)
                try:
                    parent_id = by_title.get((project, parent)) if parent else None
                    page = await docs.create_page(s, pids[project], title, parent_id=parent_id, markdown=md)
                    if published:
                        await docs.publish_page(s, page["id"], base_version=0, markdown=md)
                finally:
                    activity.reset_actor(tok)
                by_title[(project, title)] = page["id"]
                ids[page["id"]] = f"<p:{title}>"
        words: dict[str, int] = {}
        for _p, rows in ((KANBAN, PAGES), (OTHER, OTHER_PAGES)):
            for title, _parent, md, _pub, _a in rows:
                for w in (title + " " + md).replace("#", " ").replace("|", " ").split():
                    w = w.strip(".,:;!?()[]`*-/").lower()
                    if len(w) >= 3 and w not in STOP and w.isalpha():
                        words[w] = words.get(w, 0) + 1
        vocab = sorted(words)
        phrases = ["rate limiting", "dark mode", "tìm kiếm", "đăng nhập", "per minute", "weekly sync", "bearer tokens",
                   "docker compose", "refresh endpoint", "mật khẩu", "the board", "e mail", "max retries"]  # fmt: skip
        titles = [t for t, *_ in PAGES][::3]
        queries = build_queries(vocab, phrases, titles)

        class Sorted:
            @staticmethod
            def extractOne(query, choices, **kw):  # noqa: N802
                return process.extractOne(query, sorted(choices), **kw)

        real_process, real_ensure = docs_search.process, docs_search.ensure_fts
        docs_search.process = Sorted

        async def off(_session):
            return False

        def params_of(params):
            out = {}
            for k, v in params.items():
                if k == "has_tickets":  # the route reads the query text as a bool
                    out[k] = v == "true"
                else:
                    out[k] = ids_by_title(v[1:]) if isinstance(v, str) and v.startswith("@") else v
            return out

        def ids_by_title(title):
            return by_title[(KANBAN, title)]

        results = []
        for q, params in queries:
            kw = params_of(params)
            docs_search.ensure_fts = real_ensure
            try:
                fts = await docs_search.search(s, pids[KANBAN], q, **kw)
            except docs_search.DocsError as e:
                fts = {"error": e.code}
            docs_search.ensure_fts = off
            try:
                scan = await docs_search.search(s, pids[KANBAN], q, **kw)
            except docs_search.DocsError as e:
                scan = {"error": e.code}
            fts, scan = clean(fts, ids), clean(scan, ids)
            results.append({"q": q, "params": params, "fts": fts, "scan": None if scan == fts else scan})
        docs_search.ensure_fts = real_ensure
        similar = []
        for slug in SLUGS:
            similar.append({"slug": slug, "result": clean(await docs_search.similar(s, pids[KANBAN], slug), ids)})
        docs_search.process = real_process
    out = {
        "projects": [{"name": KANBAN, "prefix": "KAN"}, {"name": OTHER, "prefix": "OTH"}],
        "members": ["Mai"],
        "tickets": [{"project": p, "title": t, "description": d} for p, t, d in TICKETS],
        "pages": [{"project": KANBAN, "title": t, "parent": pa, "markdown": m, "publish": pub, "author": a} for t, pa, m, pub, a in PAGES]
        + [{"project": OTHER, "title": t, "parent": pa, "markdown": m, "publish": pub, "author": a} for t, pa, m, pub, a in OTHER_PAGES],
        "queries": results,
        "similar": similar,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{len(results)} queries, {sum(1 for r in results if r['scan'] is not None)} where scan differs, {OUT.stat().st_size} bytes")


asyncio.run(main())
