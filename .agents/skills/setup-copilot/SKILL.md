---
name: setup-copilot
description: 'Setup GitHub Copilot instructions for a project. Use when: initializing copilot for a new repo, generating or updating .github/copilot-instructions.md, personalizing how Copilot responds, capturing project role/stack/conventions once to avoid repeating them every chat. Triggers: "setup copilot", "initialize copilot", "create copilot instructions", "update copilot instructions", "configure copilot", "personalize copilot", "build copilot-instructions.md", "help Copilot understand my project".'
argument-hint: 'Optional: describe your project briefly, or leave blank to auto-scan'
---

# Setup Copilot Instructions

Builds or regenerates `.github/copilot-instructions.md` — the persistent context file that shapes how GitHub Copilot responds across every chat in this workspace.

## What It Produces

A `copilot-instructions.md` that captures:
- **Role & stack** — what kind of project this is and what the agent should behave like
- **Architecture** — key components, layers, service boundaries
- **Build & test commands** — so agents can run them without asking
- **Conventions** — patterns that differ from defaults (naming, error handling, logging, etc.)
- **Key doc links** — pointers to deeper docs instead of duplicating content

---

## Procedure

### Step 1 — Scan the Repo

Run a broad, parallel scan to collect signals about the project. Look for:

| Signal | Where to look |
|---|---|
| Language / runtime | `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `*.csproj`, `Gemfile`, `pom.xml`, `build.gradle` |
| Framework | Imports in entry-point files, config files (`next.config.*`, `vite.config.*`, `fastapi`, `django`, `rails`) |
| Architecture | Folder structure, `src/`, `app/`, `services/`, `packages/`, monorepo markers |
| Build / test commands | `Makefile`, `scripts` field in `package.json`, CI config (`.github/workflows/*.yml`, `Jenkinsfile`) |
| Coding conventions | `eslint.config.*`, `.prettierrc`, `pyproject.toml [tool.ruff]`, `CONTRIBUTING.md` |
| Existing docs | `README.md`, `docs/`, `ADR-*.md` |
| Existing instructions | `.github/copilot-instructions.md`, `.github/AGENTS.md` |

> **Note:** Always ignore the `.github/` folder during scanning — it contains default Copilot/agent setup boilerplate that is not specific to the project being set up.

**If the repo is essentially empty** (no code files, no config outside `.github/`, only `.git/`) → skip to **Step 2 (Empty Repo)**.
**If the repo has content** → skip to **Step 3 (Generate)**.

---

### Step 2 — Empty Repo Interview

The project is new. Ask the user these questions (can ask all at once):

```
I can see this repo is empty. To build useful Copilot instructions I need a bit of context:

1. What are you building? (e.g. REST API, web app, CLI tool, mobile app, data pipeline)
2. What language(s) and framework(s) are you planning to use?
3. What's your role on this project? (solo dev, tech lead, full-stack, backend, etc.)
4. Any strong preferences? (e.g. functional over OOP, strict typing, test-first, specific patterns)
5. Are there any agent tools or MCP integrations planned? (e.g. GitHub, databases, Jira)
6. Will this be a team repo shared with others, or personal?
```

Collect answers, then proceed to **Step 3**.

---

### Step 3 — Generate `copilot-instructions.md`

Using the signals from Step 1 or answers from Step 2, compose the file following these rules:

**Rules:**
- Include only sections that are meaningful for THIS project
- Be concise and actionable — every line should guide behavior, not describe what the project does
- Link to existing docs (`See docs/TESTING.md`) instead of duplicating them
- Do NOT add linter-enforced conventions (Copilot cannot override tooling anyway)
- Keep total file under ~150 lines

**Use this structure** (omit sections that don't apply):

```markdown
# Project: <name>

## Role
<Describe what role the agent should adopt — e.g. "You are a senior backend engineer on a FastAPI service." This should reflect the user's own role and expectations.>

## Tech Stack
- Language: <...>
- Framework: <...>
- Runtime / infra: <...>
- Key libraries: <...>

## Architecture
<2–5 bullet points describing major layers, service boundaries, or module layout. Focus on "why" and non-obvious decisions.>

## Build & Test
```bash
# Install
<install command>

# Run locally
<run command>

# Test
<test command>
```

## Conventions
<Non-obvious patterns specific to this project. Examples:>
- Prefer <X> over <Y> for <reason>
- All errors must be <logged/wrapped/re-raised> using <pattern>
- File naming: <snake_case / kebab-case / etc.>
- <Any other project-specific deviations from defaults>

## Key Docs
- [CONTRIBUTING.md](../CONTRIBUTING.md) — coding standards and PR process
- [docs/architecture.md](../docs/architecture.md) — system design
- <add more as relevant>

## Agent Notes
<Optional. Anything specific the agent must know:>
- Always ask before touching <sensitive area>
- Prefer editing existing files over creating new ones
- <Team / repo-specific agent guidelines>
```

---

### Step 4 — Write and Confirm

1. Write the generated content to `.github/copilot-instructions.md`.
2. Show the user the file path and a brief summary of what was captured.
3. Ask: *"Does this look right? Anything to adjust — your role, missing conventions, or stack details?"*
4. Apply any corrections and confirm the final file.

---

### Step 5 — Suggest Next Steps

After the file is confirmed, suggest relevant follow-ups:

- **Agent-specific instructions** (`.github/instructions/`) — if the project uses specialized skills or agents
- **Custom agents** (`.github/agents/`) — if certain workflows would benefit from dedicated modes
- **Prompts** (`.github/prompts/`) — for repeatable task templates (e.g. code review, PR description)
- **Skills** (`.github/skills/`) — for on-demand multi-step workflows

---

## Quality Checklist

Before finishing, verify:
- [ ] File is at `.github/copilot-instructions.md` (not nested deeper)
- [ ] Role section accurately reflects the user's perspective
- [ ] Build & test commands were verified (or noted as approximate)
- [ ] Conventions are specific and actionable — not generic advice
- [ ] No section duplicates what a linter or existing doc already enforces
- [ ] File is under 150 lines
