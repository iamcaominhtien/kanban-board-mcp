/**
 * "Show where it was" for an orphaned thread: the spot on the page where the text it was on stood. The server keeps
 * the block now at that spot (rich pages) and the section the text was in; this finds the element to scroll to and
 * marks it for a moment.
 */

import type { DocsCommentThread } from '../../../types/docs';
import type { ThreadPlace } from './blockAnchor';

/** How long the spot stays marked, in milliseconds. */
export const WHERE_FLASH_MS = 1800;

/**
 * The element where an orphaned thread's text was: the block the server kept for it, else the heading of its
 * section; null when neither is on the page.
 * @param t - The thread.
 * @param place - Its place on a rich page (null on a Markdown page).
 * @param root - Where to look (the document by default).
 */
export function whereTarget(
  t: DocsCommentThread,
  place: ThreadPlace | null | undefined,
  root: ParentNode = document,
): HTMLElement | null {
  const id = place?.whereBlockId;
  if (id) {
    const el = root.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);
    if (el) return el;
  }
  const slug = t.anchor?.section;
  if (slug) return root.querySelector<HTMLElement>(`#${CSS.escape(`docs-${slug}`)}`);
  return null;
}

/**
 * Scroll to the spot and mark it for {@link WHERE_FLASH_MS}.
 * @param el - From {@link whereTarget}.
 */
export function revealWhere(el: HTMLElement): void {
  const reduced =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView?.({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
  el.classList.add('dc-where-flash');
  window.setTimeout(() => el.classList.remove('dc-where-flash'), WHERE_FLASH_MS);
}

/** The words of a section slug when its heading is not at hand ("rate-limits" → "rate limits"). */
export function slugWords(slug: string): string {
  return slug.replace(/-\d+$/, '').replace(/-/g, ' ');
}
