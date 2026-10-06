"""Docs import: dry run, folder trees, titles, front matter, conflicts, limits and unsafe paths."""

import pytest

from services import docs_import
from tests.test_docs import c, mk, pid, publish, setup_db  # noqa: F401  (fixtures)


def upload(files, **data):
    """multipart kwargs for httpx: files = [(path, text-or-bytes)]."""
    parts = [
        ("files", (p.rsplit("/", 1)[-1], b if isinstance(b, bytes) else b.encode()))
        for p, b in files
    ]
    form = {"paths": [p for p, _ in files]}
    form.update(
        {
            k: (str(v).lower() if isinstance(v, bool) else v)
            for k, v in data.items()
            if v is not None
        }
    )
    return {"files": parts, "data": form}


async def dry(c, pid, files, **data):
    r = await c.post(
        f"/projects/{pid}/docs/import", **upload(files, dry_run=True, **data)
    )
    assert r.status_code == 200, r.text
    return r.json()


async def do_import(c, pid, files, **data):
    r = await c.post(f"/projects/{pid}/docs/import", **upload(files, **data))
    assert r.status_code == 200, r.text
    return r.json()


async def tree(c, pid):
    rows = (await c.get(f"/projects/{pid}/docs/tree")).json()
    by_id = {r["id"]: r for r in rows}

    def path(r):
        return (path(by_id[r["parent_id"]]) + "/" if r["parent_id"] else "") + r[
            "title"
        ]

    return sorted(path(r) for r in rows)


# --- dry run -----------------------------------------------------------------


async def test_dry_run_reports_the_plan_and_writes_nothing(c, pid):
    await publish(c, await mk(c, pid, "Existing"), "x")
    files = [
        (
            "guide/setup.md",
            "# Setup\nSee [[Existing]] and [[Nowhere]] and [[Nowhere]].",
        ),
        ("guide/usage.md", "no title heading\n[[Setup]]"),
        ("readme-top.md", "---\ntitle: Top page\n---\nbody"),
    ]
    out = await dry(c, pid, files)
    assert set(out) == {
        "files",
        "pages",
        "links_resolved",
        "links_unresolved_total",
        "skipped",
        "bytes",
        "errors",
    }
    assert out["pages"] == 4  # the folder "guide" is a page too
    by_path = {f["path"]: f for f in out["files"]}
    setup = by_path["guide/setup.md"]
    assert setup == {
        "path": "guide/setup.md",
        "page_path": ["guide", "Setup"],
        "title": "Setup",
        "status": "warning",
        "links_resolved": 1,
        "links_unresolved": ["Nowhere"],
        "message": "1 link not found yet",
    }
    usage = by_path["guide/usage.md"]
    assert (
        usage["title"] == "usage"
        and usage["status"] == "ok"
        and usage["links_resolved"] == 1
    )  # [[Setup]] is in the batch
    assert by_path["readme-top.md"]["title"] == "Top page"
    assert (
        out["links_resolved"] == 2
        and out["links_unresolved_total"] == 1
        and out["skipped"] == 0
    )
    assert out["bytes"] == sum(len(b.encode()) for _, b in files)
    assert [f["path"] for f in out["files"]] == [p for p, _ in files]  # input order
    assert await tree(c, pid) == ["Existing"]


# --- real run ----------------------------------------------------------------


async def test_folders_become_parent_pages_and_pages_are_drafts(c, pid):
    out = await do_import(
        c,
        pid,
        [
            ("docs/a.md", "# Alpha\n## Section\ntext"),
            ("docs/deep/b.markdown", "bee"),
            ("top.md", "---\ntitle: Top\n---\nt"),
        ],
    )
    assert out["failed"] == [] and out["skipped"] == []
    assert {c_["path"] for c_ in out["created"]} == {
        "docs",
        "docs/deep",
        "docs/a.md",
        "docs/deep/b.markdown",
        "top.md",
    }
    assert await tree(c, pid) == [
        "Top",
        "docs",
        "docs/Alpha",
        "docs/deep",
        "docs/deep/b",
    ]
    tree_rows = {
        r["title"]: r for r in (await c.get(f"/projects/{pid}/docs/tree")).json()
    }
    assert all(r["status"] == "draft" and r["version"] == 0 for r in tree_rows.values())
    alpha = (await c.get(f"/docs/pages/{tree_rows['Alpha']['id']}")).json()
    assert (
        alpha["draft"]["markdown"] == "## Section\ntext"
    )  # the title heading became the title
    assert alpha["status"] == "draft" and alpha["created_by"] == "user"
    assert alpha["draft"]["base_version"] == 0
    assert [c_["page_id"] for c_ in out["created"] if c_["path"] == "docs/a.md"] == [
        tree_rows["Alpha"]["id"]
    ]


async def test_index_and_readme_become_the_folder_page_body(c, pid):
    out = await do_import(
        c,
        pid,
        [
            ("guides/index.md", "---\ntitle: All guides\n---\nwelcome"),
            ("guides/README.md", "# Readme heading\nreadme body"),
            ("guides/one.md", "one"),
            ("solo/README.md", "# Solo home\nhome body"),
            ("solo/two.md", "two"),
            ("plain/README.md", "no heading here"),
        ],
    )
    assert out["failed"] == []
    paths = await tree(c, pid)
    assert (
        "All guides" in paths
        and "All guides/one" in paths
        and "All guides/Readme heading" in paths
    )
    assert "Solo home" in paths and "Solo home/two" in paths and "plain" in paths
    rows = {r["title"]: r for r in (await c.get(f"/projects/{pid}/docs/tree")).json()}
    guide = (await c.get(f"/docs/pages/{rows['All guides']['id']}")).json()
    assert guide["draft"]["markdown"] == "welcome"  # index.md wins over README.md
    solo = (await c.get(f"/docs/pages/{rows['Solo home']['id']}")).json()
    assert solo["draft"]["markdown"] == "home body"
    plain = (await c.get(f"/docs/pages/{rows['plain']['id']}")).json()
    assert (
        plain["draft"]["markdown"] == "no heading here"
    )  # README without a title keeps the folder's name


async def test_titles_front_matter_beats_heading_beats_file_name(c, pid):
    out = await dry(
        c,
        pid,
        [
            (
                "a.md",
                "---\ntitle: From front matter\nauthor: x\n---\n# A heading\nbody",
            ),
            ("b.md", "# From heading\ntext"),
            ("c-file_name.md", "text only"),
            ("d.md", "---\ntitle: Same\n---\n# Same\nbody"),
            ("e.md", "```\n# not a heading\n```\nbody"),
            ("f.md", "\ufeff# BOM heading\nx"),
        ],
    )
    got = {f["path"]: f["title"] for f in out["files"]}
    assert got == {
        "a.md": "From front matter",
        "b.md": "From heading",
        "c-file_name.md": "c-file_name",
        "d.md": "Same",
        "e.md": "e",
        "f.md": "BOM heading",
    }
    real = await do_import(
        c,
        pid,
        [
            ("d.md", "---\ntitle: Same\n---\n# Same\nbody"),
            ("a.md", "---\ntitle: T\n---\n# Heading stays\nbody"),
        ],
    )
    rows = {r["title"]: r for r in (await c.get(f"/projects/{pid}/docs/tree")).json()}
    assert (await c.get(f"/docs/pages/{rows['Same']['id']}")).json()["draft"][
        "markdown"
    ] == "body"
    assert (await c.get(f"/docs/pages/{rows['T']['id']}")).json()["draft"][
        "markdown"
    ] == "# Heading stays\nbody"
    assert len(real["created"]) == 2


async def test_front_matter_errors_name_the_line(c, pid):
    bad = "---\ntitle: ok\nitems: [unclosed\n---\nbody"
    out = await dry(c, pid, [("bad.md", bad), ("good.md", "fine")])
    f = out["files"][0]
    assert f["status"] == "error" and f["title"] is None and f["page_path"] is None
    assert f["message"].startswith("Front matter could not be read (line ")
    line = int(f["message"].split("line ")[1].rstrip(")"))
    assert line in (3, 4)  # a line inside or just after the broken block
    assert out["errors"] == 1 and out["pages"] == 1
    real = await do_import(c, pid, [("bad.md", bad), ("good.md", "fine")])
    assert [x["path"] for x in real["failed"]] == ["bad.md"] and real["failed"][0][
        "message"
    ] == f["message"]
    assert await tree(c, pid) == ["good"]
    scalar = await dry(c, pid, [("s.md", "---\njust a string\n---\nx")])
    assert scalar["files"][0]["message"] == "Front matter could not be read (line 1)"
    unclosed = await dry(c, pid, [("u.md", "---\nnot closed\nbody")])
    assert unclosed["files"][0]["status"] == "ok"  # no closing marker: it is just text


# --- conflicts ---------------------------------------------------------------


async def test_conflict_copy_renames_and_skip_leaves_files_out(c, pid):
    await mk(c, pid, "Notes")
    files = [
        ("Notes.md", "a"),
        ("other/Notes.md", "b"),
        ("dupe.md", "# Twin\n1"),
        ("dupe2.md", "# Twin\n2"),
    ]
    copy = await dry(c, pid, files, on_conflict="copy")
    by = {f["path"]: f for f in copy["files"]}
    assert (
        by["Notes.md"]["title"] == "Notes (copy)"
        and by["Notes.md"]["status"] == "warning"
    )
    assert "already exists" in by["Notes.md"]["message"]
    assert (
        by["other/Notes.md"]["title"] == "Notes"
        and by["other/Notes.md"]["status"] == "ok"
    )  # another parent: no clash
    assert {by["dupe.md"]["title"], by["dupe2.md"]["title"]} == {"Twin", "Twin (copy)"}
    assert copy["skipped"] == 0

    skip = await dry(c, pid, files, on_conflict="skip")
    by = {f["path"]: f for f in skip["files"]}
    assert by["Notes.md"]["status"] == "warning" and by["Notes.md"]["page_path"] is None
    assert by["Notes.md"]["message"].startswith("Skipped:")
    assert skip["skipped"] == 2 and skip["pages"] == 3  # other + folder + one Twin

    real = await do_import(c, pid, files, on_conflict="skip")
    assert {s["path"] for s in real["skipped"]} == {"Notes.md", "dupe2.md"}
    assert await tree(c, pid) == ["Notes", "Twin", "other", "other/Notes"]
    again = await do_import(c, pid, files, on_conflict="copy")
    assert len(again["created"]) == 5 - 1  # folder "other" is reused, not duplicated
    paths = await tree(c, pid)
    assert (
        paths.count("other") == 1
        and "other/Notes (copy)" in paths
        and "Notes (copy)" in paths
    )
    bad = await c.post(
        f"/projects/{pid}/docs/import", **upload(files, on_conflict="overwrite")
    )
    assert bad.status_code == 422 and bad.json()["detail"]["code"] == "bad_conflict"


async def test_importing_under_a_parent_page(c, pid):
    parent = await mk(c, pid, "Imports")
    await mk(c, pid, "Taken", parent_id=parent["id"])
    out = await do_import(
        c, pid, [("sub/x.md", "x"), ("Taken.md", "t")], parent_id=parent["id"]
    )
    assert len(out["created"]) == 3
    assert await tree(c, pid) == [
        "Imports",
        "Imports/Taken",
        "Imports/Taken (copy)",
        "Imports/sub",
        "Imports/sub/x",
    ]
    other = (
        await c.post("/projects", json={"name": "O", "prefix": "OOO", "color": "#00f"})
    ).json()
    r = await c.post(
        f"/projects/{other['id']}/docs/import",
        **upload([("a.md", "a")], parent_id=parent["id"]),
    )
    assert r.status_code == 422 and r.json()["detail"]["code"] == "bad_parent"
    r = await c.post(
        f"/projects/{pid}/docs/import", **upload([("a.md", "a")], parent_id="nope")
    )
    assert r.status_code == 404


# --- limits and unsafe input -------------------------------------------------


async def test_wrong_extension_size_utf8_and_unsafe_paths_are_errors_not_crashes(
    c, pid
):
    files = [
        ("notes.txt", "x"),
        ("big.md", b"x" * (2 * 1024 * 1024 + 1)),
        ("latin.md", b"caf\xe9 \xff"),
        ("../evil.md", "x"),
        ("a/../../evil.md", "x"),
        ("/abs/evil.md", "x"),
        ("C:/win/evil.md", "x"),
        ("back\\..\\evil.md", "x"),
        ("ok.md", "fine"),
        ("exact.md", b"x" * 1_000_000),
        ("two-mb.md", b"x" * (2 * 1024 * 1024)),
    ]
    out = await dry(c, pid, files)
    msgs = {f["path"]: (f["status"], f["message"]) for f in out["files"]}
    assert msgs["notes.txt"] == (
        "error",
        "Only .md and .markdown files can be imported",
    )
    assert msgs["big.md"] == ("error", "File is larger than 2 MB")
    assert msgs["latin.md"] == ("error", "File is not valid UTF-8 text")
    for p in (
        "../evil.md",
        "a/../../evil.md",
        "/abs/evil.md",
        "C:/win/evil.md",
        "back\\..\\evil.md",
    ):
        assert msgs[p][0] == "error" and msgs[p][1].startswith("Unsafe path"), p
    assert msgs["ok.md"] == ("ok", None) and msgs["exact.md"][0] == "ok"
    assert msgs["two-mb.md"] == (
        "error",
        "File is too large for a page",
    )  # a page holds at most 1,000,000 characters
    assert out["errors"] == 9 and out["pages"] == 2
    real = await do_import(c, pid, files)
    assert len(real["failed"]) == 9 and {c_["path"] for c_ in real["created"]} == {
        "ok.md",
        "exact.md",
    }
    assert await tree(c, pid) == ["exact", "ok"]


async def test_dot_segments_are_harmless_and_case_of_extension_is_ignored(c, pid):
    out = await do_import(c, pid, [("./a/./b.MD", "x"), ("c.Markdown", "y")])
    assert out["failed"] == [] and await tree(c, pid) == ["a", "a/b", "c"]


async def test_too_many_files_and_no_files(c, pid):
    files = [(f"f{n}.md", "x") for n in range(201)]
    r = await c.post(f"/projects/{pid}/docs/import", **upload(files, dry_run=True))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "too_many_files"
    ok = await dry(c, pid, files[:200])
    assert ok["pages"] == 200
    r = await c.post(f"/projects/{pid}/docs/import", data={"dry_run": "true"})
    assert r.status_code == 422  # no files at all (validation)


async def test_missing_paths_fall_back_to_the_upload_name(c, pid):
    r = await c.post(
        f"/projects/{pid}/docs/import",
        files=[("files", ("loose.md", b"hello"))],
        data={"dry_run": "true"},
    )
    assert r.json()["files"][0]["path"] == "loose.md"


# --- links, publish, resolve post-pass --------------------------------------


async def test_import_keeps_links_as_written_and_resolve_pass_indexes_them(c, pid):
    out = await do_import(
        c,
        pid,
        [("a.md", "# A\nsee [[B]] and [[Missing]]"), ("b.md", "# B\n## Part\nx")],
    )
    ids = [x["page_id"] for x in out["created"]]
    a = (await c.get(f"/docs/pages/{ids[0]}")).json()
    assert "[[B]] and [[Missing]]" in a["draft"]["markdown"]
    r = await c.post(
        f"/projects/{pid}/docs/import/resolve", json={"page_ids": ids + ["unknown-id"]}
    )
    assert r.status_code == 200 and r.json() == {
        "pages": 2,
        "links_resolved": 1,
        "links_unresolved": 1,
    }


async def test_import_with_publish_creates_versions_and_links(c, pid):
    out = await do_import(
        c, pid, [("a.md", "# A\nsee [[B]]"), ("b.md", "# B\ncontent")], publish=True
    )
    by_title = {x["title"]: x["page_id"] for x in out["created"]}
    a = (await c.get(f"/docs/pages/{by_title['A']}")).json()
    assert a["status"] == "published" and a["version"] == 1 and a["draft"] is None
    versions = (await c.get(f"/docs/pages/{by_title['A']}/versions")).json()
    assert versions[0]["note"] == "Imported"
    bl = (await c.get(f"/docs/pages/{by_title['B']}/backlinks")).json()
    assert [p["page_id"] for p in bl["pages"]] == [by_title["A"]]
    found = (
        await c.get(f"/projects/{pid}/docs/search", params={"q": "content"})
    ).json()
    assert [p["title"] for p in found["pages"]] == ["B"]


async def test_imported_drafts_are_searchable_by_title_and_body(c, pid):
    await do_import(c, pid, [("pangram.md", "# Zebra crossing\nquick brown fox")])
    found = (await c.get(f"/projects/{pid}/docs/search", params={"q": "fox"})).json()
    assert [p["title"] for p in found["pages"]] == ["Zebra crossing"] and found[
        "pages"
    ][0]["status"] == "draft"


async def test_import_notify_only_when_published_and_asked(c, pid):
    import json

    import events as board_events

    q = board_events.subscribe()
    try:
        await do_import(c, pid, [("a.md", "x")], publish=True)
        assert all(not e.startswith("{") for e in _drain(q))
        await do_import(c, pid, [("b.md", "x")], publish=True, notify=True)
        events = [json.loads(e) for e in _drain(q) if e.startswith("{")]
        assert (
            len(events) == 1
            and events[0]["type"] == "docs_published"
            and events[0]["title"] == "b"
        )
        await do_import(
            c, pid, [("c.md", "x")], notify=True
        )  # drafts: nothing to announce
        assert all(not e.startswith("{") for e in _drain(q))
    finally:
        board_events.unsubscribe(q)


def _drain(q):
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return out


# --- unit helpers ------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("a/b.md", ["a", "b.md"]),
        ("./a//b.md", ["a", "b.md"]),
        ("a\\b.md", ["a", "b.md"]),
        ("../x.md", None),
        ("a/../b.md", None),
        ("/etc/passwd.md", None),
        ("", None),
        ("   ", None),
        ("a\x00b.md", None),
        ("D:\\x.md", None),
    ],
)
def test_clean_path(raw, expected):
    assert docs_import.clean_path(raw) == expected


def test_collect_local_walks_folders_and_skips_hidden_and_non_markdown(tmp_path):
    (tmp_path / "a.md").write_text("a")
    (tmp_path / "notes.txt").write_text("t")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "b.markdown").write_text("b")
    (tmp_path / ".hidden").mkdir()
    (tmp_path / ".hidden" / "c.md").write_text("c")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "d.md").write_text("d")
    got = docs_import.collect_local(str(tmp_path))
    assert [p for p, _ in got] == ["a.md", "sub/b.markdown"]
    assert docs_import.collect_local(str(tmp_path / "a.md")) == [("a.md", b"a")]
    with pytest.raises(docs_import.DocsError):
        docs_import.collect_local(str(tmp_path / "nope"))
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(docs_import.DocsError):
        docs_import.collect_local(str(empty))


def test_collect_local_ignores_symlinks_that_leave_the_folder(tmp_path):
    outside = tmp_path / "outside.md"
    outside.write_text("secret")
    root = tmp_path / "root"
    root.mkdir()
    (root / "ok.md").write_text("ok")
    (root / "link.md").symlink_to(outside)
    assert [p for p, _ in docs_import.collect_local(str(root))] == ["ok.md"]
