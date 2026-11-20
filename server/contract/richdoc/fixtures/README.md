# Rich Docs fixtures (format 1)

Shared by the UI (`ui/src/richdoc`, the truth: it runs the Docs editor's own TipTap extensions) and the server
(`server/crates/kb-richdoc`, which must reproduce every file byte for byte). The rules they follow are in
`../README.md`; this file says how the files are made and where the plain flavour loses something.

## Layout

| Files | What |
|---|---|
| `md/<name>.md` | Plain Markdown input: one file per syntax feature, every page template (`template-*`, from `kb-docs/src/text/ba_templates/` and `kb-doctext/src/docs_templates.rs`) and the Markdown of the Docs guide, section 5 (`guide-section5.md` is the section itself, `guide-examples.md` its examples written out); `empty.md` is the blank template |
| `md/<name>.json` | `markdownToDoc(md, seqIds())`: the page the editor makes of it, canonical JSON (`../README.md`), ids `b-000001`, `b-000002`… in document order (pre-order: a block before its children) |
| `md/<name>.out.md` | `docToMarkdown(json)`: what the editor stores, `compactMarkdown(cleanEditorMarkdown(getMarkdown()))` |
| `md/<name>.txt` | `docToText(json)`: the plain-text projection |
| `json/<name>.json` | Rich-only pages (every node, mark and attribute of `schema.json` at least once), canonical, with valid unique ids |
| `json/<name>.out.md`, `json/<name>.txt` | As above |

Each `.out.md` and `.txt` file holds the value followed by one newline (an empty value gives an empty file). The
value itself can end with a newline: the editor writes one when the page ends with an empty paragraph (see below).

## How they are made and checked

`ui/src/richdoc/fixtures.test.ts` checks every file; `cd ui && RICHDOC_WRITE=1 npx vitest run src/richdoc` writes
the `.json` (md only), `.out.md` and `.txt` files again. The `json/*.json` inputs are written by hand (they were
generated once by a script and are now edited directly); the test checks they are canonical and their ids valid. It
also checks:

- **idempotence** of the md fixtures: `docToMarkdown(markdownToDoc(out.md)) == out.md`, except the four cases listed
  below (`NOT_IDEMPOTENT` in the test);
- for the json fixtures: the page survives the editor through `setContent`/`getJSON` and through HTML (copy and
  paste); `out.md` read and written again is stable after one round;
- `ui/src/richdoc/schema.test.ts`: the editor schema has exactly the nodes, marks, attributes and defaults of
  `schema.json` (plus `doc`, `text`, `hardBreak`).

## The text projection (`.txt`)

- One line per text block (paragraph, heading, pull quote, code block); a block holding only white space gives none.
  A hard break is a new line, and a soft line break kept in the text (`a\nb` from two Markdown lines) stays one.
- Inline: text as is (marks dropped); docRef its `label`, else `Page › Section`, else `Page`; ticketRef its key; math
  its LaTeX.
- List items start with `- `, task items with `- [ ] ` / `- [x] `, on the item's first line; nested lists are not
  indented; an ordered list uses `- ` too.
- A table row is one line, cells joined by ` | ` (a cell's blocks joined by a space, line breaks made spaces); a row
  whose cells are all empty is skipped. A `|` in a cell is not escaped.
- Embeds, one line per non-empty value, in this order: image `alt`, `caption`; video `title`, `caption`,
  `description`; htmlEmbed `title`; linkEmbed `title`, `description`; fileCard `name`; pageCard `page`; ticketCard
  `key`; diagram, sketch, canvas `label`; mathBlock `latex`.
- callout: its `title`, then its blocks; blockquote and pullQuote: their text, then `source`. A rule gives nothing.
- Lines are joined by `\n`, with no final newline.

## Known lossy cases (today's editor behaviour, kept)

Reading Markdown:

- A callout's title line folds into the body: `> [!WARNING] Careful` + `> body` reads as one paragraph
  `Careful\nbody` and is written back as `> [!WARNING]` / `> Careful` / `> body` (`callout-title-line`). A
  `title` attribute is written on the marker line for that reason, and reads back the same way.
- Callout kinds: `NOTE` → note, `DANGER` → danger (format 1; before, info and warning), `TIP`/`OK` → success,
  `CAUTION`/`WARN` → warning, `IMPORTANT` → info, case-insensitive. An unknown kind (`[!FOO]`) stays a quote and is
  written `> \[!FOO\]`.
- Inline and block HTML: only `<a>`, `<b>`, `<strong>`, `<i>`, `<em>`, `<u>`, `<s>`, `<del>`, `<strike>`, `<sup>`,
  `<sub>`, `<code>`, `<mark>` and `<br>` are read as formatting. Any other tag (`<span>`, `<div>`, `<kbd>`, `<title>`
  in the templates) is kept as the text typed, written back `&lt;span>…` (format 1; before, the element and its text
  could vanish).
- A ticket key that is the whole of a bold span loses the bold (`**FR-001**` → `FR-001`), and anything shaped like a
  key (`UTF-8`, `ISO-8601`) is read as a ticket reference (the editor shows it plain when no such ticket exists).
- `![x](…)` inside a sentence stays an image inside the paragraph (the schema has image as a block; the editor keeps
  it) and gets a block id (`images`).
- An escaped dollar (`\$x\$`) is written `$x$`, which reads back as math; `$$` in the middle of a line is moved to a
  line of its own (`math-dollars`).
- Entities: `&amp;`, `&lt;`, `&gt;` are read as the characters and written as the characters (`&copy;`, `&nbsp;`
  stay as typed).
- `[Needs input: …]` markers are text: written `\[Needs input: …\]`.
- When the last block is not a paragraph the editor adds an empty paragraph at the end (StarterKit's trailing node):
  it is in the `.json` and makes the Markdown end with a newline.

Not idempotent (read again, the Markdown changes once more):

- `code-fence-tilde`: `~~~` and longer fences are written as ```` ``` ````, so a fence inside a fence closes it.
- `html-inline`: `<not a tag>` is written `&lt;not a tag>`, which reads back as the text `<not a tag>`.
- `lists-bullet`: two lists one after the other (`-` then `*`) are written as two `-` lists, which read back as one.

Writing plain Markdown from a rich page (json fixtures):

- Dropped, text kept: colour, font, size, underline, sup/sub, highlight colour, alignment, indent, spacing, drop cap,
  variants, list styles, rule styles, table and cell styles, image placement, code block options and `filename`,
  column layout. Two highlights of different colours side by side are written `==a====b==` and read back as two
  default highlights.
- Dropped entirely: image `caption` (it is in `.txt`), blockquote and pullQuote `source`, callout `color`, `icon`,
  `style`, pageCard `pageId`, docRef `pageId`, `targetBlockId` and `targetLabel`, diagram `version` and `widthPct`.
- A pullQuote reads back as a blockquote, a fileCard as a link in a paragraph, a pageCard as a docRef and a
  ticketCard as a ticketRef in a paragraph, a `custom` callout as `info`, and a placeholder line as a paragraph of
  text (written `\[embed: …\]` the next time).
- `code` excludes every other mark (TipTap's Code mark), so `code` with `underline` cannot be held.
