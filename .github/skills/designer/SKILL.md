---
name: designer
description: "UI/UX design skill using code-based prototyping. Use when: designing UI components, pages, flows, or mockups for this project. Outputs are rendered HTML files, screenshotted to PNG via Chrome DevTools MCP, and delivered inline. Covers both lo-fi sketch exploration and hi-fi implementation-ready mockups."
---

# Designer Skill

## Core Philosophy

**Design is a hypothesis about user behavior, not a solution.**

Every layout decision, color choice, and interaction pattern is a bet on how a real person will think and feel. The designer's job is to make that bet explicit, test it visually, and invite challenge — not to deliver a polished artifact and call it done.

This means:
- Always explain *why* a design decision was made, not just *what* was built
- Offer 2 options when a genuine trade-off exists
- Be willing to tear it down if the hypothesis doesn't hold

---

## Mode Routing — First Thing to Decide

Before designing anything, determine which mode applies:

| Signal from user | Mode |
|---|---|
| "what would this look like", "explore", "brainstorm", "rough idea" | **Sketch** — lo-fi, fast, layout + structure only |
| "mockup for ticket X", "dev needs to implement", "redesign this component" | **Mockup** — hi-fi, matches project design system |
| Unclear | Ask one question: *"Is this for quick exploration or implementation-ready?"* |

---

## Mindset Layers — Apply in Order

### Layer 1 — UNDERSTAND (Psychologist lens)

Load `.github/skills/psychologist/SKILL.md` when the design involves user interaction, onboarding, retention, or motivation.

Ask before designing:
- Who is the user of this feature? What are they trying to accomplish?
- What is their cognitive state at this moment in the flow? (rushed? confused? excited?)
- What friction exists today? What would reduce it?
- What mental model does this user already have? Does the design match or break it?

### Layer 2 — FRAME (Consultant + Critical Thinking lens)

Load `.github/skills/consultant/SKILL.md` and `.github/skills/critical-thinking/SKILL.md`.

Challenge the brief before executing:
- Is this the right design problem to solve? Is there a deeper issue upstream?
- What assumption is this design resting on? Is that assumption verified?
- What would have to be true for this design to fail?

### Layer 3 — BUILD (Code-based prototyping)

See **Tooling** section below.

### Layer 4 — EVALUATE (Frontend Design lens)

Load `.github/skills/frontend-design/SKILL.md`.

For **hi-fi mockups**, extract from that skill:
- Color palette and CSS variables in use
- Typography choices (fonts, weight, size scale)
- Spacing system and component patterns
- The aesthetic direction of the project

Apply these faithfully in the generated HTML. The mockup must look like it belongs in the actual app.

For **lo-fi sketches**, frontend-design skill is not required — focus on layout and structure only.

---

## Tooling — HTML + Tailwind CDN

The output of every design task is a **single self-contained `.html` file**.

### Why this approach
- No build step — create one file, open in browser instantly
- Tailwind CDN handles all styling utility classes
- Chrome DevTools MCP can screenshot it → PNG → embeds in markdown
- Easy to iterate: edit file, refresh, screenshot again

### File location
- Active working files: `docs/ui-audit/designs/`
- Temp/exploratory files: same folder, prefix with `draft-`
- After approved: keep as design reference

### HTML template structure

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>[Design Name]</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    // Extend Tailwind config with project-specific tokens (hi-fi only)
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            // Extract from frontend-design skill
          }
        }
      }
    }
  </script>
  <style>
    /* Custom CSS only when Tailwind utilities are insufficient */
    /* Google Fonts import if needed for hi-fi */
  </style>
</head>
<body class="...">
  <!-- Design content -->
</body>
</html>
```

### Lo-fi rules
- Use only neutral Tailwind colors (`gray`, `slate`, `zinc`)
- No custom fonts — use `font-sans` or `font-mono`
- Focus on layout, spacing, and information hierarchy
- Annotate design decisions with HTML comments: `<!-- Why: user scans left-to-right, ID anchors the row -->`

### Hi-fi rules
- Extract exact colors, fonts, and spacing from `frontend-design` skill
- Match the app's aesthetic direction exactly — no generic styles
- Micro-interactions are welcome: `hover:`, `transition`, `focus:` states
- Annotate design decisions the same way

---

## Render & Deliver

After generating the HTML file:

1. Open the file in browser via Chrome DevTools MCP
2. Take a full-page screenshot → PNG
3. **Embed the PNG directly in the response** — never just provide a file path
4. Briefly explain the 2–3 key design decisions made and why
5. **Write or update the design doc** — see Documentation section below
6. Ask one focused question to invite feedback

If Chrome DevTools MCP is unavailable, provide the HTML file path and ask the user to open it locally.

---

## Iteration

If user gives feedback:
- Treat feedback as hypothesis-updating data
- Edit the `.html` file, re-screenshot, re-deliver
- Don't rebuild from scratch unless the framing has fundamentally changed

If design is approved for implementation:
- The HTML mockup becomes the reference artifact for the dev
- Move from `draft-` prefix to a clean name
- Optionally note which React component(s) it maps to

---

## What Good Design Output Looks Like

A good design delivery from this skill includes:

1. **PNG screenshot(s)** — embedded in response
2. **Design rationale** — 2–3 bullets explaining key decisions and the user behavior hypothesis behind them
3. **Design doc** — written or updated at `docs/design/<feature>.md`, with screenshots embedded, decisions explained, and open questions listed
4. **Open question** — one thing that is still uncertain or worth challenging

A bad delivery is: "Here is the HTML file." Full stop. Or: screenshots delivered but no doc written.

---

## Documentation

After every design task, write or update a Markdown design doc. This is not optional.

### When to create vs. update
- **New feature / new design** → create `docs/design/<feature-name>-visual-concept.md`
- **Iteration / new variant** → update existing doc, append new section

### Required sections
1. **Frontmatter** — `title`, `type: design`, `status: draft`, `created`, `updated`
2. **Overview** — what was designed and why (1–2 sentences)
3. **Design hypothesis** — what user behavior assumption this is testing
4. **Screenshots** — embed every PNG with relative path from `docs/design/` (e.g. `../ui-audit/designs/my-design.png`)
5. **Key design decisions** — each decision + psychology/reasoning behind it
6. **Component breakdown** — React components mapped to visual elements (hi-fi only)
7. **Open questions** — what needs to be decided before implementation

### Multiple variants
- Each variant gets its own subsection + embedded screenshot
- Comparison table at the end
- Clear recommendation with rationale

---

## Remotion Video Animations

For video/animation tasks, this skill does not apply — load `.github/skills/remotion/SKILL.md` instead.
