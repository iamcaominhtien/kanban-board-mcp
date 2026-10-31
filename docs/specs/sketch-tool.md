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
* AI agents are told (MCP instructions) to leave the line alone, and may work on the sketch itself as files (see "AI agents over MCP").

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

## AI help in the editor

Added after step 8 of [#203](https://github.com/iamcaominhtien/kanban-board-mcp/issues/203) ("AI where you work",
[`ai-where-you-work.md`](ai-where-you-work.md) section 2.6). Nothing here is a new kind of AI: every request goes through the
AI members, permissions, per-member and board caps, the project's AI switch, the kill switch and the audit log that
exist, the AI only **suggests** and a person accepts, and everything works with AI off.

### What a person sees

* An **AI** button in the editor header opens a panel beside the drawing (a bottom sheet under 760 px). The button is
  drawn only when AI help can be used here: it is **hidden** for a viewer, for a person outside the project, and where AI
  is off (project switch, "Sketch AI" feature switch, project not shared). A temporary reason (no AI member set up, a cap
  reached, Pause all AI) keeps the button and the panel says why it cannot answer.
* An embedded sketch has an **Ask AI** button next to *Edit sketch* (people who can edit, where AI is available). It opens
  the editor with the panel already open **on the same conversation**.
* **One conversation, one thread.** There are no tabs. The person asks in words ("what is missing?", "brainstorm ideas",
  "draw a retry button next to the error"). Quick-start chips in the empty thread (What is missing? / Brainstorm ideas /
  Draw an arrow to… / Draw a retry button next to the error) send a question or put the start of a sentence in the box.
  The thread is **private to the person, kept 30 days** (like the ticket and idea chats), and found again when the editor
  is closed and opened again, or opened from the embed. **New chat** (the + in the panel header) starts another. Every
  earlier message and proposal stays in the thread.
* The answer is **words** and, when drawing was asked for, a **proposal card** in the thread: "3 shapes, 1 arrow and 1
  label on a new layer “AI”". The newest proposal is shown as a preview on the drawing; **Accept / Discard / Try again**
  are on the card. Accept puts the shapes on a **new layer named “AI”** on top (“AI 2” if that name is taken) as **one undo
  step** (Ctrl+Z removes the layer, Ctrl+Shift+Z brings it back). Esc or Discard throws the preview away; the person's own
  layers are never touched. Older cards say **Accepted** or **Discarded**; an undecided older card has **Show on the
  drawing**. Try again discards the card and sends the same words again with the picture as it is now. If the drawing
  already has 10 layers the preview is refused with the usual layer-limit message.
* **Ideas** in an answer (when asked for ideas) are a list, each with **Add as label**: a text label on the selected
  layer, one undoable step, editable like any text; the thread remembers which were added.
* **Pictures and files.** Paste a picture (Ctrl+V in the box), drop files on the panel, or use the paperclip. Pending
  attachments show as chips with a thumbnail and an x; a refused file shows its reason in red and the others still go.
  Sent attachments appear on the person's message in the thread. A sent picture has **Put on the drawing**: it goes on a
  **new layer** named after the file, centred and scaled to fit the canvas (never enlarged), as one undo step.
* Before sending, the panel shows **the cost** ("About $0.01 per answer", with a drawing a little more; "Not metered" for a
  local runner) and **What will be sent**, a list that now includes the attachments: the message, the sketch title, the
  flattened picture (size shown; a checkbox "Send the drawing" sends words only), the title and text of the ticket, page or
  idea the sketch is in, the canvas size, the earlier messages of the chat, each attached picture and file; and what is
  never sent (layers and the editable source, private Docs pages, other sketches, other comments, secrets, files that were
  not attached to the message).

### What the model sees

Every message goes with the **current flattened picture of what is on screen** (every visible layer, an unaccepted preview
excluded), scaled so its longest side is at most 1280 px (PNG, 4 MB at most), so unsaved work and a drawing that changed
between two questions are what is discussed. On top of that, the engine's history window sends the earlier turns of the
chat (the last 14 messages, each cut at 1,500 characters, with a note under them about what was attached and what became of
a proposal: accepted, discarded, undecided). There is no summary of older turns: older ones fall out of the window.

* The title of the sketch, the question and the earlier turns are fenced as `<untrusted>` data and checked for wording that
  reads like instructions (flagged on the answer, never obeyed). Text inside the picture or an attachment is told to be data.
* **The text the sketch sits in**: a ticket's title and description, a Docs page's title and text, an idea's title and page
  (3,000 characters each), fenced as untrusted data. A **private Docs page is left out** (the chip says so), and only a thing
  of the project the request is booked on is read. A comment's sketch reads the ticket or page it is written on.
* **Attached pictures** follow the picture of the drawing as further pictures; **text files** are added to the message as
  fenced text (named `attached file <name>`). Files of earlier turns are not sent again, only their names in the history.
* The model gets no tools and no layer data.

Image input in the LLM layer (`server/services/ai/llm.py`, `complete(..., images=[bytes, ...])`, any number of PNG, JPEG,
WebP or GIF, the type read from the bytes): Anthropic members send an `image` block each, OpenAI-compatible members an
`image_url` data URL each, and a Claude Code member gets the pictures written to a private temporary folder
(`picture-1.png`, `picture-2.jpg`, …) that becomes its working folder, with only the read-only `Read` tool turned on
(text-only calls still run with no tools). Leaving `images` out gives exactly the old request.

### The ops format (drawing proposals)

The model ends a drawing answer with a ```` ```kanban-actions ```` block `{"draw": {"ops": [...], "note": "one sentence"},
"ideas": [...]}`. The server validates and clamps it (`services/ai/assist/sketch_ai.py`, `clean_ops`; a block cut short by
the token limit is repaired as far as it goes) and the editor checks it **again** before drawing (`engine/aiOps.ts`,
`cleanAiOps`); only these shapes exist, coordinates are integer canvas pixels inside `0..width` and `0..height`, `color` is
`#rrggbb` (anything else becomes `#2b2b2b`):

| `op` | Fields | Drawn as |
|---|---|---|
| `line` (`arrow` is a line with `arrow: true`) | `x1 y1 x2 y2 color size arrow` | stroked line, filled arrow head (head length `max(10, 4 * size)`) |
| `rect`, `ellipse` | `x y w h` (or corners `x1 y1 x2 y2`) `color size fill` | outline, or solid when `fill` is true; clipped to the canvas |
| `text` | `x y text color size bold` | an **editable text object** on the AI layer (font size 8 to 120) |
| `path` | `points [[x, y], ...] color size closed` | a freehand polyline, 2 to 120 points |

Limits: at most **60 ops** per answer; stroke width 1 to 60; text at most 120 characters and 3 lines, control characters
and tags removed; a text with `<script`, `javascript:`, `data:text/html` or an `on…=` handler drops the whole op; unknown
`op`s, non-numbers (strings, booleans, NaN), zero-length lines and empty boxes are dropped, extra keys are never passed
on. The card says how many ops were dropped ("2 shapes could not be drawn and were left out"); an answer that asked to
draw but had nothing usable says "Nothing was changed and nothing was drawn" under the words and has no card. The pure
mapping is tested without a canvas (`engine/aiOps.test.ts`).

### The chat: scope, ids, retention

The chat is the `sketch` scope of the scoped-chat engine (`services/ai/assist/sketch_scope.py`, registered like the `idea`
scope; kind `sketch`, id = the sketch id). It is stored in `ai_chat` / `ai_chat_message` like every scoped chat, one per
person and sketch, and kept 30 days from the last message (`chat.purge`, run whenever chats are listed or opened).

* **A sketch that is not saved yet has no id.** The editor makes a key (kept in the draft in IndexedDB, so restoring the
  draft finds the chat again) and keeps the chat under the scope id `new~<key>~<owner kind>~<owner id>~<project id or ->`.
  The first message of an unsaved drawing also writes the draft, so closing the app does not lose the thread. When the
  sketch is first saved the editor sends that scope id as `draft_chat` with `POST /sketches`, and the server **moves the
  person's own chat to the real sketch id** (`rebind`; only a chat of the same owner and person moves, and a failure never
  fails the save). **Save a copy** makes another sketch, which starts a **new chat**; the original keeps its own.
* **Attachments** are kept in the uploads folder under `_private/ai-chat/<chat id>/<message id>/` (the picture of the
  drawing of every message as `picture.png`, attachments as `a1.png`, `a2.txt`, …), so a backup of the data folder
  carries them. `/uploads/_private/...` is never served (`uploads.resolve_upload_path` refuses it), the files are read only
  through `GET /ai/sketch/chats/{chat}/files/{message}/{file}` by the person whose chat it is (everyone else, members,
  viewers and strangers included, gets 404), and a text file is always stored as `.txt` and served as a download. The folder
  is removed when the chat expires or is deleted.

### What may be attached

Checked from the bytes, not from the name or the type the browser claims, in the browser first (to say why) and again on
the server (`services/ai/assist/attachments.py`):

| | Accepted | Limits |
|---|---|---|
| Pictures | PNG, JPEG, WebP, GIF | 4 per message, 5 MB each, 8000 px on a side at most (the browser scales a picture to 1600 px before sending, so a large photo usually fits) |
| Text files | txt, md, markdown, csv, tsv, json, log, xml, yaml, toml, ini, html, css, svg and common source code (py, js, ts, tsx, java, c, cpp, go, rs, sh, sql …) | 4 per message, 200 KB each, valid UTF-8 without NUL bytes |
| Everything else | PDF, office files, archives, audio and video, other pictures (BMP, HEIC, AVIF) | refused with ““report.pdf” is a PDF, which cannot be read here. Pictures (PNG, JPEG, WebP or GIF, 5 MB at most) and text files (…) can be attached.” |

There is **no PDF text extraction**: no PDF library is a dependency and none was added.

### API

Errors use the AI assistant shape `{detail, code}` (`ai_off`, `viewer`, `forbidden`, `not_configured`, `unavailable`,
`over_budget`, `feature_off`, `invalid`, `too_large` (413), `invalid_output`, `not_found`). The request is booked on the
project of the owner (ticket, page, idea, or the `project_id` a comment passes); an idea with no project is booked on a
project of the caller that has an AI member ready, like the idea chat.

| Route | Purpose |
|---|---|
| `GET /ai/sketch/state?owner_kind&owner_id&project_id&sketch_id` | `availability` (`code` ok / viewer / forbidden / ai_off / …, never an error), the answering member, `estimates` (`answer`, `draw`), `limits` (60 ops, attachment limits) and what is never sent. Sends nothing. |
| `GET /ai/scopes/sketch/{scope id}` | The shared scope state: what the chat reads (chips), the quick-start chips (`starting_points`, `prefill` for the ones that are the start of a sentence), `availability`, the members, the saved `chat_id`. `scope id` is the sketch id or a draft scope id. |
| `POST /ai/scopes/sketch/{scope id}/chat` | The person's saved chat (with its messages and drafts), or a new one with `{"fresh": true}`. |
| `POST /ai/sketch/preview` | JSON: the place, `prompt`, `title`, canvas size, the picture's size, `attachments` (`[{name, kind, bytes, chars}]`) and `chat_id`. Returns the pieces ("What will be sent"), tokens, `estimate` and `draw_estimate`. Sends nothing. |
| `POST /ai/sketch/chats/{chat id}/messages` | Multipart: `text`, `title`, `width`, `height` (the canvas), `with_image`, `image` (the current picture, PNG, 4 MB), `files` (the attachments), `member_id`. Returns `{user, ai}`; the answer streams into the `ai` message (poll `GET /ai/assist/messages/{id}` or the chat). The plain `POST /ai/assist/chats/{id}/messages` refuses a sketch chat. |
| `GET /ai/sketch/chats/{chat id}/files/{message id}/{file}` | A kept picture or file of the person's own chat. |
| `POST /ai/sketch/drafts/{id}/accept` | The editor drew the proposal on the AI layer: records it (audit `sketch_edit`) and closes it. Only the asker, never a viewer. |
| `POST /ai/sketch/drafts/{id}/idea` | `{index}`: idea number `index` was added as a label; the thread remembers it. |
| `POST /ai/assist/drafts/{id}/discard`, `POST /ai/assist/messages/{id}/stop`, `…/retry` | The existing routes: discard a proposal, stop an answer, try a failed answer again (with its own picture). |
| `POST /sketches` (`draft_chat` field) | Also moves the draft chat to the new sketch id (see above). |

Rules enforced by the engine and the scope: a stranger gets `403 forbidden`, a viewer `403 viewer`, AI off for the project
`409 ai_off`, the "Sketch AI" switch off `409 feature_off`, Pause all / a paused member `409 unavailable`, a reached
per-member, board daily or monthly cap leaves the thread readable and the message as `over_budget` (nothing is sent); for a
sketch in an idea the **Idea Space's own switch and daily cap** apply too. Nothing reaches the provider in any of these
cases, and a refused attachment writes nothing (no message, no file). A proposal is an `ai_draft` of kind `sketch`
(`open`, `applied`, `discarded`) the answer links to.

Usage is metered under its own labels: `sketch_chat` (a message without a drawing) and `sketch_draw` (an answer that
carries shapes); a sketch in an idea is booked as `idea_sketch_chat` / `idea_sketch_draw`, which the Idea Space daily cap
counts with its other helpers (`idea_` prefix). All of them count toward the member's daily budget and the board's daily
and monthly caps, and the Settings → AI page shows their month cost under the **Sketch AI** switch. The audit log gets
`sketch_help` when an answer is written (drawing or chat, whether a picture was sent, number of attachments, ops, cost) and
`sketch_edit` when a person accepts shapes.

## AI agents over MCP (the Claude Code CLI path)

A sketch is already two files, so an agent can pull it, edit it and upload it back, exactly like a diagram. These are
new **actions of the existing Docs tools** (no new tool):

| Action | Does |
|---|---|
| `docs_read(sketches, project_id)` | `[{id, title, owner_kind, owner_id, version, width, height, layers, updated_by, updated_at, markdown}]` |
| `docs_read(sketch, sketch_id, path)` | Writes the PNG and the editable `.sketch.json` to local files: `path` is a folder (`<name>.png` and `<name>.sketch.json` inside it) or a `.png` path (the source goes next to it). Returns the paths and `version`. |
| `docs_write(sketch_save, sketch_id, path, base_version [, source_path, title])` | Stores a new version from local files. A stale `base_version` is rejected (409) before the files are read, with "export the sketch again". |
| `docs_write(sketch_create, owner_kind, owner_id, title, path [, source_path])` | A new sketch for a ticket (`IAM-12`) or a Docs page (UUID). Returns the `![title](sketch:sk_…)` line to put on its own line in a text. |

What an agent must respect (all checked by the server with a message that names the limit): paths are **absolute**;
the PNG at most **4096 × 4096 px** and **10 MB**; the source (`format: "kanban-sketch"`, `version: 1`, see
"Source format" above) at most **10 layers** and **10 MB**, its `width` and `height` equal to the PNG's, layers bottom to
top with `png` as a `data:image/png;base64,` URL or `null`. **The PNG is what every text shows, so it must be the flattened
picture of the source.** An agent that only draws a PNG can leave out `source_path`: the server then writes a source with
a white page and the PNG as one picture layer, which opens in the editor to be drawn over (layers and text
of an earlier version are not kept in that case).

Permissions: `docs_write` actions need the **"edit docs"** permission of an AI member (the default templates ask a person
to approve it; "Ask" runs only read), and are recorded in the audit log like the diagram actions. A run may only read or
write sketches of **its own project** ("belongs to another project than this run works in"). The save is attributed to
the AI member. Reading needs nothing beyond the read permission.

## Tests

* `server/tests/test_sketches.py`: create/read/files in the uploads folder, limits (canvas, PNG, source, layers),
  conflict 409 and "replace theirs", save as copy, roles (viewer, member, free idea), delete/restore, ETag.
* `server/tests/test_sketch_ai.py`: validation and clamping of ops, the answer block (found, repaired, bare), who may
  ask (viewer 403, stranger 403, member ok), AI off per project, feature switch, kill switch, monthly cap, the Idea Space
  switch and cap, the thread kept and found again on reopen, the history and what became of a proposal sent to the model,
  the current picture of every turn, Try again with its own picture, proposals (clamped ops, Accept, Discard, only the
  asker), ideas and their added state, the text of a ticket, page and idea fenced (injection flagged, private page left
  out, another project's ticket not read), "What will be sent", attached pictures and text files (accepted by their bytes,
  fenced, flagged), refused kinds and limits (PDF, office, archive, binary, too large, too many), private storage and 404
  for everyone else, removal when the chat expires or is deleted, rebind on first save and a copy starting a new chat, usage
  labels and audit entries, the provider layer with several pictures (Anthropic block, OpenAI `image_url`, Claude Code files).
* `server/tests/test_sketch_mcp.py`: export, edit and save as files, stale `base_version`, a picture without a source,
  limits and messages, an AI run (ask run, approval, blocked, allowed, another project).
* `ui/src/components/sketch/engine/*.test.ts` (`aiOps.test.ts` covers the ops mapping with a recording context,
  `chatFiles.test.ts` what can be attached, scaling, where a picture goes on the drawing and the chat's scope id): flood fill, tile undo, history (>= 100 steps, memory cap), layer
  limits, limits and size checks, source format round trip and refusal of bad files, brush spacing/pressure,
  geometry, colours. Run with `npm test` in `ui/` (the Node test runner, no framework; CI runs it).

## Not built

* Curves with the line tool (lines and arrows only).
* **AI**: the model cannot edit or move the person's own layers or strokes (by design: it only adds an "AI" layer), cannot
  change colours of existing marks, curves with handles, gradients or fills of arbitrary regions, and does not draw
  pixels. Ops are lines, arrows, rectangles, ellipses, text and freehand polylines; 60 per answer.
* **AI**: one answer at a time, no streaming of the answer into the panel as formatted text (it streams as plain text; no
  Markdown rendering in the thread), no "Post as comment" or sharing of a chat (a chat is private to its asker), no
  Do the work. Ideas added as labels are a person's edit and are not audited separately.
* **AI**: older turns are not summarised: the engine sends the last 14 messages, older ones fall out. Attachments of earlier
  turns are not sent again (only their names), so the person attaches a file again to talk about it again. An old
  proposal shown after the canvas was resized is clamped to the new size by the editor's own check.
* **AI**: attachments are pictures and text only. **No PDF or office text extraction** (no library, none added); a PDF is
  refused with advice to paste its text or a screenshot. A GIF is read as a still picture. The browser scales pictures
  down to 1600 px (a re-encode to PNG or JPEG), so fine print in a huge screenshot may be lost.
* **AI**: a chat of a drawing that was never saved and whose draft was discarded or lost (browser data cleared, another
  browser) stays on the server until it expires and cannot be reopened; the scope id of a draft is not guessable but is not
  a secret either (only its owner can read the chat). Opening a sketch's chat from a deleted sketch is "not found".
* **AI**: the Claude Code runner path (pictures as files read with the `Read` tool) is covered by a test of the command it
  builds, not run against a real `claude` binary here; Anthropic and OpenAI-compatible requests are tested against a mock
  transport, not a live provider. The picture of the drawing is scaled to 1280 px and a very detailed drawing may lose fine
  detail.
* **AI**: no "Ask AI" for a sketch shown in the large viewer (it opens in the editor only), and no AI help for a sketch
  that is only readable (viewer).
* **MCP**: agents cannot delete or restore a sketch, cannot list sketches of a project-less idea, and `sketch_create` does
  not accept an idea or comment as owner (ticket or Docs page only). Older versions are not kept, so there is no way to
  export a past version. An agent that saves a PNG without a source loses the layers of the previous version.
* Real-time drawing together; one person edits at a time (the conflict card handles the rest).
* Undo history is not stored in the saved file or the draft.
* Older versions of a sketch are not kept (one PNG and one source per drawing); a Docs page version shows the latest
  drawing.
