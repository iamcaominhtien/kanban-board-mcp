/**
 * The public view of a page (`/?public=<token>`, design board "Rich Docs — reading", frames 41-46): what it reads
 * from the address, and the page as people outside the project see it — sketches, canvases, diagrams, files, HTML
 * embeds and page or ticket cards as plain text (they would need the board to load), so the view asks the server
 * for nothing but the page.
 */

import { inlineText } from '../../richdoc/text';
import type { RichDoc } from '../../types/docs';
import { slugify } from '../../utils/docsMarkdown';

/** The query parameter of a public link. */
export const PUBLIC_PARAM = 'public';

/**
 * The token of a public link in an address's query, or `null`.
 * @param search - `window.location.search`.
 */
export function publicTokenOf(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
): string | null {
  const t = new URLSearchParams(search).get(PUBLIC_PARAM);
  return t ? t.slice(0, 128) : null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The plain-text line a block that needs the board becomes. */
function plainLine(node: RichDoc): string | null {
  const a = node.attrs ?? {};
  switch (node.type) {
    case 'sketch':
      return `Sketch${str(a.label) ? ` · ${str(a.label)}` : ''}`;
    case 'canvas':
      return `Canvas${str(a.label) ? ` · ${str(a.label)}` : ''}`;
    case 'diagram':
      return `Diagram${str(a.label) ? ` · ${str(a.label)}` : ''}`;
    case 'fileCard':
      return `File · ${str(a.name) || str(a.src).split('/').pop() || 'attachment'}`;
    case 'htmlEmbed':
      return `HTML embed${str(a.title) ? ` · ${str(a.title)}` : ''}`;
    case 'pageCard':
      return str(a.page) || null;
    case 'ticketCard':
      return str(a.key) || null;
    default:
      return null;
  }
}

/**
 * The page as the public view draws it: the blocks that need the board become a line of plain text (in italics,
 * with their block id), every other block is kept. Page and ticket chips stay; the view draws them as text.
 * @param doc - The published page.
 */
export function publicDoc(doc: RichDoc): RichDoc {
  const walk = (node: RichDoc): RichDoc | null => {
    if (node.type && node.type !== 'doc') {
      const line = plainLine(node);
      if (line !== null || ['sketch', 'canvas', 'diagram', 'fileCard', 'htmlEmbed'].includes(node.type)) {
        if (!line) return null;
        return {
          type: 'paragraph',
          attrs: { blockId: node.attrs?.blockId ?? null },
          content: [{ type: 'text', text: line, marks: [{ type: 'italic' }] }],
        };
      }
    }
    if (!node.content) return node;
    return { ...node, content: node.content.map(walk).filter((n): n is RichDoc => n !== null) };
  };
  return walk(doc) ?? { type: 'doc', content: [] };
}

/**
 * Sets the page's `robots` meta: `noindex` unless the owner let search engines index it.
 * @param allowIndex - Search engines may index the page.
 */
export function setRobots(allowIndex: boolean): void {
  let meta = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'robots';
    document.head.appendChild(meta);
  }
  meta.content = allowIndex ? 'index, follow' : 'noindex';
}

/** A heading of the public page's outline. */
export interface PublicHeading {
  /** The element id RichDocView gives it (`docs-<slug>`). */
  id: string;
  text: string;
  level: number;
}

/**
 * The h2 and h3 headings of a page, with the ids RichDocView gives them (a repeated title gets `-2`, `-3`…).
 * @param doc - The page.
 */
export function docHeadings(doc: RichDoc): PublicHeading[] {
  const out: PublicHeading[] = [];
  const seen = new Map<string, number>();
  const walk = (node: RichDoc) => {
    if (node.type === 'heading') {
      const text = inlineText(node);
      const base = slugify(text.replace(/[*_`~]/g, '')) || 'section';
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const level = typeof node.attrs?.level === 'number' ? node.attrs.level : 2;
      if (level === 2 || level === 3) out.push({ id: `docs-${n === 1 ? base : `${base}-${n}`}`, text, level });
    }
    node.content?.forEach(walk);
  };
  walk(doc);
  return out;
}
