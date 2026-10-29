"""A custom HTTP tool's arguments fill the path and query of its URL, never the scheme or host."""

import pytest

from services.ai import custom_tools


def _spec(url: str, method: str = "GET") -> dict:
    return {"http": {"method": method, "url": url}}


def test_arguments_fill_the_path_and_query_only():
    method, url, params, body = custom_tools.build_request(
        _spec("https://crm.example.dev/v1/customers/{id}"), {"id": "a/b", "env": "prod"}
    )
    assert (method, url, params, body) == (
        "GET",
        "https://crm.example.dev/v1/customers/a%2Fb",
        {"env": "prod"},
        None,
    )
    with pytest.raises(ValueError, match="not its host"):
        custom_tools.build_request(
            _spec("https://{tenant}.example.dev/v1"), {"tenant": "x"}
        )
