---
name: auto-deliver
description: "Autonomous end-to-end delivery skill for the project-manager agent ONLY. Use when: the user gives a feature idea or improvement goal and wants the PM to handle the full cycle autonomously — ideation, research, planning, ticket creation, implementation, testing, merging, release, and work logging — with minimal interruptions. Triggers: 'auto-deliver this', 'ship this autonomously', 'handle end-to-end', 'run the full cycle', 'build and ship this', 'autonomous delivery', 'ideate and implement', 'do it all'."
argument-hint: "Describe the feature, idea, or goal to deliver — e.g. 'add dark mode toggle', 'optimize the ticket search endpoint'."
---

# Auto-Deliver Skill

This skill drives a **fully autonomous delivery pipeline** from raw idea to shipped release. The PM orchestrates all agents without interrupting the user at every step — only pausing at the critical approval gates defined below.

---

## Golden Rule

**Pause only at gates. Run everything else autonomously.**

Gates are mandatory user approvals before continuing. All other steps execute automatically.

---

## Phase 1 — Discovery: Ideate & Research

**Goal:** converge on the best solution before writing a single line of code.

### 1.1 Brainstorm
Delegate to `brainstormer`:
- Problem framing: what user pain or system gap does this solve?
- At least 3 solution approaches with trade-offs
- Recommended path and rationale

### 1.2 Research (if external knowledge needed)
If the brainstormer surfaces technical unknowns (libraries, patterns, APIs, best practices), delegate to `internet-researcher`:
- Specific questions only — no open-ended "research everything about X"
- Request a 3–5 bullet summary with source links

### 1.3 Synthesize
Compile findings into a **Solution Brief**:

```
## Solution Brief

**Goal:** <1-sentence problem statement>
**Chosen approach:** <selected option + rationale>
**Key decisions:**
- <decision 1>
- <decision 2>
**Out of scope:** <what won't be done>
**Risks:** <top 1–2 risks>
```

---

## 🔴 GATE 1 — Solution Approval

Present the Solution Brief to the user. **Wait for explicit approval before continuing.**

If rejected: revise or re-run discovery as directed.

---

## Phase 2 — Planning: Spec & Ticket Setup

**Goal:** produce a clear execution plan and Kanban artifact before any code is touched.

### 2.1 Document
Delegate to `knowledge-keeper` to create or update the BA spec in `docs/specs/` reflecting the chosen solution.

### 2.2 Create Ticket
Delegate to `kanbander` to create (or update) the main ticket with:
- Clear title and description
- Acceptance criteria matching the Solution Brief
- Priority set
- Initial Work Log entry: `[DATE] project-manager: Solution approved. Starting delivery.`

### 2.3 Break into Subtasks (if needed)
If the ticket is too large (> ~2 days), break it down now:
- Create child tickets via `kanbander` (one per logical unit)
- Each subtask = its own branch + PR + merge cycle
- Never create subtasks mid-implementation

### 2.4 Branch
Instruct `developer` to create the feature branch off `main` following the `git-workflow` skill:
```bash
git checkout main && git pull origin main
git checkout -b feature/<ticket_id>
```

---

## Phase 3 — Build: Implement & Auto-Review

**Goal:** produce clean, reviewed code meeting all acceptance criteria.

### 3.1 Implement
Delegate to `developer` with:
- Link to BA spec
- Full acceptance criteria list
- Branch name to work on
- Instruction to open a PR after pushing, **not** merge directly

### 3.2 Simplify (automatic, no user prompt)
After the PR is opened, immediately delegate to `code-simplifier`:
- Analyze the PR diff for complexity, duplication, and clarity
- Apply improvements on the same branch

### 3.3 Review (automatic, no user prompt)
After simplifier completes, immediately delegate to `code-change-reviewer`:
- Full code review with cybersecurity + technical-lead lens
- Output: approve OR list of required changes

**If changes requested:** loop back to `developer` → `code-simplifier` → `code-change-reviewer` until approved. No user interruption unless the loop exceeds 3 iterations (then surface the blocker).

---

## Phase 4 — Test: QC Write & Execute

**Goal:** verify all acceptance criteria are met before shipping.

### 4.1 Write Test Plan (automatic)
After reviewer approves, immediately delegate to `qc` to write a complete test plan in `docs/test-plans/<ticket-id>.md`.

### 4.2 Execute Tests (automatic)
After the test plan is written, delegate to `qc` to execute tests via Playwright where applicable.

**If bugs found:** loop back to `developer` → repeat review → repeat QC. No user interruption unless the bug is a blocker the PM cannot resolve (then surface it with a clear description and options).

---

## 🔴 GATE 2 — Ship Approval

Report to the user:
- Summary of what was built (linked to PR)
- QC result summary (pass/fail counts)
- Any known limitations

**Wait for explicit "ship it" or equivalent confirmation before merging.**

---

## Phase 5 — Deliver: Merge, Release & Close

**Goal:** ship cleanly and leave no loose ends.

### 5.1 Include QC Docs in PR
Instruct `developer` to copy the test plan doc (`docs/test-plans/<ticket-id>.md`) into the PR branch and push before merging.

### 5.2 Merge
Squash merge via GitHub (preferred for clean history):
```bash
gh pr merge <PR_number> --squash --delete-branch
```

### 5.3 Create Release
```bash
gh release create v<X.Y.Z> \
  --title "v<X.Y.Z> — <short feature title>" \
  --notes "<what was shipped and why>"
```
Increment version: patch for fixes, minor for features, major for breaking changes.

### 5.4 Close Ticket
Delegate to `kanbander`: mark the ticket (and all subtasks) as **Done**.

### 5.5 Log Work
Delegate to `kanbander` to append a final Work Log to the ticket:
```
[DATE] project-manager: Delivery complete. PR #N merged. Release vX.Y.Z created. All ACs verified by QC.
```

### 5.6 Update Memory
Store the delivery outcome in the knowledge graph:
- Decision entity for any non-obvious architectural choices made
- Any new risks surfaced during the cycle (add to RAID)

### 5.7 Cleanup (automatic)
Delegate to `errand-boy`:
- Delete any temp QC test files outside `docs/test-plans/`
- Confirm feature branch is deleted remotely

---

## Summary Output

After full completion, present to the user:

```
✅ <Feature Name> — SHIPPED

Released: vX.Y.Z
PR: #N — <title>
Ticket: <ticket-id> → Done
QC: <X> tests passed, 0 blockers

Key decisions made:
- <decision 1>
- <decision 2>

Next steps (optional): <suggestions if any>
```

---

## Constraints

- **PM never writes code directly.** All code changes are delegated to `developer`.
- **Gate 1 and Gate 2 are mandatory.** No autonomous shipping without user confirmation.
- **If a loop runs > 3 iterations** (review or QC), surface the blocker — do not loop infinitely.
- **Subtasks are planned upfront** (Phase 2), never created mid-implementation.
- **Each subtask follows the same Build → Test → Ship cycle** independently before the parent is closed.
