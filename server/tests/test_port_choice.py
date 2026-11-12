"""The board keeps its port from one start to the next, so an MCP client's address does not go stale."""

import socket

import pytest

import config
import port_choice


@pytest.fixture(autouse=True)
def own_config(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "_CONFIG_DIR", tmp_path / "cfg")
    monkeypatch.setattr(config, "_CONFIG_FILE", tmp_path / "cfg" / "config.json")
    monkeypatch.delenv("KANBAN_PORT", raising=False)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_the_first_start_takes_a_free_port_and_remembers_it():
    assert config.get_port() is None
    with port_choice.bind_socket() as sock:
        assert config.get_port() == sock.getsockname()[1]


def test_the_next_start_asks_for_the_port_of_the_last_one():
    port = _free_port()
    config.set_port(port)
    with port_choice.bind_socket() as sock:
        assert sock.getsockname()[1] == port


def test_the_port_survives_many_restarts():
    with port_choice.bind_socket() as sock:
        first = sock.getsockname()[1]
    for _ in range(3):
        with port_choice.bind_socket() as sock:
            assert sock.getsockname()[1] == first


def test_an_environment_variable_picks_the_port(monkeypatch):
    port = _free_port()
    config.set_port(_free_port())
    monkeypatch.setenv("KANBAN_PORT", str(port))
    with port_choice.bind_socket() as sock:
        assert sock.getsockname()[1] == port
        assert config.get_port() == port


def test_a_port_that_is_taken_gives_a_free_one_and_keeps_the_saved_port():
    with socket.socket() as busy:
        busy.bind(("127.0.0.1", 0))
        busy.listen()
        taken = busy.getsockname()[1]
        config.set_port(taken)
        with port_choice.bind_socket() as sock:
            assert sock.getsockname()[1] != taken
        # a second instance that had to move does not steal the first one's port
        assert config.get_port() == taken


@pytest.mark.parametrize("bad", ["abc", "0", "70000", "-5", ""])
def test_a_bad_environment_value_is_ignored(monkeypatch, bad):
    port = _free_port()
    config.set_port(port)
    monkeypatch.setenv("KANBAN_PORT", bad)
    with port_choice.bind_socket() as sock:
        assert sock.getsockname()[1] == port


def test_a_bad_saved_port_is_ignored():
    config._save({"port": "nope"})
    assert config.get_port() is None
    with port_choice.bind_socket() as sock:
        assert config.get_port() == sock.getsockname()[1]
