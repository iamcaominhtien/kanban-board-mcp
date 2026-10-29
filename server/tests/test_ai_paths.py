"""Folders and programs a person names for an AI member stay inside the allowed places; config files stay inside
the working folder."""

import os

import pytest

from services.ai import config_sync, paths


def test_a_working_folder_must_sit_inside_an_allowed_root(tmp_path, monkeypatch):
    monkeypatch.setenv(paths.ROOTS_ENV, str(tmp_path))
    repo = tmp_path / "repo"
    repo.mkdir()
    assert paths.folder(f"  {repo}  ") == os.path.realpath(repo)
    for bad in ("/etc", "/", str(tmp_path)):
        with pytest.raises(paths.PathRefused):
            paths.folder(bad)
    with pytest.raises(paths.PathRefused):
        paths.folder("~")  # the home folder itself is too wide


def test_a_symlink_out_of_the_roots_is_refused(tmp_path, monkeypatch):
    monkeypatch.setenv(paths.ROOTS_ENV, str(tmp_path / "work"))
    (tmp_path / "work").mkdir()
    (tmp_path / "work" / "etc").symlink_to("/etc")
    with pytest.raises(paths.PathRefused):
        paths.folder(str(tmp_path / "work" / "etc"))


def test_a_cli_may_live_in_the_usual_install_folders(tmp_path, monkeypatch):
    monkeypatch.setenv(paths.ROOTS_ENV, str(tmp_path))
    assert paths.program("/usr/bin/env").startswith("/usr/")
    with pytest.raises(paths.PathRefused):
        paths.program("/etc/passwd")


def test_config_files_stay_inside_the_working_folder(tmp_path):
    root = tmp_path / "repo"
    (root / ".claude").mkdir(parents=True)
    (tmp_path / "outside.md").write_text("secret")
    (root / ".claude" / "link.md").symlink_to(tmp_path / "outside.md")
    assert config_sync._safe_target(root, "CLAUDE.md") == root / "CLAUDE.md"
    for bad in ("../outside.md", "/etc/passwd", ".claude/link.md", ""):
        with pytest.raises(config_sync.SyncError):
            config_sync._safe_target(root, bad)
