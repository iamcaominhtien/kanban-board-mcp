"""Folders and programs a person names for an AI member stay inside the allowed places; config files stay inside
the working folder."""

import os

import pytest

from services.ai import paths


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
