---
description: Generate a Conventional Commit message based on my changes.
---

// turbo
1. Review the staged changes (or the current file).
2. Generate a concise commit message following these rules:
   - Format: `<type>(<optional scope>): <description>`
   - Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, or revert.
   - Lowercase description, no period at the end.
   - Header < 50 characters.
   - Add a body for complex changes, separated by a blank line.
3. Output ONLY the commit message text.
