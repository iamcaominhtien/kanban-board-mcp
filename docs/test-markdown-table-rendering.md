---
title: "Test Plan: Markdown Table Rendering in Ticket Descriptions"
type: test
status: review
version: 1.2.0
created: 2026-04-15
updated: 2026-04-15
authors: [GitHub Copilot]
related: []
---

# Test Plan: Markdown Table Rendering in Ticket Descriptions

## 1. Scope
This plan verifies whether markdown entered in a ticket description renders correctly in the Kanban board UI, with emphasis on GitHub-style tables.

In scope:
- Markdown table rendering
- Raw markdown leakage for table syntax
- Bold rendering
- Italic rendering
- Bullet list rendering
- Visual and DOM verification in the ticket modal

Out of scope: backend persistence beyond the created test ticket, export behavior, and markdown rendering outside the ticket description UI.

## 2. Test Strategy

| Layer | Approach | Tools |
|---|---|---|
| E2E | Create a test ticket containing a markdown table and other markdown elements, then inspect it in the ticket detail view | Playwright MCP |
| Code inspection | Trace the description rendering component and markdown configuration | ripgrep, file reads |

## 3. Test Cases

| ID | Description | Preconditions | Steps | Expected Result | Status |
|---|---|---|---|---|---|
| TC-01 | UI is reachable | Vite dev server available | Open the Kanban board URL | Board renders without blocking errors | ✅ Pass |
| TC-02 | Ticket with markdown payload can be created and viewed | Ability to create a ticket via API or UI | Create a ticket, open it in the UI, and display the description area | Ticket modal/detail opens successfully with saved markdown content | ✅ Pass |
| TC-03 | Markdown table renders visually as a table | Ticket detail view open with markdown table description | Inspect description area and capture screenshot | Table renders as a formatted table with rows and columns, not as raw pipe text | ❌ Fail |
| TC-04 | Raw table markdown is not leaked as plain text | Ticket detail view open with markdown table description | Inspect rendered description text and DOM | The header separator row and raw pipe layout are not displayed as plain text | ❌ Fail |
| TC-05 | Bold, italic, and bullet list markdown render correctly | Ticket detail view open with description containing these elements | Inspect rendered description text and DOM | Bold appears in strong emphasis, italic in emphasis, and bullets as a list | ✅ Pass |
| TC-06 | Rendering component and markdown capability can be identified | Repository available | Inspect UI code path for description markdown | Responsible component/file is identified with evidence, including any table support gap | ✅ Pass |

## 4. Edge Cases & Negative Tests
- [ ] Raw pipe-separated text is not shown for valid markdown table syntax
- [ ] No console errors appear while opening the ticket description view
- [ ] Markdown emphasis and lists do not regress while testing the table scenario

## 5. Coverage Goals

| Area | Target |
|---|---|
| Ticket description rendering | 100% of requested checks |
| Markdown formatting coverage | Table, bold, italic, bullet list |
| Visual evidence | 1 clear screenshot of the rendered description area |

## 6. Test Data
Ticket title prefix: [TEST] Markdown table rendering

Description payload:

```md
**Bold text**

*Italic text*

- Bullet one
- Bullet two

| Column A | Column B |
|---|---|
| Value 1 | Value 2 |
| Value 3 | Value 4 |
```

## 7. Execution Notes
- Target UI URL: http://127.0.0.1:5173
- Execution date: 2026-04-15
- Test ticket: SBFF-23 (`[TEST] Markdown Table Rendering 2026-04-15`)
- Evidence files created during execution must be removed after reporting

## 8. Results
Executed via Playwright against the live UI at http://127.0.0.1:5173/?ticket=SBFF-23.

Observed rendering:
- Bold rendered as `<strong>`
- Italic rendered as `<em>`
- Bullet list rendered as `<ul><li>`
- Table markdown did not render as `<table>`
- Raw table syntax remained visible in the description area as plain text

DOM evidence captured from the description container:

```html
<p><strong>Bold text</strong></p>
<p><em>Italic text</em></p>
<ul>
<li>Bullet one</li>
<li>Bullet two</li>
</ul>
<p>| Column A | Column B |
|----------|----------|
| Value 1  | Value 2  |
| Value 3  | Value 4  |</p>
```

Element counts from the rendered description:
- `table`: 0
- `strong`: 1
- `em`: 1
- `ul`: 1
- `li`: 2

## 9. Findings
Primary finding: markdown tables do not render in ticket descriptions.

Supporting findings:
- Basic markdown is partially supported: bold, italic, and unordered lists render correctly.
- The description viewer uses `react-markdown` in read-only mode, but the UI dependencies do not include `remark-gfm`, which is required for GitHub Flavored Markdown table parsing.
- The renderer therefore treats the table block as ordinary paragraph text instead of producing semantic table markup.

Code evidence:
- `ui/src/components/MarkdownEditor.tsx` renders descriptions with `ReactMarkdown` and `rehype-sanitize`, but no GFM plugin.
- `ui/package.json` includes `react-markdown` and `rehype-sanitize`, but no `remark-gfm` dependency.