import type { Editor, JSONContent, Range } from '@tiptap/core';
import type { CalloutKind } from './constants';

/** The AI rows of `/ai` (design/screens/docs-ai.md F1). `docs` marks the rows of the "Docs only" group. */
export type AiSlashId =
  'ask' | 'section' | 'links' | 'summary' | 'table' | 'explain_code' | 'diagram' | 'tickets' | 'check';

export interface SlashCtx {
  /** Opens the AI menu at the cursor; undefined when the editor has no AI (the "Ask AI" item is then left out). */
  openAi?: () => void;
  /** Set while the editor offers AI: picking a row runs it. `docs` is true when Docs AI is on for the project. */
  ai?: { run: (id: AiSlashId) => void; docs: boolean };
  pickImage: () => void;
  newDiagram: () => void;
  newSketch: () => void;
  importDiagram: () => void;
  ticketPrefix: string;
  pageTitle: string;
}

export interface SlashItem {
  id: string;
  group: 'Text' | 'Blocks' | 'Link to' | 'AI' | 'Docs only';
  /** Extra words that find the row (the AI rows answer to `ai`). */
  keywords?: string;
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
    id: 'bullet',
    group: 'Text',
    label: 'Bulleted list',
    desc: 'Simple list of items',
    kbd: '- ',
    tile: { icon: 'i48' },
    run: (e, r) => chain(e, r).toggleBulletList().run(),
  },
  {
    id: 'number',
    group: 'Text',
    label: 'Numbered list',
    desc: 'Ordered steps',
    kbd: '1. ',
    tile: { icon: 'i49' },
    run: (e, r) => chain(e, r).toggleOrderedList().run(),
  },
  {
    id: 'task',
    group: 'Text',
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
    id: 'divider',
    group: 'Text',
    label: 'Divider',
    desc: 'Horizontal rule',
    kbd: '---',
    tile: { icon: 'i64' },
    run: (e, r) => chain(e, r).setHorizontalRule().run(),
  },
  {
    id: 'code',
    group: 'Blocks',
    label: 'Code block',
    desc: 'Monospace with language',
    kbd: '```',
    tile: { icon: 'i53' },
    run: (e, r) => chain(e, r).setCodeBlock().run(),
  },
  {
    id: 'table',
    group: 'Blocks',
    label: 'Table',
    desc: '3 × 3 to start',
    tile: { icon: 'i52' },
    run: (e, r) => chain(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: 'callout-info',
    group: 'Blocks',
    label: 'Callout: Info',
    desc: 'Blue note',
    kbd: ':::info',
    tile: { icon: 'i31' },
    run: callout('info'),
  },
  {
    id: 'callout-warning',
    group: 'Blocks',
    label: 'Callout: Warning',
    desc: 'Amber caution',
    kbd: ':::warn',
    tile: { icon: 'i31', color: '#B8860B' },
    run: callout('warning'),
  },
  {
    id: 'callout-success',
    group: 'Blocks',
    label: 'Callout: Success',
    desc: 'Green confirmation',
    kbd: ':::ok',
    tile: { icon: 'i31', color: '#2E6F40' },
    run: callout('success'),
  },
  {
    id: 'ai',
    group: 'Blocks',
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
    group: 'Blocks',
    label: 'Image',
    desc: 'Upload or paste',
    tile: { icon: 'i54' },
    run: (e, r, ctx) => {
      chain(e, r).run();
      ctx.pickImage();
    },
  },
  {
    id: 'sketch',
    group: 'Blocks',
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
    id: 'diagram',
    group: 'Blocks',
    label: 'Diagram',
    desc: 'Boxes and arrows (draw.io)',
    kbd: '/diagram',
    tile: { icon: 'i33' },
    run: (e, r, ctx) => {
      chain(e, r).run();
      ctx.newDiagram();
    },
  },
  {
    id: 'diagram-import',
    group: 'Blocks',
    label: 'Import .drawio file',
    desc: 'Also drop a file onto the page',
    tile: { icon: 'i26' },
    run: (e, r, ctx) => {
      chain(e, r).run();
      ctx.importDiagram();
    },
  },
  {
    id: 'toc',
    group: 'Blocks',
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

/**
 * Return the slash-menu items matching a query. Items whose name starts with the query come first, so "/ai" offers
 * the editor's AI menu before "Sketch" (whose description has "paint" in it).
 * @param query - What was typed after "/".
 * @param opts.ai - Set while the Docs AI rows are offered (adds them).
 * @param opts.withAi - False leaves out the editor's own "Ask AI…" row (the editor has no AI menu). Default true.
 */
export function filterSlash(query: string, opts: { ai?: SlashCtx['ai']; withAi?: boolean } = {}): SlashItem[] {
  const q = query.trim().toLowerCase();
  const withAi = opts.withAi ?? true;
  const base = withAi ? SLASH_ITEMS : SLASH_ITEMS.filter((i) => i.id !== 'ai');
  const all = opts.ai ? [...base, ...aiSlashItems(opts.ai.docs, withAi)] : base;
  if (!q) return all;
  if (q === 'ai') {
    // "/ai" is its own menu: the editor's AI row first, then the Docs rows, all under the AI headings
    const own = all.filter((i) => i.id === 'ai').map<SlashItem>((i) => ({ ...i, group: 'AI' }));
    return [...own, ...all.filter((i) => i.group === 'AI' || i.group === 'Docs only')];
  }
  const hits = all.filter((i) =>
    `${i.label} ${i.desc} ${i.kbd ?? ''} ${i.id} ${i.keywords ?? ''}`.toLowerCase().includes(q),
  );
  const starts = (i: SlashItem) => i.id.startsWith(q) || i.label.toLowerCase().startsWith(q);
  return [...hits.filter(starts), ...hits.filter((i) => !starts(i))];
}
