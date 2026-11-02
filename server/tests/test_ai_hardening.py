"""Checks that keep untrusted text (a remote, an upload's name, a rule's sentence, a member's configuration) from
choosing where the board writes or how long a regular expression runs."""

import time

import pytest

from services.ai import kb, orders, run_config, workflow, worktrees


@pytest.mark.parametrize(
    ("remote", "github"),
    [
        ("https://github.com/a/b.git", True),
        ("git@github.com:a/b.git", True),
        ("ssh://git@github.com/a/b", True),
        ("https://evil.example/github.com/a", False),
        ("https://github.com.evil.example/a", False),
        ("git@gitlab.com:a/b.git", False),
        ("", False),
        (None, False),
    ],
)
def test_a_remote_is_on_github_by_its_host_only(remote, github):
    assert worktrees.is_github(remote) is github


def test_an_upload_is_saved_under_a_known_suffix_never_its_own_name():
    assert kb.known_suffix("Release Rules.PDF") == ".pdf"
    assert kb.known_suffix("../../etc/passwd") == ""
    assert kb.known_suffix("notes.md") == ".md"


def test_the_test_file_is_found_word_by_word():
    out = "FAILED tests/test_calc.py::test_double - assert 5 == 4"
    assert workflow._test_file("python3 -m pytest -q", out) == "tests/test_calc.py"
    assert workflow._test_file("npx vitest run src/a.test.ts", "") == "src/a.test.ts"
    assert workflow._test_file("make", "all good") is None


def test_a_plugin_folder_never_leaves_its_base(tmp_path):
    assert run_config._within(tmp_path, "m1", "run_1").parent.name == "m1"
    for bad in (("..", "x"), ("/etc",), ("m1", "../../x")):
        with pytest.raises(ValueError):
            run_config._within(tmp_path, *bad)


def test_a_rule_sentence_reads_minutes_and_a_long_string_of_digits_is_quick():
    rule = orders.parse_sentence("If an AI hangs for 20 minutes, diagnose it")
    assert rule["if"]["min_minutes"] == 20
    start = time.perf_counter()
    with pytest.raises(orders.OrderError):
        orders.parse_sentence("9" * 200_000)
    assert time.perf_counter() - start < 1
