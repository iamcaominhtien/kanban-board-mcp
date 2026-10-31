"""KANBAN_CONFIG_DIR gives a test instance its own config.json (and so its own data folder) without moving HOME."""

import importlib

import config


def test_the_config_folder_can_be_moved_with_an_environment_variable(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("KANBAN_CONFIG_DIR", str(tmp_path / "cfg"))
    importlib.reload(config)
    assert config._CONFIG_FILE == tmp_path / "cfg" / "config.json"
    config.set_data_folder(tmp_path / "data")
    assert config.get_data_folder() == tmp_path / "data"
    monkeypatch.delenv("KANBAN_CONFIG_DIR")
    importlib.reload(config)
    assert config._CONFIG_DIR.name == ".kanban-board"
