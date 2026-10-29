import type { CommentAnchorInput, DocsCommentThread } from '../../../types/docs';

/** Elements that hold one block of page text; a selection over several of them reads them joined by spaces. */
export const BLOCK_SEL = 'p,li,h1,h2,h3,h4,h5,h6,td,th,pre,.dk-code';
const SKIP_SEL = 'button,.dk-anchor,svg,.katex,[data-nocomment],script,style';
const CONTEXT = 32;
const MAX_QUOTE = 2000;

export interface BlockText {
  el: Element;
  /** Whitespace-collapsed text of the block, the way the server reads the Markdown. */
  text: string;
  /** For each character of `text`, the DOM text node and offset it came from. */
  map: { node: Text; offset: number }[];
  section: string | null;
}

/**
 * Read the rendered page into text blocks (paragraph, list item, heading, table cell, code block).
 * @param root - Element holding the rendered page body.
 * @returns Blocks in page order.
 */
export function collectBlocks(root: HTMLElement): BlockText[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP_SEL) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const byEl = new Map<Element, { node: Text }[]>();
  const order: Element[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    const el = node.parentElement?.closest(BLOCK_SEL);
    if (!el || !root.contains(el)) continue;
    if (!byEl.has(el)) {
      byEl.set(el, []);
      order.push(el);
    }
    byEl.get(el)!.push({ node });
  }
  let section: string | null = null;
  const out: BlockText[] = [];
  for (const el of order) {
    if (/^H[1-6]$/.test(el.tagName) && el.id) section = el.id.replace(/^docs-/, '');
    let text = '';
    const map: BlockText['map'] = [];
    let lastSpace = true;
    for (const { node } of byEl.get(el)!) {
      const data = node.data;
      for (let i = 0; i < data.length; i++) {
        if (/\s/.test(data[i])) {
          if (lastSpace) continue;
          text += ' ';
          lastSpace = true;
        } else {
          text += data[i];
          lastSpace = false;
        }
        map.push({ node, offset: i });
      }
    }
    if (text.endsWith(' ')) {
      text = text.slice(0, -1);
      map.pop();
    }
    if (text) out.push({ el, text, map, section });
  }
  return out;
}

const commonSuffix = (a: string, b: string) => {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
};
const commonPrefix = (a: string, b: string) => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
};

/**
 * Score how well text around a candidate match fits the stored context (same rule as the server).
 * @param text - Block text.
 * @param at - Start of the candidate.
 * @param end - End of the candidate.
 * @param a - Stored anchor context.
 * @param a.prefix - Text that preceded the selection.
 * @param a.suffix - Text that followed it.
 * @param section - Section the block sits in.
 * @param wantSection - Section stored with the anchor.
 */
export function scoreMatch(
  text: string,
  at: number,
  end: number,
  a: { prefix: string; suffix: string },
  section: string | null,
  wantSection: string | null,
): number {
  let s = commonSuffix(text.slice(Math.max(0, at - CONTEXT), at), a.prefix);
  s += commonPrefix(text.slice(end, end + CONTEXT), a.suffix);
  if (wantSection && section === wantSection) s += 0.5;
  return s;
}

/** The page text: every block joined by one space (as the server reads it), with where each character came from. */
interface PageText {
  text: string;
  /** DOM position of each character; null for the space between two blocks. */
  map: ({ node: Text; offset: number } | null)[];
  /** Section of the block each character belongs to. */
  sections: (string | null)[];
}

function pageText(blocks: BlockText[]): PageText {
  let text = '';
  const map: PageText['map'] = [];
  const sections: PageText['sections'] = [];
  blocks.forEach((b, i) => {
    if (i > 0) {
      text += ' ';
      map.push(null);
      sections.push(b.section);
    }
    text += b.text;
    map.push(...b.map);
    for (let k = 0; k < b.text.length; k++) sections.push(b.section);
  });
  return { text, map, sections };
}

/**
 * Find the DOM range of a comment's quote in the rendered page (exact text; the best match by context). The quote
 * may run over several blocks.
 * @param blocks - Output of `collectBlocks`.
 * @param t - Thread whose anchor is looked up.
 * @returns The range, or null when the text is not on the page.
 */
export function rangeForThread(blocks: BlockText[], t: DocsCommentThread): Range | null {
  const a = t.anchor;
  if (!a?.quote) return null;
  const page = pageText(blocks);
  let best: { score: number; at: number } | null = null;
  let at = page.text.indexOf(a.quote);
  while (at !== -1) {
    const score = scoreMatch(page.text, at, at + a.quote.length, a, page.sections[at], a.section);
    if (!best || score > best.score) best = { score, at };
    at = page.text.indexOf(a.quote, at + 1);
  }
  if (!best) return null;
  const first = page.map[best.at];
  const last = page.map[best.at + a.quote.length - 1];
  if (!first || !last) return null;
  const r = document.createRange();
  r.setStart(first.node, first.offset);
  r.setEnd(last.node, last.offset + 1);
  return r;
}

/**
 * Turn a selection inside the page body into a comment anchor; it may run over several blocks.
 * @param root - Element holding the rendered page body.
 * @param range - Current selection range.
 * @returns The anchor, or null for an empty selection, one outside the page text or one that is too long.
 */
export function anchorFromRange(root: HTMLElement, range: Range): CommentAnchorInput | null {
  if (range.collapsed || !root.contains(range.commonAncestorContainer)) return null;
  const page = pageText(collectBlocks(root));
  const point = (node: Node, offset: number) => {
    const r = document.createRange();
    r.setStart(node, offset);
    r.collapse(true);
    return r;
  };
  const sp = point(range.startContainer, range.startOffset);
  const ep = point(range.endContainer, range.endOffset);
  let s = page.map.findIndex((m) => m !== null && sp.comparePoint(m.node, m.offset) >= 0);
  if (s === -1) return null;
  let e = page.map.findIndex((m) => m !== null && ep.comparePoint(m.node, m.offset) >= 0);
  if (e === -1) e = page.text.length;
  while (s < e && page.text[s] === ' ') s++;
  while (e > s && page.text[e - 1] === ' ') e--;
  if (e <= s || e - s > MAX_QUOTE) return null;
  return {
    quote: page.text.slice(s, e),
    prefix: page.text.slice(Math.max(0, s - CONTEXT), s),
    suffix: page.text.slice(e, e + CONTEXT),
    section: page.sections[s],
  };
}
