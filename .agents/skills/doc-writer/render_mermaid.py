#!/usr/bin/env python3
"""
render_mermaid.py — Render a Mermaid diagram to an image file.

Uses the mermaid.ink public API (no local Node.js required).

Encoding strategy:
  1. Tries pako-compatible encoding first (zlib.compress → base64url) — handles large diagrams.
  2. Falls back to plain base64 encoding if the pako request fails with 4xx/5xx.

SSL: Uses certifi when available; falls back to the system CA bundle. Always
verifies certificates — do NOT run via system Python on macOS without first
running `pip install certifi` or using `uv run`.

Usage:
    uv run .github/skills/doc-writer/render_mermaid.py --input diagram.mmd --output docs/images/flow.png
    uv run .github/skills/doc-writer/render_mermaid.py --code "graph LR; A-->B" --output docs/images/flow.svg
    cat diagram.mmd | uv run .github/skills/doc-writer/render_mermaid.py --output docs/images/flow.png

Supported output formats: .png, .svg, .pdf
"""

import argparse
import base64
import json
import ssl
import sys
import urllib.error
import urllib.request
import zlib
from pathlib import Path

# ---------------------------------------------------------------------------
# SSL context — prefer certifi, fall back to default context
# ---------------------------------------------------------------------------


def _make_ssl_context() -> ssl.SSLContext:
    try:
        import certifi  # type: ignore[import-untyped]

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


_SSL_CONTEXT = _make_ssl_context()


# ---------------------------------------------------------------------------
# Encoding helpers
# ---------------------------------------------------------------------------


def _encode_pako(code: str, theme: str) -> str:
    """Zlib-compress a JSON payload and return a base64url string (pako-compatible)."""
    payload = json.dumps({"code": code, "mermaid": {"theme": theme}})
    compressed = zlib.compress(payload.encode("utf-8"), level=9)
    return base64.urlsafe_b64encode(compressed).decode("utf-8").rstrip("=")


def _encode_plain(code: str) -> str:
    """Plain base64url encoding (works for short diagrams only)."""
    return base64.urlsafe_b64encode(code.encode("utf-8")).decode("utf-8")


# ---------------------------------------------------------------------------
# URL builders
# ---------------------------------------------------------------------------


def _build_url(encoded: str, prefix: str, ext: str, theme: str) -> str:
    base = "https://mermaid.ink"
    if ext == ".svg":
        return f"{base}/svg/{prefix}{encoded}?theme={theme}"
    elif ext == ".pdf":
        return f"{base}/pdf/{prefix}{encoded}?theme={theme}"
    else:
        return f"{base}/img/{prefix}{encoded}?type=png&theme={theme}&bgColor=white"


# ---------------------------------------------------------------------------
# HTTP helper
# ---------------------------------------------------------------------------


def _fetch(url: str, timeout: int = 45) -> tuple[bytes, str]:
    req = urllib.request.Request(url, headers={"User-Agent": "render-mermaid/2.0"})
    with urllib.request.urlopen(req, timeout=timeout, context=_SSL_CONTEXT) as resp:
        return resp.read(), resp.headers.get("Content-Type", "")


# ---------------------------------------------------------------------------
# Core render function
# ---------------------------------------------------------------------------


def render(mermaid_code: str, output_path: Path, theme: str = "default") -> None:
    ext = output_path.suffix.lower()

    # --- Strategy 1: pako (handles large diagrams) ---
    pako_encoded = _encode_pako(mermaid_code, theme)
    pako_url = _build_url(pako_encoded, "pako:", ext, theme)
    print(f"Rendering (pako) via mermaid.ink → {output_path}")

    data: bytes = b""
    content_type: str = ""

    # Attempt pako with up to 2 tries (mermaid.ink can be transiently slow)
    _pako_exc: Exception | None = None
    for attempt in range(1, 3):
        try:
            data, content_type = _fetch(pako_url)
            print(f"  ✓ pako encoding succeeded (attempt {attempt})")
            _pako_exc = None
            break
        except (urllib.error.URLError, OSError) as exc:
            # Covers HTTPError (subclass of URLError), TimeoutError, ConnectionError…
            label = (
                f"{exc.code} {exc.reason}"
                if isinstance(exc, urllib.error.HTTPError)
                else str(exc)
            )
            print(f"  ✗ pako attempt {attempt} failed ({label})")
            _pako_exc = exc

    if _pako_exc is not None:
        print("  Falling back to plain base64 encoding …")

        # --- Strategy 2: plain base64 (fallback for small diagrams) ---
        plain_encoded = _encode_plain(mermaid_code)
        plain_url = _build_url(plain_encoded, "", ext, theme)
        try:
            data, content_type = _fetch(plain_url)
            print("  ✓ plain base64 encoding succeeded")
        except (urllib.error.URLError, OSError) as exc2:
            label2 = (
                f"{exc2.code} {exc2.reason}"
                if isinstance(exc2, urllib.error.HTTPError)
                else str(exc2)
            )
            print(
                f"  ✗ plain base64 also failed ({label2}).\n"
                "    The diagram may be too large or mermaid.ink may be unavailable.\n"
                "    Consider splitting the diagram or installing mmdc (mermaid CLI).",
                file=sys.stderr,
            )
            raise SystemExit(1) from exc2

    # Validate content type vs. requested extension
    if ext in (".png", "") and "jpeg" in content_type:
        corrected = output_path.with_suffix(".jpg")
        print(
            f"  Warning: server returned JPEG instead of PNG. "
            f"Saving as {corrected} to avoid media-type mismatch."
        )
        output_path = corrected

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(data)
    print(f"Saved: {output_path} ({len(data):,} bytes)")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Render a Mermaid diagram to PNG, SVG, or PDF via mermaid.ink"
    )
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--input", "-i", type=Path, help="Path to .mmd file")
    source.add_argument("--code", "-c", type=str, help="Mermaid code as a string")
    parser.add_argument(
        "--output",
        "-o",
        type=Path,
        required=True,
        help="Output image path (.png/.svg/.pdf)",
    )
    parser.add_argument(
        "--theme",
        choices=["default", "dark", "forest", "neutral"],
        default="default",
        help="Mermaid theme (default: default)",
    )
    args = parser.parse_args()

    if args.input:
        mermaid_code = args.input.read_text(encoding="utf-8")
    elif args.code:
        mermaid_code = args.code
    elif not sys.stdin.isatty():
        mermaid_code = sys.stdin.read()
    else:
        parser.error("Provide --input, --code, or pipe mermaid code via stdin")

    render(mermaid_code.strip(), args.output, theme=args.theme)


if __name__ == "__main__":
    main()
