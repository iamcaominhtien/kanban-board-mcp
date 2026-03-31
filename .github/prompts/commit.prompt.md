---
description: Generate a Conventional Commit message based on my changes.
---

You are an expert at writing Conventional Commit messages. 
Review the staged changes (or the current file) and generate a concise commit message.

### Rules:
1. Use the format: `<type>(<optional scope>): <description>`
2. Types must be one of: feat, fix, docs, style, refactor, perf, test, build, ci, chore, or revert.
3. Use lowercase for the description and no period at the end.
4. Keep the first line under 50 characters.
5. If the change is complex, add a body with a blank line separating it from the header.

### Output:
Provide only the commit message text so I can easily copy it.
