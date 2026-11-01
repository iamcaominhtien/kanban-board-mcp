"""Members made from the ready-made packs get the tools their pack's work needs."""

from services.ai import packs


def _pack(key: str) -> dict:
    return next(p for p in packs.BUILTIN if p["key"] == key)


def test_a_pack_that_changes_code_can_edit_files_and_run_commands():
    for key in ("dev", "qa"):
        allow = packs.member_body(
            _pack(key), name="x", working_dir=None, account_id=None
        )["config"]["allow_rules"]
        assert {"Edit", "Write", "Bash"} <= set(allow), key


def test_a_pack_that_writes_nothing_keeps_its_own_narrow_list():
    for key in ("triage", "pm", "reviewer"):
        allow = packs.member_body(
            _pack(key), name="x", working_dir=None, account_id=None
        )["config"]["allow_rules"]
        assert allow == list(_pack(key)["allow"]), key
        assert "Edit" not in allow and "Bash" not in allow


def test_triage_sets_labels_without_asking_and_makes_nothing_else():
    from services.ai.permissions import ALLOWED, BLOCKED, TEMPLATES, validate_overrides

    body = packs.member_body(
        _pack("triage"), name="x", working_dir=None, account_id=None
    )
    got = {
        **TEMPLATES[body["template"]],
        **validate_overrides(body["template"], body["permissions"]),
    }
    assert got["edit_fields"] == ALLOWED
    assert all(
        got[a] == BLOCKED
        for a in ("create_tickets", "edit_docs", "create_branches", "change_assignee")
    )


def test_an_ai_writing_its_own_work_log_needs_only_the_comment_right():
    from services.ai import guard

    assert guard.classify("ticket_items", "work_log.add", {}) == ["comment"]
    assert guard.classify("ticket_items", "criterion.add", {}) == ["edit_fields"]
