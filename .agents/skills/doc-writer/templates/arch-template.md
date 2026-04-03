---
title: "Architecture: <Feature>"
type: arch
status: draft
version: 1.0.0
created: YYYY-MM-DD
updated: YYYY-MM-DD
authors: [Name]
related: []
---

# Architecture: <Feature>

## 1. Context
_Why does this component exist? What problem does it solve? 1–3 paragraphs._

## 2. System Overview

```mermaid
C4Context
  Person(user, "User", "...")
  System(system, "This Service", "...")
  Rel(user, system, "uses")
```

## 3. Components

| Component | Responsibility | Location |
|---|---|---|
| `ExampleService` | Orchestrates LLM calls | `app/services/example/` |

## 4. Data Flow

```mermaid
sequenceDiagram
    participant Client
    participant API
    participant Service
    Client->>API: POST /resource
    API->>Service: process(input)
    Service-->>API: result
    API-->>Client: 200 OK
```

## 5. Key Decisions
_Link to relevant ADRs._
- [ADR-NNN: Decision Title](adr-NNN-slug.md)

## 6. Non-Functional Requirements

| Concern | Target |
|---|---|
| Latency | p99 < 10s |
| Availability | 99.9% |

## 7. Open Questions / Future Work
- [ ] Item 1
