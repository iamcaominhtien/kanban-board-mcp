## Summary

One or two sentences: who gets what, and why it matters now. Link the ticket (KAN-12) and any Story.

## User stories

Ordered by priority. Each one can be built and tested on its own: P1 alone is already worth shipping.

### P1 · <title>

As a <who>, I want <what>, so that <why>.

- **Test on its own:** how a tester sees that this story works, without the others.
- **Acceptance scenarios:**
  1. **Given** <starting state>, **when** <action>, **then** <what the user sees or gets>.
  2. **Given** …, **when** …, **then** …

### P2 · <title>

…

## Edge cases

- Empty, zero, the largest value, wrong input: what happens?
- First time (empty state), offline, permission refused, the server fails.
- Time: midnight, another time zone. Language and number format.

## Functional requirements

Numbered, one behaviour each, observable. The ticket's acceptance criteria carry the same numbers.

- **FR-001** The system shall <behaviour>.
- **FR-002** When <event>, the system shall <response>.
- **FR-003** While <state>, the system shall <behaviour>.
- **FR-004** If <unwanted condition>, then the system shall <response>.
- **FR-005** <something not decided yet> **[NEEDS CLARIFICATION: the question, and who decides]**

## Rules and data

Business rules (limits, numbers, who may do what) and the data the feature reads or writes. Many conditions
together: a decision table. New fields: a data dictionary.

## Copy

The exact words of buttons, messages, empty states and errors, in the product's language.

## Success criteria

Measurable and free of technology: **SC-001** "A first-time user reserves a book in under 30 seconds."

## Out of scope

What this does not do, so nobody builds it.

## Assumptions and open questions

- Assumption: <what you assumed because nobody decided it>; who can correct it.
- Question: <question> · options · recommendation · who decides.
