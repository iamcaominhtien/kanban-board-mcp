---
name: canvas-design
description: Design the HTML frames of a Canvas (mockups and prototypes of screens, pages and flows) so they look like one considered product, then create them with docs_write(canvas_create) or offer them with canvas_propose. Use when asked to design, mock up or redesign a screen, an app or a flow on a canvas, or to explore design directions.
---

# Designing frames for a Canvas

A frame is an open web page (scripts, CDN libraries and fonts run). Good frames come from a process, not from more CSS:
context, then a direction, then tokens, then the screens, then a check. This one text is what the board's Ask AI job and
every MCP agent are given (it is the `GUIDE` in `server/services/canvas_design.py`; the skill file in
`.claude/skills/canvas-design/` is generated from it and a test fails if they differ).

## 0. Context before anything

Design is rooted in what exists. Before the first line of code, look for: the product's own screens (other frames on the
canvas, a ticket or page that describes it), its brand or design system, its code (components, CSS variables), and
screenshots. Match its visual vocabulary: tone of the copy, palette, density, radius, shadows, hover and pressed states.
Designing a whole product from nothing is the last resort; if you must, say what you assumed. Where you have no icon or
asset, draw a plain labelled placeholder: a placeholder beats a bad attempt at the real thing. When asked to recreate a UI
whose source you can read, build from that source (copy exact paddings, radii, sizes), not from memory or a screenshot.
Do not recreate another company's distinctive proprietary UI; make an original design that does the same job.

## 1. Ask once, then decide

With a person there to answer (Claude Code can use `AskUserQuestion`), ask **one** round of at most 4 questions before the
first frame, only if two or more result-changing decisions are open (which job the screen does first, who lands on it, what
to reuse or break from, what may be added). Questions come from their material ("your notes list four screens; the
ticket says onboarding is the problem..."), never a stock form. Each has 2 to 4 concrete options that differ on a named
axis, your pick first marked "(Recommended)", no "you decide" option. Never re-ask a settled point. When nobody can
answer (an Ask AI job, a headless run, "just make it"): decide, build, and state your assumptions in one line.

## 2. Direction (settle it before building)

Name four things and keep them for the whole canvas:

- **Purpose and user**: what problem the screen solves and for whom.
- **Tone**: pick a real one (calm editorial, dense and data-first, playful and toy-like, industrial, warm and soft,
  luxury and refined, brutalist...). Boldness is not volume: a minimal design needs precise spacing and restraint, a
  maximal one needs real effort. Either is fine; timid and generic is not.
- **The one thing** someone will remember.
- **Type, colour, space**: a characterful display face over a plain body face (Google Fonts, with a system fallback of
  close metrics), a dominant colour with sharp accents rather than an even, timid palette, and generous space or
  controlled density, on purpose.
- **Composition and ground**: a layout with intent (an asymmetric hero, one element that breaks the grid, overlap that
  never covers text, a rhythm of big and small) and, where the tone calls for it, a ground with depth (a soft mesh, a fine
  grain or pattern, layered translucency, one dramatic shadow), done with restraint. A flat white page of centred cards is
  the generic default: earn it or avoid it.

Do not converge on the same choices from one brief to the next: vary light and dark, fonts, palettes and layouts. A cream
ground, a serif display face and terracotta are a habit, not a direction: only when the brief asks. Inter, Roboto, Arial
or the system face as the display face is the template look, unless the product already uses it.

**When a direction is still open** and a person is waiting, make 2 to 4 low-fi frames, each differing on an axis you can
name ("Warm editorial" vs "Dense data-first"), not five shades of one look. Name them once and keep the names ("Option B"
stays "Option B"). Give each an honest motivation and its main tradeoff in your reply or in one `canvas_comment`, not
written on the frame, and make the case for each, not only your favourite. Once they choose, the choice stays chosen.
Decision fidelity is not deliverable fidelity: grey boxes and real copy are enough to pick a direction. When they want
variations to keep, give 3 or more across several dimensions (by-the-book next to novel layout, interaction or style) that
they can mix and match.

## 3. Content

- Real copy, written for this product: real names, amounts, dates, counts, error messages. Never lorem ipsum, never
  "Welcome to our website", never filler that could describe any business.
- A missing fact (a price, a date, an address) is a visible placeholder like `[YOUR PRICE]`, not an invention.
- Every element earns its place. No filler sections, no decorative numbers, icons or stats. A screen that feels empty is a
  layout problem; do not fix it with invented content. **Ask before adding** sections, pages or copy nobody mentioned.
- A landing page: one hero that states the offer in one sentence with one clear action, proof the visitor can trust (from
  the person's material, or marked placeholders), benefit sections that answer real doubts, the one action repeated down
  the page. The copy is the product.

## 4. Tokens

One `tokens.css` copied into every frame (or one `:root` block), and nothing in a frame that is not a token.

| Token | Rule of thumb |
| --- | --- |
| Neutrals | ink, muted, line, surface, background; tinted slightly toward the accent (whites below 0.02 chroma; never pure grey on pure white) |
| Colour | in `oklch()`: one dominant colour, at most two accents sharing its chroma and lightness (the hue varies), soft tints for success, warning, danger |
| Spacing | 4, 8, 12, 16, 24, 32, 48 |
| Radius | 8 (inputs), 12 (cards), 16 or 20 (sheets), 999 (pills) |
| Type | 1 to 3 families; sizes 12, 14, 16, 20, 28, 34 (more for display); weights 400, 600, 700; line height 1.4 for text, 1.15 for titles; tight tracking on big titles; `text-wrap: balance` on titles, `pretty` on text |
| Elevation | two levels at most: a hairline for cards, a soft shadow for floating things |
| Motion | a few high-impact moments (one well-staged reveal), not micro-animation everywhere; honour `prefers-reduced-motion` |

## 5. Layout and hierarchy

- Mobile first, 8 px grid, 16 to 20 px side margins; group by proximity. Use flex or grid with `gap`, never siblings spaced
  by whitespace or per-element margins (gaps survive edits and reordering).
- One primary action per screen, in the lower half on a phone; tap targets at least 44 px; no text under 12 px. In every
  state (an alert, an error, a banner) that action stays on the first phone screen (844 px tall): the state makes room
  for it, never pushes it below.
- The title and the main action are what the eye finds first. Get there with size, weight and colour, not with borders and
  boxes around everything. Meta text is muted, 12 to 14 px.
- The three widths differ on purpose: the same page with a media query at about 700 px for a second column or a side pane,
  not a stretched phone. Fluid roots (`max-width`, %, rem), never a fixed pixel page; a grid of cards is
  `repeat(auto-fit, minmax(min(280px, 100%), 1fr))`, so a phone gets one column instead of an overflow.
- Prototype flow: one frame per screen, arrows on the canvas between them. Frames of one canvas share `localStorage` (same
  address), so a prototype can carry data from one screen to the next. Add behaviour where it is cheap and sells the concept
  (a toggle, tabs, a form that adds to a list, a toast).
- Diagrams: build a flowchart from separate placed elements, not one big `<svg>` nobody can edit; an `<svg>` is right for
  an icon, a logo, an illustration or a chart's plot.

## 6. Built to be used

- Real `<button>`, `<a href>` and `<input>` with a `<label>`, even in a static mockup. A `div` with a click handler looks
  the same but Tab skips it and a screen reader cannot announce it. Icon-only buttons get `aria-label`; decorative SVG is
  `aria-hidden="true"`.
- Icons are inline SVG with one stroke width (1.75 to 2). Never emoji as icons.
- No fake phone chrome: no painted status bar ("9:41", battery) and no fake keyboard. The real device draws them on top, so
  a painted one looks doubled and childish; leave that space alone.
- Draw the states, not only the happy screen: pressed or hover, selected, disabled, empty (say what to do next), loading,
  error, long text.

## 7. Colour and access

Text contrast at least 4.5:1 (3:1 from 24 px). Grey captions and white text on a coloured fill fail most often: darken
both. Colours that must be told apart differ in lightness, not only hue (prefer blue and orange to red and green). Never
colour alone for a state: add an icon or a word. Visible focus.

## 8. Avoid

Lorem ipsum, invented numbers, a purple-to-blue gradient wash behind everything, containers with a rounded corner and a left accent border,
emoji, shadows on everything, long centred text, text under 12 px, grey boxes in place of content, one-off pixel values,
the same look as last time.

## 9. Changing an existing design

A small, targeted change (a word, a colour, one element) changes only that: every other layout, size, colour and word stays
exactly as it is. If a broader change would help, finish what was asked and **suggest** the rest. A redesign or a new
direction is different: then make the substantial changes. Follow the design's own vocabulary when you add to it.

## 10. Check before you send

1. Squint: are the title and the main action what you see first?
2. Is every gap, size and colour from the tokens, and is the direction the one you named?
3. Does it hold at 390, 820 and 1280 px (the Desktop / Tablet / Phone switch in the large view)? No short label broken
   over two lines, nothing cut off, the main action on the first screen in every state.
4. States there, copy real, nothing added that nobody asked for?
5. Does it match what was asked, and nothing else changed?
6. Would someone remember it? If it could be any template, push the one thing harder.

## 11. Hand it over

New canvas: a folder with one sub-folder per frame (`index.html`, optional `frame.json`), then
`docs_write(canvas_create, owner_kind, owner_id, title, path)`; the owner (a ticket or a Docs page) must exist first. Put the
returned `markdown` line on its own line in that ticket or page, with the tool that edits it (`manage_ticket` or
`docs_write(update)`).

- **Order and names**: frames are placed left to right in folder-name order, so name the folders `01-today`, `02-new-task`;
  the number is not part of the shown name.
- **`frame.json`**: `{"name", "size": "phone"|"tablet"|"desktop"|[w, h], "fit": true, "x", "y"}`. A long page is cut off by a
  fixed height: either measure `document.documentElement.scrollHeight` at the frame's width and give `[w, h]`, or set
  `"fit": true` and the editor measures the page once and sets the height.
- **`canvas.json` at the top**, so a flow is presented and not only drawn: `notes` (`{"id", "text", "near": "<frame>" or
  "x", "y", "color", "w", "h"}`), `arrows` (`{"from", "to", "label"}`, each end a frame folder name or a note `id`) and
  `labels` (`{"text", "x", "y", "size"}`). A wrong reference is reported before anything is created.
- **Change to an existing frame**: write the changed files to a folder and `docs_write(canvas_propose)` with a one-sentence
  note on the design decision; a person accepts or rejects.
- Leave `canvas_comment`s for the open questions (what you were unsure of), each pinned to the element it is about with `at`
  (a CSS selector, or `text=Add task` for the element showing that text): the pin stays on that element when the page is
  drawn at another width. Give your assumptions in one line.
