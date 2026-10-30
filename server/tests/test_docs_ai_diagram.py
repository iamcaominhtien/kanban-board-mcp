"""Draw a diagram: the AI member draws a section as an editable draw.io diagram or changes an existing one; the XML
is checked before anything is saved; the page is not touched; viewers cannot start it."""

from tests.docs_ai_helpers import H, env, fake, page, setup  # noqa: F401
from tests.test_docs_ai_threads import _wait

GRAPH = (
    '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>'
    '<mxCell id="a" value="Client" style="rounded=1;" vertex="1" parent="1">'
    '<mxGeometry x="40" y="40" width="120" height="50" as="geometry"/></mxCell>'
    '<mxCell id="b" value="API" style="rounded=1;" vertex="1" parent="1">'
    '<mxGeometry x="240" y="40" width="120" height="50" as="geometry"/></mxCell>'
    '<mxCell id="e" value="" style="endArrow=classic;" edge="1" parent="1" source="a" target="b">'
    '<mxGeometry relative="1" as="geometry"/></mxCell></root></mxGraphModel>'
)
TEXT = "## Flow\n\nThe client calls the API. The API answers with JSON.\n"


async def _draw(c, page_id, **body):
    r = await c.post(f"/docs/pages/{page_id}/ai/diagram", json=body, headers=H)
    assert r.status_code == 202, r.text
    return await _wait(c, r.json()["id"])


async def test_a_section_becomes_an_editable_diagram_and_the_page_is_untouched(
    env, fake
):
    c, pid, m = await setup(env)
    p = await page(c, pid, "API", TEXT)
    fake.queue.append(f"Here you go:\n```xml\n{GRAPH}\n```")
    job = await _draw(c, p["id"], selection="The client calls the API.")
    assert job["state"] == "finished", job
    res = job["result"]
    assert res["changed"] is False and res["version"] == 1
    assert res["markdown"] == f"[API](diagram:{res['diagram_id']})"
    assert "The client calls the API." in fake.prompts[-1]
    d = (await c.get(f"/diagrams/{res['diagram_id']}", headers=H)).json()
    assert d["version"] == 1 and d["item_kind"] == "doc" and d["item_id"] == p["id"]
    cur = (await c.get(f"/docs/pages/{p['id']}", headers=H)).json()
    assert cur["version"] == 1 and cur["markdown"] == TEXT and cur["draft"] is None


async def test_an_existing_diagram_gets_a_new_version(env, fake):
    c, pid, m = await setup(env)
    p = await page(c, pid, "API", TEXT)
    fake.queue.append(GRAPH)
    first = (await _draw(c, p["id"]))["result"]
    changed = GRAPH.replace("Client", "Browser")
    fake.queue.append(changed)
    job = await _draw(
        c,
        p["id"],
        diagram_id=first["diagram_id"],
        instruction="Rename Client to Browser",
    )
    assert job["state"] == "finished", job
    assert job["result"]["changed"] is True and job["result"]["version"] == 2
    assert (
        "Client" in fake.prompts[-1] and "Rename Client to Browser" in fake.prompts[-1]
    )


async def test_a_reply_that_is_not_a_diagram_saves_nothing(env, fake):
    c, pid, m = await setup(env)
    p = await page(c, pid, "API", TEXT)
    fake.queue.append("Sorry, I cannot draw that.")
    job = await _draw(c, p["id"])
    assert job["state"] == "failed" and job["error"]["code"] == "invalid"
    fake.queue.append(
        "<mxGraphModel><root><mxCell id='0'/><mxCell id='1' parent='0'/></root></mxGraphModel>"
    )
    job = await _draw(c, p["id"])
    assert job["state"] == "failed" and "no boxes" in job["error"]["message"]
    listed = (await c.get(f"/projects/{pid}/diagrams", headers=H)).json()
    assert listed == [] or listed.get("diagrams", []) == []


async def test_a_viewer_cannot_start_it(env, fake):
    c, pid, m = await setup(env)
    p = await page(c, pid, "API", TEXT)
    await c.post(f"/projects/{pid}/members", json={"name": "Vera", "role": "viewer"})
    r = await c.post(
        f"/docs/pages/{p['id']}/ai/diagram", json={}, headers={"X-Actor": "Vera"}
    )
    assert r.status_code in (403, 404) and fake.prompts == []
