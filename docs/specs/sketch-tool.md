# Sketch tool

Step 7 of [#203](https://github.com/iamcaominhtien/kanban-board-mcp/issues/203). Design:
[`design/screens/sketch-tool.md`](../../design/screens/sketch-tool.md). A simple, offline, paint-style drawing tool
that works in any text (ticket, comment, Docs page, idea) and on any picture.

## Library decision: none (plain Canvas 2D)

The design does not fix a library. I looked at what fits a *paint* program (pixels, fill, soft brush, eraser, picker,
layers) and the repository's licence (`LICENSE` is MIT, so a dependency must be MIT, Apache, BSD or similar and must
bundle with Vite and run offline).

| Candidate | Licence (npm) | Why not |
|---|---|---|
| Fabric.js 7 | MIT | An object model (shapes you move). A paint tool needs pixels: flood fill, soft brush, eraser and colour picker are not in it. 22 MB unpacked. |
| Konva 10 | MIT | Same: scene graph of shapes, no pixel tools. |
| Paper.js 0.16 | MIT | Vector paths. Same gap. |
| Literally Canvas 0.5 | BSD-2 | Unmaintained, no fill/layers of this kind. |
| tui-image-editor 3 | MIT | A photo editor (filters, crop, rotate). The design says "no photo editing". |
| Excalidraw | MIT | Hand-drawn *diagrams* (the Diagram feature's job), 47 MB unpacked. |
| tldraw 5 | custom ("SEE LICENSE IN LICENSE.md"), not MIT/Apache/BSD | Not compatible with an MIT project without its licence terms. |
| perfect-freehand 1 | MIT | Only smooths stroke outlines (112 KB). The brush needs size, softness, opacity and pressure on a raster anyway, so I wrote the 40 lines of stamping it would replace. |

So the editor is hand-written Canvas 2D code with **no new dependency**. The cost is that I own the code, which is
why the parts that can go wrong are small pure modules with tests (`ui/src/components/sketch/engine/`).

Performance on 4096 x 4096 with 10 layers:

* One offscreen `canvas` per layer; the view only draws layers that are visible and not empty.
* A brush or pencil stroke is drawn into one shared stroke canvas and merged into the layer when the stroke ends,
  so overlapping stamps do not add up past the chosen opacity and a stroke can be thrown away cleanly.
* Undo keeps the *before* pixels of only the 128 px tiles a change touched (`engine/tiles.ts`), not the layer.
  One history serves the whole drawing: at least 100 steps (250 at most, fewer only above 512 MB) and it survives
  switching tools and layers.
* Fill is a scanline fill over typed arrays (`engine/floodFill.ts`): no recursion, no per-pixel closure. A 4 megapixel
  open area takes well under 2 s in the test; filling a 16 megapixel page measured about 0.8 s in headless Chromium
  without a GPU.
* `getImageData` is used only for fill, picker and undo, so layer canvases are created with `willReadFrequently`.
* Measured in headless Chromium without GPU: 4096 x 4096, 10 layers, 80 px soft brush: strokes stay interactive;
  Done (flatten, encode, upload) about 0.6 s.

## What is stored

Two files, one drawing, both in the **uploads folder** so the existing backup/export of the data folder carries them
like any attachment:

* `uploads/sketches/sk_xxxxxxxx.png`: the picture, shown anywhere an image works.
* `uploads/sketches/sk_xxxxxxxx.sketch.json`: the editable source.

Both are overwritten on each save (the row keeps the version number). A row in the `sketch` table
(migration `c3d9a1b7e5f2`) holds the owner (`owner_kind`: `idea`, `ticket`, `doc`, `comment`; `owner_id`), the
project (resolved from the owner; none for an idea that belongs to no project), the title, size, layer count,
version and who changed it. Deleting only unlinks (`deleted_at`); files and row are kept and can be restored.

The files are served by the normal `/uploads/...` route as well as by the sketch API, so a PNG shown in an export
works like any other image there.

### Source format (`*.sketch.json`, version 1)

```json
{
  "format": "kanban-sketch",
  "version": 1,
  "width": 840,
  "height": 500,
  "background": "white",
  "activeLayer": "l2",
  "recent": ["#e8441a"],
  "layers": [
    { "id": "l1", "name": "Background", "kind": "paper", "visible": true, "opacity": 1, "locked": true,
      "png": null, "texts": [] },
    { "id": "l2", "name": "Sketch", "kind": "layer", "visible": true, "opacity": 1, "locked": false,
      "png": "data:image/png;base64,...",
      "texts": [{ "id": "t1", "x": 10, "y": 20, "text": "hello", "size": 28, "color": "#2b2b2b", "bold": true }] }
  ]
}
```

Layers run bottom to top. `kind` is `paper` (the white page), `picture` (the picture opened with "Draw on it") or
`layer`. `png` is a data URL, `null` for an empty layer. Text stays a list of objects (editable) until the layer is
merged down; the saved PNG always has it drawn in. Undo history is not saved.

## Limits

4096 x 4096 px, 10 MB for the PNG and 10 MB for the source, 10 layers. The editor checks before saving:
the canvas size cannot go past 4096 (the Crop and resize tool says so), the "add layer" button explains the limit,
and the files are measured before upload (banner "This drawing is too large to save", with a "Crop and resize"
button). The server enforces the same numbers (413 `sketch_too_large`, 422 `too_many_layers`); the 413 body names the
part (`png`, `source`, `canvas`) and the limits. A picture larger than 4096 px opened with "Draw on it" is scaled down
to fit, and the editor says so.

## Markdown

```
![Name](sketch:sk_8f2a1c3d)
```

on a line of its own (the link form `[Name](sketch:sk_8f2a1c3d)` is read too). It renders the PNG with an
"Edit sketch" button (only for people who can edit) and a "View large" button (everyone). It works in ticket
descriptions, ticket comments, Docs pages and Docs comments, and wherever `MarkdownRenderer` / `MarkdownEditor` are used.

* Insert: Docs editor `/draw` (and a Sketch button on its toolbar); ticket description editor: Sketch button beside
  Diagram; comment boxes: Sketch button beside Diagram.
* Plain-image fallback: the Docs "Export" action writes `![Name](/uploads/sketches/sk_8f2a1c3d.png)` instead, a
  normal image reference that every markdown reader understands once the data folder is next to the file. The ticket
  attachment strip lists a sketch as its PNG.
* AI agents are told (MCP instructions) to leave the line alone.

## API

All writes are multipart (the PNG can be 10 MB, so no base64). Errors use the Docs error shape
`{detail: {code, message, ...}}`. Viewers (and strangers) can read; creating, saving, copying and deleting need the
member role (`403 read_only`). The project is resolved from the owner (ticket, Docs page, idea); a comment that is still
being written passes `project_id`.

| Route | Purpose |
|---|---|
| `POST /sketches` | New sketch. Form: `owner_kind`, `owner_id`, `title`, `project_id` (optional), files `png`, `source`. |
| `GET /sketches?owner_kind=&owner_id=` | List the sketches of one page, ticket or idea. |
| `GET /sketches/{id}` | Details: owner, size, `version`, `png_url`, `can_edit`, `role`. |
| `GET /sketches/{id}/png` | The picture (latest). ETag `"sk_x-v3-png"`; `?download=true` for a download. |
| `GET /sketches/{id}/source` | The editable source. |
| `PUT /sketches/{id}` | Save a new version. Form: `base_version`, `title`, `png`, `source`, `force`. **409 `sketch_conflict`** (with `latest_version`, `latest_author`, `latest_at`) when `base_version` is not the latest; `force=true` replaces theirs. |
| `POST /sketches/{id}/copy` | Save as a copy (a second sketch, same owner). With `png` and `source` it saves the editor's unsaved state; without, it copies the saved one. |
| `DELETE /sketches/{id}` | Unlink. |
| `POST /sketches/{id}/restore` | Bring it back. |

## Using it from the UI code

```ts
const { openSketch } = useSketch();   // ui/src/components/sketch/SketchContext.ts

const result = await openSketch({
  ownerKind: 'idea',            // 'idea' | 'ticket' | 'doc' | 'comment'
  ownerId: 'IDEA-12',
  sketchId,                     // edit a saved sketch
  baseImageUrl,                 // or draw on a picture (an /uploads/ path); it goes on its own locked layer
  title,
  size: { w: 840, h: 500, background: 'white' },  // skips the "New sketch" dialog
  projectId, ownerLabel,        // optional: for the role check and the "in idea “…”" subtitle
});
// result: { id, pngUrl, title, version, markdown: '![title](sketch:id)', sketch } | null (closed without saving)
```

`SketchProvider` (in `main.tsx`) hosts the editor, mounted full screen above everything (z-index above the file
viewer). `SketchEmbed` renders a sketch inline; `SketchOwnerContext` tells the file viewer where "Draw on it" saves to
(the ticket modal provides it; a page that wants the button for its own attachments wraps its tree in
`SketchOwnerContext.Provider`).

## Drafts

While drawing, the editor writes a draft to IndexedDB (`kanban-sketch-drafts`) every 4 seconds when something changed
and the pointer is idle. Nothing leaves the computer. On the next start the app offers "Unsaved drawing found:
Restore / Discard"; opening the same sketch shows the same card inside the editor. Done, or Discard in the "Save your
drawing?" dialog, removes the draft. A restored drawing has no undo history.

## Keys, pen and touch

V select, P pencil, B brush, E eraser, G fill, I colour picker (Alt while drawing picks), L line (Shift snaps to
15 degrees; arrow head option), R rectangle/ellipse (Shift for square/circle), T text, C crop and resize. Ctrl+Z, Ctrl+Shift+Z
(Ctrl+Y), `[` `]` size, Space + drag pans, wheel pans, Ctrl+wheel zooms, `+` `-` `1` Ctrl+0 zoom, Ctrl+S saves,
Esc cancels a half-made action or asks to save, Enter puts a selection down or crops, Delete removes the selection.

Pen: pressure changes size or opacity (option; off by default); the eraser end of a pen switches to the Eraser; a touch
within 1.5 s of a pen is ignored (palm rejection). Touch: one finger draws, two fingers pan and zoom, a two-finger tap
undoes, a three-finger tap redoes. Under 760 px wide the tools move to the bottom and Colour and Layers become sheets.
On touch devices (`pointer: coarse`) buttons are at least 44 px high. Animation only runs when the system allows it
(`prefers-reduced-motion`).

## Tests

* `server/tests/test_sketches.py`: create/read/files in the uploads folder, limits (canvas, PNG, source, layers),
  conflict 409 and "replace theirs", save as copy, roles (viewer, member, free idea), delete/restore, ETag.
* `ui/src/components/sketch/engine/*.test.ts`: flood fill, tile undo, history (>= 100 steps, memory cap), layer
  limits, limits and size checks, source format round trip and refusal of bad files, brush spacing/pressure,
  geometry, colours. Run with `npm test` in `ui/` (the Node test runner, no framework; CI runs it).

## Not built

* Curves with the line tool (lines and arrows only).
* Real-time drawing together; one person edits at a time (the conflict card handles the rest).
* Undo history is not stored in the saved file or the draft.
* Older versions of a sketch are not kept (one PNG and one source per drawing); a Docs page version shows the latest
  drawing.
