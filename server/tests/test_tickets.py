from collections.abc import AsyncGenerator

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from database import get_session
from main import app

DATABASE_URL_TEST = "sqlite+aiosqlite:///:memory:"

test_engine = create_async_engine(DATABASE_URL_TEST, echo=False)
test_async_session = sessionmaker(
    test_engine, class_=AsyncSession, expire_on_commit=False
)


async def override_get_session() -> AsyncGenerator[AsyncSession, None]:
    async with test_async_session() as session:
        yield session


@pytest.fixture(autouse=True)
async def setup_db():
    async with test_engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    app.dependency_overrides[get_session] = override_get_session
    yield
    app.dependency_overrides.pop(get_session, None)
    async with test_engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.drop_all)


@pytest.fixture
def client():
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _create_project(c: httpx.AsyncClient, prefix: str = "TST") -> dict:
    r = await c.post(
        "/projects", json={"name": "Test Project", "prefix": prefix, "color": "#123456"}
    )
    assert r.status_code == 201
    return r.json()


async def _create_ticket(
    c: httpx.AsyncClient, project_id: str, title: str = "My ticket", **kwargs
) -> dict:
    body = {"title": title, **kwargs}
    r = await c.post(f"/projects/{project_id}/tickets", json=body)
    assert r.status_code == 201
    return r.json()


# ---------------------------------------------------------------------------
# Core CRUD
# ---------------------------------------------------------------------------


async def test_create_ticket_appears_in_list(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"], "First ticket")
        r = await c.get(f"/projects/{project['id']}/tickets")
    assert r.status_code == 200
    tickets = r.json()
    assert len(tickets) == 1
    assert tickets[0]["id"] == ticket["id"]
    assert tickets[0]["title"] == "First ticket"


async def test_get_ticket_404_if_missing(client: httpx.AsyncClient):
    async with client as c:
        r = await c.get("/tickets/DOESNOTEXIST-999")
    assert r.status_code == 404


async def test_update_ticket_title_logs_activity(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"], "Old title")
        r = await c.patch(f"/tickets/{ticket['id']}", json={"title": "New title"})
    assert r.status_code == 200
    body = r.json()
    assert body["title"] == "New title"
    assert any(
        e["field"] == "title" and e["from"] == "Old title" and e["to"] == "New title"
        for e in body["activity_log"]
    )


async def test_update_ticket_status_logs_activity(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])
        r = await c.patch(f"/tickets/{ticket['id']}", json={"status": "in-progress"})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "in-progress"
    assert any(
        e["field"] == "status" and e["to"] == "in-progress"
        for e in body["activity_log"]
    )


async def test_update_ticket_description_and_tags_logs_activity(
    client: httpx.AsyncClient,
):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])
        r = await c.patch(
            f"/tickets/{ticket['id']}",
            json={
                "description": "Updated description content",
                "tags": ["FRONTEND", "UI"],
            },
        )
    assert r.status_code == 200
    body = r.json()
    assert body["description"] == "Updated description content"
    assert any(
        e["field"] == "description" and e["to"] == "Updated description content"
        for e in body["activity_log"]
    )
    assert any(
        e["field"] == "tags" and e["to"] == ["FRONTEND", "UI"]
        for e in body["activity_log"]
    )


async def test_delete_ticket_then_404(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])
        r_del = await c.delete(f"/tickets/{ticket['id']}")
        assert r_del.status_code == 204
        r_get = await c.get(f"/tickets/{ticket['id']}")
    assert r_get.status_code == 404


async def test_quick_status_patch(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])
        r = await c.patch(f"/tickets/{ticket['id']}/status", json={"status": "done"})
    assert r.status_code == 200
    assert r.json()["status"] == "done"


# ---------------------------------------------------------------------------
# Parent / child nesting
# ---------------------------------------------------------------------------


async def test_create_child_ticket(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        parent = await _create_ticket(c, project["id"], "Parent")
        child = await _create_ticket(c, project["id"], "Child", parent_id=parent["id"])
    assert child["parent_id"] == parent["id"]


async def test_create_child_of_child_returns_400(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        parent = await _create_ticket(c, project["id"], "Parent")
        child = await _create_ticket(c, project["id"], "Child", parent_id=parent["id"])
        r = await c.post(
            f"/projects/{project['id']}/tickets",
            json={"title": "Grandchild", "parent_id": child["id"]},
        )
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# Comments
# ---------------------------------------------------------------------------


async def test_add_and_delete_comment(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])

        r_add = await c.post(
            f"/tickets/{ticket['id']}/comments",
            json={"text": "Hello", "author": "alice"},
        )
        assert r_add.status_code == 200
        comments = r_add.json()["comments"]
        assert len(comments) == 1
        assert comments[0]["text"] == "Hello"
        comment_id = comments[0]["id"]

        r_del = await c.delete(f"/tickets/{ticket['id']}/comments/{comment_id}")
    assert r_del.status_code == 200
    assert r_del.json()["comments"] == []


async def test_update_comment(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])

        r_add = await c.post(
            f"/tickets/{ticket['id']}/comments",
            json={"text": "Hello", "author": "alice"},
        )
        comment_id = r_add.json()["comments"][0]["id"]

        r_patch = await c.patch(
            f"/tickets/{ticket['id']}/comments/{comment_id}",
            json={"text": "## Updated\n\n- with markdown"},
        )
        assert r_patch.status_code == 200
        comments = r_patch.json()["comments"]
        assert len(comments) == 1
        assert comments[0]["id"] == comment_id
        assert comments[0]["text"] == "## Updated\n\n- with markdown"
        assert comments[0]["author"] == "alice"


async def test_update_comment_unknown_returns_404(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])

        r_patch = await c.patch(
            f"/tickets/{ticket['id']}/comments/does-not-exist",
            json={"text": "new text"},
        )
    assert r_patch.status_code == 404


# ---------------------------------------------------------------------------
# Acceptance criteria
# ---------------------------------------------------------------------------


async def test_add_toggle_delete_acceptance_criterion(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])

        r_add = await c.post(
            f"/tickets/{ticket['id']}/acceptance-criteria", json={"text": "It works"}
        )
        assert r_add.status_code == 200
        acs = r_add.json()["acceptance_criteria"]
        assert len(acs) == 1
        assert acs[0]["done"] is False
        ac_id = acs[0]["id"]

        r_toggle = await c.patch(
            f"/tickets/{ticket['id']}/acceptance-criteria/{ac_id}/toggle"
        )
        assert r_toggle.status_code == 200
        ac_after = r_toggle.json()["acceptance_criteria"][0]
        assert ac_after["done"] is True

        r_del = await c.delete(f"/tickets/{ticket['id']}/acceptance-criteria/{ac_id}")
    assert r_del.status_code == 200
    assert r_del.json()["acceptance_criteria"] == []


# ---------------------------------------------------------------------------
# Sub-tasks (checklist items)
# ---------------------------------------------------------------------------


async def test_add_toggle_delete_sub_task(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])
        assert ticket["sub_tasks"] == []

        r_add = await c.post(
            f"/tickets/{ticket['id']}/sub-tasks", json={"text": "Confirm spec"}
        )
        assert r_add.status_code == 200
        items = r_add.json()["sub_tasks"]
        assert [(i["text"], i["done"]) for i in items] == [("Confirm spec", False)]
        sub_id = items[0]["id"]

        r_toggle = await c.patch(f"/tickets/{ticket['id']}/sub-tasks/{sub_id}/toggle")
        assert r_toggle.json()["sub_tasks"][0]["done"] is True

        r_blank = await c.post(
            f"/tickets/{ticket['id']}/sub-tasks", json={"text": "  "}
        )
        assert r_blank.status_code == 400

        r_del = await c.delete(f"/tickets/{ticket['id']}/sub-tasks/{sub_id}")
        assert r_del.status_code == 200
        assert r_del.json()["sub_tasks"] == []

        r_missing = await c.post("/tickets/NOPE-1/sub-tasks", json={"text": "x"})
    assert r_missing.status_code == 404


# ---------------------------------------------------------------------------
# Work log
# ---------------------------------------------------------------------------


async def test_add_work_log(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])
        r = await c.post(
            f"/tickets/{ticket['id']}/work-log",
            json={"author": "bob", "role": "Developer", "note": "Did stuff"},
        )
    assert r.status_code == 200
    wl = r.json()["work_log"]
    assert len(wl) == 1
    assert wl[0]["note"] == "Did stuff"


async def test_delete_work_log(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])
        r_add = await c.post(
            f"/tickets/{ticket['id']}/work-log",
            json={"author": "alice", "role": "Tester", "note": "Reviewed"},
        )
        assert r_add.status_code == 200
        log_id = r_add.json()["work_log"][0]["id"]
        r_del = await c.delete(f"/tickets/{ticket['id']}/work-log/{log_id}")
    assert r_del.status_code == 200
    assert r_del.json()["work_log"] == []


async def test_debug_space_extended_work_log_and_update(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])
        # Links must point at a real branch and test case of the ticket
        await c.post(
            f"/tickets/{ticket['id']}/branches", json={"name": "fix/jwt-decode"}
        )
        await c.post(
            f"/tickets/{ticket['id']}/test-cases", json={"title": "jwt decode"}
        )

        # Add rich debug entry
        r_add = await c.post(
            f"/tickets/{ticket['id']}/work-log",
            json={
                "author": "An",
                "role": "Tester",
                "note": "Found null pointer in JWT decoder",
                "kind": "investigation",
                "pinned": True,
                "attachments": [
                    {"id": "att-1", "name": "trace.log", "url": "/uploads/trace.log"}
                ],
                "linked_branch": "fix/jwt-decode",
                "linked_test_case": "TC-1",
            },
        )
        assert r_add.status_code == 200
        wl = r_add.json()["work_log"]
        assert len(wl) == 1
        entry = wl[0]
        assert entry["author"] == "An"
        assert entry["kind"] == "investigation"
        assert entry["pinned"] is True
        assert len(entry["attachments"]) == 1
        assert entry["linked_branch"] == "fix/jwt-decode"
        assert entry["linked_test_case"] == "TC-1"
        assert entry["at"] is not None

        # Update debug entry (change to root_cause, modify note)
        log_id = entry["id"]
        r_patch = await c.patch(
            f"/tickets/{ticket['id']}/work-log/{log_id}",
            json={
                "kind": "root_cause",
                "note": "Confirmed root cause: missing fallback when token header has no kid",
                "pinned": True,
            },
        )
        assert r_patch.status_code == 200
        entry_upd = r_patch.json()["work_log"][0]
        assert entry_upd["kind"] == "root_cause"
        assert (
            entry_upd["note"]
            == "Confirmed root cause: missing fallback when token header has no kid"
        )
        assert entry_upd["pinned"] is True
        assert entry_upd["updated_at"] is not None


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------


async def test_add_update_delete_test_case(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])

        r_add = await c.post(
            f"/tickets/{ticket['id']}/test-cases",
            json={"title": "TC1", "status": "pending"},
        )
        assert r_add.status_code == 200
        tcs = r_add.json()["test_cases"]
        assert len(tcs) == 1
        tc_id = tcs[0]["id"]
        assert tcs[0]["status"] == "pending"

        r_upd = await c.patch(
            f"/tickets/{ticket['id']}/test-cases/{tc_id}",
            json={"status": "pass", "proof": "screenshot.png"},
        )
        assert r_upd.status_code == 200
        tc_after = r_upd.json()["test_cases"][0]
        assert tc_after["status"] == "pass"
        assert tc_after["proof"] == "screenshot.png"

        r_del = await c.delete(f"/tickets/{ticket['id']}/test-cases/{tc_id}")
    assert r_del.status_code == 200
    assert r_del.json()["test_cases"] == []


async def test_test_case_extended_fields_and_running_status(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])

        # Add first TC with running status & extended fields
        r1 = await c.post(
            f"/tickets/{ticket['id']}/test-cases",
            json={
                "title": "Verify login with OAuth",
                "status": "running",
                "description": "User clicks Google button and completes auth",
                "expected_result": "Redirect to dashboard with valid JWT",
                "notes": "Testing against staging OAuth provider",
                "assignee": "alex",
            },
        )
        assert r1.status_code == 200
        tc1 = r1.json()["test_cases"][0]
        assert tc1["code"] == "TC-1"
        assert tc1["status"] == "running"
        assert tc1["started_at"] is not None
        assert tc1["description"] == "User clicks Google button and completes auth"
        assert tc1["expected_result"] == "Redirect to dashboard with valid JWT"
        assert tc1["assignee"] == "alex"

        # Add second TC
        r2 = await c.post(
            f"/tickets/{ticket['id']}/test-cases",
            json={"title": "Verify password reset", "status": "pending"},
        )
        assert r2.status_code == 200
        tc2 = r2.json()["test_cases"][1]
        assert tc2["code"] == "TC-2"
        assert tc2["status"] == "pending"

        # Update first TC to pass
        r_upd = await c.patch(
            f"/tickets/{ticket['id']}/test-cases/{tc1['id']}",
            json={
                "status": "pass",
                "notes": "OAuth returned status 200, JWT verified in local storage",
            },
        )
        assert r_upd.status_code == 200
        tc1_updated = r_upd.json()["test_cases"][0]
        assert tc1_updated["status"] == "pass"
        assert (
            tc1_updated["notes"]
            == "OAuth returned status 200, JWT verified in local storage"
        )


# ---------------------------------------------------------------------------
# List with filters
# ---------------------------------------------------------------------------


async def test_list_tickets_with_status_filter(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        t1 = await _create_ticket(c, project["id"], "Backlog ticket")
        await c.patch(f"/tickets/{t1['id']}/status", json={"status": "done"})
        await _create_ticket(c, project["id"], "Another backlog ticket")

        r = await c.get(f"/projects/{project['id']}/tickets", params={"status": "done"})
    assert r.status_code == 200
    results = r.json()
    assert len(results) == 1
    assert results[0]["status"] == "done"


# ---------------------------------------------------------------------------
# Fuzzy search (`q`)
# ---------------------------------------------------------------------------


async def test_search_by_ticket_id_substring(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c, prefix="MON")
        ticket = await _create_ticket(c, project["id"], "Unrelated title")
        number = ticket["id"].split("-")[1]

        r = await c.get(f"/projects/{project['id']}/tickets", params={"q": number})
    assert r.status_code == 200
    results = r.json()
    assert len(results) == 1
    assert results[0]["id"] == ticket["id"]


async def test_search_by_title_fuzzy(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"], "Fix login page crash")
        await _create_ticket(c, project["id"], "Improve onboarding flow")

        # Slightly misspelled / partial query should still match via fuzzy scoring.
        r = await c.get(f"/projects/{project['id']}/tickets", params={"q": "login pge"})
    assert r.status_code == 200
    results = r.json()
    assert len(results) == 1
    assert results[0]["id"] == ticket["id"]


async def test_search_by_description(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(
            c,
            project["id"],
            "Generic title",
            description="Users cannot reset their password",
        )
        await _create_ticket(c, project["id"], "Another generic title")

        r = await c.get(
            f"/projects/{project['id']}/tickets", params={"q": "reset password"}
        )
    assert r.status_code == 200
    results = r.json()
    assert len(results) == 1
    assert results[0]["id"] == ticket["id"]


async def test_search_by_tag(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(
            c, project["id"], "Generic title", tags=["backend"]
        )
        await _create_ticket(c, project["id"], "Other ticket", tags=["frontend"])

        r = await c.get(f"/projects/{project['id']}/tickets", params={"q": "backend"})
    assert r.status_code == 200
    results = r.json()
    assert len(results) == 1
    assert results[0]["id"] == ticket["id"]


async def test_search_no_match_returns_empty(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        await _create_ticket(c, project["id"], "Fix login page crash")

        r = await c.get(
            f"/projects/{project['id']}/tickets", params={"q": "zzzzz nonexistent"}
        )
    assert r.status_code == 200
    assert r.json() == []


# ---------------------------------------------------------------------------
# Wont Do status
# ---------------------------------------------------------------------------


async def test_set_wont_do_requires_reason(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])
        r = await c.patch(f"/tickets/{ticket['id']}", json={"status": "wont_do"})
    assert r.status_code == 400
    assert "wont_do_reason" in r.json()["detail"]


async def test_set_wont_do_with_reason(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])
        r = await c.patch(
            f"/tickets/{ticket['id']}",
            json={"status": "wont_do", "wont_do_reason": "Out of scope"},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "wont_do"
    assert body["wont_do_reason"] == "Out of scope"


async def test_wont_do_tickets_excluded_by_default(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        t1 = await _create_ticket(c, project["id"], "Normal ticket")
        t2 = await _create_ticket(c, project["id"], "Wont do ticket")
        await c.patch(
            f"/tickets/{t2['id']}",
            json={"status": "wont_do", "wont_do_reason": "Not needed"},
        )
        r_default = await c.get(f"/projects/{project['id']}/tickets")
        r_include = await c.get(
            f"/projects/{project['id']}/tickets", params={"include_wont_do": "true"}
        )
    assert r_default.status_code == 200
    default_ids = [t["id"] for t in r_default.json()]
    assert t1["id"] in default_ids
    assert t2["id"] not in default_ids

    all_ids = [t["id"] for t in r_include.json()]
    assert t1["id"] in all_ids
    assert t2["id"] in all_ids


async def test_set_wont_do_with_null_reason_returns_400(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])
        r = await c.patch(
            f"/tickets/{ticket['id']}",
            json={"status": "wont_do", "wont_do_reason": None},
        )
    assert r.status_code == 400
    assert "wont_do_reason" in r.json()["detail"]


async def test_child_ticket_cannot_be_set_to_wont_do(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        parent = await _create_ticket(c, project["id"], "Parent ticket")
        child = await _create_ticket(
            c, project["id"], "Child ticket", parent_id=parent["id"]
        )
        r = await c.patch(
            f"/tickets/{child['id']}",
            json={"status": "wont_do", "wont_do_reason": "Not needed"},
        )
    assert r.status_code == 400
    assert "Child" in r.json()["detail"] or "wont_do" in r.json()["detail"]


async def test_restore_ticket_clears_wont_do_reason(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])
        await c.patch(
            f"/tickets/{ticket['id']}",
            json={"status": "wont_do", "wont_do_reason": "Out of scope"},
        )
        r = await c.patch(
            f"/tickets/{ticket['id']}",
            json={"status": "backlog"},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "backlog"
    assert body["wont_do_reason"] is None


async def test_review_and_testing_status_transitions(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])

        # Update to review
        r = await c.patch(
            f"/tickets/{ticket['id']}/status",
            json={"status": "review"},
        )
        assert r.status_code == 200
        assert r.json()["status"] == "review"

        # Update to testing
        r = await c.patch(
            f"/tickets/{ticket['id']}/status",
            json={"status": "testing"},
        )
        assert r.status_code == 200
        assert r.json()["status"] == "testing"


async def test_branch_crud_operations(client: httpx.AsyncClient):
    async with client as c:
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])

        # Create branch
        r_create = await c.post(
            f"/tickets/{ticket['id']}/branches",
            json={
                "name": "feature/attachments",
                "branch_from": "main",
                "status": "open",
                "ahead_count": 2,
                "behind_count": 1,
            },
        )
        assert r_create.status_code == 201
        branches = r_create.json()["branches"]
        assert len(branches) == 1
        branch = branches[0]
        assert branch["name"] == "feature/attachments"
        assert branch["status"] == "open"
        assert branch["branch_from"] == "main"
        assert branch["ahead_count"] == 2
        assert branch["behind_count"] == 1
        branch_id = branch["id"]

        # List branches
        r_list = await c.get(f"/tickets/{ticket['id']}/branches")
        assert r_list.status_code == 200
        assert len(r_list.json()) == 1

        # Patch branch
        r_patch = await c.patch(
            f"/tickets/{ticket['id']}/branches/{branch_id}",
            json={
                "status": "merged",
                "pr_url": "https://github.com/example/repo/pull/42",
            },
        )
        assert r_patch.status_code == 200
        updated_branch = r_patch.json()["branches"][0]
        assert updated_branch["status"] == "merged"
        assert updated_branch["pr_url"] == "https://github.com/example/repo/pull/42"

        # Delete branch
        r_del = await c.delete(f"/tickets/{ticket['id']}/branches/{branch_id}")
        assert r_del.status_code == 200
        assert r_del.json()["branches"] == []


async def test_workspace_settings_and_ticket_retention(client: httpx.AsyncClient):
    async with client as c:
        # Get settings
        r_get = await c.get("/workspace/settings")
        assert r_get.status_code == 200
        settings = r_get.json()
        assert settings["enabled"] is True
        assert settings["default_retention_days"] == 14

        # Patch settings
        r_patch = await c.patch(
            "/workspace/settings",
            json={"default_retention_days": 30},
        )
        assert r_patch.status_code == 200
        assert r_patch.json()["default_retention_days"] == 30

        # Ticket workspace
        project = await _create_project(c)
        ticket = await _create_ticket(c, project["id"])

        r_ws = await c.get(f"/tickets/{ticket['id']}/workspace")
        assert r_ws.status_code == 200
        ws_info = r_ws.json()
        assert ws_info["enabled"] is True
        assert ws_info["retention_days"] == 30
        assert "files" in ws_info

        # Override retention per task
        r_override = await c.patch(
            f"/tickets/{ticket['id']}/workspace/retention",
            json={"retention_days": 7},
        )
        assert r_override.status_code == 200
        assert r_override.json()["workspace_retention_days"] == 7

        r_ws2 = await c.get(f"/tickets/{ticket['id']}/workspace")
        assert r_ws2.json()["retention_days"] == 7


async def test_remove_member_blocked_when_assigned_to_open_tickets(
    client: httpx.AsyncClient,
):
    async with client as c:
        project = await _create_project(c)
        # Create member
        r_mem = await c.post(
            f"/projects/{project['id']}/members",
            json={"name": "An Nguyen", "color": "#2E6F40"},
        )
        assert r_mem.status_code == 201
        member_id = r_mem.json()["id"]

        # Create ticket assigned to member
        ticket = await _create_ticket(c, project["id"], title="Task for An")
        r_assign = await c.patch(
            f"/tickets/{ticket['id']}",
            json={"assignee": member_id},
        )
        assert r_assign.status_code == 200
        assert r_assign.json()["assignee"] == member_id

        # Try to delete member while assigned to open ticket
        r_del_blocked = await c.delete(f"/projects/{project['id']}/members/{member_id}")
        assert r_del_blocked.status_code == 400
        assert (
            "Cannot remove: assigned to 1 open ticket" in r_del_blocked.json()["detail"]
        )

        # Close ticket
        r_done = await c.patch(
            f"/tickets/{ticket['id']}/status",
            json={"status": "done"},
        )
        assert r_done.status_code == 200

        # Now delete member should succeed
        r_del_ok = await c.delete(f"/projects/{project['id']}/members/{member_id}")
        assert r_del_ok.status_code == 204
