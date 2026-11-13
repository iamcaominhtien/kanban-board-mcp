# Before you hand in: check every criterion and page

Studies of AI-written requirements found them well-formed but failing quality checks more often than a person's,
and longer. Go through this list; fix what fails.

## Each criterion or requirement
- [ ] **One behaviour.** No "and" joining two things a tester would check separately.
- [ ] **Observable.** A tester sees it on the screen, in the data or in the output.
- [ ] **Concrete.** Numbers, names and exact words, not "fast", "easy", "appropriate", "user-friendly", "etc.".
- [ ] **Testable without asking you.** QA could write the pass/fail test from it alone.
- [ ] **Free of the solution.** What the user gets, not which table, endpoint or library.
- [ ] **Fits the product as it is.** The screen, platform and data it talks about exist (or are part of this work).
- [ ] **No contradiction** with another criterion, the design or an earlier decision.

## The set
- [ ] Every story or behaviour of the ticket has criteria; nothing in them is out of the ticket's scope.
- [ ] The edge cases and errors that matter are covered.
- [ ] Each open point is marked [NEEDS CLARIFICATION] with who decides, not guessed.
- [ ] Small enough: a story with more than about 8 criteria or 4 rules is split, or the split is proposed.

## Length
- [ ] A criterion is one or two lines. A spec page is as long as its content needs, usually under two screens; cut
      repetition, history and general advice.
