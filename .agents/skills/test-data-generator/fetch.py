#!/usr/bin/env python3
"""
Fetch files from URLs for testing and development.

Supports any URL and any file type (PDF, XLSX, DOCX, CSV, …).

Usage:
    # One or more URLs — filename inferred from URL
    uv run .github/skills/test-data-generator/fetch.py \
        --urls https://example.com/report.xlsx https://example.com/data.csv

    # Custom output filenames via a manifest CSV (url,filename — one per line)
    uv run .github/skills/test-data-generator/fetch.py \
        --manifest files.csv --output ./fixtures/

Notes:
    - Uses requests — handles SSL automatically on macOS/Linux.
    - Skips files that already exist and are > 10 KB.
    - Polite default delay: 0.5 s between requests.
"""

import argparse
import os
import sys
import time


def fetch(files: list[tuple[str, str]], output_dir: str, delay: float = 0.5) -> tuple[int, int]:
    """Download (url, filename) pairs into output_dir. Returns (ok, fail) counts."""
    import requests

    os.makedirs(output_dir, exist_ok=True)
    ok = fail = 0

    for url, fname in files:
        out = os.path.join(output_dir, fname)
        if os.path.isfile(out) and os.path.getsize(out) > 10_000:
            print(f"SKIP  {fname} (already exists)", flush=True)
            ok += 1
            continue
        try:
            r = requests.get(url, timeout=60)
            r.raise_for_status()
            with open(out, "wb") as f:
                f.write(r.content)
            print(f"OK    {fname}  ({os.path.getsize(out) // 1024} KB)", flush=True)
            ok += 1
        except Exception as e:
            print(f"FAIL  {fname}: {e}", flush=True)
            fail += 1
        time.sleep(delay)

    return ok, fail


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fetch files from URLs for testing.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  uv run fetch.py --urls https://example.com/report.xlsx https://example.com/data.csv
  uv run fetch.py --manifest files.csv --output ./fixtures/

Manifest CSV format (no header; lines starting with # are ignored):
  https://example.com/report.pdf, annual_report.pdf
  https://example.com/data.xlsx, products.xlsx
""",
    )
    parser.add_argument("--output", "-o", default="./downloads",
                        help="Output directory (default: ./downloads)")
    parser.add_argument("--delay", type=float, default=0.5,
                        help="Delay in seconds between requests (default: 0.5)")

    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--urls", nargs="+", metavar="URL",
                       help="One or more URLs to fetch")
    group.add_argument("--manifest", metavar="CSV",
                       help="CSV file: url,filename (one per line)")

    args = parser.parse_args()

    if args.urls:
        files = [
            (url.strip(), os.path.basename(url.strip().split("?")[0]) or f"file_{i}")
            for i, url in enumerate(args.urls)
        ]
    else:
        files = []
        with open(args.manifest) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = [p.strip() for p in line.split(",", 1)]
                url = parts[0]
                fname = parts[1] if len(parts) > 1 else os.path.basename(url.split("?")[0])
                files.append((url, fname))

    output_dir = os.path.abspath(args.output)
    print(f"Fetching {len(files)} file(s) → {output_dir}/\n", flush=True)
    ok, fail = fetch(files, output_dir, delay=args.delay)

    print(f"\n=== {ok} OK / {fail} FAIL ===")
    if ok > 0:
        print(f"\nFiles in {output_dir}/:")
        for fname in sorted(os.listdir(output_dir)):
            fp = os.path.join(output_dir, fname)
            if os.path.isfile(fp):
                print(f"  {fname}  ({os.path.getsize(fp) // 1024} KB)")

    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
