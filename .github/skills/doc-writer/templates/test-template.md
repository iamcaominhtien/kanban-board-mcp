---
title: "Test Plan: <Feature>"
type: test
status: draft
version: 1.0.0
created: YYYY-MM-DD
updated: YYYY-MM-DD
authors: [Name]
related: []
---

# Test Plan: <Feature>

## 1. Scope
_What is being tested. What is NOT being tested._

## 2. Test Strategy

| Layer | Approach | Tools |
|---|---|---|
| Unit | Pure function tests | pytest |
| Integration | API + DB | pytest + TestClient |
| E2E | Full flow | playwright |

## 3. Test Cases

| ID | Description | Preconditions | Steps | Expected Result |
|---|---|---|---|---|
| TC-01 | Happy path | User logged in | POST /resource with valid body | 200 OK, id returned |
| TC-02 | Invalid input | — | POST /resource with missing field | 422 Unprocessable Entity |

## 4. Edge Cases & Negative Tests
- [ ] Empty input
- [ ] Extremely large payload (>50MB)
- [ ] Concurrent requests

## 5. Coverage Goals

| Area | Target |
|---|---|
| Service layer | ≥ 80% |
| API routes | 100% happy path |

## 6. Test Data
_Location: `tests/fixtures/`_
