"""API keys on desktop: the encryption key lives in the OS keychain; a key file from before moves there once; a
denied keychain saves nothing and creates no AI member (design/screens/ai-members.md, 5b)."""

import keyring
import pytest
from cryptography.fernet import Fernet
from keyring.backend import KeyringBackend
from keyring.errors import PasswordSetError

from services.ai import secrets
from tests.test_ai import _project, env  # noqa: F401


class MemoryKeyring(KeyringBackend):
    """A keychain in memory."""

    priority = 1

    def __init__(self, deny: bool = False):
        """Empty, or refusing every write."""
        super().__init__()
        self.items: dict[tuple[str, str], str] = {}
        self.deny = deny

    def get_password(self, service, username):
        """Stored value or None."""
        return self.items.get((service, username))

    def set_password(self, service, username, password):
        """Store, unless access is denied."""
        if self.deny:
            raise PasswordSetError("denied by the user")
        self.items[(service, username)] = password

    def delete_password(self, service, username):
        """Forget."""
        self.items.pop((service, username), None)


@pytest.fixture
def keychain(monkeypatch):
    def use(deny=False):
        ring = MemoryKeyring(deny=deny)
        keyring.set_keyring(ring)
        monkeypatch.setenv("KANBAN_SECRET_STORE", "keychain")
        monkeypatch.setattr(secrets, "_cached", {})
        return ring

    yield use
    keyring.set_keyring(MemoryKeyring())


def test_key_moves_from_the_file_into_the_keychain(keychain, tmp_path, monkeypatch):
    path = tmp_path / "ai-secret.key"
    old = Fernet.generate_key()
    path.write_bytes(old)
    monkeypatch.setenv("KANBAN_AI_KEY_FILE", str(path))
    token = Fernet(old).encrypt(b"sk-ant\x2dold").decode()
    ring = keychain()
    assert secrets.store_kind() == "keychain"
    assert secrets.decrypt(token) == "sk-ant\x2dold"  # keys saved before still open
    assert ring.items[("kanban-board", "ai-secret-key")] == old.decode()
    assert not path.exists()
    assert secrets.decrypt(secrets.encrypt("sk-new")) == "sk-new"


async def test_denied_keychain_saves_nothing(env, keychain):
    keychain(deny=True)
    c = env["c"]
    pid, _ = await _project(c)
    r = await c.post(
        f"/projects/{pid}/ai/members",
        json={
            "name": "Reviewer (Claude API)",
            "provider": "anthropic",
            "api_key": "sk-ant\x2dapi03-zzzz3f9a",
        },
    )
    assert r.status_code == 500 and r.json()["detail"].startswith(
        "Could not store the key in the OS keychain"
    )
    assert (await c.get(f"/projects/{pid}/ai/members")).json() == []
