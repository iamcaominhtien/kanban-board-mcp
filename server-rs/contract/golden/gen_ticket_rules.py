"""Golden vectors for the pure rules of the ticket port in crates/kb-board: the validators of `services/tickets.py`
(`src/tickets/validate.rs`), `services/ticket_waves.py`, `services/proofs.py` and the text of
`services/ticket_guide.py`.

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_ticket_rules.py
Writes `ticket_rules.json` next to this file. A case is `{"in": ..., "out": ...}` or `{"in": ..., "error": message}`.
"""

import json
import os
import random
import sys
import tempfile
from pathlib import Path

# importing the models must not open the developer's own database
_tmp = tempfile.mkdtemp(prefix="golden-ticket-rules-")
os.environ["KANBAN_CONFIG_DIR"] = os.path.join(_tmp, "config")
os.environ["KANBAN_DB_PATH"] = os.path.join(_tmp, "kanban.db")
os.environ["KANBAN_LOG_DIR"] = os.path.join(_tmp, "logs")
sys.path.insert(0, os.getcwd())  # run from `server/`: the script's own folder is not where `services` is

from models import Ticket  # noqa: E402
from services import proofs, ticket_guide, ticket_waves  # noqa: E402
from services import tickets as svc  # noqa: E402

OUT = Path(__file__).with_name("ticket_rules.json")
rng = random.Random(20261112)


def case(fn, *args):
    shown = args[0] if len(args) == 1 else list(args)
    try:
        return {"in": shown, "out": fn(*args)}
    except ValueError as exc:
        return {"in": shown, "error": str(exc)}


DATES = [
    "2026-05-01", "2026-13-45", "2026-02-29", "2024-02-29", "not-a-date", "", "   ", " 2026-05-01 ", "2026-5-1",
    "20260501", "2026050112", "2026-W01-1", "2026-W53-7", "2026-W54-1", "2026-W01", "2026W011", "2026W01",
    "0000-01-01", "9999-12-31", "2026-05-01T10:00", "2026-05-01T10:00:00", "2026-05-01 10:00:00.123",
    "2026-05-01T10:00:00.123456789", "2026-05-01T10:00:00Z", "2026-05-01T10:00:00+07:00", "2026-05-01T10:00:00+0700",
    "2026-05-01T10:00:00+07", "2026-05-01T10:00:00-07:30:15", "2026-05-01T10:00:00+24:00", "2026-05-01T10:00:00+23:59",
    "2026-05-01T24:00:00", "2026-05-01T23:59:60", "2026-05-01T10", "2026-05-01T1", "2026-05-01T", "2026-05-01T10:0",
    "2026-05-01T1000", "2026-05-01T100000", "2026-05-01T100000.5", "20260501T100000", "20260501T10:00",
    "2026-05-01T10:00:00,5", "2026-05-01T10:00:00.", "2026-05-01T10:00:00.x", "2026-05-01T10:00:00:5",
    "2026-05-01X10:00", "2026-05-01é10:00", "2026-05-01T10:00Z", "2026-05-01T10:00z", "2026-05-01T10:00:00ZZ",
    "2026-05-01T10:00:00+", "2026-05-01T10:00:00+0", "2026-05-01T10:00:00+070", "2026-05-01T10:00:00 +07:00",
    "2026-05-01T10:00:00.123+07:00", "2026-05-01T10:00:00.123Z", "2026-W01-1T10:00", "2026-W01T10:00",
    "2026W011T1000", "2026-05", "2026", "2026-05-0", "2026-05-011", "２０２６-05-01", "2026/05/01", "01-05-2026",
    "2026-05-01T10:00:00+07:00:00.5", "2026-05-01T10:00:00-00:00", "2026-05-01T10:00:00+00:00:00", "2026-00-10",
    "2026-01-00", "2026-04-31", "2026-05-01T10:60", "2026-05-01T99:00", "1-01-01", "2026-05-01T10:00:00.1234567Z",
    "2026-05-01t10:00", "2026-05-01\t10:00", "2026-05-01T 10:00", "2026-05-01T10 :00", "+2026-05-1", "2026-05--1",
    "2026-1-011", "2026-01-1 ", "\u00a02026-05-01\u2003", "2026W01123", "2026W01-12", "2026-W0112", "20260501xx",
    "2026-W01xx", "2026-W01-x", "2026W010", "2026-W01-0", "2026-W01-8", "2026-W00-1", "2020-W53-1", "2021-W53-1",
    "0001-W01-1", "9999-W52-7", "9999-W52-6", "2026-05-01T10:00:00.5+07:00:00.123456", "2026-05-01T10:00:00+23:59:59.9",
    "2026-05-01T10:00:00-23:59:59.999999", "2026-05-01T10Z", "2026-05-01T10+07", "2026-05-01TZ", "2026-05-01T10:00:00.5,5",
]  # fmt: skip
seeds = [d for d in DATES if len(d) > 6]
for _ in range(160):  # one character of a date changed, dropped or doubled
    base = rng.choice(seeds)
    i = rng.randrange(len(base))
    DATES.append(
        rng.choice([
            base[:i] + rng.choice("0123456789-:TWZ+. ,x") + base[i + 1 :],
            base[:i] + base[i + 1 :],
            base[:i] + base[i] + base[i:],
        ])
    )  # fmt: skip
DATES = list(dict.fromkeys(DATES))

TITLES = [None, "", "   ", "  Hello  ", "x" * 300, "x" * 301, " " + "é" * 300 + "\n", "\u001f t \u2003", "a\u00a0"]
TAGS = [
    None, [], [" a ", "A", "", "b"], [1], [{"a": 1}], [None], ["x" * 50], ["x" * 51], [" " + "y" * 50 + " "],
    [f"t{i}" for i in range(30)], [f"t{i}" for i in range(31)], [f"T{i % 30}" for i in range(60)],
    ["İ", "i̇", "I", "ı"], ["STRASSE", "straße", "Straße"], ["Σ", "σ", "ς"], ["a", True], ["\u001fx\u001f", "x"],
]  # fmt: skip
ESTIMATES = [None, 0, 0.0, 3.5, -5, -0.0, 1e12, 100000, 100000.0, 100000.5, 99999.99, -0.001]  # JSON has no NaN
ORDERS = [
    [None, None], ["2026-12-01", "2026-01-01"], ["2026-01-01", "2026-12-01"], ["2026-01-01", "2026-01-01T09:00"],
    ["2026-01-02T00:00", "2026-01-01"], ["", "2026-01-01"], ["2026-01-01", None], ["2026-W10-1", "2026-01-01"],
]  # fmt: skip
PINS = [None, 1, 99, 0, 100, -1, True, False, 1.0, 2.5, "3", [1]]
MENTIONS = [
    None, "", "hi @[An Nguyen](member:m-1) and @[Bao](member:b.2_x) and @[An Nguyen](member:m-1)",
    "@[a]b](member:x)", "@[line\nbreak](member:x)", "@[" + "n" * 101 + "](member:x)", "@[ok](member:" + "i" * 65 + ")",
    "@[ok](member:" + "i" * 64 + ")", "@[é](member:đ1) @[x](member:a b) @[y](member:)", "@[z](member:٣)",
]  # fmt: skip
DOC_REFS = [
    None, "", "See [[API#Endpoints]] and [[API]] and [[API#Endpoints]].", "`[[Code]]` stays, [[ Page  # Sec ]] too",
    "```\n[[Fenced]]\n```\n[[After]]", "[[A]] [[a]] [[A#]] [[#x]] [[]]", "## H\n[[Under heading|label]]",
]  # fmt: skip


def never_copied(path: str) -> bool:
    return proofs.never_copied(Path(path))


PATHS = [
    "qa/evidence/TC-1.png", ".git/config", "a/.ssh/id_rsa", "node_modules/x/y.png", "a/__pycache__/b.txt", "server.pem",
    "a/KEY.KEY", "store.p12", "x.pfx", "my.keystore", ".env", "prod.env", "notes/password.txt", "notes/password.png",
    "shots/Token-list.JPG", "private_key.txt", "private-key.md", "privatekey.csv", "id_ed25519.pub", "report.pdf",
    "a/b/secretary.docx", "CREDENTIALS.json", "a/./b/../c.txt", "x", "", "passwd", "tokens.svg", "a.b/.c/d.txt",
]  # fmt: skip
PROOFS = [
    None, "", "   ", "Not provable: no iPhone", "  not PROVABLE", "not provables", "Not provable", "Not provable_x",
    "Không chứng minh được: cần tài khoản thật", "không chứng minh đượcx", "KHÔNG CHỨNG MINH ĐƯỢC.", "ran it",
    "x Not provable", "\n\tnot provable\n", "not provable\u0301", "not  provable", 0, 5,
]  # fmt: skip
MARKDOWN = [
    None, "", "![login](qa/evidence/TC-1.png) and [log](out/run.log \"the log\") and [web](https://x.y/a.png)",
    "`![a](code.png)` ```\n![b](fenced.png)\n``` ~~~\n[c](tilde.pdf)\n~~~ ![d](real.png)", "[a]( spaced.png)",
    "[a](two words.png) [b](/uploads/x.png) [c](#top) [d](data:image/png;base64,AA) [e](mailto:a@b.c)",
    "![](x.PNG)[y](y.unknownext) [z](z) [multi\nline](m.png) [t](t.png\t\"title\") [u](u.png \"bad\ntitle\")",
    "[v](v.png\u001f\"t\") [w](w.png\u00a0\"t\") [x](a(b).png)",
]  # fmt: skip
TEST_CASES = [
    [], [{"code": "TC-1", "status": "pass"}, {"code": "TC-2", "status": "fail", "proof": " "},
         {"title": "no code", "status": "pass", "proof": None}, {"status": "fail"}, {"code": "TC-5", "status": "pending"},
         {"code": "TC-6", "status": "pass", "proof": "Not provable: taste"}, {"code": 7, "status": "pass", "proof": "ok"},
         {"code": "", "title": "T8", "status": "fail", "proof": "không chứng minh được"}],
]  # fmt: skip


def waves_case(rows):
    kids = [
        Ticket(id=r[0], project_id="p", title="t", blocked_by=r[1] if isinstance(r[1], str) else json.dumps(r[1]),
               wave_pin=r[2])
        for r in rows
    ]  # fmt: skip
    closed = {r[0] for r in rows if len(r) > 3 and r[3]}
    return {
        "in": [[r[0], r[1] if isinstance(r[1], str) else json.dumps(r[1]), r[2], r[0] in closed] for r in rows],
        "waves": ticket_waves.waves(kids),
        "pinned_ready": {k.id: ticket_waves.pinned_ready(k, kids, closed) for k in kids},
    }


WAVES = [
    [],
    [["A", [], None], ["B", ["A"], None], ["C", ["B", "A"], None], ["D", ["Z"], None]],
    [["A", ["B"], None], ["B", ["A"], None], ["C", ["A"], None]],  # a loop
    [["A", ["A"], None]],
    [["A", [], None, True], ["B", ["A"], 1], ["C", ["B"], None], ["D", [], 5], ["E", ["D"], None, True]],
    [["A", "not json", None], ["B", "{}", None], ["C", "", None], ["D", [1, "A"], None], ["1", [], 3], ["F", "null", 0]],
    [["A", [], 2], ["B", [], 1, True], ["C", [], 3], ["D", ["C"], None]],
]  # fmt: skip

data = {
    "clean_date": [case(svc._clean_date, d, "Due date") for d in DATES] + [case(svc._clean_date, None, "Start date")],
    "clean_title": [case(svc._clean_title, t) for t in TITLES],
    "clean_tags": [case(svc._clean_tags, t) for t in TAGS],
    "clean_estimate": [case(svc._clean_estimate, e) for e in ESTIMATES],
    "clean_text": [case(svc._clean_text, t, "Acceptance criterion", 10) for t in [None, "", " ", " ok ", "x" * 10, "x" * 11]],
    "check_date_order": [case(svc._check_date_order, *o) for o in ORDERS],
    "clean_pin": [case(ticket_waves.clean_pin, p) for p in PINS],
    "mention_ids": [case(svc.mention_ids, m) for m in MENTIONS],
    "doc_ref_keys": [case(svc._doc_ref_keys, t) for t in DOC_REFS],
    "never_copied": [case(never_copied, p) for p in PATHS],
    "has_proof": [case(proofs.has_proof, {"proof": p}) for p in PROOFS] + [case(proofs.has_proof, {})],
    "is_unprovable": [case(proofs.is_unprovable, {"proof": p}) for p in PROOFS] + [case(proofs.is_unprovable, {})],
    "gaps": [case(proofs.gaps, t) for t in TEST_CASES],
    "unprovable": [case(proofs.unprovable, t) for t in TEST_CASES],
    "targets": [{"in": m, "out": sorted(proofs.targets(m))} for m in MARKDOWN],
    "is_local": [case(proofs._is_local, t) for m in MARKDOWN for t in sorted(proofs.targets(m))],
    "localize_no_folder": [case(proofs.localize, m, None) for m in MARKDOWN],
    "waves": [waves_case(rows) for rows in WAVES],
    "guide": {
        "name": ticket_guide.NAME,
        "description": ticket_guide.DESCRIPTION,
        "guide": ticket_guide.GUIDE,
        "on_ticket": ticket_guide.ON_TICKET,
        "role_line": [
            {"in": [role, skill], "out": ticket_guide.role_line(role, skill)}
            for role in [None, "", "nope", *ticket_guide.ON_TICKET]
            for skill in (True, False)
        ],
    },
}
OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
print(f"{OUT.name}: {sum(len(v) for v in data.values())} cases, {OUT.stat().st_size} bytes", file=sys.stderr)
