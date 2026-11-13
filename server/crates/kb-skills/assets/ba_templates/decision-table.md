## Rule

What the table decides, in one sentence. Link the ticket and the spec.

## Conditions and outcome

One row per combination that matters. Write every column; "any" (–) only when the condition truly does not change
the outcome. A row is one acceptance criterion and one test case.

| # | <condition 1> | <condition 2> | <condition 3> | Outcome |
|---|---|---|---|---|
| 1 | yes | yes | – | <result> |
| 2 | yes | no | yes | <result> |
| 3 | yes | no | no | <result> |
| 4 | no | – | – | <result> |

## Checks

- Every combination is covered once, and no two rows overlap.
- Boundaries named exactly ("at least 500,000 đ", not "large orders").
- Open combinations: **[NEEDS CLARIFICATION: …]**
