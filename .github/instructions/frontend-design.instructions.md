---
description: Apply when building, editing, or reviewing any frontend UI code for this project (React components, CSS, styling, layout).
applyTo: "ui/**"
---

# Required Skills

Always load the skill `frontend-design` before proceeding.

# Frontend Design — Kanban Board MCP

When building UI for this project, always follow the Bento Grid design system defined below.

## Design System (Quick Reference)

```css
--color-bg:      #F5EFE0;  /* page background */
--color-dark:    #3D0C11;  /* text, headers, dark tiles */
--color-yellow:  #F5C518;  /* Backlog column */
--color-orange:  #E8441A;  /* To Do column */
--color-lime:    #AACC2E;  /* In Progress column */
--color-pink:    #F472B6;  /* Done column */
--color-blue:    #5BB8F5;  /* tags, info, links */
```

## Rules

- **Stack**: Vite + React + TypeScript
- **Drag-and-drop**: `dnd-kit` only
- **Font**: DM Sans (bold/black for headings, regular for body)
- **Border-radius**: `16px` cards, `20px` columns/panels
- **No gradients, no shadows** — solid color blocks for depth
- **No two columns share the same accent color**
- Cards sit on `--color-dark` background inside columns for contrast
- Animations: `transform` + `opacity`, 200–300ms ease

## Phase 1 Constraints

- **Mock data only** — no backend calls, no MCP integration yet
- All ticket state lives in React local state or context