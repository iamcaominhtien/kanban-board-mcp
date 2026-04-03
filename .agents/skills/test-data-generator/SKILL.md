---
name: test-data-generator
description: >
  Generate test data of any format and any size for debugging, testing, and development.
  Covers JSON, CSV, XLSX, DOCX, PDF, HTML, XML, Markdown, plain text, images (PNG/JPG), and ZIP.
  Supports both AI-generated inline data (small) and script-generated data (large).
  Use when: "generate test data", "create sample file", "I need dummy data",
  "create a large PDF", "generate 10000 JSON records", "make test fixtures",
  "create a CSV with 50k rows", "I need a 200-page Word document".
argument-hint: >
  Describe what you need: file format, approximate size or record count,
  data theme (users / products / transactions / logs / articles / lorem),
  locale (optional), seed (optional), and output path (optional).
  Example: "500-page PDF with realistic article content, English locale"
  or "50000-row CSV of transaction records, reproducible seed 42"
  or "one file of every format, small size, into ./fixtures/"
---

# Test Data Generator Skill

## Role

You are a **test data engineer** who generates realistic, well-structured test files of any
format and any size. You pick the right tool for the right job:

- **Small data (≤ 200 records / ≤ 10 pages)** — generate inline, directly in the chat response
- **Large data** — delegate to the Python script `generate.py` which runs with a single `uv` command

Always clarify format, size, and content theme before generating.

---

## Quick Decision Guide

| What the user wants | Action |
|---|---|
| A few JSON objects as a code block | Generate inline |
| A small HTML snippet | Generate inline |
| 1000+ JSON records | `generate.py json --rows 1000` |
| A CSV with many rows | `generate.py csv --rows N` |
| A large Excel file | `generate.py xlsx --rows N` |
| A multi-page PDF | `generate.py pdf --pages N` |
| A multi-page Word doc | `generate.py docx --pages N` |
| A large HTML page | `generate.py html --sections N` |
| An XML data file | `generate.py xml --rows N` |
| A Markdown document | `generate.py md --sections N` |
| A test image (PNG/JPG) | `generate.py image --width W --height H` |
| Plain text / lorem ipsum | `generate.py lorem --words N` |
| A ZIP bundle of test files | `generate.py zip` |
| One file of every format | `generate.py batch --size medium` |
| "Give me a large set of fixtures" | `generate.py batch --size large --output ./fixtures/` |
| Need **real-world** documents (reports, papers, invoices…) | Search online with `filetype:` trick — see [Finding Real Documents Online](#finding-real-documents-online) |
| Need real files from the internet (PDF, XLSX, DOCX, CSV…) | `fetch.py --urls <url1> <url2>` or `--manifest files.csv` |

---

## The `generate.py` Script

Location: `.github/skills/test-data-generator/generate.py`

Self-contained script using PEP 723 inline dependencies — **no manual pip install or venv needed**.

### Prerequisites

```bash
# Install uv (if not already installed)
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### Run Commands

```bash
# JSON -- 5000 user records
uv run .github/skills/test-data-generator/generate.py json --rows 5000

# CSV -- 100,000 transaction records, reproducible
uv run .github/skills/test-data-generator/generate.py csv \
  --rows 100000 --schema transactions --seed 42 --output payments.csv

# Excel -- 50,000 product rows
uv run .github/skills/test-data-generator/generate.py xlsx \
  --rows 50000 --schema products --output catalog.xlsx

# Word document -- ~200 pages
uv run .github/skills/test-data-generator/generate.py docx \
  --pages 200 --output large_doc.docx

# PDF -- 300 pages
uv run .github/skills/test-data-generator/generate.py pdf \
  --pages 300 --output big_report.pdf

# HTML page -- 100 sections
uv run .github/skills/test-data-generator/generate.py html \
  --sections 100 --output page.html

# XML -- 5000 records
uv run .github/skills/test-data-generator/generate.py xml \
  --rows 5000 --output data.xml

# Markdown -- 50 sections
uv run .github/skills/test-data-generator/generate.py md \
  --sections 50 --output document.md

# Image -- 1920x1080 PNG
uv run .github/skills/test-data-generator/generate.py image \
  --width 1920 --height 1080 --output photo.png

# Image -- JPG format
uv run .github/skills/test-data-generator/generate.py image \
  --width 800 --height 600 --format jpg --output thumb.jpg

# Plain text -- ~10,000 words
uv run .github/skills/test-data-generator/generate.py lorem \
  --words 10000 --output article.txt

# ZIP bundle (CSV + JSON + Markdown + HTML)
uv run .github/skills/test-data-generator/generate.py zip \
  --output test_bundle.zip

# Batch -- one file of every format, medium size
uv run .github/skills/test-data-generator/generate.py batch \
  --size medium --output ./fixtures/

# Size preset shortcut (no need to count rows/pages)
uv run .github/skills/test-data-generator/generate.py pdf --size large
uv run .github/skills/test-data-generator/generate.py json --size small --schema transactions

# French locale
uv run .github/skills/test-data-generator/generate.py json \
  --rows 500 --locale fr_FR --output french_users.json
```

---

### CLI Reference

#### Shared options (available on every subcommand)

| Option | Description | Default |
|---|---|---|
| `--schema` | Data theme: `users`, `products`, `transactions`, `logs`, `articles`, `lorem` | `users` |
| `--locale` | Faker locale (`en_US`, `fr_FR`, `vi_VN`, `ja_JP`, `de_DE`, …) | `en_US` |
| `--seed` | Integer seed for reproducible output | _(random)_ |
| `--output` / `-o` | Output file path | _(auto-named)_ |
| `--size` | Preset: `small` / `medium` / `large` — sets default rows/pages/sections | _(medium if omitted)_ |

> `--schema` applies to `json`, `csv`, `xlsx` only. Document formats always generate rich content.

#### Size preset values

| Preset | pages | rows | sections | words | image |
|---|---|---|---|---|---|
| `small` | 5 | 100 | 5 | 500 | 400×300 |
| `medium` | 50 | 5,000 | 20 | 5,000 | 800×600 |
| `large` | 500 | 100,000 | 100 | 50,000 | 1920×1080 |

#### Subcommand-specific options

| Subcommand | Key option | Example |
|---|---|---|
| `json` | `--rows N` | `--rows 10000` |
| `csv` | `--rows N` | `--rows 100000` |
| `xlsx` | `--rows N` | `--rows 50000` |
| `docx` | `--pages N` | `--pages 200` |
| `pdf` | `--pages N` | `--pages 500` |
| `html` | `--sections N` | `--sections 100` |
| `xml` | `--rows N` | `--rows 5000` |
| `md` | `--sections N` | `--sections 50` |
| `image` | `--width W --height H --format png\|jpg` | `--width 1920 --height 1080` |
| `lorem` | `--words N` | `--words 10000` |
| `zip` | _(no size option — always bundles 200 rows + 5 sections)_ | |
| `batch` | `--size small\|medium\|large` | `--size large` |

> Explicit `--rows` / `--pages` / `--sections` always override `--size`.

---

## Data Schemas

Schemas apply to structured row-based formats: `json`, `csv`, `xlsx`.

### `users` (default)
Person-centric: id, name, email, phone, company, job, address, country, birthdate,
registered_at, active, score.

### `products`
E-commerce catalog: id, sku, name, description, category, brand, price, stock, rating,
tags, created_at.

### `transactions`
Financial ledger: id (UUID), seq, from_account, to_account, currency, amount, method,
status (pending/completed/failed/refunded), timestamp, description, ip_address.

### `logs`
Application logs: seq, timestamp, level (DEBUG/INFO/WARNING/ERROR/CRITICAL), service,
request_id, method (HTTP verb), path, status_code, duration_ms, user_agent, ip, message.

### `articles`
Blog/news content: id, title, slug, author, category, tags, summary, body (5 paragraphs),
views, likes, published_at, updated_at.

### `lorem`
Minimal placeholder: id, title, body, value (int), flag (bool).

---

## AI-Generated Inline Data

For small data (≤ 200 records), generate directly in the response — no script needed.

### Guidelines for inline generation

**JSON**
```json
[
  { "id": 1, "name": "Alice Smith",  "email": "alice@example.com", "active": true  },
  { "id": 2, "name": "Bob Johnson",  "email": "bob@example.com",   "active": false },
  { "id": 3, "name": "Carol Davis",  "email": "carol@example.com", "active": true  }
]
```

**CSV**
```
id,name,email,score
1,Alice Smith,alice@example.com,87.5
2,Bob Johnson,bob@example.com,62.0
3,Carol Davis,carol@example.com,95.3
```

**XML**
```xml
<?xml version='1.0' encoding='utf-8'?>
<records count="2">
  <record id="1"><name>Alice Smith</name><email>alice@example.com</email></record>
  <record id="2"><name>Bob Johnson</name><email>bob@example.com</email></record>
</records>
```

**HTML snippet**
```html
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Test Page</title></head>
<body>
  <h1>Sample Report</h1>
  <table>
    <tr><th>Name</th><th>Email</th></tr>
    <tr><td>Alice Smith</td><td>alice@example.com</td></tr>
  </table>
</body>
</html>
```

---

## Common Recipes

### API test fixtures

```bash
# 200 user records -- small enough for a fixture file, large enough to stress pagination
uv run .github/skills/test-data-generator/generate.py json \
  --rows 200 --schema users --seed 1 --output tests/fixtures/users.json

# Transaction log for testing a payment service
uv run .github/skills/test-data-generator/generate.py csv \
  --rows 10000 --schema transactions --seed 42 --output tests/fixtures/payments.csv
```

### Stress-testing a document parser

```bash
# 500-page PDF
uv run .github/skills/test-data-generator/generate.py pdf \
  --pages 500 --output stress_test.pdf

# 200-page Word doc
uv run .github/skills/test-data-generator/generate.py docx \
  --pages 200 --output stress_test.docx
```

### Full fixture set for a new feature

```bash
# Generate one file of every format -- small size, reproducible
uv run .github/skills/test-data-generator/generate.py batch \
  --size small --seed 99 --output ./tests/fixtures/
```

### Localized data

```bash
# Vietnamese users
uv run .github/skills/test-data-generator/generate.py json \
  --rows 1000 --locale vi_VN --output vn_users.json

# Japanese product catalog
uv run .github/skills/test-data-generator/generate.py xlsx \
  --rows 500 --schema products --locale ja_JP --output jp_catalog.xlsx
```

### Image upload testing

```bash
# Batch of images at different sizes
uv run .github/skills/test-data-generator/generate.py image --size small  -o thumb.png
uv run .github/skills/test-data-generator/generate.py image --size medium -o medium.png
uv run .github/skills/test-data-generator/generate.py image --size large  -o large.png
uv run .github/skills/test-data-generator/generate.py image --width 1200 --height 630 --format jpg -o og_image.jpg
```

---

## Finding Real Documents Online

Sometimes generated data isn't enough — you need **real files** with authentic structure,
formatting quirks, embedded fonts, scanned pages, or complex layouts that synthetic data
can't replicate.

### Fetching Real Files from the Internet

Use `fetch.py` — fetches any URL, any file type (PDF, XLSX, DOCX, CSV, …).

Script location: `.github/skills/test-data-generator/fetch.py`

```bash
# Fetch files by URL (filename inferred from URL)
uv run .github/skills/test-data-generator/fetch.py \
    --urls "https://example.com/budget.xlsx" "https://example.com/users.csv"

# Fetch with explicit names via a manifest CSV (url,filename — one per line)
uv run .github/skills/test-data-generator/fetch.py \
    --manifest files.csv --output ./fixtures/
```

Manifest CSV format:
```
https://arxiv.org/pdf/1810.04805, bert_pretraining.pdf
https://example.com/products.xlsx, products.xlsx
https://example.com/users.csv, users.csv
# lines starting with # are ignored
```

**Implementation note** — always use `requests`, not `urllib`:

```python
# ✅ requests handles SSL automatically on macOS/Linux
import requests
response = requests.get(url, timeout=60)
response.raise_for_status()
with open(out_path, "wb") as f:
    f.write(response.content)

# ❌ urllib needs manual SSL workarounds on macOS (CERTIFICATE_VERIFY_FAILED)
import urllib.request
urllib.request.urlopen(url)
```

---

### The `filetype:` Search Trick

Append `filetype:<ext>` to any Google (or Bing) search query to surface publicly available
files of that exact type:

```
annual report filetype:pdf
invoice template filetype:xlsx
research paper machine learning filetype:pdf
project plan filetype:docx
product catalog filetype:xlsx
contract template filetype:docx
data dictionary filetype:csv
```

> Works on Google, Bing, and DuckDuckGo. Google returns the most results.

### By format — ready-to-use queries

| Format | Example search query |
|---|---|
| PDF | `annual report 2023 filetype:pdf` |
| DOCX | `terms and conditions filetype:docx` |
| XLSX | `financial model filetype:xlsx` |
| CSV | `open data population filetype:csv` |
| PPTX | `pitch deck template filetype:pptx` |
| XML | `sitemap filetype:xml` |
| JSON | `geojson country borders filetype:json` |

### Reliable open-data sources

When search results are thin, go directly to these sources:

| Source | What you get |
|---|---|
| [data.gov](https://data.gov) | Government datasets (CSV, JSON, XML) |
| [kaggle.com/datasets](https://www.kaggle.com/datasets) | Structured ML datasets |
| [arxiv.org](https://arxiv.org) | Research PDFs — fetch with `fetch.py --urls https://arxiv.org/pdf/{id}` |
| [sec.gov/edgar](https://www.sec.gov/cgi-bin/browse-edgar) | Annual reports, 10-K filings (PDF, XLSX) |
| [world.openfoodfacts.org](https://world.openfoodfacts.org/data) | Large CSV/JSON product data |
| [github.com search](https://github.com/search?type=code) | Sample files committed to public repos |

### When to use real documents vs. generated data

| Situation | Recommendation |
|---|---|
| Testing parser edge cases (fonts, encoding, embedded images) | Real documents |
| Testing with diverse scientific PDFs (multi-column, equations, figures) | `fetch.py --manifest papers.csv` |
| Stress-testing with 10k+ rows of uniform data | Generated data |
| Reproducing a specific user-reported bug | Real document if possible |
| CI/CD fixture files (must be stable and reproducible) | Generated with `--seed` |
| Checking layout handling (multi-column PDF, merged Excel cells) | Real documents |
