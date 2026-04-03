---
title: "BA Spec: <Feature>"
type: ba
status: draft
version: 1.0.0
created: YYYY-MM-DD
updated: YYYY-MM-DD
authors: [Name]
related: []
---

# BA Spec: <Feature>

## 1. Purpose & Scope
_What this feature does and what it does NOT do._

## 2. Stakeholders & Actors

| Actor | Role | Interaction |
|---|---|---|
| End User | Uploads document | Via web UI |

## 3. User Stories

| ID | Story | Priority | Acceptance Criteria |
|---|---|---|---|
| US-01 | As a user, I want to... | High | Given … When … Then … |

## 4. Business Rules
1. Rule 1: ...
2. Rule 2: ...

## 5. Data Model

```mermaid
erDiagram
    USER ||--o{ DOCUMENT : uploads
    DOCUMENT {
        string id
        string status
    }
```

## 6. Workflows / Process Flows

```mermaid
flowchart LR
    A[Upload Doc] --> B{Valid?}
    B -- Yes --> C[Process]
    B -- No --> D[Return Error]
```

## 7. API Contract (summary)
_Full spec in `api-{feature}.md`._

## 8. Out of Scope
- ...

## 9. Glossary

| Term | Definition |
|---|---|
