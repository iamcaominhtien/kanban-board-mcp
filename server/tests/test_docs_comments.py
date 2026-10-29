import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from main import app
from services import docs_anchors as anchors
from tests.fast_db import fresh_tables

test_engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
test_async_session = sessionmaker(
    test_engine, class_=AsyncSession, expire_on_commit=False
)


async def override_get_session():
    async with test_async_session() as session:
        yield session


@pytest.fixture(autouse=True)
async def setup_db():
    await fresh_tables(test_engine)
    app.dependency_overrides[get_session] = override_get_session
    yield
    app.dependency_overrides.pop(get_session, None)


@pytest.fixture
async def c():
    async with httpx.AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client


@pytest.fixture
async def pid(c):
    r = await c.post(
        "/projects", json={"name": "Kanban", "prefix": "KAN", "color": "#0a0"}
    )
    return r.json()["id"]


DOC = (
    "# API\n\n"
    "Every route requires a bearer token; rotation rules live in [[Auth]].\n\n"
    "## Limits\n\n"
    "Rate limits are not enforced yet. Tracked in KAN-12.\n\n"
    "| Method | Path |\n|---|---|\n| GET | /tickets |\n"
)


async def publish(c, page_id, markdown):
    await c.put(f"/docs/pages/{page_id}/draft", json={"markdown": markdown})
    cur = (await c.get(f"/docs/pages/{page_id}")).json()
    r = await c.post(
        f"/docs/pages/{page_id}/publish", json={"base_version": cur["version"]}
    )
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture
async def page(c, pid):
    r = await c.post(f"/projects/{pid}/docs/pages", json={"title": "API"})
    page = r.json()
    await publish(c, page["id"], DOC)
    return page


def as_(name):
    return {"x-actor": name}


async def member(c, pid, name, role="member"):
    r = await c.post(f"/projects/{pid}/members", json={"name": name, "role": role})
    assert r.status_code == 201, r.text
    return r.json()


async def inline(c, page, quote="bearer token", body="Is this enough?", actor="user"):
    r = await c.post(
        f"/docs/pages/{page['id']}/comments",
        json={
            "kind": "inline",
            "body": body,
            "anchor": {
                "quote": quote,
                "prefix": "Every route requires a ",
                "suffix": "; rotation",
                "section": "api",
            },
        },
        headers=as_(actor),
    )
    assert r.status_code == 201, r.text
    return r.json()


# --- anchors (pure) --------------------------------------------------------


def test_blocks_strip_markdown_and_split_blocks():
    blocks = anchors.blocks_of(DOC)
    texts = [b.text for b in blocks]
    assert "Every route requires a bearer token; rotation rules live in Auth." in texts
    assert "GET" in texts and "/tickets" in texts  # table cells are blocks
    limits = next(b for b in blocks if b.text.startswith("Rate limits"))
    assert limits.section == "limits"


def test_exact_match_prefers_the_best_context():
    blocks = anchors.blocks_of("# T\n\nfoo bar baz.\n\nqux bar quux.\n")
    hit = anchors.find_anchor(blocks, "bar", "qux ", " quux")
    assert hit and hit.exact and "qux" in hit.prefix


def test_edited_text_stays_attached_and_changed_text_is_refreshed():
    blocks = anchors.blocks_of("Every route requires a valid bearer token always.")
    hit = anchors.find_anchor(blocks, "bearer token", "requires a ", "")
    assert hit and hit.exact
    blocks = anchors.blocks_of("Read the bearer token rotation policy first.")
    hit = anchors.find_anchor(blocks, "bearer token rotation rules", "", "")
    assert hit and not hit.exact and hit.quote.startswith("bearer token rotation")


def test_missing_text_does_not_match():
    blocks = anchors.blocks_of("Nothing alike lives here at all.")
    assert anchors.find_anchor(blocks, "bearer token", "", "") is None


# --- threads, replies, page comments ------------------------------------------


async def test_inline_thread_roundtrip(c, page):
    t = await inline(c, page)
    assert t["number"] == 1 and t["status"] == "open"
    assert t["anchor"]["state"] == "attached" and t["anchor"]["pos"] is not None
    assert t["comments"][0]["author"] == "user"

    r = await c.post(f"/docs/comments/threads/{t['id']}/replies", json={"body": "Yes."})
    assert r.status_code == 201 and len(r.json()["comments"]) == 2

    listed = (await c.get(f"/docs/pages/{page['id']}/comments")).json()
    assert listed["counts"] == {
        "all": 1,
        "open": 1,
        "resolved": 0,
        "orphaned": 0,
        "page": 0,
    }
    assert listed["role"] == "admin" and listed["me"] == "user"


async def test_numbers_follow_page_order(c, page):
    later = await inline(c, page, quote="Rate limits are not enforced")
    first = await inline(c, page, quote="bearer token")
    listed = (await c.get(f"/docs/pages/{page['id']}/comments")).json()["threads"]
    numbers = {t["id"]: t["number"] for t in listed}
    assert numbers[first["id"]] == 1 and numbers[later["id"]] == 2


async def test_state_filter_and_resolve_reopen(c, page):
    t = await inline(c, page)
    r = await c.post(f"/docs/comments/threads/{t['id']}/resolve")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "resolved" and body["resolved_by"] == "user"
    assert body["resolved_at"] and body["number"] is None

    pid_ = page["id"]
    assert (await c.get(f"/docs/pages/{pid_}/comments?state=open")).json()[
        "threads"
    ] == []
    resolved = (await c.get(f"/docs/pages/{pid_}/comments?state=resolved")).json()
    assert [x["id"] for x in resolved["threads"]] == [t["id"]]

    r = await c.post(f"/docs/comments/threads/{t['id']}/reopen")
    assert r.json()["status"] == "open" and r.json()["resolved_by"] is None
    bad = await c.get(f"/docs/pages/{pid_}/comments?state=nope")
    assert bad.status_code == 422


async def test_page_comments_and_validation(c, page):
    r = await c.post(
        f"/docs/pages/{page['id']}/comments",
        json={"kind": "page", "body": "Looks good"},
    )
    assert r.status_code == 201 and r.json()["anchor"] is None
    only = (await c.get(f"/docs/pages/{page['id']}/comments?kind=page")).json()
    assert len(only["threads"]) == 1 and only["counts"]["page"] == 1
    # page comments cannot be resolved
    assert (
        await c.post(f"/docs/comments/threads/{r.json()['id']}/resolve")
    ).status_code == 422

    for payload in (
        {"kind": "page", "body": "   "},
        {"kind": "inline", "body": "x"},
        {
            "kind": "inline",
            "body": "x",
            "anchor": {"quote": "a" * (anchors.MAX_QUOTE + 1)},
        },
        {"kind": "weird", "body": "x"},
    ):
        bad = await c.post(f"/docs/pages/{page['id']}/comments", json=payload)
        assert bad.status_code == 422, payload


async def test_edit_marks_edited_and_only_author_edits(c, pid, page):
    await member(c, pid, "Linh")
    t = await inline(c, page, actor="Linh")
    cid = t["comments"][0]["id"]
    r = await c.patch(
        f"/docs/comments/{cid}", json={"body": "Edited"}, headers=as_("Linh")
    )
    assert r.status_code == 200
    assert r.json()["comments"][0]["body"] == "Edited"
    assert r.json()["comments"][0]["edited_at"]
    # even the admin cannot edit someone else's comment
    other = await c.patch(f"/docs/comments/{cid}", json={"body": "Hack"})
    assert other.status_code == 403 and other.json()["detail"]["code"] == "not_author"


async def test_delete_first_comment_removes_thread_reply_keeps_it(c, pid, page):
    t = await inline(c, page)
    r = await c.post(
        f"/docs/comments/threads/{t['id']}/replies", json={"body": "Reply"}
    )
    reply_id = r.json()["comments"][1]["id"]
    out = await c.delete(f"/docs/comments/{reply_id}")
    assert out.json() == {"deleted": "comment", "thread_id": t["id"]}
    listed = (await c.get(f"/docs/pages/{page['id']}/comments")).json()
    assert len(listed["threads"][0]["comments"]) == 1

    out = await c.delete(f"/docs/comments/{t['comments'][0]['id']}")
    assert out.json()["deleted"] == "thread"
    listed = (await c.get(f"/docs/pages/{page['id']}/comments")).json()
    assert listed["threads"] == [] and listed["counts"]["all"] == 0


# --- permissions ----------------------------------------------------------------


async def test_viewer_reads_but_cannot_write(c, pid, page):
    await member(c, pid, "Vera", "viewer")
    t = await inline(c, page)
    listed = await c.get(f"/docs/pages/{page['id']}/comments", headers=as_("Vera"))
    assert listed.json()["role"] == "viewer"
    assert listed.json()["threads"][0]["can_reply"] is False

    for method, url, payload in (
        ("post", f"/docs/pages/{page['id']}/comments", {"kind": "page", "body": "hi"}),
        ("post", f"/docs/comments/threads/{t['id']}/replies", {"body": "hi"}),
        ("post", f"/docs/comments/threads/{t['id']}/resolve", None),
    ):
        r = (
            await getattr(c, method)(url, json=payload, headers=as_("Vera"))
            if payload
            else await getattr(c, method)(url, headers=as_("Vera"))
        )
        assert r.status_code == 403, url
        assert r.json()["detail"]["code"] == "read_only"
    # a name that is not a project member is read-only as well
    r = await c.post(
        f"/docs/comments/threads/{t['id']}/replies",
        json={"body": "hi"},
        headers=as_("Stranger"),
    )
    assert r.status_code == 403


async def test_member_resolves_but_only_admin_deletes_any(c, pid, page):
    await member(c, pid, "Mia", "member")
    await member(c, pid, "Ada", "admin")
    t = await inline(c, page, actor="Mia")
    cid = t["comments"][0]["id"]
    assert (
        await c.post(f"/docs/comments/threads/{t['id']}/resolve", headers=as_("Mia"))
    ).status_code == 200

    # another member cannot delete Mia's comment
    await member(c, pid, "Max", "member")
    r = await c.delete(f"/docs/comments/{cid}", headers=as_("Max"))
    assert r.status_code == 403
    # an admin can
    r = await c.delete(f"/docs/comments/{cid}", headers=as_("Ada"))
    assert r.status_code == 200 and r.json()["deleted"] == "thread"


async def test_member_role_can_be_changed(c, pid):
    m = await member(c, pid, "Mia")
    r = await c.patch(f"/projects/{pid}/members/{m['id']}", json={"role": "viewer"})
    assert r.json()["role"] == "viewer"
    bad = await c.patch(f"/projects/{pid}/members/{m['id']}", json={"role": "boss"})
    assert bad.status_code == 422


# --- mentions, notifications, activity -----------------------------------------


async def test_mentions_are_limited_to_project_members(c, pid, page):
    await member(c, pid, "Linh Pham")
    t = await inline(c, page, body="@Linh Pham please check, cc @Nobody")
    mentions = t["comments"][0]["mentions"]
    assert [m["name"] for m in mentions] == ["Linh Pham"]


async def test_picker_mentions_are_understood(c, pid, page):
    linh = await member(c, pid, "Linh Pham")
    t = await inline(
        c, page, body=f"cc @[Linh Pham](member:{linh['id']}) and @[Ghost](member:nope)"
    )
    assert [m["name"] for m in t["comments"][0]["mentions"]] == ["Linh Pham"]
    got = (
        await c.get(f"/projects/{pid}/docs/comment-events?recipient=Linh Pham")
    ).json()
    assert got[0]["snippet"].startswith("cc @Linh Pham and")


async def test_notifications_reach_only_the_right_people(c, pid, page):
    for name in ("Hoa", "Linh", "Tuan", "Bystander"):
        await member(c, pid, name)
    thread = await inline(c, page, body="Starting this thread", actor="Tuan")
    tid = thread["id"]
    # Hoa replies and mentions Linh
    await c.post(
        f"/docs/comments/threads/{tid}/replies",
        json={"body": "Good catch @Linh"},
        headers=as_("Hoa"),
    )
    # Linh replies: notifies the starter (Tuan) and the earlier replier (Hoa), not herself or bystanders
    await c.post(
        f"/docs/comments/threads/{tid}/replies",
        json={"body": "Thanks"},
        headers=as_("Linh"),
    )

    def who(events):
        return {e["kind"] for e in events}

    ev = lambda r: c.get(f"/projects/{pid}/docs/comment-events?recipient={r}")  # noqa: E731
    linh = (await ev("Linh")).json()
    assert [e["kind"] for e in linh] == ["reply"] and linh[0]["mentioned"] == ["Linh"]
    tuan = (await ev("Tuan")).json()
    assert who(tuan) == {"reply"} and len(tuan) == 2
    hoa = (await ev("Hoa")).json()
    assert len(hoa) == 1 and hoa[0]["actor"] == "Linh"
    assert (await ev("Bystander")).json() == []

    # Activity lists everything, newest first
    allv = (await c.get(f"/projects/{pid}/docs/comment-events")).json()
    assert [e["kind"] for e in allv] == ["reply", "reply", "comment"]
    assert allv[0]["page_title"] == "API"


async def test_mention_in_a_new_comment_notifies_the_mentioned(c, pid, page):
    await member(c, pid, "Linh")
    await inline(c, page, body="@Linh take a look")
    got = (await c.get(f"/projects/{pid}/docs/comment-events?recipient=Linh")).json()
    assert [e["kind"] for e in got] == ["comment"]


async def test_resolve_notifies_starter_and_repliers_but_not_the_actor(c, pid, page):
    await member(c, pid, "Tuan")
    await member(c, pid, "Hoa")
    t = await inline(c, page, actor="Tuan")
    await c.post(
        f"/docs/comments/threads/{t['id']}/replies",
        json={"body": "ok"},
        headers=as_("Hoa"),
    )
    await c.post(f"/docs/comments/threads/{t['id']}/resolve", headers=as_("Hoa"))
    tuan = (await c.get(f"/projects/{pid}/docs/comment-events?recipient=Tuan")).json()
    assert "resolved" in {e["kind"] for e in tuan}
    hoa = (await c.get(f"/projects/{pid}/docs/comment-events?recipient=Hoa")).json()
    assert "resolved" not in {e["kind"] for e in hoa}


async def test_unread_dot(c, pid, page):
    await member(c, pid, "Linh")
    t = await inline(c, page, actor="Linh")
    assert t["unread"] is False  # your own thread
    mine = (await c.get(f"/docs/pages/{page['id']}/comments")).json()["threads"][0]
    assert mine["unread"] is True  # someone else wrote it
    read = await c.post(f"/docs/comments/threads/{t['id']}/read")
    assert read.json()["unread"] is False
    await c.post(
        f"/docs/comments/threads/{t['id']}/replies",
        json={"body": "more"},
        headers=as_("Linh"),
    )
    again = (await c.get(f"/docs/pages/{page['id']}/comments")).json()["threads"][0]
    assert again["unread"] is True


# --- anchors across publishes --------------------------------------------------


async def test_publish_keeps_moves_and_orphans(c, page):
    attached = await inline(c, page, quote="bearer token")
    moved = await inline(c, page, quote="Rate limits are not enforced yet.")
    gone = await inline(c, page, quote="Tracked in KAN-12")

    new = (
        "# API\n\nIntro paragraph added above.\n\n"
        "Every route requires a bearer token; rotation rules live in [[Auth]].\n\n"
        "## Limits\n\n"
        "Rate limits are not yet enforced. Nothing else.\n"
    )
    await publish(c, page["id"], new)
    listed = {
        t["id"]: t
        for t in (await c.get(f"/docs/pages/{page['id']}/comments")).json()["threads"]
    }
    assert listed[attached["id"]]["anchor"]["state"] == "attached"
    assert (
        listed[attached["id"]]["anchor"]["pos"] > attached["anchor"]["pos"]
    )  # moved down
    assert listed[moved["id"]]["anchor"]["state"] == "attached"  # slightly edited: kept
    assert listed[gone["id"]]["anchor"]["state"] == "orphaned"
    assert listed[gone["id"]]["number"] is None
    counts = (await c.get(f"/docs/pages/{page['id']}/comments")).json()["counts"]
    assert counts["orphaned"] == 1 and counts["open"] == 3


async def test_anchor_preview_warns_before_publishing(c, page):
    await inline(c, page, quote="bearer token")
    await inline(c, page, quote="Rate limits are not enforced")
    r = await c.post(
        f"/docs/pages/{page['id']}/comments/anchor-preview",
        json={"markdown": "# API\n\nA bearer token is needed.\n"},
    )
    assert r.json()["count"] == 1
    assert r.json()["orphaned"][0]["quote"] == "Rate limits are not enforced"
    # nothing changed
    counts = (await c.get(f"/docs/pages/{page['id']}/comments")).json()["counts"]
    assert counts["orphaned"] == 0


async def test_orphaned_thread_can_be_reattached_or_resolved(c, page):
    t = await inline(c, page, quote="Tracked in KAN-12")
    await publish(c, page["id"], "# API\n\nBrand new text with a bearer token.\n")
    orphan = (await c.get(f"/docs/pages/{page['id']}/comments")).json()["threads"][0]
    assert orphan["anchor"]["state"] == "orphaned"

    r = await c.post(
        f"/docs/comments/threads/{t['id']}/reattach",
        json={
            "quote": "bearer token",
            "prefix": "with a ",
            "suffix": ".",
            "section": "api",
        },
    )
    assert r.status_code == 200
    assert r.json()["anchor"]["state"] == "attached" and r.json()["number"] == 1

    await publish(c, page["id"], "# API\n\nNothing matches now.\n")
    resolved = await c.post(f"/docs/comments/threads/{t['id']}/resolve")
    assert resolved.json()["status"] == "resolved"


async def test_orphan_comes_back_when_text_returns_via_restore(c, page):
    t = await inline(c, page, quote="bearer token")
    await publish(c, page["id"], "# API\n\nCompletely different.\n")
    assert (await c.get(f"/docs/pages/{page['id']}/comments")).json()["counts"][
        "orphaned"
    ] == 1
    r = await c.post(f"/docs/pages/{page['id']}/versions/1/restore", json={})
    assert r.status_code == 200, r.text
    listed = (await c.get(f"/docs/pages/{page['id']}/comments")).json()
    assert listed["counts"]["orphaned"] == 0
    assert listed["threads"][0]["id"] == t["id"]


async def test_comments_follow_the_page_through_history(c, page):
    t = await inline(c, page)
    for i in range(2):
        await publish(c, page["id"], DOC + f"\nExtra {i}.\n")
    listed = (await c.get(f"/docs/pages/{page['id']}/comments")).json()
    assert [x["id"] for x in listed["threads"]] == [t["id"]]


# --- recycle bin -----------------------------------------------------------------


async def test_deleting_a_page_hides_comments_and_restore_brings_them_back(c, page):
    t = await inline(c, page)
    assert (await c.delete(f"/docs/pages/{page['id']}")).status_code == 200
    gone = await c.get(f"/docs/pages/{page['id']}/comments")
    assert gone.status_code == 410  # in the Recycle Bin
    assert (await c.post(f"/docs/pages/{page['id']}/restore")).status_code == 200
    back = (await c.get(f"/docs/pages/{page['id']}/comments")).json()
    assert [x["id"] for x in back["threads"]] == [t["id"]]


async def test_purging_a_page_deletes_its_comments(c, page):
    await inline(c, page)
    await c.delete(f"/docs/pages/{page['id']}")
    assert (await c.delete(f"/docs/pages/{page['id']}/purge")).status_code == 204
    async with test_async_session() as s:
        from sqlmodel import select

        from models import DocsComment, DocsCommentThread

        assert (await s.exec(select(DocsCommentThread))).all() == []
        assert (await s.exec(select(DocsComment))).all() == []


async def test_selection_over_several_blocks(c, page):
    quote = "rotation rules live in Auth. Limits Rate limits are not enforced"
    t = await inline(c, page, quote=quote)
    assert t["anchor"]["state"] == "attached" and t["anchor"]["pos"] is not None
    assert t["anchor"]["quote"] == quote

    # an edit elsewhere keeps it attached; removing the text it spans orphans it
    await publish(c, page["id"], DOC + "\nA new closing line.\n")
    listed = (await c.get(f"/docs/pages/{page['id']}/comments")).json()["threads"]
    assert listed[0]["anchor"]["state"] == "attached"
    await publish(c, page["id"], DOC.replace("## Limits\n\n", ""))
    listed = (await c.get(f"/docs/pages/{page['id']}/comments")).json()["threads"]
    assert listed[0]["anchor"]["state"] == "orphaned"


def test_find_anchor_across_blocks_takes_the_section_it_starts_in():
    blocks = anchors.blocks_of("## One\n\nalpha beta\n\n## Two\n\ngamma delta\n")
    hit = anchors.find_anchor(blocks, "beta Two gamma")
    assert hit is not None and hit.exact
    assert hit.section == "one"
    assert hit.prefix.endswith("alpha ") and hit.suffix == " delta"


def test_snippet_names_images_and_diagrams():
    from services.docs_comments import snippet_of

    body = "Look at this\n\n![shot.png](/uploads/a.png)\n\n[Auth flow](diagram:dg_12345678) and [docs](https://x.y) @[Ann](member:m1)"
    assert snippet_of(body) == "Look at this [image] [diagram] and docs @Ann"
