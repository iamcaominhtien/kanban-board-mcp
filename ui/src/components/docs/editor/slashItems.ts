import type { Editor, JSONContent, Range } from '@tiptap/core';
import type { CalloutKind } from './constants';

export interface SlashCtx {
  pickImage: () => void;
  ticketPrefix: string;
  pageTitle: string;
}

export interface SlashItem {
  id: string;
  group: 'Text' | 'Blocks' | 'Link to';
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
    const text = n.textBetween(0, n.content.size, '', (l) => String(l.attrs.label || l.attrs.page || l.attrs.key || '')).trim();
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
  { id: 'h1', group: 'Text', label: 'Heading 1', desc: 'Big section title', kbd: '# ', tile: { text: 'H1' }, run: (e, r) => chain(e, r).setHeading({ level: 1 }).run() },
  { id: 'h2', group: 'Text', label: 'Heading 2', desc: 'Medium section title', kbd: '## ', tile: { text: 'H2' }, run: (e, r) => chain(e, r).setHeading({ level: 2 }).run() },
  { id: 'h3', group: 'Text', label: 'Heading 3', desc: 'Small section title', kbd: '### ', tile: { text: 'H3' }, run: (e, r) => chain(e, r).setHeading({ level: 3 }).run() },
  { id: 'bullet', group: 'Text', label: 'Bulleted list', desc: 'Simple list of items', kbd: '- ', tile: { icon: 'i48' }, run: (e, r) => chain(e, r).toggleBulletList().run() },
  { id: 'number', group: 'Text', label: 'Numbered list', desc: 'Ordered steps', kbd: '1. ', tile: { icon: 'i49' }, run: (e, r) => chain(e, r).toggleOrderedList().run() },
  { id: 'task', group: 'Text', label: 'Task list', desc: 'Checkable items', kbd: '[] ', tile: { icon: 'i50' }, run: (e, r) => chain(e, r).toggleTaskList().run() },
  { id: 'quote', group: 'Text', label: 'Quote', desc: 'Set a passage apart', kbd: '> ', tile: { icon: 'i51' }, run: (e, r) => chain(e, r).setBlockquote().run() },
  { id: 'divider', group: 'Text', label: 'Divider', desc: 'Horizontal rule', kbd: '---', tile: { icon: 'i64' }, run: (e, r) => chain(e, r).setHorizontalRule().run() },
  { id: 'code', group: 'Blocks', label: 'Code block', desc: 'Monospace with language', kbd: '```', tile: { icon: 'i53' }, run: (e, r) => chain(e, r).setCodeBlock().run() },
  { id: 'table', group: 'Blocks', label: 'Table', desc: '3 × 3 to start', tile: { icon: 'i52' }, run: (e, r) => chain(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { id: 'callout-info', group: 'Blocks', label: 'Callout: Info', desc: 'Blue note', kbd: ':::info', tile: { icon: 'i31' }, run: callout('info') },
  { id: 'callout-warning', group: 'Blocks', label: 'Callout: Warning', desc: 'Amber caution', kbd: ':::warn', tile: { icon: 'i31', color: '#B8860B' }, run: callout('warning') },
  { id: 'callout-success', group: 'Blocks', label: 'Callout: Success', desc: 'Green confirmation', kbd: ':::ok', tile: { icon: 'i31', color: '#2E6F40' }, run: callout('success') },
  { id: 'image', group: 'Blocks', label: 'Image', desc: 'Upload or paste', tile: { icon: 'i54' }, run: (e, r, ctx) => { chain(e, r).run(); ctx.pickImage(); } },
  { id: 'toc', group: 'Blocks', label: 'Table of contents', desc: "List of this page's headings", tile: { icon: 'i42' }, run: toc },
  { id: 'ticket', group: 'Link to', label: 'Ticket card', desc: 'Embed a ticket as KAN-12', kbd: 'KAN-', tile: { icon: 'i13' }, run: (e, r, ctx) => chain(e, r).insertContent(`[[${ctx.ticketPrefix}-`).run() },
  { id: 'page', group: 'Link to', label: 'Page link', desc: 'Link a page or section', kbd: '[[', tile: { icon: 'i00' }, run: (e, r) => chain(e, r).insertContent('[[').run() },
];

export function filterSlash(query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.filter((i) =>
    `${i.label} ${i.desc} ${i.kbd ?? ''} ${i.id}`.toLowerCase().includes(q),
  );
}
