/**
 * Comments on the blocks of a rich page (design "History and comments on rich pages", D 18–22): a comment attaches
 * to a block id and a quote inside it, so an image, a table or an embed can be commented on as a whole (its quote is
 * the image's alt text or caption, the table's first cell, the embed's title). This module says what a block is
 * called in a thread ("Image · Float right"), where a thread stands on the page now (open, resolved, quote edited,
 * block deleted, orphaned), the page order of the threads, how many threads a restore would orphan, and where the
 * margin marks go. Pure: no React; the DOM only in {@link topBlockOf}.
 */

import type { CommentAnchorInput, DocsCommentThread, RichDoc } from '../../../types/docs';
import { topLevelBlocks } from '../../../richdoc/ids';
import { cellText, docToText } from '../../../richdoc/text';
import { slugify } from '../../../utils/docsMarkdown';

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const short = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Blocks commented on as a whole (no text selection inside them): the block menu's Comment selects the block. */
export const WHOLE_COMMENT_BLOCKS: ReadonlySet<string> = new Set([
  'image',
  'table',
  'htmlEmbed',
  'video',
  'diagram',
  'sketch',
  'canvas',
  'fileCard',
  'linkEmbed',
  'pageCard',
  'ticketCard',
  'mathBlock',
]);

const KIND_NAMES: Record<string, string> = {
  image: 'Image',
  table: 'Table',
  htmlEmbed: 'HTML embed',
  video: 'Video',
  diagram: 'draw.io diagram',
  sketch: 'Sketch',
  canvas: 'Canvas',
  fileCard: 'File',
  linkEmbed: 'Link card',
  pageCard: 'Page card',
  ticketCard: 'Ticket card',
  mathBlock: 'Maths',
};

const PLACEMENT: Record<string, string> = {
  block: 'Centre',
  center: 'Centre',
  left: 'Left',
  right: 'Right',
  floatLeft: 'Float left',
  floatRight: 'Float right',
};

/** The plain text of one block. */
function textOf(node: RichDoc): string {
  return squash(docToText({ type: 'doc', content: [node] }));
}

/**
 * The text a comment on a whole block quotes: the image's alt text or caption, the table's first cell, the embed's
 * title (its label, name or key for a diagram, a file or a card), else the block's text; never empty (the block's
 * kind as a last resort, since the server needs a quote).
 * @param node - A top-level block.
 */
export function blockQuote(node: RichDoc): string {
  const a = node.attrs ?? {};
  let q = '';
  switch (node.type) {
    case 'image':
      q = str(a.alt) || str(a.caption);
      break;
    case 'table': {
      const first = node.content?.[0]?.content?.[0];
      q = first ? cellText(first) : '';
      break;
    }
    case 'htmlEmbed':
    case 'video':
    case 'linkEmbed':
      q = str(a.title) || str(a.caption);
      break;
    case 'diagram':
    case 'sketch':
    case 'canvas':
      q = str(a.label);
      break;
    case 'fileCard':
      q = str(a.name);
      break;
    case 'pageCard':
      q = str(a.page);
      break;
    case 'ticketCard':
      q = str(a.key);
      break;
    case 'mathBlock':
      q = str(a.latex);
      break;
    default:
      q = textOf(node).split('\n')[0] ?? '';
  }
  q = squash(q);
  return q ? short(q, 200) : (KIND_NAMES[node.type ?? ''] ?? 'Block');
}

/**
 * What a whole-block comment is about, in words: "Image · Float right", "Table", "HTML embed · Release countdown".
 * Null for a text block (its thread shows its quote).
 * @param node - A top-level block.
 */
export function blockLabel(node: RichDoc | null | undefined): string | null {
  if (!node?.type || !WHOLE_COMMENT_BLOCKS.has(node.type)) return null;
  const kind = KIND_NAMES[node.type] ?? 'Block';
  const a = node.attrs ?? {};
  if (node.type === 'image') return `${kind} · ${PLACEMENT[str(a.placement)] ?? 'Centre'}`;
  if (node.type === 'table') return kind;
  const title = str(a.title) || str(a.label) || str(a.name) || str(a.page) || str(a.key);
  return title ? `${kind} · ${short(squash(title), 32)}` : kind;
}

/** The slug of the heading a block sits under (the section stored with a comment), or null at the top. */
export function sectionOfBlock(doc: RichDoc | null | undefined, blockId: string): string | null {
  let section: string | null = null;
  for (const b of topLevelBlocks(doc ?? { type: 'doc' })) {
    if (str(b.attrs?.blockId) === blockId) return section;
    if (b.type === 'heading') section = slugify(textOf(b)) || section;
  }
  return section;
}

/**
 * The anchor of a comment on a whole block: its id, its quote ({@link blockQuote}) and its section.
 * @param node - The block.
 * @param doc - The page it is on (for the section).
 */
export function anchorForBlock(node: RichDoc, doc?: RichDoc | null): CommentAnchorInput {
  const id = str(node.attrs?.blockId);
  return {
    quote: blockQuote(node),
    prefix: '',
    suffix: '',
    section: id ? sectionOfBlock(doc, id) : null,
    ...(id ? { blockId: id } : {}),
  };
}

/** A block of `doc` by its id (columns' blocks included), with its place among the page's blocks. */
export function findBlock(doc: RichDoc | null | undefined, id: string): { node: RichDoc; index: number } | null {
  if (!doc || !id) return null;
  const all = topLevelBlocks(doc);
  const index = all.findIndex((b) => str(b.attrs?.blockId) === id);
  return index < 0 ? null : { node: all[index], index };
}

/** Where a thread stands on the page now (design D 22). */
export type ThreadState = 'open' | 'resolved' | 'quoteEdited' | 'blockDeleted' | 'orphaned';

/** A thread's place on the page: its state, the block it is on and what that block is called. */
export interface ThreadPlace {
  state: ThreadState;
  /** The block's place among the page's blocks (null: not on the page). */
  blockIndex: number | null;
  /** Where its quote starts in the block's text (-1: not found). */
  quoteAt: number;
  /** "Image · Float right" for a comment on a whole block. */
  label: string | null;
  /** An orphaned thread: the block now where its text was (the server keeps it), to show that spot. */
  whereBlockId?: string | null;
  /** An orphaned thread: the title of the section its text was in. */
  sectionTitle?: string | null;
}

/** The text of the heading whose slug is `slug`, or null. */
export function sectionTitle(doc: RichDoc | null | undefined, slug: string | null | undefined): string | null {
  if (!doc || !slug) return null;
  const want = slug.replace(/-\d+$/, '');
  const h = topLevelBlocks(doc).find((b) => b.type === 'heading' && slugify(textOf(b)) === want);
  return h ? textOf(h) : null;
}

/** How many characters `a` and `b` share at their ends (`fromEnd`) or starts. */
function shared(a: string, b: string, fromEnd: boolean): number {
  let n = 0;
  while (n < a.length && n < b.length) {
    const x = fromEnd ? a[a.length - 1 - n] : a[n];
    const y = fromEnd ? b[b.length - 1 - n] : b[n];
    if (x !== y) break;
    n++;
  }
  return n;
}

/**
 * The block a quote is in when its block id does not say: of the blocks holding it, the one whose text around it
 * matches the anchor's prefix and suffix best (ties: the first), not simply the first block holding it.
 */
function blockByQuote(all: RichDoc[], quote: string, prefix: string, suffix: string): number {
  let best = -1;
  let bestScore = -1;
  all.forEach((b, i) => {
    const text = textOf(b);
    let at = text.indexOf(quote);
    if (at < 0 && blockQuote(b) === quote) at = 0;
    while (at >= 0) {
      const sc = shared(text.slice(0, at), prefix, true) + shared(text.slice(at + quote.length), suffix, false);
      if (sc > bestScore) {
        best = i;
        bestScore = sc;
      }
      at = text.indexOf(quote, at + 1);
    }
  });
  return best;
}

/**
 * Where a thread stands on a page: on its block with its quote (open), on its block whose text changed (quote
 * edited: the thread follows its block), its block gone (block deleted), or its text gone (orphaned). The server
 * carries every anchor across a publish and says when its text was removed; an orphaned thread then names the block
 * now where its text was. Threads without a block id (from before the rich format) are found by their quote.
 * @param t - The thread.
 * @param doc - The published page (null for a Markdown page: the server's state is all there is).
 */
export function threadPlace(t: DocsCommentThread, doc: RichDoc | null | undefined): ThreadPlace {
  const a = t.anchor;
  const quote = squash(a?.quote ?? '');
  const blockId = str(a?.blockId);
  const resolved = t.status === 'resolved';
  const orphaned = a?.state === 'orphaned';
  const base = (state: ThreadState): ThreadPlace => ({ state, blockIndex: null, quoteAt: -1, label: null });
  if (!doc) return base(resolved ? 'resolved' : orphaned ? 'orphaned' : 'open');
  const all = topLevelBlocks(doc);
  const hit = blockId ? findBlock(doc, blockId) : null;
  if (orphaned) {
    // its text is gone; a block id that is still on the page is where that text was
    const title = sectionTitle(doc, a?.section);
    if (hit) return { ...base(resolved ? 'resolved' : 'orphaned'), whereBlockId: blockId, sectionTitle: title };
    return { ...base(resolved ? 'resolved' : blockId ? 'blockDeleted' : 'orphaned'), sectionTitle: title };
  }
  const byQuote = () => (quote ? blockByQuote(all, quote, a?.prefix ?? '', a?.suffix ?? '') : -1);
  if (blockId && hit) {
    const label = blockLabel(hit.node);
    const text = textOf(hit.node);
    const inside = !quote || text.includes(quote) || blockQuote(hit.node) === quote || !!label;
    return {
      state: resolved ? 'resolved' : inside ? 'open' : 'quoteEdited',
      blockIndex: hit.index,
      quoteAt: quote ? text.indexOf(quote) : -1,
      label,
    };
  }
  // no block id, or one from before the page's ids changed: the server found the quote, so follow it
  const at = byQuote();
  if (at < 0 && blockId) return base(resolved ? 'resolved' : 'blockDeleted');
  return {
    state: resolved ? 'resolved' : 'open',
    blockIndex: at < 0 ? null : at,
    quoteAt: at < 0 ? -1 : textOf(all[at]).indexOf(quote),
    label: null,
  };
}

/**
 * Threads in page order: by the place of their block, then where their quote starts in it, then their number;
 * threads not on the page come last, newest first.
 * @param threads - The page's inline threads.
 * @param doc - The published page (null keeps the server's order).
 */
export function orderThreads(threads: DocsCommentThread[], doc: RichDoc | null | undefined): DocsCommentThread[] {
  if (!doc) return threads;
  const keyed = threads.map((t, i) => ({ t, i, p: threadPlace(t, doc) }));
  keyed.sort((x, y) => {
    const bx = x.p.blockIndex ?? Infinity;
    const by = y.p.blockIndex ?? Infinity;
    if (bx !== by) return bx - by;
    if (bx === Infinity) return y.t.createdAt.localeCompare(x.t.createdAt) || x.i - y.i;
    const qx = x.p.quoteAt < 0 ? (x.t.anchor?.pos ?? 0) : x.p.quoteAt;
    const qy = y.p.quoteAt < 0 ? (y.t.anchor?.pos ?? 0) : y.p.quoteAt;
    if (qx !== qy) return qx - qy;
    return (x.t.number ?? Infinity) - (y.t.number ?? Infinity) || x.i - y.i;
  });
  return keyed.map((k) => k.t);
}

/**
 * How many open threads a restore would orphan: those on a block of the page now that the restored version does not
 * have (they stay in the panel as orphaned threads; nothing is deleted).
 * @param threads - The page's threads.
 * @param current - The page now.
 * @param target - The version being restored.
 */
export function orphanedByRestore(
  threads: DocsCommentThread[],
  current: RichDoc | null | undefined,
  target: RichDoc | null | undefined,
): number {
  if (!current || !target) return 0;
  const keep = new Set(topLevelBlocks(target).map((b) => str(b.attrs?.blockId)));
  const blocks = topLevelBlocks(current);
  let n = 0;
  for (const t of threads) {
    if (t.kind !== 'inline' || t.status !== 'open' || t.anchor?.state === 'orphaned') continue;
    const p = threadPlace(t, current);
    if (p.blockIndex == null || p.state === 'blockDeleted') continue;
    const id = str(blocks[p.blockIndex]?.attrs?.blockId);
    if (id && !keep.has(id)) n += 1;
  }
  return n;
}

/**
 * The top-level block a DOM node is in: the outermost element with a block id inside the reader (`.dk-rich`).
 * @param node - A node of the rendered page (where a selection starts).
 */
export function topBlockOf(node: Node | null | undefined): HTMLElement | null {
  let el: Element | null = node instanceof Element ? node : (node?.parentElement ?? null);
  let hit: HTMLElement | null = null;
  while (el && !el.classList.contains('dk-rich')) {
    if (el.hasAttribute('data-block-id')) hit = el as HTMLElement;
    el = el.parentElement;
  }
  return hit;
}

/** One thread to mark in the margin: its block and how far down the page that block starts. */
export interface MarkInput {
  threadId: string;
  number: number;
  /** The block it is on (marks on one block share one mark). */
  blockKey: string;
  /** The block's top, in px from the top of the page body. */
  top: number;
}

/** One mark in the margin: level with its block, the first thread's number and how many threads it holds. */
export interface MarginMark {
  blockKey: string;
  top: number;
  number: number;
  threadIds: string[];
}

/**
 * Where the margin marks go: one per block (its threads in number order), level with the block, in page order, each
 * pushed down below the one before it when two blocks are closer than a mark.
 * @param items - The threads with their blocks.
 * @param gap - The height of a mark plus the space between two (px).
 */
export function layoutMarks(items: MarkInput[], gap = 26): MarginMark[] {
  const byBlock = new Map<string, MarginMark>();
  for (const it of items) {
    const m = byBlock.get(it.blockKey);
    if (m) {
      m.threadIds.push(it.threadId);
      m.number = Math.min(m.number, it.number);
      m.top = Math.min(m.top, it.top);
    } else
      byBlock.set(it.blockKey, { blockKey: it.blockKey, top: it.top, number: it.number, threadIds: [it.threadId] });
  }
  const numberOf = new Map(items.map((i) => [i.threadId, i.number]));
  const marks = [...byBlock.values()].sort((a, b) => a.top - b.top || a.number - b.number);
  let floor = -Infinity;
  for (const m of marks) {
    m.threadIds.sort((a, b) => (numberOf.get(a) ?? 0) - (numberOf.get(b) ?? 0));
    m.top = Math.max(m.top, floor);
    floor = m.top + gap;
  }
  return marks;
}
