"""Golden vectors for crates/kb-ideas (`src/idea_similarity.rs`): the Python `services/idea_similarity.py` over a few
hundred texts and searches: the words a text is cut into, the unrounded cosine score of each candidate, and the
ranked result (`rank`: scores rounded to 2 places, best first, those under the minimum left out).

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_idea_similarity.py
Writes `idea_similarity.json` next to this file: `words` (text and its words), `rank` (query, min_score, candidates
with the text and an id, `raw` the unrounded score of each candidate in order, `result` the ids and scores `rank`
returns). The Rust test checks every case bit for bit.
"""

import json
import math
import os
import random
import sys
import tempfile
from collections import Counter
from pathlib import Path

# importing the services must not open the developer's own database
_tmp = tempfile.mkdtemp(prefix="golden-idea-similarity-")
os.environ["KANBAN_CONFIG_DIR"] = os.path.join(_tmp, "config")
os.environ["KANBAN_DB_PATH"] = os.path.join(_tmp, "kanban.db")
os.environ["KANBAN_LOG_DIR"] = os.path.join(_tmp, "logs")
sys.path.insert(0, os.getcwd())  # run from `server/`: the script's own folder is not where `services` is

from services import idea_similarity as sim  # noqa: E402

OUT = Path(__file__).with_name("idea_similarity.json")
rng = random.Random(20261112)

TEXTS = [
    "Show cost on every AI run card",
    "People ask what a run cost before they start it",
    "Dark mode for Docs",
    "the and of",
    "",
    "   ",
    "a b c d e f",
    "snake_case_names and __dunder__ and under_score",
    "x1 y22 z333 4444 55555",
    "Hiển thị chi phí trên thẻ chạy AI",
    "Nhắc uống nước mỗi giờ để khỏe mạnh",
    "看板性能优化 和 用户认证",
    "ユーザー認証の修正について",
    "İstanbul office: STRASSE vs straße and ΣΊΣΥΦΟΣ",
    "Ünïcödé wörds with àccents and ñ",
    "mixed-case WORDS Words words wOrDs",
    "emoji 🚀 in the text 💡 and symbols #$%^&* between",
    "hyphen-ated words, comma,separated;semi:colon",
    "tabs\tand\nnewlines\r\nand   spaces",
    "numbers 123 4567 and ٣٤٥ arabic digits",
    "combining marks: é à कि अक",
    "How would they be sent? What about them: should it, could it, might it?",
    "very over only such some most more like just also must may might",
]
VOCAB = (
    "show cost card run ai agent board ticket idea docs page search login user data error export import report "
    "estimate budget price table member project sprint review merge branch deploy server cache index query "
    "nhắc uống nước giờ đăng nhập trang cài đặt máy chủ thẻ công việc người dùng 看板 性能 ユーザー the and for with "
    "from this that will would there their what about which when your into than then them been were being"
).split()


def sentence(low=1, high=14):
    return " ".join(rng.choice(VOCAB) for _ in range(rng.randint(low, high)))


def messy():
    parts = []
    for _ in range(rng.randint(1, 10)):
        word = rng.choice(VOCAB)
        parts.append(rng.choice([word, word.upper(), word.title(), word + "_x", word[:2], word + "123", "-" + word]))
        parts.append(rng.choice([" ", "  ", ", ", "\n", "-", "/", " 🚀 "]))
    return "".join(parts)


def raw_scores(query, texts):
    """What `rank` computes before it rounds, step for step."""
    q_tokens = sim.words(query)
    docs = [sim.words(t) for t in texts]
    n = len(docs) + 1
    df = Counter()
    for tokens in [q_tokens, *docs]:
        df.update(set(tokens))
    idf = {w: math.log(1 + n / c) for w, c in df.items()}
    qv = sim._vector(q_tokens, idf)
    return [sim._cosine(qv, sim._vector(tokens, idf)) for tokens in docs]


words_cases = [{"text": t, "words": sim.words(t)} for t in TEXTS]
for _ in range(250):
    t = rng.choice([sentence, messy, lambda: messy() + " " + sentence()])()
    words_cases.append({"text": t, "words": sim.words(t)})

rank_cases = []
for case in range(400):
    query = rng.choice([sentence, messy, lambda: rng.choice(TEXTS)])()
    count = rng.choice([0, 1, 1, 2, 3, 5, 8, 12, 20])
    candidates = []
    for n in range(count):
        text = rng.choice([sentence, messy, lambda: rng.choice(TEXTS), lambda: sentence(20, 60)])()
        candidates.append({"id": f"c{n}", "text": text})
    min_score = rng.choice([sim.MIN_SCORE, 0.0, 0.15, 0.5, 0.9])
    raw = raw_scores(query, [c["text"] for c in candidates])
    result = sim.rank(query, [dict(c) for c in candidates], min_score)
    for r, c in zip(raw, candidates):
        c["raw"] = r
    rank_cases.append(
        {
            "query": query,
            "min_score": min_score,
            "candidates": candidates,
            "result": [{"id": r["id"], "score": r["score"]} for r in result],
        }
    )

OUT.write_text(json.dumps({"words": words_cases, "rank": rank_cases}, ensure_ascii=False, indent=0) + "\n")
print(f"{OUT}: {len(words_cases)} word cases, {len(rank_cases)} rank cases, {OUT.stat().st_size} bytes")
