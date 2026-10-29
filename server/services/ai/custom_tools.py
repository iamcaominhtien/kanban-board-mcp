"""Custom HTTP tools of an API agent (design/screens/ai-provider-config.md, D2, D3, F3): the model's tool call becomes
one HTTP request. The response is capped at 20 KB, redacted and handed to the model as untrusted text."""

import ipaddress
import socket
import json
import re
import time
from urllib.parse import quote, urlparse

import httpx

from . import config_model as cm
from .secrets import redact

_PLACEHOLDER = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")


def _blocked_host(url: str) -> str | None:
    """Why a URL must not be called (not http/https, or a cloud-metadata / link-local address, also behind a host
    name that resolves to one), or None."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return "Custom tools call http or https URLs only."
    host = parsed.hostname or ""
    if not host:
        return "The URL has no host."
    try:
        addresses = [ipaddress.ip_address(host)]
    except ValueError:
        try:
            infos = socket.getaddrinfo(
                host, parsed.port or None, proto=socket.IPPROTO_TCP
            )
        except OSError:
            return None  # the request itself reports that the host is unknown
        addresses = [ipaddress.ip_address(i[4][0].split("%")[0]) for i in infos]
    for ip in addresses:
        if ip.is_link_local or ip.is_multicast or ip.is_unspecified:
            return f"{host} is a link-local address; the board does not call it."
    return None


def build_request(spec: dict, args: dict) -> tuple[str, str, dict | None, dict | None]:
    """(method, url, query params, JSON body) of a call: ``{name}`` in the URL is filled from the arguments, the
    rest goes to the query string (GET, DELETE) or the JSON body."""
    http = spec["http"]
    method = (http.get("method") or "GET").upper()
    rest = dict(args)

    def fill(m):
        value = rest.pop(m.group(1), None)
        if value is None:
            raise ValueError(f"Missing argument “{m.group(1)}” for the URL.")
        return quote(str(value), safe="")

    url = _PLACEHOLDER.sub(fill, http["url"])
    if method in ("GET", "DELETE"):
        return (
            method,
            url,
            {k: v for k, v in rest.items() if v is not None} or None,
            None,
        )
    return method, url, None, rest or None


async def call(
    spec_text: str, headers: dict[str, str], args: dict, *, simulate: bool = False
) -> dict:
    """Run one call of a tool.

    Returns:
        {ok, status, body, seconds, method, url, simulated}; `body` is capped at 20 KB and redacted.
    """
    check = cm.check_tool_spec(spec_text)
    if not check["ok"]:
        return {
            "ok": False,
            "status": None,
            "body": check["problems"][0]["message"],
            "seconds": 0,
            "method": "",
            "url": "",
            "simulated": False,
        }
    spec = check["tool"]
    try:
        method, url, params, body = build_request(spec, args)
    except ValueError as exc:
        return {
            "ok": False,
            "status": None,
            "body": str(exc),
            "seconds": 0,
            "method": spec["http"].get("method", "GET"),
            "url": spec["http"]["url"],
            "simulated": False,
        }
    bad = _blocked_host(url)
    if bad:
        return {
            "ok": False,
            "status": None,
            "body": bad,
            "seconds": 0,
            "method": method,
            "url": url,
            "simulated": False,
        }
    if simulate:
        return {
            "ok": True,
            "status": None,
            "body": f"Simulated {method} {url}; nothing was sent.",
            "seconds": 0,
            "method": method,
            "url": url,
            "simulated": True,
        }
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
            r = await client.request(
                method, url, params=params, json=body, headers=headers
            )
    except httpx.HTTPError as exc:
        return {
            "ok": False,
            "status": None,
            "body": f"Could not reach {urlparse(url).netloc}: {type(exc).__name__}",
            "seconds": round(time.monotonic() - started, 1),
            "method": method,
            "url": url,
            "simulated": False,
        }
    text = r.text
    cut = len(text.encode()) > cm.RESPONSE_CAP
    if cut:
        text = text.encode()[: cm.RESPONSE_CAP].decode(errors="ignore")
    text = redact(text) + ("\n[…cut at 20 KB]" if cut else "")
    return {
        "ok": r.status_code < 400,
        "status": r.status_code,
        "body": text,
        "seconds": round(time.monotonic() - started, 1),
        "method": method,
        "url": str(r.request.url),
        "simulated": False,
    }


def as_model_text(name: str, res: dict) -> str:
    """The tool result as the model reads it: fenced as untrusted, with the status first."""
    head = (
        f"HTTP {res['status']}"
        if res["status"]
        else ("Error" if not res["ok"] else "OK")
    )
    safe = res["body"].replace("</untrusted>", "<\\/untrusted>")
    prefix = "" if res["ok"] else "ERROR: "
    return f'{prefix}<untrusted source="tool · {name}">\n{head}\n{safe}\n</untrusted>'


def sample_args(schema: dict) -> str:
    """A starting point for the test call: required properties filled with a placeholder of their type."""
    out = {}
    props = (schema or {}).get("properties") or {}
    for key in (schema or {}).get("required") or list(props)[:3]:
        t = (props.get(key) or {}).get("type")
        enum = (props.get(key) or {}).get("enum")
        out[key] = (
            enum[0]
            if enum
            else {
                "integer": 1,
                "number": 1,
                "boolean": True,
                "array": [],
                "object": {},
            }.get(t, "")
        )
    return json.dumps(out, indent=2)
