---
name: canvas-design
description: Design the HTML frames of a Canvas (mockups and prototypes of screens: apps, pages, flows) so they look like one considered product, then create them with docs_write(canvas_create) or offer them with canvas_propose. Use when asked to design, mock up or redesign a screen, an app or a flow on a canvas.
---

# Designing frames for a Canvas

A frame is an open web page (scripts, CDN libraries and fonts run). Quality comes from a process, not from more CSS.
The same brief is given to the board's Ask AI job and to MCP agents (`server/services/canvas_design.py`); keep them in step.

## 1. Brief (two minutes, before any code)

Write down, in a note on the canvas or in your reply: who it is for, the one job of each screen, the device and the
widths (Phone 390, Tablet 820, Desktop 1280), and 3 words for the feel ("calm, warm, focused"). Pick one reference
product for density and tone. Then list the screens as a flow (what the person taps to get from one to the next).

Write **realistic copy** for every screen: real names, amounts, dates, counts, error messages. Lorem ipsum and grey
placeholder boxes hide layout problems.

## 2. Tokens first

One `tokens.css` copied into every frame (or one `:root` block), and nothing in a frame that is not a token.

| Token | Rule of thumb |
| --- | --- |
| Accent | one colour, used for the primary action, the selected state and links only |
| Neutrals | ink, muted, line, surface, background; tint them slightly toward the accent (never pure grey on pure white) |
| Semantic | success, warning, danger, each with a soft tint for backgrounds |
| Spacing | 4, 8, 12, 16, 24, 32, 48 |
| Radius | 8 (inputs), 12 (cards), 16 or 20 (sheets), 999 (pills) |
| Type | one family; sizes 12, 14, 16, 20, 28, 34; weights 400, 600, 700; line height 1.4 for text, 1.15 for titles; tight letter spacing on large titles |
| Elevation | two shadows at most: a hairline for cards, a soft one for floating things (sheet, button) |

## 3. Layout and hierarchy

- Mobile first, 8 px grid, 16 to 20 px side margins. Group by proximity (small gaps inside a group, large gaps between).
- One primary action per screen, in the lower half on a phone (thumb zone), tap targets at least 44 px.
- The title and the main action must be what the eye finds first. Get there with size, weight and colour, not with
  borders and boxes around everything. Meta text is muted and 12 to 14 px.
- Make the three widths differ on purpose: the same page with a media query at 700 px for a second column or a side
  pane, not a stretched phone.

## 4. Details that make it look real

- Icons are inline SVG (one stroke width, 1.75 to 2). Never emoji as icons.
- Draw the states, not only the happy screen: pressed or hover, selected, disabled, empty, loading, error, long text.
  An empty state tells the person what to do next.
- Add behaviour where it is cheap and sells the idea: toggles, tabs, a form that adds to a list, a toast. Frames of one
  canvas share `localStorage` (same address), so a prototype can carry data from one screen to the next.
- A phone frame may draw its own status bar (time, signal, battery) so it reads as a device.

## 5. Colour and access

Text contrast at least 4.5:1 (3:1 for 20 px and up), never colour alone to show a state (add an icon or a word), visible
focus, `prefers-reduced-motion` respected for any animation.

## 6. Avoid

Lorem ipsum, more than one accent colour, decorative gradients, shadows on everything, long centred text, text under
12 px, emoji icons, grey boxes in place of content, one-off pixel values.

## 7. Check before you send

1. Squint: are the title and the main action what you see first?
2. Is every gap, size and colour from the tokens?
3. Does it hold at 390, 820 and 1280 px (use the Desktop / Tablet / Phone switch in the large view)?
4. Are the states there, and is the copy real?
5. Does what you made match what was asked, and nothing else changed?

## 8. Hand it over

New canvas: a folder with one sub-folder per frame (`index.html`, optional `frame.json` `{"name", "size"}`), then
`docs_write(canvas_create, owner_kind, owner_id, title, path)`; put the returned `markdown` line on its own line in the
ticket, idea or page. Change to an existing frame: write the changed files to a folder and `docs_write(canvas_propose)`
with a one-sentence note on the design decision; a person accepts or rejects. Leave one `canvas_comment` on the
canvas for the open questions (what you were unsure of), pinned to the frame it is about.
