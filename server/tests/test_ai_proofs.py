"""The proof of a test case is Markdown: a picture named by a path in the run's working folder is copied into the
board, and an AI that reports with results nobody backed is told to add the proof."""

from pathlib import Path

import pytest

import services.proofs as proofs
from kanban_mcp.tools.ai_run import ai_run
from kanban_mcp.tools.items import ticket_items
from services.ai import guard
from tests.test_ai import _ctx, _runner, _ticket, env  # noqa: F401


@pytest.fixture
def folder(tmp_path, monkeypatch):
    monkeypatch.setenv("KANBAN_UPLOADS_DIR", str(tmp_path / "uploads"))
    work = tmp_path / "work"
    (work / "qa" / "evidence").mkdir(parents=True)
    (work / "qa" / "evidence" / "TC-1.png").write_bytes(b"\x89PNG fake")
    (work / "run.log").write_text("ok")
    (work / "prod.env").write_text("SECRET=1")
    (work / "outside.png").write_bytes(b"x")
    for hidden in (
        ".claude/.credentials.json",
        ".config/app.json",
        "deploy/credentials.json",
    ):
        (work / hidden).parent.mkdir(parents=True, exist_ok=True)
        (work / hidden).write_text("{}")
    (work / "secrets.yaml").write_text("k: v")
    return work


def test_a_picture_named_by_a_path_is_copied_and_the_reference_rewritten(folder):
    md = proofs.localize(
        "Logged in:\n![login](qa/evidence/TC-1.png)\nsee [log](run.log)", str(folder)
    )
    assert "qa/evidence/TC-1.png" not in md and "run.log" not in md
    urls = [
        u
        for u in md.replace("(", " ").replace(")", " ").split()
        if u.startswith("/uploads/")
    ]
    assert len(urls) == 2 and urls[0].endswith(".png") and urls[1].endswith(".log")
    root = Path(proofs.uploads.get_uploads_dir())
    assert all((root / u.removeprefix("/uploads/")).is_file() for u in urls)


def test_web_links_uploaded_files_code_and_plain_links_stay_as_written(folder):
    md = (
        "[ci](https://ci.example.com/run/1) ![a](/uploads/a.png) [ticket](AGT-5)\n"
        "```\n![not a file](qa/evidence/missing.png)\n```\n"
        "and `![inline](qa/evidence/missing.png)` as code"
    )
    assert proofs.localize(md, str(folder)) == md
    assert proofs.localize(None, str(folder)) is None
    assert proofs.localize("no links", None) == "no links"


@pytest.mark.parametrize(
    ("ref", "why"),
    [
        ("qa/evidence/missing.png", "no such file"),
        ("../outside.png", "outside the working folder"),
        ("prod.env", "never attached"),
        (".claude/.credentials.json", "never attached"),
        (".config/app.json", "never attached"),
        ("secrets.yaml", "never attached"),
        ("deploy/credentials.json", "never attached"),
    ],
)
def test_a_file_that_is_missing_outside_or_secret_is_refused(folder, ref, why):
    with pytest.raises(proofs.ProofError, match=why):
        proofs.localize(f"![x]({ref})", str(folder))


def test_a_person_cannot_attach_by_path_and_must_upload_in_the_editor(folder):
    with pytest.raises(proofs.ProofError, match="only from inside an AI run"):
        proofs.localize("![x](qa/evidence/TC-1.png)", None)


def test_gaps_and_unprovable_look_only_at_results_that_were_given():
    cases = [
        {"code": "TC-1", "status": "pass", "proof": "![a](/uploads/a.png)"},
        {"code": "TC-2", "status": "pass", "proof": "  "},
        {"code": "TC-3", "status": "fail"},
        {"code": "TC-4", "status": "pending"},
        {
            "code": "TC-5",
            "status": "pass",
            "proof": "Not provable: needs a real iPhone",
        },
    ]
    assert proofs.gaps(cases) == ["TC-2", "TC-3"]
    assert proofs.unprovable(cases) == ["TC-5"]


async def _as(ctx, fn, **args):
    tokens = guard.enter(ctx)
    try:
        return await fn(**args)
    finally:
        guard.leave(tokens)


async def test_an_ai_proof_with_a_picture_is_stored_with_the_copy(
    env, folder, monkeypatch
):
    c = env["c"]
    ctx, pid, _, member, tid = await _ctx(env)
    await c.patch(f"/ai/members/{member['id']}", json={"working_dir": str(folder)})
    out = await _as(
        ctx,
        ticket_items,
        ticket_id=tid,
        item="test_case",
        action="add",
        title="Login works",
        status="pass",
        proof="![login](qa/evidence/TC-1.png)\n```\n$ node --test\n34 passed\n```",
    )
    proof = out["test_cases"][0]["proof"]
    assert "/uploads/" in proof and "qa/evidence" not in proof and "34 passed" in proof


async def test_a_run_in_the_tickets_worktree_attaches_from_the_worktree(
    env, folder, tmp_path
):
    """A run works in its ticket's worktree (`repo.worktrees/KAN-1`, beside the member's folder): the paths it writes
    are from there, by a relative path or its absolute one."""
    from models import AiWorktree

    c = env["c"]
    ctx, pid, _, member, tid = await _ctx(env)
    main = tmp_path / "main"
    main.mkdir()
    await c.patch(f"/ai/members/{member['id']}", json={"working_dir": str(main)})
    async with env["maker"]() as s:
        s.add(
            AiWorktree(
                ticket_id=tid,
                project_id=pid,
                repo=str(main),
                path=str(folder),
                branch=f"ai/{tid}",
            )
        )
        await s.commit()
    shot = folder / "qa" / "evidence" / "TC-1.png"
    out = await _as(
        ctx,
        ticket_items,
        ticket_id=tid,
        item="test_case",
        action="add",
        title="Login works",
        status="pass",
        proof=f"![login](qa/evidence/TC-1.png) ![again]({shot})",
    )
    proof = out["test_cases"][0]["proof"]
    assert proof.count("/uploads/") == 2 and "qa/evidence" not in proof


async def test_a_picture_that_was_never_taken_is_refused_with_what_to_do(env, folder):
    c = env["c"]
    ctx, pid, _, member, tid = await _ctx(env)
    await c.patch(f"/ai/members/{member['id']}", json={"working_dir": str(folder)})
    with pytest.raises(ValueError, match="Take the screenshot first"):
        await _as(
            ctx,
            ticket_items,
            ticket_id=tid,
            item="test_case",
            action="add",
            title="Login works",
            status="pass",
            proof="![login](qa/evidence/missing.png)",
        )


async def test_reporting_with_results_nobody_backed_names_them(env, folder):
    ctx, pid, _, member, tid = await _ctx(env)
    await _as(
        ctx,
        ticket_items,
        ticket_id=tid,
        item="test_case",
        action="add",
        title="A",
        status="pass",
    )
    await _as(
        ctx,
        ticket_items,
        ticket_id=tid,
        item="test_case",
        action="add",
        title="B",
        status="pass",
        proof="Not provable: taste",
    )
    out = await _as(ctx, ai_run, action="report", summary="Done")
    assert (
        "TC-1" in out["next"]
        and "TC-2" not in out["next"]
        and "Not provable" in out["next"]
    )


async def test_reporting_when_every_result_has_a_proof_just_asks_to_finish(env, folder):
    ctx, pid, _, member, tid = await _ctx(env)
    await _as(
        ctx,
        ticket_items,
        ticket_id=tid,
        item="test_case",
        action="add",
        title="A",
        status="pass",
        proof="ok: 3 passed",
    )
    out = await _as(ctx, ai_run, action="report", summary="Done")
    assert out["next"] == "End with a short final message."


def test_on_a_docs_page_only_pictures_are_copied_and_what_the_page_held_may_stay(
    folder,
):
    md = proofs.localize(
        "![TC-1](qa/evidence/TC-1.png) [log](run.log) ![old](images/flow.png)",
        str(folder),
        pictures_only=True,
        keep={"images/flow.png"},
    )
    assert "qa/evidence" not in md
    assert "](/uploads/" in md
    assert "[log](run.log)" in md
    assert "![old](images/flow.png)" in md
    with pytest.raises(proofs.ProofError, match="no such file"):
        proofs.localize("![new](images/new.png)", str(folder), pictures_only=True)


async def test_an_ai_docs_page_shows_its_screenshots_from_the_working_folder(
    env, folder
):
    from kanban_mcp.tools.docs import docs_write

    c = env["c"]
    ctx, pid, _, member, _ = await _ctx(env)
    await c.patch(f"/ai/members/{member['id']}", json={"working_dir": str(folder)})
    page = (
        await c.post(
            f"/projects/{pid}/docs/pages",
            json={"title": "Demo", "markdown": "![old](images/flow.png)"},
        )
    ).json()
    await c.post(f"/docs/pages/{page['id']}/publish", json={"base_version": 0})
    version = (await c.get(f"/docs/pages/{page['id']}")).json()["version"]

    out = await _as(
        ctx,
        docs_write,
        action="update",
        page_id=page["id"],
        base_version=version,
        markdown="![old](images/flow.png)\n\n![TC-1](qa/evidence/TC-1.png)",
    )
    md = (await c.get(f"/docs/pages/{page['id']}")).json()["markdown"]
    assert out["version"] == version + 1
    assert "qa/evidence" not in md
    assert "](/uploads/" in md
    assert "![old](images/flow.png)" in md  # held before this edit, kept as written

    with pytest.raises(ValueError, match="Take the screenshot first"):
        await _as(
            ctx,
            docs_write,
            action="update",
            page_id=page["id"],
            base_version=out["version"],
            markdown=md + "\n\n![TC-9](qa/evidence/TC-9.png)",
        )


async def test_a_page_a_person_writes_over_mcp_keeps_its_paths_as_written(env):
    from kanban_mcp.tools.docs import docs_write

    c = env["c"]
    ctx, pid, _, _, _ = await _ctx(env)
    out = await docs_write(
        action="create",
        project_id=pid,
        title="Notes",
        markdown="![x](qa/evidence/TC-1.png)",
    )
    md = (await c.get(f"/docs/pages/{out['id']}")).json()["markdown"]
    assert md == "![x](qa/evidence/TC-1.png)"
