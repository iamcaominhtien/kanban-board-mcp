/**
 * Where a shared highlight sits in the rendered page: a block id (`data-block-id`), character offsets in that
 * block's text and the quote (kb-docs docs_highlights.rs). The text of a block is its text nodes, leaving out what
 * the reader adds around the page's own words (comment numbers, anchors, buttons, maths). Finding a highlight again
 * trusts the quote first: the words at the offsets, else the same words nearest to them in the block, else nothing
 * ("Passage changed"), so a highlight is never drawn on the wrong words.
 */

import type { DocsHighlight, HighlightInput } from '../../../api/docsHighlights';

/** Elements whose text is not the page's own words. */
const SKIP_SEL = 'button,.dk-anchor,svg,.katex,[data-nocomment],[data-hl-skip],script,style';
/** Characters of context kept before and after a quote. */
const CONTEXT = 32;
/** Elements that cannot be highlighted inside (design K 88: embeds). */
const EMBED_SEL = 'iframe,video,.dk-embed,[data-embed]';

/** The text of one block and, for each of its characters, the DOM text node and offset it came from. */
export interface BlockMap {
  el: HTMLElement;
  text: string;
  map: { node: Text; offset: number }[];
}

/**
 * Reads a block's text.
 * @param el - The block element (`data-block-id`).
 */
export function blockMap(el: HTMLElement): BlockMap {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP_SEL) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let text = '';
  const map: BlockMap['map'] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    const data = node.data;
    for (let i = 0; i < data.length; i += 1) map.push({ node, offset: i });
    text += data;
  }
  return { el, text, map };
}

const attrValue = (s: string) => s.replace(/["\\]/g, '\\$&');

/**
 * The element of a block in the page.
 * @param root - The rendered page body.
 * @param id - The block id.
 */
export function blockEl(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-block-id="${attrValue(id)}"]`);
}

/** The innermost block element holding a DOM node, inside `root`. */
function innerBlock(root: HTMLElement, node: Node): HTMLElement | null {
  const el = node instanceof Element ? node : node.parentElement;
  const hit = el?.closest<HTMLElement>('[data-block-id]') ?? null;
  return hit && root.contains(hit) ? hit : null;
}

/** How many characters of the block come before a DOM point. */
function offsetIn(bm: BlockMap, container: Node, offset: number): number {
  const point = document.createRange();
  point.setStart(container, offset);
  let n = 0;
  for (const m of bm.map) {
    if (point.comparePoint(m.node, m.offset) < 0) n += 1;
    else break;
  }
  return n;
}

const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);

/**
 * What to send to highlight the words of a DOM range.
 * @param root - The rendered page body.
 * @param range - The selection.
 * @returns The anchor without its colour, or null when the range is not on a block's words (nothing selected, inside
 *   an embed, only spaces).
 */
export function anchorFromRange(root: HTMLElement, range: Range): Omit<HighlightInput, 'color'> | null {
  if (range.collapsed) return null;
  const sb = innerBlock(root, range.startContainer);
  const eb = innerBlock(root, range.endContainer);
  if (!sb || !eb) return null;
  const startEl = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  if (startEl?.closest(EMBED_SEL)) return null;
  const sm = blockMap(sb);
  const em = eb === sb ? sm : blockMap(eb);
  let s = offsetIn(sm, range.startContainer, range.startOffset);
  let e = offsetIn(em, range.endContainer, range.endOffset);
  if (sb === eb) {
    while (s < e && isSpace(sm.text[s])) s += 1;
    while (e > s && isSpace(sm.text[e - 1])) e -= 1;
    if (e <= s) return null;
    return {
      blockId: sb.dataset.blockId ?? '',
      endBlockId: null,
      start: s,
      end: e,
      quote: sm.text.slice(s, e),
      prefix: sm.text.slice(Math.max(0, s - CONTEXT), s),
      suffix: sm.text.slice(e, e + CONTEXT),
    };
  }
  while (s < sm.text.length && isSpace(sm.text[s])) s += 1;
  while (e > 0 && isSpace(em.text[e - 1])) e -= 1;
  const quote = range.toString().replace(/\s+/g, ' ').trim();
  if (!quote) return null;
  return {
    blockId: sb.dataset.blockId ?? '',
    endBlockId: eb.dataset.blockId ?? null,
    start: s,
    end: e,
    quote,
    prefix: sm.text.slice(Math.max(0, s - CONTEXT), s),
    suffix: em.text.slice(e, e + CONTEXT),
  };
}

/**
 * "Use the new quote" (K 87): the words that now stand where a changed highlight was, widened to whole words.
 * @param root - The rendered page body.
 * @param h - The highlight whose words are gone.
 * @returns The anchor of the edited words, or null when its block is gone, it ran across blocks, or nothing stands
 *   there any more.
 */
export function newQuoteOf(
  root: HTMLElement,
  h: Pick<DocsHighlight, 'blockId' | 'endBlockId' | 'start' | 'end'>,
): Omit<HighlightInput, 'color'> | null {
  if (h.endBlockId) return null;
  const el = blockEl(root, h.blockId);
  if (!el) return null;
  const { text } = blockMap(el);
  let s = Math.min(Math.max(0, h.start), text.length);
  let e = Math.min(Math.max(s, h.end), text.length);
  while (s > 0 && !isSpace(text[s - 1])) s -= 1;
  while (e < text.length && e > 0 && !isSpace(text[e]) && !isSpace(text[e - 1])) e += 1;
  // the widening stops before punctuation at the edges ("screens." → "screens")
  while (e > s && /[.,;:!?)\]”’"]/.test(text[e - 1])) e -= 1;
  while (s < e && /[([“‘"]/.test(text[s])) s += 1;
  while (s < e && isSpace(text[s])) s += 1;
  while (e > s && isSpace(text[e - 1])) e -= 1;
  if (e <= s) return null;
  return {
    blockId: h.blockId,
    endBlockId: null,
    start: s,
    end: e,
    quote: text.slice(s, e),
    prefix: text.slice(Math.max(0, s - CONTEXT), s),
    suffix: text.slice(e, e + CONTEXT),
  };
}

/** A DOM range over characters `[s, e)` of two block maps (the same one inside a block). */
function rangeOf(sm: BlockMap, s: number, em: BlockMap, e: number): Range | null {
  if (s < 0 || e <= 0 || s >= sm.map.length || e > em.map.length) return null;
  const r = document.createRange();
  const a = sm.map[s];
  const b = em.map[e - 1];
  r.setStart(a.node, a.offset);
  r.setEnd(b.node, b.offset + 1);
  return r.collapsed ? null : r;
}

/** Every index of `needle` in `hay`. */
function indexesOf(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/**
 * Finds a highlight's words in the rendered page.
 * @param root - The rendered page body.
 * @param h - The highlight.
 * @returns Its DOM range, or null when its words are not on the page ("Passage changed").
 */
export function locate(
  root: HTMLElement,
  h: Pick<DocsHighlight, 'blockId' | 'endBlockId' | 'start' | 'end' | 'quote'>,
): Range | null {
  const sb = blockEl(root, h.blockId);
  if (!sb) return null;
  const sm = blockMap(sb);
  if (!h.endBlockId) {
    if (sm.text.slice(h.start, h.end) === h.quote) return rangeOf(sm, h.start, sm, h.end);
    const hits = indexesOf(sm.text, h.quote);
    if (!hits.length) return null;
    const best = hits.reduce((a, b) => (Math.abs(b - h.start) < Math.abs(a - h.start) ? b : a));
    return rangeOf(sm, best, sm, best + h.quote.length);
  }
  const eb = blockEl(root, h.endBlockId);
  if (!eb) return null;
  const em = blockMap(eb);
  const head = h.quote.split(/\s+/)[0] ?? '';
  if (head && !sm.text.slice(h.start).startsWith(head)) return null;
  return rangeOf(sm, h.start, em, h.end);
}

/**
 * Where a block sits for a person reading the list: the heading above it ("Write the ticket for a stranger"), else
 * "Paragraph N" for the paragraphs before the first heading.
 * @param root - The rendered page body.
 * @param blockId - The block.
 */
export function placeOf(root: HTMLElement, blockId: string): string {
  const el = blockEl(root, blockId);
  if (!el) return '';
  if (/^H[1-6]$/.test(el.tagName)) return el.textContent?.trim() ?? '';
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,p,blockquote,li,td,th,figcaption'));
  let heading = '';
  let paras = 0;
  for (const b of blocks) {
    if (b === el || b.contains(el)) break;
    if (/^H[1-4]$/.test(b.tagName)) heading = b.textContent?.trim() ?? '';
    else if (b.tagName === 'P') paras += 1;
  }
  if (heading) return heading;
  if (el.closest('blockquote')) return 'Quote';
  return `Paragraph ${paras + 1}`;
}
