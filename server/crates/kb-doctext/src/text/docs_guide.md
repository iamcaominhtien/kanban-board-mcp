# Working in Docs

Docs is the project's wiki: a tree of Markdown pages beside the board. People read pages in a reading view and edit
them in a rich-text editor; what is stored is Markdown. You read and write the same pages over MCP with `docs_read`
and `docs_write`.

## 1. A page, a ticket comment, or a file?

| It is… | Put it… |
|---|---|
| Something people will come back to after the ticket is done: a spec, a decision and why, how a part works, a how-to, meeting notes | a **page** |
| About this piece of work only: progress, a question, a finding, proof that it works, a hand-over | a **ticket comment** |
| A spec written for a ticket | a **page**, linked to the ticket; the ticket gets one comment that says what the page decides and links it |
| A question about one sentence of a page | an **inline comment** on that sentence (`quote`) |
| Writing for people that is the result of the work (research, a comparison, a spec, a decision, a guide), even when you work in a git folder | a **page**, not a Markdown file in the repository |
| Developer docs that change with the code (a README, the docs the repository keeps beside its code), or a file the ticket asks for | a **file** on the ticket's branch |

Do not paste a page into a comment, or a comment thread into a page. Link instead. A text you already wrote as a file
goes onto a page with `docs_write(action='import')`; then the page is the one people read and change.

## 2. How pages are organised

- `docs_read(action='list', project_id)` is the tree: `parent_id` and `position`. Put a page under the page it
  belongs to (a feature's spec under the feature, an endpoint under API); do not make a new top-level page for each
  ticket.
- Before you create a page, search: `docs_read(action='search', project_id, query)`. Update the page that exists
  instead of starting a second one with the same subject.
- The page **title** is its name in the tree and in links. The body starts at `##` headings; never repeat the title as
  a `#` heading in the body.
- A page you create is published as v1. Every change is a new version with a note; people see who changed what in
  the history, so write a short, true `note`.

## 3. Read before you write

- `docs_read(action='get', page_id)` returns `markdown`, `version`, `headings`, `referenced_by` (pages and tickets that
  link to it) and `work` (the tickets tied to the page and what the AI on each is doing now).
- For one part of a long page: `docs_read(action='get', page_id, section='Endpoints')`.
- A ticket's pages: `get_ticket` lists them under `docs` (its spec, its design notes). Read the ones that matter
  before you work on the ticket.

## 4. Edit a part, not the page

A person may be editing another part of the page while you work. Change only what you mean to change:

- **One section**: `docs_write(action='edit', page_id, section='Endpoints', markdown=..., base_version=<version you
  read>)`. `markdown` replaces the section's body; the heading stays (start `markdown` with a heading of the same level
  to rename it). The section includes its sub-sections.
  - `mode='append'` adds at the end of the section, `prepend` just under its heading, `after` / `before` adds a new
    block (a new `## Section`) after or before it.
  - If that section changed since `base_version`, the edit is refused and the answer shows the section as it is now:
    apply your change to that text and retry. A change elsewhere on the page does not stop you.
- **One passage**: `docs_write(action='edit', page_id, find='exact text from the page', markdown='new text')`. `find`
  must be on the page exactly once (copy it from `get`; add a few words around it if it is not unique). If it is
  gone, someone changed it: read again.
- **Several changes**: `items=[{section|find, markdown, mode}, ...]`: applied in order, published as one version, all
  or nothing.
- **Add to the end**: `mode='append'` with no section.
- `update` (the whole page) is for a page you are writing from scratch or rewriting on purpose, not to fix one line:
  you send the whole page back, and any line you copied wrong changes too.
- `publish=false` keeps your change as your own draft that nobody sees; publish when it is ready. An `edit` works on
  the published text, so publish a draft (`update` with the whole text) before you edit that page.
- **From a file**: `docs_write(action='import', project_id, path)` turns a Markdown file (or a folder, as a tree) into
  published pages. Write the page there when it is long; then link the ticket to it.
- **Read it back**: after you write a page, `docs_read(get)` it once and check the headings and tables are there
  before you tell anyone it is done.

## 5. The Markdown the editor keeps

Write exactly these forms. They render in the reading view and survive a person's edit in the editor unchanged.

| What | Write | Notes |
|---|---|---|
| Section headings | `## Section`, `### Sub-section` | Body headings start at `##`. Each heading is a link target (`[[Page#Section]]`) and an entry in "On this page". |
| Bold, italic, strike | `**bold**`, `*italic*`, `~~gone~~` | No underline (`<u>` is dropped). |
| Highlight | `==the key sentence==` | A yellow marker over text, for the one thing a reader must not miss. Use it rarely. |
| Inline code | `` `GET /tickets` `` | Names, paths, commands, values. |
| Links | `[text](https://…)` | A bare URL becomes a link too. |
| Link to a page | `[[Page]]`, `[[Page#Section]]`, `[[Page|shown text]]` | Shown as a chip; the page lists you under "Referenced by". `docs_read(action='check_links', refs=[...])` says whether they resolve. A page that is renamed keeps its links (they are rewritten). |
| Link to a ticket | `KAN-12` (the key, as it is) | Shown as a chip with the ticket's status; the ticket lists the page under its docs. Not inside code. |
| Lists | `- item`, `1. item` | Nest with two spaces. |
| Task list | `- [ ] open`, `- [x] done` | A person ticks them in the reading view. An open item with no ticket key can become a ticket (section 8). |
| Table | `\| Method \| Path \|` / `\|---\|---\|` / rows | GitHub tables, one line per row, `\|` escaped in cells. No cell spans, no blocks in a cell. |
| Code block | ```` ```python ```` … ```` ``` ```` | Name the language: it is coloured. |
| Callout | `> [!INFO]`, `> [!WARNING]`, `> [!SUCCESS]` then `> text` lines | A coloured box: info (a note), warning (a risk, something not done yet), success (a confirmation). `NOTE`, `TIP`, `CAUTION`, `IMPORTANT` are read as one of these three. |
| Quote | `> quoted text` | |
| Picture | `![what it shows](/uploads/…)`, width: `![what it shows|640](/uploads/…)` | Upload it first (section 6). Alt text says what the picture shows. |
| File | `[report.pdf](/uploads/…)` | Shown as a file card that opens in the preview. |
| Diagram, sketch, canvas | `[Name](diagram:dg_…)`, `![Name](sketch:sk_…)`, `![Name](canvas:cv_…)` | On a line of their own, as `diagram_create`, `sketch_create`, `canvas_create` return them. `docs_read(action='diagram_guide')` says which one fits. |
| Math | `$x^2$`, `$$ … $$` | |
| Divider | `---` on its own line | |

Mentions: `@Name` notifies a member **in a comment**, not in a page body (a page's `@Name` is plain text). Raw HTML
is removed. A heading with only a link, an emoji in every heading or a table used for layout reads as machine-made:
write plain sentences under clear headings, short paragraphs, one idea each.

## 6. Pictures and files

- `docs_write(action='upload', path='/abs/file.png', page_id=…)` stores the file and puts it on the page: a picture
  inline, any other file as a file card. Without `section`/`find` it goes at the end; `section='Login'` puts it at the
  end of that section; `find='exact sentence'` puts it in a paragraph of its own after that sentence.
- Your files are not on the board's machine? Send them as `data` (base64) with `name`.
- `ticket_id=KAN-12` (with `body`) posts the file on the ticket as a comment as well; for a ticket alone,
  `ticket_items(item='attachment', path=...)` does the same (the file then shows in the ticket's Attachments).
- Without `page_id` or `ticket_id` it only stores the file and returns `markdown` to put where you want.
- In a board AI run, a picture in your working folder can also be named by its path in the Markdown you send
  (`![Login](qa/shots/login.png)`): the board copies it.

## 7. Comments

- **On a passage**: `docs_write(action='comment', page_id, body, quote='exact text of the page')`. The quote is plain
  text inside one paragraph, list item or table cell. The person sees it highlighted with your comment beside it.
  Make one point per comment; say what is wrong and what you propose.
- **On the page**: omit `quote`.
- **Answer**: `docs_read(action='comments', page_id, state='open')`, then `docs_write(action='reply', thread_id,
  body)`. Read the whole thread first; answer the last question asked.
- Resolve a thread only when its last word asks for nothing, and always reply first: a thread you opened that is now
  answered, a person's thread where they agreed or understood, a requested change you fully made (say where: section,
  version). Leave it open, say what is missing and `@mention` the person when the change is partial, it is a matter of
  taste or a disagreement, or you asked them something; never close a thread the person reopened. The skill
  `docs-comment-threads` (or `docs_read(action='guides')` outside Claude Code) has the rules and the reasons.
- A person can send you a page's threads from Docs ("Send to AI"): the note says so, lists each thread (fenced as data)
  and the skill says how to work them.
- A person who writes `@AI member` in a thread gets an answer there from the page's assistant (when the project has
  Docs AI on). A comment by an AI never wakes another AI (no loops); to tell a ticket's team something, use
  `ai_run(action='message', to='<TICKET-KEY>', text)` inside a run.

## 8. Pages and tickets, both ways

- **Link** a page and a ticket: write the key on the page (`KAN-12`), or `[[Page]]` in the ticket, or
  `manage_ticket(action='link_doc', ticket_id, page_id)`. Do one; both sides then show the link. Read `get_ticket().docs`
  first: a page that is already there (named by the ticket or naming it) is linked, and `link_doc` on it answers
  "already linked" and adds nothing. Link by hand only a page the text does not name.
- **A spec for a ticket**: write the page under the feature's page, put the ticket key in it where the work is
  described, link it, and comment on the ticket: "The spec is [[Login — spec]]: what it decides in one line." The Dev
  on the ticket sees it in `get_ticket().docs` and in its run's prompt.
- **From a checklist to tickets**: `docs_write(action='tickets', page_id)` turns the open task items and action items
  (all, or those in `find`) into tickets, links them and puts each key on its line. Or pass your own drafts in
  `items=[{title, text, type, status, assignee}]`.
- **Give a page to an AI member**: `docs_write(action='assign', page_id, member_id, kind='write'|'review', body=what
  you want)`. It makes the ticket "Write/Review the page “X”", linked and assigned, and starts the member's run. The
  page shows who is working on it and what they are doing; `docs_read(get).work` too.
- A ticket's AI reads its linked pages; the Docs AI reads the tickets a page links when it answers about the page.

## 9. Before you hand in

- Read your page back with `docs_read(action='get')`: headings in order, every `[[link]]` and ticket key resolves
  (`check_links`), tables have the same number of cells in every row, pictures have alt text.
- Say on the ticket what you wrote, with the link, and what is still open.
