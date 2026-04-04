---
name: git-workflow
description: Step-by-step git workflow for this project. Use when starting a ticket, creating commits, opening PRs, handling review feedback, or cleaning up after a merge.
---

This skill covers the full lifecycle of a feature from branch creation to merge. The source of truth for git conventions is `copilot-instructions.md` — this skill adds the operational how-to.

## Starting a Ticket

Always branch off `main`. Never work directly on `main`.

```bash
git checkout main && git pull origin main
git checkout -b feature/<ticket_id>   # or fix/ or chore/
```

**Single machine, multiple active branches?** Use `git worktree` instead of switching:
```bash
git worktree add ../<project-name>-<ticket_id> feature/<ticket_id>
cd ../<project-name>-<ticket_id>
```
Each worktree is an independent folder on its own branch, sharing the same `.git`. No repo duplication. Safe to run in parallel.

## Committing

Use Conventional Commits: `type(scope): short description` — subject under 72 chars.

Types: `feat` `fix` `refactor` `style` `chore` `test` `docs`  
Scope: component or folder changed — e.g. `ui`, `server`, `modal`, `kanban`

## Opening a PR

```bash
git push origin <branch>

# Create the PR via GitHub CLI (preferred):
gh pr create \
  --base main \
  --title "<ticket title>" \
  --body "Closes <ticket_id>

## Summary
<what was changed and why>

## Test steps
<manual steps to verify, if any>"
```

PR must target `main`. Title = ticket title. Body must reference the ticket ID.

Notify the PM that the PR is ready for review.

## QC Test Docs

QC writes test plans and results as markdown files (e.g. `docs/test-plans/`), but QC does not commit or push code directly.

**Developer responsibility**: after QC hands over a test plan doc, the developer must:
1. Copy the doc into the repo (typically `docs/test-plans/<ticket-id>.md`)
2. Include it in the PR before merging

This keeps test artifacts tracked in git alongside the code they cover.

## Handling Review Feedback

Apply fixes on the same branch, push — the PR updates automatically. Notify PM when ready for re-review.

## After Approval — Merge & Cleanup

Squash merge on GitHub (preferred for clean history). Then locally:

```bash
git worktree remove ../<project-name>-<ticket_id>   # if worktree was used
git branch -d feature/<ticket_id>
git remote prune origin
```

## Rules

- Never commit directly to `main`
- Never force-push or amend published commits
- Never bypass hooks with `--no-verify`
- Always delete the remote branch after merging


---

## Rules

- Never commit directly to `main`
- Never force-push or amend published commits
- Never use `--no-verify` to bypass hooks
- Always delete the remote branch after merging
