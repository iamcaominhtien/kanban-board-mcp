"""Docs search: FTS5 ranking, query syntax, scopes, filters, facets, snippets and the LIKE fallback."""

import pytest

from services import docs_search
from tests.test_docs import c, mk, pid, publish, setup_db  # noqa: F401  (fixtures)


async def search(c, pid, q, **params):
    r = await c.get(f"/projects/{pid}/docs/search", params={"q": q, **params})
    assert r.status_code == 200, r.text
    return r.json()


def titles(result):
    return [p["title"] for p in result["pages"]]


@pytest.fixture
async def corpus(c, pid):
    pages = {}
    pages["title"] = await publish(c, await mk(c, pid, "Rate limiting"), "## Intro\nunrelated words")
    pages["heading"] = await publish(c, await mk(c, pid, "Guide"), "## Rate limiting\nsome text here")
    pages["body"] = await publish(c, await mk(c, pid, "Notes"), "## Misc\nwe apply rate limiting to every call")
    pages["other"] = await publish(c, await mk(c, pid, "Auth"), "## Tokens\nbearer tokens expire hourly")
    return pages


# --- ranking and syntax ------------------------------------------------------


async def test_title_beats_heading_beats_body(c, pid, corpus):
    res = await search(c, pid, "rate limiting")
    assert titles(res) == ["Rate limiting", "Guide", "Notes"]
    assert res["total"] == 3 and res["took_ms"] >= 0 and res["suggestion"] is None
    first = res["pages"][0]
    assert set(first) >= {
        "page_id", "project_id", "project_name", "title", "path", "status", "version",
        "updated_at", "updated_by", "matches",
    }
    assert first["project_name"] == "Kanban" and first["status"] == "published" and first["version"] == 1


async def test_words_are_anded_phrases_must_match_as_written_and_minus_excludes(c, pid, corpus):
    assert titles(await search(c, pid, "rate tokens")) == []
    assert titles(await search(c, pid, "bearer tokens")) == ["Auth"]
    assert sorted(titles(await search(c, pid, '"rate limiting"'))) == ["Guide", "Notes", "Rate limiting"]
    assert titles(await search(c, pid, '"limiting rate"')) == []
    assert sorted(titles(await search(c, pid, "limiting -unrelated"))) == ["Guide", "Notes"]
    assert titles(await search(c, pid, 'rate -"every call" -unrelated')) == ["Guide"]
    assert titles(await search(c, pid, "-rate")) == []  # nothing positive to look for
    assert (await search(c, pid, ""))["total"] == 0


async def test_prefix_and_case_and_diacritics(c, pid):
    await publish(c, await mk(c, pid, "Café menu"), "## Déjà vu\nauthentication flows")
    assert titles(await search(c, pid, "AUTHEN")) == ["Café menu"]
    assert titles(await search(c, pid, "cafe")) == ["Café menu"]


async def test_mode_headings_only_looks_at_headings(c, pid, corpus):
    res = await search(c, pid, "#rate", mode="headings")
    assert titles(res) == ["Guide"]
    assert res["pages"][0]["matches"][0]["section"] == "Rate limiting"
    assert titles(await search(c, pid, "tokens", mode="headings")) == ["Auth"]  # a heading too
    assert titles(await search(c, pid, "bearer", mode="headings")) == []  # body only


async def test_snippets_are_marked_and_html_escaped(c, pid):
    await publish(c, await mk(c, pid, "XSS"), "## Part\nuse <script>alert(1)</script> to rate things & more")
    res = await search(c, pid, "rate")
    m = res["pages"][0]["matches"][0]
    assert m["section"] == "Part" and m["slug"] == "part"
    assert "<mark>rate</mark>" in m["snippet"]
    assert "&lt;script&gt;" in m["snippet"] and "<script>" not in m["snippet"] and "&amp;" in m["snippet"]
    assert res["pages"][0]["title_snippet"] == "XSS"
    t = await search(c, pid, "xss")
    assert t["pages"][0]["title_snippet"] == "<mark>XSS</mark>"


async def test_odd_characters_never_break_the_query(c, pid, corpus):
    nasty = [
        '"', '""', '"unterminated', "*", "(", ")", "a AND", "OR", "NOT", "NEAR(a b)", "title:rate",
        "rate:", "-", "--", "- -", "'; DROP TABLE docs_page; --", "^rate", "rate*", "{a b}:c", "%", "_",
        "\\", "\x00", "rate\x00limiting", "😀", "((((", "))))", '"a" "b" "c"', "-" * 50, "a" * 400,
    ]
    for q in nasty:
        r = await c.get(f"/projects/{pid}/docs/search", params={"q": q})
        assert r.status_code == 200, q
        assert isinstance(r.json()["pages"], list)
    # and the pages are still there afterwards
    assert len((await c.get(f"/projects/{pid}/docs/tree")).json()) == 4
    assert titles(await search(c, pid, "rate*")) == ["Rate limiting", "Guide", "Notes"]  # punctuation is dropped


async def test_phrase_with_punctuation_and_hyphenated_words(c, pid):
    await publish(c, await mk(c, pid, "Config"), "## Keys\nset max-retries to 3 and e-mail on")
    assert titles(await search(c, pid, "max-retries")) == ["Config"]
    assert titles(await search(c, pid, '"max retries"')) == ["Config"]
    assert titles(await search(c, pid, "e-mail")) == ["Config"]


# --- scopes ------------------------------------------------------------------


async def test_scopes_space_all_and_tickets(c, pid, corpus):
    other = (await c.post("/projects", json={"name": "Other board", "prefix": "OTH", "color": "#00f"})).json()
    await publish(c, await mk(c, other["id"], "Other limits"), "## X\nrate limiting elsewhere")
    await c.post(f"/projects/{pid}/tickets", json={"title": "Fix rate limiting bug", "description": "the limiter breaks"})
    await c.post(f"/projects/{other['id']}/tickets", json={"title": "Rate card", "description": "pricing"})

    space = await search(c, pid, "rate limiting")
    assert "Other limits" not in titles(space)
    assert [t["title"] for t in space["tickets"]] == ["Fix rate limiting bug"]
    assert space["tickets"][0]["ticket_id"] == "KAN-1" and space["tickets"][0]["status"] == "backlog"
    assert "<mark>rate</mark>" in space["tickets"][0]["snippet"]

    everywhere = await search(c, pid, "rate limiting", scope="all")
    assert "Other limits" in titles(everywhere)
    assert {p["project_name"] for p in everywhere["pages"]} == {"Kanban", "Other board"}
    assert everywhere["total"] == 4

    tickets = await search(c, pid, "rate", scope="tickets")
    assert tickets["pages"] == [] and tickets["total"] == 1
    assert [t["ticket_id"] for t in tickets["tickets"]] == ["KAN-1"]
    assert [t["ticket_id"] for t in (await search(c, pid, "rate", scope="tickets"))["tickets"]] == ["KAN-1"]
    all_tickets = await search(c, pid, "rate", scope="all")
    assert {t["ticket_id"] for t in all_tickets["tickets"]} == {"KAN-1", "OTH-1"}
    assert (await search(c, pid, "KAN-1", scope="tickets"))["total"] == 1  # by key
    bad = await c.get(f"/projects/{pid}/docs/search", params={"q": "x", "scope": "galaxy"})
    assert bad.status_code == 422 and bad.json()["detail"]["code"] == "bad_scope"


async def test_deleted_pages_leave_the_index_and_return_on_restore(c, pid, corpus):
    await c.delete(f"/docs/pages/{corpus['title']['id']}")
    assert "Rate limiting" not in titles(await search(c, pid, "rate limiting"))
    await c.post(f"/docs/pages/{corpus['title']['id']}/restore")
    assert titles(await search(c, pid, "rate limiting"))[0] == "Rate limiting"
    await c.delete(f"/docs/pages/{corpus['title']['id']}")
    await c.delete(f"/docs/pages/{corpus['title']['id']}/purge")
    assert "Rate limiting" not in titles(await search(c, pid, "rate limiting"))


async def test_index_follows_publish_rename_and_duplicate(c, pid):
    page = await publish(c, await mk(c, pid, "Alpha"), "first draft zebra")
    assert titles(await search(c, pid, "zebra")) == ["Alpha"]
    await publish(c, page, "now giraffe")
    assert titles(await search(c, pid, "zebra")) == [] and titles(await search(c, pid, "giraffe")) == ["Alpha"]
    await c.patch(f"/docs/pages/{page['id']}", json={"title": "Beta"})
    assert titles(await search(c, pid, "alpha")) == [] and titles(await search(c, pid, "beta")) == ["Beta"]
    await c.post(f"/docs/pages/{page['id']}/duplicate", json={})
    assert sorted(titles(await search(c, pid, "giraffe"))) == ["Beta", "Beta (copy)"]
    # a never-published page is found through its draft
    d = await mk(c, pid, "Gamma", markdown="platypus lives here")
    assert titles(await search(c, pid, "platypus")) == ["Gamma"]
    assert (await search(c, pid, "platypus"))["pages"][0]["status"] == "draft"
    # restoring an old version re-indexes it
    await c.post(f"/docs/pages/{page['id']}/versions/1/restore", json={})
    assert "Alpha" in titles(await search(c, pid, "zebra"))  # v1 brings its own title back
    assert d is not None


# --- filters and facets ------------------------------------------------------


async def test_filters_author_status_edited_since_under_page_has_tickets_sort(c, pid):
    parent = await publish(c, await mk(c, pid, "Handbook"), "## H\nwidget parent")
    kid = await mk(c, pid, "Kid", parent_id=parent["id"])
    r = await c.post(
        f"/docs/pages/{kid['id']}/publish",
        json={"base_version": 0, "markdown": "widget child"},
        headers={"x-actor": "Mai"},
    )
    assert r.status_code == 200
    await mk(c, pid, "Loose", markdown="widget draft")
    t = (await c.post(f"/projects/{pid}/tickets", json={"title": "T"})).json()
    solo = await publish(c, await mk(c, pid, "Solo"), f"widget solo {t['id']}")

    assert len((await search(c, pid, "widget"))["pages"]) == 4
    assert titles(await search(c, pid, "widget", author="Mai")) == ["Kid"]
    assert sorted(titles(await search(c, pid, "widget", status="draft"))) == ["Loose"]
    assert sorted(titles(await search(c, pid, "widget", status="published"))) == ["Handbook", "Kid", "Solo"]
    assert sorted(titles(await search(c, pid, "widget", under_page=parent["id"]))) == ["Handbook", "Kid"]
    assert sorted(titles(await search(c, pid, "widget", page_id=parent["id"]))) == ["Handbook", "Kid"]
    assert titles(await search(c, pid, "widget", has_tickets="true")) == ["Solo"]
    assert len((await search(c, pid, "widget", has_tickets="false"))["pages"]) == 3
    assert len((await search(c, pid, "widget", edited_since="2000-01-01"))["pages"]) == 4
    assert (await search(c, pid, "widget", edited_since="2999-01-01"))["total"] == 0
    assert len((await search(c, pid, "widget", edited_since="7d"))["pages"]) == 4
    bad = await c.get(f"/projects/{pid}/docs/search", params={"q": "widget", "edited_since": "last week"})
    assert bad.status_code == 422 and bad.json()["detail"]["code"] == "bad_filter"
    by_edit = await search(c, pid, "widget", sort="edited_at")
    assert by_edit["pages"][0]["page_id"] == solo["id"]  # the last one touched
    assert (await c.get(f"/projects/{pid}/docs/search", params={"q": "w", "sort": "nope"})).status_code == 422

    facets = (await search(c, pid, "widget", author="Mai"))["facets"]  # facets ignore the narrowing filters
    assert {a["name"]: a["count"] for a in facets["authors"]} == {"Mai": 1, "user": 3}
    assert {s["name"]: s["count"] for s in facets["status"]} == {"draft": 1, "published": 3}
    assert {u["title"]: u["count"] for u in facets["under"]} == {"Handbook": 2, "Loose": 1, "Solo": 1}
    assert facets["has_tickets"] == 1


async def test_pagination(c, pid):
    for n in range(5):
        await publish(c, await mk(c, pid, f"Item {n}"), "common text")
    first = await search(c, pid, "common", limit=2)
    rest = await search(c, pid, "common", limit=2, offset=4)
    assert first["total"] == 5 and len(first["pages"]) == 2 and len(rest["pages"]) == 1
    assert not set(p["page_id"] for p in first["pages"]) & set(p["page_id"] for p in rest["pages"])


async def test_results_show_the_parent_path(c, pid):
    a = await mk(c, pid, "Engineering")
    b = await mk(c, pid, "Backend", parent_id=a["id"])
    await publish(c, await mk(c, pid, "Caching", parent_id=b["id"]), "redis")
    res = await search(c, pid, "redis")
    assert res["pages"][0]["path"] == ["Engineering", "Backend"]


async def test_suggestion_when_nothing_matches(c, pid, corpus):
    res = await search(c, pid, "ratte limitng")
    assert res["total"] == 0 and res["suggestion"] == "rate limiting"
    assert (await search(c, pid, "zzzzzz"))["suggestion"] is None


async def test_similar_pages_for_a_missing_slug(c, pid):
    await mk(c, pid, "Getting started")
    await mk(c, pid, "Rate limits")
    await mk(c, pid, "Deployment")
    r = await c.get(f"/projects/{pid}/docs/similar", params={"slug": "getting-start"})
    assert r.status_code == 200
    rows = r.json()
    assert rows[0]["title"] == "Getting started" and set(rows[0]) == {"page_id", "title", "path"}
    assert len((await c.get(f"/projects/{pid}/docs/similar", params={"slug": "xqzv"})).json()) == 0
    assert (await c.get(f"/projects/{pid}/docs/similar")).json() == []
    for n in range(8):
        await mk(c, pid, f"Rate limit part {n}")
    assert len((await c.get(f"/projects/{pid}/docs/similar", params={"slug": "rate-limit"})).json()) == 4


# --- fallback ----------------------------------------------------------------


@pytest.fixture
def no_fts(monkeypatch):
    async def off(session):
        return False

    monkeypatch.setattr(docs_search, "ensure_fts", off)


async def test_fallback_without_fts5_gives_the_same_answers(c, pid, corpus, no_fts):
    assert titles(await search(c, pid, "rate limiting")) == ["Rate limiting", "Guide", "Notes"]
    assert titles(await search(c, pid, "bearer tokens")) == ["Auth"]
    assert titles(await search(c, pid, "rate tokens")) == []
    assert sorted(titles(await search(c, pid, '"rate limiting"'))) == ["Guide", "Notes", "Rate limiting"]
    assert sorted(titles(await search(c, pid, "limiting -unrelated"))) == ["Guide", "Notes"]
    assert titles(await search(c, pid, "#rate", mode="headings")) == ["Guide"]
    m = (await search(c, pid, "bearer"))["pages"][0]["matches"][0]
    assert "<mark>bearer</mark>" in m["snippet"]
    for q in ('"', "(", "'; --", "NEAR(", "*"):
        assert (await c.get(f"/projects/{pid}/docs/search", params={"q": q})).status_code == 200


async def test_fallback_when_match_raises(c, pid, corpus, monkeypatch):
    monkeypatch.setattr(docs_search.Query, "fts", lambda self: '"broken')  # an FTS5 syntax error
    assert titles(await search(c, pid, "bearer tokens")) == ["Auth"]


async def test_index_writes_are_noops_without_fts5_and_catch_up_afterwards(c, pid, monkeypatch):
    async def off(session):
        return False

    real = docs_search.ensure_fts
    monkeypatch.setattr(docs_search, "ensure_fts", off)
    await publish(c, await mk(c, pid, "While off"), "capybara")  # not indexed
    monkeypatch.setattr(docs_search, "ensure_fts", real)
    assert titles(await search(c, pid, "capybara")) == []  # the stale index misses it ...
    from tests.test_docs import test_async_session

    async with test_async_session() as s:
        await docs_search.rebuild_index(s)
        await s.commit()
    assert titles(await search(c, pid, "capybara")) == ["While off"]  # ... until rebuilt


async def test_ensure_fts_creates_the_table_lazily_and_backfills(c, pid):
    from sqlalchemy import text

    from tests.test_docs import test_async_session

    await publish(c, await mk(c, pid, "Early page"), "pangolin")
    async with test_async_session() as s:
        conn = await s.connection()
        await conn.execute(text("DROP TABLE docs_fts"))
        await s.commit()
    assert titles(await search(c, pid, "pangolin")) == ["Early page"]  # recreated and backfilled on demand
