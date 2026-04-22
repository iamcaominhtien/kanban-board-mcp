---
name: feedback
description: "Submit manual feedback to trigger self-improvement AND any follow-up work actions. Use when you want to correct agent behavior, update conventions, fix missing docs, adjust UI patterns, or improve any aspect of the system — the agent will self-improve AND act on the feedback immediately."
agent: project-manager
---

The user is giving you explicit, intentional feedback. Your job is two things:
1. **Self-improve** — update the relevant prompt, skill, agent config, or instruction file so the mistake won't repeat.
2. **Act on it** — if the feedback implies a real-world change (missing doc, wrong code, broken convention, etc.), do that work too.

---

## Step 1 — Understand the Feedback

Read the feedback carefully. Before doing anything, ask yourself:
- Is the feedback clear enough to act on?
- Does it imply a change to **agent behavior** (self-improvement target)?
- Does it imply a change to **the codebase, docs, or config** (follow-up work)?

If the feedback is ambiguous, ask one focused clarifying question to surface the intent. Keep it to one question — don't interrogate.

---

## Step 2 — Self-Improvement

Identify what needs to change in the system prompts/skills/instructions:

| Feedback about | File to update |
|---|---|
| Agent behavior or tone | `.github/agents/<agent>.agent.md` |
| Skill logic or output format | `.github/skills/<skill>/SKILL.md` |
| Project-wide conventions | `.github/copilot-instructions.md` |
| Delegation or cross-agent rules | `.github/instructions/<rule>.instructions.md` |

Delegate the file update to the `errand-boy` agent with a precise instruction: what to change, where, and why.

---

## Step 3 — Follow-Up Work

After self-improving, look at the feedback again and ask: **does the feedback point to something broken or missing right now?**

Examples:
- "You forgot to write docs for this feature" → after self-improving, also delegate to `knowledge-keeper` to write the missing docs
- "This component has no unit tests" → also delegate to `developer` or `qc` to add the tests
- "The UI color is wrong" → also delegate to `developer` to fix it
- "The ticket was never created for this work" → also delegate to `kanbander` to create it

If yes → plan and execute the follow-up work using the standard PM workflow (create ticket if needed, delegate to the right agent, review output).

If no → self-improvement alone is sufficient. State clearly that the improvement has been applied.

---

## Step 4 — Confirm

Report back to the user with:
- What was updated (which file, what changed)
- What follow-up work was done (if any)
- One-line summary of how the system will behave differently going forward

Keep it brief.
