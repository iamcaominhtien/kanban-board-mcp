import type { Editor, JSONContent, Range } from '@tiptap/core';
import type { CalloutKind } from './constants';
import { askBlockUi } from './blocks/bus';
import { insertColumns, insertDivider, insertPullQuote, insertTableSized, type TableSize } from './blocks/commands';

/** The AI rows of `/ai` (design/screens/docs-ai.md F1). `docs` marks the rows of the "Docs only" group. */
export type AiSlashId =
  'ask' | 'section' | 'links' | 'summary' | 'table' | 'explain_code' | 'diagram' | 'tickets' | 'check';

export interface SlashCtx {
  /** Opens the AI menu at the cursor; undefined when the editor has no AI (the "Ask AI" item is then left out). */
  openAi?: () => void;
  /** Set while the editor offers AI: picking a row runs it. `docs` is true when Docs AI is on for the project. */
  ai?: { run: (id: AiSlashId) => void; docs: boolean };
  pickImage: () => void;
  /** Opens the file picker for any file (Excel, Word, PDF, zip…), inserted as a link to the stored file. */
  pickFile?: () => void;
  newDiagram: () => void;
  newSketch: () => void;
  newCanvas: () => void;
  importDiagram: () => void;
  ticketPrefix: string;
  pageTitle: string;
  /** Opens the Insert image dialog (Upload, Link, Project files); without it Image opens the file picker. */
  insertImage?: () => void;
  /** The size picked in the catalog's Insert table step; 3 × 3 with a header row when unset. */
  table?: TableSize;
  /** False in an editor of plain Markdown (an idea page): the embeds only a rich page holds are left out. */
  rich?: boolean;
}

/** The groups of the Insert catalog, in the order of its rail. */
export const SLASH_GROUPS = [
  'Text',
  'Lists',
  'Media',
  'Tables & layout',
  'Embeds',
  'Link to',
  'AI',
  'Docs only',
] as const;
export type SlashGroup = (typeof SLASH_GROUPS)[number];

export interface SlashItem {
  id: string;
  group: SlashGroup;
  /** `table`: the catalog asks for the size first (a hover grid, steppers on a phone). */
  step?: 'table';
  /** Extra words that find the row (the AI rows answer to `ai`). */
  keywords?: string;
  /** Only a rich page can hold it (HTML embed, video, link embeds). */
  richOnly?: boolean;
  label: string;
  desc: string;
  kbd?: string;
  /** text tile (H1…) or an icon id */
  tile: { text: string } | { icon: string; color?: string };
  run: (editor: Editor, range: Range, ctx: SlashCtx) => void;
}

const chain = (e: Editor, r: Range) => e.chain().focus().deleteRange(r);

function callout(kind: CalloutKind) {
  return (e: Editor, r: Range) => chain(e, r).setCallout(kind).run();
}

function toc(e: Editor, r: Range, ctx: SlashCtx) {
  const items: JSONContent[] = [];
  e.state.doc.descendants((n) => {
    if (n.type.name !== 'heading') return;
    const text = n
      .textBetween(0, n.content.size, '', (l) => String(l.attrs.label || l.attrs.page || l.attrs.key || ''))
      .trim();
    if (!text) return;
    items.push({
      type: 'listItem',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'docRef', attrs: { page: ctx.pageTitle, section: text, label: null } }],
        },
      ],
    });
  });
  if (!items.length) {
    chain(e, r).run();
    return;
  }
  chain(e, r).insertContent({ type: 'bulletList', content: items }).run();
}

export const SLASH_ITEMS: SlashItem[] = [
  {
    id: 'h1',
    group: 'Text',
    label: 'Heading 1',
    desc: 'Big section title',
    kbd: '# ',
    tile: { text: 'H1' },
    run: (e, r) => chain(e, r).setHeading({ level: 1 }).run(),
  },
  {
    id: 'h2',
    group: 'Text',
    label: 'Heading 2',
    desc: 'Medium section title',
    kbd: '## ',
    tile: { text: 'H2' },
    run: (e, r) => chain(e, r).setHeading({ level: 2 }).run(),
  },
  {
    id: 'h3',
    group: 'Text',
    label: 'Heading 3',
    desc: 'Small section title',
    kbd: '### ',
    tile: { text: 'H3' },
    run: (e, r) => chain(e, r).setHeading({ level: 3 }).run(),
  },
  {
    id: 'h4',
    group: 'Text',
    label: 'Heading 4',
    desc: 'Run-in heading',
    kbd: '#### ',
    tile: { text: 'H4' },
    run: (e, r) => chain(e, r).setHeading({ level: 4 }).run(),
  },
  {
    id: 'bullet',
    group: 'Lists',
    label: 'Bulleted list',
    desc: 'Simple list of items',
    kbd: '- ',
    tile: { icon: 'i48' },
    run: (e, r) => chain(e, r).toggleBulletList().run(),
  },
  {
    id: 'number',
    group: 'Lists',
    label: 'Numbered list',
    desc: 'Ordered steps',
    kbd: '1. ',
    tile: { icon: 'i49' },
    run: (e, r) => chain(e, r).toggleOrderedList().run(),
  },
  {
    id: 'task',
    group: 'Lists',
    label: 'Task list',
    desc: 'Checkable items',
    kbd: '[] ',
    tile: { icon: 'i50' },
    run: (e, r) => chain(e, r).toggleTaskList().run(),
  },
  {
    id: 'quote',
    group: 'Text',
    label: 'Quote',
    desc: 'Set a passage apart',
    kbd: '> ',
    tile: { icon: 'i51' },
    run: (e, r) => chain(e, r).setBlockquote().run(),
  },
  {
    id: 'pullquote',
    group: 'Text',
    label: 'Pull quote',
    desc: 'A big line lifted from the text',
    keywords: 'quote magazine blog',
    tile: { text: '“' },
    run: (e, r) => insertPullQuote(e, r),
  },
  {
    id: 'code',
    group: 'Text',
    label: 'Code block',
    desc: 'Monospace with language',
    kbd: '```',
    tile: { icon: 'i53' },
    run: (e, r) => chain(e, r).setCodeBlock().run(),
  },
  {
    id: 'table',
    group: 'Tables & layout',
    label: 'Table',
    desc: '3 × 3 to start',
    keywords: 'grid rows cells spreadsheet',
    step: 'table',
    tile: { icon: 'i52' },
    run: (e, r, ctx) => insertTableSized(e, ctx.table ?? { rows: 3, cols: 3, headerRow: true }, r),
  },
  {
    id: 'columns',
    group: 'Tables & layout',
    label: 'Columns',
    desc: 'Two side by side',
    keywords: 'layout side by side two 2 grid aside',
    tile: { text: '▥' },
    run: (e, r) => insertColumns(e, 2, r),
  },
  {
    id: 'columns3',
    group: 'Tables & layout',
    label: '3 columns',
    desc: 'Three side by side',
    keywords: 'columns layout three grid',
    tile: { text: '▥▥' },
    run: (e, r) => insertColumns(e, 3, r),
  },
  {
    id: 'divider',
    group: 'Tables & layout',
    label: 'Divider',
    desc: 'Line, dots or a scene break',
    keywords: 'horizontal rule line hr separator',
    kbd: '---',
    tile: { icon: 'i64' },
    run: (e, r) => chain(e, r).setHorizontalRule().run(),
  },
  {
    id: 'scene',
    group: 'Tables & layout',
    label: 'Scene break',
    desc: 'Three stars between two scenes',
    keywords: 'divider stars story fiction',
    kbd: '* * *',
    tile: { text: '***' },
    run: (e, r) => insertDivider(e, 'stars', r),
  },
  {
    id: 'callout-info',
    group: 'Tables & layout',
    label: 'Callout: Info',
    desc: 'Blue note',
    kbd: ':::info',
    tile: { icon: 'i31' },
    run: callout('info'),
  },
  {
    id: 'callout-warning',
    group: 'Tables & layout',
    label: 'Callout: Warning',
    desc: 'Amber caution',
    kbd: ':::warn',
    tile: { icon: 'i31', color: '#B8860B' },
    run: callout('warning'),
  },
  {
    id: 'callout-success',
    group: 'Tables & layout',
    label: 'Callout: Success',
    desc: 'Green confirmation',
    kbd: ':::ok',
    tile: { icon: 'i31', color: '#2E6F40' },
    run: callout('success'),
  },
  {
    id: 'callout-danger',
    group: 'Tables & layout',
    label: 'Callout: Danger',
    desc: 'Red, for what cannot be undone',
    keywords: 'error caution alert',
    tile: { icon: 'i14', color: '#C4432A' },
    run: callout('danger'),
  },
  {
    id: 'callout-note',
    group: 'Tables & layout',
    label: 'Callout: Note',
    desc: 'Grey aside',
    keywords: 'aside remark',
    tile: { icon: 'i28', color: '#5B6B60' },
    run: callout('note'),
  },
  {
    id: 'callout-custom',
    group: 'Tables & layout',
    label: 'Callout: Custom',
    desc: 'Your own colour and icon',
    keywords: 'colour color icon emoji',
    tile: { icon: 'i31', color: '#5B4BB5' },
    run: (e, r) => chain(e, r).setCallout('custom').run(),
  },
  {
    id: 'ai',
    group: 'AI',
    label: 'Ask AI…',
    desc: 'Write, continue, summarise or translate',
    kbd: '/ai',
    tile: { text: '✦' },
    run: (e, r, ctx) => {
      chain(e, r).run();
      ctx.openAi?.();
    },
  },
  {
    id: 'image',
    group: 'Media',
    label: 'Image',
    desc: 'Upload or paste',
    keywords: 'picture photo screenshot png jpg upload',
    tile: { icon: 'i54' },
    run: (e, r, ctx) => {
      chain(e, r).run();
      (ctx.insertImage ?? ctx.pickImage)();
    },
  },
  {
    id: 'file',
    group: 'Media',
    keywords: 'attach attachment upload excel xlsx word docx pdf zip',
    label: 'File',
    desc: 'Attach Excel, Word, PDF or any file',
    tile: { icon: 'attach' },
    run: (e, r, ctx) => {
      chain(e, r).run();
      ctx.pickFile?.();
    },
  },
  {
    id: 'video',
    group: 'Media',
    label: 'Video',
    desc: 'Upload a file or use its address',
    keywords: 'movie mp4 webm mov film recording',
    richOnly: true,
    tile: { text: '▶' },
    run: (e, r) => {
      chain(e, r).run();
      askBlockUi(e, { type: 'insertVideo' });
    },
  },
  {
    id: 'html',
    group: 'Embeds',
    label: 'HTML embed',
    desc: 'A small web page, or a whole folder, that runs here',
    keywords: 'html widget iframe css script site folder zip 3d',
    richOnly: true,
    tile: { text: '</>' },
    run: (e, r) =>
      chain(e, r)
        .insertContent({ type: 'htmlEmbed', attrs: { html: '', runScripts: false } })
        .run(),
  },
  {
    id: 'embed-link',
    group: 'Embeds',
    label: 'Embed from link',
    desc: 'YouTube, Vimeo, Loom, or a link card',
    keywords: 'link url bookmark card youtube vimeo loom website',
    richOnly: true,
    tile: { icon: 'link' },
    run: (e, r) => {
      chain(e, r).run();
      askBlockUi(e, { type: 'embedLink' });
    },
  },
  {
    id: 'diagram-insert',
    group: 'Embeds',
    label: 'Insert diagram',
    desc: 'New, from this project, or a .drawio file',
    keywords: 'drawio existing project diagram',
    richOnly: true,
    tile: { icon: 'i33' },
    run: (e, r, ctx) => {
      chain(e, r).run();
      askBlockUi(e, { type: 'insertDiagram', onNew: ctx.newDiagram, onImport: ctx.importDiagram });
    },
  },
  {
    id: 'sketch',
    group: 'Embeds',
    label: 'Sketch',
    desc: 'Draw freehand, like a paint program',
    kbd: '/draw',
    tile: { icon: 'sketch' },
    run: (e, r, ctx) => {
      chain(e, r).run();
      ctx.newSketch();
    },
  },
  {
    id: 'canvas',
    group: 'Embeds',
    label: 'Canvas',
    desc: 'Boards on one large plane',
    kbd: '/canvas',
    keywords: 'boards frames plane screens',
    tile: { icon: 'canvas' },
    run: (e, r, ctx) => {
      chain(e, r).run();
      ctx.newCanvas();
    },
  },
  {
    id: 'diagram',
    group: 'Embeds',
    // DG-2: the design's name; "diagram" stays a keyword so "/dia" still finds it
    label: 'New draw.io drawing',
    desc: 'Boxes and arrows, edited in draw.io',
    keywords: 'diagram boxes arrows flowchart',
    kbd: '/diagram',
    tile: { icon: 'i33' },
    run: (e, r, ctx) => {
      chain(e, r).run();
      ctx.newDiagram();
    },
  },
  {
    id: 'diagram-import',
    group: 'Embeds',
    label: 'Import .drawio file',
    desc: 'Also drop a file onto the page',
    tile: { icon: 'i26' },
    run: (e, r, ctx) => {
      chain(e, r).run();
      ctx.importDiagram();
    },
  },
  {
    id: 'formula',
    group: 'Embeds',
    label: 'Formula',
    desc: 'LaTeX on its own line',
    keywords: 'math latex equation katex',
    kbd: '$$',
    tile: { text: '∑' },
    run: (e, r) =>
      chain(e, r)
        .insertContent({ type: 'mathBlock', attrs: { latex: '' } })
        .run(),
  },
  {
    id: 'toc',
    group: 'Tables & layout',
    label: 'Table of contents',
    desc: "List of this page's headings",
    tile: { icon: 'i42' },
    run: toc,
  },
  {
    id: 'ticket',
    group: 'Link to',
    label: 'Ticket card',
    desc: 'Embed a ticket as KAN-12',
    kbd: 'KAN-',
    tile: { icon: 'i13' },
    run: (e, r, ctx) => chain(e, r).insertContent(`[[${ctx.ticketPrefix}-`).run(),
  },
  {
    id: 'page',
    group: 'Link to',
    label: 'Page link',
    desc: 'Link a page or section',
    kbd: '[[',
    tile: { icon: 'i00' },
    run: (e, r) => chain(e, r).insertContent('[[').run(),
  },
];

function aiItem(id: AiSlashId, group: 'AI' | 'Docs only', label: string, desc: string, icon: string): SlashItem {
  return {
    id: `ai-${id}`,
    group,
    label,
    desc,
    keywords: 'ai',
    tile: { icon, color: '#6B5BD2' },
    run: (e, r, ctx) => {
      chain(e, r).run();
      ctx.ai?.run(id);
    },
  };
}

/**
 * The Docs rows of `/ai` (docs-ai F1): the page's own AI helpers, then the Docs-only group. The editor's own menu
 * ("Ask AI…" with Continue, Summarise, Translate…) is the `ai` row of SLASH_ITEMS and comes before these.
 * @param docs - True when Docs AI is on for the project (adds the Docs-only group).
 * @param ownAsk - True when the editor has its own "Ask AI…" row, so this list does not repeat it.
 */
export function aiSlashItems(docs: boolean, ownAsk = false): SlashItem[] {
  const own = [
    ...(ownAsk ? [] : [aiItem('ask', 'AI', 'Ask AI…', 'Write from a prompt, with this page as context', 'i58')]),
    aiItem('section', 'AI', 'Draft a section from a ticket…', 'Write a section about a ticket', 'i15'),
    aiItem('links', 'AI', 'Suggest [[ ]] links', 'Pages and tickets mentioned in the text', 'i11'),
  ];
  if (!docs) return own;
  return [
    ...own,
    aiItem('summary', 'Docs only', 'Summary at the top', 'A short summary block, as a draft', 'i42'),
    aiItem('table', 'Docs only', 'Table from this list', 'Turns the list above into a table', 'i52'),
    aiItem('explain_code', 'Docs only', 'Explain this code block', 'Plain-language notes under the code', 'i33'),
    aiItem('diagram', 'Docs only', 'Draw a diagram', 'From this section, as an editable draw.io diagram', 'i57'),
    aiItem('tickets', 'Docs only', 'Create tickets from this list', 'Drafts to review first', 'i01'),
    aiItem('check', 'Docs only', 'Check this page', 'Unclear text, gaps, broken or unknown references', 'i17'),
  ];
}

const groupRank = (g: SlashGroup) => SLASH_GROUPS.indexOf(g);

/** How well an item answers a query: 0 for no match, higher is better. */
function score(item: SlashItem, q: string): number {
  const label = item.label.toLowerCase();
  if (label === q || item.id === q) return 100;
  if (item.id.startsWith(q) || label.startsWith(q)) return 80;
  const words = label.split(/[^a-z0-9.]+/).filter(Boolean);
  if (words.some((w) => w.startsWith(q))) return 60;
  const kbd = (item.kbd ?? '').toLowerCase().trim();
  if (kbd && (kbd === q || kbd === `/${q}` || kbd.startsWith(q))) return 50;
  const extra = `${item.keywords ?? ''} ${item.desc}`.toLowerCase();
  if (extra.split(/[^a-z0-9.]+/).some((w) => w.startsWith(q))) return 40;
  if (`${label} ${extra} ${kbd} ${item.id}`.includes(q)) return 20;
  return 0;
}

/**
 * Return the Insert catalog items matching a query: every item, in the order of the catalog's groups, for an empty
 * query; otherwise the items whose name, words (keywords, description) or shortcut match, best first (a name that
 * starts with the query before a word in the description), so "/ai" offers the editor's AI menu before "Sketch"
 * (whose description has "paint" in it).
 * @param query - What was typed after "/".
 * @param opts.ai - Set while the Docs AI rows are offered (adds them).
 * @param opts.withAi - False leaves out the editor's own "Ask AI…" row (the editor has no AI menu). Default true.
 * @param opts.rich - False leaves out what only a rich page holds (an idea page's Markdown editor). Default true.
 */
export function filterSlash(
  query: string,
  opts: { ai?: SlashCtx['ai']; withAi?: boolean; rich?: boolean } = {},
): SlashItem[] {
  const q = query.trim().toLowerCase();
  const withAi = opts.withAi ?? true;
  const rich = opts.rich ?? true;
  const base = SLASH_ITEMS.filter((i) => (withAi || i.id !== 'ai') && (rich || !i.richOnly));
  const all = (opts.ai ? [...base, ...aiSlashItems(opts.ai.docs, withAi)] : base)
    .map((item, i) => ({ item, i }))
    .sort((a, b) => groupRank(a.item.group) - groupRank(b.item.group) || a.i - b.i)
    .map((x) => x.item);
  if (!q) return all;
  if (q === 'ai') {
    // "/ai" is its own menu: the editor's AI row first, then the Docs rows, all under the AI headings
    return all.filter((i) => i.group === 'AI' || i.group === 'Docs only');
  }
  return all
    .map((item, i) => ({ item, i, s: score(item, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.item);
}

const RECENT_KEY = 'kb.docs.insertRecent';

/** The ids of the blocks this person inserted last, newest first (kept in this browser). */
export function recentSlashIds(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').slice(0, 4) : [];
  } catch {
    return [];
  }
}

/** Remembers that the block `id` was inserted (the four newest are kept). */
export function rememberSlash(id: string): void {
  try {
    const next = [id, ...recentSlashIds().filter((x) => x !== id)].slice(0, 4);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // storage blocked: the catalog simply shows no recent blocks
  }
}
