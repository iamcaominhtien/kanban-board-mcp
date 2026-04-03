# Frameworks & Mental Models

Practical thinking tools — use them when you need structure, not just intuition.

---

## First Principles Thinking

Break a problem down to what you **actually know is true**, not what you assume.

**Ask:**
- What do I know for certain here?
- What am I taking on faith?
- If I remove all the "we've always done it this way" rules — what am I left with?

**Use when:** Designing a solution, questioning a constraint, or someone says "that's just how it works."

---

## Inversion (Think Backwards)

Instead of *"How do I make this succeed?"* — ask *"What would guarantee this fails?"*

**Steps:**
1. State the goal.
2. Ask: "What would cause this to fail completely?"
3. List all the failure modes.
4. Work backwards and eliminate them.

**Use when:** Planning something important. Before deploying or shipping.

---

## Pre-mortem

Imagine it is 6 months from now. The project **failed completely**.

**Ask:** "What went wrong?"

Work backwards from that imagined failure. This surfaces concerns people are afraid to raise during optimistic planning.

**Use when:** Starting a project, planning a feature, committing to an approach.

---

## Second-Order Thinking ("And then what?")

First-order: "This quick fix solves the problem."
Second-order: "And then what? What breaks at scale?"

Keep asking "And then what?" until you reach a real consequence.

**Ask:**
- What happens immediately?
- And then what happens next?
- And then what? (repeat 2-3 times)

**Use when:** Evaluating trade-offs, technical debt, quick fixes, architecture decisions.

---

## Socratic Questioning

A 6-question loop to examine any belief or plan:

1. **Clarify:** "What exactly do I believe? Why?"
2. **Challenge assumptions:** "What if the opposite were true?"
3. **Demand evidence:** "What's the source? Can I verify this?"
4. **Consider alternatives:** "How would someone who disagrees see this?"
5. **Examine consequences:** "What happens if I'm wrong?"
6. **Question the question:** "Am I solving the right problem?"

---

## Steel-manning

Before responding to an idea you disagree with — articulate the **strongest possible version** of that idea.

**Steps:**
1. State the other person's argument as well as they would.
2. Only then respond to *that* version.

**Why:** If you're only defeating a weak version of an idea, you have not actually engaged with it.

---

## Red-Teaming

Actively try to break, attack, or poke holes in a plan before it ships.

**Ask:**
- How would I break this design?
- What edge cases does the author not see?
- What inputs could cause this to fail?
- If I were an attacker — what would I target here?

**Use when:** Code review, security review, reviewing architecture decisions.

---

## Chesterton's Fence

> Never remove something until you understand *why it was put there.*

If you see old code, a legacy rule, or an "unnecessary" config — don't remove it until you know what it's protecting.

**Ask:** "Why does this exist? What breaks if I remove it?"

**Use when:** Deleting code, changing behavior, refactoring legacy systems.

---

## Five Whys

Ask "Why?" five times until you reach the root cause.

Most problems presented to engineers are **symptoms**. The actual cause is 3-5 whys deeper.

**Example:**
- Bug: users are getting logged out. Why?
- Session expired. Why?
- Token refresh is failing. Why?
- The refresh endpoint changed. Why?
- A migration removed the old route without redirecting. Why?
- Nobody checked the dependent consumers. → Root cause.

---

## Occam's Razor

Among competing explanations, prefer the one with **fewer assumptions**.

Start with the simplest explanation when debugging — before jumping to complex root causes.

---

## Margin of Safety

Whatever you think is true — **assume you are partially wrong**. 

Build a buffer. Prefer reversible steps. Ask "If I'm wrong about one key assumption — what's my recovery plan?"
