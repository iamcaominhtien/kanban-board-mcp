---
name: doc-writer
description: "Create, update, and manage technical documentation in the docs/ folder. Use when: writing architecture docs, BA specs, test plans, API references, ADRs, or any project documentation. Triggers: 'write doc', 'create architecture doc', 'add BA spec', 'test plan', 'update docs', 'generate index', 'document this', 'ADR', 'clean up docs folder'."
argument-hint: "Describe the doc to create or update (e.g. 'architecture doc for translation service', 'BA spec for user auth', 'ADR for switching to Redis caching')"
---

# Doc Writer

Creates, updates, and manages technical documentation in the `docs/` folder, following consistent structure, versioning, and quality standards suited to this project.

---

## Folder Structure & Organization

The `docs/` folder uses a **flat, category-prefixed layout** — no deep nesting. Every file is discoverable from the root.

```
docs/
├── _index.md                  # Auto-generated navigation index (do not edit manually)
├── arch-{feature}.md          # Architecture / system design docs
├── adr-{NNN}-{slug}.md        # Architecture Decision Records (numbered, sequential)
├── api-{feature}.md           # API reference / endpoint docs
├── ba-{feature}.md            # Business Analysis / requirements specs
├── test-{feature}.md          # Test plans and QA strategies
├── ops-{topic}.md             # DevOps, deployment, runbooks
└── guide-{topic}.md           # Developer how-to guides
```

**Naming rules:**
- Use **kebab-case** only: `arch-translation-service.md`, not `ArchTranslationService.md`
- Be specific: `arch-doc-translation-v2.md` not `architecture.md`
- ADRs are numbered sequentially from `001`: `adr-001-use-mysql.md`
- Never use spaces or uppercase in filenames

**Cleanliness rules:**
- One topic per file — split if a file exceeds ~300 lines
- No duplicate content across files — link instead
- Keep `_index.md` up to date after every add/rename/delete (see automation below)
- Deprecated docs: add `status: deprecated` in frontmatter and move to `docs/archive/`

---

## Document Frontmatter (Version Tracking)

Every `.md` doc in `docs/` must begin with this YAML frontmatter block:

```markdown
---
title: "Human-Readable Title"
type: arch | adr | api | ba | test | ops | guide
status: draft | review | stable | deprecated
version: 1.0.0
created: YYYY-MM-DD
updated: YYYY-MM-DD
authors: [Name]
related:
  - docs/arch-related-feature.md
---
```

**Versioning conventions (SemVer-lite):**
| Change type | Bump |
|---|---|
| Typo / minor wording fix | patch: `1.0.0 → 1.0.1` |
| Section added / significantly expanded | minor: `1.0.0 → 1.1.0` |
| Document restructured or scope changed | major: `1.0.0 → 2.0.0` |

Always update `updated:` and `version:` when editing an existing doc.

> Git history is the full audit trail. The frontmatter is a human-readable signal only.

---

## Document Templates by Type

Each doc type has a ready-to-use template file in the [`templates/`](./templates/) directory. Copy the relevant template, rename it following the naming rules above, and fill in the placeholders.

| Type | Template | Filename pattern |
|---|---|---|
| Architecture | [arch-template.md](./templates/arch-template.md) | `arch-{feature}.md` |
| Business Analysis | [ba-template.md](./templates/ba-template.md) | `ba-{feature}.md` |
| Test Plan | [test-template.md](./templates/test-template.md) | `test-{feature}.md` |
| ADR | [adr-template.md](./templates/adr-template.md) | `adr-{NNN}-{slug}.md` |
| API Reference | [api-template.md](./templates/api-template.md) | `api-{feature}.md` |

**Key structure highlights by type:**

| Type | Must include | Mermaid diagrams |
|---|---|---|
| `arch` | Context, System Overview, Data Flow, NFRs | C4Context + sequenceDiagram |
| `ba` | User Stories, Business Rules, Data Model, Workflows | erDiagram + flowchart |
| `test` | Scope, Test Cases table, Coverage Goals | — |
| `adr` | Context, Decision, Consequences, Alternatives | — |
| `api` | Base URL, Auth, Endpoints with request/response examples | — |

---

## Generating the Index (`docs/_index.md`)

After adding or changing docs, regenerate the index. The agent should write or run a small inline script that:
1. Scans all `.md` files in `docs/` (excluding `_index.md` and `archive/`)
2. Parses frontmatter (`title`, `type`, `status`, `version`, `updated`)
3. Groups by `type` and writes a Markdown table per group to `docs/_index.md`

**Expected output format:**

```markdown
# Documentation Index
_Auto-generated. Do not edit manually. Run `python .github/skills/doc-writer/generate_docs_index.py` to refresh._

## Architecture
| File | Title | Status | Version | Updated |
|---|---|---|---|---|
| [arch-translation.md](arch-translation.md) | Architecture: Translation Service | stable | 1.2.0 | 2026-03-01 |

## ADRs
| File | Title | Status | Version | Updated |
...
```

---

## Diagrams — Mermaid First

Always prefer **Mermaid** diagrams embedded directly in Markdown (renders on GitHub, in VS Code with the Markdown Preview Mermaid extension, and in most doc platforms).

Use these diagram types:
| Need | Mermaid type |
|---|---|
| System/component overview | `C4Context`, `C4Container` |
| Request flow | `sequenceDiagram` |
| Process / state machine | `flowchart LR` or `stateDiagram-v2` |
| Data model / ERD | `erDiagram` |
| Deployment / infra | `graph TD` |
| Timeline / Gantt | `gantt` |

If an image is needed (e.g., screenshots, hand-drawn diagrams), store it in `docs/images/` and link as `![alt](images/filename.png)`.

---

## Scripts

Three helper scripts live alongside this `SKILL.md` and can be invoked directly by the agent or by the user.

---

### [`generate_docs_index.py`](./generate_docs_index.py) — Regenerate `docs/_index.md`

Scans all `.md` files in `docs/`, parses frontmatter, and writes an auto-generated navigation index.

```bash
# Default (docs/ relative to cwd)
uv run .github/skills/doc-writer/generate_docs_index.py

# Custom docs directory
uv run .github/skills/doc-writer/generate_docs_index.py --docs-dir path/to/docs
```

**Options:** `--docs-dir` (default: `docs/`)

---

### [`render_mermaid.py`](./render_mermaid.py) — Mermaid → Image

Renders any Mermaid diagram to PNG, SVG, or PDF using the [mermaid.ink](https://mermaid.ink) API. No local Node.js required.

```bash
# From a .mmd file
uv run .github/skills/doc-writer/render_mermaid.py \
  --input diagram.mmd \
  --output docs/images/flow.png

# Inline code
uv run .github/skills/doc-writer/render_mermaid.py \
  --code "graph LR; A[Start] --> B[Process] --> C[End]" \
  --output docs/images/flow.svg

# From stdin
cat diagram.mmd | uv run .github/skills/doc-writer/render_mermaid.py \
  --output docs/images/flow.png

# Dark theme
uv run .github/skills/doc-writer/render_mermaid.py \
  --input diagram.mmd --theme dark \
  --output docs/images/flow.png
```

**Options:** `--input` / `--code` / stdin, `--output` (required), `--theme` (default/dark/forest/neutral)

Use this when embedding a diagram image is preferred over inline Mermaid (e.g., for PDF exports or external sharing).

---

### [`render_chart.py`](./render_chart.py) — Data → Chart / Dashboard

Renders bar, line, area, pie, donut, and horizontal bar charts, plus multi-chart dashboards, from a JSON data file. Requires `matplotlib` (`uv add matplotlib`).

```bash
# Single bar chart
uv run .github/skills/doc-writer/render_chart.py \
  --input data.json --type bar \
  --output docs/images/revenue.png

# Pie chart
uv run .github/skills/doc-writer/render_chart.py \
  --input data.json --type pie \
  --output docs/images/share.png

# Multi-chart dashboard
uv run .github/skills/doc-writer/render_chart.py \
  --input dashboard.json --type dashboard \
  --output docs/images/dashboard.png
```

**Supported types:** `bar`, `line`, `area`, `pie`, `donut`, `horizontal_bar`, `dashboard`

**Input JSON format — bar / line / area:**
```json
{
  "title": "Monthly Revenue",
  "xlabel": "Month", "ylabel": "Revenue ($)",
  "series": [
    { "label": "2025", "x": ["Jan","Feb","Mar"], "y": [100, 200, 150] }
  ]
}
```

**Input JSON format — pie / donut:**
```json
{
  "title": "Market Share",
  "labels": ["A", "B", "C"],
  "values": [45, 30, 25]
}
```

**Input JSON format — dashboard:**
```json
{
  "title": "Project Dashboard",
  "charts": [
    { "type": "bar", "title": "Weekly Calls", "series": [...] },
    { "type": "pie", "title": "Status", "labels": [...], "values": [...] }
  ]
}
```

**Options:** `--input` (required), `--type` (default: bar), `--output` (required), `--dpi` (default: 150)

---

## Workflow

### Creating a new doc
1. Choose the correct type prefix and filename
2. Copy the matching template above
3. Fill in the frontmatter (`status: draft`, `version: 1.0.0`)
4. Write the content using the structure for that type
5. Run `python .github/skills/doc-writer/generate_docs_index.py` to update the index
6. Set `status: stable` when content is reviewed and complete

### Updating an existing doc
1. Read the current file — understand its version and scope
2. Make targeted changes
3. Bump `version` and update `updated` date in frontmatter
4. Regenerate the index if the title or status changed

### Deprecating a doc
1. Change `status: deprecated` in frontmatter
2. Add a notice at the top: `> ⚠️ This document is deprecated as of YYYY-MM-DD. See [replacement](link).`
3. Move file to `docs/archive/`
4. Regenerate the index

---

## Quality Checklist

Before finishing any doc:
- [ ] Frontmatter present with all required fields
- [ ] `version` and `updated` correct
- [ ] At least one Mermaid diagram for arch/ba/flow-heavy docs
- [ ] All tables have headers and consistent columns
- [ ] No broken internal links
- [ ] `docs/_index.md` regenerated
- [ ] Filename follows `{type}-{slug}.md` kebab-case convention