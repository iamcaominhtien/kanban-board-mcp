# Rich Docs format (`richdoc`, format version 1)

A Docs page is stored as a ProseMirror/TipTap JSON document (`{"type":"doc","content":[...]}`) that follows
`schema.json`. Markdown is a projection of it (export, import, the MCP view, search text); it is never the page.

The schema is shared by the server (`server/crates/kb-richdoc`) and the UI (`ui/src/richdoc`). Both read
`fixtures/` and must produce the same results. A change to the format changes `schema.json`, the fixtures, both
implementations and `FORMAT_VERSION` together.

## Block ids

- Every node that is not inline, not `text` and not `doc` carries the attribute `blockId`: `b-` and 6 lower-case
  hex digits (`b-3f2a9c`). Ids are unique within a page. (`id` is taken: `diagram`, `sketch` and `canvas` use it for
  the drawing they show.)
- A missing, malformed or duplicated id is replaced when the page is saved (`ensure_block_ids`); the first holder of a
  duplicated id keeps it. Ids never change otherwise: moving, editing or restyling a block keeps its id.
- The **top-level blocks** are the children of `doc` and the children of each `column`. They are the unit of AI
  edits, suggestions and diffs. Nested blocks (list items, paragraphs in a callout or a cell) keep their own ids for
  comment and highlight anchors.

## Named palette

Colours are stored by name (`"teal"`), or as `#rrggbb` for a hand-picked colour ("custom" to AI teams). The value
of a name depends on the page background (`palette.json`). Text colours: ink, slate, green, olive, teal, blue,
violet, pink, red, orange, amber, brown. Highlights: yellow, lime, green, teal, blue, violet, pink, red, orange,
sand, grey, slate. Table cell shading uses the highlight names.

## The two Markdown flavours

**Plain** (export, the stored `markdown` projection, search, the UI's Markdown import and copy): GFM plus the
syntax the editor already kept before format 1, written exactly as the TipTap editor writes it (fixtures):

| Node / mark | Plain Markdown |
|---|---|
| heading 1–6, paragraph, bold, italic, strike, code, link, lists, task list, quote, code fence, GFM table, `---` | GFM |
| highlight (any colour) | `==text==` |
| callout | `> [!INFO]`, `[!WARNING]`, `[!SUCCESS]`, `[!DANGER]`, `[!NOTE]` (the kind upper-cased; `custom` is written `[!INFO]`) |
| image | `![alt\|width](src)` (width in px, when set) |
| docRef | `[[Page#Section\|label]]` |
| ticketRef | the bare key `KAN-12` |
| diagram / sketch / canvas | `[Name](diagram:dg_…)`, `![Name](sketch:sk_…)`, `![Name](canvas:cv_…#frag)` |
| mathInline / mathBlock | `$…$` / `$$\n…\n$$` |
| fileCard | `[name](/uploads/…)` on its own line |
| pageCard / ticketCard | `[[Page]]` / `KAN-12` on its own line |
| pullQuote | `> text` |
| columns | the columns' blocks one after another |
| video, htmlEmbed, linkEmbed, a table with merged cells | one placeholder line `[embed: <kind> · <title>]` (`kind`: `video`, `HTML embed`, `link`, `table with merged cells`) |
| colour, font, size, alignment, indent, spacing, drop cap, underline, sup/sub, image placement… | dropped (the text stays) |

**Annotated** (the MCP view `docs_read get` and the input of `docs_write` edits): plain, plus

- one marker line before every top-level block: `<!-- #b-3f2a9c -->`, with the block's rich attributes after the
  id as `key=value` pairs (values with spaces in double quotes): `<!-- #b-3f2a9c align=center -->`,
  `<!-- #b-77c1aa image placement=floatRight width=40 caption="Planning night" -->`. Attributes at their default are
  left out. A marker without an id (`<!-- align=center -->`) is allowed in input: the block gets a new id.
- inline spans for marks plain Markdown cannot hold: `[text]{color=red}`, `[text]{highlight=pink}`,
  `[text]{font=lora size=18}`, `[text]{.underline}`, `[text]{.sup}`, `[text]{.sub}`; several in one span
  (`[text]{.underline color=teal}`).
- `columns`: `<!-- #b-… columns ratio=1:2 -->`, then `<!-- column -->` before each column's blocks, then
  `<!-- /columns -->`.
- placeholders keep their id: `<!-- #b-… video -->` + `[embed: video · Release demo]`. A placeholder in an edit
  means "keep this block as it is"; leaving one out of `update` keeps it too (it can only be removed with an explicit
  block delete). Full detail of one block: `docs_read(action='block')` (JSON).

## Projections written on every save

- `markdown`: plain Markdown (above).
- `text`: plain text, one line per text block, for search, snippets, word counts and Docs health
  (`fixtures/*.txt`). Table cells are separated by ` | `, list items start with `- `; embeds contribute their title,
  caption, alt text, file name or code; nothing is read from inside an image, a video, a drawing or a file.
