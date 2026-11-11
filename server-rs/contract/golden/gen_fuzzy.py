"""Golden vectors for crates/kb-fuzzy, computed by the compiled rapidfuzz.

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_fuzzy.py
Writes `fuzzy.json` next to this file.
"""

import json
import random
from pathlib import Path

from rapidfuzz import fuzz, process

MAX_PAIRS = 2400
OUT = Path(__file__).with_name("fuzzy.json")
rng = random.Random(20240607)

SCORERS = {
    "ratio": fuzz.ratio,
    "partial_ratio": fuzz.partial_ratio,
    "token_sort_ratio": fuzz.token_sort_ratio,
    "token_set_ratio": fuzz.token_set_ratio,
    "token_ratio": fuzz.token_ratio,
    "partial_token_sort_ratio": fuzz.partial_token_sort_ratio,
    "partial_token_set_ratio": fuzz.partial_token_set_ratio,
    "partial_token_ratio": fuzz.partial_token_ratio,
    "WRatio": fuzz.WRatio,
    "QRatio": fuzz.QRatio,
}

TITLES = [
    "Fix login bug on mobile",
    "Add dark mode toggle to settings page",
    "Sửa lỗi đăng nhập trên điện thoại",
    "Thêm chế độ tối vào trang cài đặt",
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
    "实现模糊搜索功能",
    "ユーザー認証の修正",
    "Weekly sync: roadmap, risks & blockers",
    "idea similarity: merge duplicates",
    "Meeting notes 2024-05-01",
    "FAQ",
    "Getting started",
    "Architecture overview",
    "Security & permissions model",
]
TAGS = ["bug", "feature", "ui", "backend", "docs", "urgent", "p1", "tech-debt", "đồ-họa", "mobile", "api", "refactor"]
WORDS = (
    "the a of to and in is for on with fix add update remove ticket board page docs search login user data error "
    "settings dark mode toggle server client test build deploy release note design review idea merge cache index "
    "đăng nhập lỗi trang cài đặt chế độ tối thẻ công việc tìm kiếm hướng dẫn máy chủ bảng "
    "🚀 ✅ 🔥 看板 搜索 修复 ユーザー 認証"
).split()
ALPHA = "abcdefghijklmnopqrstuvwxyzáàảãạăắằẳẵặâấầẩẫậđéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵ 0123456789-_.,:;!?()[]#"
ALPHA += "AÀÁĐÉ看板🚀\t"


EDGE = ["", " ", "a", "A", "ab", "ba", "aaaa", "aaaaaaaa", "\t", "  a  b  ", "đ", "🚀", "看板", "a b", "b a",
    "a,b", "x" * 70, "xy" * 40, "abc" * 30, "\x1c\x1d", "a\x1cb", "a b", "\n", "a\nb"]


def rand_str(lo, hi, alphabet=ALPHA):
    return "".join(rng.choice(alphabet) for _ in range(rng.randint(lo, hi)))


def rand_words(lo, hi):
    return " ".join(rng.choice(WORDS) for _ in range(rng.randint(lo, hi)))


def mutate(s):
    chars = list(s)
    for _ in range(rng.randint(0, 3)):
        if not chars:
            break
        op = rng.choice("dis")
        i = rng.randrange(len(chars))
        if op == "d":
            del chars[i]
        elif op == "i":
            chars.insert(i, rng.choice(ALPHA))
        else:
            chars[i] = rng.choice(ALPHA)
    return "".join(chars)


def shuffled_words(s):
    w = s.split()
    rng.shuffle(w)
    return " ".join(w)


def pairs():
    out = []
    edge = EDGE
    for a in edge:
        for b in edge:
            out.append((a, b))
    for t in TITLES + TAGS:
        out.append((t, t))
        out.append((t.lower(), t))
        out.append((t.upper(), t))
        out.append((t.casefold(), t.lower()))
        out.append((t, shuffled_words(t)))
        out.append((t, mutate(t)))
        out.append((t.lower(), mutate(t.lower())))
        out.append((t[: len(t) // 2], t))
        out.append((t, t[len(t) // 3 :]))
    for a in TITLES + TAGS:
        for b in rng.sample(TITLES + TAGS, 12):
            out.append((a, b))
            out.append((a.lower(), b.lower()))
    for q in ["login", "dark", "docs", "tìm", "búg", "mobile", "api", "fuzzy", "lỗi", "🚀", "看", "p1", "đăng nhập"]:
        for t in TITLES:
            out.append((q, t.lower()))
    # descriptions: short query inside long text
    for _ in range(150):
        long = rand_words(15, 80)
        q = rng.choice(long.split())
        out.append((q, long))
        out.append((mutate(q), long))
        out.append((long, q))
        s = rng.randrange(len(long))
        out.append((long[s : s + rng.randint(3, 20)], long))
    # length ratios around 1.5 and 8.0 (WRatio branches)
    for _ in range(400):
        n = rng.randint(2, 30)
        a = rand_str(n, n, "abcde fgh")
        for ratio_ in (1.0, 1.4, 1.49, 1.5, 1.51, 1.6, 2.0, 7.9, 8.0, 8.01, 8.1, 9.0, 12.0):
            m = max(1, int(round(n * ratio_)))
            b = rand_str(m, m, "abcde fgh")
            out.append((a, b))
            out.append((b, a))
    # exact boundary lengths
    for n in (2, 3, 4, 6, 8, 10, 12):
        for m in (n * 3 // 2, n * 3 // 2 - 1, n * 3 // 2 + 1, n * 8, n * 8 - 1, n * 8 + 1):
            for _ in range(5):
                out.append((rand_str(n, n, "ab c"), rand_str(m, m, "ab c")))
    # repeated characters
    for _ in range(150):
        c = rng.choice("ab 🚀đ")
        out.append((c * rng.randint(0, 20), c * rng.randint(0, 60)))
        out.append((c * rng.randint(1, 10) + "x", c * rng.randint(1, 30)))
    # long strings: needles over 64 chars exercise the other partial_ratio paths
    for _ in range(120):
        out.append((rand_str(60, 130, "abcd "), rand_str(60, 400, "abcd ")))
        out.append((rand_words(12, 30), rand_words(30, 120)))
        w = rand_words(25, 60)
        out.append((w, w + " " + rand_words(5, 40)))
        out.append((mutate(w), w))
    # random pairs
    for _ in range(900):
        out.append((rand_str(0, 25), rand_str(0, 25)))
        out.append((rand_words(0, 6), rand_words(0, 8)))
    for _ in range(300):
        a = rand_words(1, 8)
        out.append((a, shuffled_words(a)))
        out.append((a, shuffled_words(mutate(a))))
        out.append((a, a + " " + rand_words(1, 3)))
    # equal-length strings (partial_ratio runs both directions)
    for _ in range(200):
        n = rng.randint(1, 40)
        out.append((rand_str(n, n, "abc d"), rand_str(n, n, "abc d")))
    return out


def main():
    cases = []
    seen = set()
    unique = []
    for pair in pairs():
        if pair not in seen:
            seen.add(pair)
            unique.append(pair)
    # keep the file small: every edge-case pair (the first block) plus a random sample of the rest
    n_edge = len(EDGE) ** 2
    unique = unique[:n_edge] + random.Random(7).sample(unique[n_edge:], MAX_PAIRS - n_edge)
    for a, b in unique:
        for name, fn in SCORERS.items():
            cases.append({"scorer": name, "a": a, "b": b, "score": float(fn(a, b))})

    # extract_one(query, choices, scorer=fuzz.ratio, score_cutoff) -- docs_search._suggest
    extract = []
    vocab_words = sorted({w for t in TITLES for w in t.casefold().split() if len(w) >= 3} | set(WORDS))
    for _ in range(100):
        choices = rng.sample(vocab_words, rng.randint(0, 25))
        if rng.random() < 0.3 and choices:  # duplicates and ties
            choices += rng.sample(choices, min(3, len(choices)))
        base = rng.choice(vocab_words)
        q = mutate(base) if rng.random() < 0.8 else rand_str(1, 8)
        q = q.casefold()
        for scorer_name in ("ratio", "WRatio", "partial_ratio"):
            for cutoff in (None, 70, 0, 100, 50.5):
                kwargs = {} if cutoff is None else {"score_cutoff": cutoff}
                r = process.extractOne(q, choices, scorer=SCORERS[scorer_name], **kwargs)
                extract.append(
                    {
                        "scorer": scorer_name,
                        "query": q,
                        "choices": choices,
                        "score_cutoff": cutoff,
                        "result": None if r is None else {"choice": r[0], "score": float(r[1]), "index": r[2]},
                    }
                )
    # hand-picked ties and exact matches
    for q, choices in [("abcd", ["abce", "abcf", "abcd", "abcd"]), ("abcd", ["abce", "abcf"]), ("x", []),
                       ("abc", ["xyz", "qrs"]), ("tìm", ["tim", "tìm kiếm", "tìm"]), ("", ["", "a"])]:
        for cutoff in (None, 70):
            kwargs = {} if cutoff is None else {"score_cutoff": cutoff}
            r = process.extractOne(q, choices, scorer=fuzz.ratio, **kwargs)
            extract.append(
                {"scorer": "ratio", "query": q, "choices": choices, "score_cutoff": cutoff,
                 "result": None if r is None else {"choice": r[0], "score": float(r[1]), "index": r[2]}}
            )

    OUT.write_text(
        json.dumps({"cases": cases, "extract_one": extract}, ensure_ascii=False, separators=(",", ":"))
        + "\n",
        encoding="utf-8",
    )
    counts = {}
    for c in cases:
        counts[c["scorer"]] = counts.get(c["scorer"], 0) + 1
    print(counts, "extract_one:", len(extract))


if __name__ == "__main__":
    main()
