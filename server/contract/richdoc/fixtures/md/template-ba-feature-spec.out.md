## Summary

One or two sentences: who gets what, and why it matters now. Link the ticket (KAN-12) and any Story.

## User stories

Ordered by priority. Each one can be built and tested on its own: P1 alone is already worth shipping.

### P1 · &lt;title>

As a &lt;who>, I want &lt;what>, so that &lt;why>.

- **Test on its own:** how a tester sees that this story works, without the others.
- **Acceptance scenarios:**
  1. **Given** &lt;starting state>, **when** &lt;action>, **then** &lt;what the user sees or gets>.
  2. **Given** …, **when** …, **then** …

### P2 · &lt;title>

…

## Edge cases

- Empty, zero, the largest value, wrong input: what happens?
- First time (empty state), offline, permission refused, the server fails.
- Time: midnight, another time zone. Language and number format.

## Functional requirements

Numbered, one behaviour each, observable. The ticket's acceptance criteria carry the same numbers.

- FR-001 The system shall &lt;behaviour>.
- FR-002 When &lt;event>, the system shall &lt;response>.
- FR-003 While &lt;state>, the system shall &lt;behaviour>.
- FR-004 If &lt;unwanted condition>, then the system shall &lt;response>.
- FR-005 &lt;something not decided yet> **\[NEEDS CLARIFICATION: the question, and who decides\]**

## Rules and data

Business rules (limits, numbers, who may do what) and the data the feature reads or writes. Many conditions
together: a decision table. New fields: a data dictionary.

## Copy

The exact words of buttons, messages, empty states and errors, in the product's language.

## Success criteria

Measurable and free of technology: SC-001 "A first-time user reserves a book in under 30 seconds."

## Out of scope

What this does not do, so nobody builds it.

## Assumptions and open questions

- Assumption: &lt;what you assumed because nobody decided it>; who can correct it.
- Question: &lt;question> · options · recommendation · who decides.

