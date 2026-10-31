---
title: Diagrams, Sketch and Canvas
part: 3
audience: [everyone]
summary: Draw a diagram with draw.io, sketch a quick picture, or lay screens side by side on a canvas, right inside a page or ticket.
reading: 7
---
## Diagrams

Diagrams are draw.io drawings stored with the project. Insert one into a Docs page and edit it in place. The picture you see comes from the draw.io editor itself.

!!! note "The draw.io editor"
    Set the editor address in {menu:Settings › Integrations} (the draw.io section, for a self-hosted editor). The public diagrams.net is never used unless the server is started with `KANBAN_DIAGRAM_EXPORT=public`. With `KANBAN_DIAGRAM_EXPORT=off` the preview step is skipped. {Ch:self-hosting} lists these settings.

A diagram that an agent saves over MCP gets its picture drawn by a hidden browser: the desktop app’s own executable, or a Chrome, Chromium or Edge found on the computer (`KANBAN_CHROME_PATH` points at one). Without either, the server draws a plain preview and the footer says “Simple preview” until someone opens the diagram and saves it.

## Sketch

Sketch is a paint-style drawing editor that works offline. Open it with `/draw` in Docs pages, ideas, ticket descriptions and comments, with the **Sketch** button, or with **Draw on it** on any picture in the file viewer.

- Tools: pencil, brush, eraser, fill, picker, line and arrow, shapes, text, crop and layers.
- More than 100 undo steps, and it works with a pen (with pressure) and with touch.
- A sketch is saved as a PNG plus an editable source. Limits: 4096 px, 10 layers and 10 MB.
- Drafts are kept in the browser. If someone else saves first, a conflict card lets you choose.

In markdown a sketch is written `![Name](sketch:sk_…)`.

## AI in Sketch

The **AI** panel keeps one conversation per person and sketch (kept 30 days, private to you). The model sees the current picture with every message. Ask “what is missing?” or “draw a retry button next to the error”. A drawing answer is a **proposal** shown as a preview; **Accept** puts it on a new layer named “AI” as one undoable step, and **Discard** drops it. The AI never writes pixels and never touches your layers. You can paste or attach pictures (PNG, JPEG, WebP, GIF, up to 4 per message, 5 MB each) and text files (up to 200 KB). {Ch:safety} explains what is sent.

!!! ai
    Sketch AI uses the same AI members, project switch, kill switch and caps as the other AI helpers. Viewers can read but not ask. Everything works with AI turned off.

## Canvas

A canvas puts **frames** side by side on one large plane: HTML pages, pictures, Sketches and Diagrams, with notes, arrows and labels. It is for explaining a flow, such as every screen of a sign-in redesign, and for reviewing it together. It sits wherever Sketch and Diagram do: the **Canvas** button of the markdown toolbar (description, comments, ideas, Docs), `/canvas`, **Docs › New page › Canvas** (a page with the layers icon), and **Open on a canvas** on an HTML file or a picture in the file viewer.

- **A frame** is shown in a locked frame: no scripts and no outside requests, as in Preview. A chip such as “3 blocked” lists what was left out. Any width from 320 to 1920; the size presets are Desktop, Laptop, Wide, Tablet and Phone.
- **Moving, resizing, notes, arrows and comments need no lock** and merge by item, so two people can arrange a canvas at once. **Changing what is inside a frame (Edit) locks that one frame** for you; others can still look, comment and move it, and the lock ends when you save, cancel, close or have been idle for 10 minutes.
- **Zoom** 10% to 400% (Ctrl + scroll), Fit (0), a map (M), Space to pan, Tab to step through frames, **P** to present, **F** for focus, **?** for every key. Below 40% frames show a picture of their last state; from 40% they are drawn live.
- **In text** a canvas is a card with an overview of its frames (or one frame, or just a chip). Click it to open the large view: step through the frames, switch the page width, read and write comments, press **G** for all frames.
- **History** makes a version on every Done, every accepted AI proposal and, for a canvas page, every 10 minutes of change. Compare two versions, name one, restore one (restoring makes a new version).
- **Limits:** 60 frames, 5 MB per frame, 50 MB per canvas, 10 page tabs.

!!! ai
    **Ask AI** (Ctrl J) about the selected frames prepares a **proposal**: you see before and after and accept or reject each frame. The AI never overwrites, never takes a lock from a person, and an AI member can also comment under its own name. Over MCP an agent reads a canvas (`docs_read` `canvas`), comments and proposes (`docs_write` `canvas_comment`, `canvas_propose`). Details: `docs/specs/canvas.md`.

In markdown a canvas is written `![Name](canvas:cv_…)`, or `![Name](canvas:cv_…#b_…)` for one frame.

