from collections.abc import AsyncGenerator

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from kanban_mcp import common, operations as ops
from database import get_session
from main import app

test_engine = create_async_engine(
    "sqlite+aiosqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
test_async_session = async_sessionmaker(
    test_engine, class_=AsyncSession, expire_on_commit=False
)


async def override_get_session() -> AsyncGenerator[AsyncSession, None]:
    async with test_async_session() as session:
        yield session


@pytest.fixture(autouse=True)
async def setup_db(monkeypatch, tmp_path):
    monkeypatch.setenv("KANBAN_UPLOADS_DIR", str(tmp_path / "uploads"))
    async with test_engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    app.dependency_overrides[get_session] = override_get_session
    monkeypatch.setattr(common, "async_session", test_async_session)
    yield
    app.dependency_overrides.pop(get_session, None)
    async with test_engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.drop_all)


@pytest.fixture
def client():
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _ticket(c):
    p = (
        await c.post(
            "/projects", json={"name": "D", "prefix": "DBG", "color": "#123456"}
        )
    ).json()
    return (await c.post(f"/projects/{p['id']}/tickets", json={"title": "t"})).json()[
        "id"
    ]


def _entry(**kw):
    return {"author": "An", "role": "Developer", "note": "found it", **kw}


async def test_kind_role_and_note_are_validated(client):
    async with client as c:
        tid = await _ticket(c)
        url = f"/tickets/{tid}/work-log"
        assert (await c.post(url, json=_entry(kind="weird"))).status_code == 422
        assert (await c.post(url, json=_entry(role="Wizard"))).status_code == 422
        for note in ("", "   \n"):
            r = await c.post(url, json=_entry(note=note))
            assert r.status_code == 400 and "Note" in r.json()["detail"]
        assert (await c.post(url, json=_entry(author="  "))).status_code == 400
        assert (await c.post(url, json=_entry(note="x" * 20001))).status_code == 400
        r = await c.post(url, json=_entry(note="  padded  "))
        assert r.status_code == 200 and r.json()["work_log"][0]["note"] == "padded"

        lid = r.json()["work_log"][0]["id"]
        assert (
            await c.patch(f"{url}/{lid}", json={"kind": "weird"})
        ).status_code == 422
        assert (await c.patch(f"{url}/{lid}", json={"note": " "})).status_code == 400
        # nothing was changed by the rejected edits
        assert (await c.get(f"/tickets/{tid}")).json()["work_log"][0][
            "note"
        ] == "padded"


async def test_links_must_point_at_real_branch_and_test_case(client):
    async with client as c:
        tid = await _ticket(c)
        url = f"/tickets/{tid}/work-log"
        r = await c.post(url, json=_entry(linked_branch="fix/nope"))
        assert r.status_code == 400 and "fix/nope" in r.json()["detail"]
        r = await c.post(url, json=_entry(linked_test_case="TC-99"))
        assert r.status_code == 400 and "TC-99" in r.json()["detail"]

        await c.post(f"/tickets/{tid}/branches", json={"name": "fix/jwt"})
        tc = (await c.post(f"/tickets/{tid}/test-cases", json={"title": "jwt"})).json()[
            "test_cases"
        ][0]
        # a test case may be referenced by id, it is stored as its readable code
        r = await c.post(
            url, json=_entry(linked_branch="fix/jwt", linked_test_case=tc["id"])
        )
        assert r.status_code == 200
        e = r.json()["work_log"][0]
        assert e["linked_branch"] == "fix/jwt" and e["linked_test_case"] == "TC-1"

        # "" clears a link; omitting it leaves it alone
        lid = e["id"]
        r = await c.patch(f"{url}/{lid}", json={"note": "edited"})
        assert r.json()["work_log"][0]["linked_branch"] == "fix/jwt"
        r = await c.patch(
            f"{url}/{lid}", json={"linked_branch": "", "linked_test_case": ""}
        )
        e = r.json()["work_log"][0]
        assert e["linked_branch"] is None and e["linked_test_case"] is None


async def test_attachments_are_validated_and_edit_sets_updated_at(client):
    async with client as c:
        tid = await _ticket(c)
        url = f"/tickets/{tid}/work-log"
        for bad in (
            [{"name": "a.txt", "url": "https://evil.example/a.txt"}],
            [{"name": "a.txt", "url": "/uploads/../secret"}],
            [{"name": "", "url": "/uploads/a.txt"}],
            ["not-an-object"],
        ):
            r = await c.post(url, json=_entry(attachments=bad))
            assert r.status_code in (400, 422), bad
        good = [
            {
                "name": "trace.txt",
                "url": "/uploads/trace-1.txt",
                "size": 12,
                "type": "text/plain",
            }
        ]
        r = await c.post(url, json=_entry(attachments=good))
        e = r.json()["work_log"][0]
        assert (
            e["attachments"][0]["id"]
            and e["attachments"][0]["url"] == "/uploads/trace-1.txt"
        )
        assert e["updated_at"] == e["at"]
        r = await c.patch(f"{url}/{e['id']}", json={"attachments": []})
        e2 = r.json()["work_log"][0]
        assert e2["attachments"] == [] and e2["updated_at"] >= e["updated_at"]


async def test_mcp_can_delete_work_log_and_is_validated():
    p = await ops.create_project(name="M", prefix="MWL")
    t = await ops.create_ticket(project_id=p["id"], title="x")
    added = await ops.add_work_log(t["id"], author="agent", role="Developer", note="n")
    lid = added["work_log"][0]["id"]
    with pytest.raises(ValueError):
        await ops.add_work_log(t["id"], author="a", role="Wizard", note="n")
    result = await ops.delete_work_log(t["id"], lid)
    assert result["work_log"] == []
    with pytest.raises(ValueError, match="not found"):
        await ops.delete_work_log("NOPE-1", lid)


async def test_upload_any_file_and_serve_it_as_a_download(client, tmp_path):
    async with client as c:
        r = await c.post(
            "/uploads/files",
            files={"file": ("trace log.txt", b"stack trace", "text/plain")},
        )
        assert r.status_code == 201
        up = r.json()
        assert (
            up["name"] == "trace log.txt"
            and up["size"] == 11
            and up["url"].startswith("/uploads/")
        )
        got = await c.get(up["url"])
        assert got.content == b"stack trace"
        assert "attachment" in got.headers["content-disposition"]
        assert got.headers["x-content-type-options"] == "nosniff"

        # ?name= offers the original file name instead of the stored one
        named = await c.get(up["url"], params={"name": "../trace log.txt"})
        assert (
            "trace%20log.txt" in named.headers["content-disposition"]
        )  # RFC 5987 form
        bad = await c.get(up["url"], params={"name": "a\r\nSet-Cookie: x=1"})
        assert (
            "\n" not in bad.headers["content-disposition"]
            and "Set-Cookie" not in bad.headers
        )

        # active content is never rendered inline in the app's origin
        r = await c.post(
            "/uploads/files",
            files={"file": ("../evil.html", b"<script>alert(1)</script>", "text/html")},
        )
        assert r.status_code == 201 and ".." not in r.json()["url"]
        got = await c.get(r.json()["url"])
        assert got.headers["content-type"].startswith("application/octet-stream")
        assert "attachment" in got.headers["content-disposition"]

        # images keep being shown inline
        png = b"\x89PNG\r\n\x1a\n"
        r = await c.post("/uploads/images", files={"file": ("a.png", png, "image/png")})
        got = await c.get(r.json()["url"])
        assert (
            got.headers["content-type"] == "image/png"
            and "content-disposition" not in got.headers
        )


async def test_upload_size_limit(client, monkeypatch):
    import api.tickets as api_tickets

    monkeypatch.setattr(api_tickets, "MAX_ATTACHMENT_BYTES", 10)
    async with client as c:
        r = await c.post("/uploads/files", files={"file": ("big.bin", b"x" * 11)})
        assert r.status_code == 413
        r = await c.post("/uploads/files", files={"file": ("ok.bin", b"x" * 10)})
        assert r.status_code == 201
