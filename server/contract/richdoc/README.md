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
- The **top-level blocks** are the children of `doc` and the children of each `column` (in reading order: a
  `columns` block, then the blocks of its first column, its second…). They are the unit of AI
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
| callout | `> [!INFO]`, `[!WARNING]`, `[!SUCCESS]`, `[!DANGER]`, `[!NOTE]` (the kind upper-cased; `custom` is written `[!INFO]`); a `title` goes on the marker line (`> [!DANGER] Do not`) and reads back as the first line of the body |
| image | `![alt\|width](src)` (width in px, when set) |
| docRef | `[[Page#Section\|label]]` |
| ticketRef | the bare key `KAN-12` |
| diagram / sketch / canvas | `[Name](diagram:dg_…)`, `![Name](sketch:sk_…)`, `![Name](canvas:cv_…#frag)` |
| mathInline / mathBlock | `$…$` / `$$\n…\n$$` |
| fileCard | `[name](/uploads/…)` on its own line (`name`, or `src` when empty, escaped as editor text: `[report\_v2.pdf](…)`) |
| pageCard / ticketCard | `[[Page]]` / `KAN-12` on its own line (`[`, `]`, `\|`, `#` and line breaks in the page become spaces; nothing for an empty page) |
| pullQuote | `> text` |
| columns | the columns' blocks one after another |
| video, htmlEmbed, linkEmbed, a table with merged cells | one placeholder line `[embed: <kind> · <title>]` (`kind`: `video`, `HTML embed`, `link`, `table with merged cells`), or `[embed: <kind>]` when the title is empty. Title: video `title`, else `caption`, else `src`; htmlEmbed `title`; linkEmbed `title`, else `url`; merged table its first row as in `text` (cells joined by ` \| `). In the title `[`, `]` and line breaks become spaces, runs of white space one space, trimmed |
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

## Annotated attribute names

The annotated flavour as `kb-richdoc` writes and reads it (`fixtures/annotated/<name>.md` is the annotated form of
the page `md/<name>.json` or `json/<name>.json`).

**Markers.** `<!-- #b-3f2a9c [type] key=value … -->` on its own line, right before the block's Markdown; blocks are
separated by a blank line. The marker lists only what the block's Markdown does not give back when read: the
attributes below whose value differs (`alt=null` when `![](…)` would read as an empty alt), in key order. The `type`
word appears when the Markdown reads as another node (`fileCard` reads as a link, `pageCard` as a page reference,
`ticketCard` as a ticket reference, `pullQuote` as a quote, an empty `pageCard`/`ticketCard` as nothing) and for
placeholders. Values are a bare word or a JSON string in double quotes (`-->` written `-\u002d>`); a bare value takes
the attribute's type (`24`, `true`, `null`), objects and arrays (`crop`) are JSON in a string. In input, the id can
be left out (the block gets a new one), a marker names attributes by these names or by their schema names, and an
HTML comment that does not start like a marker (`#id`, a node type, `column`, `/columns` or `key=value`) is text.
An unknown key or a value of the wrong type is a syntax error.

| Schema attribute | Annotated name | | Schema attribute | Annotated name |
|---|---|---|---|---|
| `textAlign` | `align` | | `language` (codeBlock) | `lang` |
| `indent` | `indent` | | `filename` | `file` |
| `lineHeight` | `line-height` | | `lineNumbers` | `numbers` |
| `spaceBefore` / `spaceAfter` | `before` / `after` | | `highlightLines` | `lines` |
| `dropCap` | `dropcap` | | `wrap`, `theme`, `diff` | same |
| `variant`, `source` | same | | `width` (image, px) | `px` |
| `listStyle` | `style` | | `widthPct` (image, diagram, video) | `width` |
| `start`, `type` (orderedList) | same | | `wrapGap` (image) | `gap` |
| `style` (rule, table, callout) | `style` | | `runScripts` (htmlEmbed) | `scripts` |
| `width` (table), `ratio`, `gap`, `line` (columns) | same | | `pageId` | `page-id` |
| `kind`, `color`, `icon`, `title` (callout) | same | | `targetBlockId` | `target` |
| | | | `targetLabel` (docRef: the heading's or block's name when the link was made, shown when it is gone) | `target-label` |

Every other attribute keeps its schema name (`placement`, `caption`, `href`, `crop`, `border`, `radius`, `shadow`,
`version`, `fragment`, `poster`, `loop`, `muted`, `size`, `mime`, `preview`, `site`…). A callout's `title` is always
in its marker (the `> [!KIND]` line is written without it, since the plain flavour reads a title line back as body
text).

**Inline spans.** `[text]{…}` with `.underline`, `.sup`, `.sub` and `color=`, `highlight=` (a coloured highlight; a
default one stays `==text==`), `font=` (a `fontFamily` key), `size=` (px), classes first:
`[**all of them**]{.underline color=teal font=caveat size=24}`. A span sits inside a link and outside every other mark
(`[[x]{.sup}](url)`, `[**x**]{.sub}`). A page reference's ids follow it: `[[Spec#Fields]]{page-id=pg_9
target=b-00ab12 target-label=Fields}`.

**Columns.** `<!-- #b-… columns ratio=1:2 gap=32 line=true -->`, then `<!-- #b-… column -->` before each column's
blocks (each with its own marker), then `<!-- /columns -->`.

**Placeholders.** `<!-- #b-… video -->` + `[embed: video · Release demo]` (also `htmlEmbed`, `linkEmbed`, `table` for a
table with merged cells). A block whose annotated Markdown would not read back exactly (rare: two inline formulas
side by side, a code span holding a line break, an empty ordered-list item…) is written the same way with its own
type (`<!-- #b-… paragraph -->` + `[embed: paragraph · first words]`). Reading, a marker with a type followed by an
`[embed: …]` line takes the block of that id from the page as it is (its marker's attributes applied); a `video`,
`htmlEmbed` or `linkEmbed` marker followed by anything else is refused.

**HTML embeds showing a site.** An `htmlEmbed` whose `src` is set (a site's page, `/docs/sites/<id>/<entry>`) is its
marker line alone, with no placeholder or code block under it: `<!-- #b-… htmlEmbed height=600
src=/docs/sites/ab12cd34ef56/index.html title=Globe -->`. Reading, a marker with `src=…` is the whole block (what
follows it, a code block included, is the next block); its `html` is kept from the page's block of the same id. Plain
Markdown writes the same placeholder line as for inline HTML.

**Escapes added to plain text** so it reads back as written: `\$` where `$` would open math or makes `$$`, `\=\=`
for `==`, `KAN\-12` for text that only looks like a ticket key, `http\://`, `www\.`, `a\@b` for bare URLs and
e-mails that are not links, `\<` before a tag-like `<`, `\&` before an entity-like `&` (no `&amp;` encoding),
`&#32;` for spaces that start or end a text block, `<br>` for every hard break, a fence longer than any backtick run
in the code, and, when needed, block syntax at the start of a paragraph line (`\# `, `\> `, `\- `, `1\. `, `a\) `).

**Reading.** The first block under a marker takes its id and attributes (more blocks under one marker get new ids).
Nested blocks (list items, cells, a callout's paragraphs…) take their ids and the attributes plain Markdown cannot
show (`background`, `colspan`, a nested callout's `title`…) from the block of the same id in the page, by position
and type; attributes the Markdown holds (`level`, `language`, `checked`, image `src`/`alt`/`title`/`width`, a cell's
`align` when its column's alignment changed…) come from the Markdown. A block whose Markdown renders exactly as the
page's block of the same id is that block, unchanged (white space at mark edges and similar details survive).
Markers inside fenced code are code.

## Projections written on every save

- `markdown`: plain Markdown (above).
- `text`: plain text, one line per text block, for search, snippets, word counts and Docs health
  (`fixtures/*.txt`). Table cells are separated by ` | `, list items start with `- `; embeds contribute their title,
  caption, alt text, file name or code; nothing is read from inside an image, a video, a drawing or a file.

## Canonical JSON

The fixtures and both implementations compare pages in one canonical form: an attribute at its schema default is left
out (an `attrs` left empty too), attribute keys are sorted by code point, marks come in the order of `schema.json`
`marks`, and the keys of a node come in the order `type`, `attrs`, `content`, `marks`, `text`. Files are
`JSON.stringify(doc, null, 2)` plus a newline. Like the editor (StarterKit's trailing node), reading Markdown whose
last block is not a paragraph adds an empty paragraph at the end. How the fixtures are made: `fixtures/README.md`.
