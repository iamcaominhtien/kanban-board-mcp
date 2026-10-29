"""REST API of the Idea Space: stages, triage, merge, votes, assumptions, evidence, log, activity, promote."""

from datetime import date, timedelta

from kanban_mcp import operations as ops
from tests.test_idea_tickets import (  # noqa: F401  (fixtures)
    _create_idea,
    _create_project,
    client,
    setup_db,
)

API = "/api/idea-tickets"
TOMORROW = (date.today() + timedelta(days=1)).isoformat()


async def _stage(c, idea_id, to, **body):
    return await c.post(f"{API}/{idea_id}/stage", json={"to": to, **body})


async def _assumption(c, idea_id, text="They pay", impact="high"):
    r = await c.post(
        f"{API}/{idea_id}/assumption-records", json={"text": text, "impact": impact}
    )
    assert r.status_code == 200, r.text
    return r.json()["assumptions"][-1]


async def _ready_idea(c, project_id, title="Ready idea"):
    """An idea in Exploring with its only (high-impact) assumption validated, so Ready is allowed."""
    idea = await _create_idea(c, project_id, title=title, problem_statement="P")
    a = await _assumption(c, idea["id"])
    await c.patch(
        f"{API}/{idea['id']}/assumption-records/{a['id']}",
        json={"status": "validated"},
    )
    assert (await _stage(c, idea["id"], "exploring")).status_code == 200
    return idea, a


# ── listing and counts ─────────────────────────────────────────────────────


async def test_list_by_project_all_and_none_with_filters_and_counts(client):
    async with client as c:
        p1, p2 = await _create_project(c), await _create_project(c)
        a = await _create_idea(c, p1["id"], title="Alpha cost badge", tags=["ai"])
        b = await _create_idea(c, p2["id"], title="Beta sync")
        loose = (
            await c.post(f"{API}", json={"title": "Loose note"})
        ).json()  # no project
        await _stage(c, a["id"], "exploring")

        one = (await c.get(f"{API}/space", params={"project_id": p1["id"]})).json()
        everything = (await c.get(f"{API}/space", params={"scope": "all"})).json()
        none = (await c.get(f"{API}/space", params={"scope": "none"})).json()
        exploring = (
            await c.get(f"{API}/space", params={"scope": "all", "stage": "exploring"})
        ).json()
        tagged = (
            await c.get(f"{API}/space", params={"scope": "all", "tag": "ai"})
        ).json()
        found = (
            await c.get(f"{API}/space", params={"scope": "all", "q": "sync"})
        ).json()
        counts = (await c.get(f"{API}/counts")).json()
        bad = await c.get(f"{API}/space", params={"scope": "project"})

    assert [i["id"] for i in one] == [a["id"]]
    assert {i["id"] for i in everything} == {a["id"], b["id"], loose["id"]}
    assert [i["id"] for i in none] == [loose["id"]]
    assert [i["id"] for i in exploring] == [a["id"]]
    assert [i["id"] for i in tagged] == [a["id"]]
    assert [i["id"] for i in found] == [b["id"]]
    assert counts["total_inbox"] == 2 and counts["all"]["active"] == 1
    assert counts["none"]["stages"]["inbox"] == 1
    by_project = {x["project_id"]: x for x in counts["projects"]}
    assert by_project[p1["id"]]["stages"]["exploring"] == 1
    assert bad.status_code == 400


async def test_the_list_puts_the_ideas_closest_to_ready_first(client):
    async with client as c:
        p = await _create_project(c)
        bare = await _create_idea(c, p["id"], title="No assumptions")
        ready, _ = await _ready_idea(c, p["id"], "Validated")
        half = await _create_idea(c, p["id"], title="Half")
        await _assumption(c, half["id"], "one", "low")
        rows = (await c.get(f"{API}/space", params={"project_id": p["id"]})).json()

    assert [r["id"] for r in rows] == [ready["id"], half["id"], bare["id"]]
    assert [r["readiness"]["state"] for r in rows] == [
        "ready",
        "growing",
        "not_started",
    ]


# ── stages ─────────────────────────────────────────────────────────────────


async def test_keep_park_archive_restore_and_the_rules_around_them(client):
    async with client as c:
        p = await _create_project(c)
        idea = await _create_idea(c, p["id"])
        i = idea["id"]
        assert idea["stage"] == "inbox"

        kept = (await _stage(c, i, "exploring", via="Keep", tags=["x"])).json()
        no_date = await _stage(c, i, "parked")
        past = await _stage(c, i, "parked", park_until="2020-01-01")
        parked = (
            await _stage(c, i, "parked", park_until=TOMORROW, park_note="later")
        ).json()
        no_reason = await _stage(c, i, "archived")
        archived = (
            await _stage(
                c, i, "archived", archive_reason="not_now", archive_note="not yet"
            )
        ).json()
        restored = (await _stage(c, i, "exploring")).json()
        to_building = await _stage(c, i, "building")
        bad_reason = await c.post(
            f"{API}/{i}/stage", json={"to": "archived", "archive_reason": "bored"}
        )

    assert kept["stage"] == "exploring" and kept["tags"] == ["x"]
    assert (
        no_date.status_code == 409
        and no_date.json()["detail"]["code"] == "park_needs_date"
    )
    assert past.json()["detail"]["code"] == "park_date_past"
    assert (parked["stage"], parked["park_until"], parked["park_note"]) == (
        "parked",
        TOMORROW,
        "later",
    )
    assert no_reason.json()["detail"]["code"] == "archive_needs_reason"
    assert (
        archived["stage"],
        archived["archive_reason"],
        archived["archive_note"],
    ) == (
        "archived",
        "not_now",
        "not yet",
    )
    assert restored["stage"] == "exploring" and restored["archive_reason"] is None
    assert to_building.json()["detail"]["code"] == "use_promote"
    assert bad_reason.status_code == 422


async def test_ready_needs_the_checks_or_force_and_undo_takes_a_move_back(client):
    async with client as c:
        p = await _create_project(c)
        idea = await _create_idea(c, p["id"])
        i = idea["id"]
        await _assumption(c, i)
        await _stage(c, i, "exploring")
        refused = await _stage(c, i, "ready")
        forced = (await _stage(c, i, "ready", force=True)).json()
        undone = (await c.post(f"{API}/{i}/undo")).json()
        again = await c.post(f"{API}/{i}/undo")

    assert refused.status_code == 409
    assert refused.json()["detail"]["code"] == "not_ready"
    assert refused.json()["detail"]["readiness"]["high_open"] == 1
    assert forced["stage"] == "ready"
    assert undone["stage"] == "exploring"
    assert again.json()["detail"]["code"] == "nothing_to_undo"


async def test_park_many_parks_each_with_the_same_date(client):
    async with client as c:
        p = await _create_project(c)
        ids = [(await _create_idea(c, p["id"], title=f"I{n}"))["id"] for n in range(3)]
        rows = (
            await c.post(f"{API}/park-many", json={"ids": ids, "park_until": TOMORROW})
        ).json()

    assert [r["stage"] for r in rows] == ["parked"] * 3
    assert {r["park_until"] for r in rows} == {TOMORROW}


async def test_a_viewer_can_vote_and_comment_but_not_move_ideas(client):
    async with client as c:
        p = await _create_project(c)
        await c.post(
            f"/projects/{p['id']}/members", json={"name": "Vera", "role": "viewer"}
        )
        await c.post(
            f"/projects/{p['id']}/members", json={"name": "Mia", "role": "member"}
        )
        idea = await _create_idea(c, p["id"])
        i = idea["id"]
        as_viewer = {"X-Actor": "Vera"}
        moved = await c.post(
            f"{API}/{i}/stage", json={"to": "exploring"}, headers=as_viewer
        )
        voted = await c.post(f"{API}/{i}/vote", json={}, headers=as_viewer)
        commented = await c.post(
            f"{API}/{i}/comments", json={"body": "+1"}, headers=as_viewer
        )
        moved_by_member = await c.post(
            f"{API}/{i}/stage", json={"to": "exploring"}, headers={"X-Actor": "Mia"}
        )

    assert moved.status_code == 403 and moved.json()["detail"]["code"] == "read_only"
    assert voted.status_code == 200 and voted.json()["voters"] == ["Vera"]
    assert commented.status_code == 201 and commented.json()["author"] == "Vera"
    assert moved_by_member.status_code == 200


# ── merge, votes ───────────────────────────────────────────────────────────


async def test_merge_adds_text_and_votes_and_can_be_undone(client):
    async with client as c:
        p = await _create_project(c)
        target = await _create_idea(c, p["id"], title="Cost on card", description="T")
        source = await _create_idea(
            c, p["id"], title="Cost in members", description="S text"
        )
        await c.post(f"{API}/{source['id']}/vote", json={"voter": "Lan"})
        await c.post(f"{API}/{target['id']}/vote", json={"voter": "Tuan"})

        merged = (
            await c.post(f"{API}/{source['id']}/merge", json={"into_id": target["id"]})
        ).json()
        source_after = (await c.get(f"{API}/{source['id']}")).json()
        self_merge = await c.post(
            f"{API}/{target['id']}/merge", json={"into_id": target["id"]}
        )
        undone = (await c.post(f"{API}/{target['id']}/undo-merge")).json()
        source_back = (await c.get(f"{API}/{source['id']}")).json()
        nothing = await c.post(f"{API}/{target['id']}/undo-merge")

    assert (
        "Merged from " + source["id"] in merged["body"] and "S text" in merged["body"]
    )
    assert set(merged["voters"]) == {"Tuan", "Lan", "user"}
    assert source_after["stage"] == "archived"
    assert source_after["merged_into_id"] == target["id"]
    assert source_after["archive_note"] == f"Merged into {target['id']}"
    assert self_merge.json()["detail"]["code"] == "merge_self"
    assert "S text" not in undone["body"] and set(undone["voters"]) == {"Tuan"}
    assert source_back["stage"] == "inbox" and source_back["merged_into_id"] is None
    assert nothing.json()["detail"]["code"] == "nothing_to_undo"


async def test_a_merge_cannot_be_undone_after_ten_minutes(client):
    from datetime import datetime, timedelta, timezone
    import json

    from sqlalchemy import text

    from tests.test_idea_tickets import test_engine

    async with client as c:
        p = await _create_project(c)
        target = await _create_idea(c, p["id"], title="A")
        source = await _create_idea(c, p["id"], title="B")
        await c.post(f"{API}/{source['id']}/merge", json={"into_id": target["id"]})
        old = (datetime.now(timezone.utc) - timedelta(minutes=11)).isoformat()
        async with test_engine.begin() as conn:
            row = (
                await conn.execute(
                    text("SELECT merge_undo FROM idea_ticket WHERE id = :i"),
                    {"i": target["id"]},
                )
            ).scalar()
            undo = json.loads(row)
            undo["at"] = old
            await conn.execute(
                text("UPDATE idea_ticket SET merge_undo = :u WHERE id = :i"),
                {"u": json.dumps(undo), "i": target["id"]},
            )
        late = await c.post(f"{API}/{target['id']}/undo-merge")

    assert late.status_code == 409 and late.json()["detail"]["code"] == "undo_expired"


async def test_one_vote_per_person_and_it_can_be_taken_back(client):
    async with client as c:
        p = await _create_project(c)
        i = (await _create_idea(c, p["id"]))["id"]
        await c.post(f"{API}/{i}/vote", json={"voter": "Lan"})
        twice = (await c.post(f"{API}/{i}/vote", json={"voter": "Lan"})).json()
        back = (
            await c.post(f"{API}/{i}/vote", json={"voter": "Lan", "on": False})
        ).json()

    assert twice["votes"] == 1 and back["votes"] == 0


# ── assumptions, tests, evidence ───────────────────────────────────────────


async def test_a_test_ticket_is_linked_both_ways_and_asks_when_it_is_closed(client):
    async with client as c:
        p = await _create_project(c)
        idea = await _create_idea(c, p["id"])
        a = await _assumption(c, idea["id"])
        made = await c.post(
            f"{API}/{idea['id']}/assumption-records/{a['id']}/test-ticket",
            json={"title": "Ask 3 members"},
        )
        again = await c.post(
            f"{API}/{idea['id']}/assumption-records/{a['id']}/test-ticket", json={}
        )
        ticket = made.json()["ticket"]
        by_ticket = (await c.get(f"{API}/by-ticket/{ticket['id']}")).json()
        await c.patch(f"/tickets/{ticket['id']}", json={"status": "done"})
        after = (await c.get(f"{API}/{idea['id']}")).json()
        resolved = (
            await c.post(
                f"{API}/{idea['id']}/assumption-records/{a['id']}/resolve",
                json={"outcome": "disproved"},
            )
        ).json()
        loose = (await c.post(API, json={"title": "No project"})).json()
        la = await _assumption(c, loose["id"], "x")
        needs = await c.post(
            f"{API}/{loose['id']}/assumption-records/{la['id']}/test-ticket", json={}
        )

    assert made.status_code == 201
    assert made.json()["idea"]["assumptions"][0]["state"] == "testing"
    assert made.json()["idea"]["assumptions"][0]["test_ticket_id"] == ticket["id"]
    assert ticket["tests_assumption_id"] == a["id"]
    assert again.json()["detail"]["code"] == "already_has_test"
    assert by_ticket["tests"]["assumption_id"] == a["id"]
    assert any(e.get("meta", {}).get("asks") for e in after["activity_trail"]), (
        "closing the test ticket asks what it showed"
    )
    assert resolved["assumptions"][0]["state"] == "disproved"
    assert resolved["readiness"]["state"] == "at_risk"
    assert needs.json()["detail"]["code"] == "needs_project"


async def test_evidence_can_support_several_assumptions_and_be_removed(client):
    async with client as c:
        p = await _create_project(c)
        i = (await _create_idea(c, p["id"]))["id"]
        a1, a2 = await _assumption(c, i, "one"), await _assumption(c, i, "two", "low")
        added = await c.post(
            f"{API}/{i}/evidence",
            json={
                "assumption_ids": [a1["id"], a2["id"]],
                "kind": "link",
                "ref": "https://example.com/x",
                "title": "Pricing page",
            },
        )
        listed = (await c.get(f"{API}/{i}/evidence")).json()
        removed = await c.delete(f"{API}/{i}/evidence/{listed[0]['ids'][0]}")
        unknown = await c.post(
            f"{API}/{i}/evidence",
            json={"assumption_ids": ["nope"], "kind": "link", "ref": "x"},
        )

    assert added.status_code == 201 and added.json()["evidence_count"] == 2
    assert len(listed) == 1 and len(listed[0]["assumptions"]) == 2
    assert removed.json()["evidence_count"] == 1
    assert unknown.status_code == 404


# ── comments, log, activity ────────────────────────────────────────────────


async def test_comments_and_the_research_log(client):
    async with client as c:
        p = await _create_project(c)
        i = (await _create_idea(c, p["id"]))["id"]
        a = await _assumption(c, i)
        comment = (await c.post(f"{API}/{i}/comments", json={"body": "hello"})).json()
        edited = (
            await c.patch(f"{API}/{i}/comments/{comment['id']}", json={"body": "hi"})
        ).json()
        entry = (
            await c.post(
                f"{API}/{i}/log",
                json={
                    "kind": "finding",
                    "body": "5 of 8 checked",
                    "assumption_id": a["id"],
                },
            )
        ).json()
        await c.post(f"{API}/{i}/log", json={"kind": "note", "body": "later"})
        pinned = (
            await c.patch(f"{API}/{i}/log/{entry['id']}", json={"pinned": True})
        ).json()
        log = (await c.get(f"{API}/{i}/log")).json()
        evidence = (
            await c.post(
                f"{API}/{i}/log/{entry['id']}/evidence", json={"assumption_id": a["id"]}
            )
        ).json()
        await c.delete(f"{API}/{i}/comments/{comment['id']}")
        gone = (await c.get(f"{API}/{i}/comments")).json()
        bad = await c.post(f"{API}/{i}/log", json={"kind": "gossip", "body": "x"})
        await _stage(c, i, "archived", archive_reason="other")
        closed = await c.post(f"{API}/{i}/log", json={"kind": "note", "body": "x"})

    assert comment["author"] == "user" and edited["body"] == "hi"
    assert pinned["pinned"] is True and log[0]["id"] == entry["id"]
    assert evidence["assumptions"][0]["evidence"][0]["kind"] == "note"
    assert gone == []
    assert bad.status_code == 422
    assert (
        closed.status_code == 409 and closed.json()["detail"]["code"] == "idea_closed"
    )


async def test_activity_has_authors_kinds_and_filter_counts(client):
    async with client as c:
        p = await _create_project(c)
        i = (await _create_idea(c, p["id"]))["id"]
        await _assumption(c, i)
        await _stage(c, i, "exploring", via="Keep")
        await c.patch(f"{API}/{i}/page", json={"body": "new text", "ai": True})
        everything = (await c.get(f"{API}/{i}/activity")).json()
        stage = (await c.get(f"{API}/{i}/activity", params={"filter": "stage"})).json()
        ai = (await c.get(f"{API}/{i}/activity", params={"filter": "ai"})).json()
        bad = await c.get(f"{API}/{i}/activity", params={"filter": "nope"})

    assert everything["counts"]["all"] == 4
    assert (
        everything["counts"]["assumptions"] == 1 and everything["counts"]["page"] == 1
    )
    assert [e.get("meta", {}).get("to") for e in stage["items"]] == ["exploring", None]
    assert [e["kind"] for e in stage["items"]] == ["stage", "created"]
    assert all(e["author"] == "user" for e in everything["items"])
    assert len(ai["items"]) == 1 and ai["items"][0]["kind"] == "page"
    assert bad.status_code == 422


# ── promote and the ticket side ────────────────────────────────────────────


async def test_promote_preview_then_create_builds_the_ticket_from_the_idea(client):
    async with client as c:
        p = await _create_project(c)
        idea = await _create_idea(
            c, p["id"], title="Cost badge", problem_statement="People ask the cost"
        )
        i = idea["id"]
        done = await _assumption(c, i, "Fits on the card", "low")
        open_ = await _assumption(c, i, "Price table stays current", "high")
        await c.patch(
            f"{API}/{i}/assumption-records/{done['id']}", json={"status": "validated"}
        )
        await c.post(f"{API}/{i}/vote", json={"voter": "Lan"})
        await c.post(f"{API}/{i}/vote", json={"voter": "Hoa"})
        await _stage(c, i, "exploring")

        preview = (await c.get(f"{API}/{i}/promote/preview")).json()
        no_ack = await c.post(f"{API}/{i}/promote", json={})
        made = await c.post(f"{API}/{i}/promote", json={"acknowledge_not_ready": True})
        again = await c.post(f"{API}/{i}/promote", json={"acknowledge_not_ready": True})
        ticket = made.json()["ticket"]
        context = (await c.get(f"{API}/by-ticket/{ticket['id']}")).json()
        listed = (await c.get(f"/projects/{p['id']}/tickets")).json()

    assert preview["can_promote"] and preview["not_ready"]["high_open"] == 1
    assert [x["text"] for x in preview["draft"]["checklist"]] == [open_["text"]]
    assert preview["draft"]["confirmed"] == ["Fits on the card"]
    assert preview["draft"]["demand"] == "2 people want this"
    assert "### Already confirmed" in preview["draft"]["description"]
    assert no_ack.status_code == 409 and no_ack.json()["detail"]["code"] == "not_ready"
    assert made.status_code == 201
    assert made.json()["idea"]["stage"] == "building"
    assert made.json()["idea"]["ticket"]["id"] == ticket["id"]
    assert ticket["from_idea_id"] == i
    assert [s["text"] for s in ticket["sub_tasks"]] == [open_["text"]]
    assert again.json()["detail"]["code"] == "already_promoted"
    assert context["from_idea"]["assumptions_checked"] == 1
    assert context["from_idea"]["demand"] == "2 people want this"
    assert any(t.get("from_idea_id") == i for t in listed)


async def test_promote_can_split_into_sub_tickets_and_assigns_a_project(client):
    async with client as c:
        p = await _create_project(c)
        idea = (await c.post(API, json={"title": "Loose idea"})).json()
        i = idea["id"]
        await _stage(c, i, "exploring")
        needs = await c.post(f"{API}/{i}/promote", json={"acknowledge_not_ready": True})
        made = await c.post(
            f"{API}/{i}/promote",
            json={
                "project_id": p["id"],
                "acknowledge_not_ready": True,
                "sub_tickets": ["Price table", "Estimate on the card"],
            },
        )

    assert needs.json()["detail"]["code"] == "needs_project"
    body = made.json()
    assert body["idea"]["project_id"] == p["id"]
    assert [t["title"] for t in body["sub_tickets"]] == [
        "Price table",
        "Estimate on the card",
    ]
    assert {t["parent_id"] for t in body["sub_tickets"]} == {body["ticket"]["id"]}


async def test_the_idea_follows_its_ticket_done_wont_do_reopen_and_delete(client):
    async def promoted(c, p, title):
        idea = await _create_idea(c, p["id"], title=title)
        r = await c.post(
            f"{API}/{idea['id']}/promote", json={"acknowledge_not_ready": True}
        )
        return idea["id"], r.json()["ticket"]["id"]

    async with client as c:
        p = await _create_project(c)
        shipped, t1 = await promoted(c, p, "Ships")
        dropped, t2 = await promoted(c, p, "Dropped")
        deleted, t3 = await promoted(c, p, "Deleted")

        await c.patch(f"/tickets/{t1}", json={"status": "in-progress"})
        building = (await c.get(f"{API}/{shipped}")).json()["stage"]
        await c.patch(f"/tickets/{t1}", json={"status": "done"})
        done = (await c.get(f"{API}/{shipped}")).json()
        archive_while_done = await _stage(
            c, shipped, "exploring"
        )  # reopen the idea by hand
        await c.patch(
            f"/tickets/{t2}", json={"status": "wont_do", "wont_do_reason": "no"}
        )
        wont = (await c.get(f"{API}/{dropped}")).json()
        again = await c.post(
            f"{API}/{dropped}/promote", json={"acknowledge_not_ready": True}
        )
        await c.delete(f"/tickets/{t3}")
        gone = (await c.get(f"{API}/{deleted}")).json()

    assert building == "building"
    assert done["stage"] == "shipped" and done["shipped_at"]
    assert archive_while_done.status_code == 200
    assert wont["stage"] == "exploring" and wont["ticket"] is None
    assert wont["former_ticket_id"] == t2
    assert again.status_code == 201, (
        "an idea whose ticket was dropped can be promoted again"
    )
    assert gone["stage"] == "ready" and gone["former_ticket_id"] == t3


async def test_a_building_idea_cannot_be_archived_or_dropped(client):
    async with client as c:
        p = await _create_project(c)
        idea = await _create_idea(c, p["id"])
        i = idea["id"]
        await c.post(f"{API}/{i}/promote", json={"acknowledge_not_ready": True})
        archived = await _stage(c, i, "archived", archive_reason="other")
        legacy = await c.patch(f"{API}/{i}/status", json={"new_status": "dropped"})

    assert archived.status_code == 409
    assert archived.json()["detail"]["code"] == "building_locked"
    assert legacy.status_code == 400


# ── similarity ─────────────────────────────────────────────────────────────


async def test_similar_ideas_tickets_and_tags_are_found_without_a_model(client):
    async with client as c:
        p = await _create_project(c)
        like = await _create_idea(
            c,
            p["id"],
            title="Show cost on every AI run card",
            description="People ask what a run cost before they start it",
            tags=["ai", "cost"],
        )
        await _create_idea(c, p["id"], title="Dark mode for Docs")
        await c.post(
            f"/projects/{p['id']}/tickets",
            json={
                "title": "Cost estimate on the run card",
                "description": "show the AI run cost",
            },
        )
        found = (
            await c.get(
                f"{API}/similar",
                params={"text": "Show cost on the AI run card", "project_id": p["id"]},
            )
        ).json()
        tags = (
            await c.get(
                f"{API}/tag-suggestions", params={"text": "AI run card cost estimate"}
            )
        ).json()
        nothing = (await c.get(f"{API}/similar", params={"text": "the and of"})).json()

    assert like["id"] in [f["id"] for f in found[:2]] and found[0]["score"] >= 0.5
    assert {f["kind"] for f in found} == {"idea", "ticket"}
    assert "Dark mode for Docs" not in [f["title"] for f in found]
    assert "ai" in tags and "cost" in tags
    assert nothing == []


# ── MCP: AI members read and suggest only ──────────────────────────────────


async def test_an_ai_member_can_read_ideas_and_add_to_the_inbox_only(client):
    async with client as c:
        p = await _create_project(c)
        created = await ops.create_idea_ticket(
            title="Split the card renderer",
            description="It is 480 lines.",
            project_id=p["id"],
            why="Out of scope for KAN-231",
            ticket_id="KAN-231",
        )
        listed = await ops.list_idea_tickets(project_id=p["id"])
        assumptions = await ops.list_idea_assumptions(created["id"])
        trail = await ops.get_idea_activity_trail(created["id"])

    assert created["stage"] == "inbox" and created["source"] == "ai"
    assert created["source_ref"]["why"] == "Out of scope for KAN-231"
    assert created["source_ref"]["id"] == "KAN-231"
    assert created["created_by"] == "agent"
    assert [i["id"] for i in listed] == [created["id"]]
    assert assumptions["readiness"]["state"] == "not_started"
    assert trail[-1]["ai"] is True
    assert not hasattr(ops, "update_idea_status")
    assert not hasattr(ops, "promote_idea_to_ticket")
    assert not hasattr(ops, "delete_idea_ticket")


async def test_the_old_status_endpoint_keeps_working_for_the_current_board(client):
    async with client as c:
        p = await _create_project(c)
        i = (await _create_idea(c, p["id"]))["id"]
        r = await c.patch(f"{API}/{i}/status", json={"new_status": "in_review"})
        got = (await c.get(f"{API}/{i}")).json()

    assert r.status_code == 200
    assert got["stage"] == "exploring" and got["idea_status"] == "in_review"
