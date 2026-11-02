---
name: canvas-design
description: Design the HTML frames of a Canvas (mockups and prototypes of screens, pages and flows) so they look like one considered product, presented as a design document (foundations, components, then screens, each board with its states side by side), then create them with docs_write(canvas_create) or offer them with canvas_propose. Use when asked to design, mock up or redesign a screen, an app or a flow on a canvas, or to explore design directions.
---

# Designing frames for a Canvas

A frame is an open web page (scripts, CDN libraries and fonts run). Good frames come from a process, not from more CSS:
context, a direction, foundations, then the boards, then a check. This one text is what the board's Ask AI job and every
MCP agent are given (it is the `GUIDE` in `server/services/canvas_design.py`; the skill file in
`.claude/skills/canvas-design/` is generated from it and a test fails if they differ).

**The bar.** As the skill, this guide carries two exemplar boards in `examples/` beside it (outside Claude Code,
docs_read(design_guide) gives their folder): `foundations.png` (a foundations board) and `states.png` (a feature board:
what it decides, the states of one card side by side, a whole screen, the states of a panel), each with its `.html`.
Look at both pictures before your first frame and match their structure and craft. Never copy their brand (the green,
the fonts, the copy): your product has its own.

## 0. Context before anything

Design is rooted in what exists. Before the first line of code, look for the product's own screens (other frames, a
ticket or page that describes it), its brand or design system, its code (components, CSS variables) and screenshots.
Match its vocabulary: tone of the copy, palette, density, radius, shadows, hover and pressed states. Designing a whole
product from nothing is the last resort; if you must, say what you assumed. Where you have no icon or asset, draw a
plain labelled placeholder. To recreate a UI whose source you can read, build from that source (exact paddings, radii,
sizes), not from memory. Do not recreate another company's distinctive proprietary UI; make an original design that does
the same job.

## 1. Ask once, then decide

With a person there to answer (Claude Code can use `AskUserQuestion`), ask **one** round of at most 4 questions before the
first frame, only if two or more result-changing decisions are open (which job the screen does first, who lands on it, what
to reuse or break from, what may be added). Questions come from their material, never a stock form. Each has 2 to 4
concrete options that differ on a named axis, your pick first marked "(Recommended)". Never re-ask a settled point. When
nobody can answer (an Ask AI job, a headless run, "just make it"): decide, build, and state your assumptions in one line.

## 2. Direction (settle it before building)

Name these and keep them for the whole canvas: **purpose and user** (what problem, for whom), **tone**, **the one thing**
someone will remember, and **type, colour, space**.

**Restraint for product UI, boldness for a stage.** Decide which one you are designing:

- **An app or tool people use every day** (a tracker, a dashboard, settings, a feed): product-grade and calm. Quiet
  neutrals tinted toward one brand colour, and that colour carries meaning (the main action, selected, done), never
  decoration. Dense but airy: real content on the first screen, not one big shape in empty space. Hierarchy from size,
  weight and colour; small uppercase section labels; hairline cards; a status as a pill with an icon and a word. No
  hero art, decorative illustration or gradient ground inside the app. The memorable thing is a precise detail (the copy,
  one data mark, one well-staged moment), not decoration.
- **A landing page, a splash, a poster, a campaign**: be bold. A characterful display face over a plain body face, a
  dominant colour with sharp accents, a composition with intent (an asymmetric hero, one element that breaks the grid, a
  rhythm of big and small), a ground with depth (a soft mesh, a grain, one dramatic shadow) where the tone calls for it.

Either way, timid and generic is not a direction. Do not converge on the same choices from one brief to the next. A cream
ground, a serif display face and terracotta are a habit, not a direction: only when the brief asks. Inter, Roboto or the
system face as the display face is the template look, unless the product already uses it.

**When a direction is still open** and a person is waiting, make 2 to 4 low-fi frames that differ on an axis you can
name ("Calm and dense" vs "Warm editorial"), not five shades of one look; keep their names. Give each its motivation and
main tradeoff in your reply or one `canvas_comment`. Once they choose, the choice stays chosen.

## 3. Content

- Real copy, written for this product: real names, amounts, dates, counts, error messages. Never lorem ipsum, never
  filler that could describe any business. A missing fact is a visible placeholder like `[YOUR PRICE]`.
- Every state says what happened and what to do next ("Plan for 4 tickets is waiting for your approval", "Needs you:
  choose a sender address"), never blame and never a bare "Error".
- Every element earns its place: no filler sections, decorative numbers, icons or stats. **Ask before adding** sections,
  pages or copy nobody mentioned.

## 4. Tokens

One `tokens.css` copied into every frame (or one `:root` block), and nothing in a frame that is not a token.

| Token | Rule of thumb |
| --- | --- |
| Neutrals | ink, muted, line, surface, background; tinted slightly toward the brand (never pure grey on pure white) |
| Colour | in `oklch()`: one brand colour, at most two accents sharing its chroma and lightness, soft tints for success, warning, danger |
| Spacing | 4, 8, 12, 16, 24, 32, 48 |
| Radius | 8 (inputs), 12 (cards), 16 or 20 (sheets), 999 (pills) |
| Type | 1 to 3 families (a mono face for keys and numbers is fine); sizes 12 to 34 named by use; weights 400, 600, 700; line height 1.4 text, 1.15 titles; `text-wrap: balance` on titles |
| Elevation | two levels at most: a hairline for cards, a soft shadow for floating things |
| Motion | a few staged moments, not micro-animation everywhere; honour `prefers-reduced-motion` |

## 5. Layout and hierarchy

- Mobile first, 8 px grid, 16 to 20 px side gutters; group by proximity. Flex or grid with `gap`, never siblings spaced by
  margins.
- One primary action per screen, in the lower half on a phone; tap targets at least 44 px; no text under 12 px. In every
  state (an alert, an error, a banner) that action stays on the first phone screen (844 px tall).
- The title and the main action are what the eye finds first, by size, weight and colour, not borders around everything.
- A web view differs from the phone on purpose (a second column, a side pane), not a stretched phone. Fluid roots
  (`max-width`, %, rem); a grid of cards is `repeat(auto-fit, minmax(min(280px, 100%), 1fr))`.
- Diagrams: a flowchart of separate placed elements, not one big `<svg>`; `<svg>` is for an icon, a logo or a chart.

## 6. Built to be used

- Real `<button>`, `<a href>` and `<input>` with a `<label>`, even in a static mockup; icon-only buttons get `aria-label`;
  decorative SVG is `aria-hidden="true"`. Icons are inline SVG with one stroke width (1.75 to 2). Never emoji as icons.
- No fake phone chrome: no painted status bar ("9:41", battery), no fake keyboard; the device draws them.
- Draw the states, not only the happy screen: pressed, selected, disabled, empty (say what to do next), loading, error,
  offline, long text.
- Text contrast at least 4.5:1 (3:1 from 24 px); grey captions and white text on a fill fail most often. Colours told
  apart differ in lightness, not only hue. Never colour alone for a state: add an icon or a word. Visible focus.

## 7. The canvas is a design document

A canvas that designs a product or a feature is read like a document, not browsed like a gallery of screens. (One frame
asked for, or a change to one, stays a frame.)

- **Pages, in order**: Foundations, then Components, then one page per area of screens ("Screens · Today"), set with
  `"page"` in `frame.json`. Each page opens with a title label over its boards.
- **Every board is a spec board**: a wide page (1440 to 1800 px, `"fit": true`) that opens with a small uppercase eyebrow
  (`FOUNDATIONS`, `SCREEN · V1`), a title and one or two sentences on what it is for and what it decides. Then lettered
  sections (`a. Type scale, spacing, radii`, `c2. The six states of a reminder card`), each with a heading saying what
  it shows and a one-line lead.
- **States side by side**: the states of one thing in one row, each under a short label (`Empty · first day`,
  `On track`, `Behind · after 3 pm`, `Goal met`, `Offline`), drawn at the same size so only the state changes. Never one
  frame per state. A phone screen is a 390 px wide panel inside the board, real markup, not a picture.
- **A caption beside each decision**: one or two muted lines saying the rule and why ("Visual size can be smaller than
  the target. The tappable area never overlaps its neighbour."). The reasoning lives on the canvas, not only in a comment.
- **Foundations first, at full depth**, so a developer could build from that one board. Every value named by its use:
  the type scale as `Card title / 15 / 600 / lh 1.35` under a sample in the real face; spacing as `12 card padding`,
  `16 side gutter`; radii as `12 card, button, input`; touch targets (`44 × 44 minimum`); neutrals and brand colours
  with their job; status colours with their rule ("Dot colour only. The name always sits beside it."); then the base
  components with their states in a row (a button: primary, pressed, secondary, disabled, loading, destructive; an input:
  default, focus, error, disabled).
- **Components** next: each repeated piece (a card, a row, a banner, a sheet) with its states and variants side by side.
- **Screens** last, built only from those foundations and components: the screen in its main state, then a section of
  its states, then the web view at its own width.
- A clickable prototype is extra: only when asked, as a last page of phone-size frames joined by arrows (frames share
  `localStorage`, so one can carry data to the next).

## 8. Avoid

Lorem ipsum, invented numbers, a gradient wash behind everything, one huge decorative shape on an app screen, low density
dressed up as calm, containers with a rounded corner and a left accent border, emoji, shadows on everything, long centred
text, text under 12 px, grey boxes in place of content, one-off pixel values, a frame per state, the same look as last time.

## 9. Changing an existing design

A small, targeted change (a word, a colour, one element) changes only that: every other layout, size, colour and word stays
exactly as it is. If a broader change would help, finish what was asked and **suggest** the rest. A redesign or a new
direction is different: then make the substantial changes. Follow the design's own vocabulary when you add to it.

## 10. Check before you send

1. Squint: on each screen, are the title and the main action what you see first?
2. Is every gap, size and colour a token, and is the direction (restrained or bold) the one you named?
3. Do the boards read as a document: pages in order, a title and purpose on each, lettered sections, states side by side
   with labels, a caption by each decision, foundations a developer could build from?
4. Does each screen hold at the width it is for (390 for a phone panel, 1280 and 820 for a web view)? No short label
   broken over two lines, nothing cut off, the main action on the first phone screen in every state.
5. States there, copy real, nothing added that nobody asked for? Does it match what was asked, and nothing else changed?
6. Put it beside the exemplars: is it at that level of structure, density and finish? If not, it is not done.

## 11. Hand it over

New canvas: a folder with one sub-folder per frame (`index.html`, optional `frame.json`), then
`docs_write(canvas_create, owner_kind, owner_id, title, path)`; the owner (a ticket or a Docs page) must exist first. Put the
returned `markdown` line on its own line in that ticket or page (`manage_ticket` or `docs_write(update)`).

- **Order and names**: frames are placed left to right in folder-name order on their page, so name the folders
  `01-foundations`, `02-components`, `10-today`; the number is not part of the shown name.
- **`frame.json`**: `{"name", "page": "Foundations", "size": "phone"|"tablet"|"desktop"|[w, h], "fit": true, "x", "y"}`.
  Frames with the same `page` share a page tab, in the order they first appear. A long board is cut off by a fixed
  height: set `"fit": true` and the editor measures the page once, or give `[w, h]`.
- **`canvas.json` at the top**: `labels` (`{"text", "page", "x", "y", "size"}`, a page's title), `notes` (`{"id",
  "text", "near": "<frame>", "page", "x", "y", "color", "w", "h"}`; a note near a frame sits under it, on its page) and `arrows` (`{"from", "to", "label"}`, a frame
  folder name or a note `id`). A wrong reference is reported before anything is created.
- **A spec per screen** on Docs, for whoever builds it: one page per screen (or a section each on one page) with what it
  is for, a screenshot of each state (`![Today · behind](shots/today-behind.png)`, a file in your working folder), the
  tokens and components it uses, sizes and behaviour, the copy of every state, open questions, and the board it is on.
- **Change to an existing frame**: write the changed files to a folder and `docs_write(canvas_propose)` with a
  one-sentence note on the design decision; a person accepts or rejects.
- Leave `canvas_comment`s for open questions, each pinned with `at` (a CSS selector, or `text=Add task`). Give your
  assumptions in one line.
