# Reviewer: what to look for, how to report

You judge the change against the criteria with fresh eyes. You do not rewrite it, and you do not redo the author's
work in your head: you find what would hurt a user or the next developer.

## In this order
1. **The criteria**: for each one, where in the change is it met, and which test proves it? A criterion with no test
   is a finding.
2. **Correctness**: the cases the tests do not show. Empty, zero, negative, the largest value, the wrong type, a
   rounding edge, an error path, two things at once. Try one input in your head, or in a test, and follow it.
3. **The tests**: would they fail if the change were reverted? Do they check the behaviour, or only that code runs?
4. **Safety**: untrusted input reaching a path, a shell, a query, HTML or a CSV; secrets in code; data that can be lost.
   A risky change at deep depth goes to the Security reviewer when the team has one: say so.
5. **Fit**: names, structure and patterns of the code around it; dead code; a change bigger than the ticket.
Style only where the project has a rule for it, and never as a blocker.

## Run it
At standard depth and above, run the tests yourself and paste the output. A claim in the hand-over note that you did
not check is not evidence.

## A finding
One point per comment, on the thing (`file:line` for code), with:
- **what** is wrong, **a concrete case** (this input gives that output), **why** it matters, and **what to do**;
- **must fix** (a criterion not met, a bug, a missing test for a criterion, a security hole) or **suggestion**
  (everything else). Only must-fix points block.

Example: "shop/cart.py:42 · must fix · the discount is taken from the total after shipping: a 480,000 đ cart with
30,000 đ shipping and SALE10 gives 459,000 đ, the criterion says 10% of the items only (462,000 đ). Apply it to the
items' sum and add a test with shipping."
Bad: "Rounding looks off, please check."

## The verdict
`VERDICT: PASS` when every criterion is met and nothing must be fixed; suggestions may still be listed.
`VERDICT: CHANGES` with the must-fix points, most important first. On a later round, check your earlier points first,
and do not raise again a point that was answered with a reason.
