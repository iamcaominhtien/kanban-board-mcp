---
name: self-improvement
description: Protocol for all agents to detect user feedback and trigger the self-improvement loop.
applyTo: "**"
---

# Self-Improvement Loop

All agents must watch for user feedback and decide whether it warrants updating a prompt, skill, or agent config. When it does, delegate the update to the `errand-boy` agent.

---

## Step 1 — Detect Feedback

A message contains **actionable feedback** when it expresses a specific preference, critique, or finding about:
- Code style, architecture, or patterns used in this project
- UI aesthetics (colors, spacing, layout, component style)
- Agent or skill behavior (tone, structure, output format)
- Tooling or dependency choices

**Do not act on:**
- Vague frustration without specifics ("this sucks", "I hate this")
- Casual hypotheticals ("what if we someday tried X")
- One-off fixes that don't reflect a broader preference

---

## Step 2 — Classify the Feedback

### Verifiable feedback
The claim can be tested or confirmed objectively.  
*Examples: "global imports slow app startup", "this regex fails on Unicode input", "the API returns 429 on retries"*

**Protocol:**
1. Acknowledge the claim
2. Clarify if needed ("Slow by how much? Which import?")
3. Verify — run a test, check a benchmark, inspect the code
4. If confirmed → update immediately, no further approval needed
5. Delegate the prompt/skill update to `errand-boy`

### Subjective feedback
The claim is about taste, aesthetics, or preference — no single right answer.  
*Examples: "this button looks off", "the theme feels cold", "the agent tone is too formal"*

**Protocol:**
1. Engage — ask follow-up questions to surface intent ("What feeling should the button convey?")
2. Offer options or proposals to help the user decide
3. Keep discussing until you reach a **concrete spec** ("black background, white text, 8px border-radius")
4. Once spec is confirmed → delegate the prompt/skill update to `errand-boy`

---

## Step 3 — Delegate the Update

Once feedback is confirmed (verified OR spec-settled), call:

```
Use the errand-boy agent to update [file path] — [what to change and why, in 1–2 sentences]
```

The errand-boy handles all file edits. You do not edit prompts or skill files directly.

---

## What Gets Updated

| Feedback about | File to update |
|---|---|
| Agent behavior or tone | `.github/agents/<agent>.agent.md` |
| Skill logic or output format | `.github/skills/<skill>/SKILL.md` |
| Adding a template or asset | New file in `.github/skills/<skill>/` |
| Project-wide conventions | `.github/copilot-instructions.md` |
| Delegation or cross-agent rules | `.github/instructions/<rule>.instructions.md` |
