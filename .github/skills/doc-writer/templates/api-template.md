---
title: "API Reference: <Feature>"
type: api
status: draft
version: 1.0.0
created: YYYY-MM-DD
updated: YYYY-MM-DD
authors: [Name]
related: []
---

# API Reference: <Feature>

## Base URL
`/api/v1/<resource>`

## Authentication
`X-API-Key` header required on all endpoints.

## Endpoints

### `POST /<resource>`
**Description:** ...

**Request Body:**
```json
{
  "field": "value"
}
```

**Response `200`:**
```json
{
  "id": "uuid",
  "status": "queued"
}
```

**Error Codes:**

| Code | Meaning |
|---|---|
| 422 | Validation error |
| 500 | Internal server error |

---

### `GET /<resource>/{id}`
**Description:** ...

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `id` | string (UUID) | Resource identifier |

**Response `200`:**
```json
{
  "id": "uuid",
  "status": "done"
}
```
