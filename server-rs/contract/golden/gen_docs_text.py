"""Golden vectors for the low-level Docs text modules, made by the Python code itself.

Writes, next to this file, one JSON per module (`docs_text.json`, `docs_anchors.json`, `docs_checklist.json`,
`docs_edit.json`, `docs_templates.json`, `docs_guide.json`) and `docs_text_charclasses.json` (what Python's `\\w`, `\\s`,
`lower()`, `upper()` and `casefold()` do to every code point). Each module file is
`{"functions": {name: [case, ...]}}` with a case being `{"args": [...], "result": ...}` or
`{"args": [...], "error": {"type": ..., "message": ...}}`.

Run from `server/` (it imports the server's modules), with its own temporary folders so no developer data is touched:

    cd server && .venv/bin/python ../server-rs/contract/golden/gen_docs_text.py

The random part (mutations of realistic pages) uses a fixed seed.
"""

import os
import sys
import tempfile

sys.path.insert(0, os.getcwd())
_TMP = tempfile.mkdtemp(prefix="gen-docs-text-")
os.environ["KANBAN_CONFIG_DIR"] = os.path.join(_TMP, "config")
os.environ["KANBAN_DB_PATH"] = os.path.join(_TMP, "kanban.db")
os.environ["KANBAN_LOG_DIR"] = os.path.join(_TMP, "logs")

import dataclasses  # noqa: E402
import json  # noqa: E402
import random  # noqa: E402
import re  # noqa: E402
import unicodedata  # noqa: E402

from services import (  # noqa: E402
    docs_anchors as A,
    docs_checklist as C,
    docs_edit as E,
    docs_guide as G,
    docs_templates as TP,
    docs_text as T,
)

OUT = os.path.dirname(os.path.abspath(__file__))
SEED = 20261111

# ---------------------------------------------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------------------------------------------

PAGES = [
    "",
    " ",
    "\n",
    "\n\n\n",
    "   \t  \n \t",
    "only a line",
    "## Overview\n\nThe API is REST.\n\n## Endpoints\n\n| Method | Path |\n|---|---|\n| GET | /tickets |\n\n### Errors\n\n401 when the token is missing.\n\n## Limits\n\nRate limits are not enforced yet.\n",
    "# API\n\nEvery route requires a bearer token; rotation rules live in [[Auth]].\n\n## Limits\n\nRate limits are not enforced yet. Tracked in KAN-12.\n\n| Method | Path |\n|---|---|\n| GET | /tickets |\n",
    "## Intro\nSee [[Data model#Fields|the fields]] and KAN-12.\n`[[Ignored]] KAN-99`\n```\n[[Fenced]] KAN-98\n```\n## Next\n[[Auth]]",
    "## Overview\n\n```\n## not a heading\n```\n\n## Overview\n\n### `Code` bit",
    "## A\nx\n```\n## not a heading\n```\n### A1\ny\n## A\nz\n",
    "# One\n## One\n```\n# no\n```\n",
    "## The ==key== rule\n\nA person signs in. ==Five failed attempts lock the account.==\n",
    "# T\n\nfoo bar baz.\n\nqux bar quux.\n",
    "## One\n\nalpha beta\n\n## Two\n\ngamma delta\n",
    "Every route requires a valid bearer token always.",
    "Read the bearer token rotation policy first.",
    "Nothing alike lives here at all.",
    # checklists in every form
    "## Tasks\n\n- [ ] Write the spec\n- [x] Draft done\n- [X] Review done\n* [ ] Star item\n+ [ ] Plus item\n1. [ ] Numbered\n2) [ ] not a task\n- [ ]no space\n-  [ ]  two spaces\n  - [ ] indented\n> - [ ] quoted task\n> > - [ ] nested quote\n- [ ] Already ticketed KAN-12\n- [ ] Code `KAN-99` only\n- [ ] [[Page]] link and KAN-7\n",
    "## Meeting\n\nTODO: send the notes — Linh due Friday\nAction item: book the room by 2026-12-01\n- TODO - call Ana by tomorrow\n- Action: ship it, due Mar 5\n1. todo: numbered\nTodo:\nTODO:   spaced out\n## Next steps\n- First step\n- Second step by today\n\n```\n- [ ] in a fence\nTODO: also in a fence\n```\n## Follow-ups\n1. One\n2. Two\n## Done\n- not an action\n",
    "## To-do\n- a\n## Todo list\n- b\n## ACTION ITEMS\n- c\n## Followups\n- d\n## Follow-up\n- e\n## Next step\n- f\n## Notes\n- g\n",
    # Vietnamese, CJK, emoji, combining
    "## Tổng quan\n\nHệ thống cho phép đăng nhập. Xem [[Mô hình dữ liệu#Trường|các trường]] và KAN-5.\n\n- [ ] Viết tài liệu — Linh\n- [ ] Kiểm thử by Friday\n",
    "## Đặc tả\n\nTiếng Việt có dấu: ắ, ằ, ẳ, ẵ, ặ. Gõ e\u0301 và o\u0302 kiểu tổ hợp.\n\n## Ghi chú về Đà Nẵng\n",
    "## 概要\n\nこのシステムは認証を行います。[[認証#フロー|フロー]] を参照。KAN-3。\n\n- [ ] 仕様を書く — 田中\n\n## 한국어 제목\n\n본문입니다.\n",
    "## Emoji 😀 heading\n\nA line with 👩\u200d💻 and 🇻🇳 flags. [[Page 😀#Sec 🚀|shown 🌟]]\n\n- [ ] ship 🚀 by tomorrow\n",
    "## Combining\n\ne\u0301e\u0301e\u0301 KAN-12\u0301 and a\u0301 KAN-7 b\u0301\n\n[[Pagé#Séction]] and [[Pa\u0301ge]]\n",
    "## Mixed ٣ digits\n\nKAN-١٢ and KAN-12 and ABC-3² and AB-9_ and KAN-5٣\n",
    "## Turkish and Kelvin\n\n- [ ] İşi bitir DUE FRİDAY\n- [ ] Ship by Marıch 5\n- [ ] Ship by \u212aay\n- [ ] Pay by \u017fun\n- [ ] Task BY mon\n",
    # html in markdown
    "## HTML\n\n<div class=\"x\">text <b>bold</b> and <br/> more</div>\n\n<!-- comment -->\n\nA < B and C > D and <3\n\n<a href=\"https://x.y\">link</a>\n",
    # emphasis, escapes, underscores, images, links
    "## Inline\n\n**bold** *it* _under_ __dunder__ ~~gone~~ ==hi== `code` snake_case_name _a_b_ \\*not\\* \\_x\\_ \\\\ \\# \\q\n\n![alt text](/uploads/a.png) and [link](https://x.y/a_b) and [empty]() and [a](b(c)) and [[Page|alt]]\n\n![](x.png) ![a]\n",
    # line endings
    "## A\r\n\r\nline one\r\nline two\r\n\r\n- [ ] task\r\n- item\r\n",
    "## A\rold mac\rline\r- [ ] task\r",
    "## A\u2028line sep\u2029para sep\u0085nel\x0bvt\x0cff\x1cfs\x1dgs\x1ers\x1fus\n- [ ] after\n",
    "## A\n\twith tab\n\t- [ ] tabbed task\n \t > quote\n",
    # tables
    "| a | b |\n|:-:|--:|\n| 1 | **2** |\n| [[X]] | `a|b` |\n|\n||\n| |\n",
    "## T\n\n|---|\n| only |\n  | indented | row |\n\n| a \\| b | c |\n",
    # nested and unclosed fences
    "## F\n\n```python\nprint('x')\n~~~\ninside\n~~~\n```\n\ntext after\n\n~~~\nopen fence never closed\n## in fence\n",
    "```\n```\n```\n## after three\n```\n",
    "   ```\nindented fence\n   ```\n## real\n",
    # headings of every level and odd forms
    "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n####### H7\n#NoSpace\n## Closed ##\n## Hash#inside\n## C#\n##\t Tab\n## \n#\n##   ##\n## a ## b ##\n   ## indented\n    ## four\n",
    "## Same\n## Same\n## Same\n## same\n### Same-2\n## !!!\n## ???\n## ___\n## ---\n## 中文\n## 中文\n",
    "## Heading with [[Link|label]] and [text](url) and **bold** and `code` and ==mark==\n",
    "## [[Only|link]]\n## ![img](x.png)\n## 😀\n## KAN-12 heading\n",
    # wiki links of every form
    "[[A]] [[A#B]] [[A#B|label]] [[A|label]] [[ A ]] [[a#b c]] [[]] [[#x]] [[A#]] [[A|]] [[A#|x]] [[A]]] [[[A]]] [[A]] [[A\n]] [[A#b#c]] [[A|b|c]] [[A#b|c#d]]\n",
    "See [[Auth]] and [[auth#Tokens]] and [[AUTH|the Auth page]] and [[Other]]. KAN-1 KAN-2.\nSecond line [[Auth#Tokens|tokens]]!\n",
    "Rename [[Old name]] to new; also [[old name#Part]], [[ OLD NAME |label]], `[[Old name]]` and ```[[Old name]]```.\n```\n[[Old name]]\n```\n[[Old name]]\n",
    # ticket keys
    "KAN-1 AB-12 ABCDEF-3 ABCDEFG-3 A-1 KAN-1a KAN-12abc xKAN-1 KAN_1 kan-1 KAN-1.5 (KAN-2) [KAN-3] KAN-0 K9-4 9K-4 KAN--1 KAN-1-2\n",
    # sentences
    "First sentence. Second one has [[Target]] in the middle! Third? Yes. A [[Target#Part]] again.   Last   one.\n",
    "- [ ] Do the thing. See [[Target]] for more. Then more...\n> Quoted. [[Target]] here\n1. Item with [[Target]]\n",
    # very long lines
    "## Long\n\n" + ("word " * 400) + "[[Needle]]" + (" tail" * 300) + "\n",
    "## Long2\n\n" + ("é" * 3000) + "\n\n" + "- [ ] " + ("x" * 500) + " KAN-9\n",
    "a" * 5000,
    "[[" + "a" * 250 + "]] [[" + "b" * 200 + "]] [[" + "c" * 201 + "]] [[x#" + "d" * 200 + "]] [[x#" + "d" * 201 + "]] [[x|" + "e" * 200 + "]] [[x|" + "e" * 201 + "]]",
    "[" + "t" * 300 + "](u) [" + "t" * 301 + "](u) [t](" + "u" * 500 + ") [t](" + "u" * 501 + ")",
    # hostile (the linear tests)
    "[[" * 200,
    '[["#' * 100,
    "[x](" * 100,
    "@[" * 100,
    " " * 500 + "x",
    "/" * 500 + "a",
    "## " + "#" * 500 + " x",
    "- " + " " * 500,
    "`" * 101,
    "`a" * 100,
    "_a" * 100,
    "_" * 300,
]

TOKENS = [
    "[[", "]]", "#", "|", "```", "~~~", "- [ ] ", "- [x] ", "> ", "KAN-12", "`", "**", "_", "==", "\\", "![", "](", "<b>",
    "</b>", "\r", "\r\n", "\u2028", "\x0b", "\x1c", "\x1f", "é", "e\u0301", "中", "😀", "Đ", "İ", "ı", "ſ", "\u212a", "ß",
    "Σ", "ǅ", "٣", "²", "‿", "\u00a0", "\u3000", "\u200d", "\n", "\n\n", "  ", "\t", "## ", "### ", "# ", "1. ", "* ", "+ ",
    "| ", " |", "|---|", "TODO: ", "Action item: ", " due Friday", " by tomorrow", " by 2026-12-31", " by Mar 5",
    " — Linh Pham", " - Bob", "[", "]", "(", ")", "[[Auth]]", "[[Auth#Tokens|t]]", "[x](http://y)", "~~", "__", "*",
]


def mutate(rng: random.Random, text: str) -> str:
    chars = list(text)
    for _ in range(rng.randint(1, 6)):
        op = rng.choice(["insert", "insert", "insert", "delete", "dup", "swap", "case"])
        if op == "insert":
            at = rng.randint(0, len(chars))
            chars[at:at] = list(rng.choice(TOKENS))
        elif op == "delete" and chars:
            a = rng.randrange(len(chars))
            del chars[a : a + rng.randint(1, 12)]
        elif op == "dup" and chars:
            lines = "".join(chars).split("\n")
            i = rng.randrange(len(lines))
            lines.insert(i, lines[i])
            chars = list("\n".join(lines))
        elif op == "swap":
            lines = "".join(chars).split("\n")
            if len(lines) > 1:
                i, j = rng.randrange(len(lines)), rng.randrange(len(lines))
                lines[i], lines[j] = lines[j], lines[i]
            chars = list("\n".join(lines))
        elif op == "case" and chars:
            a = rng.randrange(len(chars))
            chars[a : a + 8] = list("".join(chars[a : a + 8]).swapcase())
    return "".join(chars)


def all_pages() -> list[str]:
    rng = random.Random(SEED)
    pages = list(PAGES)
    base = [p for p in PAGES if len(p) > 40]
    for _ in range(170):
        pages.append(mutate(rng, rng.choice(base)))
    # two-stage mutations of the mutants
    for _ in range(30):
        pages.append(mutate(rng, mutate(rng, rng.choice(base))))
    return pages


def line_corpus(pages: list[str]) -> list[str]:
    rng = random.Random(SEED + 1)
    seen: dict[str, None] = {}
    for p in pages:
        for ln in p.splitlines()[:40]:
            seen[ln] = None
        for ln in p.split("\n")[:40]:
            seen[ln] = None
    seen.update(dict.fromkeys(EXTRA_LINES))
    lines = list(seen)
    rng.shuffle(lines)
    # keep the crafted ones, then a sample of the rest
    keep = list(EXTRA_LINES) + [ln for ln in lines if ln not in EXTRA_LINES][:700]
    return keep


EXTRA_LINES = [
    "",
    " ",
    "\t",
    "- ",
    "-",
    "-x",
    "- x",
    "-\tx",
    "* x",
    "+ x",
    "1. x",
    "12. x",
    "123456789. x",
    "1234567890. x",
    "1.x",
    "1 . x",
    "٣. x",
    "²x",
    "> x",
    ">x",
    "> > x",
    ">  > x",
    ">\t>\tx",
    "> - [ ] x",
    "- [ ] x",
    "- [x] x",
    "- [X] x",
    "- [ ]",
    "- [ ]   spaced",
    "[ ] bare",
    "[x]x",
    "[y] x",
    "# H",
    "## H",
    "###### H",
    "####### H",
    "#H",
    "##",
    "## ",
    "##\tH",
    "## H ##",
    "## H##",
    "## H #",
    "## C#",
    "## ##",
    "## # #",
    "   ## H",
    "#" * 6 + " ok",
    "## [[A]] [b](c) **x**",
    "1. # not heading",
    "> ## quoted heading",
    "```",
    "~~~",
    "```python",
    "  ```",
    " ~~~ x",
    "``",
    "`` `",
    "\u00a0```",
    "\x1f```",
    "text ```",
    "[[A]]",
    "[[A#B]]",
    "[[A#B|c]]",
    "[[A|c]]",
    "see [[A]] and [[B#C]] now",
    "a [[A]] b [[A]] c",
    "KAN-1",
    "KAN-1 and AB-22, xx-3",
    "KAN-12\u0301",
    "e\u0301KAN-12",
    "\u0301KAN-12 and \u200dKAN-13",
    "KAN-١٢ KAN-12٣ KAN-1²",
    "ABCDEF-1 ABCDEFG-1 A-1 AB-1 AB1-1 aB-1 AB-",
    "x_KAN-1 KAN-1_x KAN-1-x -KAN-1",
    "(KAN-1) [KAN-2] \"KAN-3\" KAN-4. KAN-5, KAN-6;",
    "KAN-1KAN-2 KAN-1 KAN-2",
    "\u00a0KAN-1\u3000KAN-2\u200bKAN-3",
    "Fixes KAN-123456789012 and BUG-7",
    "`KAN-1` KAN-2",
    "[[KAN-5]] KAN-6",
    "Title — Name",
    "Fix the login bug, due Friday",
    "Fix the login bug, by tomorrow",
    "Fix it by 2026-01-02 please",
    "Send it due on Mar 5 — Ann Lee",
    "Send it due on March 5th",
    "Send it due mon.",
    "Pay due Mon, Tue",
    "x due tomorrowish",
    "x by todayx",
    "x due 2026-1-2",
    "x due 2026-01-022",
    "x BY SUN. 12",
    "x by sep. 31 and by oct 1",
    "x, by mon",
    ",by mon",
    " , due today ,",
    "bydue today",
    "x by\u00a0mon",
    "x due \tmon",
    "x due on",
    "x due onmon",
    "x due on mon",
    "x due on  tue  ",
    "x - Bob",
    "x — Bob Smith Jones",
    "x — Bob Smith Jones Brown",
    "x – lowercase",
    "x - A'B",
    "x - Aé",
    "x — Bob \n",
    "TODO: x",
    "todo - x",
    "- TODO: x",
    "1. Action item: x",
    "Action: x",
    "action item - x",
    "ACTION ITEM : x",
    "TODO:x",
    "TODO:",
    "TODO:   ",
    "todox: y",
    "• todo: y",
    "todo: x\n",
    "todo: x\n\n",
    "todo: x\ny",
    "İşi bitir due friday",
    "ſun by ſun",
    "Pay BY \u212aay",
    "ǆ first letter",
    "ß first letter",
    "ﬁrst ligature",
    "éclair",
    "x" * 300,
    "é" * 300,
    "a. b! c? d. e",
    "One. Two [[T]] three. Four",
    "One.  Two [[T]]. Four",
    "One.\tTwo [[T]] three!\u00a0Four",
    "x. [[T]]",
    "[[T]]. y",
    ".[[T]]",
    "Ends with [[T]]",
    "[[T]] starts",
    "A [[T#S|l]] B",
    "- [ ] 3. step [[T]] end",
    "1. [x] done [[T]]",
    "> [!INFO] [[T]]",
    "* **bold [[T]]** `c` text",
    "a" * 150 + " [[T]] " + "b" * 150,
    "a " * 80 + "[[T]] " + "b " * 80,
    "a" * 100 + "[[T]]" + "b" * 100,
    "a [[T]]",
    "é" * 25 + " [[T]] " + "ü" * 25,
    "Σ ΑΣ ΑΣ. ΑΣΣ",
]


def jsonable(x):
    if dataclasses.is_dataclass(x) and not isinstance(x, type):
        return {k: jsonable(v) for k, v in dataclasses.asdict(x).items()}
    if isinstance(x, (list, tuple)):
        return [jsonable(v) for v in x]
    if isinstance(x, dict):
        return {k: jsonable(v) for k, v in x.items()}
    if isinstance(x, re.Match):
        return None
    if isinstance(x, (E.Section,)):
        return jsonable(dataclasses.asdict(x))
    return x


class Out:
    """The cases of one module."""

    def __init__(self) -> None:
        self.functions: dict[str, list[dict]] = {}

    def add(self, name: str, fn, *args) -> None:
        case: dict = {"args": jsonable(list(args))}
        try:
            case["result"] = jsonable(fn(*args))
        except Exception as exc:  # noqa: BLE001 - the vector records whatever Python raises
            case["error"] = {"type": type(exc).__name__, "message": str(exc)}
        self.functions.setdefault(name, []).append(case)

    def save(self, name: str) -> None:
        path = os.path.join(OUT, f"{name}.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"functions": self.functions}, fh, ensure_ascii=False, separators=(",", ":"))
        total = sum(len(v) for v in self.functions.values())
        print(f"{name}.json: {total} cases, " + ", ".join(f"{k}={len(v)}" for k, v in self.functions.items()), file=sys.stderr)


# ---------------------------------------------------------------------------------------------------------------
# docs_text
# ---------------------------------------------------------------------------------------------------------------


def _ref_json(m: re.Match) -> list:
    return [m.start(), m.end(), m.group(1), m.group(2), m.group(3)]


def needles_of(line: str, rng: random.Random) -> list[str]:
    out = [m.group(0) for m in T._REF.finditer(line)][:2]
    words = line.split()
    if words:
        out.append(rng.choice(words))
    if len(line) > 3:
        a = rng.randrange(len(line))
        out.append(line[a : a + rng.randint(1, 12)])
    out.append("zzz-not-there")
    return out


def gen_docs_text(pages: list[str], lines: list[str]) -> None:
    o = Out()
    rng = random.Random(SEED + 2)
    for ln in lines:
        o.add("slugify", T.slugify, ln)
        o.add("strip_inline", T._strip_inline, ln)
        o.add("strip_block_prefix", T.strip_block_prefix, ln)
        o.add("strip_block_prefix_headings", lambda x: T.strip_block_prefix(x, headings=True), ln)
        o.add("heading_match", lambda x: (lambda m: None if m is None else [m.group(1), m.group(2)])(T._HEADING.match(x)), ln)
        o.add("is_fence", lambda x: T._FENCE.match(x) is not None, ln)
        o.add("ticket_keys", lambda x: [[m.start(), m.end()] for m in T._TICKET.finditer(x)], ln)
        o.add("first_ticket", lambda x: (lambda m: None if m is None else m.group(1))(T._TICKET.search(x)), ln)
        o.add("find_refs", lambda x: [_ref_json(m) for m in T._REF.finditer(x)], ln)
        o.add("link_labels", lambda x: T._LINK.sub(r"\1", x), ln)
        o.add("ref_labels", lambda x: T._REF.sub(lambda m: m.group(3) or m.group(1), x), ln)
        o.add("remove_inline_code", lambda x: T._INLINE_CODE.sub("", x), ln)
        for needle in needles_of(ln, rng):
            o.add("sentence_around", T.sentence_around, ln, needle)
            o.add("ref_excerpt", T.ref_excerpt, ln, needle)
        if rng.random() < 0.3:
            needle = rng.choice(needles_of(ln, rng))
            o.add("sentence_around", T.sentence_around, ln, needle, rng.choice([1, 10, 30]))
            o.add("ref_excerpt", T.ref_excerpt, ln, needle, rng.choice([1, 20, 60, 200]))
    for p in pages:
        o.add("heading_anchors", T.heading_anchors, p)
        o.add("parse_references", T.parse_references, p)
        o.add("page_ref_contexts", T.page_ref_contexts, p)
        o.add("slugify", T.slugify, p[:80])
        for title in rng.sample(["Auth", "auth", "Old name", " OLD NAME ", "Pagé", "Page 😀", "Σ", "A", "x"], 2):
            o.add("rewrite_page_links", T.rewrite_page_links, p, title, "New [title]")
            o.add("count_page_links", T.count_page_links, p, title)
        found = [m.group(1).strip() for m in T._REF.finditer(p)]
        for title in found[:2]:
            o.add("rewrite_page_links", T.rewrite_page_links, p, title, "Renamed Title")
            o.add("rewrite_page_links", T.rewrite_page_links, p, title.upper(), "ΑΣ")
            o.add("count_page_links", T.count_page_links, p, title)
    o.save("docs_text")


# ---------------------------------------------------------------------------------------------------------------
# docs_anchors
# ---------------------------------------------------------------------------------------------------------------


def mutate_quote(rng: random.Random, q: str) -> str:
    chars = list(q)
    for _ in range(rng.randint(1, 3)):
        if not chars:
            break
        op = rng.choice(["sub", "del", "ins", "word"])
        a = rng.randrange(len(chars))
        if op == "sub":
            chars[a] = rng.choice("abcxyz é中")
        elif op == "del":
            del chars[a]
        elif op == "ins":
            chars.insert(a, rng.choice("abcxyz é中"))
        else:
            words = "".join(chars).split(" ")
            if len(words) > 1:
                del words[rng.randrange(len(words))]
            chars = list(" ".join(words))
    return "".join(chars)


def gen_docs_anchors(pages: list[str], lines: list[str]) -> None:
    o = Out()
    rng = random.Random(SEED + 3)
    for ln in lines:
        o.add("normalize", A.normalize, ln)
        o.add("normalize", A.normalize, "  " + ln + "\t\n x ")
    for p in pages:
        o.add("blocks_of", A.blocks_of, p)
    for _ in range(120):
        text = rng.choice(pages)
        n = len(text)
        o.add("context_of", A.context_of, text, rng.randint(0, n + 3), rng.randint(0, n + 40))
        o.add("context_of", A.context_of, text, rng.randint(0, 40), rng.randint(0, 80))
    for p in pages:
        blocks = A.blocks_of(p)
        bl = [dataclasses.asdict(b) for b in blocks]
        slugs = [b["section"] for b in bl if b["section"]] + [None, "nope"]
        if not bl:
            o.add("find_anchor", A.find_anchor, [], "x", "", "", None)
            continue
        for _ in range(rng.randint(3, 7)):
            kind = rng.choice(["exact", "exact", "across", "fuzzy", "fuzzy", "miss", "ws", "short"])
            i = rng.randrange(len(bl))
            t = bl[i]["text"]
            quote = ""
            if kind in ("exact", "fuzzy", "ws", "short") and t:
                a = rng.randrange(len(t))
                quote = t[a : a + rng.randint(1, 45)]
                if kind == "fuzzy":
                    quote = mutate_quote(rng, t[a : a + rng.randint(8, 60)])
                elif kind == "ws":
                    quote = "  " + quote.replace(" ", "  \n ") + "\t"
                elif kind == "short":
                    quote = t[a : a + 3]
            elif kind == "across" and len(bl) > 1:
                j = min(i + 1, len(bl) - 1)
                joined = bl[i]["text"] + " " + bl[j]["text"]
                if rng.random() < 0.3 and len(bl) > j + 1:
                    joined += " " + bl[j + 1]["text"]
                cut = len(bl[i]["text"])
                a = max(0, cut - rng.randint(1, 15))
                quote = joined[a : cut + 1 + rng.randint(1, 15)]
            elif kind == "miss":
                quote = rng.choice(["not on the page at all", "zzzz", "Quux quux", "é中😀"])
            if not quote:
                quote = "a"
            prefix = rng.choice(["", t[max(0, rng.randrange(len(t) + 1) - 20) :][:20], "xx", rng.choice(lines)[:30]])
            suffix = rng.choice(["", t[rng.randrange(len(t) + 1) :][:20], "yy", rng.choice(lines)[:30]])
            section = rng.choice(slugs)

            def run(q, pre, suf, sec, b=bl):
                return A.find_anchor([A.Block(**x) for x in b], q, pre, suf, sec)

            case_args = [bl, quote, prefix, suffix, section]
            case: dict = {"args": jsonable(case_args)}
            try:
                case["result"] = jsonable(run(quote, prefix, suffix, section))
            except Exception as exc:  # noqa: BLE001
                case["error"] = {"type": type(exc).__name__, "message": str(exc)}
            o.functions.setdefault("find_anchor", []).append(case)
    # blocks with offsets that do not follow the "joined by one separator" rule, empty and equal texts
    odd_blocks = [
        [{"text": "alpha beta", "section": "a", "start": 0}, {"text": "alpha beta", "section": "b", "start": 11}],
        [{"text": "x", "section": None, "start": 0}, {"text": "y", "section": "s", "start": 2}],
        [{"text": "aaaa", "section": "s", "start": 0}],
        [{"text": "one two three", "section": "a", "start": 5}, {"text": "four five", "section": "b", "start": 3}],
    ]
    for bl in odd_blocks:
        for q, pre, suf, sec in [
            ("aa", "", "", None),
            ("aa", "a", "a", "s"),
            ("alpha", "", " beta", "b"),
            ("beta alpha", "", "", None),
            ("three four", "two ", " five", "b"),
            ("x y", "", "", "s"),
            ("one two", "", "", "a"),
        ]:
            case = {"args": jsonable([bl, q, pre, suf, sec])}
            try:
                case["result"] = jsonable(A.find_anchor([A.Block(**x) for x in bl], q, pre, suf, sec))
            except Exception as exc:  # noqa: BLE001
                case["error"] = {"type": type(exc).__name__, "message": str(exc)}
            o.functions.setdefault("find_anchor", []).append(case)
    o.save("docs_anchors")


# ---------------------------------------------------------------------------------------------------------------
# docs_checklist
# ---------------------------------------------------------------------------------------------------------------


def gen_docs_checklist(pages: list[str], lines: list[str]) -> None:
    o = Out()
    rng = random.Random(SEED + 4)
    for ln in lines:
        o.add("line_text", C.line_text, ln)
        o.add("clean_title", C.clean_title, ln)
        o.add("clean_title", C.clean_title, "TODO: " + ln + " — Ann Lee, due friday")
        o.add("clean_title", C.clean_title, ln + ", by tomorrow")
    for p in pages:
        o.add("extract", C.extract, p)
        o.add("extract", C.extract, p, None)
        pl = p.splitlines()
        if pl:
            pick = rng.sample(pl, min(len(pl), rng.randint(1, 3)))
            o.add("extract", C.extract, p, "\n".join(pick))
            o.add("extract", C.extract, p, "  " + C._norm(pick[0]).upper() + "  ")
        o.add("extract", C.extract, p, "- [ ] a selection that is not on the page\nTODO: and an action in it")
        o.add("extract", C.extract, p, "   ")
        o.add("extract", C.extract, p, "")
    # more than MAX_ITEMS items
    many = "\n".join(f"- [ ] item {i}" for i in range(45)) + "\n- [x] done\n"
    o.add("extract", C.extract, many)
    o.add("extract", C.extract, many, "item 3")
    o.save("docs_checklist")


# ---------------------------------------------------------------------------------------------------------------
# docs_edit
# ---------------------------------------------------------------------------------------------------------------

NEWS = [
    "",
    "   ",
    "\n\n",
    "plain text",
    "line one\n\nline two",
    "\n\nwith blank edges\n\n",
    "## Same level heading\n\nbody",
    "### Deeper\n\nbody",
    "# Higher\n\nbody",
    "> [!WARNING]\n> Soon.",
    "| POST | /tickets |",
    "- [ ] task\n- [ ] task two\n\n\n\nafter gap",
    "é中😀",
]


def gen_docs_edit(pages: list[str], lines: list[str]) -> None:
    o = Out()
    rng = random.Random(SEED + 5)
    for ln in lines:
        o.add("key", E._key, ln)
        o.add("block", E._block, ln)
        o.add("block", E._block, "\n" + ln + "\n\n")
    for _ in range(150):
        ls = [rng.choice(lines) for _ in range(rng.randint(0, 8))]
        o.add("join", E._join, ls)
        o.add("join", E._join, ["", "", ""] + ls + ["", "", "", ""])
        at = rng.randint(0, len(ls))
        end = rng.randint(at, len(ls))
        o.add("splice", E._splice, ls, at, end, [rng.choice(lines) for _ in range(rng.randint(0, 3))])
    for p in pages[:56] + rng.sample(pages[56:], 24):
        secs = E.sections(p)
        o.add("sections", E.sections, p)
        names = ["", "nope", "#", "[[ ]]", "Overview", "overview", "OVERVIEW", "## Endpoints", "a", "a-2", "API#Endpoints", "[[Page#Section]]", "same", "Same-2"]
        for s in secs[:6]:
            names += [s.text, s.slug, s.text.upper(), "## " + s.text, "[[X#" + s.text + "]]", " " + s.slug + " "]
        real = [x for s_ in secs for x in (s_.text, s_.slug, s_.text.upper(), "## " + s_.text)]
        names = rng.sample(real, min(len(real), 4)) + rng.sample(names, min(len(names), 3))
        for name in names:
            o.add("find_section", E.find_section, p, name)
            o.add("section_text", E.section_text, p, name)
            for mode in rng.sample(["replace", "append", "prepend", "before", "after", "bogus"], 3):
                new = rng.choice(NEWS)
                if mode == "replace" and secs and rng.random() < 0.5:
                    new = "#" * rng.choice([1, 2, 2, 3]) + " Renamed\n\nbody"
                o.add("edit_section", E.edit_section, p, name, new, mode)
        # passages
        finds = ["", "zzz not here", "the", "e", "\n", "\n\n", "  "]
        if p:
            for _ in range(4):
                a = rng.randrange(len(p))
                n = rng.randint(3, 25)
                while p.count(p[a : a + n]) > 1 and a + n < len(p):
                    n += 5  # grow it until it names one place on the page
                finds.append(p[a : a + n])
            a = rng.randrange(len(p))
            finds.append(p[a : a + 20].replace(" ", "  "))
            finds.append(p[a : a + 20].replace(" ", "\n"))
        for find in finds:
            for mode in rng.sample(["replace", "before", "after", "append"], 2):
                o.add("edit_passage", E.edit_passage, p, find, rng.choice(NEWS), mode)
        for new in rng.sample(NEWS, 4):
            o.add("append_page", E.append_page, p, new)
        # apply: every shape of edit, with and without a base
        now = p
        base_choices = [None, p, mutate(rng, p), ""]
        sect_names = [s_.text for s_ in secs[:4]] + [s_.slug for s_ in secs[:2]] + ["nope"]
        for _ in range(6):
            edit: dict = {}
            r = rng.random()
            if r < 0.05:
                pass
            else:
                if rng.random() < 0.95:
                    edit["markdown"] = rng.choice(NEWS)
                if rng.random() < 0.8:
                    edit["mode"] = rng.choice(["replace", "append", "prepend", "before", "after", "", None, "bogus"])
                kind = rng.choice(["section", "find", "both", "none", "emptyfind", "emptysection"])
                if kind in ("section", "both"):
                    edit["section"] = rng.choice(sect_names)
                if kind in ("find", "both") and p:
                    a = rng.randrange(len(p))
                    edit["find"] = p[a : a + rng.randint(1, 20)]
                if kind == "emptyfind":
                    edit["find"] = ""
                if kind == "emptysection":
                    edit["section"] = ""
                    edit["find"] = None
            o.add("apply", E.apply, now, edit, rng.choice(base_choices))
    # the sections of a page whose heading text is only markup, and a page with a thousand lines
    o.add("sections", E.sections, "## **\n## __\n## `\n## **\n")
    o.add("sections", E.sections, "\n".join(f"## S{i % 7}\ntext" for i in range(300)))
    o.save("docs_edit")


# ---------------------------------------------------------------------------------------------------------------
# docs_templates, docs_guide, character classes
# ---------------------------------------------------------------------------------------------------------------


def gen_docs_templates() -> None:
    with open(os.path.join(OUT, "docs_templates.json"), "w", encoding="utf-8") as fh:
        json.dump(
            {"templates": [[k, v] for k, v in TP.TEMPLATES.items()]},
            fh,
            ensure_ascii=False,
            separators=(",", ":"),
        )
    print(f"docs_templates.json: {len(TP.TEMPLATES)} templates", file=sys.stderr)


def gen_docs_guide() -> None:
    with open(os.path.join(OUT, "docs_guide.json"), "w", encoding="utf-8") as fh:
        json.dump(
            {"GUIDE": G.GUIDE, "SKILL_HEADER": G.SKILL_HEADER, "guide": G.guide()},
            fh,
            ensure_ascii=False,
            separators=(",", ":"),
        )
    print("docs_guide.json written", file=sys.stderr)


def gen_charclasses() -> None:
    def ranges(pred):
        out, start = [], None
        for cp in range(0x110000):
            hit = pred(chr(cp))
            if hit and start is None:
                start = cp
            if not hit and start is not None:
                out.append([start, cp - 1])
                start = None
        if start is not None:
            out.append([start, 0x10FFFF])
        return out

    w, d, s = re.compile(r"\w"), re.compile(r"\d"), re.compile(r"\s")
    data = {
        "unidata_version": unicodedata.unidata_version,
        "word": ranges(lambda c: bool(w.match(c))),
        "decimal": ranges(lambda c: bool(d.match(c))),
        "space": ranges(lambda c: bool(s.match(c))),
        "isspace": ranges(lambda c: c.isspace()),
        "assigned": ranges(lambda c: unicodedata.category(c) != "Cn" and not 0xD800 <= ord(c) < 0xE000),
        "lower": [[cp, chr(cp).lower()] for cp in range(0x110000) if not 0xD800 <= cp < 0xE000 and chr(cp).lower() != chr(cp)],
        "upper": [[cp, chr(cp).upper()] for cp in range(0x110000) if not 0xD800 <= cp < 0xE000 and chr(cp).upper() != chr(cp)],
        "casefold": [[cp, chr(cp).casefold()] for cp in range(0x110000) if not 0xD800 <= cp < 0xE000 and chr(cp).casefold() != chr(cp)],
        # strings where a character's lower() depends on its neighbours (final sigma)
        "lower_words": [[t, t.lower()] for t in ["ΑΣ", "ΑΣ ΑΣΑ", "Σ", "ΑΣ.", "ΑΣΣ", "ΑΣ\u0301", "A.Σ", "ΟΔΟΣ ΟΔΟΣ", "İ", "ǅ", "ẞ", "ΑΣ-ΒΣ", "Σ.Α", "ΑΣ\u00ad", "ᾼΣ"]],
    }
    with open(os.path.join(OUT, "docs_text_charclasses.json"), "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
    print("docs_text_charclasses.json written", file=sys.stderr)


def main() -> None:
    pages = all_pages()
    lines = line_corpus(pages)
    print(f"{len(pages)} pages, {len(lines)} lines", file=sys.stderr)
    gen_docs_text(pages, lines)
    gen_docs_anchors(pages, lines)
    gen_docs_checklist(pages, lines)
    gen_docs_edit(pages, lines)
    gen_docs_templates()
    gen_docs_guide()
    gen_charclasses()


if __name__ == "__main__":
    main()
