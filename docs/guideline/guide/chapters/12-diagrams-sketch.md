---
title: Diagrams and Sketch
part: 3
audience: [everyone]
summary: Draw a diagram with draw.io, or sketch a quick picture, right inside a page or ticket.
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
