# Canvas

[#246](https://github.com/iamcaominhtien/kanban-board-mcp/issues/246). Design:
[`design/screens/canvas.md`](../../design/screens/canvas.md) (source `design/source/Canvas.dc.html`). Version 3.17.0.

A **canvas** is the third drawing object, next to [Sketch](sketch-tool.md) and Diagram: design **frames** (HTML pages,
pictures, Sketches, Diagrams) sit side by side on one large plane, with notes, arrows and labels. It appears wherever
Sketch and Diagram appear, and can be a Docs page of its own. It was built the way Sketch was: one object, stored as
attachments of its owner, one markdown line in the text, the same buttons and slash entries, the same save, draft and
conflict behaviour.

## The five questions of section M, answered

| Question | Decision |
|---|---|
| **Name.** "Board" clashes with the Board view. | The screens say **frame** (and "board" nowhere a person reads). Ids, files and code keep `board` (`b_…`, `boards`), because it is text only. |
| **Both forms in v1?** | **Both.** An inline canvas is an attachment of its owner; a canvas can also be a Docs page (`docs_page.kind = 'canvas'`, layers icon in the tree, **Docs › New page › Canvas**). **Move to Docs** turns the first into the second without changing the id, so every text that embeds it keeps showing it. |
| **History of a page that embeds a canvas.** | **Always the latest**, as the design's cheaper option says. A text never freezes a canvas; the canvas has its own history (versions). |
| **Limits.** | As proposed: **60 frames, 5 MB per frame, 50 MB per canvas, 10 page tabs**, lock released after **10 idle minutes**. The numbers are constants in `services/canvases.py` and `services/canvas_locks.py`; the API returns them (`limits`). |
| **HTML boards.** | **A folder**: `index.html` (or the page you name) with its CSS, pictures and fonts, shown in the same locked frame the Preview uses. A ZIP of a built page works. |

## What is stored

Everything of one canvas is inside the uploads folder (so a backup of the data folder carries it):

```
uploads/canvases/cv_8f3a1c2d/
  canvas.json                    the plane: page tabs, boards, notes, arrows, labels (the "one file")
  overview.png                   an outline picture of the first page tab, written on every save (exports use it)
  boards/b_0a1b2c3d/r2/…         the files of one revision of a frame's content; revisions are never rewritten
  proposals/cp_…/b_…/…           the files an AI member proposed (nothing on the canvas changes until accepted)
```

The tables (migration `b8c9d0e1f2a3`): `canvas` (owner, `rev`, latest `version`), `canvas_version` (a frozen copy of
`canvas.json` per version), `canvas_thread` / `canvas_comment` (comments, same shape as Docs comments),
`canvas_proposal`; and `docs_page.kind`.

### `canvas.json` (format `kanban-canvas`, version 1)

```json
{
  "format": "kanban-canvas", "version": 1,
  "pages":  [{ "id": "p_…", "name": "Sign in", "rev": 3 }],
  "boards": [{ "id": "b_…", "page": "p_…", "name": "Sign in", "kind": "html|image|sketch|diagram|empty",
               "x": 0, "y": 0, "w": 1280, "h": 800, "order": 0, "ref": null, "rev": 5,
               "content": { "rev": 2, "entry": "index.html", "files": [{"path": "index.html", "bytes": 1234}],
                            "bytes": 1234, "blocked": [{"kind": "request", "count": 2, "host": "cdn.example.com"}] } }],
  "notes":  [{ "id": "n_…", "page": "p_…", "x": 0, "y": 0, "w": 160, "h": 100, "text": "", "color": "yellow", "by": "HM", "rev": 5 }],
  "arrows": [{ "id": "a_…", "page": "p_…", "from": "b_…", "to": "n_…", "label": "", "rev": 5 }],
  "labels": [{ "id": "t_…", "page": "p_…", "x": 0, "y": 0, "text": "Step 2", "size": 20, "rev": 5 }]
}
```

A **sketch** or **diagram** frame has `ref` (`sk_…` / `dg_…`) and no `content`: it shows the *latest version* of that
object, so editing the Sketch elsewhere changes the frame. `order` is the list Present and the viewer step through; by
default (all in step with the plane) it is reading order, left to right then top to bottom.

## The markdown line

```
![Login redesign](canvas:cv_8f3a1c2d)            the whole canvas, current page tab (a card)
![Wrong password](canvas:cv_8f3a1c2d#b_0a1b2c3d)  one frame
![Sign in flow](canvas:cv_8f3a1c2d#p_0a1b2c3d)    one page tab
[Login redesign](canvas:cv_8f3a1c2d)              "link only": a chip in the sentence
```

The image form on its own line is a card (Edit, Download, View full size, Copy link on hover; a **⋯** menu with Move to
Docs, Save as copy, Remove from text). A deleted frame falls back to the whole canvas with a note; a canvas that is gone
shows "Canvas not found" with the alt text. In an export (`docs` Export) the card becomes
`![Name](/uploads/canvases/cv_…/overview.png)` and a chip becomes its text. A ticket's attachment strip lists a canvas
as its overview picture.

It is read by `MarkdownRenderer`, `DocsMarkdown`, the WYSIWYG editor (`canvasBlockElement`, with **Show…** for whole
canvas / one frame / link only), and the Docs editor (`Canvas` TipTap node, `/canvas`, a toolbar button).

## API (`api/canvases.py`)

Errors use the Docs error shape `{detail: {code, message, …}}`. Viewers (and strangers) can read; anything that changes
needs the member role (`403 read_only`). **Access is the owner's**: the project is resolved from the ticket, page or idea
(a comment still being written passes `project_id`). There is no public link.

| Route | Purpose |
|---|---|
| `POST /canvases` · `POST /canvases/pages` | Create for an owner (`start: blank \| none`), or a Docs page of kind canvas. |
| `GET /canvases?owner_kind&owner_id` · `GET /canvases/{id}` | List an owner's canvases · the canvas with its file, locks and counts. |
| `PATCH /canvases/{id}` | **Save the plane, merged per item.** Body `{base_rev, upsert: {pages, boards, notes, arrows, labels}, remove, force, checkpoint, name, note, title}`. |
| `DELETE /canvases/{id}` · `POST …/restore` · `POST …/copy` · `POST …/move-to-docs` | Unlink, bring back, save a copy, give it a Docs page. |
| `POST …/boards` · `POST …/import` · `POST …/boards/{b}/duplicate` · `POST …/boards/{b}/replace` | Add a frame (files, picture, `ref`, empty), make frames from files / a ZIP, copy, replace the content. |
| `GET/PUT …/boards/{b}/source` · `…/content` | The text files of an HTML frame; save a new source (needs the lock). |
| `POST/DELETE …/boards/{b}/lock` · `POST …/heartbeat` | Take, release, keep a lock. |
| `GET …/boards/{b}/r/{rev}/{path}` | A file of a frame, served with the locking policy below. `…/snapshot.png`, `…/overview.png`: outline pictures. |
| `GET …/download?board_id&version` | ZIP of every frame with `canvas.json`, or of one frame. |
| `GET/POST …/versions` · `GET/PATCH …/versions/{n}` · `POST …/versions/{n}/restore` · `GET …/compare?a&b` · `GET …/boards/{b}/source-diff` | History. |
| `GET/POST …/threads` · `POST /canvases/threads/{id}/replies · resolve · reopen · propose` · `PATCH/DELETE /canvases/comments/{id}` | Comments. |
| `GET …/proposals` · `POST …/proposals/{p}/decide` · `GET …/proposals/{p}/{b}/{path}` · `POST …/ai/ask` | AI proposals. |

### Layout changes merge per item

Every item carries `rev`, the canvas revision it was last changed in. A save names the `rev` of each item it changes;
the server applies an item only when it still has that `rev`. So two people can arrange at once (different items never
conflict, and no one is asked anything), and only the **same frame or note changed by both** answers
`409 canvas_conflict` with `conflicts: [ids]`, the author and time. The editor then shows the card of the design (Save as
copy, Load theirs; **Replace theirs** is `force`). A save that fails (offline) keeps a draft in `localStorage`
(`kanban-canvas-draft:<id>`) and retries on its own. Ctrl Z undoes layout changes (not source edits); an undone state is
re-stamped with the server's current revisions before it is saved.

### Locks

One lock per frame, **only while its content is open for changing** (the source editor). Moving, resizing, notes,
arrows and comments need no lock. In memory with a time limit (`services/canvas_locks.py`): ends on Save, Cancel, closing
the editor, or **10 idle minutes** (the editor warns after 9; its heartbeat stops after idle so the lock can end). A frame
somebody holds answers `423 board_locked` with the holder; it shows a blue ribbon and its Edit is off. A lost lock leaves
the source as a draft with **Save as new board** / **Copy my source**. A restore waits while any frame is locked. **An AI
member never takes a lock** (it has no route that does).

### Versions

On **Done**, on **accepting a proposal**, on **restore**, and **every 10 minutes of change** for a canvas that is a Docs
page. A version holds a frozen copy of `canvas.json`; frame content is never overwritten (a revision folder per change),
so any version can be looked at, compared and restored. **Restoring makes a new version**; nothing is lost. Compare shows
the two frames side by side with a list of frames that changed, were added or removed, and a source diff.

## HTML frames: no script, no outside request

Defence in depth, because the files come from a person, an upload, a ZIP or an AI:

1. **On the way in** (`services/canvas_html.py`): a real HTML parser (not a regular expression) drops `<script>`,
   `<iframe>`, `<object>`, `<embed>`, `<base>`, `<meta http-equiv>`, event handlers, `javascript:` and outside addresses
   in `src`, `href`, `srcset`, `style`, `<style>` and CSS files (`@import`, `url(…)`); script files (`.js` …) are not kept.
   What was left out is counted per board (`blocked`: scripts, handlers, requests by host) and shown as a **"3 blocked"**
   chip that lists them.
2. **When served** (`api/canvases.py`): every file comes with
   `Content-Security-Policy: default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self' data:; form-action 'none'; base-uri 'none'; sandbox`,
   `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. `sandbox` without `allow-scripts` means a
   frame opened on its own is as locked as one inside the editor.
3. **In the page**: `<iframe sandbox="">` (no scripts, forms, pop-ups, top navigation or same origin), the same locked frame
   as Preview. The source editor's live preview uses Preview's `makeSafeHtml` with the board's own files inlined.

Verified in a real browser (`docs/demo/canvas/frame-check.js`): a hostile page written straight onto the disk, past
step 1, runs no script, raises no dialog and makes no request to the outside, in the large view and opened on its own.
`server/tests/test_canvases.py` covers the cleaning and the headers; `ui/src/components/canvas/canvasUi.test.tsx` the
frame attributes.

## Limits and their errors

| Limit | Error |
|---|---|
| 60 frames per canvas | `422 too_many_boards` |
| 5 MB per frame (all its files) | `413 board_too_large` (names the size, the limits and what to do) |
| 50 MB per canvas | `413 canvas_too_large` |
| 10 page tabs | `422 too_many_pages` |
| 300 files per frame, 500 notes, 500 arrows, 300 labels | `422 too_many_files`, `too_many_items` |
| Frame width 320 to 1920 | clamped |

## AI

Reuse of the Docs AI machinery (members, permissions, budgets, caps, kill switch, audit, "AI never overwrites").

* **Ask AI about the selected frames** (Ctrl J, or **Ask AI** on a frame): `POST /canvases/{id}/ai/ask` starts a Docs AI
  job of kind `canvas` (`services/canvas_proposals.py`). The model sees the frames' source, the notes and the open
  comments as fenced untrusted data, and answers with `=== FILE <frame> <path> ===` blocks. While it works the frames show a
  purple ribbon and stay usable. The result is a **proposal**.
* **A proposal** holds the new files of one or more frames beside the canvas. The person sees **before and after** (two locked
  frames) and, with *Compare in source*, the changed lines; they **Accept both / Accept this one / Reject**. What is accepted
  is saved as **one new version** (`reason: proposal`). A frame that changed since is `stale`; a frame somebody is editing makes
  the proposal **wait** ("AI is waiting for Sign in") and is accepted when the lock ends. Proposals change HTML frames only.
* **AI comments** under the member's own name, can offer **Propose a fix** (starts the same job on that frame) and never
  resolve a person's thread (`403 ai_cannot_resolve`).
* **MCP: no new tool.** Four actions of the Docs tools: `docs_read(canvases)`, `docs_read(canvas, canvas_id [, board_id,
  path])` (frames, notes, arrows, labels, comments, open proposals, locks; with `board_id` a frame's source or, with `path`, its
  files written to a folder), `docs_write(canvas_comment, canvas_id, body [, board_id, thread_id])` and
  `docs_write(canvas_propose, canvas_id, board_id, path [, note])`. `docs_write` needs the member's **Edit docs** permission, an
  ask run only reads, and an AI run may only touch canvases of its own project.

## The editor

Full window over the page (`CanvasEditor`), or inside Docs for a canvas page (no Done, saves as it goes, Share). Header (name,
owner, draft status, **AI**, **Comments**, **History**, **Present**, Download, Save a copy, **Done**), page tabs, the plane,
the tool bar (Select V, Hand H, Board B, Note N, Arrow A, Label T, Comment C), zoom 10% to 400% with Fit, the map, snapping
guides, multi-select and the **Boards** / **Comments** side panel. Below 40% a frame shows a picture of its last state
(an outline, see below); from 40% it is drawn live. Every page tab keeps its own position and zoom for each person
(`localStorage`). The keys are listed under **?** (all of section I). A phone opens a canvas read only in the large view,
one frame at a time.

## Where it differs from the design

* **Frames, not boards**, in the words of the screens (decision 1).
* **Snapshots and overview pictures are outlines, not screenshots.** There is no browser on the server, so the picture shown
  below 40% zoom and written for an export (`overview.png`, `snapshot.png`) is a wireframe drawn from the page's outline
  (headings, text, buttons, fields) and from the plane (`services/canvas_png.py`, no image library). The editor's
  **Board as image (PNG, 2x)** and **Copy board as image** draw the real page in the browser; **PDF** opens the browser's print
  dialog with one frame per page.
* **Ctrl G (group into a named frame) is not built.** Duplicate, align by snapping and multi-select are.
* **Copy link** copies the markdown link (`[Name](canvas:cv_…#b_…)`), which is what a text takes; there is no app URL
  scheme to open a canvas at a frame from outside the app.
* **Create ticket** from a comment thread creates the ticket in the canvas's project with a link back to the frame.
* `.sketch` and `.drawio` files dropped on the plane are turned into a Sketch / Diagram by the editor (flattened in the
  browser, or opened in the Diagram editor to check) and a frame then points at it; the server's import takes HTML, pictures
  and ZIPs.
* Present needs a person at the keys; handing it to a remote presenter is not designed (as in the design).

## Not built

* Real-time editing and live cursors (out of scope in v1).
* Free drawing and a shape library (that is Sketch and Diagram).
* AI proposals for picture, Sketch and Diagram frames (they have their own editors).
* A frame's own comments are kept when the frame is deleted but are only shown in the Comments tab.

## Tests

* `server/tests/test_canvases.py`: create, read, files in the uploads folder, HTML folder frames, placement, limits and their
  errors, the cleaner and the serving headers, ZIP import, the per-item merge and conflict, locks (one per frame, idle
  expiry, content needs the lock, layout does not), versions (Done, named, restore makes a new one, compare, source diff),
  Docs page canvases and auto versions, Move to Docs, comments, permissions (viewers), download / overview / snapshot,
  proposals (nothing changes until accepted, accept one, stale, waiting for a lock, HTML frames only), the model reply parser,
  boards as sections, Linked docs and backlinks.
* `server/tests/test_canvas_mcp.py`: the four MCP actions, the guard, the project scope.
* `ui/src/components/canvas/*.test.ts(x)`: plane math (zoom, fit, snap, resize, order, arrows), the merge after a save and the
  undo re-stamp, the line diff, the preview inlining, the canvas line and exports, and the UI (embed display and hover
  actions, editor load and save, lock and conflict cards, offline draft, source editor, the locked frame, proposal accept and
  reject, a view-only person).
