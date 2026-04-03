# Checklists

Situation-specific questions to ask yourself before acting.

---

## Receiving an Idea

Someone pitches you a feature, an approach, or an opinion.

- What problem does this actually solve?
- What assumptions is this built on? Are they verified?
- What would I need to see to reject this idea?
- What is the strongest argument *against* it?
- Who benefits from me believing this? (incentive check)
- Do I agree because it's *true*, or because the person seems confident?

---

## Cross-Checking Info

Before implementing based on docs, reports, or someone's claim.

- Is this the most current version / source?
- Who wrote this, when, and what are they incentivized to say?
- Can I find a second independent source that confirms this?
- Do the primary sources (code, logs, metrics) match what I was told?
- How confident am I, really? What's my evidence quality?

---

## Planning

Before committing to a feature design, project plan, or architectural direction.

- What do I *actually* know vs. what am I *assuming*?
- What are the explicit assumptions? Have I listed them all?
- If this plan fails completely — what most likely caused the failure? (pre-mortem)
- What are the second and third-order consequences?
- Which parts of this are reversible? Which are not?
- What would a skeptic say? Do I have a good answer?
- What unknowns could change this plan if we discovered them?
- Am I solving the actual user problem, or a symptom of it?

---

## Code Review

When reviewing someone else's (or your own) code.

- Do I understand *why* this was written this way?
- What is the failure mode of this code?
- What inputs or edge cases could break this?
- Is there existing code this change might affect unexpectedly?
- Why does this older code exist? (Chesterton's Fence — before changing it)
- Is validation happening at the correct boundary?
- If I were attacking this system — what would I target here?
- At 10x traffic or 10x data volume — does this still hold up?

---

## Making a Change

Before modifying existing code or behavior.

- Have I read and understood the existing code before touching it?
- Why does the thing I'm about to change exist? What does it protect?
- What is the minimal change that solves this problem?
- What other parts of the system depend on this?
- How will I detect if this change breaks something?
- Is this change reversible? If not — am I certain enough to be irreversible?
- Am I fixing the actual problem or just a symptom?

---

## Daily General Check

Quick 30-second gut check before any significant decision or action.

- Am I accepting this because it's true — or because it's comfortable?
- Have I heard the strongest opposing argument?
- Am I about to do something I cannot undo without the certainty to justify it?
- Is action actually required right now — or would waiting give me better information?
