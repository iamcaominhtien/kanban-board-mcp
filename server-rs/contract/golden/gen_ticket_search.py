"""Golden vectors for the ticket search of crates/kb-board (`src/tickets/search.rs`): the Python scoring
(`services/tickets.py:_fuzzy_score`, rapidfuzz's `partial_ratio` with the field weights) over a few hundred tickets and
queries, and the order `list_tickets(q=...)` returns them in.

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_ticket_search.py
Writes `ticket_search.json` next to this file: `tickets` (id, title, description, tags as stored) in the order the
database returns them, and for each query its score per ticket (as `repr` text) and the ids of the matches in the
order of the reply.
"""

import json
import os
import random
import sys
import tempfile
from pathlib import Path

# importing the models must not open the developer's own database
_tmp = tempfile.mkdtemp(prefix="golden-ticket-search-")
os.environ["KANBAN_CONFIG_DIR"] = os.path.join(_tmp, "config")
os.environ["KANBAN_DB_PATH"] = os.path.join(_tmp, "kanban.db")
os.environ["KANBAN_LOG_DIR"] = os.path.join(_tmp, "logs")
sys.path.insert(0, os.getcwd())  # run from `server/`: the script's own folder is not where `services` is

from models import Ticket  # noqa: E402
from services.tickets import _fuzzy_score  # noqa: E402

OUT = Path(__file__).with_name("ticket_search.json")
rng = random.Random(20261112)

TITLES = [
    "Fix login page crash",
    "Improve onboarding flow",
    "Add dark mode toggle to settings page",
    "Sửa lỗi đăng nhập trên điện thoại",
    "Thêm chế độ tối vào trang cài đặt",
    "Nhắc uống nước mỗi giờ",
    "Refactor ticket service to use async sessions",
    "Docs: how to deploy the server with Docker",
    "Hướng dẫn cài đặt và triển khai máy chủ",
    "Kanban board drag and drop is slow",
    "Bảng Kanban kéo thả bị chậm",
    "Implement fuzzy search for tickets",
    "Tìm kiếm mờ cho các thẻ công việc",
    "API rate limiting design",
    "Onboarding checklist for new members",
    "Release notes v1.2.0",
    "Bug: 500 error when title contains emoji 🚀",
    "看板性能优化",
    "ユーザー認証の修正",
    "Weekly sync: roadmap, risks & blockers",
    "Users cannot reset their password",
    "Export one month as CSV",
    "ĐĂNG NHẬP: sai mật khẩu không báo lỗi",
    "İstanbul office: STRASSE vs straße",
    "FAQ",
    "x",
]
WORDS = (
    "the a of to and in is for on with fix add update remove ticket board page docs search login user data error "
    "settings dark mode toggle server client test build deploy release note design review idea merge cache index "
    "lỗi đăng nhập mật khẩu trang cài đặt tìm kiếm thẻ công việc bảng kéo thả chậm máy chủ triển khai nhắc uống nước"
).split()
TAGS = ["bug", "feature", "ui", "backend", "frontend", "docs", "urgent", "p1", "tech-debt", "đồ-họa", "mobile",
        "api", "Refactor", "UX"]  # fmt: skip
PREFIXES = ["MON", "KAN", "IAM", "GIOT", "A"]


def words(n: int) -> str:
    return " ".join(rng.choice(WORDS) for _ in range(n))


def typo(text: str) -> str:
    if len(text) < 2:
        return text
    i = rng.randrange(len(text))
    kind = rng.choice(["drop", "swap", "double", "replace"])
    if kind == "drop":
        return text[:i] + text[i + 1 :]
    if kind == "swap" and i + 1 < len(text):
        return text[:i] + text[i + 1] + text[i] + text[i + 2 :]
    if kind == "double":
        return text[:i] + text[i] + text[i:]
    return text[:i] + rng.choice("abcdefghijklmnopqrstuvwxyzăâđêôơư") + text[i + 1 :]


tickets: list[Ticket] = []
for n in range(1, 241):
    prefix = PREFIXES[n % len(PREFIXES)]
    base = rng.choice(TITLES)
    title = rng.choice([base, base, f"{base} {words(2)}", words(rng.randint(1, 7)), base.upper(), typo(base)])
    description = rng.choice(["", "", words(rng.randint(3, 40)), f"{rng.choice(TITLES)}\n\n{words(12)}", "  "])
    tag_values: list = rng.sample(TAGS, rng.randint(0, 4))
    if n % 37 == 0:
        tag_values += ["", 7, None, 2.5, True]  # values an older version or an import may have left
    tags = "" if n % 41 == 0 else json.dumps(tag_values)
    tickets.append(Ticket(id=f"{prefix}-{n}", project_id="p", title=title, description=description, tags=tags))

queries: list[str] = ["", "   ", "login pge", "reset password", "backend", "zzzzz nonexistent", "1", "24", "MON-1",
                      "mon-12", "KAN", "  Login  ", "ĐĂNG NHẬP", "đăng nhập", "dang nhap", "straße", "STRASSE",
                      "İstanbul", "🚀", "看板", "x", "a", "p1", "tech debt", "tech-debt", "đồ họa", "v1.2", "500"]  # fmt: skip
for t in rng.sample(tickets, 40):
    queries.append(t.id)
    queries.append(t.id.split("-")[1])
    queries.append(typo(t.title))
    queries.append(" ".join(t.title.split()[:2]))
    if t.description.strip():
        queries.append(" ".join(t.description.split()[1:4]))
for _ in range(30):
    queries.append(typo(words(rng.randint(1, 3))))
for tag in TAGS:
    queries.append(rng.choice([tag, tag.upper(), typo(tag)]))
queries = list(dict.fromkeys(queries))[:260]

cases = []
for q in queries:
    scores = [_fuzzy_score(t, q) for t in tickets]
    # `list_tickets`: a query of spaces alone filters nothing; else the matches, best first (a stable sort)
    if q.strip():
        scored = [(t, s) for t, s in zip(tickets, scores) if s > 0]
        scored.sort(key=lambda pair: pair[1], reverse=True)
        order = [t.id for t, _ in scored]
    else:
        order = [t.id for t in tickets]
    # `repr`: the shortest text that reads back as the same float, kept as text so that no JSON reader rounds it
    cases.append({"q": q, "scores": [repr(s) for s in scores], "order": order})

data = {
    "tickets": [{"id": t.id, "title": t.title, "description": t.description, "tags": t.tags} for t in tickets],
    "cases": cases,
}
OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
matches = sum(1 for c in cases for s in c["scores"] if float(s) > 0)
print(f"{OUT.name}: {len(tickets)} tickets, {len(cases)} queries, {matches} matches, {OUT.stat().st_size} bytes", file=sys.stderr)
