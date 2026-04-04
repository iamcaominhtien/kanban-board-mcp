---
name: unit-testing
description: "Unit testing & component testing skill for any language or framework. Use when: writing tests, setting up a test suite, thinking about what to test, applying TDD, testing a React component, testing a Python/Node.js backend, mocking dependencies, checking test coverage, understanding unit vs component vs integration tests. Triggers: 'write a test', 'add tests for', 'unit test this', 'component test', 'test this function', 'how do I test', 'TDD', 'what should I test', 'set up vitest', 'set up pytest', 'test coverage', 'mock this', 'I don't know how to test this'."
argument-hint: "Describe what you want to test — a function, a component, an API endpoint, or a behavior. Include the file path and language/framework if known."
---

# Unit Testing Skill

## Core Mindset

> **A test is a specification written in code, not a proof that code works.**

This distinction matters. When you write a test to "prove it works", you unconsciously write tests that pass. When you write a test to *specify behavior*, you write tests that actually catch bugs.

Before touching any test file, ask yourself:
- **What is the behavior I'm specifying?** (not: what code am I covering?)
- **What would have to break for this test to fail?** (if nothing obvious, the test is probably worthless)
- **Would someone reading this test understand the feature?** (if not, the name or structure is wrong)

---

## How to Think About What to Test

Not everything deserves a test. Apply this filter:

**Worth testing — code that:**
- Contains branching logic (if/else, conditions, rules)
- Transforms data (sort, filter, map, parse, format)
- Has edge cases that are hard to catch manually (null, empty, boundary, error path)
- Would cause a silent bug if broken — wrong output, no crash

**Not worth testing — code that:**
- Just passes data through with no logic
- Delegates entirely to a well-tested library
- Is so trivial that reading it is faster than reading a test for it

The goal is **high-value coverage**, not high-percentage coverage. A 40% test suite that covers all business logic beats a 90% suite of tautological tests.

---

## Mental Model: The Test Spectrum

```
Unit          →    Component/Service    →    Integration    →    E2E
Fastest, most isolated                              Slowest, most real
```

| Type | Tests | When to use |
|---|---|---|
| **Unit** | One pure function, zero dependencies | Business logic, data transformations |
| **Component / Service** | One module, dependencies mocked | React component, API route handler |
| **Integration** | Multiple real parts wired together | Service + real DB, component + real hook |
| **E2E** | Full system in a real browser/env | Critical user journeys only |

**Default strategy**: most tests at unit + component level. Integration for critical paths. E2E sparingly — they're expensive to write and maintain.

---

## How to Structure Any Test: AAA

Every test, in every language, follows the same shape:

**Arrange** → set up the world (inputs, state, mocks)  
**Act** → call the thing being tested — one call, one operation  
**Assert** → verify the outcome — be specific

If your test has multiple Acts, you're testing multiple behaviors — split it.

---

## How to Think About Mocking

Mocking is about **isolating the unit under test**, not about making tests pass.

The rule: **mock at the boundary of your code** — things you don't own (HTTP, DB, filesystem, time, randomness). Don't mock code you own; if you feel the urge to, that's a signal the code is too tightly coupled.

Ask before mocking:
- Is this an external dependency (network, DB, I/O)? → mock it
- Is this code I wrote? → don't mock it, test through it
- Is this a library I imported? → don't mock it unless it's expensive (HTTP, filesystem)

---

## TDD — When It Actually Helps

TDD (write test first, then code) is not religion. Use it when:
- You're not sure how the function signature/API should look — writing the test first clarifies the interface
- You're fixing a bug — write a failing test that reproduces the bug first, then fix it

Skip TDD when you're exploring or prototyping. Come back and add tests once the shape is clear.

---

## What NOT to Test

| Skip | Why |
|---|---|
| Internal implementation details | Test breaks on refactor even when behavior is correct |
| Third-party library behavior | Their tests cover it |
| Trivial pass-throughs | No logic, no value |
| Visual appearance | Wrong tool — use visual regression |

---

## Quality Check Before Committing Tests

- [ ] Test name states the behavior: `should <do X> when <condition Y>`
- [ ] Test would actually fail if I deleted the feature
- [ ] No internal variable names or private method calls in the test
- [ ] Each test is independent — no setup shared via mutable globals
- [ ] Edge cases covered: null, empty, boundary, error path
